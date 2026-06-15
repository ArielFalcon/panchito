// toRunReportView turns ONE finished run (its record + learning outcome) into a self-describing
// report about THAT execution — distinct from the evolutionary report (toReportView), which ranks
// period-over-period trends. This answers "what is important about the run that just finished?":
// the verdict, the case mix, this run's change-coverage and value-oracle, its duration, and which
// flows misbehaved. It emits the SAME ReportView shape as the evolutionary report, so every client
// renders both with one renderer (render by `intent`, not by domain).
//
// Pure — unit-tested directly. Snapshot semantics: there is no previous window, so delta/multiplier
// are null and ranking is by IMPORTANCE plus a CONCERN boost — a failing/under-target metric rises
// to the top so problems surface first; a clean green run lists the facts in natural importance
// order. Absence is never painted as a hard zero (a not-measured ratio is null, not 0).
import type { RunRecord, RunOutcome } from "../types";
import type { ReportView } from "../contract/commands";

type Insight = ReportView["insights"][number];

const round = (n: number): number => Math.round(n * 1e4) / 1e4;
const pct = (n: number): number => Math.round(n * 1000) / 10; // 0.812 → 81.2

// Sum of the run's case wall-clock times; null when no case carried timing (never 0-as-absence).
function suiteDurationMs(record: RunRecord): number | null {
  let sum = 0;
  let any = false;
  for (const c of record.cases) {
    if (c.durationMs !== undefined && c.durationMs !== null) {
      sum += c.durationMs;
      any = true;
    }
  }
  return any ? sum : null;
}

// Case counts by status, derived from the case list; falls back to the record's pass/fail tallies
// when no per-case detail is present (e.g. a code-target run that only carries counts).
function caseCounts(record: RunRecord): { pass: number; fail: number; flaky: number; total: number } {
  if (record.cases.length > 0) {
    let pass = 0;
    let fail = 0;
    let flaky = 0;
    for (const c of record.cases) {
      if (c.status === "pass") pass++;
      else if (c.status === "fail") fail++;
      else if (c.status === "flaky") flaky++;
    }
    return { pass, fail, flaky, total: record.cases.length };
  }
  const pass = record.passed ?? 0;
  const fail = record.failed ?? 0;
  return { pass, fail, flaky: 0, total: pass + fail };
}

