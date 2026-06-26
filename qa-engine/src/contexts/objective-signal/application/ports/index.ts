// qa-engine/src/contexts/objective-signal/application/ports/index.ts
// THE TRUST KEYSTONE ports. CoverageCollectorPort [SWAP — NEW DI seam] fixes the one weak spot
// (defaultCollectCoverage hard-codes FS reads with no *Deps). ValueOraclePort [SWAP — one port, two
// adapters: Stryker mutation for code, fault-injection for e2e] replaces the pipeline.ts:564 ternary.
// SourceMapPort maps V8 byte offsets → original lines. The keystone invariant — unknown NEVER blocks
// — lives in the (Plan-6) DecideCoverageService, not in these ports.

import type { Sha } from "@kernel/sha.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";

export interface CoveredLines { file: string; lines: number[]; }
export interface CoverageReport { covered: CoveredLines[]; }
// [SWAP — NEW] per-ecosystem coverage collection (v8/c8/JaCoCo/lcov), injected (never FS-hardcoded).
export interface CoverageCollectorPort {
  collect(specDir: string, namespace: string): Promise<CoverageReport>;
}
// Aligned to legacy oracle-types.ts ValueOracleResult (4 fields): renaming score→valueScore +
// adding details prevents a silent field drop when the adapters wrap runMutationOracle /
// runFaultInjectionOracle (base-fix B.3).
export interface ValueOracleResult {
  valueScore: number | null;
  mutantCount: number;
  killedCount: number;
  details: string;
}
// [SWAP — one port, two adapters] mutation (code) vs fault-injection (e2e).
// measure(br, repoDir, namespace): namespace is per-run (sha-scoped like "qa-bot-<sha>") — it comes
// from the measure call args, NOT from the constructor; repoDir maps to OracleInput.repoDir.
// baselineCases = the e2e fault-injection oracle's green-run passing spec names (the channel the
// legacy runFaultInjectionOracle needs, without which it returns valueScore:null forever); the
// mutation/code oracle ignores it. The keystone invariant (signal-only, null never blocks) is unchanged.
export interface ValueOraclePort {
  measure(br: BlastRadius, repoDir: string, namespace: string, baselineCases?: string[]): Promise<ValueOracleResult>;
}
export interface SourceMapPort {
  toOriginalLine(file: string, byteOffset: number): Promise<{ file: string; line: number } | null>;
}
// Used by the decide step (Plan 6); declared here as the read-model shape the collector feeds.
export interface ChangeCoverageInput { sha: Sha; changedLines: number; coveredLines: number; }
