import { test } from "node:test";
import assert from "node:assert/strict";
import { FixLoop, type FixLoopExecutionPort, type FixLoopGenerationPort } from "@contexts/qa-run-orchestration/domain/fix-loop.aggregate.ts";
import { CycleBudget } from "@contexts/qa-run-orchestration/domain/cycle-budget.ts";
import { WallClockBudget } from "@contexts/qa-run-orchestration/domain/wall-clock-budget.ts";

// CHARACTERIZATION: drives the FixLoop through the fail-issue golden's EXACT stub semantics
// (test/characterization/goldens/fail-issue.json, sourced from makeDeps in scenarios.ts) and
// asserts it reproduces the golden's retries:1 + final verdict=fail.
//
// SCOPE NOTE (honest, read before extending this file): the plan's Task D.4 text names BOTH
// fail-issue (retries:1) and invalid-issue (retries:2) as the characterization targets. Verified
// against the real legacy at HEAD: invalid-issue.json's retries:2 is produced ENTIRELY by the
// STATIC-GATE repair loop (src/pipeline.ts:2258-2265, MAX_STATIC_FIX_ROUNDS, errorClass:"E-STATIC",
// verdict:"invalid") — a DIFFERENT loop from the fix-loop this aggregate ports (src/pipeline.ts
// :2527-2886, the execute-fail-retry loop, retries++ at :2723 only). `retries` is a SINGLE counter
// shared across FOUR distinct regen sites in the legacy (:1776 reviewer-rejection regen, :2265
// static-gate repair, :2449 code-mode compile-gate repair, :2723 THIS aggregate's fix-loop) — an
// `invalid` verdict is decided by the static gate BEFORE execution ever runs, so the fix-loop's
// `for` header (`run.verdict === "fail"`) never even evaluates for that scenario; this aggregate
// cannot reproduce a retry count produced by a loop it does not contain. Registered in the
// bug-register as a plan-fidelity gap (the plan's wording implies both goldens exercise THIS
// aggregate, which is not what the legacy source shows). This file characterizes ONLY fail-issue
// (the one golden whose retries genuinely flow through the ported loop) plus a SEPARATE synthetic
// scenario proving the aggregate's OWN retries counter reaches 2 under maxRetries=2 with a
// progress-preserving stub — demonstrating the loop's upper bound independent of the invalid-issue
// golden's unrelated static-gate mechanism.

