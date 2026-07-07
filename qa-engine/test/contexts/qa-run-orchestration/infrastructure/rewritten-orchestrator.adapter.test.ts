// test/contexts/qa-run-orchestration/infrastructure/rewritten-orchestrator.adapter.test.ts
// RED-first parity test (Plan 6, Task D.6): drives RewrittenOrchestratorAdapter — RunPipelinePort
// over the REWRITTEN domain (RunQaUseCase) — with the SAME stubbed ports as run-qa.use-case.test.ts
// (Task D.5), so this pin is genuinely comparable to the legacy adapter's own scenario tests
// (legacy-pipeline.adapter.test.ts) and to the D.5 10-scenario parity. A gutted impl returning a
// literal FAILS this test — the adapter must forward through RunQaUseCase and map its RunQaResult
// to a RunOutcome (the SAME shape RunHistoryPort.save persists).

import { test } from "node:test";
import assert from "node:assert/strict";
import { RewrittenOrchestratorAdapter } from "@contexts/qa-run-orchestration/infrastructure/rewritten-orchestrator.adapter.ts";
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
} from "@contexts/qa-run-orchestration/application/ports/index.ts";
import { ok } from "@kernel/result.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";

// ── Fully-stubbed port set — IDENTICAL shape to run-qa.use-case.test.ts's stubPorts() (Task D.5),
// so the adapter's own scenario tests are apples-to-apples with the use-case's own 10-scenario
// parity: same green-pr fixture semantics (scenarioApp needsReview:true, makeDeps({}) — generate()
// approved:true with 1 spec, execute() a clean pass, no coverage config, not shadow, onFailure
// "github-issue"). ──────────────────────────────────────────────────────────────────────────────

