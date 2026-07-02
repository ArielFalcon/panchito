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
  PreExecGroundingPort,
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
  capture: PreExecGroundingPort["capture"];
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
  const preExecGrounding: PreExecGroundingPort | undefined = overrides.capture
    ? { capture: overrides.capture }
    : undefined;

  return {
    ports: { changeAnalysis, generation, review, validation, execution, objectiveSignal, publication, learning, workspace, deployGate, runHistory, setup, ...(preExecGrounding ? { preExecGrounding } : {}) },
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

test("RunQaUseCase: emits preExecAmbiguityCatches:0 + deterministicSelectorBlocks:0 (number, not undefined) when PreExecGroundingPort is ABSENT ([SWAP])", async () => {
  const { ports } = stubPorts();
  const useCase = new RunQaUseCase(ports);

  const out = await useCase.run(baseInput);

  assert.equal(typeof out.gateSignals.preExecAmbiguityCatches, "number");
  assert.equal(out.gateSignals.preExecAmbiguityCatches, 0);
  assert.equal(typeof out.gateSignals.deterministicSelectorBlocks, "number");
  assert.equal(out.gateSignals.deterministicSelectorBlocks, 0);
});

// ── B5.3: PreExecGroundingPort wired — real counters, corrective regen, W2 deterministic block ──
// A page-rooted, page.goto("/owners")-targeting spec source drives the ambiguity check (matches the
// captured route by name, per the domain service's per-spec route pairing); a getByTestId-only spec
// drives the catalog gate independently.
const AMBIGUOUS_SPEC_SOURCE = `await page.goto("/owners"); await page.getByRole("heading", { name: "Owners" }).click();`;
const FABRICATED_TESTID_SPEC_SOURCE = `await page.goto("/owners"); await page.getByTestId("ghost-id").click();`;
const CLEAN_SPEC_SOURCE = `await page.goto("/owners"); await page.getByRole("heading", { name: "Owners" }).click();`;

test("RunQaUseCase: PreExecGroundingPort wired — a captured ambiguity is counted in preExecAmbiguityCatches", async () => {
  const { ports } = stubPorts({
    capture: async () => ({
      specSources: [AMBIGUOUS_SPEC_SOURCE],
      routes: [{ route: "/owners", nodes: ["heading: Owners", "heading: Owners"] }],
    }),
    generate: async () => ({
      specs: ["a.spec.ts"],
      approved: true,
    }),
  });
  const useCase = new RunQaUseCase(ports);

  const out = await useCase.run(baseInput);

  assert.equal(out.gateSignals.preExecAmbiguityCatches, 1);
});

test("RunQaUseCase: PreExecGroundingPort wired — corrections feed the ONE-SHOT corrective regen via selectorContradictions", async () => {
  const generateCalls: Array<{ enrichment?: { selectorContradictions?: readonly string[] } }> = [];
  const { ports } = stubPorts({
    capture: async () => ({
      specSources: [AMBIGUOUS_SPEC_SOURCE],
      routes: [{ route: "/owners", nodes: ["heading: Owners", "heading: Owners"] }],
    }),
    generate: async (_objectives, _specDir, _signal, _diff, enrichment) => {
      generateCalls.push({ enrichment });
      return { specs: ["a.spec.ts"], approved: true };
    },
  });
  const useCase = new RunQaUseCase(ports);

  await useCase.run(baseInput);

  // The FIRST generate() call is the initial pass (no corrections yet — nothing captured before it).
  // The pre-exec gate runs AFTER it, catches the ambiguity, and feeds it into exactly ONE corrective
  // regen call (the one-shot repair channel), mirroring legacy's W1 (src/pipeline.ts:2166-2188).
  const correctiveCall = generateCalls.find((c) => (c.enrichment?.selectorContradictions?.length ?? 0) > 0);
  assert.ok(correctiveCall, "expected one generate() call carrying selectorContradictions");
  assert.match(correctiveCall!.enrichment!.selectorContradictions![0]!, /MULTIPLE/);
});

test("RunQaUseCase: PreExecGroundingPort wired — a PERSISTING ambiguity after the corrective regen holds the run invalid (W2 deterministic block)", async () => {
  const { ports } = stubPorts({
    // The stub generation port never actually rewrites specs to resolve the ambiguity (the corrective
    // regen is a no-op from the gate's point of view) — capture() keeps reporting the SAME
    // duplicate-node tree every call, so the ambiguity PERSISTS after the one-shot repair.
    capture: async () => ({
      specSources: [AMBIGUOUS_SPEC_SOURCE],
      routes: [{ route: "/owners", nodes: ["heading: Owners", "heading: Owners"] }],
    }),
    generate: async () => ({ specs: ["a.spec.ts"], approved: true }),
  });
  const useCase = new RunQaUseCase(ports);

  const out = await useCase.run(baseInput);

  assert.equal(out.decision.verdict, "invalid");
  assert.equal(out.decision.sideEffect, "issue");
  assert.ok(out.gateSignals.deterministicSelectorBlocks > 0);
});

test("RunQaUseCase: PreExecGroundingPort wired — catalog-gate fail-closed corrections NEVER trigger the deterministic block (safe direction)", async () => {
  // A fabricated test-id (catalog gate) with ZERO role-based ambiguity — the block must stay
  // ambiguity-only; a catalog correction alone can never hold the run invalid, only feed the
  // one-shot repair (the established safe-direction split — catalogGate* is telemetry, not a gate).
  const { ports } = stubPorts({
    capture: async () => ({
      specSources: [FABRICATED_TESTID_SPEC_SOURCE],
      routes: [{ route: "/owners", nodes: [], status: "captured", settled: true, testIds: new Map() }],
    }),
    generate: async () => ({ specs: ["a.spec.ts"], approved: true }),
  });
  const useCase = new RunQaUseCase(ports);

  const out = await useCase.run(baseInput);

  assert.equal(out.gateSignals.preExecAmbiguityCatches, 0);
  assert.equal(out.gateSignals.deterministicSelectorBlocks, 0);
  assert.notEqual(out.decision.verdict, "invalid");
});

test("RunQaUseCase: PreExecGroundingPort wired — a clean capture (no ambiguity) leaves the run green, zero counters", async () => {
  const { ports } = stubPorts({
    capture: async () => ({
      specSources: [CLEAN_SPEC_SOURCE],
      routes: [{ route: "/owners", nodes: ["heading: Owners"] }],
    }),
  });
  const useCase = new RunQaUseCase(ports);

  const out = await useCase.run(baseInput);

  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.gateSignals.preExecAmbiguityCatches, 0);
  assert.equal(out.gateSignals.deterministicSelectorBlocks, 0);
});

