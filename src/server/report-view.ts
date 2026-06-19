// toReportView turns a TrendsView into an ad-hoc report: it ranks each metric by how much it
// MOVED versus the previous window (interestingness = relative change × weight × confidence) and
// emits a SELF-DESCRIBING insight (intent + chart + unit + target + breakdown semantic) so any
// client can render it without domain knowledge. Pure — unit-tested directly. Keystone guard
// against vanity reporting: a metric that did not move (or has no baseline) scores 0 and never
// headlines, so the report surfaces what changed the ground truth, not what ran.
import type { TrendsView, ReportView } from "../contract/commands";

type Insight = ReportView["insights"][number];
type Intent = Insight["intent"];

const round = (n: number): number => Math.round(n * 1e4) / 1e4;
const confidence = (sample: number): number => Math.min(sample / 10, 1);
const pct = (n: number): number => Math.round(n * 1000) / 10; // 0.812 → 81.2

// Colour intent for one verdict slice: the backend owns the domain meaning so every client paints
// it identically. pass is good; fail/invalid/flaky are bad; skipped/infra-error are neutral noise.
function verdictSemantic(verdict: string): "good" | "bad" | "neutral" {
  if (verdict === "pass") return "good";
  if (verdict === "fail" || verdict === "invalid" || verdict === "flaky") return "bad";
  return "neutral";
}

function metricInsight(p: {
  id: string;
  title: string;
  intent: Intent;
  chart: Insight["chart"];
  value: number | null;
  previous: number | null;
  unit: Insight["unit"];
  goodWhen: Insight["goodWhen"];
  weight: number;
  sample: number;
  target?: number | null;
  series?: number[];
  caption?: string;
}): Insight {
  const both = p.value !== null && p.previous !== null;
  const delta = both ? round(p.value! - p.previous!) : null;
  const multiplier = both && p.previous !== 0 ? round(p.value! / p.previous!) : null;
  // A rise from a zero baseline (0 → x>0) has no finite multiplier yet is a genuine movement, so
  // score it by the magnitude ACHIEVED (these metrics are 0..1 ratios) rather than 0 or the cap.
  const fromZeroUp = both && p.previous === 0 && p.value! > 0;
  const direction: Insight["direction"] = fromZeroUp
    ? "up"
    : delta === null || Math.abs(delta) < 1e-9
      ? "flat"
      : delta > 0
        ? "up"
        : "down";
  const rc = fromZeroUp
    ? Math.min(p.value!, 4) // magnitude-scaled: the achieved 0..1 value (capped at the global 4)
    : both && p.previous !== 0
      ? Math.abs((p.value! - p.previous!) / p.previous!)
      : 0;
  const score = round(Math.min(rc, 4) * p.weight * confidence(p.sample));
  const insight: Insight = {
    id: p.id,
    title: p.title,
    intent: p.intent,
    chart: p.chart,
    value: p.value,
    unit: p.unit,
    delta,
    multiplier,
    direction,
    goodWhen: p.goodWhen,
    score,
  };
  if (p.target !== undefined) insight.target = p.target;
  if (p.caption) insight.caption = p.caption;
  if (p.series && p.series.length > 0) insight.series = p.series;
  return insight;
}

function headline(insights: Insight[]): string {
  const top = insights.find((i) => i.score > 0);
  if (!top) return "No notable movement this period.";
  // Frame the move by whether it is good or bad for this metric: a rise in flaky/error rate is
  // bad news, a rise in coverage is good. goodWhen "neutral" stays purely descriptive.
  const improving =
    top.goodWhen === "neutral"
      ? null
      : (top.direction === "up" && top.goodWhen === "up") ||
        (top.direction === "down" && top.goodWhen === "down");
  if (top.multiplier !== null) {
    if (improving === false) {
      return top.direction === "up"
        ? `${top.title} worsened — up ${top.multiplier}× this period.`
        : `${top.title} worsened — down to ${top.multiplier}× of last period.`;
    }
    if (improving === true) {
      return top.direction === "up"
        ? `${top.title} improved — up ${top.multiplier}× this period.`
        : `${top.title} improved — down to ${top.multiplier}× of last period.`;
    }
    return top.multiplier >= 1
      ? `${top.title} up ${top.multiplier}× this period.`
      : `${top.title} down to ${top.multiplier}× of last period.`;
  }
  // No multiplier — most often a from-zero gain (previous baseline 0). Phrase the climb honestly.
  if (top.direction === "up" && top.value !== null) {
    const tail = improving === false ? " (worse)" : improving === true ? " (better)" : "";
    return `${top.title} climbed from zero to ${top.value} this period${tail}.`;
  }
  return `${top.title} shifted this period.`;
}