test("CHARACTERIZATION: fail-issue golden — FixLoop reproduces retries:1, verdict=fail (test/characterization/goldens/fail-issue.json)", async () => {
  // Mirrors makeDeps({ run: { sha:"s", verdict:"fail", passed:false, cases:[{name:"login",
  // status:"fail"}], logs:"x" } }) from scenarios.ts exactly: execute() ALWAYS returns the SAME fail
  // result (no state change across retries — no .detail, no .failureDom, no .file on the case), and
  // generate() ALWAYS returns the same {specs:["a.spec.ts"], approved:true} on every regen call
  // (scenarioApp never overrides opts.agent for this scenario). scenarioApp.qa.fixLoop is unset ->
  // MAX_RETRIES defaults to 2 (src/pipeline.ts:2527).
  const FAIL_RUN = { verdict: "fail" as const, cases: [{ name: "login", status: "fail" as const }] };

  let executeCallCount = 0;
  const execution: FixLoopExecutionPort = {
    execute: async () => {
      executeCallCount++;
      return FAIL_RUN; // the stub returns the identical fail result every call, verbatim
    },
  };
  let generateCallCount = 0;
  const generation: FixLoopGenerationPort = {
    generate: async () => {
      generateCallCount++;
      return { specs: ["a.spec.ts"], approved: true }; // mirrors scenarios.ts's `generated` fixture
    },
  };
  const cycleBudget = CycleBudget.derive({ maxRetries: 2 });
  const wallClockBudget = WallClockBudget.derive({ cycleBudget, agentTimeoutMs: 60_000 });
  const loop = new FixLoop({
    execution,
    generation,
    // No specSources/failureTrees supplied — mirrors the golden's case having no failureDom (empty
    // trees, empty findings) and the scenario supplying no e2e spec-file reads.
    selectorCheck: { check: () => ({ contradictions: [], absentKeys: new Set(), anyVerifiedPresent: false, anyNonExtractable: false, anyUnverifiable: false }) },
  });

  const result = await loop.run({
    initialRun: FAIL_RUN,
    isCode: false,
    generating: true,
    mode: "diff",
    objectiveSource: ["src/x.ts"], // scenarioApp's fixture diff touches src/x.ts
    maxRetries: 2, // app.qa.fixLoop?.maxRetries ?? 2 — unset in scenarioApp, defaults to 2
    cycleBudget,
    wallClockBudget,
    devHealthy: async () => true, // makeDeps default opts.healthy ?? true
    namespace: "golden-fail-issue",
    coverageWillMeasure: false, // no change-coverage wiring in this scenario
  });

  // The golden: gateSignals.retries === 1, verdict === "fail".
  assert.equal(result.retries, 1, "must reproduce fail-issue.json's gateSignals.retries:1 exactly");
  assert.equal(result.run.verdict, "fail", "must reproduce fail-issue.json's verdict:fail exactly");
  assert.equal(generateCallCount, 1, "exactly ONE regen call — round 2's fail-closed progress gate stops before a second regen");
  assert.equal(executeCallCount, 1, "exactly ONE retry-execute call — round 2 never re-executes (loop breaks on break-needs-human first)");
  assert.equal(result.lastAdjudicatorVerdict?.action, "break-needs-human", "round 2 stops via the fail-closed progress gate (Rule 5), matching the legacy's own asymmetric-stop behavior");
});

test("CHARACTERIZATION: FixLoop's OWN retries counter reaches 2 under maxRetries=2 with a progress-preserving stub (upper-bound proof, independent of invalid-issue's unrelated static-gate loop)", async () => {
  // A stub where EACH round shows measurable progress (Signal A: failing count strictly decreases),
  // so decideProgress spends on every round up to the maxRetries cap — proving the aggregate's own
  // loop can reach retries:2 (the SAME cap invalid-issue.json's static-gate loop independently hits
  // via MAX_STATIC_FIX_ROUNDS, a different mechanism entirely).
  let executeCallCount = 0;
  const execution: FixLoopExecutionPort = {
    execute: async () => {
      executeCallCount++;
      if (executeCallCount === 1) {
        return {
          verdict: "fail" as const,
          cases: [{ name: "checkout-retry-1", status: "fail" as const, file: "checkout.spec.ts", detail: "getByRole resolved to 0 elements" }],
        };
      }
      // Round 2's retry-execute: a DIFFERENT failing name than round 1's retry-execute output, so
      // Signal B (failing name set changed) holds on round 2's evaluation too — proving the CAP is
      // reached (maxRetries=2 exhausts the for header) rather than an early fail-closed break.
      return {
        verdict: "fail" as const,
        cases: [{ name: "checkout-retry-2", status: "fail" as const, file: "checkout.spec.ts", detail: "getByRole resolved to 0 elements" }],
      };
    },
  };
  let generateCallCount = 0;
  const generation: FixLoopGenerationPort = {
    generate: async () => {
      generateCallCount++;
      return { specs: ["checkout.spec.ts"], approved: true };
    },
  };
  const cycleBudget = CycleBudget.derive({ maxRetries: 2 });
  const wallClockBudget = WallClockBudget.derive({ cycleBudget, agentTimeoutMs: 60_000 });
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
    namespace: "golden-progress",
    coverageWillMeasure: true, // never-filter, keeps merge logic out of this test's scope
  });

  assert.equal(result.retries, 2, "reaches the maxRetries=2 cap when progress signal B holds every round");
  assert.equal(generateCallCount, 2);
  assert.equal(executeCallCount, 2);
  assert.equal(result.run.verdict, "fail");
});

