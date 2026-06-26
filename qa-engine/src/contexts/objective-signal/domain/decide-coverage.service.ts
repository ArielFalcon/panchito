// src/contexts/objective-signal/domain/decide-coverage.service.ts
// THE KEYSTONE GATE. decide() and blocks() are carried VERBATIM from src/qa/change-coverage.ts
// (decideCoverage / blocksPublish). Do NOT "improve" the logic — a reimplementation that
// starts blocking on `unknown` would freeze every cross-repo and unmeasured run (risk R2). The
// parity test pins these to the legacy originals until Plan 7 deletes them.
export type CoverageStatus = "pass" | "fail" | "unknown";
export type CoverageMode = "off" | "signal" | "enforce";
export interface CoveragePolicy { mode: CoverageMode; minRatio: number; }

// ChangeCoverage read-model shape carried from change-coverage.ts (only the fields decide() reads
// are required here; the full per-file/uncovered/branches fields are kept for the report).
export interface ChangeCoverage {
  measured: boolean;
  overall: { changedLines: number; coveredChanged: number; ratio: number };
  perFile: { file: string; changed: number; covered: number; ratio: number }[];
  uncovered: { file: string; lines: number[] }[];
  branches: { changedBranches: number; takenBranches: number; ratio: number } | null;
}

export class DecideCoverageService {
  // VERBATIM from change-coverage.ts decideCoverage. Unmeasured/zero-changed → "unknown".
  decide(cc: ChangeCoverage | null, policy: CoveragePolicy): CoverageStatus {
    if (!cc || !cc.measured || cc.overall.changedLines === 0) return "unknown";
    return cc.overall.ratio >= policy.minRatio ? "pass" : "fail";
  }

  // VERBATIM from change-coverage.ts blocksPublish. Only "enforce" + "fail" blocks.
  blocks(status: CoverageStatus, policy: CoveragePolicy): boolean {
    return policy.mode === "enforce" && status === "fail";
  }
}
