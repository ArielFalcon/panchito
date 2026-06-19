import { test } from "node:test";
import assert from "node:assert/strict";
import { toTrendsView } from "./trends-view";
import type { RunOutcome, RunVerdict, RunRecord } from "../types";

const round = (n: number): number => Math.round(n * 1e4) / 1e4;

function outcome(p: {
  verdict: RunVerdict;
  coverageRatio?: number | null;
  valueScore?: number | null;
  flaky?: boolean;
  errorClass?: RunOutcome["errorClass"];
}): RunOutcome {
  return {
    runId: "r",
    app: "a",
    sha: "s",
    mode: "diff",
    target: "e2e",
    verdict: p.verdict,
    errorClass: p.errorClass ?? null,
    gateSignals: {
      static: true,
      coverageRatio: p.coverageRatio ?? null,
      valueScore: p.valueScore ?? null,
      reviewerCorrections: [],
      flaky: p.flaky ?? false,
      retries: 0,
    },
    rulesRetrieved: [],
    at: "2026-01-01T00:00:00Z",
  };
}

test("toTrendsView splits current vs previous window and computes the coverage trend", () => {
  // newest-first; window=2 → current = first 2, previous = next 2.
  const outcomes = [
    outcome({ verdict: "pass", coverageRatio: 0.8 }),
    outcome({ verdict: "pass", coverageRatio: 0.6 }),
    outcome({ verdict: "fail", coverageRatio: 0.4 }),
    outcome({ verdict: "pass", coverageRatio: 0.2 }),
  ];
  const v = toTrendsView({ app: "a", outcomes, now: "2026-06-14T00:00:00Z", window: 2 });
  assert.equal(v.window.current, 2);
  assert.equal(v.window.previous, 2);
  assert.equal(v.coverage.measured, true);
  assert.equal(v.coverage.ratio, 0.7); // (0.8 + 0.6) / 2
  assert.equal(v.coverage.previousRatio, 0.3); // (0.4 + 0.2) / 2
  assert.equal(v.coverage.minRatio, 0.7);
  assert.deepEqual(v.coverage.series, [0.6, 0.8]); // oldest → newest
});

test("toTrendsView aggregates verdict mix, flaky rate and error classes (current window)", () => {
  const outcomes = [
    outcome({ verdict: "pass" }),
    outcome({ verdict: "flaky", flaky: true }),
    outcome({ verdict: "fail", errorClass: "E-EXEC-FAIL" }),
  ];
  const v = toTrendsView({ app: "a", outcomes, now: "2026-06-14T00:00:00Z", window: 3 });
  assert.equal(v.verdictMix["pass"], 1);
  assert.equal(v.verdictMix["flaky"], 1);
  assert.equal(v.verdictMix["fail"], 1);
  assert.equal(v.flaky.rate, round(1 / 3));
  assert.equal(v.reviewerPassRate, round(1 / 3)); // pass / (pass + flaky + fail)
  assert.equal(v.errorClasses.length, 1);
  assert.equal(v.errorClasses[0]?.errorClass, "E-EXEC-FAIL");
  assert.equal(v.errorClasses[0]?.count, 1);
});

test("toTrendsView computes suite duration and per-flow stability from records", () => {
  const rec = (cases: RunRecord["cases"]): RunRecord => ({
    id: "r", app: "a", sha: "s", target: "e2e", mode: "diff", status: "done", cases, logs: [], at: "2026-01-01T00:00:00Z",
  });
  const records = [
    rec([
      { name: "a", status: "pass", flow: "checkout", durationMs: 100 },
      { name: "b", status: "flaky", flow: "login", durationMs: 200 },
    ]),
    rec([{ name: "a", status: "fail", flow: "login", durationMs: 50 }]),
  ];
  const v = toTrendsView({ app: "a", outcomes: [], records, now: "2026-06-14T00:00:00Z", window: 2 });
  assert.equal(v.duration.avgMs, 175); // run1 = 100+200=300, run2 = 50 → mean 175
  assert.equal(v.duration.runs, 2);
  const login = v.flows.find((f) => f.flow === "login");
  assert.equal(login?.flaky, 1);
  assert.equal(login?.fail, 1);
  assert.ok(!v.flows.some((f) => f.flow === "checkout")); // a stable flow is not surfaced
});

test("toTrendsView flaky.runs counts only quality verdicts and flaky.rate uses that denominator", () => {
  // A mixed window: pass + flaky are quality; skipped + infra-error are excluded. flaky.runs must
  // be the quality count (2), and flaky.rate must divide by it (1 flaky / 2 quality = 0.5), NOT by
  // the full window of 4.
  const outcomes = [
    outcome({ verdict: "pass" }),
    outcome({ verdict: "flaky", flaky: true }),
    outcome({ verdict: "skipped" }),
    outcome({ verdict: "infra-error" }),
  ];
  const v = toTrendsView({ app: "a", outcomes, now: "2026-06-14T00:00:00Z", window: 4 });
  assert.equal(v.flaky.runs, 2); // quality count: skipped + infra-error excluded
  assert.equal(v.flaky.rate, 0.5); // 1 flaky / 2 quality, NOT 1 / 4
});

test("toTrendsView reports coverage as not measured when no run carried a ratio", () => {
  const v = toTrendsView({
    app: "a",
    outcomes: [outcome({ verdict: "pass" }), outcome({ verdict: "fail" })],
    now: "2026-06-14T00:00:00Z",
  });
  assert.equal(v.coverage.measured, false);
  assert.equal(v.coverage.ratio, null);
  assert.deepEqual(v.coverage.series, []);
});