// ── FIX F3 (confirmed, structural) ────────────────────────────────────────────────────────────────
// Legacy re-derives BOTH failureTrees (from the CURRENT run.cases[].failureDom, src/pipeline.ts
// :2580-2582) and specSources (fresh from the CURRENT round's regen result.specs, :2590-2596) INSIDE
// the loop, every iteration. Before the fix, the aggregate read both from static FixLoopInput fields
// set ONCE before the loop starts — loop-invariant, so on retry >=2 the Lever-2 selector check ran
// against STALE round-1 data even though the run's failing cases (and their failureDom) had changed.
//
// This test drives a 2-round loop where round 1's and round 2's failing cases carry DIFFERENT
// failureDom trees, and the selectorCheck stub records exactly which trees it was called with each
// round. The fix must make round 2's Lever-2 check see round 2's FRESH failureDom — not round 1's.
test("FIX F3: failureTrees are re-derived per-round from the CURRENT run's failing cases (fresh, not loop-invariant), matching src/pipeline.ts:2580-2582", async () => {
  let executeCallCount = 0;
  const receivedTreesPerCall: string[][][] = [];
  const execution: FixLoopExecutionPort = {
    execute: async () => {
      executeCallCount++;
      // Round 1's retry-execute returns a failing case whose failureDom differs from the initial run's
      // — round 2's Lever-2 check must see THIS tree, not the initial run's.
      return {
        verdict: "fail" as const,
        cases: [
          {
            name: "checkout",
            status: "fail" as const,
            file: "checkout.spec.ts",
            detail: "getByRole resolved to 0 elements",
            failureDom: "round-2-tree: button Submit",
          },
        ],
      };
    },
  };
  const generation: FixLoopGenerationPort = {
    generate: async () => ({ specs: ["checkout.spec.ts"], approved: true }),
  };
  const cycleBudget = CycleBudget.derive({ maxRetries: 2 });
  const wallClockBudget = WallClockBudget.derive({ cycleBudget, agentTimeoutMs: 60_000 });
  const loop = new FixLoop({
    execution,
    generation,
    selectorCheck: {
      check: (specSources, trees) => {
        receivedTreesPerCall.push(trees);
        return { contradictions: [], absentKeys: new Set(), anyVerifiedPresent: false, anyNonExtractable: false, anyUnverifiable: false };
      },
    },
  });

  await loop.run({
    initialRun: {
      verdict: "fail",
      cases: [
        {
          name: "checkout",
          status: "fail",
          file: "checkout.spec.ts",
          detail: "getByRole resolved to 0 elements",
          failureDom: "round-1-tree: button Cancel",
        },
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
    namespace: "golden-f3-trees",
    coverageWillMeasure: true,
  });

  assert.equal(executeCallCount, 1, "round 1 regenerates+re-executes once; round 2's fail-closed gate (unchanging failing name) stops before a second regen");
  assert.equal(receivedTreesPerCall.length, 2, "the selector check runs once per loop iteration (round 1 and round 2's gate evaluation)");
  // Round 1's check must see the INITIAL run's failureDom tree.
  assert.deepEqual(receivedTreesPerCall[0], [["round-1-tree: button Cancel"]], "round 1's Lever-2 check must read the initial run's failureDom, not a stale/empty tree");
  // Round 2's check must see the RETRY run's (fresh) failureDom tree — NOT round 1's stale tree, and
  // NOT an empty tree (which is what a loop-invariant static field would produce after retry-execute
  // returned a case with a NEW failureDom the static field never captured).
  assert.deepEqual(receivedTreesPerCall[1], [["round-2-tree: button Submit"]], "round 2's Lever-2 check must read the CURRENT (retry) run's failureDom — a loop-invariant static field would still show round 1's tree or an empty one here");
});
