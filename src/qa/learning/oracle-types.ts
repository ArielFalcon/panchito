import type { TestTarget } from "../../types";

export interface OracleInput {
  target: TestTarget;
  repoDir: string;
  e2eDir?: string;
  namespace: string;
  ecosystem?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  changedFiles?: string[]; // code: scope mutation to the diff (not the whole repo)
  baseUrl?: string; // e2e fault-injection: the live DEV URL to re-run the suite against
  baselineCases?: string[]; // e2e fault-injection: spec names that passed at baseline (the green run)
  onProgress?: (msg: string) => void; // heartbeat during long-running oracle (Stryker output)
}

export interface ValueOracleResult {
  valueScore: number | null;
  mutantCount: number;
  killedCount: number;
  details: string;
}

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