function stubPorts(overrides: Partial<{
  classify: ChangeAnalysisPort["classify"];
  generate: GenerationPort["generate"];
  review: ReviewPort["review"];
  validate: ValidationPort["validate"];
  execute: ExecutionPort["execute"];
  measure: ObjectiveSignalPort["measure"];
  blocks: ObjectiveSignalPort["blocks"];
  publish: PublicationPort["publish"];
  fold: LearningPort["fold"];
  retrieve: LearningPort["retrieve"];
  prepare: WorkspacePort["prepare"];
  waitUntilServing: DeployGatePort["waitUntilServing"];
  save: RunHistoryPort["save"];
}> = {}) {
  const savedOutcomes: RunOutcome[] = [];
  const foldedOutcomes: RunOutcome[] = [];

  const changeAnalysis: ChangeAnalysisPort = {
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
    // Default mirrors this suite's own baseline scenario (no coverage config -> never blocks).
    blocks: overrides.blocks ?? (() => false),
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

  return {
    ports: { changeAnalysis, generation, review, validation, execution, objectiveSignal, publication, learning, workspace, deployGate, runHistory },
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

const baseConfig = { needsReview: true, shadow: false, onFailure: "github-issue", maxRetries: 2, isCode: false };

test("RewrittenOrchestratorAdapter: green-pr — fully stubbed ports, returns RunOutcome verdict pass", async () => {
  const { ports } = stubPorts();
  const adapter = new RewrittenOrchestratorAdapter({ ...ports, config: baseConfig });

  const outcome = await adapter.run(baseInput);

  assert.equal(outcome.verdict, "pass");
});

// ── The 10-scenario equivalence (mirrors Task A.4 for the rewritten adapter, and Task D.5's own
// 10-scenario parity for RunQaUseCase) — drives ALL 10 scenarios.ts goldens through
// RewrittenOrchestratorAdapter.run(), asserting the resulting RunOutcome.verdict equals the golden.
// The adapter's OWN job is proving the RunInput -> RunQaUseCase -> RunOutcome MAPPING is faithful —
// not re-deriving decide()'s policy (already proven by run-decision-parity.test.ts) or the use-case's
// own wiring (already proven by run-qa.use-case.test.ts). ─────────────────────────────────────────

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
}

const tenScenarios: TenScenarioCase[] = [
  {
    // scenarioApp (needsReview:true), makeDeps({}) — generated (approved:true), passing(). Source:
    // scenarios.ts:226-234.
    scenario: "green-pr",
    overrides: {},
    config: baseConfig,
    input: {},
    expectedVerdict: "pass",
  },
  {
    // scenarioApp, makeDeps({ run: fail }) — a failing case, no fix-loop recovery (execute always
    // returns the SAME fail result). Source: scenarios.ts:236-246.
    scenario: "fail-issue",
    overrides: {
      execute: async () => ({ verdict: "fail", cases: [{ name: "login", status: "fail" }], logs: "x" }),
      generate: async () => ({ specs: ["a.spec.ts"], approved: true }),
    },
    config: baseConfig,
    input: {},
    expectedVerdict: "fail",
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
  },
  {
    // codeApp (needsReview:true), makeDeps({ isCodeMode: true }) — code mode reuses the SAME
    // pass-path chain. Source: scenarios.ts:292-300.
    scenario: "code-mode",
    overrides: {},
    config: { ...baseConfig, isCode: true },
    input: { target: "code" },
    expectedVerdict: "pass",
  },
  {
    // crossApp (needsReview:false, shadow:false explicit), makeDeps({ isCrossRepo: true }). Source:
    // scenarios.ts:302-322.
    scenario: "cross-repo",
    overrides: {},
    config: { ...baseConfig, needsReview: false },
    input: {},
    expectedVerdict: "pass",
  },
  {
    // shadowApp (needsReview:true, shadow:true), makeDeps({}). Source: scenarios.ts:324-332.
    scenario: "shadow",
    overrides: {},
    config: { ...baseConfig, shadow: true },
    input: {},
    expectedVerdict: "pass",
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
  },
];

test("RewrittenOrchestratorAdapter 10-scenario equivalence: the golden set is non-trivial (guards against an accidentally-empty pin)", () => {
  assert.equal(tenScenarios.length, 10, "expected exactly the 10 scenarios.ts goldens");
});

for (const c of tenScenarios) {
  test(`RewrittenOrchestratorAdapter 10-scenario equivalence — ${c.scenario}: RunOutcome.verdict matches the golden`, async () => {
    const { ports } = stubPorts(c.overrides);
    const adapter = new RewrittenOrchestratorAdapter({ ...ports, config: c.config });

    const outcome = await adapter.run({ ...baseInput, runId: `golden-${c.scenario}`, ...c.input });

    assert.equal(outcome.verdict, c.expectedVerdict, `${c.scenario}: verdict mismatch`);
    assert.equal(outcome.runId, `golden-${c.scenario}`, `${c.scenario}: runId must be forwarded, not a stub literal`);
    assert.equal(outcome.app, baseInput.app, `${c.scenario}: app must be forwarded, not a stub literal`);
  });
}

// ── Genuine-mapping proofs — not a gutted literal. The RunOutcome the adapter returns must be the
// SAME shape RunHistoryPort.save persists (per Task D.6's own contract), so these assert the
// adapter's returned RunOutcome carries real fields the use-case's toRunOutcome() derives, not a
// hand-rolled re-derivation with a different shape. ────────────────────────────────────────────

test("RewrittenOrchestratorAdapter: returns the SAME RunOutcome shape RunHistoryPort.save receives (fail-issue — retries + coverageRatio forwarded)", async () => {
  let savedOutcome: RunOutcome | undefined;
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass", cases: [], logs: "" }),
    measure: async () => ({ status: "pass", ratio: 0.92 }),
  });
  ports.runHistory.save = async (outcome) => { savedOutcome = outcome; };
  const adapter = new RewrittenOrchestratorAdapter({ ...ports, config: { ...baseConfig, needsReview: false } });

  const outcome = await adapter.run({ ...baseInput, runId: "golden-mapping-proof" });

  assert.ok(savedOutcome, "the use-case must have called runHistory.save()");
  assert.deepEqual(outcome, savedOutcome, "the adapter's returned RunOutcome must equal the SAME outcome persisted via RunHistoryPort.save");
  assert.equal(outcome.gateSignals.coverageRatio, 0.92, "coverageRatio must be threaded through, not dropped");
});

test("RewrittenOrchestratorAdapter — invalid: still returns a well-formed RunOutcome even though decide/persist happened on a terminal early-exit", async () => {
  const { ports } = stubPorts({ validate: async () => ({ ok: false, errors: ["[lint] no-wait-for-timeout"] }) });
  const adapter = new RewrittenOrchestratorAdapter({ ...ports, config: baseConfig });

  const outcome = await adapter.run({ ...baseInput, runId: "golden-invalid-mapping" });

  assert.equal(outcome.verdict, "invalid");
  assert.equal(outcome.mode, "diff");
  assert.equal(outcome.target, "e2e");
  assert.deepEqual(outcome.rulesRetrieved, [], "rulesRetrieved must be a well-formed array, not undefined");
});

test("RewrittenOrchestratorAdapter — infra-error (entry gate): DeployGatePort failure surfaces as a RunOutcome, not a thrown error", async () => {
  const { ports } = stubPorts({ waitUntilServing: async () => ({ ok: false, error: new Error("DEV unhealthy") }) });
  const adapter = new RewrittenOrchestratorAdapter({ ...ports, config: baseConfig });

  const outcome = await adapter.run({ ...baseInput, runId: "golden-infra-error-entry-gate" });

  assert.equal(outcome.verdict, "infra-error");
  assert.equal(outcome.runId, "golden-infra-error-entry-gate", "even the entry-gate infra-error path must forward runId, not a stub literal");
});

