import { test } from "node:test";
import assert from "node:assert/strict";
import { toSignalsView } from "./signals-view";
import type { Scorecard } from "../qa/learning/oracle-types";
import type { RunRecord } from "../types";

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
  assert.ok(Math.abs((view.reviewer.passRate ?? 0) - 2 / 3) < 1e-9);
});
