import { test } from "node:test";
import assert from "node:assert/strict";
import { toSignalsView } from "./signals-view";
import type { Scorecard } from "../qa/learning/oracle-types";
import type { RunRecord, RunOutcome } from "../types";

function run(verdict: RunRecord["verdict"]): RunRecord {
  return {
    id: "r", app: "a", sha: "s", target: "e2e", mode: "diff",
    status: "done", verdict, cases: [], logs: [], at: "2026-01-01T00:00:00Z",
  };
}

function scorecard(totalRuns: number, measuredRuns: number, avg: number | null): Scorecard {
  return {
    app: "a", updatedAt: "2026-01-01T00:00:00Z", entries: [],
    summary: { totalRuns, measuredRuns, avgValueScore: avg, lastValueScore: avg },
  };
}

test("toSignalsView reads 'not measured' when no scorecard has measured runs", () => {
  const view = toSignalsView([
    { scorecard: null, runs: [run("pass"), run("fail"), run("skipped"), run("infra-error"), run(undefined)] },
  ]);
  assert.equal(view.valueOracle.measured, false);
  assert.equal(view.valueOracle.avgScore, null);
  assert.equal(view.coverage.measured, false);
  // Proxy pass-rate counts only quality verdicts: pass + fail (skipped/infra-error/in-flight excluded).
  assert.equal(view.reviewer.runs, 2);
  assert.equal(view.reviewer.passRate, 0.5);
});

test("toSignalsView never reports 0.00 as ground truth when no real score was contributed", () => {
  // A partial/degenerate state: runs were measured but no avgValueScore emerged. avgScore
  // must stay null (→ the panel reads "not measured"), not surface a hard 0.00 as truth.
  const view = toSignalsView([{ scorecard: scorecard(5, 3, null), runs: [] }]);
  assert.equal(view.valueOracle.measured, true); // measured runs DID happen
  assert.equal(view.valueOracle.avgScore, null); // …but no honest number to show
});

test("toSignalsView weights the fleet value-oracle by measured runs", () => {
  const view = toSignalsView([
    { scorecard: scorecard(10, 4, 0.5), runs: [run("pass")] },
    { scorecard: scorecard(10, 6, 1.0), runs: [run("pass"), run("fail")] },
  ]);
  // (0.5·4 + 1.0·6) / 10 = 0.8
  assert.equal(view.valueOracle.measured, true);
  assert.equal(view.valueOracle.avgScore, 0.8);
  assert.equal(view.valueOracle.measuredRuns, 10);
  assert.equal(view.valueOracle.totalRuns, 20);
  assert.equal(view.reviewer.runs, 3);
  assert.equal(view.reviewer.passRate, 0.6667); // 2/3 rounded to 4 dp, matching avgScore/avgRatio
});

test("toSignalsView aggregates change-coverage across the fleet (null when unmeasured)", () => {
  const outcome = (coverageRatio: number | null): RunOutcome => ({
    runId: "r", app: "a", sha: "s", mode: "diff", target: "e2e", verdict: "pass",
    errorClass: null,
    gateSignals: { static: true, coverageRatio, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
    rulesRetrieved: [], at: "2026-01-01T00:00:00Z",
  });
  const view = toSignalsView([
    { scorecard: null, runs: [], outcomes: [outcome(0.8), outcome(0.6), outcome(null)] },
  ]);
  assert.equal(view.coverage.measured, true);
  assert.equal(view.coverage.measuredRuns, 2);
  assert.equal(view.coverage.totalRuns, 3);
  assert.equal(view.coverage.avgRatio, 0.7); // (0.8 + 0.6) / 2, null run ignored
});
