// Deterministic persistence of measured/derived manifest fields (coverage,
// stability, ledger) — the "learning" keystone that closes the value loop.
// Lives OUTSIDE the commited manifest (e2e/.qa/measured.json, gitignored) so
// writes do NOT trigger PR-spam ("nothing changed in e2e/" is preserved).
// Keyed by manifest entry id (flow name), same as upsertManifest.
//
// Caller: pipeline.ts after execute/coverage. Pure functions with injected fs
// so the orchestration is unit-testable with stubs.

import { QaCase } from "../types";

export interface MeasuredEntry {
  coverage?: { files: string[] };
  stability?: { runs: number; flakyRuns?: number };
}

export type MeasuredStore = Record<string, MeasuredEntry>;

export interface MeasuredFs {
  read(path: string): string | null;
  write(path: string, content: string): void;
}

export function readMeasured(fs: MeasuredFs, path: string): MeasuredStore {
  const raw = fs.read(path);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as MeasuredStore;
    }
  } catch { /* corrupt → start fresh */ }
  return {};
}

export function writeMeasured(fs: MeasuredFs, path: string, store: MeasuredStore): void {
  fs.write(path, JSON.stringify(store, null, 2));
}

// Measured data is recorded at SUITE scope (one entry), NOT per-flow. Honest per-flow
// attribution would require per-test coverage AND a case→flow map — neither exists today —
// so crediting aggregate coverage/flaky data to every flow id was misleading. Suite-level is
// truthful: "this suite ran N times, was flaky in M of them, last covered these files."
export const SUITE_KEY = "__suite";

export function recordStability(store: MeasuredStore, cases: QaCase[]): MeasuredStore {
  const prev = store[SUITE_KEY] ?? {};
  const wasFlaky = cases.some((c) => c.status === "flaky");
  const flakyRuns = (prev.stability?.flakyRuns ?? 0) + (wasFlaky ? 1 : 0);
  const stability: { runs: number; flakyRuns?: number } = { runs: (prev.stability?.runs ?? 0) + 1 };
  if (flakyRuns > 0) stability.flakyRuns = flakyRuns;
  return { ...store, [SUITE_KEY]: { ...prev, stability } };
}

export function recordCoverage(store: MeasuredStore, coveredFiles: string[]): MeasuredStore {
  if (coveredFiles.length === 0) return store;
  const prev = store[SUITE_KEY] ?? {};
  return { ...store, [SUITE_KEY]: { ...prev, coverage: { files: coveredFiles } } };
}
