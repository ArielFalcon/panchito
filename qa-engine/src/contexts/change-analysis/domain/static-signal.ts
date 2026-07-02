import type { Sha } from "@kernel/sha.ts";
import type { LanguageId } from "./language-id.ts";

// Change VOs (carried from src/qa/static-signal/types.ts; tightened from the loose Plan-2 stubs).
export interface ChangedSymbol { file: string; name: string; kind: string; signature: string; line: number; }
export interface RelationEdge { from: string; to: string; via: string; }
// cognitive is OPTIONAL (ADR-5): a graph-only value-add lizard cannot produce. Additive and
// backward-compatible — LizardComplexityAdapter leaves it undefined; every existing consumer
// (emptyStaticSignal, the StaticSignal read-model, render.ts's future port) is unaffected.
export interface ComplexityHotspot { file: string; function: string; ccn: number; cognitive?: number; nloc: number; line: number; }
export interface FileChangeKind { file: string; cosmetic: boolean; }
export interface ChangePattern { file: string; pattern: string; source: "ast-grep" | "regex"; }

// Typed degradation event: replaces the legacy opaque `skipped: string[]`. A consumer can route by
// `extractor` without substring-matching a prose message. Signal-only: a skip never blocks publish.
export interface ExtractorSkipped { extractor: string; reason: string; }

// Sha-keyed READ-MODEL (no guarded state transitions — demoted from aggregate per §5.3(2)).
export interface StaticSignal {
  builtForSha: string;
  languages: LanguageId[];
  symbols: ChangedSymbol[];
  relations: RelationEdge[];
  complexity: ComplexityHotspot[];
  fileChangeKinds: FileChangeKind[];
  patterns: ChangePattern[];
  skipped: ExtractorSkipped[];
}

export function emptyStaticSignal(sha: Sha): StaticSignal {
  return {
    builtForSha: sha.value, languages: [], symbols: [], relations: [],
    complexity: [], fileChangeKinds: [], patterns: [], skipped: [],
  };
}
