// toTrendsView splits an app's run outcomes (and run records) into a current vs previous window and
// computes the period-over-period readings the report surface needs (change-coverage, value-oracle,
// verdict mix, flaky rate, error-class distribution, suite duration, per-flow stability). Pure (no
// I/O), so it is unit-tested directly; the orchestrator injects the real history reads + clock at the
// call site. Every reading is null/0 when its source is absent — nothing is invented, and absence is
// never painted as a hard zero.
import type { RunOutcome, RunRecord } from "../types";

const round = (n: number): number => Math.round(n * 1e4) / 1e4;

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return round(xs.reduce((a, b) => a + b, 0) / xs.length);
}

function ratios(outcomes: RunOutcome[]): number[] {
  const out: number[] = [];
  for (const o of outcomes) {
    const r = o.gateSignals.coverageRatio;
    if (r !== null && r !== undefined) out.push(r);
  }
  return out;
}

function scores(outcomes: RunOutcome[]): number[] {
  const out: number[] = [];
  for (const o of outcomes) {
    const s = o.gateSignals.valueScore;
    if (s !== null && s !== undefined) out.push(s);
  }
  return out;
}

function countErrorClasses(outcomes: RunOutcome[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const o of outcomes) {
    if (o.errorClass === null) continue;
    m.set(o.errorClass, (m.get(o.errorClass) ?? 0) + 1);
  }
  return m;
}

// Total test-execution time for a run = sum of its case durations; null when no case carried timing.
function runDurationMs(r: RunRecord): number | null {
  let sum = 0;
  let any = false;
  for (const c of r.cases) {
    if (c.durationMs !== undefined && c.durationMs !== null) {
      sum += c.durationMs;
      any = true;
    }
  }
  return any ? sum : null;
}

function meanDurationMs(records: RunRecord[]): number | null {
  const xs: number[] = [];
  for (const r of records) {
    const d = runDurationMs(r);
    if (d !== null) xs.push(d);
  }
  if (xs.length === 0) return null;
  return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
}

// Per-flow instability over a window: only flows that actually flaked/failed are surfaced (a stable
// flow is not interesting), ranked by total instability then name.
function computeFlows(records: RunRecord[]): Array<{ flow: string; runs: number; flaky: number; fail: number }> {
  const m = new Map<string, { flow: string; runs: number; flaky: number; fail: number }>();
  for (const r of records) {
    for (const c of r.cases) {
      if (!c.flow) continue;
      let f = m.get(c.flow);
      if (!f) {
        f = { flow: c.flow, runs: 0, flaky: 0, fail: 0 };
        m.set(c.flow, f);
      }
      f.runs++;
      if (c.status === "flaky") f.flaky++;
      else if (c.status === "fail") f.fail++;
    }
  }
  return [...m.values()]
    .filter((f) => f.flaky > 0 || f.fail > 0)
    .sort((a, b) => b.flaky + b.fail - (a.flaky + a.fail) || a.flow.localeCompare(b.flow));
}

export interface TrendsInput {
  app: string;
  outcomes: RunOutcome[]; // newest-first (as listRunOutcomes returns)
  records?: RunRecord[]; // newest-first (as listRecords returns) — for duration + per-flow stability
  now: string; // ISO timestamp, injected for determinism
  window?: number; // outcomes per window (default 20)
  minRatio?: number; // change-coverage policy threshold (default 0.7)
}

export function toTrendsView(input: TrendsInput) {
  const window = input.window ?? 20;
  const minRatio = input.minRatio ?? 0.7;
  const current = input.outcomes.slice(0, window);
  const previous = input.outcomes.slice(window, window * 2);
  const records = input.records ?? [];
  const curRecords = records.slice(0, window);
  const prevRecords = records.slice(window, window * 2);

  const curRatios = ratios(current);
  const coverage = {
    measured: curRatios.length > 0,
    ratio: mean(curRatios),
    previousRatio: mean(ratios(previous)),
    minRatio,
    series: [...curRatios].reverse(), // oldest → newest for a line chart
  };

  const curScores = scores(current);
  const valueOracle = {
    measured: curScores.length > 0,
    avgScore: mean(curScores),
    previousAvgScore: mean(scores(previous)),
    series: [...curScores].reverse(),
  };

  const verdictMix: Record<string, number> = {};
  for (const o of current) verdictMix[o.verdict] = (verdictMix[o.verdict] ?? 0) + 1;

  // Proxy pass-rate over quality verdicts only — skipped (clean no-op) and infra-error
  // (environment, not a code fault) would distort the reading.
  const quality = current.filter((o) => o.verdict !== "skipped" && o.verdict !== "infra-error");
  const passes = quality.filter((o) => o.verdict === "pass").length;
  const reviewerPassRate = quality.length > 0 ? round(passes / quality.length) : null;

  // Flaky rate over quality verdicts only, mirroring reviewerPassRate — skipped (clean no-op) and
  // infra-error (environment, not a code fault) never flake, so including them would dilute the rate.
  const prevQuality = previous.filter((o) => o.verdict !== "skipped" && o.verdict !== "infra-error");
  const curFlaky = quality.filter((o) => o.gateSignals.flaky).length;
  const prevFlaky = prevQuality.filter((o) => o.gateSignals.flaky).length;
  const flaky = {
    rate: quality.length > 0 ? round(curFlaky / quality.length) : null,
    previousRate: prevQuality.length > 0 ? round(prevFlaky / prevQuality.length) : null,
    runs: quality.length,
  };

  const curEC = countErrorClasses(current);
  const prevEC = countErrorClasses(previous);
  const ecKeys = new Set<string>([...curEC.keys(), ...prevEC.keys()]);
  const errorClasses = [...ecKeys]
    .map((errorClass) => {
      const count = curEC.get(errorClass) ?? 0;
      const previousCount = prevEC.get(errorClass) ?? 0;
      return { errorClass, count, previousCount, multiplier: previousCount > 0 ? round(count / previousCount) : null };
    })
    .sort((a, b) => b.count - a.count || a.errorClass.localeCompare(b.errorClass));

  const duration = {
    avgMs: meanDurationMs(curRecords),
    previousMs: meanDurationMs(prevRecords),
    runs: curRecords.filter((r) => runDurationMs(r) !== null).length,
  };

  const flows = computeFlows(curRecords);

  return {
    app: input.app,
    generatedAt: input.now,
    window: { current: current.length, previous: previous.length },
    coverage,
    valueOracle,
    verdictMix,
    reviewerPassRate,
    flaky,
    errorClasses,
    duration,
    flows,
  };
}
