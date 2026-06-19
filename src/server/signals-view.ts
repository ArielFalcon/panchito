import type { Scorecard } from "../qa/learning/oracle-types";
import type { RunRecord, RunOutcome } from "../types";

// toSignalsView aggregates per-app integrity data into the fleet-wide readout the
// dashboard's SIGNALS panel renders — the honest answer to "can I trust the fleet's
// green?". It is pure (no I/O), so it is unit-tested directly and the orchestrator wires
// the real history reads at the call site. The inferred return must stay structurally
// compatible with SignalsViewSchema — tsc catches any drift between this and the contract.
export function toSignalsView(
  inputs: Array<{ scorecard: Scorecard | null; runs: RunRecord[]; outcomes?: RunOutcome[] }>,
) {
  // ◆ ground truth: the value-oracle scorecard, aggregated across the fleet. The fleet
  // average is weighted by measured runs so a tiny app with one measured run doesn't
  // swing the number as hard as a heavily-measured one.
  let totalRuns = 0;
  let measuredRuns = 0;
  let weightedScoreSum = 0; // Σ(avgValueScore · measuredRuns)
  let hasScore = false; // did ANY app contribute a real (non-null) score?
  for (const { scorecard } of inputs) {
    if (!scorecard) continue;
    const s = scorecard.summary;
    totalRuns += s.totalRuns;
    measuredRuns += s.measuredRuns;
    if (s.measuredRuns > 0 && s.avgValueScore !== null) {
      weightedScoreSum += s.avgValueScore * s.measuredRuns;
      hasScore = true;
    }
  }
  // avgScore stays null unless a real score was contributed — otherwise a partial state
  // (measuredRuns > 0 but every avgValueScore null) would surface 0.00 as a ◆ ground-truth
  // reading when no quality number actually exists. Never paint absence as a hard zero.
  // Round to 4 dp to match coverage.avgRatio — otherwise the same panel shows a tidy 0.8 next to
  // a raw 0.6666666666666666.
  const avgScore = hasScore ? Math.round((weightedScoreSum / measuredRuns) * 1e4) / 1e4 : null;

  // ◇ proxy: of runs that produced a QUALITY verdict (pass/fail/flaky/invalid), how many
  // were green. skipped (a clean no-op) and infra-error (environment, not a code fault)
  // are excluded — counting them would distort the gate's reading.
  let passes = 0;
  let qualityRuns = 0;
  for (const { runs } of inputs) {
    for (const r of runs) {
      const v = r.verdict;
      if (v === undefined || v === "skipped" || v === "infra-error") continue;
      qualityRuns++;
      if (v === "pass") passes++;
    }
  }
  // Round to 4 dp to match avgScore / coverage.avgRatio — otherwise the same panel shows a tidy
  // 0.8 next to a raw 0.6666666666666666.
  const passRate = qualityRuns > 0 ? Math.round((passes / qualityRuns) * 1e4) / 1e4 : null;

  // ◆/⚠ change-coverage: aggregate the persisted coverageRatio across the fleet. avgRatio stays
  // null (→ "not measured") unless at least one run carried a ratio — absence is never a hard 0.
  let covSum = 0;
  let covMeasured = 0;
  let covTotal = 0;
  for (const { outcomes } of inputs) {
    for (const o of outcomes ?? []) {
      covTotal++;
      const r = o.gateSignals.coverageRatio;
      if (r !== null && r !== undefined) {
        covSum += r;
        covMeasured++;
      }
    }
  }

  return {
    valueOracle: {
      measured: measuredRuns > 0,
      avgScore,
      measuredRuns,
      totalRuns,
    },
    reviewer: {
      passRate,
      runs: qualityRuns,
    },
    // ◆/⚠ change-coverage: of runs that produced coverage data, what fraction of the changed
    // lines did the tests exercise? avgRatio is null (→ "not measured") when none carried a ratio.
    coverage: {
      measured: covMeasured > 0,
      avgRatio: covMeasured > 0 ? Math.round((covSum / covMeasured) * 1e4) / 1e4 : null,
      measuredRuns: covMeasured,
      totalRuns: covTotal,
    },
  };
}
