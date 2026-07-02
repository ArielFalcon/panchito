// qa-engine/src/shared-kernel/code/index.ts
// Intra-repo structural VOs spoken by CodeGraphPort (§6.1). Flat, invariant-free plain interfaces —
// they follow the service-topology/domain/index.ts precedent (grouped flat interfaces, one index.ts),
// NOT the BlastRadius/Sha class-VO pattern (no invariant → no private ctor / .of()).
// LocalSymbolRef is intra-repo and is intentionally DISTINCT from service-topology's ServiceSymbolRef
// (cross-repo, carries a repo identity). Never name a transport or a watched-app literal here.

/** An intra-repo symbol: a repo-relative file path plus the symbol name within it. */
export interface LocalSymbolRef {
  file: string;   // repo-relative file path
  symbol: string; // function/class/method name within the file
}

/** A file that historically co-changes with a queried file (git-history co-change coupling). */
export interface CoupledFile {
  file: string;            // repo-relative file path of the coupled file
  couplingScore: number;   // [0, 1] normalized co-change strength
  coChanges: number;       // raw count of commits in which both files changed
  lastCoChange?: string;   // ISO-8601 timestamp of the most recent co-change (optional)
}

/** Existing spec/test coverage referencing a changed symbol. coveredSymbol is optional: a spec may be
 *  known to cover the change without the graph resolving the exact intra-repo symbol it hit. */
export interface SpecCoverage {
  specFile: string;            // repo-relative path of the spec/test file
  testName: string;            // the test/spec name within the file
  coveredSymbol?: LocalSymbolRef; // the symbol it covers, when the graph can resolve it
}

/** Typed failure: the graph is unavailable for a QUERY (not indexed, MCP unreachable). Query methods
 *  fail-open — a consumer treats this as "no structural signal", never as a hard error. */
export interface CodeGraphUnavailable {
  reason: string;
}

/** Typed failure: syncTo could not build the WHOLE index (empty index / crashed indexer). NEVER used
 *  for per-file absence — that surfaces later as ExtractorSkipped at extract() time (change-analysis). */
export interface IndexFailed {
  reason: string;
}
