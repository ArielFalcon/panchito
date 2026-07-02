// qa-engine/src/shared-kernel/ports/code-graph.port.ts
// Kernel-resident structural-knowledge seam for the codebase-memory graph integration
// (docs/superpowers/qa-engine-codebase-memory-integration.md §6.1). Advisory-only BY CONSTRUCTION:
// every confidence-bearing query defaults to the 0.55 advisory floor and NEVER gates a PR — the graph
// is a generation-guidance COMPLEMENT to the objective runtime change-coverage signal, never a
// replacement. Raising toward the 0.85 blocking floor is Phase 7 calibration, not this phase.
// Phase 1 lands the CONTRACT ONLY: no live consumer, no composition-root wiring, no real graph call.
// Two-failure-mode contract (encoded here for later phases; no runtime implements it yet):
//   - syncTo returns IndexFailed ONLY for whole-index failure (empty index / crashed indexer).
//   - Per-file absence is NEVER an IndexFailed — it surfaces later at extract() time as ExtractorSkipped
//     (owned by change-analysis/domain, out of this phase's file set). This is "surface errors loudly"
//     expressed at the type level for a phase with no runtime.
import type { Result } from "@kernel/result.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";
import type {
  LocalSymbolRef,
  CoupledFile,
  SpecCoverage,
  CodeGraphUnavailable,
  IndexFailed,
} from "@kernel/code/index.ts";

export interface CodeGraphPort {
  /** Index/refresh the graph for repoDir over changedFiles. opts.semantic requests embedding-backed
   *  edges. Returns node count on success; IndexFailed ONLY on whole-index failure (never per-file). */
  syncTo(
    repoDir: string,
    changedFiles: string[],
    opts?: { semantic?: boolean },
  ): Promise<Result<{ nodeCount: number }, IndexFailed>>;

  /** Symbols structurally impacted by the changed set, up to opts.depth hops. depth is REQUIRED and
   *  lives in opts; minConfidence defaults to the 0.55 advisory floor (advisory use-case: depth=3). */
  impactedSymbols(
    repoDir: string,
    changed: BlastRadius,
    opts: { depth: number; minConfidence?: number },
  ): Promise<Result<LocalSymbolRef[], CodeGraphUnavailable>>;

  /** Files that historically co-change with the given files (git-history co-change coupling). */
  coChangeCoupling(
    repoDir: string,
    files: string[],
  ): Promise<Result<CoupledFile[], CodeGraphUnavailable>>;

  /** Callers of a symbol up to `depth` hops. depth is POSITIONAL (intentional asymmetry vs
   *  impactedSymbols.opts.depth), required, no default; minConfidence defaults to the 0.55 floor. */
  callersOf(
    repoDir: string,
    symbol: LocalSymbolRef,
    depth: number,
    opts?: { minConfidence?: number },
  ): Promise<Result<LocalSymbolRef[], CodeGraphUnavailable>>;

  /** Existing spec/test coverage that references the changed symbols. An EMPTY result is NOT an error
   *  or a warning (repos with no unit tests / e2e specs that generate 0 TESTS edges) — a future
   *  consumer MUST NOT render empty as "no coverage". */
  existingCoverage(
    repoDir: string,
    changed: BlastRadius,
  ): Promise<Result<SpecCoverage[], CodeGraphUnavailable>>;

  /** Symbols structurally related by shared-neighbor similarity (Jaccard). minJaccard is an optional
   *  similarity floor. */
  structurallyRelated(
    repoDir: string,
    symbols: LocalSymbolRef[],
    minJaccard?: number,
  ): Promise<Result<LocalSymbolRef[], CodeGraphUnavailable>>;
}