export function toReportView(trends: TrendsView, opts?: { weights?: Record<string, number> }): ReportView {
  // Each metric's confidence is sized by ITS OWN measured-sample count, not the whole window —
  // a coverage reading from 2 measured runs must not borrow the window's confidence. Metrics
  // measured on every run (verdict-mix, error-classes) use the window size. The per-insight
  // interestingness weight is overridable per-app (qa.reports.weights), keyed by insight id.
  const windowSample = trends.window.current;
  const W = (id: string, dflt: number): number => opts?.weights?.[id] ?? dflt;
  const insights: Insight[] = [];

  insights.push(
    metricInsight({
      id: "change-coverage",
      title: "Change-coverage (diff exercised by tests)",
      intent: trends.coverage.series.length > 1 ? "trend" : "comparison",
      chart: trends.coverage.series.length > 1 ? "line" : "paired-bars",
      value: trends.coverage.ratio,
      previous: trends.coverage.previousRatio,
      unit: "ratio",
      goodWhen: "up",
      weight: W("change-coverage", 1),
      sample: trends.coverage.series.length,
      target: trends.coverage.minRatio,
      series: trends.coverage.series,
      caption:
        trends.coverage.ratio !== null
          ? `${pct(trends.coverage.ratio)}% of changed lines exercised (target ${pct(trends.coverage.minRatio)}%)`
          : "not measured this window",
    }),
  );

  insights.push(
    metricInsight({
      id: "value-oracle",
      title: "Value-oracle (mutation kill rate)",
      intent: trends.valueOracle.series.length > 1 ? "trend" : "comparison",
      chart: trends.valueOracle.series.length > 1 ? "line" : "paired-bars",
      value: trends.valueOracle.avgScore,
      previous: trends.valueOracle.previousAvgScore,
      unit: "ratio",
      goodWhen: "up",
      weight: W("value-oracle", 1),
      sample: trends.valueOracle.series.length,
      series: trends.valueOracle.series,
    }),
  );

  insights.push(
    metricInsight({
      id: "reviewer-pass-rate",
      title: "Reviewer pass-rate",
      intent: "single-value",
      chart: "big-number",
      value: trends.reviewerPassRate,
      previous: null, // trends carries no previous-window pass-rate yet — a single value, not a move
      unit: "ratio",
      goodWhen: "up",
      weight: W("reviewer-pass-rate", 0.6),
      sample: windowSample,
    }),
  );

  insights.push(
    metricInsight({
      id: "flaky-rate",
      title: "Flaky / quarantine rate",
      intent: "single-value",
      chart: "big-number",
      value: trends.flaky.rate,
      previous: trends.flaky.previousRate,
      unit: "ratio",
      goodWhen: "down",
      weight: W("flaky-rate", 0.7),
      sample: trends.flaky.runs,
    }),
  );

  insights.push({
    id: "verdict-mix",
    title: "Verdict mix",
    intent: "composition",
    chart: "donut", // preferred (web draws a donut); a terminal falls back to a stacked bar / % list
    value: null,
    unit: "count",
    delta: null,
    multiplier: null,
    direction: "flat",
    goodWhen: "neutral",
    breakdown: Object.entries(trends.verdictMix).map(([label, value]) => ({
      label,
      value,
      semantic: verdictSemantic(label),
    })),
    score: round(W("verdict-mix", 0.4) * confidence(windowSample)),
  });

  if (trends.errorClasses.length > 0) {
    const top = trends.errorClasses[0]!;
    const rc = top.multiplier !== null ? Math.abs(top.multiplier - 1) : 0;
    insights.push({
      id: "error-classes",
      title: "Where the guardrails fire (by error class)",
      intent: "distribution",
      chart: "ranked-bars",
      value: top.count,
      unit: "count",
      delta: top.previousCount > 0 ? top.count - top.previousCount : null,
      multiplier: top.multiplier,
      direction:
        top.multiplier === null ? "flat" : top.multiplier > 1 ? "up" : top.multiplier < 1 ? "down" : "flat",
      goodWhen: "down",
      breakdown: trends.errorClasses.map((e) => ({ label: e.errorClass, value: e.count, semantic: "neutral" as const })),
      score: round(Math.min(rc, 4) * W("error-classes", 0.8) * confidence(windowSample)),
    });
  }

  insights.push(
    metricInsight({
      id: "suite-duration",
      title: "Suite duration",
      intent: "single-value",
      chart: "big-number",
      value: trends.duration.avgMs,
      previous: trends.duration.previousMs,
      unit: "ms",
      goodWhen: "down",
      weight: W("suite-duration", 0.5),
      sample: trends.duration.runs,
    }),
  );

  // Per-flow stability — only when some flow actually flaked/failed (else it is not interesting).
  if (trends.flows.length > 0) {
    const top = trends.flows[0]!;
    const topInstability = top.flaky + top.fail;
    insights.push({
      id: "flow-stability",
      title: "Least stable flows",
      intent: "distribution",
      chart: "ranked-bars",
      value: topInstability,
      unit: "count",
      delta: null,
      multiplier: null,
      direction: "flat",
      goodWhen: "down",
      breakdown: trends.flows.map((f) => ({ label: f.flow, value: f.flaky + f.fail, semantic: "bad" as const })),
      score: round(Math.min(topInstability / 5, 1) * W("flow-stability", 0.6) * confidence(windowSample)),
    });
  }

  insights.sort((a, b) => b.score - a.score);

  return {
    app: trends.app,
    generatedAt: trends.generatedAt,
    window: trends.window,
    headline: headline(insights),
    insights,
  };
}

