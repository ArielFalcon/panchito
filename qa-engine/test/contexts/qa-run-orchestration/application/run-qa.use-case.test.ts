import { test } from "node:test";
import assert from "node:assert/strict";
import { RunQaUseCase } from "@contexts/qa-run-orchestration/application/run-qa.use-case.ts";
import { FixLoop } from "@contexts/qa-run-orchestration/domain/fix-loop.aggregate.ts";
import { Sha } from "@kernel/sha.ts";
import type {
  ChangeAnalysisPort,
  GenerationPort,
  ReviewPort,
  ValidationPort,
  ExecutionPort,
  ObjectiveSignalPort,
  PublicationPort,
  LearningPort,
  WorkspacePort,
  DeployGatePort,
  RunHistoryPort,
  SetupPort,
} from "@contexts/qa-run-orchestration/application/ports/index.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { ok, err } from "@kernel/result.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";

// RunQaUseCase (Task D.5 — design §5.3(1)): composes Run, RunDecisionService, FixLoop, and the 11
// ports through the full lifecycle. NO inline IO, NO prompt strings, NO learning side-effects on
// the verdict path (LearningPort.fold is off-path). Drives the SAME stub shapes scenarios.ts
// provides for the equivalent runPipeline scenario, so this pin is genuinely comparable to the
// legacy net's own scenario tests.

// ── Fully-stubbed port set, mirroring the green-pr scenario (scenarios.ts:226-234): scenarioApp
// (needsReview:true), makeDeps({}) — generate() returns approved:true with 1 spec, execute()
// returns a clean pass, no coverage config (blocksPublish never trips), not shadow, onFailure
// defaults to "github-issue". ──────────────────────────────────────────────────────────────────

function stubPorts(overrides: Partial<{
  classify: ChangeAnalysisPort["classify"];
  analyze: ChangeAnalysisPort["analyze"];
  generate: GenerationPort["generate"];
  review: ReviewPort["review"];
  validate: ValidationPort["validate"];
  execute: ExecutionPort["execute"];
  measure: ObjectiveSignalPort["measure"];
  publish: PublicationPort["publish"];
  fold: LearningPort["fold"];
  retrieve: LearningPort["retrieve"];
  prepare: WorkspacePort["prepare"];
  waitUntilServing: DeployGatePort["waitUntilServing"];
  save: RunHistoryPort["save"];
  setup: SetupPort["setup"];
}> = {}) {
  const savedOutcomes: RunOutcome[] = [];
  const foldedOutcomes: RunOutcome[] = [];

  const changeAnalysis: ChangeAnalysisPort = {
    analyze: overrides.analyze ?? (async (sha) => BlastRadius.of(sha, ["src/x.ts"])),
    classify: overrides.classify ?? (async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "" })),
  };
  const generation: GenerationPort = {
    generate: overrides.generate ?? (async () => ({ specs: ["a.spec.ts"], approved: true })),
  };
  const review: ReviewPort = {
    review: overrides.review ?? (async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true })),
  };
  const validation: ValidationPort = {
    validate: overrides.validate ?? (async () => ({ ok: true, errors: [] })),
  };
  const execution: ExecutionPort = {
    execute: overrides.execute ?? (async () => ({ verdict: "pass", cases: [], logs: "" })),
  };
  const objectiveSignal: ObjectiveSignalPort = {
    measure: overrides.measure ?? (async () => ({ status: "unknown", ratio: null })),
  };
  const publication: PublicationPort = {
    publish: overrides.publish ?? (async () => ({ outcome: "pr" })),
  };
  const learning: LearningPort = {
    fold: overrides.fold ?? (async (outcome) => { foldedOutcomes.push(outcome); }),
    retrieve: overrides.retrieve ?? (async () => []),
  };
  const workspace: WorkspacePort = {
    prepare: overrides.prepare ?? (async () => ({ specDir: "/tmp/qa-golden/e2e" })),
  };
  const deployGate: DeployGatePort = {
    waitUntilServing: overrides.waitUntilServing ?? (async () => ok(true)),
  };
  const runHistory: RunHistoryPort = {
    save: overrides.save ?? (async (outcome) => { savedOutcomes.push(outcome); }),
  };
  const setup: SetupPort = {
    setup: overrides.setup ?? (async () => {}),
  };

  return {
    ports: { changeAnalysis, generation, review, validation, execution, objectiveSignal, publication, learning, workspace, deployGate, runHistory, setup },
    savedOutcomes,
    foldedOutcomes,
  };
}

const baseInput = {
  app: "demo",
  sha: Sha.of("abc1234"),
  source: "manual" as const,
  mode: "diff" as const,
  target: "e2e" as const,
  runId: "golden-green-pr",
};

test("RunQaUseCase: green-pr — fully stubbed ports, reaches decide, returns pass/pr RunDecision", async () => {
  const { ports } = stubPorts();
  const useCase = new RunQaUseCase(ports);

  const out = await useCase.run(baseInput);

  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.decision.sideEffect, "pr");
});

test("RunQaUseCase: emits preExecAmbiguityCatches:0 + deterministicSelectorBlocks:0 (number, not undefined) when W1/W2 unwired", async () => {
  const { ports } = stubPorts();
  const useCase = new RunQaUseCase(ports);

  const out = await useCase.run(baseInput);

  assert.equal(typeof out.gateSignals.preExecAmbiguityCatches, "number");
  assert.equal(out.gateSignals.preExecAmbiguityCatches, 0);
  assert.equal(typeof out.gateSignals.deterministicSelectorBlocks, "number");
  assert.equal(out.gateSignals.deterministicSelectorBlocks, 0);
});

// ── The 10-scenario parity (mirrors Task A.4 for the rewritten core) ──────────────────────────
// Drives ALL 10 scenarios.ts goldens through RunQaUseCase, with per-scenario stub ports built from
// the SAME fixture semantics scenarios.ts's makeDeps() encodes (never a new, invented behavior) —
// asserting RunDecision (verdict + sideEffect) equals the EXPECTED_VERDICT/EXPECTED_SIDE_EFFECT
// golden-outcome.test.ts already proves for LegacyPipelineAdapter (and run-decision-parity.test.ts
// already proves for decide() in isolation). This test's OWN job is proving the WIRING reaches the
// same decision — not re-deriving decide()'s policy.

interface TenScenarioCase {
  scenario: string;
  overrides: Partial<{
    classify: ChangeAnalysisPort["classify"];
    generate: GenerationPort["generate"];
    review: ReviewPort["review"];
    validate: ValidationPort["validate"];
    execute: ExecutionPort["execute"];
    measure: ObjectiveSignalPort["measure"];
    waitUntilServing: DeployGatePort["waitUntilServing"];
  }>;
  config: { needsReview: boolean; shadow: boolean; onFailure: string; maxRetries: number; isCode: boolean };
  input: Partial<{ mode: "diff" | "complete" | "exhaustive" | "manual" | "context"; target: "e2e" | "code" }>;
  expectedVerdict: string;
  expectedSideEffect: string;
}

const baseConfig = { needsReview: true, shadow: false, onFailure: "github-issue", maxRetries: 2, isCode: false };

const tenScenarios: TenScenarioCase[] = [
  {
    // scenarioApp (needsReview:true), makeDeps({}) — generated (approved:true), passing(). Source:
    // scenarios.ts:226-234.
    scenario: "green-pr",
    overrides: {},
    config: baseConfig,
    input: {},
    expectedVerdict: "pass",
    expectedSideEffect: "pr",
  },
  {
    // scenarioApp, makeDeps({ run: fail }) — a failing case, no fix-loop recovery (execute always
    // returns the SAME fail result, mirroring the golden's fail-issue stub semantics exactly).
    // Source: scenarios.ts:236-246.
    scenario: "fail-issue",
    overrides: {
      execute: async () => ({ verdict: "fail", cases: [{ name: "login", status: "fail" }], logs: "x" }),
      generate: async () => ({ specs: ["a.spec.ts"], approved: true }),
    },
    config: baseConfig,
    input: {},
    expectedVerdict: "fail",
    expectedSideEffect: "issue",
  },
  {
    // scenarioApp, makeDeps({ run: flaky }). Source: scenarios.ts:248-258.
    scenario: "flaky-quarantine",
    overrides: {
      execute: async () => ({ verdict: "flaky", cases: [{ name: "checkout", status: "flaky" as const }], logs: "" }),
    },
    config: baseConfig,
    input: {},
    expectedVerdict: "flaky",
    expectedSideEffect: "quarantine",
  },
  {
    // scenarioApp, makeDeps({ agent: noopAgent }) — the agent approves with zero specs: a VALID
    // skipped (CLAUDE.md invariant), never invalid. Source: scenarios.ts:260-268.
    scenario: "no-op-skip",
    overrides: {
      generate: async () => ({ specs: [], approved: true }),
    },
    config: baseConfig,
    input: {},
    expectedVerdict: "skipped",
    expectedSideEffect: "none",
  },
  {
    // scenarioApp, makeDeps({ validation: { ok:false, ... } }). Source: scenarios.ts:270-280.
    scenario: "invalid-issue",
    overrides: {
      validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }),
    },
    config: baseConfig,
    input: {},
    expectedVerdict: "invalid",
    expectedSideEffect: "issue",
  },
  {
    // scenarioApp, makeDeps({ healthy: false }) — DEV unhealthy before execution. Source:
    // scenarios.ts:282-290.
    scenario: "infra-error",
    overrides: {
      waitUntilServing: async () => ({ ok: false, error: new Error("DEV unhealthy") }),
    },
    config: baseConfig,
    input: {},
    expectedVerdict: "infra-error",
    expectedSideEffect: "none",
  },
  {
    // codeApp (needsReview:true), makeDeps({ isCodeMode: true }) — code mode reuses the SAME
    // pass-path chain (report()/decide are verdict-shaped, not e2e-vs-code-shaped). Source:
    // scenarios.ts:292-300.
    scenario: "code-mode",
    overrides: {},
    config: { ...baseConfig, isCode: true },
    input: { target: "code" },
    expectedVerdict: "pass",
    expectedSideEffect: "pr",
  },
  {
    // crossApp (needsReview:false, shadow:false explicit), makeDeps({ isCrossRepo: true }). Source:
    // scenarios.ts:302-322. NOTE (judgment-day): this row deliberately does NOT set
    // input.triggerRepo — it pins the needsReview-skip semantics of the cross-repo shape only; the
    // triggerRepo coverage guard has its own dedicated KEYSTONE tests further down this file.
    scenario: "cross-repo",
    overrides: {},
    config: { ...baseConfig, needsReview: false },
    input: {},
    expectedVerdict: "pass",
    expectedSideEffect: "pr",
  },
  {
    // shadowApp (needsReview:true, shadow:true), makeDeps({}). Source: scenarios.ts:324-332.
    scenario: "shadow",
    overrides: {},
    config: { ...baseConfig, shadow: true },
    input: {},
    expectedVerdict: "pass",
    expectedSideEffect: "shadow-log",
  },
  {
    // scenarioApp, context mode's own generate() stub — approved:true, reviewed:false, passing().
    // Source: scenarios.ts:334-351.
    scenario: "context",
    overrides: {
      generate: async () => ({ specs: [".qa/context.json"], approved: true, note: "built map" }),
    },
    config: baseConfig,
    input: { mode: "context" },
    expectedVerdict: "pass",
    expectedSideEffect: "pr",
  },
];