// ── Judgment-day D.7 FIX 1/3/4: toOutcome() must mirror the SAME errorClass/valueScore/
// reviewerApproved the use-case already derived and persisted — not re-hardcode them to null a
// second time at this adapter boundary (RunHistoryPort has no read-back path, so this adapter's own
// toOutcome() is the ONLY place these fields can be surfaced to the RunPipelinePort caller). ──────

test("FIX 1 (adapter): reviewerApproved is forwarded into the returned RunOutcome, not hardcoded away", async () => {
  const { ports } = stubPorts({
    review: async () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true }),
  });
  const adapter = new RewrittenOrchestratorAdapter({ ...ports, config: baseConfig }); // needsReview: true

  const outcome = await adapter.run({ ...baseInput, runId: "fix-1-adapter-reviewer-approved" });

  assert.equal(outcome.gateSignals.reviewerApproved, true, "reviewerApproved must be forwarded from the use-case's RunQaResult into the adapter's RunOutcome");
});

test("FIX 3 (adapter): valueScore is forwarded into the returned RunOutcome, not hardcoded null", async () => {
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "pass", cases: [], logs: "" }),
    measure: async () => ({ status: "pass", ratio: 0.92, valueScore: 0.85 }),
  });
  const adapter = new RewrittenOrchestratorAdapter({ ...ports, config: { ...baseConfig, needsReview: false } });

  const outcome = await adapter.run({ ...baseInput, runId: "fix-3-adapter-value-score" });

  assert.equal(outcome.gateSignals.valueScore, 0.85, "valueScore must be forwarded from the use-case's RunQaResult into the adapter's RunOutcome, matching the value-oracle result");
});

test("FIX 4 (adapter): errorClass is forwarded into the returned RunOutcome, not hardcoded null", async () => {
  const { ports } = stubPorts({
    execute: async () => ({ verdict: "fail", cases: [{ name: "login", status: "fail" }], logs: "x" }),
    generate: async () => ({ specs: ["a.spec.ts"], approved: true }),
  });
  const adapter = new RewrittenOrchestratorAdapter({ ...ports, config: baseConfig });

  const outcome = await adapter.run({ ...baseInput, runId: "fix-4-adapter-error-class" });

  assert.equal(outcome.verdict, "fail");
  assert.equal(outcome.errorClass, "E-EXEC-FAIL", "errorClass must be forwarded from the use-case's RunQaResult into the adapter's RunOutcome");
});

// ── CLAUDE.md invariant note-chain (a live infra-error once surfaced with NO note/log/cases —
// undiagnosable without instrumenting a live container): RunQaResult.note must reach RunOutcome.note
// through this adapter's toOutcome() mapping — previously dropped entirely, silently breaking the
// note chain between RunQaUseCase and src/server/runner.ts's runViaRewrittenEngine (which reads
// outcome.note off exactly the RunOutcome this adapter returns). ──────────────────────────────────

test("NOTE CHAIN (adapter): RunQaResult.note is forwarded into the returned RunOutcome.note", async () => {
  const { ports } = stubPorts({ waitUntilServing: async () => ({ ok: false, error: new Error("DEV did not serve sha abc1234 within 5000ms") }) });
  const adapter = new RewrittenOrchestratorAdapter({ ...ports, config: baseConfig });

  const outcome = await adapter.run({ ...baseInput, runId: "note-chain-adapter-mapping" });

  assert.equal(outcome.verdict, "infra-error");
  assert.ok(
    outcome.note?.includes("DEV did not serve sha abc1234"),
    `the entry deploy-gate's InfraError message must survive RunQaResult -> RunOutcome mapping — got: ${outcome.note}`,
  );
});

test("NOTE CHAIN (adapter): a clean pass carries the real publish() outcome, never a fabricated diagnostic", async () => {
  // F1 fix (audit, CRITICAL): a "pass"/"pr" decision now genuinely calls PublicationPort.publish()
  // (previously the ONLY side effect that ever did), and its real return value threads into
  // RunQaResult.note -> RunOutcome.note (see run-qa.use-case.ts's own FIX F1 comment). The stub here
  // (stubPorts' default `publish: async () => ({ outcome: "pr" })`) makes this note genuinely
  // reflect what publish() returned — not a fabricated value — so a clean pass's note is now
  // "pr" (the publish outcome string), not absent.
  const { ports } = stubPorts();
  const adapter = new RewrittenOrchestratorAdapter({ ...ports, config: baseConfig });

  const outcome = await adapter.run({ ...baseInput, runId: "note-chain-adapter-no-note" });

  assert.equal(outcome.verdict, "pass");
  assert.equal(outcome.note, "pr", "a clean pass's note must reflect the REAL publish() outcome string (F1), not be silently dropped");
});
