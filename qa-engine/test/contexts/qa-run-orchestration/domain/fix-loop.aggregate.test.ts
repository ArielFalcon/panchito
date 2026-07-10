import { test } from "node:test";
import assert from "node:assert/strict";
import { FixLoop, type FixLoopExecutionPort, type FixLoopGenerationPort } from "@contexts/qa-run-orchestration/domain/fix-loop.aggregate.ts";
import { CycleBudget } from "@contexts/qa-run-orchestration/domain/cycle-budget.ts";
import { WallClockBudget } from "@contexts/qa-run-orchestration/domain/wall-clock-budget.ts";
import type { QaCase } from "@kernel/qa-case.ts";

// FixLoop aggregate (Task D.4 — THE HARDEST + RISKIEST port). Drives the fix-loop VERBATIM from
// pipeline.ts ~2527-2880 (the real anchors — the plan's cited ~2416-2760 was stale). Injected stub
// ExecutionPort/GenerationPort/SelectorCheck (this file); sub-decisions tested in isolation.
// Characterization against the fail-issue/invalid-issue goldens lives in a separate file.

function makeCase(overrides: Partial<QaCase> = {}): QaCase {
  return { name: "login", status: "fail", detail: "getByRole resolved to 0 elements", ...overrides };
}

function budgets(): { cycleBudget: CycleBudget; wallClockBudget: WallClockBudget } {
  const cycleBudget = CycleBudget.derive({ maxRetries: 2 });
  const wallClockBudget = WallClockBudget.derive({ cycleBudget, agentTimeoutMs: 60_000 });
  return { cycleBudget, wallClockBudget };
}

// A stub GenerationPort that always regenerates one spec with no selector-contradiction feedback.
function regenAlwaysSucceeds(): FixLoopGenerationPort {
  return {
    generate: async () => ({ specs: ["checkout.spec.ts"], approved: true }),
  };
}

test("sub-decision (a): break-issue with runner_infra evidence -> infra-error, no regen call", async () => {
  let regenCalled = false;
  const execution: FixLoopExecutionPort = {
    execute: async () => {
      throw new Error("execute must not be called — the loop should break BEFORE any retry-execute");
    },
  };
  const generation: FixLoopGenerationPort = {
    generate: async () => {
      regenCalled = true;
      return { specs: [], approved: true };
    },
  };
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({ execution, generation, selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: false, anyNonExtractable: false, anyUnverifiable: false }) } });

  const result = await loop.run({
    initialRun: { verdict: "fail", cases: [makeCase({ detail: "browserType.launch: Executable doesn't exist" })] },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 2,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-abc",
  });

  assert.equal(result.run.verdict, "infra-error");
  assert.equal(result.realBugDetected, false);
  assert.equal(regenCalled, false, "runner_infra breaks BEFORE any regeneration call");
});

test("sub-decision (b): break-issue with app_defect (real-bug) evidence -> realBugDetected=true, verdict stays fail", async () => {
  const execution: FixLoopExecutionPort = {
    execute: async () => {
      throw new Error("execute must not be called — the loop should break on the FIRST evaluation");
    },
  };
  const generation = regenAlwaysSucceeds();
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({
    execution,
    generation,
    selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: true, anyNonExtractable: false, anyUnverifiable: false }) },
  });

  const result = await loop.run({
    initialRun: {
      verdict: "fail",
      cases: [makeCase({ detail: "expect(locator).toHaveText(expected) failed\nExpected: 'Paid'\nReceived: 'Pending'" })],
    },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 2,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-abc",
  });

  assert.equal(result.run.verdict, "fail");
  assert.equal(result.realBugDetected, true);
});

test("sub-decision: loop condition — maxRetries=0 disables the fix-loop entirely (no regen, no re-execute)", async () => {
  let regenCalled = false;
  const execution: FixLoopExecutionPort = {
    execute: async () => {
      throw new Error("execute must not be called when maxRetries=0");
    },
  };
  const generation: FixLoopGenerationPort = {
    generate: async () => {
      regenCalled = true;
      return { specs: [], approved: true };
    },
  };
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({ execution, generation, selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: false, anyNonExtractable: false, anyUnverifiable: false }) } });

  const result = await loop.run({
    initialRun: { verdict: "fail", cases: [makeCase()] },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 0,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-abc",
  });

  assert.equal(result.run.verdict, "fail");
  assert.equal(regenCalled, false);
  assert.equal(result.retries, 0);
});