test("RunQaUseCase 10-scenario parity: the golden set is non-trivial (guards against an accidentally-empty pin)", () => {
  assert.equal(tenScenarios.length, 10, "expected exactly the 10 scenarios.ts goldens");
});

for (const c of tenScenarios) {
  test(`RunQaUseCase 10-scenario parity — ${c.scenario}: RunDecision matches the golden verdict + side effect`, async () => {
    const { ports } = stubPorts(c.overrides);
    const useCase = new RunQaUseCase({ ...ports, config: c.config });

    const out = await useCase.run({ ...baseInput, runId: `golden-${c.scenario}`, ...c.input });

    assert.equal(out.decision.verdict, c.expectedVerdict, `${c.scenario}: verdict mismatch`);
    assert.equal(out.decision.sideEffect, c.expectedSideEffect, `${c.scenario}: sideEffect mismatch`);
  });
}

// ── Genuine-wiring proofs (guards against an accidentally-green parity from a swallowed call or a
// dead branch) — call-count instrumentation on the specific ports each scenario's OWN semantics
// says must (or must not) be invoked. ──────────────────────────────────────────────────────────

test("RunQaUseCase — shadow: publish() is NEVER called (green routes to shadow-log, not a real PR)", async () => {
  let publishCallCount = 0;
  const { ports } = stubPorts({ execute: async () => ({ verdict: "pass", cases: [], logs: "" }) });
  ports.publication.publish = async () => { publishCallCount++; return { outcome: "pr" }; };
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, shadow: true } });

  const out = await useCase.run({ ...baseInput, runId: "golden-shadow-wiring-proof" });

  assert.equal(out.decision.sideEffect, "shadow-log");
  assert.equal(publishCallCount, 0, "shadow mode must never call the real publish port");
});

test("RunQaUseCase — cross-repo (needsReview:false): review() is NEVER called", async () => {
  let reviewCallCount = 0;
  const { ports } = stubPorts({});
  ports.review.review = async () => { reviewCallCount++; return { approved: true, corrections: [], blockingCount: 0, parsed: true }; };
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false } });

  const out = await useCase.run({ ...baseInput, runId: "golden-cross-repo-wiring-proof" });

  assert.equal(out.decision.verdict, "pass");
  assert.equal(reviewCallCount, 0, "needsReview:false must skip the review port entirely");
});

test("RunQaUseCase — fail-issue: the FixLoop genuinely engages (generate + execute called MORE than once, retries > 0)", async () => {
  let generateCallCount = 0;
  let executeCallCount = 0;
  const { ports } = stubPorts({
    execute: async () => { executeCallCount++; return { verdict: "fail", cases: [{ name: "login", status: "fail" as const }], logs: "x" }; },
    generate: async () => { generateCallCount++; return { specs: ["a.spec.ts"], approved: true }; },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "golden-fail-issue-wiring-proof" });

  assert.equal(out.decision.verdict, "fail");
  assert.equal(out.gateSignals.retries, 1, "matches the fail-issue golden's own retries:1");
  assert.ok(generateCallCount > 1, `expected the FixLoop to call generate() at least twice (initial + regen), got ${generateCallCount}`);
  assert.ok(executeCallCount > 1, `expected the FixLoop to call execute() at least twice (initial + retry), got ${executeCallCount}`);
});

test("RunQaUseCase — invalid-issue: execute() is NEVER called (static gate blocks before execution)", async () => {
  let executeCallCount = 0;
  const { ports } = stubPorts({ validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }) });
  ports.execution.execute = async () => { executeCallCount++; return { verdict: "pass", cases: [], logs: "" }; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "golden-invalid-issue-wiring-proof" });

  assert.equal(out.decision.verdict, "invalid");
  assert.equal(executeCallCount, 0, "a static-gate failure must block BEFORE execution, never call it");
});

test("RunQaUseCase — infra-error: execute() is NEVER called (DEV unhealthy before execution)", async () => {
  let executeCallCount = 0;
  const { ports } = stubPorts({ waitUntilServing: async () => ({ ok: false, error: new Error("DEV unhealthy") }) });
  ports.execution.execute = async () => { executeCallCount++; return { verdict: "pass", cases: [], logs: "" }; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "golden-infra-error-wiring-proof" });

  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(executeCallCount, 0, "DEV-unhealthy must block BEFORE execution, never call it");
});

// ── CLAUDE.md invariant ("surface integration errors loudly — never swallow errors into an empty
// result"): every infra-error-shaped terminal must carry a diagnostic note. A live portfolio run
// once produced verdict:infra-error with NO note/log/cases — undiagnosable without instrumenting a
// live container. These tests pin the note end-to-end for each silent terminal that fix closed. ──

test("NOTE CHAIN: entry deploy-gate failure surfaces the InfraError message as the note", async () => {
  const { ports } = stubPorts({
    waitUntilServing: async () => ({ ok: false, error: new Error("DEV did not serve sha abc1234 within 5000ms (versionUrl=https://example.com/version)") }),
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "note-chain-entry-gate" });

  assert.equal(out.decision.verdict, "infra-error");
  assert.ok(
    out.note?.includes("DEV did not serve sha abc1234"),
    `the entry deploy-gate's own InfraError message must reach the note, not be dropped — got: ${out.note}`,
  );
});

test("NOTE CHAIN: mid-run health pre-flight failure surfaces a note (and is persisted)", async () => {
  let waitUntilServingCall = 0;
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  const { ports } = stubPorts({
    waitUntilServing: async () => {
      waitUntilServingCall++;
      // First call (entry gate) succeeds; second call (mid-run pre-flight, after validate) fails —
      // mirrors FIX E's own two-call precedent for isolating the mid-run branch.
      return waitUntilServingCall === 1 ? ok(true) : { ok: false, error: new Error("DEV went down mid-run") };
    },
  });
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "note-chain-health-preflight" });

  assert.equal(out.decision.verdict, "infra-error");
  assert.ok(out.note?.includes("DEV went down mid-run"), `the mid-run health pre-flight's captured gate error must reach the note — got: ${out.note}`);
  assert.equal(saved?.note, out.note, "the persisted RunOutcome must carry the SAME note as the returned RunQaResult — the note must survive the mapping chain out to the run record");
});

test("NOTE CHAIN: static-gate 'invalid' terminal surfaces the validation errors as the note", async () => {
  const { ports } = stubPorts({
    validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout", "[tsc] Type 'string' is not assignable to type 'number'."] }),
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "note-chain-validation-invalid" });

  assert.equal(out.decision.verdict, "invalid");
  assert.ok(out.note?.includes("no-wait-for-timeout"), `a static-gate 'invalid' terminal must surface validation.errors in the note — got: ${out.note}`);
});

// ── "Dynamic diff" fix: the Plan 7.5 shadow proof (engram #936) found that GenerationPortAdapter
// only ever saw the STATIC CompositionConfig.diff (set at composition-BUILD time), which is empty
// for the real production engineFactory (constructed BEFORE the run/checkout) — generation always
// got an empty diff -> zero specs -> a false skip. classify() already computes the commit's diff
// internally (ChangeAnalysisPortAdapter sources it from the SAME VcsReadPort it uses for
// classifyCommit) but previously discarded it. This proves the use-case now surfaces that
// classification-sourced diff into EVERY generate() call, in place of an empty/static value. ───────