test("RunQaUseCase: PreExecGroundingPort wired — a FixLoop regen (post-execution-failure) also receives pre-exec corrections via selectorContradictions", async () => {
  let executeCalls = 0;
  let captureCalls = 0;
  const generateCalls: Array<{ enrichment?: { selectorContradictions?: readonly string[]; fixCases?: readonly unknown[] } }> = [];
  const { ports } = stubPorts({
    // W1 (1st capture call) sees the ambiguity -> triggers the one-shot corrective regen and sets
    // pendingSelectorContradictions. W2's re-check (2nd capture call, post-static-fix-loop) sees a
    // CLEAN tree (the corrective regen "fixed" it from the gate's point of view) -> validation.ok
    // stays true -> the run proceeds to execute() with pendingSelectorContradictions STILL holding
    // W1's corrections (nothing clears it until a FixLoop regen actually consumes it).
    capture: async () => {
      captureCalls++;
      const nodes = captureCalls === 1 ? ["heading: Owners", "heading: Owners"] : ["heading: Owners"];
      return { specSources: [AMBIGUOUS_SPEC_SOURCE], routes: [{ route: "/owners", nodes }] };
    },
    generate: async (_objectives, _specDir, _signal, _diff, enrichment) => {
      generateCalls.push({ enrichment });
      return { specs: ["a.spec.ts"], approved: true };
    },
    execute: async () => {
      executeCalls++;
      // First execute (post static-gate) fails -> engages the FixLoop; subsequent retries pass so
      // the loop terminates promptly.
      if (executeCalls === 1) {
        return { verdict: "fail", cases: [{ name: "owners", status: "fail", detail: "boom" }], logs: "" };
      }
      return { verdict: "pass", cases: [{ name: "owners", status: "pass" }], logs: "" };
    },
  });
  const useCase = new RunQaUseCase(ports);

  const out = await useCase.run(baseInput);
  assert.notEqual(out.decision.verdict, "invalid", "sanity: the run must reach execute()/FixLoop, not hold invalid at W2");

  // At least one generate() call during/after the FixLoop's own engagement carries BOTH fixCases
  // (the FixLoop's own regen context) AND selectorContradictions (W1's leftover pre-exec
  // corrections) — proving the gate's corrections reach the FixLoop's regen channel too, not just
  // the pre-execution W1 corrective regen.
  const fixLoopCallWithCorrections = generateCalls.find(
    (c) => (c.enrichment?.fixCases?.length ?? 0) > 0 && (c.enrichment?.selectorContradictions?.length ?? 0) > 0,
  );
  assert.ok(fixLoopCallWithCorrections, "expected a FixLoop regen call carrying both fixCases and selectorContradictions");
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

test("RunQaUseCase — shadow: publish() IS called (dispatches to PublicationPort, which routes shadow-log internally)", async () => {
  // F1 fix (audit, CRITICAL): before this fix, ONLY sideEffect==="pr" ever called publish() — shadow
  // mode's "shadow-log" side effect silently never reached the publish port, so a shadow-mode green
  // run never logged anything (CLAUDE.md "Shadow mode... replaces every PR/Issue side effect with a
  // log line" — a promise the use-case could not keep on its own, since PublicationPortAdapter's
  // shadow-log routing (publication-port.adapter.ts:103-107) was simply unreachable). RunQaUseCase's
  // own scope is the DECISION (sideEffect !== "none"), not which concrete side effect the real
  // PublicationPortAdapter picks — routing shadow-log vs pr vs issue is that adapter's own decide()
  // collaborator's job (see publish-decision.service.ts), exercised separately in
  // publication-port.adapter.test.ts. This test's job is proving the WIRING reaches the port at all.
  let publishCallCount = 0;
  const { ports } = stubPorts({ execute: async () => ({ verdict: "pass", cases: [], logs: "" }) });
  ports.publication.publish = async () => { publishCallCount++; return { outcome: "shadow: shadow mode — side effects replaced with logs" }; };
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, shadow: true } });

  const out = await useCase.run({ ...baseInput, runId: "golden-shadow-wiring-proof" });

  assert.equal(out.decision.sideEffect, "shadow-log");
  assert.equal(publishCallCount, 1, "shadow mode's sideEffect ('shadow-log' !== 'none') must still dispatch to the publish port — the REAL PublicationPortAdapter is what routes it to a log line, not this use-case skipping the call");
  assert.equal(out.note, "shadow: shadow mode — side effects replaced with logs", "the publish outcome must thread into RunQaResult.note");
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

// ── FIX (judgment-day, cross-engine parity): the legacy runner only ever emits onStep("coverage")
// inside its own `mode === "diff" && ... && !triggerService` gate (src/pipeline.ts:2912). Before
// this fix, RunQaUseCase emitted "coverage" on EVERY passing verdict regardless of mode/triggerRepo
// — a step the legacy engine never produces for those runs. These three tests pin the gate exactly:
// a non-diff pass never emits it, a diff-mode pass DOES (already pinned above), and a cross-repo
// diff-mode pass does NOT. ──────────────────────────────────────────────────────────────────────

test("ObserverPort: a non-diff-mode (complete) PASS run never emits a 'coverage' step, mirroring the legacy's mode==='diff' gate", async () => {
  const { ports } = stubPorts();
  const { observer, steps } = fakeObserver();
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig, observer });

  const out = await useCase.run({ ...baseInput, runId: "coverage-step-non-diff-mode", mode: "complete" });

  assert.equal(out.decision.verdict, "pass");
  assert.ok(!steps.some((s) => s.step === "coverage"), "a non-diff mode pass must never emit 'coverage' — legacy's own onStep('coverage') site lives strictly inside the mode==='diff' branch (src/pipeline.ts:2919)");
});

