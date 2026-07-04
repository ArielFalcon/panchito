// qa-engine/src/shared-infrastructure/code-graph/lazy-project-code-graph.adapter.ts
//
// CodeGraph Phase 4 (design §6, deferred 4a.10, tasks 4b.6): wraps CodebaseMemoryCodeGraphAdapter's
// static `project` constructor arg with a per-call, memoized, fail-open resolution via
// ProjectNameResolver — this is what lets composition-root.ts (synchronous) wire the real
// CodeGraphPort chain WITHOUT knowing the indexed project name up front (it is only knowable by
// asking `list_projects` against the real repoDir, an inherently async, per-repoDir fact).
//
// Fail-open (ADR-4, §6, R10): a repoDir that does not resolve to any indexed project degrades every
// structural query to `ok([])` — the SAME "legitimate empty result" contract CodeGraphPort's own
// existingCoverage/impactedSymbols already use for a genuinely empty graph (§4.3's Lombok-omission
// precedent: absence is never miscast as an error). Crucially, this NEVER falls through to invoking
// the underlying adapter with `project: ""` — an empty-string project would silently query the
// CLI's own default/wrong scope rather than cleanly reporting "not indexed". `syncTo` is the one
// exception: R11 requires a whole-index failure to surface LOUDLY, so an unresolvable repoDir there
// maps to `err(IndexFailed)`, not a silent success.
import { err, ok, type Result } from "../../shared-kernel/result.ts";
import type { BlastRadius } from "../../shared-kernel/blast-radius.ts";
import type { CodeGraphPort } from "../../shared-kernel/ports/code-graph.port.ts";
import type {
  LocalSymbolRef,
  CoupledFile,
  SpecCoverage,
  CodeGraphUnavailable,
  IndexFailed,
} from "../../shared-kernel/code/index.ts";
import { CodebaseMemoryCodeGraphAdapter, type CodebaseMemoryCliClient } from "./codebase-memory-code-graph.adapter.ts";
import { ProjectNameResolver } from "./resolve-project-name.ts";

const UNRESOLVED = Symbol("unresolved-project");

export class LazyProjectCodeGraphAdapter implements CodeGraphPort {
  // One CodebaseMemoryCodeGraphAdapter instance PER resolved project name — the underlying adapter
  // is stateless besides its constructor-injected project string, so caching by name (not by
  // repoDir) lets two different repoDirs that happen to resolve to the SAME project reuse one
  // instance, while never risking a stale adapter after a resolution change (there is none — the
  // resolver itself is the single source of truth per repoDir, and this map is keyed off ITS output).
  private readonly adapters = new Map<string, CodebaseMemoryCodeGraphAdapter>();

  constructor(
    private readonly client: CodebaseMemoryCliClient,
    private readonly resolver: ProjectNameResolver,
  ) {}

  private async resolveAdapter(repoDir: string): Promise<CodebaseMemoryCodeGraphAdapter | typeof UNRESOLVED> {
    const project = await this.resolver.resolve(repoDir);
    if (project === undefined) return UNRESOLVED;
    const cached = this.adapters.get(project);
    if (cached) return cached;
    const built = new CodebaseMemoryCodeGraphAdapter(this.client, project);
    this.adapters.set(project, built);
    return built;
  }

  async impactedSymbols(
    repoDir: string,
    changed: BlastRadius,
    opts: { depth: number; minConfidence?: number },
  ): Promise<Result<LocalSymbolRef[], CodeGraphUnavailable>> {
    const adapter = await this.resolveAdapter(repoDir);
    if (adapter === UNRESOLVED) return ok([]);
    return adapter.impactedSymbols(repoDir, changed, opts);
  }

  async coChangeCoupling(repoDir: string, files: string[]): Promise<Result<CoupledFile[], CodeGraphUnavailable>> {
    const adapter = await this.resolveAdapter(repoDir);
    if (adapter === UNRESOLVED) return ok([]);
    return adapter.coChangeCoupling(repoDir, files);
  }

  async callersOf(
    repoDir: string,
    symbol: LocalSymbolRef,
    depth: number,
    opts?: { minConfidence?: number },
  ): Promise<Result<LocalSymbolRef[], CodeGraphUnavailable>> {
    const adapter = await this.resolveAdapter(repoDir);
    if (adapter === UNRESOLVED) return ok([]);
    return adapter.callersOf(repoDir, symbol, depth, opts);
  }

  async existingCoverage(repoDir: string, changed: BlastRadius): Promise<Result<SpecCoverage[], CodeGraphUnavailable>> {
    const adapter = await this.resolveAdapter(repoDir);
    if (adapter === UNRESOLVED) return ok([]);
    return adapter.existingCoverage(repoDir, changed);
  }

  async structurallyRelated(
    repoDir: string,
    symbols: LocalSymbolRef[],
    minJaccard?: number,
  ): Promise<Result<LocalSymbolRef[], CodeGraphUnavailable>> {
    const adapter = await this.resolveAdapter(repoDir);
    if (adapter === UNRESOLVED) return ok([]);
    return adapter.structurallyRelated(repoDir, symbols, minJaccard);
  }

  /** R11: a whole-index failure must surface LOUDLY, never a silent empty index — so an
   *  unresolvable repoDir maps to err(IndexFailed) HERE, distinct from the ok([])-degrade every
   *  query method above uses (a query's "not indexed" is legitimately empty; syncTo's job IS to
   *  build the index, so "cannot even identify which project to index" is a real failure). */
  async syncTo(
    repoDir: string,
    changedFiles: string[],
    opts?: { semantic?: boolean },
  ): Promise<Result<{ nodeCount: number }, IndexFailed>> {
    const adapter = await this.resolveAdapter(repoDir);
    if (adapter === UNRESOLVED) return err({ reason: `repo not indexed: ${repoDir}` });
    return adapter.syncTo(repoDir, changedFiles, opts);
  }
}