test("dynamic diff: generate() receives the change-analysis diff (diff mode), not an empty/static value", async () => {
  const capturedDiffs: (string | undefined)[] = [];
  const { ports } = stubPorts({
    classify: async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "diff --git a/src/x.ts b/src/x.ts\n+real change\n" }),
  });
  ports.generation.generate = async (_objectives, _specDir, _signal, diff) => {
    capturedDiffs.push(diff);
    return { specs: ["a.spec.ts"], approved: true };
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "dynamic-diff-generate-receives-classification-diff", mode: "diff" });

  assert.ok(capturedDiffs.length > 0, "generate() must have been called at least once");
  for (const captured of capturedDiffs) {
    assert.equal(
      captured,
      "diff --git a/src/x.ts b/src/x.ts\n+real change\n",
      "every generate() call must receive the SAME diff classify() computed for this run, not an empty string or a stale static value",
    );
  }
});

test("dynamic diff: the static-fix repair loop also threads the SAME classification diff into its regenerate() call", async () => {
  let validateCallCount = 0;
  const capturedDiffs: (string | undefined)[] = [];
  const { ports } = stubPorts({
    classify: async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "diff --git a/src/x.ts b/src/x.ts\n+repair-round change\n" }),
    validate: async () => {
      validateCallCount++;
      return validateCallCount === 1
        ? { ok: false, errors: ["39:11  error  'x' is assigned a value but never used"] }
        : { ok: true, errors: [] };
    },
  });
  ports.generation.generate = async (_objectives, _specDir, _signal, diff) => {
    capturedDiffs.push(diff);
    return { specs: ["a.spec.ts"], approved: true };
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "dynamic-diff-static-fix-loop-threads-diff", mode: "diff" });

  assert.equal(out.decision.verdict, "pass", "the static-fix loop must still recover exactly as before");
  assert.ok(capturedDiffs.length >= 2, `expected at least 2 generate() calls (initial + 1 repair round), got ${capturedDiffs.length}`);
  for (const captured of capturedDiffs) {
    assert.equal(captured, "diff --git a/src/x.ts b/src/x.ts\n+repair-round change\n", "the repair regeneration must reuse the SAME classification diff, not drop it on the retry");
  }
});

test("dynamic diff: the FixLoop's own regenerate() call also threads the SAME classification diff", async () => {
  const capturedDiffs: (string | undefined)[] = [];
  const { ports } = stubPorts({
    classify: async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "diff --git a/src/x.ts b/src/x.ts\n+fixloop change\n" }),
    execute: async () => ({ verdict: "fail" as const, cases: [{ name: "login", status: "fail" as const }], logs: "x" }),
  });
  ports.generation.generate = async (_objectives, _specDir, _signal, diff) => {
    capturedDiffs.push(diff);
    return { specs: ["a.spec.ts"], approved: true };
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "dynamic-diff-fixloop-threads-diff", mode: "diff" });

  assert.ok(capturedDiffs.length > 1, `expected the FixLoop to call generate() more than once, got ${capturedDiffs.length}`);
  for (const captured of capturedDiffs) {
    assert.equal(captured, "diff --git a/src/x.ts b/src/x.ts\n+fixloop change\n", "the FixLoop's own regenerate() call must reuse the SAME classification diff on every round");
  }
});

test("dynamic diff: a non-diff mode (e.g. complete) never calls classify(), so generate() receives undefined — the adapter's static ctx.diff fallback stays intact", async () => {
  let classifyCallCount = 0;
  const capturedDiffs: (string | undefined)[] = [];
  const { ports } = stubPorts({
    classify: async () => { classifyCallCount++; return { action: "generate", reason: "n/a", diff: "should never be read" }; },
  });
  ports.generation.generate = async (_objectives, _specDir, _signal, diff) => {
    capturedDiffs.push(diff);
    return { specs: ["a.spec.ts"], approved: true };
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "dynamic-diff-non-diff-mode-no-classify", mode: "complete" });

  assert.equal(classifyCallCount, 0, "only diff mode runs classifyCommit — complete/exhaustive/manual/context always generate without classifying");
  assert.ok(capturedDiffs.length > 0, "generate() must still have been called");
  for (const captured of capturedDiffs) {
    assert.equal(captured, undefined, "without a classification diff, the use-case must pass undefined (never a fabricated value) so the adapter's own ctx.diff fallback applies");
  }
});

// ── Judgment-day FIX A-E: exposing tests written FIRST (STRICT TDD RED), each proves the
// 10-scenario parity is vacuous for that specific defect — none of the 10 goldens exercises
// needsReview:true + a reviewer parse-miss, coveragePolicyMode:"signal", context-mode execute()
// call-count, coverageWillMeasure threading, or persist/fold call-count on the 3 terminal exits. ──

test("FIX A: reviewer parse-miss (parsed:false) must FAIL CLOSED — reviewerApproved=false, not true", async () => {
  // review() returns parsed:false (a parse miss) with approved:false on the raw payload too, so a
  // fail-OPEN bug (parsed:false -> treat as approved:true) is masked unless approved itself is
  // false — this reproduces the legacy's actual reviewer-outage shape (opencode-client.ts:748-753:
  // approved:false, parsed:false), so a correct fail-closed implementation and a buggy fail-open
  // implementation disagree on the FINAL decision, not just an intermediate field.
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass", cases: [], logs: "" }),
    review: async () => ({ approved: false, corrections: [], blockingCount: 0, parsed: false }),
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig }); // baseConfig.needsReview === true

  const out = await useCase.run({ ...baseInput, runId: "fix-a-reviewer-parse-miss" });

  // Fail-closed: a parse-miss must NOT be treated as approved. The legacy routes this to an Issue
  // (reviewerApproved:false -> RunEvidence.needsReview && !reviewerApproved -> issue), never a PR.
  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.decision.sideEffect, "issue", "a reviewer parse-miss must fail CLOSED (issue), not silently approve (pr)");
});

test("FIX B: coveragePolicyMode:\"signal\" (the default) NEVER blocks publish even when the signal is fail", async () => {
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass", cases: [], logs: "" }),
    measure: async () => ({ status: "fail", ratio: 0.2 }),
  });
  const useCase = new RunQaUseCase({
    ...ports,
    config: { ...baseConfig, needsReview: false, coveragePolicyMode: "signal" },
  });

  const out = await useCase.run({ ...baseInput, runId: "fix-b-signal-never-blocks" });

  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.decision.sideEffect, "pr", "signal mode must publish (measure + record only), never hold the PR");
});

test("FIX B: coveragePolicyMode:\"enforce\" DOES block publish when the signal is fail", async () => {
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass", cases: [], logs: "" }),
    measure: async () => ({ status: "fail", ratio: 0.2 }),
  });
  const useCase = new RunQaUseCase({
    ...ports,
    config: { ...baseConfig, needsReview: false, coveragePolicyMode: "enforce" },
  });

  const out = await useCase.run({ ...baseInput, runId: "fix-b-enforce-blocks" });

  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.decision.sideEffect, "issue", "enforce mode must hold the PR (route to issue) when coverage fails");
});

test("FIX C: context mode NEVER calls execute() (context.json is not a Playwright spec)", async () => {
  let executeCallCount = 0;
  const { ports } = stubPorts({
    generate: async () => ({ specs: [".qa/context.json"], approved: true, note: "built map" }),
  });
  ports.execution.execute = async () => { executeCallCount++; return { verdict: "pass", cases: [], logs: "" }; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "fix-c-context-never-executes", mode: "context" });

  assert.equal(executeCallCount, 0, "context mode must never invoke ExecutionPort.execute — context.json is not a Playwright spec");
});

test("FIX D: a diff-mode fail retry computes coverageWillMeasure per the legacy formula and threads it into the FixLoop", async () => {
  // The use-case's own ExecutionPort (a single-arg `execute(specDir: string)`) cannot express a
  // specFiles-scoped retry — the FixLoopExecutionPort closure that wraps it necessarily drops
  // FixLoopExecuteInput.specFiles on the floor no matter what this use-case passes as
  // coverageWillMeasure (that richer contract is Task E.0's composition-root concern, per
  // fix-loop.aggregate.ts's own header). So the only port-observable proof available at THIS
  // layer is instrumenting FixLoop.run itself and asserting the use-case invokes it with
  // coverageWillMeasure computed per the legacy formula (src/pipeline.ts:2563-2564):
  // `generating && mode === "diff" && covPolicy.mode !== "off"` (RunQaInput.triggerRepo exists now,
  // but this formula deliberately omits the !triggerRepo conjunct — over-firing true for cross-repo
  // only disables the FixLoop's filtered-retry optimization, a documented harmless trade-off; the
  // REAL coverage guard lives at the measure() call site, which starves the diff). We patch
  // FixLoop.prototype.run for the duration of this test to capture the actual input the use-case
  // constructs, restoring it immediately after — this is the narrowest possible seam that proves
  // the WIRING, without inventing a new port.
  const originalRun = FixLoop.prototype.run;
  let capturedCoverageWillMeasure: boolean | undefined;
  FixLoop.prototype.run = async function (input: Parameters<typeof originalRun>[0]) {
    capturedCoverageWillMeasure = input.coverageWillMeasure;
    return originalRun.call(this, input);
  };
  try {
    const { ports } = stubPorts({
      execute: async () => ({ verdict: "fail" as const, cases: [{ name: "login", status: "fail" as const }], logs: "x" }),
      generate: async () => ({ specs: ["a.spec.ts"], approved: true }),
    });
    const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false, coveragePolicyMode: "signal" } });

    await useCase.run({ ...baseInput, runId: "fix-d-coverage-will-measure", mode: "diff" });
  } finally {
    FixLoop.prototype.run = originalRun;
  }

  assert.equal(
    capturedCoverageWillMeasure,
    true,
    "diff mode + coveragePolicyMode!=='off' must thread coverageWillMeasure:true into the FixLoop (matches src/pipeline.ts:2563-2564)",
  );
});