test("sub-decision: loop condition — verdict!=='fail' skips the loop entirely (already pass)", async () => {
  const execution: FixLoopExecutionPort = { execute: async () => { throw new Error("must not execute"); } };
  const generation: FixLoopGenerationPort = { generate: async () => { throw new Error("must not regen"); } };
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({ execution, generation, selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: false, anyNonExtractable: false, anyUnverifiable: false }) } });

  const result = await loop.run({
    initialRun: { verdict: "pass", cases: [{ name: "login", status: "pass" }] },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: [],
    maxRetries: 2,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-abc",
  });

  assert.equal(result.run.verdict, "pass");
  assert.equal(result.retries, 0);
});

test("sub-decision: loop condition — generating=false skips the loop entirely (regression-only run)", async () => {
  const execution: FixLoopExecutionPort = { execute: async () => { throw new Error("must not execute"); } };
  const generation: FixLoopGenerationPort = { generate: async () => { throw new Error("must not regen"); } };
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({ execution, generation, selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: false, anyNonExtractable: false, anyUnverifiable: false }) } });

  const result = await loop.run({
    initialRun: { verdict: "fail", cases: [makeCase()] },
    isCode: false,
    generating: false,
    mode: "diff",
    objectiveSource: [],
    maxRetries: 2,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-abc",
  });

  assert.equal(result.run.verdict, "fail");
  assert.equal(result.retries, 0);
});

test("sub-decision (c): Lever-2 absentKeys short-circuit — regenerates WITHOUT re-executing, loops again", async () => {
  let executeCallCount = 0;
  let generateCallCount = 0;
  const execution: FixLoopExecutionPort = {
    execute: async () => {
      executeCallCount++;
      // Second round: selector now present → allUnique path is irrelevant here; return a clean pass
      // so the loop terminates cleanly on round 2's execute (if it ever gets called).
      return { verdict: "pass", cases: [{ name: "login", status: "pass" }] };
    },
  };
  const generation: FixLoopGenerationPort = {
    generate: async () => {
      generateCallCount++;
      return { specs: ["login.spec.ts"], approved: true };
    },
  };
  // Round 1: selector absent (absentKeys.size > 0) -> gate spends (prev===null, always allowed) ->
  // regen -> short-circuit (skip re-execute) -> loop again. Round 2: the run is UNCHANGED (never
  // re-executed), so curRound is IDENTICAL to round 1's prevRound (same failingCount, same
  // failingNames, same absentSelectors -> lever2Flips=0) -> decideProgress correctly fail-closes
  // (no measurable progress) -> adjudicate's Rule 5 (break-needs-human) fires, NOT another regen.
  // This is the CORRECT ported behavior (fail-closed progress gate), not a bug: an agent that never
  // changes the failure set only gets ONE regen before the loop stops for human review.
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({
    execution,
    generation,
    selectorCheck: {
      check: () => ({
        contradictions: ['button:"Submit" is NOT in the captured failure-point tree. Present roles: (none)'],
        absentKeys: new Set(["role|button|Submit|0|0"]),
        anyVerifiedPresent: false,
        anyNonExtractable: false,
        anyUnverifiable: false,
      }),
    },
  });

  const result = await loop.run({
    initialRun: { verdict: "fail", cases: [makeCase({ detail: "getByRole resolved to 0 elements" })] },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 2,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-abc",
  });

  assert.equal(executeCallCount, 0, "absentKeys.size>0 must short-circuit re-execute on EVERY round it fires");
  assert.equal(generateCallCount, 1, "round 1 regenerates once, then the fail-closed gate stops round 2 (break-needs-human)");
  assert.equal(result.retries, 1);
  assert.equal(result.run.verdict, "fail", "run is unchanged (never re-executed)");
  assert.equal(result.lastAdjudicatorVerdict?.action, "break-needs-human");
});

