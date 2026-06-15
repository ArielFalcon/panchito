import { test } from "node:test";
import assert from "node:assert/strict";
import { toRunReportView } from "./run-report-view";
import type { RunRecord, RunOutcome } from "../types";

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    app: "portfolio",
    sha: "abc123",
    target: "e2e",
    mode: "diff",
    status: "done",
    verdict: "pass",
    passed: 3,
    failed: 0,
    cases: [
      { name: "login", status: "pass", flow: "auth", durationMs: 1200 },
      { name: "checkout", status: "pass", flow: "cart", durationMs: 2300 },
      { name: "profile", status: "pass", flow: "auth", durationMs: 800 },
    ],
    logs: [],
    at: "2026-06-14T10:00:00.000Z",
    ...over,
  };
}

function outcome(over: Partial<RunOutcome["gateSignals"]> = {}, top: Partial<RunOutcome> = {}): RunOutcome {
  return {
    runId: "run-1",
    app: "portfolio",
    sha: "abc123",
    mode: "diff",
    target: "e2e",
    verdict: "pass",
    errorClass: null,
    gateSignals: {
      static: true,
      coverageRatio: 0.82,
      valueScore: 0.9,
      reviewerCorrections: [],
      flaky: false,
      retries: 0,
      ...over,
    },
    rulesRetrieved: [],
    at: "2026-06-14T10:00:00.000Z",
    ...top,
  };
}

test("passing run: PASS headline with coverage, case-mix donut, single-run window", () => {
  const view = toRunReportView({ record: record(), outcome: outcome() });
  assert.equal(view.app, "portfolio");
  assert.equal(view.generatedAt, "2026-06-14T10:00:00.000Z");
  assert.deepEqual(view.window, { current: 1, previous: 0 });
  assert.equal(view.headline, "PASS — 3/3 cases green · 82% change-coverage");

  const mix = view.insights.find((i) => i.id === "case-mix")!;
  assert.equal(mix.intent, "composition");
  assert.equal(mix.chart, "donut");
  assert.equal(mix.value, 3);
  // A clean run has only the pass slice — fail/flaky slices are omitted, not painted as zero bars.
  assert.deepEqual(mix.breakdown, [{ label: "pass", value: 3, semantic: "good" }]);

  const cov = view.insights.find((i) => i.id === "change-coverage")!;
  assert.equal(cov.chart, "gauge");
  assert.equal(cov.value, 0.82);
  assert.equal(cov.target, 0.7);
  assert.equal(cov.caption, "82% of changed lines exercised (target 70%)");
});

test("clean run ranks by importance: case-mix first, duration last", () => {
  const view = toRunReportView({ record: record(), outcome: outcome() });
  const ids = view.insights.map((i) => i.id);
  assert.equal(ids[0], "case-mix");
  assert.equal(ids[ids.length - 1], "suite-duration");
  // No flow misbehaved, so the flow-results insight is absent entirely.
  assert.ok(!ids.includes("flow-results"));
});

test("failing run: FAIL headline with error class, flow-results surfaces and outranks clean metrics", () => {
  const rec = record({
    verdict: "fail",
    passed: 1,
    failed: 2,
    cases: [
      { name: "login", status: "pass", flow: "auth", durationMs: 1000 },
      { name: "pay", status: "fail", flow: "checkout", durationMs: 500 },
      { name: "refund", status: "fail", flow: "checkout", durationMs: 400 },
    ],
  });
  const out = outcome({ coverageRatio: 0.4 }, { verdict: "fail", errorClass: "E-EXEC-FAIL" });
  const view = toRunReportView({ record: rec, outcome: out });

  assert.equal(view.headline, "FAIL — 2 of 3 cases failed · E-EXEC-FAIL");

  const flows = view.insights.find((i) => i.id === "flow-results")!;
  assert.equal(flows.intent, "distribution");
  assert.equal(flows.chart, "ranked-bars");
  assert.deepEqual(flows.breakdown, [{ label: "checkout", value: 2, semantic: "bad" }]);

  // Concern boosts problems to the top: case-mix (lots failed) and flows lead; below-target
  // coverage outranks the (here-absent-from-concern) clean value/duration.
  const ids = view.insights.map((i) => i.id);
  assert.ok(ids.indexOf("flow-results") < ids.indexOf("suite-duration"));
  assert.ok(ids.indexOf("change-coverage") < ids.indexOf("suite-duration"));
});

test("coverage not measured: value is null (never a hard zero), caption says so", () => {
  const view = toRunReportView({ record: record(), outcome: outcome({ coverageRatio: null, valueScore: null }) });
  const cov = view.insights.find((i) => i.id === "change-coverage")!;
  assert.equal(cov.value, null);
  assert.equal(cov.caption, "not measured this run");
  const val = view.insights.find((i) => i.id === "value-oracle")!;
  assert.equal(val.value, null);
  // Headline omits the coverage tail when there is none.
  assert.equal(view.headline, "PASS — 3/3 cases green");
});

test("no outcome at all: metrics null, run still reports its case mix and verdict", () => {
  const view = toRunReportView({ record: record(), outcome: null });
  assert.equal(view.headline, "PASS — 3/3 cases green");
  assert.equal(view.insights.find((i) => i.id === "change-coverage")!.value, null);
  assert.ok(view.insights.find((i) => i.id === "case-mix"));
});

test("empty cases fall back to passed/failed tallies", () => {
  const rec = record({ cases: [], passed: 5, failed: 1, verdict: "fail" });
  const view = toRunReportView({ record: rec, outcome: outcome({}, { verdict: "fail" }) });
  const mix = view.insights.find((i) => i.id === "case-mix")!;
  assert.equal(mix.value, 6);
  assert.deepEqual(mix.breakdown, [
    { label: "pass", value: 5, semantic: "good" },
    { label: "fail", value: 1, semantic: "bad" },
  ]);
});

test("weights override the base importance of an insight", () => {
  const base = toRunReportView({ record: record(), outcome: outcome() });
  const boosted = toRunReportView({ record: record(), outcome: outcome(), weights: { "suite-duration": 9 } });
  const baseDur = base.insights.find((i) => i.id === "suite-duration")!.score;
  const boostedDur = boosted.insights.find((i) => i.id === "suite-duration")!.score;
  assert.ok(boostedDur > baseDur);
  // With a 9 weight, duration now headlines the run report.
  assert.equal(boosted.insights[0]!.id, "suite-duration");
});

test("flaky verdict and skipped verdict produce their own headlines", () => {
  const flaky = toRunReportView({
    record: record({ verdict: "flaky" }),
    outcome: outcome({ flaky: true }, { verdict: "flaky" }),
  });
  assert.equal(flaky.headline, "FLAKY — passed only on retry · quarantined");

  const skipped = toRunReportView({
    record: record({ verdict: "skipped", cases: [], passed: 0, failed: 0 }),
    outcome: null,
  });
  assert.equal(skipped.headline, "SKIPPED — no test-worthy change");
});

test("suite duration sums case timings; null when no case carried timing", () => {
  const view = toRunReportView({ record: record(), outcome: outcome() });
  assert.equal(view.insights.find((i) => i.id === "suite-duration")!.value, 1200 + 2300 + 800);

  const untimed = toRunReportView({
    record: record({ cases: [{ name: "x", status: "pass", flow: "auth" }] }),
    outcome: outcome(),
  });
  assert.equal(untimed.insights.find((i) => i.id === "suite-duration")!.value, null);
});
