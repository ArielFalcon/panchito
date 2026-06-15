import { test } from "node:test";
import assert from "node:assert/strict";
import { toReportView, reportToCsv, trendsToCsv } from "./report-view";
import type { TrendsView } from "../contract/commands";

function trends(over: Partial<TrendsView> = {}): TrendsView {
  return {
    app: "a",
    generatedAt: "2026-06-14T00:00:00Z",
    window: { current: 10, previous: 10 },
    // Full-length series (≥10) so confidence is not throttled — confidence is sized by each
    // metric's own measured-sample count, and a sparse series would bury an otherwise-big mover.
    coverage: {
      measured: true,
      ratio: 0.8,
      previousRatio: 0.5,
      minRatio: 0.7,
      series: [0.5, 0.55, 0.6, 0.65, 0.7, 0.72, 0.74, 0.76, 0.78, 0.8],
    },
    valueOracle: {
      measured: true,
      avgScore: 0.7,
      previousAvgScore: 0.5,
      series: [0.5, 0.52, 0.55, 0.58, 0.6, 0.62, 0.64, 0.66, 0.68, 0.7],
    },
    verdictMix: { pass: 7, fail: 2, flaky: 1 },
    reviewerPassRate: 0.7,
    flaky: { rate: 0.1, previousRate: 0.1, runs: 10 },
    // unchanged (multiplier 1) so coverage is unambiguously the biggest mover.
    errorClasses: [{ errorClass: "E-COVERAGE-GAP", count: 4, previousCount: 4, multiplier: 1 }],
    duration: { avgMs: null, previousMs: null, runs: 0 },
    flows: [],
    ...over,
  };
}

test("toReportView ranks the biggest mover first and picks a chart per metric", () => {
  const report = toReportView(trends());
  assert.equal(report.app, "a");
  assert.ok(report.insights.length >= 4);
  // coverage moved 0.5 → 0.8 (1.6×) — outranks the flat metrics and headlines.
  assert.equal(report.insights[0]?.id, "change-coverage");
  assert.equal(report.insights[0]?.multiplier, 1.6);
  assert.equal(report.insights[0]?.direction, "up");
  assert.match(report.headline, /1\.6/);
  // chart selection by data shape (verdict mix is a composition → preferred chart is a donut).
  assert.equal(report.insights.find((i) => i.id === "verdict-mix")?.chart, "donut");
  assert.equal(report.insights.find((i) => i.id === "error-classes")?.chart, "ranked-bars");
  assert.ok((report.insights.find((i) => i.id === "verdict-mix")?.breakdown?.length ?? 0) >= 1);
});

test("toReportView ranks a from-zero climb first and headlines it honestly", () => {
  // coverage 0 → 0.8 has no finite multiplier but is a real, large movement: it must outrank the
  // other (flat) metrics and the headline must say it climbed from zero.
  const report = toReportView(
    trends({
      coverage: {
        measured: true,
        ratio: 0.8,
        previousRatio: 0,
        minRatio: 0.7,
        series: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8],
      },
      // hold the other movers flat so coverage is unambiguously first.
      valueOracle: {
        measured: true,
        avgScore: 0.5,
        previousAvgScore: 0.5,
        series: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
      },
      flaky: { rate: 0.1, previousRate: 0.1, runs: 10 },
    }),
  );
  assert.equal(report.insights[0]?.id, "change-coverage");
  assert.equal(report.insights[0]?.direction, "up");
  assert.equal(report.insights[0]?.multiplier, null); // no finite multiplier from a zero baseline
  assert.match(report.headline, /climbed from zero/);
});

test("toReportView scales a from-zero move by magnitude — a tiny blip does NOT outrank a real move", () => {
  // flaky climbs a trivial 0 → 0.1; coverage makes a real 0 → 0.8 move. Under the magnitude-scaled
  // fix the big mover wins; the old "slam to the cap" bug would have tied (or inverted via weight).
  const report = toReportView(
    trends({
      coverage: {
        measured: true,
        ratio: 0.8,
        previousRatio: 0,
        minRatio: 0.7,
        series: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8],
      },
      valueOracle: {
        measured: true,
        avgScore: 0.5,
        previousAvgScore: 0.5,
        series: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
      },
      flaky: { rate: 0.1, previousRate: 0, runs: 10 }, // trivial from-zero blip
    }),
  );
  const coverage = report.insights.find((i) => i.id === "change-coverage")!;
  const flaky = report.insights.find((i) => i.id === "flaky-rate")!;
  assert.ok(coverage.score > flaky.score, "the real 0→0.8 move must outrank the 0→0.1 blip");
  assert.equal(report.insights[0]?.id, "change-coverage");
});

test("toReportView emits self-describing fields: intent, unit, target, breakdown semantic", () => {
  const report = toReportView(trends());
  const cov = report.insights.find((i) => i.id === "change-coverage")!;
  assert.equal(cov.intent, "trend"); // a multi-point series → a trend
  assert.equal(cov.unit, "ratio");
  assert.equal(cov.target, 0.7); // the minRatio threshold line travels with the insight
  assert.match(cov.caption ?? "", /target/);
  const mix = report.insights.find((i) => i.id === "verdict-mix")!;
  assert.equal(mix.intent, "composition");
  assert.equal(mix.breakdown?.find((b) => b.label === "pass")?.semantic, "good");
  assert.equal(mix.breakdown?.find((b) => b.label === "fail")?.semantic, "bad");
});

test("toReportView is honest when nothing moved (no baseline)", () => {
  const report = toReportView(
    trends({
      coverage: { measured: false, ratio: null, previousRatio: null, minRatio: 0.7, series: [] },
      valueOracle: { measured: false, avgScore: null, previousAvgScore: null, series: [] },
      verdictMix: {},
      reviewerPassRate: null,
      flaky: { rate: null, previousRate: null, runs: 0 },
      errorClasses: [],
      window: { current: 0, previous: 0 },
    }),
  );
  assert.match(report.headline, /no notable movement/i);
});

test("reportToCsv flattens insights into one row each (header + data)", () => {
  const csv = reportToCsv(toReportView(trends()));
  const lines = csv.trim().split("\n");
  assert.match(lines[0]!, /^id,title,intent,chart,value,unit,delta,multiplier,direction,goodWhen,score$/);
  assert.ok(lines.length > 1);
  assert.ok(lines.some((l) => l.startsWith("change-coverage,")));
});

test("trendsToCsv dumps a flat metric,current,previous table", () => {
  const lines = trendsToCsv(trends()).trim().split("\n");
  assert.equal(lines[0], "metric,current,previous");
  assert.ok(lines.some((l) => l === "coverage.ratio,0.8,0.5"));
  assert.ok(lines.some((l) => l === "errorClass.E-COVERAGE-GAP,4,4"));
});

test("toReportView applies per-app weight overrides (qa.reports.weights)", () => {
  const covNormal = toReportView(trends()).insights.find((i) => i.id === "change-coverage")!.score;
  assert.ok(covNormal > 0); // coverage moved 0.5 → 0.8, so it scores under the default weight

  const deweighted = toReportView(trends(), { weights: { "change-coverage": 0 } });
  const covDe = deweighted.insights.find((i) => i.id === "change-coverage")!.score;
  assert.equal(covDe, 0); // weight 0 → score 0 regardless of how much it moved
  assert.notEqual(deweighted.insights[0]?.id, "change-coverage"); // and it no longer headlines
});