test("sub-decision (d): filtered-retry — canFilter true (coverageWillMeasure=false, regen stayed in failed set)", async () => {
  const receivedExecuteInputs: Array<{ namespace: string; specFiles?: string[] }> = [];
  const execution: FixLoopExecutionPort = {
    execute: async (i) => {
      receivedExecuteInputs.push(i);
      return { verdict: "pass", cases: [{ name: "login", status: "pass", file: "login.spec.ts" }] };
    },
  };
  const generation: FixLoopGenerationPort = {
    generate: async () => ({ specs: ["login.spec.ts"], approved: true }),
  };
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({
    execution,
    generation,
    selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: true, anyNonExtractable: false, anyUnverifiable: false }) },
  });

  await loop.run({
    initialRun: { verdict: "fail", cases: [makeCase({ file: "login.spec.ts" })] },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 1,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-abc",
    coverageWillMeasure: false,
  });

  assert.equal(receivedExecuteInputs.length, 1);
  assert.deepEqual(receivedExecuteInputs[0]!.specFiles, ["login.spec.ts"]);
});

test("sub-decision (d): filtered-retry — canFilter false when coverageWillMeasure=true (never filter, keystone guard)", async () => {
  const receivedExecuteInputs: Array<{ namespace: string; specFiles?: string[] }> = [];
  const execution: FixLoopExecutionPort = {
    execute: async (i) => {
      receivedExecuteInputs.push(i);
      return { verdict: "pass", cases: [{ name: "login", status: "pass", file: "login.spec.ts" }] };
    },
  };
  const generation: FixLoopGenerationPort = {
    generate: async () => ({ specs: ["login.spec.ts"], approved: true }),
  };
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({
    execution,
    generation,
    selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: true, anyNonExtractable: false, anyUnverifiable: false }) },
  });

  await loop.run({
    initialRun: { verdict: "fail", cases: [makeCase({ file: "login.spec.ts" })] },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 1,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-abc",
    coverageWillMeasure: true,
  });

  assert.equal(receivedExecuteInputs.length, 1);
  assert.equal(receivedExecuteInputs[0]!.specFiles, undefined, "coverageWillMeasure=true must NEVER filter");
});

test("sub-decision (e): bestRunSoFar regression guard — a worse terminal retry is discarded for an earlier better run", async () => {
  let executeCallCount = 0;
  const execution: FixLoopExecutionPort = {
    execute: async () => {
      executeCallCount++;
      if (executeCallCount === 1) {
        // Round 1: improves from 2 failures to 1 failure.
        return {
          verdict: "fail",
          cases: [
            { name: "login", status: "pass", file: "login.spec.ts" },
            { name: "checkout", status: "fail", file: "checkout.spec.ts", detail: "getByRole resolved to 0 elements" },
          ],
        };
      }
      // Round 2: REGRESSES back to 2 failures (worse than round 1's 1 failure).
      return {
        verdict: "fail",
        cases: [
          { name: "login", status: "fail", file: "login.spec.ts", detail: "getByRole resolved to 0 elements" },
          { name: "checkout", status: "fail", file: "checkout.spec.ts", detail: "getByRole resolved to 0 elements" },
        ],
      };
    },
  };
  const generation: FixLoopGenerationPort = {
    generate: async () => ({ specs: ["login.spec.ts", "checkout.spec.ts"], approved: true }),
  };
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({
    execution,
    generation,
    selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: false, anyNonExtractable: false, anyUnverifiable: false }) },
  });

  const result = await loop.run({
    initialRun: {
      verdict: "fail",
      cases: [
        { name: "login", status: "fail", file: "login.spec.ts", detail: "getByRole resolved to 0 elements" },
        { name: "checkout", status: "fail", file: "checkout.spec.ts", detail: "getByRole resolved to 0 elements" },
      ],
    },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 2,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-abc",
    coverageWillMeasure: true, // never-filter, keeps the merge logic out of this test's scope
  });

  // Round 1 (1 failure) is strictly better than round 2 (2 failures, a regression) — the guard must
  // restore round 1's run, not ship round 2's worse terminal retry.
  assert.equal(result.run.cases.filter((c) => c.status === "fail").length, 1);
  assert.equal(
    result.run.cases.find((c) => c.name === "checkout")?.status,
    "fail",
    "round 1's still-failing checkout case must be the one that survives",
  );
});

