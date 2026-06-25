// Deterministic blast-radius analysis ports. VcsReadPort is the typed read side (no raw git argv
// leaks past the adapter). The 5 extractor ports are an ALL-OPTIONAL fail-open map: each returns a
// typed ExtractorSkipped on degrade, NEVER throws past the use-case. The change VOs are owned by the
// domain (static-signal.ts); ExtractorSkipped too. DiffParserService / SandboxedBinaryRunner /
// ProcessKillPort / scrubEnv are consumed FROM the kernel + shared-infrastructure, not redefined.
import type { Sha } from "@kernel/sha.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { Result } from "@kernel/result.ts";
import type {
  ChangedSymbol, RelationEdge, ComplexityHotspot, FileChangeKind, ChangePattern, ExtractorSkipped,
} from "../../domain/static-signal.ts";

export type { ExtractorSkipped };

// Typed read side over a git mirror. The adapter owns argv; callers see Sha + typed results only.
export interface VcsReadPort {
  diff(sha: Sha, opts?: { baseSha?: Sha; commits?: number }): Promise<string>;
  message(sha: Sha): Promise<string>;
  blastRadius(sha: Sha, opts?: { baseSha?: Sha; commits?: number }): Promise<BlastRadius>;
}

// What every extractor receives. Carries the analyzed change so each wrapped tool has what it needs
// (semantic-diff needs the diff + sha; the rest need files + repoDir).
export interface ExtractionContext {
  sha: Sha;
  baseSha?: Sha;
  repoDir: string;
  changedFiles: string[];
  diff: string;
}

export interface SymbolExtractorPort { extract(ctx: ExtractionContext): Promise<Result<ChangedSymbol[], ExtractorSkipped>>; }
export interface RelationExtractorPort { extract(ctx: ExtractionContext): Promise<Result<RelationEdge[], ExtractorSkipped>>; }
export interface ComplexityExtractorPort { extract(ctx: ExtractionContext): Promise<Result<ComplexityHotspot[], ExtractorSkipped>>; }
export interface SemanticDiffExtractorPort { extract(ctx: ExtractionContext): Promise<Result<FileChangeKind[], ExtractorSkipped>>; }
export interface PatternExtractorPort { extract(ctx: ExtractionContext): Promise<Result<ChangePattern[], ExtractorSkipped>>; }

// The all-optional fail-open extractor map (mirrors src/qa/static-signal/aggregate.ts StaticSignalDeps).
export interface ExtractorSet {
  symbols?: SymbolExtractorPort;
  relations?: RelationExtractorPort;
  complexity?: ComplexityExtractorPort;
  semanticDiff?: SemanticDiffExtractorPort;
  patterns?: PatternExtractorPort;
}