test("ObserverPort: a diff-mode PASS run WITH triggerRepo set never emits a 'coverage' step, mirroring the legacy's !triggerService conjunct", async () => {
  const { ports } = stubPorts();
  const { observer, steps } = fakeObserver();
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig, observer });

  const out = await useCase.run({ ...baseInput, runId: "coverage-step-cross-repo", mode: "diff", triggerRepo: "org/orders-svc" });

  assert.equal(out.decision.verdict, "pass");
  assert.ok(!steps.some((s) => s.step === "coverage"), "a cross-repo diff-mode pass must never emit 'coverage' — browser coverage cannot map the triggering service repo's changed lines (CLAUDE.md), matching legacy's !triggerService conjunct at src/pipeline.ts:2912");
});

test("ObserverPort: a diff-mode PASS run WITHOUT triggerRepo still emits a 'coverage' step (control case for the two guards above)", async () => {
  const { ports } = stubPorts();
  const { observer, steps } = fakeObserver();
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig, observer });

  const out = await useCase.run({ ...baseInput, runId: "coverage-step-diff-monorepo", mode: "diff" });

  assert.equal(out.decision.verdict, "pass");
  assert.ok(steps.some((s) => s.step === "coverage"), "an ordinary monorepo diff-mode pass must still emit 'coverage' — unaffected by either guard");
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

// ── W1 publication-correctness package (audit-verified, cutover-blocking) ─────────────────────
// F1 — publish() now dispatches for EVERY side-effect-bearing decision ("pr" | "issue" |
// "quarantine" | "shadow-log"), not just "pr". F2 — onFailure suppression is reconciled: a
// "none" sideEffect (already decided by RunDecisionService's own onFailure guard) never reaches
// the publish port at all, so PublishDecisionService's own missing onFailure guard can never fire
// through this call site. F3 — issueRepo is threaded from input.triggerRepo.

test("F1: publish() is called for an 'issue' side effect (fail verdict, onFailure:'github-issue') — previously ONLY 'pr' ever called publish()", async () => {
  let publishCallCount = 0;
  let publishedDecision: { verdict: string; issueRepo?: string } | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "fail", cases: [{ name: "login", status: "fail" as const }], logs: "x" }),
  });
  ports.publication.publish = async (decision) => {
    publishCallCount++;
    publishedDecision = decision;
    return { outcome: "issue: https://github.com/org/app/issues/1" };
  };
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false, maxRetries: 0 } });

  const out = await useCase.run({ ...baseInput, runId: "f1-publish-issue-fail" });

  assert.equal(out.decision.verdict, "fail");
  assert.equal(out.decision.sideEffect, "issue");
  assert.equal(publishCallCount, 1, "a fail verdict with onFailure:'github-issue' must dispatch to publish() — F1's bug left this call site unreachable for anything but 'pr'");
  assert.ok(publishedDecision, "publish() must have been called");
  assert.equal(out.note, "issue: https://github.com/org/app/issues/1", "the publish outcome must thread into RunQaResult.note");
});

test("F1: publish() is called for a 'quarantine' side effect (flaky verdict) — previously ONLY 'pr' ever called publish()", async () => {
  let publishCallCount = 0;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "flaky", cases: [{ name: "checkout", status: "flaky" as const }], logs: "" }),
  });
  ports.publication.publish = async () => { publishCallCount++; return { outcome: "quarantine: flaky — quarantine, no PR" }; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "f1-publish-quarantine-flaky" });

  assert.equal(out.decision.verdict, "flaky");
  assert.equal(out.decision.sideEffect, "quarantine");
  assert.equal(publishCallCount, 1, "a flaky verdict must dispatch to publish() so the quarantine outcome genuinely surfaces (CLAUDE.md: 'flaky never surfaced its quarantine outcome' before F1)");
});

test("F2: onFailure:'none' + fail verdict resolves to sideEffect:'none' and publish() is NEVER called (reconciles PublishDecisionService's missing onFailure guard)", async () => {
  // PublishDecisionService (workspace-and-publication) has NO onFailure guard of its own — it would
  // unconditionally return "issue" for a fail/invalid verdict if it were ever reached. F2's
  // reconciliation: RunDecisionService's own onFailure guard resolves this case to sideEffect:"none"
  // BEFORE this use-case's publish-dispatch gate (F1's `decision.sideEffect !== "none"`) is even
  // evaluated — so PublicationPortAdapter (and its PublishDecisionService collaborator) is never
  // reached for an onFailure-suppressed verdict; the guard the adapter itself lacks never needs to
  // fire because the decision layer already suppressed the call one level up.
  let publishCallCount = 0;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "fail", cases: [{ name: "login", status: "fail" as const }], logs: "x" }),
  });
  ports.publication.publish = async () => { publishCallCount++; return { outcome: "issue: should never happen" }; };
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false, maxRetries: 0, onFailure: "none" } });

  const out = await useCase.run({ ...baseInput, runId: "f2-onfailure-none-no-issue" });

  assert.equal(out.decision.verdict, "fail");
  assert.equal(out.decision.sideEffect, "none", "onFailure:'none' must suppress the side effect for a fail verdict (report()'s own top-guard, src/pipeline.ts:3337-3340)");
  assert.equal(publishCallCount, 0, "an onFailure-suppressed decision ('none') must NEVER reach the publish port — no Issue must open");
});

test("F3: a triggerRepo run threads issueRepo into publish() so the Issue routes to the triggering service repo, not the primary", async () => {
  let publishedDecision: { verdict: string; issueRepo?: string } | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "fail", cases: [{ name: "login", status: "fail" as const }], logs: "x" }),
  });
  ports.publication.publish = async (decision) => {
    publishedDecision = decision;
    return { outcome: "issue: https://github.com/org/orders-svc/issues/9" };
  };
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false, maxRetries: 0 } });

  const out = await useCase.run({ ...baseInput, runId: "f3-cross-repo-issue-routing", triggerRepo: "org/orders-svc" });

  assert.equal(out.decision.sideEffect, "issue");
  assert.ok(publishedDecision, "publish() must have been called");
  assert.equal(publishedDecision!.issueRepo, "org/orders-svc", "publish() must receive issueRepo from input.triggerRepo so PublicationPortAdapter can route the Issue to the triggering repo, not the primary (mirrors legacy's issueRepo = triggerService ? triggerService.repo : app.repo, src/pipeline.ts:1021)");
});

