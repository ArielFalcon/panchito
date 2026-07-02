// qa-engine/src/shared-infrastructure/code-graph/stub-code-graph.adapter.ts
// Phase 1 inert stub for CodeGraphPort. Every method returns an ok(...) Result with an empty/zero
// shape — NEVER throws, NEVER random, ignores all arguments. Behavior is unchanged: no live consumer,
// no composition-root wiring (same precedent as StubMirrorRegistryAdapter). Placement mirrors
// ProcessKillAdapter: a shared-kernel port with no single owning context has its concrete
// implementation in shared-infrastructure/, not in the kernel and not in one context (see design §2).
// The real CodebaseMemoryGraphAdapter (backed by the codebase-memory MCP) is Phase 2/3 and will live
// in the consuming context's infrastructure/, not here.
import { ok, type Result } from "../../shared-kernel/result.ts";
import type { BlastRadius } from "../../shared-kernel/blast-radius.ts";
import type { CodeGraphPort } from "../../shared-kernel/ports/code-graph.port.ts";
import type {
  LocalSymbolRef,
  CoupledFile,
  SpecCoverage,
  CodeGraphUnavailable,
  IndexFailed,
} from "../../shared-kernel/code/index.ts";

export class StubCodeGraphAdapter implements CodeGraphPort {
  /** Inert: reports a zero-node index without touching disk or the graph. */
  async syncTo(
    _repoDir: string,
    _changedFiles: string[],
    _opts?: { semantic?: boolean },
  ): Promise<Result<{ nodeCount: number }, IndexFailed>> {
    return ok({ nodeCount: 0 });
  }

  /** Inert: no impacted symbols. */
  async impactedSymbols(
    _repoDir: string,
    _changed: BlastRadius,
    _opts: { depth: number; minConfidence?: number },
  ): Promise<Result<LocalSymbolRef[], CodeGraphUnavailable>> {
    return ok([]);
  }

  /** Inert: no co-change coupling. */
  async coChangeCoupling(
    _repoDir: string,
    _files: string[],
  ): Promise<Result<CoupledFile[], CodeGraphUnavailable>> {
    return ok([]);
  }

  /** Inert: no callers. */
  async callersOf(
    _repoDir: string,
    _symbol: LocalSymbolRef,
    _depth: number,
    _opts?: { minConfidence?: number },
  ): Promise<Result<LocalSymbolRef[], CodeGraphUnavailable>> {
    return ok([]);
  }

  /** Inert: no existing coverage. Empty here is a valid "no signal", not an error. */
  async existingCoverage(
    _repoDir: string,
    _changed: BlastRadius,
  ): Promise<Result<SpecCoverage[], CodeGraphUnavailable>> {
    return ok([]);
  }

  /** Inert: no structurally-related symbols. */
  async structurallyRelated(
    _repoDir: string,
    _symbols: LocalSymbolRef[],
    _minJaccard?: number,
  ): Promise<Result<LocalSymbolRef[], CodeGraphUnavailable>> {
    return ok([]);
  }
}
