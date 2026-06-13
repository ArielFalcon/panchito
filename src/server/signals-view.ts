import type { Scorecard } from "../qa/learning/oracle-types";
import type { RunRecord } from "../types";

// toSignalsView aggregates per-app integrity data into the fleet-wide readout the
// dashboard's SIGNALS panel renders — the honest answer to "can I trust the fleet's
// green?". It is pure (no I/O), so it is unit-tested directly and the orchestrator wires
// the real history reads at the call site. The inferred return must stay structurally
// compatible with SignalsViewSchema — tsc catches any drift between this and the contract.
export function toSignalsView(
  inputs: Array<{ scorecard: Scorecard | null; runs: RunRecord[] }>,
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
  const avgScore = hasScore ? weightedScoreSum / measuredRuns : null;

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
  const passRate = qualityRuns > 0 ? passes / qualityRuns : null;

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
    // ⚠ keystone, not built yet: change-coverage gating. Stays false until it ships, so
    // the panel never paints an unmeasured proxy as a ground-truth signal.
    coverage: {
      measured: false,
    },
  };
}