test("sub-decision (e): bestRunSoFar guard is SKIPPED when realBugDetected fired (the current fail run must reach the Issue)", async () => {
  let executeCallCount = 0;
  const execution: FixLoopExecutionPort = {
    execute: async () => {
      executeCallCount++;
      // Round 1 improves to a SINGLE value-mismatch failure with a unique selector.
      return {
        verdict: "fail",
        cases: [{ name: "checkout", status: "fail", file: "checkout.spec.ts", detail: "expect(locator).toHaveText(expected) failed\nExpected: 'Paid'\nReceived: 'Pending'" }],
      };
    },
  };
  const generation: FixLoopGenerationPort = {
    generate: async () => ({ specs: ["checkout.spec.ts"], approved: true }),
  };
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({
    execution,
    generation,
    selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: true, anyNonExtractable: false, anyUnverifiable: false }) },
  });

  const result = await loop.run({
    initialRun: {
      verdict: "fail",
      cases: [
        { name: "login", status: "fail", file: "login.spec.ts", detail: "getByRole resolved to 0 elements" },
        { name: "checkout", status: "fail", file: "checkout.spec.ts", detail: "getByRole resolved to 0 elements" },
      ],
    },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 2,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-abc",
    coverageWillMeasure: true,
  });

  assert.equal(result.realBugDetected, true);
  // The round-1 retry (1 failure) reduced failures vs the initial (2), so bestRunSoFar tracks it —
  // but the real-bug branch fires on round 2's evaluation and must NOT be overridden by the guard.
  assert.equal(result.run.cases.filter((c) => c.status === "fail").length, 1);
  assert.equal(result.run.cases[0]!.detail?.includes("Expected: 'Paid'"), true);
});

// ── FIX F1 (judgment-day, HIGH — both judges) ─────────────────────────────────────────────────────
// The ported decideProgress (helpers/progress-gate.ts:182) downgrades a Signal-B "progress" verdict
// to spend:false when the CURRENT round's reexploreNavigations >= REEXPLORE_FLAIL_THRESHOLD (3). The
// legacy (src/pipeline.ts:2626) sets curRound.reexploreNavigations from the PRIOR round's regen
// result (result?.reexploreNavigations ?? 0) — the round-N-1 agent's nav count is read at round N's
// gate. Before the fix, the aggregate never populated this field (FixLoopGenerateResult didn't carry
// it), so the thrash-stop was permanently unreachable and the loop always spent an extra retry the
// legacy would have declined.
test("FIX F1: reexploreNavigations thrash-stop — a heavy re-exploration round downgrades Signal B to no-progress (break-needs-human), matching src/pipeline.ts:2626+progress-gate.ts:182", async () => {
  let executeCallCount = 0;
  let generateCallCount = 0;
  const execution: FixLoopExecutionPort = {
    execute: async () => {
      executeCallCount++;
      // Round 1's retry-execute: a DIFFERENT failing name each call so Signal B (failing name set
      // changed) would normally hold every round — EXCEPT the round-1 regen reports a thrashing
      // reexploreNavigations count, which must downgrade round 2's gate evaluation to no-progress.
      return {
        verdict: "fail" as const,
        cases: [{ name: `checkout-retry-${executeCallCount}`, status: "fail" as const, file: "checkout.spec.ts", detail: "getByRole resolved to 0 elements" }],
      };
    },
  };
  const generation: FixLoopGenerationPort = {
    generate: async () => {
      generateCallCount++;
      // Every regen reports heavy re-exploration (>= REEXPLORE_FLAIL_THRESHOLD=3) — mirrors an agent
      // that re-navigated instead of fixing from the injected failure-point tree.
      return { specs: ["checkout.spec.ts"], approved: true, reexploreNavigations: 5 };
    },
  };
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({
    execution,
    generation,
    selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: false, anyNonExtractable: false, anyUnverifiable: false }) },
  });

  const result = await loop.run({
    initialRun: { verdict: "fail", cases: [{ name: "checkout", status: "fail", file: "checkout.spec.ts", detail: "getByRole resolved to 0 elements" }] },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 2,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-f1",
    coverageWillMeasure: true, // never-filter, keeps merge logic out of this test's scope
  });

  // Round 1: prev===null -> always allowed -> regen (reexploreNavigations:5) -> execute (round 2's
  // curRound.reexploreNavigations must read THIS 5, per the legacy's :2626 ordering). Round 2:
  // failing name changed (Signal B would normally hold) but reexploreNavigations>=3 downgrades it to
  // no-progress -> adjudicate's break-needs-human fires -> loop stops WITHOUT a second regen.
  assert.equal(generateCallCount, 1, "the thrash-stop must prevent a second regen call once round 2's gate reads the prior round's reexploreNavigations>=3");
  assert.equal(executeCallCount, 1, "only round 1's retry-execute runs; round 2 never re-executes because the loop breaks on the gate evaluation first");
  assert.equal(result.retries, 1);
  assert.equal(result.lastAdjudicatorVerdict?.action, "break-needs-human", "the fail-closed gate (fed by reexploreNavigations from the prior round) must route to break-needs-human, not another regen");
});