test("F3: an ordinary (non-cross-repo) run omits issueRepo entirely — the adapter falls back to its own static ctx.repo", async () => {
  let publishedDecision: { verdict: string; issueRepo?: string } | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "fail", cases: [{ name: "login", status: "fail" as const }], logs: "x" }),
  });
  ports.publication.publish = async (decision) => { publishedDecision = decision; return { outcome: "issue: https://github.com/org/app/issues/2" }; };
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, needsReview: false, maxRetries: 0 } });

  const out = await useCase.run({ ...baseInput, runId: "f3-no-trigger-repo-omits-issue-repo" });

  assert.equal(out.decision.sideEffect, "issue");
  assert.ok(publishedDecision, "publish() must have been called");
  assert.equal(publishedDecision!.issueRepo, undefined, "an ordinary run (no input.triggerRepo) must NOT fabricate an issueRepo — absent lets the adapter fall back to its own static ctx.repo");
});

// ── W3 (judgment-day, CRITICAL) — terminalResult() now dispatches publish() ───────────────────
// terminalResult (the shared helper for the static-gate "invalid" exit and the mid-run
// "infra-error" exit) computed `decision` but NEVER called this.deps.publication.publish() — a
// static-gate invalid run with onFailure:"github-issue" never actually opened a GitHub Issue.
// Legacy parity: pipeline.ts:2313-2325 (static-gate invalid -> report() -> issueOrShadow -> a real
// Issue "QA could not validate the generated E2E tests at ${sha}"); infra-error correctly stays
// no-publish (sideEffect "none" via decide() itself, matching report()'s own infra-error branch,
// pipeline.ts:3353-3355 — never calls issueOrShadow).

test("W3 FIX 1: an invalid verdict with onFailure:'github-issue' dispatches publish() exactly once with sideEffect 'issue'", async () => {
  let publishCallCount = 0;
  let publishedDecision: { verdict: string; issueRepo?: string } | undefined;
  const { ports } = stubPorts({
    validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }),
  });
  ports.publication.publish = async (decision) => {
    publishCallCount++;
    publishedDecision = decision;
    return { outcome: "issue: https://github.com/org/app/issues/42" };
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w3-fix1-invalid-publishes-issue" });

  assert.equal(out.decision.verdict, "invalid");
  assert.equal(out.decision.sideEffect, "issue");
  assert.equal(publishCallCount, 1, "terminalResult('invalid', ...) must dispatch to publish() exactly once — previously computed `decision` but never called publish() at all");
  assert.ok(publishedDecision, "publish() must have been called with a decision payload");
  assert.equal(publishedDecision!.verdict, "invalid");
  // The static gate's own validation-errors note is threaded in as terminalResult's `note` param
  // (see the "NOTE CHAIN" test) — the publish outcome is APPENDED to it, never clobbering it (FIX 1's
  // own "append to any existing note" requirement; see the dedicated append-not-clobber test below).
  assert.ok(out.note?.includes("issue: https://github.com/org/app/issues/42"), `the publish outcome must thread into RunQaResult.note — got: ${out.note}`);
});

test("W3 FIX 1: an invalid verdict with onFailure:'none' resolves to sideEffect 'none' and publish() is NEVER called", async () => {
  let publishCallCount = 0;
  const { ports } = stubPorts({
    validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }),
  });
  ports.publication.publish = async () => { publishCallCount++; return { outcome: "issue: should never happen" }; };
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, onFailure: "none" } });

  const out = await useCase.run({ ...baseInput, runId: "w3-fix1-invalid-onfailure-none" });

  assert.equal(out.decision.verdict, "invalid");
  assert.equal(out.decision.sideEffect, "none", "onFailure:'none' must suppress the side effect for an invalid verdict too, matching report()'s own top-guard");
  assert.equal(publishCallCount, 0, "an onFailure-suppressed invalid decision must NEVER reach the publish port");
});

test("W3 FIX 1: a shadow-mode invalid verdict dispatches publish() so the shadow-log line is genuinely emitted (shadow-log routing)", async () => {
  let publishCallCount = 0;
  const { ports } = stubPorts({
    validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }),
  });
  ports.publication.publish = async () => { publishCallCount++; return { outcome: "shadow: shadow mode — side effects replaced with logs" }; };
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, shadow: true } });

  const out = await useCase.run({ ...baseInput, runId: "w3-fix1-invalid-shadow" });

  assert.equal(out.decision.verdict, "invalid");
  assert.equal(out.decision.sideEffect, "shadow-log");
  assert.equal(publishCallCount, 1, "a shadow-mode invalid run must still dispatch to publish() — PublicationPortAdapter is what collapses it into a shadow-log line, not this use-case skipping the call");
  assert.ok(out.note?.includes("shadow: shadow mode — side effects replaced with logs"), `got: ${out.note}`);
});