test("FIX D: coveragePolicyMode:\"off\" threads coverageWillMeasure:false into the FixLoop (matches the legacy's covPolicy.mode!=='off' conjunct)", async () => {
  const originalRun = FixLoop.prototype.run;
  let capturedCoverageWillMeasure: boolean | undefined;
  FixLoop.prototype.run = async function (input: Parameters<typeof originalRun>[0]) {
    capturedCoverageWillMeasure = input.coverageWillMeasure;
    return originalRun.call(this, input);
  };
  try {
    const { ports } = stubPorts({
      execute: async () => ({ verdict: "fail" as const, cases: [{ name: "login", status: "fail" as const }], logs: "x" }),
      generate: async () => ({ specs: ["a.spec.ts"], approved: true }),
    });
    const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false, coveragePolicyMode: "off" } });

    await useCase.run({ ...baseInput, runId: "fix-d-coverage-off", mode: "diff" });
  } finally {
    FixLoop.prototype.run = originalRun;
  }

  assert.equal(capturedCoverageWillMeasure, false, "coveragePolicyMode:'off' must never claim coverage will measure this run");
});

// ── FIX E: persist (RunHistoryPort.save)/fold (LearningPort.fold) call-counts on the 3 terminal
// early-exits, matching the legacy's per-source table EXACTLY (src/pipeline.ts):
//   agent-no-op skip (:2226-2234)   -> persistOutcome save YES, foldRunLearning NO
//   classify-skip    (:1263-1267)   -> bare return, save NO,  fold NO   (DISTINCT from agent-no-op)
//   invalid          (:2313-2325)   -> persistOutcome save YES, foldRunLearning YES
//   infra-error      (:2328-2337)   -> persistOutcome save YES, foldRunLearning NO
// ──────────────────────────────────────────────────────────────────────────────────────────────

test("FIX E: agent no-op skip calls runHistory.save() but NOT learning.fold()", async () => {
  let saveCallCount = 0;
  let foldCallCount = 0;
  const { ports } = stubPorts({ generate: async () => ({ specs: [], approved: true }) });
  ports.runHistory.save = async () => { saveCallCount++; };
  ports.learning.fold = async () => { foldCallCount++; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "fix-e-agent-no-op-skip" });

  assert.equal(out.decision.verdict, "skipped");
  assert.equal(saveCallCount, 1, "agent no-op skip must call runHistory.save() exactly once (matches persistOutcome at pipeline.ts:2226-2234)");
  assert.equal(foldCallCount, 0, "agent no-op skip must NEVER call learning.fold() (the legacy never calls foldRunLearning for this source)");
});

test("FIX E: classify-skip does NOT call runHistory.save() or learning.fold() (distinct from the agent no-op skip source)", async () => {
  let saveCallCount = 0;
  let foldCallCount = 0;
  const { ports } = stubPorts({ classify: async () => ({ action: "skip", reason: "docs-only commit", diff: "" }) });
  ports.runHistory.save = async () => { saveCallCount++; };
  ports.learning.fold = async () => { foldCallCount++; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "fix-e-classify-skip", mode: "diff" });

  assert.equal(out.decision.verdict, "skipped");
  assert.equal(saveCallCount, 0, "classify-skip is a bare return in the legacy (pipeline.ts:1263-1267) — it must NOT call runHistory.save()");
  assert.equal(foldCallCount, 0, "classify-skip must NOT call learning.fold()");
});

test("FIX E: invalid calls BOTH runHistory.save() AND learning.fold()", async () => {
  let saveCallCount = 0;
  let foldCallCount = 0;
  const { ports } = stubPorts({ validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }) });
  ports.runHistory.save = async () => { saveCallCount++; };
  ports.learning.fold = async () => { foldCallCount++; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "fix-e-invalid" });

  assert.equal(out.decision.verdict, "invalid");
  assert.equal(saveCallCount, 1, "invalid must call runHistory.save() exactly once (matches persistOutcome at pipeline.ts:2313-2325)");
  assert.equal(foldCallCount, 1, "invalid must call learning.fold() exactly once (matches foldRunLearning at pipeline.ts:2321)");
});

// ── SETUP phase (CLAUDE.md run-flow step 3): "bootstrap the config/e2e seed into e2e/, then npm ci;
// runs BEFORE generation so the agent has the fixtures/config". Missing from this rewrite until now
// — src/pipeline.ts:1299 calls deps.setupE2e/setupCode AFTER classify resolves to generate/
// regression and BEFORE generate(); a setup throw surfaces as infra-error, never a code verdict
// (src/qa/setup.ts's own doc). ─────────────────────────────────────────────────────────────────

test("SETUP: setup() is called AFTER classify resolves to generate and BEFORE generate()", async () => {
  const callOrder: string[] = [];
  const { ports } = stubPorts({
    classify: async () => { callOrder.push("classify"); return { action: "generate", reason: "diff touches src/x.ts", diff: "" }; },
    setup: async () => { callOrder.push("setup"); },
    generate: async () => { callOrder.push("generate"); return { specs: ["a.spec.ts"], approved: true }; },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "setup-order-generate" });

  assert.deepEqual(callOrder, ["classify", "setup", "generate"], "setup must run strictly between classify and generate, never before or after");
});

test("SETUP: setup() is called on a non-diff mode too (which never classifies)", async () => {
  let setupCalled = false;
  const { ports } = stubPorts({ setup: async () => { setupCalled = true; } });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "setup-non-diff-mode", mode: "complete" });

  assert.equal(setupCalled, true, "setup must run for whole-repo/guided modes too (CLAUDE.md: setup runs before generation for every generating run)");
});

test("SETUP: setup() is SKIPPED on a classify-skip (nothing to generate for)", async () => {
  let setupCalled = false;
  const { ports } = stubPorts({
    classify: async () => ({ action: "skip", reason: "docs-only commit", diff: "" }),
    setup: async () => { setupCalled = true; },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "setup-skipped-on-classify-skip", mode: "diff" });

  assert.equal(out.decision.verdict, "skipped");
  assert.equal(setupCalled, false, "a classify-skip never reaches generation, so setup must not run either — matches legacy's classify-then-setup ordering (src/pipeline.ts:1263 returns before :1299)");
});

test("SETUP: a setup() throw maps to infra-error, never a code verdict — and does NOT persist", async () => {
  let saveCallCount = 0;
  let generateCalled = false;
  const { ports } = stubPorts({
    setup: async () => { throw new Error("npm ci in e2e failed (code 1)"); },
    generate: async () => { generateCalled = true; return { specs: ["a.spec.ts"], approved: true }; },
  });
  ports.runHistory.save = async () => { saveCallCount++; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "setup-throw-infra-error" });

  assert.equal(out.decision.verdict, "infra-error", "a setup failure must be infra-error, matching src/qa/setup.ts's own doc: 'the pipeline surfaces that as infra-error, never a code verdict'");
  assert.equal(out.decision.sideEffect, "none");
  assert.equal(generateCalled, false, "generate() must never run once setup has thrown");
  assert.equal(saveCallCount, 0, "a setup failure must NOT persist a RunOutcome — matches the entry-gate infra-error's own no-persist convention (infraErrorResult never saves)");
  assert.ok(out.note?.includes("npm ci in e2e failed (code 1)"), `a setup throw must surface a diagnostic note carrying the thrown message (CLAUDE.md "never swallow errors into an empty result") — got: ${out.note}`);
});

test("SETUP: an absent SetupPort (deps.setup undefined) is a no-op — generation still runs (backward compatible)", async () => {
  const { ports } = stubPorts();
  const { setup: _unused, ...portsWithoutSetup } = ports;
  const useCase = new RunQaUseCase({ ...portsWithoutSetup, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "setup-absent-backward-compat" });

  assert.equal(out.decision.verdict, "pass", "an absent SetupPort must never break a run — this composition simply skips the setup phase (matches the pre-fix behavior)");
});

test("SETUP: an already-aborted signal short-circuits before setup() ever runs", async () => {
  const controller = new AbortController();
  controller.abort();
  let setupCalled = false;
  const { ports } = stubPorts({ setup: async () => { setupCalled = true; } });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "setup-already-aborted" }, controller.signal);

  assert.equal(setupCalled, false, "setup must never run once the signal is already aborted — the entry short-circuit fires first");
  assert.equal(out.decision.verdict, "infra-error");
});

test("SETUP: aborting during setup() (signal fires inside the collaborator) stops before generate()", async () => {
  const controller = new AbortController();
  let generateCalled = false;
  const { ports } = stubPorts({
    setup: async () => { controller.abort(); },
    generate: async () => { generateCalled = true; return { specs: ["a.spec.ts"], approved: true }; },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "setup-abort-mid-setup" }, controller.signal);

  assert.equal(generateCalled, false, "generate() must never run once the signal aborts during setup");
  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(out.decision.sideEffect, "none");
});

// ── Judgment-day D.7 FIX 1-4: closing the 5 CONFIRMED dual-engine cross-validation divergences
// (gateSignals TELEMETRY only — no verdict divergence exists anywhere in the 21-scenario harness).
// Each test instruments runHistory.save() (the same seam FIX E's tests already use) to capture the
// PERSISTED RunOutcome and assert on the specific gateSignals/errorClass field the legacy sets and
// RunQaUseCase.toRunOutcome() previously hardcoded to null/dropped. ──────────────────────────────

