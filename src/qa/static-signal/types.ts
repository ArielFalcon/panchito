import type { LanguageId } from "./languages";
export interface ChangedSymbol { file: string; name: string; kind: string; signature: string; line: number; }
export interface RelationEdge { from: string; to: string; via: string; }
export interface ComplexityHotspot { file: string; function: string; ccn: number; nloc: number; line: number; }
export interface FileChangeKind { file: string; cosmetic: boolean; }
export interface ChangePattern { file: string; pattern: string; source: "ast-grep" | "regex"; }
export interface StaticSignal {
  builtForSha: string;
  languages: LanguageId[];
  symbols: ChangedSymbol[];
  relations: RelationEdge[];
  complexity: ComplexityHotspot[];
  fileChangeKinds: FileChangeKind[];
  patterns: ChangePattern[];
  skipped: string[];
}
export const EMPTY_STATIC_SIGNAL = (sha: string): StaticSignal => ({
  builtForSha: sha, languages: [], symbols: [], relations: [], complexity: [], fileChangeKinds: [], patterns: [], skipped: [],
});