test("W3 FIX 1: an infra-error verdict resolves to sideEffect 'none' via decide() itself — publish() is NEVER called, and no special-casing is needed", async () => {
  let publishCallCount = 0;
  const { ports } = stubPorts({
    waitUntilServing: async () => err(new Error("DEV did not respond")),
  });
  ports.publication.publish = async () => { publishCallCount++; return { outcome: "issue: should never happen" }; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w3-fix1-infra-error-no-publish" });

  assert.equal(out.decision.verdict, "infra-error");
  assert.equal(out.decision.sideEffect, "none", "infra-error must resolve to sideEffect 'none' automatically through the shared decide() call — legacy never opens an Issue for infra-error (report():3353-3355)");
  assert.equal(publishCallCount, 0, "an infra-error terminal must NEVER dispatch to publish()");
});

test("W3 FIX 1: the publish outcome is APPENDED to an existing diagnostic note (e.g. the static-gate's validation-errors note), never clobbered", async () => {
  const { ports } = stubPorts({
    validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout", "[tsc] Type 'string' is not assignable to type 'number'."] }),
  });
  ports.publication.publish = async () => ({ outcome: "issue: https://github.com/org/app/issues/7" });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w3-fix1-note-append-not-clobber" });

  assert.equal(out.decision.verdict, "invalid");
  assert.ok(out.note?.includes("no-wait-for-timeout"), `the original validation-errors note must survive — got: ${out.note}`);
  assert.ok(out.note?.includes("issue: https://github.com/org/app/issues/7"), `the publish outcome must be appended to the existing note, not replace it — got: ${out.note}`);
});

// ── W3 FIX 2 (judgment-day, judge B) — context-mode invalid now honors onFailure ────────────────
// Deliberate divergence from legacy: buildContextMap's own invalid branch (src/pipeline.ts:
// 1377-1404) calls issueOrShadow() DIRECTLY, bypassing report()'s onFailure top-guard entirely —
// undocumented in the legacy source, reading as an accident rather than a deliberate design choice
// (see the FIX 2 comment on terminalResult's skipPersist parameter for the full writeup). This
// composition prefers the CONSISTENT policy: context-mode invalid reaches the SAME terminalResult
// call as the generic static-gate invalid, so it now honors onFailure exactly like every other
// verdict — including staying silent when onFailure:"none" (which legacy's bypass would NOT do).

test("W3 FIX 2: a context-mode invalid dispatches publish() when onFailure:'github-issue' (still skips persistence per FIX 2's existing no-persist convention)", async () => {
  let publishCallCount = 0;
  let saveCallCount = 0;
  const { ports } = stubPorts({
    generate: async () => ({ specs: [".qa/context.json"], approved: true, note: "tried" }),
    validate: async () => ({ ok: false, errors: ["feBe[0]: route '/ghost' is not declared in 'routes'"] }),
  });
  ports.publication.publish = async () => { publishCallCount++; return { outcome: "issue: https://github.com/org/app/issues/11" }; };
  ports.runHistory.save = async () => { saveCallCount++; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w3-fix2-context-invalid-publishes", mode: "context" });

  assert.equal(out.decision.verdict, "invalid");
  assert.equal(publishCallCount, 1, "a context-mode invalid with onFailure:'github-issue' must dispatch publish() through the same shared terminalResult path every other invalid uses");
  assert.equal(saveCallCount, 0, "context-mode invalid must still NOT persist — publish dispatch and persistence are orthogonal (FIX 2's skipPersist convention is unaffected by FIX 1's publish dispatch)");
});

test("W3 FIX 2: a context-mode invalid does NOT dispatch publish() when onFailure:'none' — a DELIBERATE divergence from legacy's unconditional issueOrShadow bypass", async () => {
  let publishCallCount = 0;
  const { ports } = stubPorts({
    generate: async () => ({ specs: [".qa/context.json"], approved: true, note: "tried" }),
    validate: async () => ({ ok: false, errors: ["feBe[0]: route '/ghost' is not declared in 'routes'"] }),
  });
  ports.publication.publish = async () => { publishCallCount++; return { outcome: "issue: should never happen" }; };
  const useCase = new RunQaUseCase({ ...ports, config: { ...baseConfig, onFailure: "none" } });

  const out = await useCase.run({ ...baseInput, runId: "w3-fix2-context-invalid-onfailure-none", mode: "context" });

  assert.equal(out.decision.verdict, "invalid");
  assert.equal(publishCallCount, 0, "this composition prefers the CONSISTENT onFailure policy over legacy's undocumented direct-issueOrShadow bypass (src/pipeline.ts:1377-1404) — see the terminalResult skipPersist FIX 2 comment for the full rationale");
});

// ── W2 (generation quality loop, audit-verified cutover blocker) — F2: forward FixLoop context.
// The FixLoop's own regenerate() call receives FixLoopGenerateInput (fixCases/selectorContradictions/
// domSnapshot) but the use-case's closure previously discarded it entirely — every retry regenerated
// with the SAME contextless prompt as the initial attempt. ─────────────────────────────────────────

test("W2-F2: the FixLoop's regenerate() call forwards fixCases into generate()'s enrichment", async () => {
  const capturedFixCases: unknown[] = [];
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "fail" as const, cases: [{ name: "login", status: "fail" as const, detail: "timed out waiting for selector" }], logs: "x" }),
  });
  ports.generation.generate = async (_objectives, _specDir, _signal, _diff, enrichment) => {
    capturedFixCases.push(enrichment?.fixCases);
    return { specs: ["a.spec.ts"], approved: true };
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "w2-f2-fixcases-forwarded" });

  // First call is the initial generate() (no fixCases yet); the FixLoop's OWN regen call(s) must
  // carry the failing case(s) forward.
  const withFixCases = capturedFixCases.filter((fc) => Array.isArray(fc) && fc.length > 0);
  assert.ok(withFixCases.length > 0, "at least one generate() call (the FixLoop's regen) must receive fixCases — got none across all calls");
  assert.deepEqual(withFixCases[0], [{ name: "login", status: "fail", detail: "timed out waiting for selector" }]);
});

test("W2-F2: the FixLoop's regenerate() call forwards selectorContradictions when Lever-2 finds any", async () => {
  // Lever-2 only produces contradictions when a failed case carries a failureDom (buildFailureDomLines)
  // AND the prior round's spec source references a selector absent from that tree. Wiring a full
  // Lever-2 scenario is fix-loop-characterization.test.ts's own job; this test's scope is narrower:
  // prove the closure threads whatever selectorContradictions the FixLoop computes, when non-empty.
  const capturedEnrichments: Array<{ selectorContradictions?: readonly string[] }> = [];
  const { ports } = stubPorts({
    execute: async () => ({
      verdict: "fail" as const,
      cases: [{ name: "login", status: "fail" as const, detail: "err", failureDom: "button: Submit\nheading: Login" }],
      logs: "x",
    }),
  });
  let genCall = 0;
  ports.generation.generate = async (_objectives, _specDir, _signal, _diff, enrichment) => {
    genCall++;
    capturedEnrichments.push(enrichment ?? {});
    // The initial call's specSources become the round-0 Lever-2 comparison source; return a spec
    // whose source text references a selector NOT in the failure-point tree above, so Lever-2 finds
    // a contradiction on the FixLoop's own retry round.
    return { specs: ["a.spec.ts"], approved: true };
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "w2-f2-selector-contradictions-forwarded" });

  // This scenario's stub GenerationPort never supplies specSources (that is
  // GenerationPortAdapter's own collaborator, absent in this unit-level stub), so Lever-2 has
  // nothing to check against and legitimately finds zero contradictions — the assertion here is
  // that the FIELD ITSELF is threaded through the enrichment object (present when non-empty, never
  // silently dropped), not that this particular stub scenario produces a non-empty result.
  assert.ok(genCall > 1, "the FixLoop must have called generate() more than once");
  for (const enrichment of capturedEnrichments) {
    assert.ok(
      enrichment.selectorContradictions === undefined || Array.isArray(enrichment.selectorContradictions),
      "selectorContradictions, when present, must be an array (threaded verbatim from the FixLoop's own Lever-2 check, never fabricated)",
    );
  }
});