test("FIX 1: reviewerApproved is copied into the persisted gateSignals (not dropped after being used as a decide() input)", async () => {
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  const { ports } = stubPorts({
    review: async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true }),
  });
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig }); // needsReview: true

  await useCase.run({ ...baseInput, runId: "fix-1-reviewer-approved-persisted" });

  assert.ok(saved, "runHistory.save() must have been called");
  assert.equal(saved!.gateSignals.reviewerApproved, true, "reviewerApproved must be threaded into the persisted gateSignals, matching src/pipeline.ts:1114's persistOutcome call");
});

test("FIX 1: reviewerApproved reflects a reviewer REJECTION (false), not silently omitted", async () => {
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass", cases: [], logs: "" }),
    review: async () => ({ approved: false, corrections: ["[false-positive] x"], blockingCount: 1, parsed: true }),
  });
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig }); // needsReview: true

  await useCase.run({ ...baseInput, runId: "fix-1-reviewer-rejected-persisted" });

  assert.ok(saved, "runHistory.save() must have been called");
  assert.equal(saved!.gateSignals.reviewerApproved, false, "a reviewer rejection must persist reviewerApproved:false, not true or undefined");
});

test("FIX 2: a CLEAN context-mode pass does NOT persist (matches the legacy's Flag 3 convention — context mode never calls saveOutcome on a clean pass)", async () => {
  let saveCallCount = 0;
  const { ports } = stubPorts({
    generate: async () => ({ specs: [".qa/context.json"], approved: true, note: "built map" }),
  });
  ports.runHistory.save = async () => { saveCallCount++; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "fix-2-context-clean-no-persist", mode: "context" });

  assert.equal(out.decision.verdict, "pass");
  assert.equal(saveCallCount, 0, "a clean context-mode pass must NOT call runHistory.save() — the legacy's buildContextMap publishes directly via publishContext and returns without persisting (src/pipeline.ts:1422-1438)");
});

test("FIX 2: a context-mode INVALID result does NOT persist (SUPERSEDES the original assumption below — corrected per bug-register Entry 12's direct-reading root-cause, see the 'FIX 2 (D.7 batch 2)' test for the full writeup)", async () => {
  // CORRECTED: this test originally asserted saveCallCount:1, on the assumption that a context-mode
  // static-gate failure "reaches terminalResult('invalid', ...) exactly like any other mode". Direct
  // reading of the legacy (src/pipeline.ts:1377-1404's buildContextMap invalid branch) DISPROVED
  // this: it files an Issue via issueOrShadow() then returns WITHOUT ever calling persistOutcome —
  // the SAME no-persist convention as the clean context pass, not the generic static-gate invalid
  // path. The original assumption was a D.7-era harness comment error (also corrected in
  // golden-outcome.test.ts's context-invalid row) — never independently re-verified against the
  // actual legacy source until this fix batch.
  let saveCallCount = 0;
  const { ports } = stubPorts({
    generate: async () => ({ specs: [".qa/context.json"], approved: true, note: "tried" }),
    validate: async () => ({ ok: false, errors: ["feBe[0]: route '/ghost' is not declared in 'routes'"] }),
  });
  ports.runHistory.save = async () => { saveCallCount++; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "fix-2-context-invalid-persists", mode: "context" });

  assert.equal(out.decision.verdict, "invalid");
  assert.equal(saveCallCount, 0, "a context-mode invalid (validateContextFn's own context-specific validation) must NOT persist — matches src/pipeline.ts:1377-1404's buildContextMap invalid branch, which files an Issue but never calls persistOutcome");
});

test("FIX 3: valueScore flows from ObjectiveSignalPort.measure() into the persisted gateSignals (not hardcoded null)", async () => {
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass", cases: [], logs: "" }),
    measure: async () => ({ status: "pass", ratio: 0.92, valueScore: 0.85 }),
  });
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false } });

  await useCase.run({ ...baseInput, runId: "fix-3-value-score-persisted" });

  assert.ok(saved, "runHistory.save() must have been called");
  assert.equal(saved!.gateSignals.valueScore, 0.85, "valueScore must be threaded from ObjectiveSignalPort.measure() into the persisted gateSignals, matching src/pipeline.ts:3267's persistOutcome(..., valueScore, ...)");
});

test("FIX 3: an absent valueScore from ObjectiveSignalPort.measure() persists null, never a fabricated 0", async () => {
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass", cases: [], logs: "" }),
    measure: async () => ({ status: "unknown", ratio: null }), // no valueScore field at all
  });
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false } });

  await useCase.run({ ...baseInput, runId: "fix-3-value-score-absent-is-null" });

  assert.ok(saved, "runHistory.save() must have been called");
  assert.equal(saved!.gateSignals.valueScore, null, "an unwired/absent valueScore must persist as null, never a fabricated 0 or undefined");
});

test("FIX 4: errorClass is derived from the verdict (E-EXEC-FAIL on a fail), not hardcoded null", async () => {
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "fail", cases: [{ name: "login", status: "fail" }], logs: "x" }),
    generate: async () => ({ specs: ["a.spec.ts"], approved: true }),
  });
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "fix-4-error-class-exec-fail" });

  assert.equal(out.decision.verdict, "fail");
  assert.ok(saved, "runHistory.save() must have been called");
  assert.equal(saved!.errorClass, "E-EXEC-FAIL", "a fail verdict must derive errorClass:E-EXEC-FAIL via the re-ported labeler taxonomy, matching src/qa/learning/taxonomy.ts's errorClassFromVerdict");
});

test("FIX 4: errorClass is E-STATIC on an invalid verdict", async () => {
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  const { ports } = stubPorts({ validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }) });
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "fix-4-error-class-static" });

  assert.ok(saved, "runHistory.save() must have been called");
  assert.equal(saved!.errorClass, "E-STATIC", "an invalid verdict must derive errorClass:E-STATIC");
});

test("FIX 4: errorClass is E-INFRA on an infra-error verdict", async () => {
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  let waitUntilServingCall = 0;
  const { ports } = stubPorts({
    waitUntilServing: async () => {
      waitUntilServingCall++;
      return waitUntilServingCall === 1 ? ok(true) : { ok: false as const, error: new Error("DEV unhealthy") };
    },
  });
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "fix-4-error-class-infra" });

  assert.ok(saved, "runHistory.save() must have been called");
  assert.equal(saved!.errorClass, "E-INFRA", "a mid-run infra-error verdict must derive errorClass:E-INFRA");
});

test("FIX 4: errorClass is E-FLAKY on a flaky verdict", async () => {
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "flaky", cases: [{ name: "checkout", status: "flaky" as const }], logs: "" }),
  });
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "fix-4-error-class-flaky" });

  assert.ok(saved, "runHistory.save() must have been called");
  assert.equal(saved!.errorClass, "E-FLAKY", "a flaky verdict must derive errorClass:E-FLAKY");
});

test("FIX 4: errorClass is E-COVERAGE-GAP on a green run with a below-threshold coverageRatio", async () => {
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass", cases: [], logs: "" }),
    measure: async () => ({ status: "fail", ratio: 0.25 }),
  });
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({
    ...ports,
    config: { ...baseConfig, needsReview: false, coveragePolicyMode: "signal" }, // signal never blocks, but errorClass is still derived
  });

  const out = await useCase.run({ ...baseInput, runId: "fix-4-error-class-coverage-gap" });

  assert.equal(out.decision.verdict, "pass");
  assert.ok(saved, "runHistory.save() must have been called");
  assert.equal(saved!.errorClass, "E-COVERAGE-GAP", "a green run with coverageRatio below the default minRatio (0.7) must derive errorClass:E-COVERAGE-GAP");
});

test("FIX 4: errorClass is null on a clean green pass (healthy runs teach nothing, never a fabricated class)", async () => {
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass", cases: [], logs: "" }),
  });
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false } });

  await useCase.run({ ...baseInput, runId: "fix-4-error-class-clean-pass" });

  assert.ok(saved, "runHistory.save() must have been called");
  assert.equal(saved!.errorClass, null, "a clean green pass with no coverage gap must persist errorClass:null");
});

// ── Judgment-day D.7 batch 2 — closing the 3 remaining root causes the D.7 dual-engine harness
// still finds (9/21 scenarios diverge before this batch): reviewerApproved sourced from GENERATION
// (not the verdict-gated independent review), context-mode invalid must NOT persist, and the
// static-fix loop ported into the validate phase. ────────────────────────────────────────────────

test("FIX 1 (D.7 batch 2): reviewerApproved is sourced from GENERATION's own approved flag when review never genuinely runs (verdict !== 'pass')", async () => {
  // Mirrors the exact legacy shape scenarios.ts's makeDeps() exercises: `deps.review` is NEVER
  // wired at all (verified via `rg -n 'review:' scenarios.ts` — zero matches), so the legacy's
  // reviewGenerated() guard (src/pipeline.ts:1620: `if (!(app.qa.needsReview && deps.review))
  // return r;`) is ALWAYS a no-op — persistOutcome's reviewerApproved (src/pipeline.ts:1114:
  // `app.qa.needsReview && result ? result.approved : null`) ends up reading the RAW generation
  // result's own `approved` field, gated ONLY on needsReview + a non-null generation result —
  // INDEPENDENT of verdict. A "fail" verdict here proves the field is populated even though the
  // independent-review phase (verdict==="pass" gated) never ran.
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  let reviewCallCount = 0;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "fail", cases: [{ name: "login", status: "fail" as const }], logs: "x" }),
    generate: async () => ({ specs: ["a.spec.ts"], approved: true }),
  });
  ports.review.review = async () => { reviewCallCount++; return { approved: true, corrections: [], blockingCount: 0, parsed: true }; };
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig }); // needsReview: true

  const out = await useCase.run({ ...baseInput, runId: "fix-1-batch2-reviewer-approved-from-generation" });

  assert.equal(out.decision.verdict, "fail");
  assert.equal(reviewCallCount, 0, "the independent review phase must NEVER be called for a non-pass verdict (matches RunQaUseCase's own verdict==='pass' review gate)");
  assert.ok(saved, "runHistory.save() must have been called");
  assert.equal(saved!.gateSignals.reviewerApproved, true, "reviewerApproved must be sourced from GENERATION's own approved flag (needsReview gated, verdict-independent) — matching src/pipeline.ts:1114's persistOutcome call, which reads whatever AgentResult reviewGenerated returned unchanged when deps.review was never wired");
});

