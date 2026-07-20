// qa-engine/test/contexts/cross-run-learning/infrastructure/reflector-port.adapter.test.ts
// RED-first (reflector-rewire, Phase 2, task 2.2): ReflectorPortAdapter opens a "reflector"
// session over AgentRuntimePort, prompts for a StructuredReflection, and on a valid parse calls
// LearningRepositoryPort.save (candidate/low, ADR-3) + the injected backfill (ADR-2). Every
// failure mode (runtime throw, timeout, malformed/incomplete JSON) is caught inline — never
// re-thrown — mirroring LearningPortAdapter.fold()'s own documented off-path contract on the
// SAME port family. The session is ALWAYS disposed, even when prompt() itself throws.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ReflectorPortAdapter, REFLECT_TIMEOUT_MS } from "@contexts/cross-run-learning/infrastructure/reflector-port.adapter.ts";
import type { LearningRepositoryPort, LearningRule, ReflectionInput, StructuredReflection } from "@contexts/cross-run-learning/application/ports/index.ts";
import type { AgentRuntimePort, AgentSession } from "@kernel/ports/agent-runtime.port.ts";

const baseInput: ReflectionInput = {
  runId: "run-1",
  app: "app",
  sha: "abc1234",
  mode: "diff",
  verdict: "fail",
  errorClass: "E-EXEC-FAIL",
  gateSignals: { static: true, coverageRatio: 0.4, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
};

const validReflectionJson = JSON.stringify({
  goal: "verify the login form",
  decision: "used a css selector",
  assumption: "the selector would stay stable",
  errorClass: "E-EXEC-FAIL",
  gateSignal: "static gate: FAIL",
  evidence: "locator('.btn-submit') not found",
  rootCause: "css class renamed by a refactor",
  preventiveRule: { trigger: "Applies when a form submit button lacks a stable selector", action: "use getByRole('button', { name: ... })" },
});

function fakeRuntime(opts: {
  prompt?: (text: string) => Promise<{ output: string }>;
  onOpen?: (role: string, cwd: string, sessOpts?: unknown) => void;
  onDispose?: () => void;
  openThrows?: Error;
}): AgentRuntimePort {
  return {
    async openSession(role, cwd, sessOpts) {
      opts.onOpen?.(role, cwd, sessOpts);
      if (opts.openThrows) throw opts.openThrows;
      const session: AgentSession = {
        prompt: opts.prompt ?? (async () => ({ output: validReflectionJson })),
        dispose: async () => { opts.onDispose?.(); },
      };
      return session;
    },
  };
}

function fakeRepo(onSave?: (rule: LearningRule) => void): LearningRepositoryPort {
  return {
    save: async (rule) => { onSave?.(rule); },
    topRules: async () => [],
    applyOutcome: async () => {},
  };
}

test("reflect() opens a 'reflector' session, saves a candidate/low rule, and backfills on valid JSON", async () => {
  let openedRole: string | undefined;
  let openedCwd: string | undefined;
  let savedRule: LearningRule | undefined;
  let backfilled: { runId: string; refl: StructuredReflection } | undefined;

  const runtime = fakeRuntime({ onOpen: (role, cwd) => { openedRole = role; openedCwd = cwd; } });
  const repo = fakeRepo((rule) => { savedRule = rule; });

  const adapter = new ReflectorPortAdapter({
    runtime,
    repo,
    backfill: (runId, refl) => { backfilled = { runId, refl: refl as StructuredReflection }; },
    cwd: "/mirror/app",
    app: "app",
  });

  await adapter.reflect(baseInput);

  assert.equal(openedRole, "reflector");
  assert.equal(openedCwd, "/mirror/app");
  assert.ok(savedRule, "expected LearningRepositoryPort.save to be called");
  assert.equal(savedRule?.status, "candidate");
  assert.equal(savedRule?.confidence, "low");
  assert.ok(backfilled, "expected backfill to be called");
  assert.equal(backfilled?.runId, "run-1");
  assert.equal(backfilled?.refl.rootCause, "css class renamed by a refactor");
});

// SECURITY CRITICAL: gateSignals.reviewerCorrections is agent-authored text (the reviewer has
// read/bash/glob on the actual repo files) fed straight into buildReflectionPrompt — a secret it
// quotes in a rejection rationale must be redacted before reaching this second model call, exactly
// like every sibling field the prompt builders already sanitize.
const SECRET_IN_REVIEWER_CORRECTION = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGH";

test("SECURITY: a secret quoted in gateSignals.reviewerCorrections is redacted before reaching the reflection prompt", async () => {
  let capturedPrompt: string | undefined;
  const runtime = fakeRuntime({
    prompt: async (text) => {
      capturedPrompt = text;
      return { output: validReflectionJson };
    },
  });
  const repo = fakeRepo();
  const adapter = new ReflectorPortAdapter({ runtime, repo, backfill: () => {}, cwd: "/mirror/app", app: "app" });

  const input: ReflectionInput = {
    ...baseInput,
    gateSignals: { ...baseInput.gateSignals, reviewerCorrections: [`found ${SECRET_IN_REVIEWER_CORRECTION} while reading .env, quoting it here`] },
  };
  await adapter.reflect(input);

  assert.ok(capturedPrompt, "expected the reflection prompt to be captured");
  assert.ok(
    !capturedPrompt!.includes(SECRET_IN_REVIEWER_CORRECTION),
    "a secret quoted in a reviewer correction must never reach the reflection prompt unredacted",
  );
  assert.match(capturedPrompt!, /\[REDACTED\]/, "the redaction placeholder must appear in its place");
});

// judgment-day round 3 (FIX D, Judge B): the test above uses an llm-api-key-shaped secret, which
// has no modelSkip predicate and so redacts identically under BOTH sanitizeText modes — it never
// actually exercised which mode this call site uses. This test isolates the mode itself: a
// `password: <short value>`-shaped secret is exactly the api-key-assignment pattern's modelSkip
// escape hatch (WS5.4a) — "model" mode treats a short, low-entropy value as a code-shape
// false-positive and does NOT redact it, while the stricter default ("issue") mode does. Every
// sibling reviewer/selector-authored field in prompts.ts (reviewCorrections, priorCorrections,
// selectorContradictions) was moved to the stricter default mode in round 2 (commit 8cc53bf) —
// this call site's own header claims reviewerCorrections gets "the SAME redaction every sibling
// model-bound field in prompts.ts already receives", which is false for the mode parameter.
test("SECURITY: a low-entropy password-shaped secret in reviewerCorrections is redacted under the stricter default mode, matching every prompts.ts sibling", async () => {
  let capturedPrompt: string | undefined;
  const runtime = fakeRuntime({
    prompt: async (text) => {
      capturedPrompt = text;
      return { output: validReflectionJson };
    },
  });
  const repo = fakeRepo();
  const adapter = new ReflectorPortAdapter({ runtime, repo, backfill: () => {}, cwd: "/mirror/app", app: "app" });

  const input: ReflectionInput = {
    ...baseInput,
    gateSignals: { ...baseInput.gateSignals, reviewerCorrections: ["password: hunter2"] },
  };
  await adapter.reflect(input);

  assert.ok(capturedPrompt, "expected the reflection prompt to be captured");
  assert.ok(
    !capturedPrompt!.includes("hunter2"),
    "a password-shaped value in a reviewer correction must be redacted under the stricter default mode, not skipped as a code-shape false positive",
  );
  assert.match(capturedPrompt!, /\[REDACTED\]/, "the redaction placeholder must appear in its place");
});

test("reflect() never threads initialStatus — structural ADR-3 pin", async () => {
  let savedRule: LearningRule | undefined;
  const runtime = fakeRuntime({});
  const repo = fakeRepo((rule) => { savedRule = rule; });
  const adapter = new ReflectorPortAdapter({ runtime, repo, backfill: () => {}, cwd: "/mirror/app", app: "app" });

  await adapter.reflect(baseInput);

  assert.ok(savedRule);
  assert.equal(Object.prototype.hasOwnProperty.call(savedRule, "initialStatus"), false);
});

test("reflect() with invalid/incomplete JSON: no save, no backfill, does not throw", async () => {
  let saveCalled = false;
  let backfillCalled = false;
  const runtime = fakeRuntime({ prompt: async () => ({ output: "not json at all, sorry" }) });
  const repo = fakeRepo(() => { saveCalled = true; });
  const adapter = new ReflectorPortAdapter({
    runtime, repo, backfill: () => { backfillCalled = true; }, cwd: "/mirror/app", app: "app",
  });

  await assert.doesNotReject(() => adapter.reflect(baseInput));

  assert.equal(saveCalled, false);
  assert.equal(backfillCalled, false);
});

test("reflect() with incomplete JSON (missing preventiveRule fields): no save, no backfill", async () => {
  let saveCalled = false;
  const incomplete = JSON.stringify({ goal: "g", decision: "d", assumption: "a", errorClass: "E-X", gateSignal: "s", evidence: "e", rootCause: "r" });
  const runtime = fakeRuntime({ prompt: async () => ({ output: incomplete }) });
  const repo = fakeRepo(() => { saveCalled = true; });
  const adapter = new ReflectorPortAdapter({ runtime, repo, backfill: () => {}, cwd: "/mirror/app", app: "app" });

  await assert.doesNotReject(() => adapter.reflect(baseInput));

  assert.equal(saveCalled, false);
});

test("reflect() swallows a runtime openSession() throw — no save, no throw escapes, onReflectError called", async () => {
  let caught: unknown;
  let saveCalled = false;
  const boom = new Error("agent runtime unreachable");
  const runtime = fakeRuntime({ openThrows: boom });
  const repo = fakeRepo(() => { saveCalled = true; });
  const adapter = new ReflectorPortAdapter({
    runtime, repo, backfill: () => {}, cwd: "/mirror/app", app: "app",
    onReflectError: (e) => { caught = e; },
  });

  await assert.doesNotReject(() => adapter.reflect(baseInput));

  assert.equal(saveCalled, false);
  assert.equal(caught, boom);
});

test("reflect() swallows a session.prompt() rejection — no save, session still disposed (finally)", async () => {
  let disposed = false;
  let caught: unknown;
  const boom = new Error("prompt timed out mid-stream");
  const runtime = fakeRuntime({
    prompt: async () => { throw boom; },
    onDispose: () => { disposed = true; },
  });
  const repo = fakeRepo();
  const adapter = new ReflectorPortAdapter({
    runtime, repo, backfill: () => {}, cwd: "/mirror/app", app: "app",
    onReflectError: (e) => { caught = e; },
  });

  await assert.doesNotReject(() => adapter.reflect(baseInput));

  assert.equal(disposed, true, "dispose() must run in finally even when prompt() throws");
  assert.equal(caught, boom);
});

test("reflect() disposes the session on the success path too", async () => {
  let disposed = false;
  const runtime = fakeRuntime({ onDispose: () => { disposed = true; } });
  const repo = fakeRepo();
  const adapter = new ReflectorPortAdapter({ runtime, repo, backfill: () => {}, cwd: "/mirror/app", app: "app" });

  await adapter.reflect(baseInput);

  assert.equal(disposed, true);
});

test("reflect() treats a timeout (openSession opts.timeoutMs) as caught — no save, no throw", async () => {
  // The adapter must pass a bounded timeoutMs to openSession; simulate the runtime enforcing it
  // by having the session's prompt() never resolve within a fake caller-side wait, then reject
  // with a timeout-shaped error the same way a real timeout-enforcing runtime would.
  let observedTimeoutMs: number | undefined;
  const runtime: AgentRuntimePort = {
    async openSession(_role, _cwd, opts) {
      observedTimeoutMs = opts?.timeoutMs;
      return {
        prompt: async () => { throw new Error("timed out after " + opts?.timeoutMs + "ms"); },
        dispose: async () => {},
      };
    },
  };
  let saveCalled = false;
  const repo = fakeRepo(() => { saveCalled = true; });
  const adapter = new ReflectorPortAdapter({ runtime, repo, backfill: () => {}, cwd: "/mirror/app", app: "app" });

  await assert.doesNotReject(() => adapter.reflect(baseInput));

  assert.equal(observedTimeoutMs, REFLECT_TIMEOUT_MS);
  assert.equal(saveCalled, false);
});

test("reflect() forwards a custom timeoutMs override to openSession", async () => {
  let observedTimeoutMs: number | undefined;
  const runtime: AgentRuntimePort = {
    async openSession(_role, _cwd, opts) {
      observedTimeoutMs = opts?.timeoutMs;
      return { prompt: async () => ({ output: validReflectionJson }), dispose: async () => {} };
    },
  };
  const repo = fakeRepo();
  const adapter = new ReflectorPortAdapter({
    runtime, repo, backfill: () => {}, cwd: "/mirror/app", app: "app", timeoutMs: 15_000,
  });

  await adapter.reflect(baseInput);

  assert.equal(observedTimeoutMs, 15_000);
});

test("REFLECT_TIMEOUT_MS defaults to 60000", () => {
  assert.equal(REFLECT_TIMEOUT_MS, 60_000);
});

// ── WS1.5 (full-flow remediation): archetype threading — previously hardcoded to `null` on every
// saved rule (a documented gap: "archetype is always null", ADR/plan cross-ref). The use-case now
// computes archetype from the run's diff (detectArchetype, cross-run-learning/domain/distill-rule.ts)
// and threads it onto ReflectionInput; the adapter must persist THAT value, never re-derive or
// re-fabricate its own. ────────────────────────────────────────────────────────────────────────

test("reflect() persists the archetype threaded on ReflectionInput onto the saved rule", async () => {
  let savedRule: LearningRule | undefined;
  const runtime = fakeRuntime({});
  const repo = fakeRepo((rule) => { savedRule = rule; });
  const adapter = new ReflectorPortAdapter({ runtime, repo, backfill: () => {}, cwd: "/mirror/app", app: "app" });

  await adapter.reflect({ ...baseInput, archetype: "form" });

  assert.equal(savedRule?.archetype, "form");
});

test("reflect() persists archetype:null when ReflectionInput carries none — never fabricates a shape", async () => {
  let savedRule: LearningRule | undefined;
  const runtime = fakeRuntime({});
  const repo = fakeRepo((rule) => { savedRule = rule; });
  const adapter = new ReflectorPortAdapter({ runtime, repo, backfill: () => {}, cwd: "/mirror/app", app: "app" });

  await adapter.reflect(baseInput); // baseInput carries no archetype field

  assert.equal(savedRule?.archetype, null);
});

// ── WS1.5: the corrections-distillation channel — a reviewer-rejection outcome's errorClass must
// be DETERMINISTICALLY derived from the real reviewerCorrections (correctionToErrorClass), never
// blindly trusted from the LLM's own echoed `reflection.errorClass` field. The prompt instructs the
// model "do NOT change it", but an LLM is non-deterministic — this is the corrections channel's own
// authpriative source, restoring legacy's correctionToRuleUpsert non-LLM-trusting semantics. ─────

test("reflect() on a reviewer-rejection input derives errorClass deterministically from reviewerCorrections, overriding a disobedient LLM echo", async () => {
  let savedRule: LearningRule | undefined;
  // The LLM disobeys the prompt's "do NOT change it" instruction and echoes a DIFFERENT errorClass
  // than the one the input's own deterministic gateSignals.reviewerCorrections actually resolve to.
  const disobedientJson = JSON.stringify({
    goal: "g", decision: "d", assumption: "a",
    errorClass: "E-EXEC-FAIL", // wrong — the input says this was a reviewer rejection
    gateSignal: "s", evidence: "e", rootCause: "r",
    preventiveRule: { trigger: "Applies when a discount is added", action: "assert the discount total" },
  });
  const runtime = fakeRuntime({ prompt: async () => ({ output: disobedientJson }) });
  const repo = fakeRepo((rule) => { savedRule = rule; });
  const adapter = new ReflectorPortAdapter({ runtime, repo, backfill: () => {}, cwd: "/mirror/app", app: "app" });

  const rejectionInput: ReflectionInput = {
    ...baseInput,
    errorClass: "E-FALSE-POSITIVE",
    gateSignals: { ...baseInput.gateSignals, reviewerCorrections: ["[false-positive] asserts nothing on the discount"] },
  };
  await adapter.reflect(rejectionInput);

  assert.equal(
    savedRule?.errorClass,
    "E-FALSE-POSITIVE",
    "the corrections channel's deterministic derivation must win over the LLM's disobedient echo",
  );
});

test("reflect() with no reviewerCorrections trusts the reflection's own errorClass (unchanged behavior)", async () => {
  let savedRule: LearningRule | undefined;
  const runtime = fakeRuntime({});
  const repo = fakeRepo((rule) => { savedRule = rule; });
  const adapter = new ReflectorPortAdapter({ runtime, repo, backfill: () => {}, cwd: "/mirror/app", app: "app" });

  await adapter.reflect(baseInput); // baseInput has no reviewerCorrections, errorClass: E-EXEC-FAIL

  assert.equal(savedRule?.errorClass, "E-EXEC-FAIL");
});

// WS1.5 BOUNDARY companion (adversarial-review follow-up): an APPROVED run whose reviewer attached
// advisory-only corrections reaches this adapter with reviewerCorrections ALREADY cleared to [] —
// the use-case's `gateApproves ? [] : corrections` guard strips an approval's advisory notes before
// they ever cross the port (they are notes, never a learning signal). This fixture pins the
// adapter-side half of that contract: with the cleared [], the corrections-distillation override
// must NOT engage, and the reflection's own errorClass (here a coverage-gap pass — the realistic
// way an approved run still qualifies for reflect) is what persists.
test("WS1.5 BOUNDARY: an approved-with-advisory run reaches reflect() with reviewerCorrections [] — the corrections override stays dormant, the gate-derived errorClass persists", async () => {
  let savedRule: LearningRule | undefined;
  const coverageGapReflection = JSON.stringify({
    goal: "verify the checkout change",
    decision: "wrote a happy-path spec",
    assumption: "the happy path exercises the changed lines",
    errorClass: "E-COVERAGE-GAP",
    gateSignal: "coverage ratio: 40%",
    evidence: "changed lines in discount.ts never executed",
    rootCause: "the spec never triggers the discount branch",
    preventiveRule: { trigger: "Applies when a diff adds a conditional branch with no test input reaching it", action: "generate an input that takes the new branch" },
  });
  const runtime = fakeRuntime({ prompt: async () => ({ output: coverageGapReflection }) });
  const repo = fakeRepo((rule) => { savedRule = rule; });
  const adapter = new ReflectorPortAdapter({ runtime, repo, backfill: () => {}, cwd: "/mirror/app", app: "app" });

  const approvedWithAdvisoryInput: ReflectionInput = {
    ...baseInput,
    verdict: "pass",
    errorClass: "E-COVERAGE-GAP",
    // The reviewer approved WITH an advisory note — the use-case guard cleared it to [] before
    // building this projection. An advisory note must never appear here.
    gateSignals: { ...baseInput.gateSignals, coverageRatio: 0.4, reviewerCorrections: [] },
  };
  await adapter.reflect(approvedWithAdvisoryInput);

  assert.ok(savedRule, "a coverage-gap pass is a legitimate reflect case — the rule must save");
  assert.equal(
    savedRule?.errorClass,
    "E-COVERAGE-GAP",
    "with reviewerCorrections [], the corrections-distillation override must stay dormant — never re-derive a reviewer class for a run the reviewer approved",
  );
});

// ── WS1.5 ANTI-GOODHART PIN (mandatory per the plan): the corrections-distillation channel is a
// NEW SIGNAL SOURCE (a more precisely classified errorClass + a real archetype tag), never a
// promotion bypass. A reviewer-rejection-derived rule must land EXACTLY where every other
// reflector-authored rule lands — candidate/low, zero oracleOutcomeCount — and can only ever reach
// `active` through WS1.4b's oracle-scored-outcome gate (rule-fold.ts's nextStatus), the SAME as
// before this channel existed. This test fails loudly if a future edit ever threads status/
// confidence/oracleOutcomeCount from the corrections channel instead of hardcoding them. ─────────
test("WS1.5 ANTI-GOODHART PIN: a reviewer-rejection-derived rule is STILL saved as candidate/low with oracleOutcomeCount:0 — the corrections channel adds a signal, never a promotion bypass", async () => {
  let savedRule: LearningRule | undefined;
  const runtime = fakeRuntime({});
  const repo = fakeRepo((rule) => { savedRule = rule; });
  const adapter = new ReflectorPortAdapter({ runtime, repo, backfill: () => {}, cwd: "/mirror/app", app: "app" });

  const rejectionInput: ReflectionInput = {
    ...baseInput,
    errorClass: "E-NO-CLEANUP",
    gateSignals: { ...baseInput.gateSignals, reviewerCorrections: ["[no-cleanup] leaves orphaned qa-bot- rows"] },
    archetype: "data-list",
  };
  await adapter.reflect(rejectionInput);

  assert.ok(savedRule, "the corrections channel must still save a rule");
  assert.equal(savedRule?.errorClass, "E-NO-CLEANUP", "the deterministic corrections-derived class reaches the rule");
  assert.equal(savedRule?.archetype, "data-list", "the diff-derived archetype reaches the rule");
  // The anti-Goodhart invariant itself: none of the fields below are influenced by the corrections
  // channel — they stay the SAME hardcoded, non-negotiable values ADR-3 has always enforced.
  assert.equal(savedRule?.status, "candidate", "ANTI-GOODHART: a corrections-derived rule must start candidate, never active");
  assert.equal(savedRule?.confidence, "low", "ANTI-GOODHART: a corrections-derived rule must start low confidence");
  assert.equal(savedRule?.oracleOutcomeCount, 0, "ANTI-GOODHART: zero oracle evidence at authorship time — promotion still requires WS1.4b's oracle-scored-outcome gate to fire on a LATER run, never at distillation time");
  assert.equal(Object.prototype.hasOwnProperty.call(savedRule, "initialStatus"), false, "ANTI-GOODHART: no initialStatus-shaped field is threaded, exactly as ADR-3 requires for every reflector-authored rule");
});

// ── WS1.3 (full-flow remediation): route the save through distill-rule.ts's decideDistill ──────
// ReflectorPortAdapter previously built LearningRule objects inline, bypassing the anti-respawn
// dedup guard entirely. These tests pin: (a) a reflection whose rule normalizes onto an EXISTING
// rule's key (even a deprecated one) is skipped — repo.save NOT called; (b) a novel rule saves
// with a normalized trigger and capped fields; (c) the untouched anti-Goodhart pins above
// (candidate/low, no initialStatus threading) still hold with the new distill routing in place.

function fakeRepoWithExisting(existing: LearningRule[], onSave?: (rule: LearningRule) => void): LearningRepositoryPort {
  return {
    save: async (rule) => { onSave?.(rule); },
    topRules: async () => [],
    applyOutcome: async () => {},
    listAll: async () => existing,
  };
}

test("reflect() skips saving when the distilled rule normalizes onto an EXISTING rule's key, even a deprecated one", async () => {
  // Legacy dedup keys on the NORMALIZED trigger/action text; seed a deprecated rule sharing the
  // exact normalized key the canonical "Applies when ..." trigger below produces.
  const existingDeprecated: LearningRule = {
    id: "deprecated-rule-1",
    trigger: "Applies when a form submit button lacks a stable selector",
    action: "use getbyrole('button', { name: ... })",
    errorClass: "E-EXEC-FAIL",
    archetype: null,
    status: "deprecated",
    confidence: "low",
    usageCount: 0,
    outcomeCount: 5,
    oracleOutcomeCount: 0,
    successRate: 0.1,
    lastVerified: null,
    source: "run-old",
    at: "2026-01-01T00:00:00.000Z",
  };

  let saveCalled = false;
  const logs: string[] = [];
  const runtime = fakeRuntime({});
  const repo = fakeRepoWithExisting([existingDeprecated], () => { saveCalled = true; });
  const adapter = new ReflectorPortAdapter({
    runtime, repo, backfill: () => {}, cwd: "/mirror/app", app: "app",
    onSkipDuplicate: (line) => logs.push(line),
  });

  await adapter.reflect(baseInput);

  assert.equal(saveCalled, false, "a duplicate (even against a deprecated row) must not be saved");
  assert.ok(logs.length > 0, "a log line must be emitted for the skip");
});

test("reflect() saves a novel rule with normalized trigger and capped fields", async () => {
  let savedRule: LearningRule | undefined;
  const runtime = fakeRuntime({});
  const repo = fakeRepoWithExisting([], (rule) => { savedRule = rule; });
  const adapter = new ReflectorPortAdapter({ runtime, repo, backfill: () => {}, cwd: "/mirror/app", app: "app" });

  await adapter.reflect(baseInput);

  assert.ok(savedRule, "a novel rule must be saved");
  assert.equal(
    savedRule?.trigger,
    "Applies when a form submit button lacks a stable selector",
    "trigger must be canonicalized to the 'Applies when ...' form",
  );
  assert.ok((savedRule?.trigger.length ?? 0) <= 400, "trigger must respect the field cap");
  assert.ok((savedRule?.action.length ?? 0) <= 400, "action must respect the field cap");
});

test("reflect() with a repo that has no listAll (fail-open): still saves a novel rule normally", async () => {
  let savedRule: LearningRule | undefined;
  const runtime = fakeRuntime({});
  const repo = fakeRepo((rule) => { savedRule = rule; }); // no listAll on this fake
  const adapter = new ReflectorPortAdapter({ runtime, repo, backfill: () => {}, cwd: "/mirror/app", app: "app" });

  await adapter.reflect(baseInput);

  assert.ok(savedRule, "a repo without listAll must fail open (empty existing set), not throw or block saving");
});

test("reflect() still never threads initialStatus and still saves candidate/low with distill routing in place", async () => {
  let savedRule: LearningRule | undefined;
  const runtime = fakeRuntime({});
  const repo = fakeRepoWithExisting([], (rule) => { savedRule = rule; });
  const adapter = new ReflectorPortAdapter({ runtime, repo, backfill: () => {}, cwd: "/mirror/app", app: "app" });

  await adapter.reflect(baseInput);

  assert.ok(savedRule);
  assert.equal(savedRule?.status, "candidate");
  assert.equal(savedRule?.confidence, "low");
  assert.equal(Object.prototype.hasOwnProperty.call(savedRule, "initialStatus"), false);
});