// Per-flow fail+flaky for THIS run — only flows that misbehaved are surfaced (a clean flow is not
// interesting), ranked by instability then name.
function flowResults(record: RunRecord): Array<{ flow: string; instability: number }> {
  const m = new Map<string, number>();
  for (const c of record.cases) {
    if (!c.flow) continue;
    if (c.status === "fail" || c.status === "flaky") m.set(c.flow, (m.get(c.flow) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([flow, instability]) => ({ flow, instability }))
    .sort((a, b) => b.instability - a.instability || a.flow.localeCompare(b.flow));
}

// A run-centric headline: the verdict first, then the one fact that matters most for it.
function runHeadline(record: RunRecord, outcome: RunOutcome | null, counts: ReturnType<typeof caseCounts>): string {
  const verdict = record.verdict ?? "skipped";
  const cov = outcome?.gateSignals.coverageRatio;
  switch (verdict) {
    case "pass": {
      const tail = cov !== null && cov !== undefined ? ` · ${pct(cov)}% change-coverage` : "";
      return `PASS — ${counts.pass}/${counts.total} cases green${tail}`;
    }
    case "fail": {
      const ec = outcome?.errorClass ? ` · ${outcome.errorClass}` : "";
      const bad = counts.fail + counts.flaky;
      return `FAIL — ${bad} of ${counts.total} cases failed${ec}`;
    }
    case "flaky":
      return `FLAKY — passed only on retry · quarantined`;
    case "invalid":
      return `INVALID — static gate rejected the suite`;
    case "infra-error":
      return `INFRA — DEV unavailable, not a code fault`;
    default:
      return `SKIPPED — no test-worthy change`;
  }
}

// A snapshot metric insight: no previous window, so delta/multiplier are null and direction is flat
// (the client colours by value-vs-target + goodWhen, not by movement). `score` carries the ranking.
function snapshot(p: {
  id: string;
  title: string;
  chart: Insight["chart"];
  value: number | null;
  unit: Insight["unit"];
  goodWhen: Insight["goodWhen"];
  score: number;
  target?: number | null;
  caption?: string;
}): Insight {
  const insight: Insight = {
    id: p.id,
    title: p.title,
    intent: "single-value",
    chart: p.chart,
    value: p.value,
    unit: p.unit,
    delta: null,
    multiplier: null,
    direction: "flat",
    goodWhen: p.goodWhen,
    score: round(p.score),
  };
  if (p.target !== undefined) insight.target = p.target;
  if (p.caption) insight.caption = p.caption;
  return insight;
}

export interface RunReportInput {
  record: RunRecord;
  outcome: RunOutcome | null; // the learning-ledger outcome for the run (coverage/value/reviewer)
  minRatio?: number; // change-coverage target for the gauge (default 0.7)
  weights?: Record<string, number>; // per-insight base-importance override (qa.reports.weights)
}

export function toRunReportView(input: RunReportInput): ReportView {
  const { record, outcome } = input;
  const minRatio = input.minRatio ?? 0.7;
  // Base importance per insight; concern (in 0..1) is added on top so a problem outranks its base.
  // Overridable per-app by id, sharing the keys the evolutionary ranker uses where they overlap.
  const W = (id: string, dflt: number): number => input.weights?.[id] ?? dflt;
  const counts = caseCounts(record);
  const insights: Insight[] = [];

  // Case mix — the headline composition of the run. Concern = share of non-passing cases.
  if (counts.total > 0) {
    const concern = (counts.fail + counts.flaky) / counts.total;
    const breakdown: Insight["breakdown"] = [{ label: "pass", value: counts.pass, semantic: "good" }];
    if (counts.fail > 0) breakdown.push({ label: "fail", value: counts.fail, semantic: "bad" });
    if (counts.flaky > 0) breakdown.push({ label: "flaky", value: counts.flaky, semantic: "bad" });
    insights.push({
      id: "case-mix",
      title: "Case results",
      intent: "composition",
      chart: "donut",
      value: counts.total,
      unit: "count",
      delta: null,
      multiplier: null,
      direction: "flat",
      goodWhen: "neutral",
      caption: `${counts.pass}/${counts.total} passed`,
      breakdown,
      score: round(W("case-mix", 1) + concern),
    });
  }

  // Change-coverage of THIS run — did the test actually exercise the diff? Gauge vs the target.
  {
    const value = outcome?.gateSignals.coverageRatio ?? null;
    const concern = value !== null && value < minRatio ? (minRatio - value) / minRatio : 0;
    insights.push(
      snapshot({
        id: "change-coverage",
        title: "Change-coverage (diff exercised)",
        chart: "gauge",
        value,
        unit: "ratio",
        goodWhen: "up",
        target: minRatio,
        score: W("change-coverage", 0.9) + concern,
        caption:
          value !== null
            ? `${pct(value)}% of changed lines exercised (target ${pct(minRatio)}%)`
            : "not measured this run",
      }),
    );
  }

  // Value-oracle (mutation kill rate) of THIS run. Concern when below a coin-flip.
  {
    const value = outcome?.gateSignals.valueScore ?? null;
    const concern = value !== null && value < 0.5 ? 0.5 - value : 0;
    insights.push(
      snapshot({
        id: "value-oracle",
        title: "Value-oracle (mutation kill rate)",
        chart: "gauge",
        value,
        unit: "ratio",
        goodWhen: "up",
        score: W("value-oracle", 0.7) + concern,
        caption: value !== null ? `${pct(value)}% of injected faults caught` : "not measured this run",
      }),
    );
  }

  // Per-flow results — only when a flow actually failed/flaked this run.
  const flows = flowResults(record);
  if (flows.length > 0) {
    const top = flows[0]!;
    insights.push({
      id: "flow-results",
      title: "Flows that misbehaved",
      intent: "distribution",
      chart: "ranked-bars",
      value: top.instability,
      unit: "count",
      delta: null,
      multiplier: null,
      direction: "flat",
      goodWhen: "down",
      breakdown: flows.map((f) => ({ label: f.flow, value: f.instability, semantic: "bad" as const })),
      score: round(W("flow-results", 0.85) + 1),
    });
  }

  // Suite duration — informational; never a concern on its own.
  insights.push(
    snapshot({
      id: "suite-duration",
      title: "Suite duration",
      chart: "big-number",
      value: suiteDurationMs(record),
      unit: "ms",
      goodWhen: "down",
      score: W("suite-duration", 0.3),
    }),
  );

  insights.sort((a, b) => b.score - a.score);

  return {
    app: record.app,
    generatedAt: record.at,
    window: { current: 1, previous: 0 }, // a single run — not a windowed comparison
    headline: runHeadline(record, outcome, counts),
    insights,
  };
}