test("FIX 1 (D.7 batch 2): reviewerApproved reflects generation's OWN rejection (false) on a non-pass verdict, not a fabricated true", async () => {
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "invalid" as never, cases: [], logs: "" }), // unused; validate() blocks first
    validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }),
    generate: async () => ({ specs: ["a.spec.ts"], approved: false }),
  });
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig }); // needsReview: true

  const out = await useCase.run({ ...baseInput, runId: "fix-1-batch2-reviewer-approved-generation-false" });

  assert.equal(out.decision.verdict, "invalid");
  assert.ok(saved, "runHistory.save() must have been called");
  assert.equal(saved!.gateSignals.reviewerApproved, false, "a generation result with approved:false must persist reviewerApproved:false on a non-pass verdict, never a fabricated true");
});

test("FIX 1 (D.7 batch 2): reviewerApproved is ABSENT (not fabricated) when needsReview is false, regardless of verdict", async () => {
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "fail", cases: [{ name: "login", status: "fail" as const }], logs: "x" }),
    generate: async () => ({ specs: ["a.spec.ts"], approved: true }),
  });
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false } });

  const out = await useCase.run({ ...baseInput, runId: "fix-1-batch2-reviewer-approved-needs-review-false" });

  assert.equal(out.decision.verdict, "fail");
  assert.ok(saved, "runHistory.save() must have been called");
  assert.equal(saved!.gateSignals.reviewerApproved, undefined, "needsReview:false must never persist a reviewerApproved value (matches the legacy's `app.qa.needsReview && result ? ... : null` guard's first conjunct)");
});

// ── Fix 5 (engram #961) — the publish() call site threads reviewerApproved/coverageBlocks into the
// widened PublicationPort decision. Scope note (judgment-day): these tests pin FIELD THREADING only
// (the fields reach publish() instead of being dropped). They cannot pin value PROVENANCE — decide()
// only returns sideEffect "pr" when reviewerApproved===true && blocksPublish===false, so at this
// call site the values are structurally constant. The dynamic-over-static override semantics
// (a real computed false beating a static ctx true) are owned by the adapter-level tests in
// publication-port.adapter.test.ts.

test("FIX 5: publish() is called with the reviewerApproved field threaded (not dropped) on the 'pr' side effect", async () => {
  let publishedDecision: { verdict: string; reviewerApproved?: boolean; coverageBlocks?: boolean } | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass", cases: [], logs: "" }),
    review: async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true }),
  });
  ports.publication.publish = async (decision) => { publishedDecision = decision; return { outcome: "pr" }; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig }); // needsReview: true

  const out = await useCase.run({ ...baseInput, runId: "fix-5-publish-reviewer-approved-true" });

  assert.equal(out.decision.sideEffect, "pr");
  assert.ok(publishedDecision, "publication.publish() must have been called for the 'pr' side effect");
  assert.equal(publishedDecision!.reviewerApproved, true, "publish() must receive a threaded reviewerApproved field (undefined here would mean the call site dropped it)");
});

test("FIX 5: publish() is called with the coverageBlocks field threaded (not dropped) under signal-mode coverage", async () => {
  let publishedDecision: { verdict: string; reviewerApproved?: boolean; coverageBlocks?: boolean } | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass", cases: [], logs: "" }),
    measure: async () => ({ status: "fail", ratio: 0.2 }),
  });
  ports.publication.publish = async (decision) => { publishedDecision = decision; return { outcome: "pr" }; };
  const useCase = new RunQaUseCase({
    ...ports,
    config: { ...baseConfig, needsReview: false, coveragePolicyMode: "signal" },
  });

  const out = await useCase.run({ ...baseInput, runId: "fix-5-publish-coverage-blocks-false" });

  assert.equal(out.decision.sideEffect, "pr", "signal mode must still publish even with a failing coverage signal");
  assert.ok(publishedDecision, "publication.publish() must have been called");
  assert.equal(publishedDecision!.coverageBlocks, false, "publish() must receive a threaded coverageBlocks field (undefined here would mean the call site dropped it)");
});

test("FIX 1 (D.7 batch 2): reviewerApproved on a genuine pass+review call still reflects the INDEPENDENT reviewer's verdict, not generation's", async () => {
  // Guards against a regression where FIX 1 batch 2 accidentally always sources reviewerApproved
  // from generation — on a genuine pass verdict with needsReview:true, the independent REVIEW
  // phase's own approved/rejected verdict must win, even when it disagrees with generation's.
  let saved: import("@kernel/run-outcome.ts").RunOutcome | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass", cases: [], logs: "" }),
    generate: async () => ({ specs: ["a.spec.ts"], approved: true }), // generation self-approves
    review: async () => ({ approved: false, corrections: ["[false-positive] x"], blockingCount: 1, parsed: true }), // reviewer rejects
  });
  ports.runHistory.save = async (outcome) => { saved = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig }); // needsReview: true

  await useCase.run({ ...baseInput, runId: "fix-1-batch2-genuine-review-wins" });

  assert.ok(saved, "runHistory.save() must have been called");
  assert.equal(saved!.gateSignals.reviewerApproved, false, "on a genuine pass+review call, the INDEPENDENT reviewer's verdict must be persisted, not generation's own self-approval");
});

test("FIX 2 (D.7 batch 2): a context-mode INVALID result does NOT persist (matches the legacy's buildContextMap invalid branch, which files an Issue but never calls persistOutcome)", async () => {
  // Root-cause (bug-register Entry 12, FIX 2's newly-found gap): src/pipeline.ts:1377-1404's
  // context-mode invalid-context.json branch calls issueOrShadow() then returns resultOf(ns,
  // "invalid", ...) WITHOUT ever calling persistOutcome — a DIFFERENT "invalid" than the generic
  // static-gate invalid terminalResult covers (this is validateContextFn's own context-specific
  // validation, not the generic ValidationPort gate). This is the SAME no-persist convention as the
  // clean context pass (already covered by the existing "FIX 2: a CLEAN context-mode pass..." test
  // above) — extended here to context-mode's OWN invalid path, distinct from every OTHER mode's
  // generic static-gate invalid (which DOES persist, per the "FIX 2: a context-mode INVALID result
  // still persists..." test's PRE-EXISTING assertion, now narrowed to non-context-mode invalids only
  // — see the FIX below for how the two are distinguished).
  let saveCallCount = 0;
  let foldCallCount = 0;
  const { ports } = stubPorts({
    generate: async () => ({ specs: [".qa/context.json"], approved: true, note: "tried" }),
    validate: async () => ({ ok: false, errors: ["feBe[0]: route '/ghost' is not declared in 'routes'"] }),
  });
  ports.runHistory.save = async () => { saveCallCount++; };
  ports.learning.fold = async () => { foldCallCount++; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "fix-2-batch2-context-invalid-no-persist", mode: "context" });

  assert.equal(out.decision.verdict, "invalid");
  assert.equal(saveCallCount, 0, "a context-mode invalid (validateContextFn's own context-specific validation) must NOT call runHistory.save() — matches src/pipeline.ts:1377-1404's buildContextMap invalid branch, which files an Issue but never calls persistOutcome");
  assert.equal(foldCallCount, 0, "a context-mode invalid must NOT call learning.fold() either — the legacy's early return never reaches foldRunLearning at all");
});

test("FIX 2 (D.7 batch 2): a GENERIC (non-context-mode) invalid still persists exactly as before (guards against FIX 2's widened no-persist exemption over-firing)", async () => {
  let saveCallCount = 0;
  const { ports } = stubPorts({ validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }) });
  ports.runHistory.save = async () => { saveCallCount++; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "fix-2-batch2-generic-invalid-still-persists", mode: "diff" });

  assert.equal(out.decision.verdict, "invalid");
  assert.equal(saveCallCount, 1, "a diff-mode (non-context) invalid must still call runHistory.save() exactly once — the context-mode no-persist exemption must be scoped to mode==='context' only, never leak into other modes");
});