// ── FIX F2 (confirmed) ─────────────────────────────────────────────────────────────────────────────
// Legacy resultOf (src/pipeline.ts:3279-3281) returns cases:[] unconditionally for EVERY verdict,
// including the mid-retry infra-error at :2836-2838. Before the fix, the aggregate's mid-retry
// infra-error assignment (fix-loop.aggregate.ts, sub-decision 7) kept retryRun.cases — a discarded-run
// verdict (infra-error) must carry zero cases, matching every OTHER infra-error assignment site in
// the same aggregate (e.g. sub-decision 4's break-issue routing, which already correctly sets
// cases: run.cases per its own ported resultOf call).
test("FIX F2: mid-retry infra-error (DEV dies after a filtered retry-execute) discards cases, matching legacy resultOf's cases:[] contract", async () => {
  let executeCallCount = 0;
  let devHealthyCallCount = 0;
  const execution: FixLoopExecutionPort = {
    execute: async () => {
      executeCallCount++;
      // The retry-execute itself still fails (DEV died mid-run).
      return {
        verdict: "fail" as const,
        cases: [{ name: "checkout", status: "fail" as const, file: "checkout.spec.ts", detail: "net::ERR_CONNECTION_REFUSED" }],
      };
    },
  };
  const generation: FixLoopGenerationPort = {
    generate: async () => ({ specs: ["checkout.spec.ts"], approved: true }),
  };
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({
    execution,
    generation,
    selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: false, anyNonExtractable: false, anyUnverifiable: false }) },
    // devHealthy on FixLoopInput is the FIRST check (adjudicator evidence, always healthy here); the
    // SECOND, independent devHealthy() call happens right after the retry-execute returns fail — this
    // one reports DEV down, forcing the mid-retry infra-error assignment.
  });

  const result = await loop.run({
    initialRun: { verdict: "fail", cases: [{ name: "checkout", status: "fail", file: "checkout.spec.ts", detail: "getByRole resolved to 0 elements" }] },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 2,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => {
      devHealthyCallCount++;
      // 1st call: the adjudicator evidence snapshot (must be healthy so the loop proceeds to regen).
      // 2nd call: the pre-retry-execute guard (must be healthy so retry-execute actually runs).
      // 3rd call: the POST-retry-execute check (:2836 in the legacy) — DEV is now down.
      return devHealthyCallCount < 3;
    },
    namespace: "qa-bot-f2",
    coverageWillMeasure: true,
  });

  assert.equal(executeCallCount, 1, "the retry-execute must have run before the mid-retry infra-error fires");
  assert.equal(result.run.verdict, "infra-error");
  assert.deepEqual(result.run.cases, [], "legacy resultOf() ALWAYS returns cases:[] — a discarded infra-error run must carry zero cases, matching every other infra-error assignment in this aggregate");
});