// CSV-escape one cell (quote when it contains a comma, quote, or newline). null/undefined → "".
function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// reportToCsv flattens a report's insights into a spreadsheet-friendly table — one row per insight.
// The nested series/breakdown are omitted (they belong in a chart, not a CSV cell). Pure.
export function reportToCsv(report: ReportView): string {
  const cols = ["id", "title", "intent", "chart", "value", "unit", "delta", "multiplier", "direction", "goodWhen", "score"];
  const rows = report.insights.map((i) =>
    [i.id, i.title, i.intent, i.chart, i.value, i.unit, i.delta, i.multiplier, i.direction, i.goodWhen, i.score]
      .map(csvEscape)
      .join(","),
  );
  return [cols.join(","), ...rows].join("\n") + "\n";
}

// trendsToCsv dumps the trends as a flat metric,current,previous table — scalars plus each
// error-class, verdict and unstable flow as its own row. Pure.
export function trendsToCsv(trends: TrendsView): string {
  const rows: Array<[string, unknown, unknown]> = [
    ["coverage.ratio", trends.coverage.ratio, trends.coverage.previousRatio],
    ["valueOracle.avgScore", trends.valueOracle.avgScore, trends.valueOracle.previousAvgScore],
    ["reviewerPassRate", trends.reviewerPassRate, null],
    ["flaky.rate", trends.flaky.rate, trends.flaky.previousRate],
    ["duration.avgMs", trends.duration.avgMs, trends.duration.previousMs],
  ];
  for (const [verdict, n] of Object.entries(trends.verdictMix)) rows.push([`verdict.${verdict}`, n, null]);
  for (const e of trends.errorClasses) rows.push([`errorClass.${e.errorClass}`, e.count, e.previousCount]);
  for (const f of trends.flows) rows.push([`flow.${f.flow}`, f.flaky + f.fail, null]);
  const body = rows.map(([m, c, p]) => [m, c, p].map(csvEscape).join(","));
  return ["metric,current,previous", ...body].join("\n") + "\n";
}