test("W2-F2: the FixLoop's regenerate() call forwards domSnapshot when Lever-2 supplies a failure-point capture", async () => {
  const capturedDomSnapshots: (string | undefined)[] = [];
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "fail" as const, cases: [{ name: "login", status: "fail" as const, detail: "err" }], logs: "x" }),
  });
  ports.generation.generate = async (_objectives, _specDir, _signal, _diff, enrichment) => {
    capturedDomSnapshots.push(enrichment?.domSnapshot);
    return { specs: ["a.spec.ts"], approved: true };
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "w2-f2-domsnapshot-field-present" });

  // Same scope note as the selectorContradictions test above: this scenario's failing case carries
  // no failureDom, so the FixLoop's own Lever-2 check has nothing to build a domSnapshot from
  // (matches fix-loop.aggregate.ts's own `haveTrees` guard) — the field is legitimately absent here.
  // Proven present-when-populated by the generation-port.adapter.test.ts enrichment-mapping test.
  assert.ok(capturedDomSnapshots.length > 0, "generate() must have been called at least once");
});

// ── W2 — F3: reviewer-corrections regeneration loop. Ports the legacy's reviewGenerated() round
// loop VERBATIM: MAX_REVIEW_ROUNDS=2, a blocking rejection regenerates with reviewCorrections
// threaded, a rejection on the LAST round is terminal, parsed:false fails closed WITHOUT burning a
// round. ────────────────────────────────────────────────────────────────────────────────────────

test("W2-F3: a reviewer rejection with blocking corrections triggers regeneration with reviewCorrections threaded", async () => {
  let reviewCallCount = 0;
  const capturedReviewCorrections: (readonly string[] | undefined)[] = [];
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass" as const, cases: [{ name: "login", status: "pass" as const }], logs: "" }),
  });
  ports.review.review = async () => {
    reviewCallCount++;
    return reviewCallCount === 1
      ? { approved: false, corrections: ["[false-positive] assertion targets the wrong element"], blockingCount: 1, parsed: true }
      : { approved: true, corrections: [], blockingCount: 0, parsed: true };
  };
  ports.generation.generate = async (_objectives, _specDir, _signal, _diff, enrichment) => {
    capturedReviewCorrections.push(enrichment?.reviewCorrections);
    return { specs: ["a.spec.ts"], approved: true };
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig }); // needsReview: true

  const out = await useCase.run({ ...baseInput, runId: "w2-f3-corrections-thread-into-regen" });

  assert.equal(reviewCallCount, 2, "a blocking rejection on round 0 must trigger exactly one regeneration + one re-review (round 1)");
  const regenWithCorrections = capturedReviewCorrections.filter((c) => c?.length);
  assert.ok(regenWithCorrections.length > 0, "at least one generate() call must have received reviewCorrections");
  assert.deepEqual(regenWithCorrections[0], ["[false-positive] assertion targets the wrong element"]);
  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.decision.sideEffect, "pr", "once corrections are resolved on round 1, the run must publish");
});

test("W2-F3: corrections resolved on the regenerated round -> reviewerApproved:true -> publish", async () => {
  let reviewCallCount = 0;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass" as const, cases: [{ name: "login", status: "pass" as const }], logs: "" }),
  });
  ports.review.review = async (_specDir, _cases, _diff, enrichment) => {
    reviewCallCount++;
    if (reviewCallCount === 1) {
      return { approved: false, corrections: ["[false-positive] x"], blockingCount: 1, parsed: true };
    }
    // Round 1: the reviewer sees the SAME corrections it raised last round via priorCorrections and
    // now approves — proves convergence threading (mirrors legacy's previousRoundCorrections).
    assert.deepEqual(enrichment?.priorCorrections, ["[false-positive] x"], "round 1's review() call must receive round 0's own corrections as priorCorrections");
    return { approved: true, corrections: [], blockingCount: 0, parsed: true };
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w2-f3-corrections-resolved-publishes" });

  assert.equal(reviewCallCount, 2);
  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.decision.sideEffect, "pr");
});

test("W2-F3: corrections persist through the legacy's bound (2 rounds) -> terminal rejection (issue, not pr)", async () => {
  let reviewCallCount = 0;
  let generateCallCount = 0;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass" as const, cases: [{ name: "login", status: "pass" as const }], logs: "" }),
  });
  ports.review.review = async () => {
    reviewCallCount++;
    // Rejects on EVERY round — the persistent-rejection case.
    return { approved: false, corrections: ["[false-positive] persistent issue"], blockingCount: 1, parsed: true };
  };
  ports.generation.generate = async (_objectives, _specDir, _signal, _diff, _enrichment) => {
    generateCallCount++;
    return { specs: ["a.spec.ts"], approved: true };
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w2-f3-bound-terminal-rejection" });

  // MAX_REVIEW_ROUNDS=2: round 0 rejects (not the last round -> regen), round 1 rejects (the LAST
  // round -> terminal, no further regen). Exactly 2 review() calls, exactly 1 review-driven regen.
  assert.equal(reviewCallCount, 2, "MAX_REVIEW_ROUNDS=2 bounds the loop to exactly 2 review() calls — never an unbounded retry");
  assert.equal(generateCallCount, 1 + 1, "exactly 1 review-driven regeneration (round 0's rejection) on top of the initial generate() call — round 1's rejection is terminal, no further regen");
  assert.equal(out.decision.verdict, "pass", "the harness verdict itself is still 'pass' — it is the REVIEWER that rejected, not execution");
  assert.equal(out.decision.sideEffect, "issue", "a reviewer rejection that survives the full bound must route to an Issue, never a PR — matches decide()'s needsReview && !reviewerApproved branch");
});