test("FIX 3 (D.7 batch 2): a failing static gate is repaired by regenerating with the validation errors, then re-validated (the static-fix loop), instead of dying invalid on the first miss", async () => {
  // Ports the legacy's static-fix loop VERBATIM into the validate phase (src/pipeline.ts:2258-2278):
  // on a repairable static-gate failure, regenerate with the validation errors fed back
  // (baseGenInput({ reviewCorrections: [...] })) and re-validate, bounded by MAX_STATIC_FIX_ROUNDS
  // (=2). A single trivial error recovers on the FIRST repair round (this scenario mirrors
  // scenarios.ts:static-repair-recovers exactly: validate() fails once, then ok:true).
  let validateCallCount = 0;
  let generateCallCount = 0;
  const { ports } = stubPorts({
    validate: async () => {
      validateCallCount++;
      return validateCallCount === 1
        ? { ok: false, errors: ["39:11  error  'specialtyCell' is assigned a value but never used"] }
        : { ok: true, errors: [] };
    },
    generate: async () => { generateCallCount++; return { specs: ["a.spec.ts"], approved: true }; },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "fix-3-batch2-static-repair-recovers" });

  assert.equal(out.decision.verdict, "pass", "a static gate repaired within the bound must recover to the SAME pass verdict the legacy static-repair loop converges to, not invalid");
  assert.equal(out.decision.sideEffect, "pr");
  assert.equal(validateCallCount, 2, "the static-fix loop must re-validate after the repair regen (1 initial fail + 1 recovery pass)");
  assert.ok(generateCallCount >= 2, `the static-fix loop must regenerate at least once to repair the static gate, got ${generateCallCount} generate() call(s)`);
  assert.equal(out.gateSignals.retries, 1, "matches the legacy static-repair loop's own retries++ per repair round (src/pipeline.ts:2265) — 1 repair round consumed");
});

test("FIX 3 (D.7 batch 2): the static-fix loop is bounded by MAX_STATIC_FIX_ROUNDS (2) — a static gate that never recovers still resolves to invalid, not an infinite loop", async () => {
  let validateCallCount = 0;
  let generateCallCount = 0;
  const { ports } = stubPorts({
    validate: async () => { validateCallCount++; return { ok: false, errors: ["permanently broken lint error"] }; },
    generate: async () => { generateCallCount++; return { specs: ["a.spec.ts"], approved: true }; },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "fix-3-batch2-static-repair-bound" });

  assert.equal(out.decision.verdict, "invalid", "a static gate still red after the repair budget is exhausted must resolve to invalid, matching the legacy's own bounded loop");
  assert.equal(validateCallCount, 1 + 2, "MAX_STATIC_FIX_ROUNDS=2 means exactly 1 initial validate() + 2 repair-round re-validates (3 total), matching src/pipeline.ts:804's MAX_STATIC_FIX_ROUNDS constant verbatim — never an unbounded loop");
  assert.equal(generateCallCount, 1 + 2, "exactly 2 repair regenerations on top of the initial generate() call — bounded, not unbounded");
});

test("FIX 3 (D.7 batch 2): the static-fix loop is SKIPPED entirely when generation produced zero specs (nothing to repair)", async () => {
  // Mirrors the legacy's own loop guard: `generating && (result?.specs.length ?? 0) > 0` (src/
  // pipeline.ts:2260-2261) — a validate() failure with zero generated specs must not enter a repair
  // loop with nothing to regenerate against.
  let validateCallCount = 0;
  let generateCallCount = 0;
  const { ports } = stubPorts({
    validate: async () => { validateCallCount++; return { ok: false, errors: ["no specs were generated to validate"] }; },
    generate: async () => { generateCallCount++; return { specs: [], approved: false }; },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "fix-3-batch2-static-repair-skip-zero-specs" });

  assert.equal(out.decision.verdict, "invalid");
  assert.equal(validateCallCount, 1, "zero generated specs must skip the static-fix loop entirely — exactly 1 validate() call, no repair re-validates");
  assert.equal(generateCallCount, 1, "the static-fix loop must never regenerate when there is nothing to repair (matches the legacy's (result?.specs.length ?? 0) > 0 guard)");
});

// ── Plan 7.1 — AbortSignal propagation (closes the rewritten cancellation gap, engram #913).
// The queue's AbortSignal is a SEPARATE transport arg on run(), not a field on RunQaInput —
// mirrors the legacy runPipeline's own trailing signal parameter. An already-aborted signal must
// short-circuit BEFORE any port is called (no execution, no generation, no publish, no persist) —
// this is a cancellation, not a real failure to teach the learner from. ─────────────────────────

test("run() honors an already-aborted signal — no execution, no generation, no persist", async () => {
  const controller = new AbortController();
  controller.abort();
  let generated = false;
  let executed = false;
  let saved = false;
  const { ports } = stubPorts({
    generate: async () => { generated = true; return { specs: ["a.spec.ts"], approved: true }; },
    execute: async () => { executed = true; return { verdict: "pass", cases: [], logs: "" }; },
  });
  ports.runHistory.save = async () => { saved = true; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "plan7-1-already-aborted" }, controller.signal);

  assert.equal(generated, false, "generation must never run once the signal is already aborted");
  assert.equal(executed, false, "execution must never run once the signal is already aborted");
  assert.equal(saved, false, "an aborted run must not persist a RunOutcome (it is a cancellation, not a real result)");
  assert.equal(out.decision.verdict, "infra-error", "matches cancelTrackedRun's own aborted-terminal mapping (src/server/runner.ts)");
  assert.equal(out.decision.sideEffect, "none");
});

test("run() aborted mid-run (between validate and execute) stops before execute() and does not persist", async () => {
  const controller = new AbortController();
  let executed = false;
  const { ports } = stubPorts({
    validate: async () => { controller.abort(); return { ok: true, errors: [] }; },
    execute: async () => { executed = true; return { verdict: "pass", cases: [], logs: "" }; },
  });
  let saved = false;
  ports.runHistory.save = async () => { saved = true; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "plan7-1-mid-run-abort" }, controller.signal);

  assert.equal(executed, false, "execution must never run once the signal aborts mid-run");
  assert.equal(saved, false);
  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(out.decision.sideEffect, "none");
});

test("run() with no signal at all behaves exactly as before (no second-arg regression)", async () => {
  const { ports } = stubPorts();
  const useCase = new RunQaUseCase(ports);

  const out = await useCase.run(baseInput);

  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.decision.sideEffect, "pr");
});

// Plan 7.2 (closes the INFO gap in engram #916): the static-fix while loop (~line 237,
// MAX_STATIC_FIX_ROUNDS) had NO signal?.aborted check inside its own loop body — a cancel
// requested mid-repair would still burn out the full repair budget (up to MAX_STATIC_FIX_ROUNDS
// generate()+validate() round-trips) before the NEXT phase-boundary check (post-validate,
// pre-health) could ever catch it. This closes that residual unbounded-wall-clock-inside-the-loop
// gap, matching the same phase-boundary discipline the other 5 checks already established.
test("run() aborted mid-repair inside the static-fix loop stops before consuming the full repair budget", async () => {
  const controller = new AbortController();
  let validateCallCount = 0;
  let generateCallCount = 0;
  const { ports } = stubPorts({
    validate: async () => {
      validateCallCount++;
      if (validateCallCount === 1) {
        // Abort right after the FIRST validate() fails — the loop's own next generate() call
        // (the repair round) must observe the abort and stop, never reaching a 2nd repair round.
        controller.abort();
      }
      return { ok: false, errors: ["permanently broken lint error"] };
    },
    generate: async () => { generateCallCount++; return { specs: ["a.spec.ts"], approved: true }; },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "plan7-2-abort-inside-static-fix-loop" }, controller.signal);

  assert.equal(out.decision.verdict, "infra-error", "an abort observed mid-repair must map to the SAME aborted-terminal shape every other phase-boundary check uses");
  assert.equal(out.decision.sideEffect, "none");
  assert.ok(generateCallCount <= 2, `the static-fix loop must stop repairing once the signal aborts — expected at most 2 generate() calls (1 initial + at most 1 repair attempt), got ${generateCallCount}`);
  assert.ok(validateCallCount <= 2, `the static-fix loop must stop re-validating once the signal aborts — expected at most 2 validate() calls, got ${validateCallCount}`);
});

test("FIX E: infra-error calls runHistory.save() but NOT learning.fold()", async () => {
  let saveCallCount = 0;
  let foldCallCount = 0;
  // FIX E's table targets the MID-RUN health pre-flight (src/pipeline.ts:2328-2337), which fires
  // AFTER the static gate passes — distinct from the ENTRY gate (src/pipeline.ts's waitForDeploy,
  // which THROWS in the legacy rather than reaching persistOutcome at all, so it has no
  // persist/fold call to port). Both this use-case's entry gate AND its mid-run pre-flight derive
  // from the SAME DeployGatePort.waitUntilServing (per the D.5 apply-progress's own documented
  // "shared DeployGatePort for both concerns" design) — so the first call must succeed (passes the
  // entry gate) and only the SECOND call (the mid-run pre-flight, after validate) must fail, to
  // exercise the terminalResult("infra-error", ...) branch this fix actually targets.
  let waitUntilServingCall = 0;
  const { ports } = stubPorts({
    waitUntilServing: async () => {
      waitUntilServingCall++;
      return waitUntilServingCall === 1 ? ok(true) : { ok: false as const, error: new Error("DEV unhealthy") };
    },
  });
  ports.runHistory.save = async () => { saveCallCount++; };
  ports.learning.fold = async () => { foldCallCount++; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "fix-e-infra-error" });

  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(saveCallCount, 1, "infra-error must call runHistory.save() exactly once (matches persistOutcome at pipeline.ts:2328-2337)");
  assert.equal(foldCallCount, 0, "infra-error must NEVER call learning.fold() (the legacy never calls foldRunLearning for this source)");
});

// ── Change-coverage keystone: classificationDiff threading into ObjectiveSignalPort.measure() ───
// The "dynamic diff" precedent (already proven for generation/review in this file's other tests):
// classify() (diff mode only) returns the run's real commit diff, hoisted to `classificationDiff`,
// and reused across generation/review/repair. This closes the LAST missing thread — measure() must
// see the SAME real diff, so the ChangeCoverage assembler (when wired) can actually run, instead of
// silently staying "unknown" forever regardless of policy mode.