// ── FIX F4 (contract) ─────────────────────────────────────────────────────────────────────────────
// Before the fix, cycleBudget/wallClockBudget were REQUIRED FixLoopInput fields never read anywhere
// in run() — the header claimed they "guard every regen entry", which was false (dead parameters).
// The legacy's budget check (MAX_CYCLES/cycleCount, wallClockBudget) lives entirely INSIDE
// generateOnce (src/pipeline.ts:1558-1578), which generateAndReview wraps — i.e. the GENERATION
// concern, not the fix-loop block (:2527-2886) itself. The faithful port threads the immutable VOs
// into the FixLoopGenerationPort.generate() call so a composed generation adapter (D.5's composition
// root) can enforce the SAME check at the SAME call boundary the legacy does, rather than the
// fix-loop re-implementing budget logic it structurally does not own.
test("FIX F4: the regen call threads cycleBudget/wallClockBudget to the GenerationPort, matching WHERE the legacy checks (inside generateOnce, not the fix-loop block)", async () => {
  const receivedGenerateInputs: Array<{ cycleBudget?: CycleBudget; wallClockBudget?: WallClockBudget }> = [];
  const execution: FixLoopExecutionPort = {
    execute: async () => ({ verdict: "pass" as const, cases: [{ name: "checkout", status: "pass" as const }] }),
  };
  const generation: FixLoopGenerationPort = {
    generate: async (input) => {
      receivedGenerateInputs.push(input);
      return { specs: ["checkout.spec.ts"], approved: true };
    },
  };
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({
    execution,
    generation,
    selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: false, anyNonExtractable: false, anyUnverifiable: false }) },
  });

  await loop.run({
    initialRun: { verdict: "fail", cases: [makeCase()] },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 1,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-f4",
  });

  assert.equal(receivedGenerateInputs.length, 1);
  assert.strictEqual(receivedGenerateInputs[0]!.cycleBudget, cycleBudget, "the SAME immutable CycleBudget instance passed into FixLoopInput must reach the generation port call — the port's caller (D.5's composed adapter) is where the legacy's cycleCount/MAX_CYCLES check lives (generateOnce, src/pipeline.ts:1573)");
  assert.strictEqual(receivedGenerateInputs[0]!.wallClockBudget, wallClockBudget, "the SAME immutable WallClockBudget instance must reach the generation port call — matching generateOnce's wall-clock guard at src/pipeline.ts:1564");
});

// ── sdd/migration-remediation Slice 4 (D-P1a, publication rendering + tested metadata) ───────────
// FixLoopResult.lastSpecMetas surfaces the LAST regen round's own specMetas — the caller
// (RunQaUseCase) prefers this over the pre-loop generation's own specMetas once the loop has
// engaged, since the loop's own final regen is the freshest "what was tested" evidence.

test("Slice 4: lastSpecMetas reflects the FINAL regen round's own specMetas once the loop fixes the run and exits", async () => {
  const execution: FixLoopExecutionPort = {
    execute: async () => ({ verdict: "pass" as const, cases: [{ name: "checkout", status: "pass" as const }] }),
  };
  const generation: FixLoopGenerationPort = {
    generate: async () => ({
      specs: ["checkout.spec.ts"],
      approved: true,
      specMetas: [{ flow: "Checkout", objective: "user can pay with a saved card" }],
    }),
  };
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({
    execution,
    generation,
    selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: true, anyNonExtractable: false, anyUnverifiable: false }) },
  });

  const result = await loop.run({
    initialRun: { verdict: "fail", cases: [makeCase()] },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 1,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-specmetas",
  });

  assert.equal(result.run.verdict, "pass");
  assert.deepEqual(result.lastSpecMetas, [{ flow: "Checkout", objective: "user can pay with a saved card" }]);
});

test("Slice 4: lastSpecMetas is undefined when the loop never regenerated (already passing on entry)", async () => {
  const execution: FixLoopExecutionPort = {
    execute: async () => {
      throw new Error("execute must not be called — the loop condition is false from the start (verdict already pass)");
    },
  };
  const generation: FixLoopGenerationPort = {
    generate: async () => {
      throw new Error("generate must not be called — the loop never engages");
    },
  };
  const { cycleBudget, wallClockBudget } = budgets();
  const loop = new FixLoop({
    execution,
    generation,
    selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: false, anyNonExtractable: false, anyUnverifiable: false }) },
  });

  const result = await loop.run({
    initialRun: { verdict: "pass", cases: [{ name: "checkout", status: "pass" }] },
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/checkout.ts"],
    maxRetries: 2,
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true,
    namespace: "qa-bot-specmetas-noop",
  });

  assert.equal(result.lastSpecMetas, undefined);
});