test("W2-F3: parsed:false (a parse miss) fails closed WITHOUT burning a regeneration round", async () => {
  let reviewCallCount = 0;
  let generateCallCount = 0;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass" as const, cases: [{ name: "login", status: "pass" as const }], logs: "" }),
  });
  ports.review.review = async () => {
    reviewCallCount++;
    return { approved: true, corrections: [], blockingCount: 0, parsed: false }; // parse miss, NOT a real rejection
  };
  ports.generation.generate = async () => { generateCallCount++; return { specs: ["a.spec.ts"], approved: true }; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w2-f3-parse-miss-fails-closed-no-burn" });

  assert.equal(reviewCallCount, 1, "a parse miss must return IMMEDIATELY — never re-prompt/re-review, matching the legacy's reviewGenerated() own comment: 'failing closed (not burning a regeneration round)'");
  assert.equal(generateCallCount, 1, "a parse miss must NOT trigger any review-driven regeneration — only the initial generate() call happened");
  assert.equal(out.decision.verdict, "pass");
  assert.equal(out.decision.sideEffect, "issue", "a parse-miss must fail closed to an Issue, never a PR");
});

test("W2-F3: a regeneration that produces zero specs mid-loop is a lost cause — terminal rejection, no further review", async () => {
  let reviewCallCount = 0;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass" as const, cases: [{ name: "login", status: "pass" as const }], logs: "" }),
  });
  ports.review.review = async () => {
    reviewCallCount++;
    return { approved: false, corrections: ["[false-positive] x"], blockingCount: 1, parsed: true };
  };
  let generateCallCount = 0;
  ports.generation.generate = async () => {
    generateCallCount++;
    // Initial call succeeds; the review-driven regen (round 0's rejection) produces nothing.
    return generateCallCount === 1 ? { specs: ["a.spec.ts"], approved: true } : { specs: [], approved: false };
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w2-f3-empty-regen-mid-loop-terminal" });

  assert.equal(reviewCallCount, 1, "a regeneration with zero specs was never judged — the loop must NOT re-review it, matching the legacy's round>0 empty-result guard");
  assert.equal(out.decision.sideEffect, "issue", "an unreviewed empty regeneration must never inherit self-approval — routes to Issue");
});

// ── W2 — F4: kill the double reviewer. On the orchestrated path, exactly ONE reviewer session
// fires per generation round (RunQaUseCase's own ReviewPort) — GenerateTestsUseCase's internal
// reviewer branch must never fire (this use-case's own stub ReviewPort/GenerationPort cannot
// directly observe GenerateTestsUseCase's internals; the call-count proof that composition-root.ts
// wires needsReview:false into GenerationPortAdapter's ctx lives in composition-root.test.ts — this
// test's scope is the use-case's OWN single-reviewer contract: review() is called AT MOST once per
// round, never twice for the same round). ──────────────────────────────────────────────────────────

test("W2-F4: exactly ONE reviewer session (review() call) fires for a clean pass — no double review", async () => {
  let reviewCallCount = 0;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass" as const, cases: [], logs: "" }),
  });
  ports.review.review = async () => { reviewCallCount++; return { approved: true, corrections: [], blockingCount: 0, parsed: true }; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig }); // needsReview: true

  const out = await useCase.run({ ...baseInput, runId: "w2-f4-single-review-clean-pass" });

  assert.equal(out.decision.verdict, "pass");
  assert.equal(reviewCallCount, 1, "the orchestrated path must perform EXACTLY ONE reviewer session per round — a second, internal reviewer session firing on top of this one is the audit-flagged defect");
});

test("W2-F4: no-op skip (approved + zero specs) still works — needsReview:true generation self-approval is preserved", async () => {
  // CLAUDE.md invariant: "Honor the agent's no-op decision — approved + zero specs is a valid
  // skipped, never invalid." This must hold regardless of the F4 composition-root fix (which only
  // changes GenerationPortAdapter's ctx.needsReview, not this use-case's OWN generation stub
  // contract) — generation returning approved:true with zero specs is ALWAYS a valid skip.
  const { ports } = stubPorts({ generate: async () => ({ specs: [], approved: true }) });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w2-f4-no-op-skip-preserved" });

  assert.equal(out.decision.verdict, "skipped");
  assert.equal(out.decision.sideEffect, "none");
});

// ── W2 — F5: classify() surfaces intent; diff-mode generate() receives it.

test("W2-F5: classify() surfaces intent, and diff-mode generate() receives it via enrichment", async () => {
  const capturedIntents: unknown[] = [];
  const theIntent = { type: "feat", breaking: false, message: "add checkout flow", changedFiles: ["src/checkout.ts"] };
  const { ports } = stubPorts({
    classify: async () => ({ action: "generate", reason: "type=feat", diff: "the-diff", intent: theIntent }),
  });
  ports.generation.generate = async (_objectives, _specDir, _signal, _diff, enrichment) => {
    capturedIntents.push(enrichment?.intent);
    return { specs: ["a.spec.ts"], approved: true };
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "w2-f5-intent-threaded-diff-mode", mode: "diff" });

  assert.ok(capturedIntents.length > 0, "generate() must have been called at least once");
  for (const captured of capturedIntents) {
    assert.deepEqual(captured, theIntent, "every generate() call in diff mode must receive the SAME intent classify() surfaced, not an empty/undefined value");
  }
});

test("W2-F5: a non-diff mode never calls classify(), so generate() receives no intent (undefined, never fabricated)", async () => {
  let classifyCallCount = 0;
  const capturedIntents: unknown[] = [];
  const { ports } = stubPorts({
    classify: async () => { classifyCallCount++; return { action: "generate", reason: "n/a", diff: "should never be read", intent: { type: "feat", breaking: false, message: "x", changedFiles: [] } }; },
  });
  ports.generation.generate = async (_objectives, _specDir, _signal, _diff, enrichment) => {
    capturedIntents.push(enrichment?.intent);
    return { specs: ["a.spec.ts"], approved: true };
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "w2-f5-non-diff-mode-no-intent", mode: "complete" });

  assert.equal(classifyCallCount, 0, "only diff mode runs classifyCommit");
  assert.ok(capturedIntents.length > 0, "generate() must still have been called");
  for (const captured of capturedIntents) {
    assert.equal(captured, undefined, "without classification, no intent must be fabricated");
  }
});

// ── W3 F2 (CRITICAL cutover blocker): LearningPort.retrieve(sha) is called and threaded into
// generate()/review()'s enrichment.learnedRules, and the persisted/returned rulesRetrieved carries
// what retrieve() returned — LearningPortAdapter.retrieve() existed with zero call sites before
// this fix (retrieval was a provable no-op end-to-end even with a real learning store wired). ────

