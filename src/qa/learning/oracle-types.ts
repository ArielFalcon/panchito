// OracleInput and ValueOracleResult were removed here in migration-tier-1-2 (Slice 4):
// ValueOracleResult now has ONE home (qa-engine's objective-signal/application/ports/index.ts —
// this copy was byte-identical, confirmed against HEAD); OracleInput dissolved entirely — its only
// consumers were the two oracle modules deleted in Slices 2-3, which each now own a local
// structural input type instead of a shared one. This file stays SHELL-ONLY (D8 learning-store
// boundary): Scorecard/ScorecardEntry/updateScorecard keep their existing consumers
// (src/server/history.ts, signals-view.ts, intelligence-view.ts) with ZERO import churn.
import type { TestTarget } from "../../types";

export interface ScorecardEntry {
  runId: string;
  app: string;
  sha: string;
  target: TestTarget;
  valueScore: number | null;
  mutantCount: number;
  killedCount: number;
  at: string;
}

export interface Scorecard {
  app: string;
  updatedAt: string;
  entries: ScorecardEntry[];
  summary: {
    totalRuns: number;
    measuredRuns: number;
    avgValueScore: number | null;
    lastValueScore: number | null;
  };
}

export function updateScorecard(prev: Scorecard | null, entry: ScorecardEntry): Scorecard {
  const entries = [...(prev?.entries ?? []), entry];
  const measured = entries.filter((e) => e.valueScore !== null);
  const lastMeasured = measured[measured.length - 1] ?? null;

  return {
    app: entry.app,
    updatedAt: new Date().toISOString(),
    entries,
    summary: {
      totalRuns: entries.length,
      measuredRuns: measured.length,
      avgValueScore: measured.length > 0
        ? measured.reduce((s, e) => s + (e.valueScore ?? 0), 0) / measured.length
        : null,
      lastValueScore: lastMeasured?.valueScore ?? null,
    },
  };
}
