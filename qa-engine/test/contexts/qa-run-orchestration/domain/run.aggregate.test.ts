import { test } from "node:test";
import assert from "node:assert/strict";
import { Run, RunId } from "@contexts/qa-run-orchestration/domain/run.aggregate.ts";
import { Sha } from "@kernel/sha.ts";

// The Run aggregate (design §5.3(1)): identity = RunId+Sha+App; a GUARDED lifecycle
// (gate→analyze→generate→review→validate→execute→coverage→decide) so a phase cannot be skipped
// and a finalized run cannot transition further; per-instance reviewer-outage counter that fixes
// R2 (the legacy module-level `let consecutiveReviewerFailures` at src/pipeline.ts:84, which leaks
// across ALL queue entries — a cross-run global inside a per-run function).

function newRun(): Run {
  return Run.start({ runId: RunId.of("run-1"), sha: Sha.of("abc1234"), app: "portfolio" });
}

// --- Identity ---

test("Run identity: RunId+Sha+App, readable after construction", () => {
  const run = newRun();
  assert.equal(run.runId.toString(), "run-1");
  assert.equal(run.sha.toString(), "abc1234");
  assert.equal(run.app, "portfolio");
});

// --- Guarded lifecycle: cannot skip a phase ---

test("Run lifecycle: starts in the gate phase", () => {
  const run = newRun();
  assert.equal(run.phase, "gate");
});

test("Run lifecycle: gate -> analyze -> generate -> review -> validate -> execute -> coverage -> decide, in order", () => {
  let run = newRun();
  run = run.advanceTo("analyze");
  assert.equal(run.phase, "analyze");
  run = run.advanceTo("generate");
  assert.equal(run.phase, "generate");
  run = run.advanceTo("review");
  assert.equal(run.phase, "review");
  run = run.advanceTo("validate");
  assert.equal(run.phase, "validate");
  run = run.advanceTo("execute");
  assert.equal(run.phase, "execute");
  run = run.advanceTo("coverage");
  assert.equal(run.phase, "coverage");
  run = run.advanceTo("decide");
  assert.equal(run.phase, "decide");
});

test("Run lifecycle: advanceTo throws when skipping a phase (gate -> execute is illegal)", () => {
  const run = newRun();
  assert.throws(
    () => run.advanceTo("execute"),
    /cannot advance from "gate" to "execute"/,
  );
});

test("Run lifecycle: advanceTo throws when moving BACKWARD (generate -> gate is illegal)", () => {
  const run = newRun().advanceTo("analyze").advanceTo("generate");
  assert.throws(
    () => run.advanceTo("gate"),
    /cannot advance from "generate" to "gate"/,
  );
});

// --- Guarded lifecycle: cannot finalize twice ---

test("Run lifecycle: finalize() from decide moves to a terminal state", () => {
  let run = newRun();
  for (const phase of ["analyze", "generate", "review", "validate", "execute", "coverage", "decide"] as const) {
    run = run.advanceTo(phase);
  }
  const finalized = run.finalize("pass");
  assert.equal(finalized.phase, "finalized");
  assert.equal(finalized.verdict, "pass");
});

test("Run lifecycle: finalize() throws when the run is not yet at decide", () => {
  const run = newRun().advanceTo("analyze");
  assert.throws(() => run.finalize("pass"), /cannot finalize from phase "analyze" — must be at "decide"/);
});

test("Run lifecycle: finalize() throws when called TWICE (an already-finalized run cannot transition again)", () => {
  let run = newRun();
  for (const phase of ["analyze", "generate", "review", "validate", "execute", "coverage", "decide"] as const) {
    run = run.advanceTo(phase);
  }
  const finalized = run.finalize("pass");
  assert.throws(() => finalized.finalize("fail"), /already finalized/);
});

test("Run lifecycle: advanceTo throws once the run is finalized (no further transitions of any kind)", () => {
  let run = newRun();
  for (const phase of ["analyze", "generate", "review", "validate", "execute", "coverage", "decide"] as const) {
    run = run.advanceTo(phase);
  }
  const finalized = run.finalize("skipped");
  assert.throws(() => finalized.advanceTo("gate"), /already finalized/);
});

// --- Per-run reviewer-outage counter (fixes R2) ---

test("Run.recordReviewerFailure: increments a PER-INSTANCE counter (does not exist at construction = 0)", () => {
  const run = newRun();
  assert.equal(run.reviewerFailureCount, 0);
  assert.equal(run.reviewerOutage(), false);
});

test("Run.recordReviewerFailure: reviewerOutage() is false below the 3-strike threshold (mirrors src/pipeline.ts:1696 `>= 3`)", () => {
  let run = newRun();
  run = run.recordReviewerFailure();
  assert.equal(run.reviewerFailureCount, 1);
  assert.equal(run.reviewerOutage(), false);
  run = run.recordReviewerFailure();
  assert.equal(run.reviewerFailureCount, 2);
  assert.equal(run.reviewerOutage(), false);
});

test("Run.recordReviewerFailure: reviewerOutage() becomes true at exactly 3 consecutive failures", () => {
  let run = newRun();
  run = run.recordReviewerFailure().recordReviewerFailure().recordReviewerFailure();
  assert.equal(run.reviewerFailureCount, 3);
  assert.equal(run.reviewerOutage(), true);
});

test("Run.resetReviewerFailures: resets the counter to 0 (mirrors the `consecutiveReviewerFailures = 0` reset on reviewer success)", () => {
  let run = newRun();
  run = run.recordReviewerFailure().recordReviewerFailure().recordReviewerFailure();
  assert.equal(run.reviewerOutage(), true);
  run = run.resetReviewerFailures();
  assert.equal(run.reviewerFailureCount, 0);
  assert.equal(run.reviewerOutage(), false);
});

test("Run.recordReviewerFailure: is PER-INSTANCE — two Run instances do NOT share the counter (pins R2)", () => {
  // This is the exact fix for the legacy bug: `let consecutiveReviewerFailures` at src/pipeline.ts:84
  // is a MODULE-LEVEL global shared across every queue entry. Two Run aggregates for two DIFFERENT
  // queue entries must never see each other's reviewer-failure count.
  const runA = newRun();
  const runB = Run.start({ runId: RunId.of("run-2"), sha: Sha.of("def5678"), app: "petclinic" });

  const failedA = runA.recordReviewerFailure().recordReviewerFailure().recordReviewerFailure();
  assert.equal(failedA.reviewerFailureCount, 3);
  assert.equal(failedA.reviewerOutage(), true);

  // runB, constructed independently, must be completely unaffected by runA's failures.
  assert.equal(runB.reviewerFailureCount, 0);
  assert.equal(runB.reviewerOutage(), false);
});

test("Run.recordReviewerFailure: returns a NEW instance (immutable VO-style aggregate, does not mutate the original)", () => {
  const run = newRun();
  const failed = run.recordReviewerFailure();
  assert.equal(run.reviewerFailureCount, 0, "the original instance must be untouched");
  assert.equal(failed.reviewerFailureCount, 1);
});
