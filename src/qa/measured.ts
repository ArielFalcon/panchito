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

export function recordStability(
  store: MeasuredStore,
  flowCases: Map<string, QaCase[]>,
): MeasuredStore {
  const next = { ...store };
  for (const [flow, cases] of flowCases) {
    const prev = next[flow] ?? {};
    const stability = { ...prev.stability, runs: (prev.stability?.runs ?? 0) + 1 };
    const flakyCount = cases.filter((c) => c.status === "flaky").length;
    if (flakyCount > 0) {
      stability.flakyRuns = (prev.stability?.flakyRuns ?? 0) + flakyCount;
    }
    next[flow] = { ...prev, stability };
  }
  return next;
}

export function recordCoverage(
  store: MeasuredStore,
  flowIds: string[],
  coveredFiles: string[],
): MeasuredStore {
  if (coveredFiles.length === 0) return store;
  const next = { ...store };
  for (const flow of flowIds) {
    const prev = next[flow] ?? {};
    next[flow] = { ...prev, coverage: { files: coveredFiles } };
  }
  return next;
}