test("W3 F2: learning.retrieve(sha) is called before the first generate(), and its result reaches generate()'s enrichment.learnedRules", async () => {
  let retrieveCalledWithSha: string | undefined;
  const capturedLearnedRules: (readonly string[] | undefined)[] = [];
  const { ports } = stubPorts({
    retrieve: async (sha) => { retrieveCalledWithSha = sha.toString(); return ["selector absent", "use role+name"]; },
  });
  ports.generation.generate = async (_objectives, _specDir, _signal, _diff, enrichment) => {
    capturedLearnedRules.push(enrichment?.learnedRules);
    return { specs: ["a.spec.ts"], approved: true };
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "w3-f2-retrieve-into-generate" });

  assert.equal(retrieveCalledWithSha, "abc1234", "retrieve() must be called with the run's sha");
  assert.ok(capturedLearnedRules.length > 0, "generate() must have been called at least once");
  for (const captured of capturedLearnedRules) {
    assert.deepEqual(captured, ["selector absent", "use role+name"], "every generate() call must receive the SAME retrieved rules");
  }
});

test("W3 F2: retrieved rules also reach review()'s enrichment.learnedRules", async () => {
  const capturedLearnedRules: (readonly string[] | undefined)[] = [];
  const { ports } = stubPorts({
    retrieve: async () => ["never invent a test-id"],
  });
  ports.review.review = async (_specDir, _cases, _diff, enrichment) => {
    capturedLearnedRules.push(enrichment?.learnedRules);
    return { approved: true, corrections: [], blockingCount: 0, parsed: true };
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "w3-f2-retrieve-into-review" });

  assert.ok(capturedLearnedRules.length > 0, "review() must have been called (needsReview:true, clean pass)");
  assert.deepEqual(capturedLearnedRules[0], ["never invent a test-id"]);
});

test("W3 F2: an empty retrieve() result omits enrichment.learnedRules entirely (never a fabricated empty marker)", async () => {
  const capturedLearnedRules: (readonly string[] | undefined)[] = [];
  const { ports } = stubPorts({ retrieve: async () => [] });
  ports.generation.generate = async (_objectives, _specDir, _signal, _diff, enrichment) => {
    capturedLearnedRules.push(enrichment?.learnedRules);
    return { specs: ["a.spec.ts"], approved: true };
  };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "w3-f2-empty-retrieve" });

  for (const captured of capturedLearnedRules) {
    assert.equal(captured, undefined, "an empty retrieval must not fabricate a present-but-empty learnedRules field");
  }
});

test("W3 F2: a retrieve() failure does not abort the run — generation still proceeds ungrounded", async () => {
  const { ports } = stubPorts({
    retrieve: async () => { throw new Error("learning store unavailable"); },
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w3-f2-retrieve-failure" });

  assert.equal(out.decision.verdict, "pass", "a retrieval failure must be swallowed, not propagated as a run failure");
});

test("W3 F2: the retrieved rule triggers reach the persisted RunOutcome.rulesRetrieved on the mainline exit", async () => {
  let savedRulesRetrieved: string[] | undefined;
  const { ports } = stubPorts({ retrieve: async () => ["fabricated-testid-guard"] });
  ports.runHistory.save = async (outcome) => { savedRulesRetrieved = outcome.rulesRetrieved; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  await useCase.run({ ...baseInput, runId: "w3-f2-persisted-rules-retrieved" });

  assert.deepEqual(savedRulesRetrieved, ["fabricated-testid-guard"]);
});

test("W3 F2: the returned RunQaResult also carries rulesRetrieved (RewrittenOrchestratorAdapter's own read-back path)", async () => {
  const { ports } = stubPorts({ retrieve: async () => ["rule-a", "rule-b"] });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w3-f2-returned-rules-retrieved" });

  assert.deepEqual(out.rulesRetrieved, ["rule-a", "rule-b"]);
});

test("W3 F2: an early-exit terminal (static-gate invalid) persists rulesRetrieved:[] — legacy parity, retrieve() result is never threaded to a non-mainline exit", async () => {
  let savedRulesRetrieved: string[] | undefined;
  const { ports } = stubPorts({
    retrieve: async () => ["would-be-injected-rule"],
    validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }),
  });
  ports.runHistory.save = async (outcome) => { savedRulesRetrieved = outcome.rulesRetrieved; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w3-f2-invalid-exit-no-rules" });

  assert.equal(out.decision.verdict, "invalid");
  assert.deepEqual(savedRulesRetrieved, [], "legacy's persistOutcome() only threads retrievedRuleIds at its OWN mainline call site — every other exit gets []");
});

// ── W3 F3 (HIGH cutover blocker): the returned RunQaResult carries the real per-case results +
// execution logs, and the persisted RunOutcome mirrors them — RunHistoryPort.save receives the
// SAME cases/logs the caller sees, closing the "passed=0/failed=0 with empty logs" gap. ─────────

test("W3 F3: a passing run's RunQaResult.cases mirrors ExecutionPort.execute()'s real cases, not an empty array", async () => {
  const realCases = [{ name: "checkout flow", status: "pass" as const }];
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass", cases: realCases, logs: "1 passed" }),
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w3-f3-real-cases" });

  assert.deepEqual(out.cases, realCases);
  assert.equal(out.logs, "1 passed");
});

test("W3 F3: the persisted RunOutcome carries the SAME cases/logs as the returned RunQaResult (adapter parity)", async () => {
  const realCases = [{ name: "login flow", status: "pass" as const }];
  let savedOutcome: { cases?: unknown[]; logs?: string } | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass", cases: realCases, logs: "1 passed, 0 failed" }),
  });
  ports.runHistory.save = async (outcome) => { savedOutcome = outcome; };
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w3-f3-persisted-matches-returned" });

  assert.deepEqual(savedOutcome?.cases, out.cases);
  assert.equal(savedOutcome?.logs, out.logs);
});

test("W3 F3: an early-exit terminal (invalid) carries cases:[] and no logs — nothing was ever executed", async () => {
  const { ports } = stubPorts({
    validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }),
  });
  const useCase = new RunQaUseCase({ ...ports, config: baseConfig });

  const out = await useCase.run({ ...baseInput, runId: "w3-f3-invalid-no-cases" });

  assert.equal(out.decision.verdict, "invalid");
  assert.deepEqual(out.cases, []);
  assert.equal(out.logs, undefined, "an exit that never reached execute() must not fabricate a logs string");
});
