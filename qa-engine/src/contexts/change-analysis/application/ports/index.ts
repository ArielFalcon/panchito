// qa-engine/src/contexts/change-analysis/application/ports/index.ts
// Deterministic blast-radius analysis ports. VcsReadPort is the typed read side (no raw git argv
// leaks). The 5 extractor ports are an ALL-OPTIONAL fail-open map — each returns a typed degradation
// instead of an opaque `skipped` string (Result<…, ExtractorSkipped>). DiffParserService /
// SandboxedBinaryRunner / ProcessKillPort are consumed FROM the kernel/shared-infrastructure, not
// redefined here. [SWAP] on each adapter boundary.

import type { Sha } from "@kernel/sha.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { Result } from "@kernel/result.ts";

export interface ExtractorSkipped {
  extractor: string;
  reason: string;
}

export interface VcsReadPort {
  diff(sha: Sha, opts?: { baseSha?: Sha; commits?: number }): Promise<string>;
  message(sha: Sha): Promise<string>;
  blastRadius(sha: Sha, opts?: { baseSha?: Sha; commits?: number }): Promise<BlastRadius>;
}

export interface ChangedSymbol { name: string; kind: string; file: string; }
export interface RelationEdge { from: string; to: string; }
export interface ComplexityHotspot { file: string; symbol: string; score: number; }
export interface SemanticDiffEntry { file: string; change: string; }
export interface ChangePattern { name: string; files: string[]; }

export interface SymbolExtractorPort { extract(br: BlastRadius): Promise<Result<ChangedSymbol[], ExtractorSkipped>>; }
export interface RelationExtractorPort { extract(br: BlastRadius): Promise<Result<RelationEdge[], ExtractorSkipped>>; }
export interface ComplexityExtractorPort { extract(br: BlastRadius): Promise<Result<ComplexityHotspot[], ExtractorSkipped>>; }
export interface SemanticDiffExtractorPort { extract(br: BlastRadius): Promise<Result<SemanticDiffEntry[], ExtractorSkipped>>; }
export interface PatternExtractorPort { extract(br: BlastRadius): Promise<Result<ChangePattern[], ExtractorSkipped>>; }