test("KEYSTONE: a diff-mode PASS run threads classificationDiff into ObjectiveSignalPort.measure()'s 3rd arg", async () => {
  let seenDiff: string | undefined = "UNSET";
  const { ports } = stubPorts({
    classify: async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "diff --git a/src/x.ts b/src/x.ts" }),
    measure: async (_br, _specDir, diff) => {
      seenDiff = diff;
      return { status: "unknown", ratio: null };
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, mode: "diff", runId: "keystone-diff-mode" });

  assert.equal(seenDiff, "diff --git a/src/x.ts b/src/x.ts", "measure() must receive the SAME real diff classify() returned, not a static/absent value");
});

test("KEYSTONE: a non-diff mode run never has a classificationDiff — measure() sees diff:undefined", async () => {
  let seenDiff: string | undefined = "UNSET";
  const { ports } = stubPorts({
    measure: async (_br, _specDir, diff) => {
      seenDiff = diff;
      return { status: "unknown", ratio: null };
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, mode: "complete", runId: "keystone-non-diff-mode" });

  assert.equal(seenDiff, undefined, "classify() is only ever called in diff mode (CLAUDE.md 'Run modes'), so complete/exhaustive/manual/context must never fabricate a diff for measure()");
});

// ── Cross-repo coverage guard (dual-judge finding) ─────────────────────────────
// Legacy's coverage-collect gate is `mode === "diff" && ... && !triggerService` (src/pipeline.ts:2912)
// — a cross-repo (deploy-event) run's changed lines live in the SERVICE repo, which browser V8
// coverage cannot map (CLAUDE.md: "Change-coverage is unknown for these [cross-repo] runs"). The
// keystone invariant is "unknown" NEVER blocks, so a cross-repo diff run must starve the assembler
// (measure() sees diff:undefined) exactly like a non-diff-mode run, even though classify() DID run
// and DID produce a real classificationDiff.

test("KEYSTONE: a diff-mode PASS run WITH input.triggerRepo set — measure() sees diff:undefined despite classify() producing a real diff", async () => {
  let seenDiff: string | undefined = "UNSET";
  const { ports } = stubPorts({
    classify: async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "diff --git a/src/x.ts b/src/x.ts" }),
    measure: async (_br, _specDir, diff) => {
      seenDiff = diff;
      return { status: "unknown", ratio: null };
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, mode: "diff", runId: "keystone-cross-repo", triggerRepo: "org/orders-svc" });

  assert.equal(seenDiff, undefined, "a cross-repo run must starve ObjectiveSignalPort.measure()'s diff arg — the assembler must never be invoked (browser coverage cannot map service-repo lines), mirroring legacy's !triggerService gate");
});

test("KEYSTONE: the SAME diff-mode PASS run WITHOUT input.triggerRepo still threads the real classificationDiff", async () => {
  let seenDiff: string | undefined = "UNSET";
  const { ports } = stubPorts({
    classify: async () => ({ action: "generate", reason: "diff touches src/x.ts", diff: "diff --git a/src/x.ts b/src/x.ts" }),
    measure: async (_br, _specDir, diff) => {
      seenDiff = diff;
      return { status: "unknown", ratio: null };
    },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, mode: "diff", runId: "keystone-monorepo-control" });

  assert.equal(seenDiff, "diff --git a/src/x.ts b/src/x.ts", "a monorepo (non-cross-repo) run must be unaffected by the triggerRepo guard — control case for the test above");
});

// ── ObserverPort wiring (bug fix): the rewritten engine's RunRecord/RunEvents stayed frozen
// because RunQaUseCase never called an observer at any phase boundary — ObserverPort existed at
// the port barrel but nothing in this use-case ever reached for `this.deps.observer`. These tests
// pin (1) the phase-boundary emission order on a representative happy path, and (2) that an
// absent observer remains a pure no-op (backward compatible with every pre-existing test/
// composition above, none of which supply one). ──────────────────────────────────────────────────

function fakeObserver(): { observer: import("@contexts/qa-run-orchestration/application/ports/index.ts").ObserverPort; steps: Array<{ step: string; detail?: string }> } {
  const steps: Array<{ step: string; detail?: string }> = [];
  return {
    observer: {
      onStep(step, detail) {
        steps.push({ step, ...(detail !== undefined ? { detail } : {}) });
      },
      onEvent() {
        /* not exercised by these tests — RunQaUseCase never calls onEvent today */
      },
    },
    steps,
  };
}

test("ObserverPort: a diff-mode green-pr run emits gate -> classify -> setup -> generate -> validate -> health -> execute -> coverage -> decide -> done, in order", async () => {
  // stubPorts() wires a default SetupPort (see this file's own stubPorts() above), matching the
  // scenario this suite's other green-pr pin already exercises — the "setup" step is therefore
  // expected here too, not a gap.
  const { ports } = stubPorts();
  const { observer, steps } = fakeObserver();
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig, observer });

  const out = await useCase.run({ ...baseInput, mode: "diff" });

  assert.equal(out.decision.verdict, "pass");
  assert.deepEqual(
    steps.map((s) => s.step),
    ["gate", "classify", "setup", "generate", "validate", "health", "execute", "coverage", "decide", "done"],
  );
});

test("ObserverPort: the setup phase is SKIPPED (no 'setup' step) when RunQaUseCaseDeps.setup is absent", async () => {
  const { ports } = stubPorts();
  const { setup: _unusedSetup, ...portsWithoutSetup } = ports;
  const { observer, steps } = fakeObserver();
  const useCase = new RunQaUseCase({ ...portsWithoutSetup, config: baseConfig, observer });

  await useCase.run({ ...baseInput, mode: "diff" });

  assert.deepEqual(
    steps.map((s) => s.step),
    ["gate", "classify", "generate", "validate", "health", "execute", "coverage", "decide", "done"],
  );
});

test("ObserverPort: a classify-skip emits gate -> classify -> done, matching the legacy's bare-return (no generate/validate/execute)", async () => {
  const { ports } = stubPorts({ classify: async () => ({ action: "skip", reason: "docs-only change", diff: "" }) });
  const { observer, steps } = fakeObserver();
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig, observer });

  const out = await useCase.run({ ...baseInput, mode: "diff" });

  assert.equal(out.decision.verdict, "skipped");
  assert.deepEqual(steps.map((s) => s.step), ["gate", "classify", "done"]);
});

test("ObserverPort: a failing execute() emits a 'retry' step (fix-loop engaged) before the eventual done", async () => {
  const { ports } = stubPorts({ execute: async () => ({ verdict: "fail", cases: [], logs: "" }) });
  const { observer, steps } = fakeObserver();
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig, observer });

  const out = await useCase.run({ ...baseInput, mode: "diff" });

  assert.equal(out.decision.verdict, "fail");
  assert.ok(steps.some((s) => s.step === "retry"), "a failing execute() must engage the FixLoop, observed as a 'retry' step");
  assert.equal(steps.at(-1)?.step, "done", "every exit path terminates with a 'done' step");
  // A fail verdict never reaches "coverage" (ObjectiveSignalPort.measure() only runs on a pass).
  assert.ok(!steps.some((s) => s.step === "coverage"), "coverage is never measured for a non-pass verdict");
});

test("ObserverPort: a static-gate repair round emits its own 'retry' step with a round-number detail", async () => {
  let validateCalls = 0;
  const { ports } = stubPorts({
    validate: async () => {
      validateCalls++;
      // Fails once, then passes — exercises exactly ONE static-fix repair round.
      return validateCalls === 1 ? { ok: false, errors: ["unused var"] } : { ok: true, errors: [] };
    },
  });
  const { observer, steps } = fakeObserver();
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig, observer });

  await useCase.run({ ...baseInput, mode: "diff" });

  const retrySteps = steps.filter((s) => s.step === "retry");
  assert.equal(retrySteps.length, 1);
  assert.match(retrySteps[0]?.detail ?? "", /static-fix round 1\/2/);
});

test("ObserverPort: an infra-error entry-gate terminal emits gate -> done only (no classify/generate reached)", async () => {
  const { ports } = stubPorts({
    waitUntilServing: async () => err(new Error("DEV did not serve sha within 60000ms")),
  });
  const { observer, steps } = fakeObserver();
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig, observer });

  const out = await useCase.run({ ...baseInput, mode: "diff" });

  assert.equal(out.decision.verdict, "infra-error");
  assert.deepEqual(steps.map((s) => s.step), ["gate", "done"]);
});

test("ObserverPort: an already-aborted signal short-circuits straight to a single 'done' step (no gate/classify/generate reached)", async () => {
  const { ports } = stubPorts();
  const { observer, steps } = fakeObserver();
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig, observer });
  const controller = new AbortController();
  controller.abort();

  const out = await useCase.run({ ...baseInput, mode: "diff" }, controller.signal);

  assert.equal(out.decision.verdict, "infra-error");
  // abortedResult() reuses infraErrorResult()'s shared terminal, which now uniformly emits "done"
  // on every exit path (mainline, skip, invalid/infra-error) — so a cancelled-before-start run
  // still reports itself as terminal to any observer, even though it never reached "gate".
  assert.deepEqual(steps.map((s) => s.step), ["done"]);
});

test("ObserverPort: an ABSENT observer is a pure no-op — every RunQaUseCaseDeps consumer that predates this fix keeps compiling and behaving identically", async () => {
  const { ports } = stubPorts();
  // Deliberately NOT passing `observer` — this is every pre-existing test/composition in this
  // file and across the codebase today.
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await assert.doesNotReject(useCase.run({ ...baseInput, mode: "diff" }));
});
