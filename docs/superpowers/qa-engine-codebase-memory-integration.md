# Codebase-Memory Integration — design (qa-engine, hexagonal/DDD)

From a hands-on evaluation (2026-06-27) of `DeusData/codebase-memory-mcp` run against the real
indexed `nname` system (Angular `name-webapp` + 4 Spring microservices) and the `ai-pipeline` repo
itself. This document specifies how the tool plugs into the NEW `qa-engine/` architecture, what it
replaces, and how the existing analysis tools (tree-sitter, lizard, difftastic, ast-grep, Serena)
are adapted. The legacy `src/` is the cutover source and is out of scope except where `qa-engine/`
currently bridges to it.

All claims below are measured, not inferred from the tool's docs. The doc's numbers come from
querying the live graph and timing the CLI (`~/.local/bin/codebase-memory-mcp`, v0.8.1).

---

## 1. TL;DR / decision

- **Adopt the tool as the intra-repo *structural substrate*, behind a new `CodeGraphPort`.** It is
  excellent at per-repo structure (symbols, calls, imports, complexity, co-change, test coverage, and
  structural similarity) and indexes incrementally in sub-second time. It **targets retiring** our own
  tree-sitter extractors and `lizard` — but both are kept as required fallback adapters behind their
  ports until parity tests (including parse-failure degradation cases) are green (≥2 release cycles).
- **Do NOT use the tool for cross-repo / FE↔BE links.** Measured: **0 cross-repo edges** across the
  whole 5-repo system. Service boundaries get a **new, product-agnostic `ServiceBoundaryResolverPort`**
  that we own, with per-transport strategies (OpenAPI today; gRPC / events later) selected by config.
- **Keep Serena** as the precision LSP layer, **agent-side only** (MCP in the agent container,
  `agents/opencode.json` — not callable from the orchestrator). The graph's TS call resolution is
  only ~7.8–15–18% LSP (point-in-time measurement; re-measure against a current index — the index
  re-runs per commit); Serena supplies the precision the graph approximates from within the agent session.
- **Keep `difftastic`** (cosmetic-vs-semantic). **Promote `ast-grep`** to the extraction engine of the
  boundary resolver. **tree-sitter and lizard are parity-gated**, not immediately dropped (see §7, §10).
- Net: **2 new ports + 1 new bounded context + 2 new VOs** (`LocalSymbolRef`, `CrossRepoImpact`),
  reusing patterns `qa-engine` already has (optional-port composition, composite per-ecosystem
  strategy, port→SQLite adapter, stub adapters, constructor DI). No architectural novelty required.

---

## 2. What the tool is

A single static binary (C/C++, MIT, v0.8.1, **100% local** — code never leaves the machine) that
builds a **persistent SQLite knowledge graph** per repository and exposes 14 MCP tools (also a CLI:
`codebase-memory-mcp cli <tool> <json>`).

What it provides, confirmed on our code:

| Capability | Evidence on our repos |
|---|---|
| Structural graph (Function/Method/Class/Interface/Route/Channel nodes; CALLS/IMPORTS/HTTP_CALLS/… edges) | ai-pipeline: 7078 nodes / 21533 edges |
| Complexity per node | `complexity` (cyclomatic) + `cognitive` + `transitive_loop_depth` + `linear_scan_in_loop`; `runPipeline` correctly ranked #1 at cyclomatic 226 / cognitive 563 |
| Co-change coupling | `FILE_CHANGES_WITH{coupling_score, co_changes}` from git history (e.g. `agent-activity.ts`↔`opencode-client.ts` = 0.73 / 8 co-changes) |
| Transitive call graph + impact | `trace_path` (calls/data_flow), `detect_changes` (diff → impacted symbols) |
| **Test coverage edges (TESTS / TESTS_FILE) — ai-pipeline-internal** | **375 `TESTS` + 123 `TESTS_FILE` edges in ai-pipeline's own unit suite.** Measured: `name-webapp` has 0 TESTS / 248 TESTS_FILE edges; the 4 Spring microservices have 0/0. Playwright e2e specs generate NO TESTS edges (URL/DOM navigation, no static symbol imports). `existingCoverage` returns empty when the target repo has no unit tests (e.g. the 4 Spring microservices: 0/0); returns file-level results for repos that carry unit tests (e.g. name-webapp: 248 TESTS_FILE) even in e2e mode (see §6.1). |
| Structural similarity | `SIMILAR_TO` (125 edges, Jaccard) — duplicate-pattern candidates; advisory signal for the generator (§6.1) |
| Error-flow signal | `RAISES` (90 edges) — maps throw sites to exception types; negative-test candidates for the generator (advisory). **Caveat:** 88/90 in ai-pipeline point to a single Go `Error` node (2 go to non-Go error types); Java Spring apps have real typed exceptions. Validate per watched app — reliable for Java, potentially degenerate in TS; advisory only. |
| Structural linkage — ai-pipeline-internal | `CONFIGURES` (105 edges) — links constant identifiers to the files that reference them (structural, ai-pipeline-internal; **0 CONFIGURES edges in `name-webapp` and all 4 Spring services**). Not an env-dependency or test-setup signal in watched apps; advisory signal within ai-pipeline only. **[Deferred — not yet wired; no phase assigned; ai-pipeline-internal only — tracked as future implementation note]** |
| Data-flow / write-side-effect signal | `WRITES` (478 edges) — maps functions to the variables they write; larger than FILE_CHANGES_WITH/SIMILAR_TO/TESTS_FILE/RAISES/CONFIGURES combined. Advisory signal for negative-test and side-effect awareness in the generator. **[Deferred — not yet wired; no phase assigned — tracked as future implementation note]** |
| Class hierarchy | `INHERITS` (56 edges) — class inheritance; relevant for Java OOP blast radius (a changed parent method affects subclass-type callers). The adapter should traverse `INHERITS` when expanding `impactedSymbols` for Java repos. |
| Event-flow edges | `EMITS` / `LISTENS_ON` — event-flow (3/2 edges in ai-pipeline, EventEmitter-based; 0 in watched repos). **[Deferred — conceptual foundation only. EventEmitter detection is structurally unlike NATS/Kafka topics; an `EventTopicResolver` must be built from scratch against a NATS-instrumented repo. Not yet wired; no phase assigned — tracked as future implementation note]** |
| Semantic search | local embeddings (`SEMANTICALLY_RELATED` edges, `search_graph(semantic_query)`) — the vector store the legacy lacked |
| Incremental indexing | content-hash; re-parses only changed files |

> **Point-in-time caveat:** all per-edge-type counts in this table (375 TESTS, 125 SIMILAR_TO, 478 WRITES, 105 CONFIGURES, etc.) come from `get_graph_schema` / `search_graph` at a single evaluation snapshot (2026-06-27). The index re-runs on every commit; counts drift as the codebase evolves. Treat all figures as approximate, not exact.

Multi-language: tree-sitter (158 langs) + hybrid LSP (9 langs incl. TS/JS/Java/Python/Go). Our
`ai-pipeline` index alone spans TypeScript + a Go TUI client.

## 3. Measured limits (and how the design absorbs them)

| Limit | Measurement | How the design handles it |
|---|---|---|
| Call resolution is mostly **heuristic**, not LSP-grade | TS-only: ~7.8% LSP on `name-webapp`, ~15–18% at evaluation time on `ai-pipeline` (re-measure against a current index before calibrating the floor — these are point-in-time snapshots; the index re-runs per commit); Java: ~14% LSP, ~86% heuristic. Note: earlier drafts stated ~18% TS LSP — that figure mixed Go calls into the denominator. The LOWER TS precision strengthens (not weakens) the case for keeping Serena as the precision layer. | Use the graph for **breadth** (advisory `signal`); gate blocking decisions at `confidence >= 0.85`. **Two separate thresholds:** advisory/`signal` threshold (~0.55, broad blast radius for generator guidance); blocking/`enforce` threshold (0.85+, PR-gating only). Phase 4 collects calibration data; Phase 7 is the enforce gate. Keep 0.85 blocking-only until Phase 7. |
| Confidence coverage is narrow at 0.85 | ~62% of CALL edges (3583/5799 — `ai-pipeline` repo, point-in-time 2026-06-27; re-measure per run) fall below 0.85. False-negatives (a hollow blast radius → missed regressions) are a distinct anti-Goodhart risk from false-positives. | **Never use 0.85 as the only threshold.** Feed low-confidence edges into `signal` mode advisory (rendered into `staticSignal`, never `enforce`). Phase 4 collects calibration data; Phase 7 is the enforce gate (sets the thresholds and formally enables `enforce` mode). |
| webapp re-parse accuracy | 99/290 calls unresolved on `name-webapp` (point-in-time; re-verify) | Serena (LSP, agent-side) escalates for low-confidence / polymorphic cases; LSP coverage varies by project and Angular template structure (§7) |
| **Cross-repo = 0** on a real stack | `cross-repo-intelligence` from all 5 repos → `total_cross_edges: 0`. Each project's schema was inspected independently (the tool has no cross-project query surface); the 0-edge result is confirmed per-project. Spring `Route` nodes have `path=""` and ignore the in-repo OpenAPI; Angular egress through `rest-client.service.ts` is not followed; NATS channels not detected at all (`MATCH (n:Channel)` → 0). | Do not use the tool for boundaries. `ServiceBoundaryResolverPort` owns it (§6.2), OpenAPI-anchored |
| No SHA on the index | `index_status` returns `{nodes, edges, status}` only — no indexed SHA/timestamp | `CodeGraphPort.syncTo()` always runs after checkout; freshness is by on-disk content hash, not git (§6.5) |
| Cypher dialect quirks | `ORDER BY` does not cast numeric props (use `toInteger`); no `STARTS WITH`/`CONTAINS` (use `=~`); large outputs (`detect_changes` = 268 KB) | Encapsulated inside the adapter as fixed, tested queries that map to domain VOs and scope output |
| Maturity v0.8.1 | pre-1.0 | The port protects the domain; a `StubCodeGraph` and the existing tree-sitter path remain available as fallback adapters behind the same port |

**Freshness is cheap** (this was wrongly flagged as the top risk earlier): indexing is incremental by
content hash. Measured via CLI: no-change re-index of a medium repo = **~20 ms**; a large repo
(`name-webapp`, 6895 nodes) with 11 changed files in `moderate` mode (with semantic) = **~0.7 s**.
Cost is proportional to the diff, not the repo size. Re-indexing on every run is viable.

---

## 4. Design principles

1. **The tool is infrastructure.** It lives only in `infrastructure/adapters/`, behind ports. No
   domain or application code names `codebase-memory`, SQLite, or Cypher.
2. **Two capabilities → two ports.** It is great intra-repo and null cross-repo, so structure and
   boundaries are separate ports with separate fates.
3. **Product-agnostic core.** The domain never knows about OpenAPI/gRPC/NATS. Transport technologies
   are strategies (adapters) selected by `config/` — honoring the invariant *"app-specificity lives
   only in config/; nothing app-specific in the engine core."*
4. **Determinism over zeal.** Graph edges (calls/imports) drive blocking decisions only above a
   confidence floor; heuristic/low-confidence signal is advisory, mirroring the existing
   `signal | enforce` policy of change-coverage.
5. **Fallback by port.** Every new port ships a stub and tolerates an alternate adapter, so v0.8.1
   maturity never blocks the engine.

---

## 5. The seams in qa-engine (verified)

| Seam | Location | Role |
|---|---|---|
| 5 extractor ports + `ExtractorSet` + `ExtractionContext` | `change-analysis/application/ports/index.ts` | Where structural extraction is injected |
| `analyzeChange(ctx, extractors)` | `change-analysis/application/analyze-change.use-case.ts` | Fan-out + fail-open use case |
| `BlastRadius`, `DiffParserService`, `Result` | `shared-kernel/` | Domain model of change |
| `StaticSignal` | `change-analysis/domain/static-signal.ts` | Analysis output VO — change-analysis domain, NOT shared-kernel |
| `OpencodeRunInput.staticSignal?` / `.contextMap?` / `.contextBrief?` | `generation/application/ports/generation-ports.ts` | Injection point of code knowledge into the prompt |
| `LearningRepositoryPort` + `SqliteLearningRepository` | `cross-run-learning/` | Reference **port→SQLite-adapter** pattern (graph is also SQLite) |
| `CoverageCollectorPort` composite | `objective-signal/` | Reference **composite per-ecosystem strategy** pattern |
| `ServiceConfig.openapi?` | `app-catalog/application/ports/index.ts` | Only existing per-project capability hint |
| `ArchitectureContext` / `FeBeLink` | `generation-ports.ts` (data types only) | FE↔BE map — **no port builds it today**; injected by the orchestrator from legacy |

---

## 6. Integration architecture

### 6.1 `CodeGraphPort` — structural substrate (new)

The tool backs the structural layer. Two moves:

**(a) Re-back the existing extractor ports.** A single `CodebaseMemoryGraphAdapter` implements
`SymbolExtractorPort`, `RelationExtractorPort`, and `ComplexityExtractorPort` by *querying the graph*
for the changed files instead of re-parsing them. The adapter MUST filter graph results to
`changedFiles` using the graph's `file_path` property (already repo-relative, slash-separated) —
do NOT normalize `qualified_name`, which is fragile and lossy (dots appear in `.spec.ts` file names).
Filter: `graphNode.file_path` must match an entry in `ExtractionContext.changedFiles`. Two distinct
failure modes (NOT silent empty arrays — honoring "surface errors loudly"): `syncTo` returns
`IndexFailed` ONLY for a whole-index failure (empty index or crashed indexer); when `syncTo` succeeds
but a specific file is absent from the index, the subsequent `extract()` call for that file returns
`ExtractorSkipped` (per-file parse failure — never a silent empty array; never an `IndexFailed`). A
post-`syncTo` health check verifies that every file in `changedFiles` exists as a graph node — absent
files are surfaced at `extract()` time via `ExtractorSkipped`, not at `syncTo` time via `IndexFailed`. `SemanticDiffExtractorPort`
(difftastic) and `PatternExtractorPort` (ast-grep) keep their adapters (§7). **tree-sitter and
lizard are NOT retired until Phase 3 parity tests, including parse-failure cases, are green (§10);
they remain as required fallback adapters behind the same ports for ≥2 release cycles after the
graph proves stable.**

**(b) Add a `CodeGraphPort`** for what the delta-scoped extractor ports cannot express — transitive
impact, co-change, existing test coverage, semantic neighbours, and structural similarity — plus
freshness. `CodeGraphPort` spans both change-analysis (extractor re-backing, `syncTo`) and
generation (`existingCoverage`, `structurallyRelated`); it is a **shared-kernel port** at
`shared-kernel/ports/code-graph.port.ts`, imported via `@kernel/ports/...`, matching the existing
cross-context port pattern (`agent-runtime.port.ts`, `clock.port.ts`). If a future design requires
stricter context isolation, split it into `CodeStructurePort` (change-analysis) and
`CodeKnowledgePort` (generation) — but do not split prematurely; document the choice explicitly
when made. **`LocalSymbolRef`** is the intra-repo ref type used throughout this port (see §8 for
the `LocalSymbolRef` / `ServiceSymbolRef` split):

```ts
// shared-kernel/code/ — cross-context value objects
/** Intra-repo symbol reference. Used in CodeGraphPort, SymbolResolverPort, and all change-analysis ports. */
export interface LocalSymbolRef { file: string; symbol: string; }

/** Co-change coupling between files (from FILE_CHANGES_WITH edge properties in the graph). */
export interface CoupledFile {
  file: string;
  couplingScore: number;   // Jaccard-like co-occurrence score
  coChanges: number;       // number of commits where both files changed together
  lastCoChange?: string;   // ISO date of the most recent co-change commit
}

/** Returned by fallible CodeGraphPort methods when the graph is unavailable or errored. */
export interface CodeGraphUnavailable { reason: string; }

/** Whole-index failure from syncTo (empty index or crashed indexer). NOT used for per-file absence — that surfaces as ExtractorSkipped from extract(). */
export interface IndexFailed { reason: string; }

// Result<T,E>, ok(), err(), isOk(), unwrapOr() are imported from @kernel/result.ts — NOT redefined here.
// import type { Result } from "@kernel/result.ts";
// import { ok, err, isOk, unwrapOr } from "@kernel/result.ts";

/** Per-spec coverage annotation: which existing spec already covers a changed symbol.
 *  Two result kinds:
 *  - TESTS edge (symbol-level): specFile + testName + coveredSymbol (all set)
 *  - TESTS_FILE edge (file-level): specFile + testName + coveredSymbol undefined.
 *    File-level is the dominant kind in TS watched apps (name-webapp: 248 TESTS_FILE / 0 TESTS).
 */
export interface SpecCoverage {
  specFile: string;          // e.g. "e2e/flows/checkout.spec.ts"
  testName: string;          // the test function that covers it
  coveredSymbol?: LocalSymbolRef;  // set for TESTS (symbol-level); absent for TESTS_FILE (file-level)
}

// shared-kernel/ports/code-graph.port.ts — cross-context port (import via @kernel/ports/...)
// Placement rationale: generation/ only imports from @kernel/*; placing this under
// change-analysis/application/ports/ would break the compile-enforced isolation.
// Matches the existing cross-context port pattern (agent-runtime.port.ts, clock.port.ts).
export interface CodeGraphPort {
  /** Ensure the graph reflects the working copy at its current (checked-out) state. Cheap/incremental.
   *  Returns IndexFailed ONLY for a whole-index failure: the resulting index is empty or crashed.
   *  Per-file absence is NOT an IndexFailed — when syncTo succeeds but a specific changedFile is
   *  absent from the index, the subsequent extract() call for that file returns ExtractorSkipped.
   *  Post-syncTo health check: verify all changedFiles exist as nodes (not just nodeCount > 0); any
   *  absent file is surfaced via ExtractorSkipped at extract() time, not as an IndexFailed here. */
  syncTo(
    repoDir: string,
    changedFiles: string[],
    opts?: { semantic?: boolean },
  ): Promise<Result<{ nodeCount: number }, IndexFailed>>;

  /** Transitive blast radius from the changed files, confidence-filtered.
   *  Advisory path (default): call with minConfidence ~0.55 — broad blast radius for generator guidance.
   *  Blocking path: call with minConfidence 0.85 — ONLY after Phase 7 calibration proves precision/recall.
   *  Do NOT raise the default to 0.85; that is the blocking floor, not the advisory floor.
   *  `depth` has NO default — the caller must choose; advisory use-case: depth = 3. */
  impactedSymbols(
    repoDir: string,
    changed: BlastRadius,
    opts: { depth: number; minConfidence?: number },  // minConfidence defaults to 0.55 (advisory floor); depth is required — no default
  ): Promise<Result<LocalSymbolRef[], CodeGraphUnavailable>>;

  /** Files that historically change together (git co-change coupling). */
  coChangeCoupling(
    repoDir: string,
    files: string[],
  ): Promise<Result<CoupledFile[], CodeGraphUnavailable>>;

  /** Callers of a symbol, confidence-filtered. Same discipline as impactedSymbols.
   *  `depth` is positional (not in opts) — intentional asymmetry vs impactedSymbols.opts.depth,
   *  as callers tend to be invoked with a single depth value and no other structural options. */
  callersOf(
    repoDir: string,
    symbol: LocalSymbolRef,
    depth: number,       // required; no default — caller chooses (e.g. 3 for advisory)
    opts?: { minConfidence?: number },  // defaults to 0.55 (advisory floor); do NOT raise to 0.85 until Phase 7
  ): Promise<Result<LocalSymbolRef[], CodeGraphUnavailable>>;

  /** Which existing specs (TESTS / TESTS_FILE edges) already cover changed symbols.
   *  STATIC complement to the runtime change-coverage keystone — narrows generation to gaps,
   *  not covered code. Never replaces runtime coverage enforcement.
   *  SCOPE: returns empty when the target repo has no unit tests of its own (e.g. the 4 Spring
   *  microservices: 0/0); returns file-level results for repos that DO carry unit tests (e.g.
   *  name-webapp: 248 TESTS_FILE) even in e2e mode. Playwright e2e specs themselves generate
   *  0 TESTS edges (URL/DOM navigation, no static symbol imports) — do NOT render an empty
   *  result as a "no coverage" warning in e2e mode; silence is not an error. */
  existingCoverage(
    repoDir: string,
    changed: BlastRadius,
  ): Promise<Result<SpecCoverage[], CodeGraphUnavailable>>;

  /** Advisory: structurally similar symbols (SIMILAR_TO edges, Jaccard) — duplicate-pattern
   *  candidates. The generator can parameterize one test instead of duplicating. */
  structurallyRelated(
    repoDir: string,
    symbols: LocalSymbolRef[],
    minJaccard?: number,
  ): Promise<Result<LocalSymbolRef[], CodeGraphUnavailable>>;
}
```

The adapter follows the `SqliteLearningRepository` pattern exactly: a local `KnowledgeGraphStore`
interface (the raw MCP/CLI surface — `query_graph`, `trace_path`, `index_repository`, …) is injected
in the constructor; the adapter maps rows to domain VOs and never embeds Cypher quirks in the domain.
A `StubCodeGraph` (no-op / empty results) is the v1 wiring and the test double.

> **Confidence discipline:** `impactedSymbols` and `callersOf` both accept `minConfidence` (default
> `0.55`, advisory floor). At the blocking floor of 0.85, ~62% of edges (3583/5799 measured) are
> excluded — do NOT use 0.85 as the default; it would starve the blast radius before calibration.
> The advisory floor (0.55) feeds the generator's signal blast radius rendered into `staticSignal`;
> it never gates a PR. The blocking floor (0.85) may only be used after Phase 7 calibration proves
> precision/recall. This is the `signal|enforce` discipline applied to the call graph.

> **TESTS edges — static vs. runtime, e2e scoping:** `existingCoverage` queries `TESTS`/`TESTS_FILE`
> edges from the graph (static, structural). It is a COMPLEMENT to the runtime change-coverage keystone
> (`src/qa/change-coverage.ts`), not a replacement. Static coverage narrows generation scope;
> runtime coverage is the objective signal that breaks the circularity. **Scope:** returns empty when
> the target repo has no unit tests of its own (e.g. the 4 Spring microservices: 0/0); returns
> file-level results for repos that DO carry unit tests (e.g. name-webapp: 248 TESTS_FILE) even in
> e2e mode. Playwright e2e specs themselves generate 0 TESTS edges (URL/DOM navigation, no static
> symbol imports). Never render an empty result as a "no coverage" warning in e2e mode — it just
> means the repo has no unit-test TESTS edges, not that nothing is covered.

### 6.2 `ServiceBoundaryResolverPort` — cross-service links (new, the agnostic core)

Cross-repo dependency understanding is the project's stated core value and the tool delivers none of
it. A **new bounded context `service-topology`** owns it. The domain speaks a transport-agnostic VO —
**never** OpenAPI. **`ServiceSymbolRef`** is the cross-repo ref type used here (distinct from the
intra-repo `LocalSymbolRef` used in `CodeGraphPort` and `SymbolResolverPort` — see §8):

```ts
// service-topology — domain/vos
/** Identifies a repo and the filesystem path to its working copy.
 *  `mirrorDir` is populated by MirrorRegistryPort.mirrorDir(repo) (new port, Phase 1).
 *  WorkspacePort.prepare(sha) only returns specDir for the current run's SHA — it does NOT map repo→mirrorDir. */
export interface RepoRef { repo: string; mirrorDir: string; }

/** Cross-repo symbol reference. ONLY used in ServiceLink and service-topology ports. */
export interface ServiceSymbolRef { repo: string; file: string; symbol: string; }

export interface ServiceLink {
  from: ServiceSymbolRef;                  // egress call-site (e.g. a frontend service method)
  to: ServiceSymbolRef;                    // ingress handler (e.g. a backend controller method)
  transport: "http" | "event" | "rpc";    // open set; the domain treats it as opaque
  contractRef?: string;                    // e.g. operationId, proto method, topic — opaque to the domain
  confidence: number;
  source: string;                          // which strategy produced it (for audit)
}

// service-topology — application/ports
export interface ServiceBoundaryResolverPort {
  // `front` = the consumer repo; `system` = candidate backend repos.
  resolveLinks(system: RepoRef[], front: RepoRef, changed?: BlastRadius): Promise<ResolveLinksResult>;
}

// Buckets proven useful by the spike (2026-06-27). `links` is the deterministic FE↔BE map that
// replaces LLM-derived feBe; `drift` is the free contract-linter output.
export interface ResolveLinksResult {
  links: ServiceLink[];        // matched: front call-site → contract operationId
  drift: ContractDrift[];      // front call to an endpoint the back contract does NOT declare
  external: ExternalCall[];    // call to a service not in `system` (e.g. a 3rd-party API)
  unresolved: UnresolvedCall[]; // dynamic path expression / stub — not statically resolvable
}

export interface ContractDrift { from: ServiceSymbolRef; verb: string; path: string; }
export interface ExternalCall { path: string; verb: string; }
export interface UnresolvedCall { rawArg: string; file: string; }
```

Each connection technology is a **strategy/adapter** behind that port:

- `OpenApiHttpResolver` — **this project. VALIDATED by spike (2026-06-27): 10 deterministic
  ServiceLinks over the real `nname` system, where the tool's cross-repo gave 0.** Mechanism, as proven:
  - **Ingress (back) = the OpenAPI spec is ground truth.** The Spring controllers implement the
    openapi-generator interfaces (`... implements org.openapitools.api.*Api`), so each repo's
    `src/main/resources/openapi/api-definition.yaml` is the authoritative `{verb, path, operationId}`
    source. No `@*Mapping` scraping needed for generated controllers; keep it only as a fallback for
    hand-written endpoints. (Watch-out the spike caught: a service may ship the openapi-generator
    **Petstore sample** as a placeholder — `notifications` did; detect and exclude it.)
  - **Egress (front) = the path is in the call-site; no indirection-following needed.** The
    manually-authored `*.api.ts` classes call `this.rest.{verb}(PATH)` where `PATH` resolves (through
    local/imported consts) to `name-{service}-api/{resource}` — the service prefix IS the routing
    target. The earlier "follow the `RestClientService` two-hop indirection via ast-grep" framing was
    unnecessary: the resource path is already at the `.api.ts` call-site.
  - **Join = strip the `name-{service}-api/` prefix → structural segment match** against the service's
    OpenAPI paths (a contract `{param}` segment matches any concrete front segment, e.g. front
    `/countries/ES` ↔ contract `/countries/{countryCode}`) → emit the `operationId`. High confidence
    when the contract resolves the path. This deterministic anchor is what replaces LLM-derived `feBe`.
  - **Bonus output — FE↔BE contract drift.** A known-service front call whose path is NOT in the
    contract is surfaced as `ContractDrift` (the spike found 11 — e.g. `users` declares 1 op but the
    front consumes ~9). A free cross-repo contract linter, not in the original design.
  - **Extraction engine: `ast-grep`/tree-sitter.** The spike used regex to prove the logic; production
    needs AST robustness (the proven gotchas — multiline `this.rest⏎.post(...)` chaining, const
    resolution, literal-where-contract-has-param — are in §10 Phase 5). **Match rate tracks
    back-contract completeness, not resolver capability** (restaurants, 11 ops → 7 clean links; users,
    1 op → mostly drift).
- `GrpcResolver`, `EventTopicResolver` (NATS/Kafka) — **future**: a new adapter, **zero domain
  change**.

Selection is by config, via a composite that mirrors `CoverageCollectorAdapter`'s fail-open pattern
(per-collector timeout + error isolation, verified against the real adapter in
`objective-signal/infrastructure/coverage-collector.adapter.ts`):

```ts
const RESOLVER_TIMEOUT_MS = 30_000;
const EMPTY: ResolveLinksResult = { links: [], drift: [], external: [], unresolved: [] };

async function resolveWithTimeout(
  resolver: ServiceBoundaryResolverPort,
  system: RepoRef[],
  front: RepoRef,
  changed: BlastRadius | undefined,
  timeoutMs = RESOLVER_TIMEOUT_MS,
): Promise<ResolveLinksResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(EMPTY), timeoutMs);
    resolver.resolveLinks(system, front, changed).then(
      (out) => { clearTimeout(timer); resolve(out); },
      (err) => {
        clearTimeout(timer);
        // Surface error loudly; degrade to empty (fail-open, never blocks).
        console.error("[CompositeServiceBoundaryResolver] resolver failed", err);
        resolve(EMPTY);
      },
    );
  });
}

export class CompositeServiceBoundaryResolver implements ServiceBoundaryResolverPort {
  constructor(
    private readonly resolvers: readonly ServiceBoundaryResolverPort[],
    private readonly timeoutMs = RESOLVER_TIMEOUT_MS,
  ) {}

  async resolveLinks(system: RepoRef[], front: RepoRef, changed?: BlastRadius): Promise<ResolveLinksResult> {
    const outcomes = await Promise.all(
      this.resolvers.map((r) => resolveWithTimeout(r, system, front, changed, this.timeoutMs)),
    );
    // Deduplicate links by (from, to, transport, contractRef), keeping highest confidence — contractRef
    // is in the key so GET /orders vs POST /orders are NOT collapsed. Concat the other buckets.
    const seen = new Map<string, ServiceLink>();
    const drift: ContractDrift[] = [], external: ServiceSymbolRef[] = [], unresolved: ServiceSymbolRef[] = [];
    for (const o of outcomes) {
      for (const link of o.links) {
        const key = `${link.from.repo}|${link.from.file}|${link.from.symbol}|${link.to.repo}|${link.to.file}|${link.to.symbol}|${link.transport}|${link.contractRef ?? ""}`;
        const existing = seen.get(key);
        if (!existing || link.confidence > existing.confidence) seen.set(key, link);
      }
      drift.push(...o.drift); external.push(...o.external); unresolved.push(...o.unresolved);
    }
    return { links: [...seen.values()], drift, external, unresolved };
  }
}
```

The per-project choice ("this system links via OpenAPI / that one via gRPC") lives in `app-catalog`
config as a capability list (generalizing today's `ServiceConfig.openapi?`), e.g.
`boundaries: ["openapi"]` or `["grpc", "events"]`. The composition root instantiates the matching
strategies. **App-specificity stays in `config/`.**

> The tool's graph still helps here as a *candidate source*: its `Route` and `HTTP_CALLS` nodes can
> seed the resolver — but never as the join itself (they are noisy: regex-as-URL, asset loads,
> test-only paths). The resolver re-anchors on the contract and filters the noise.

### 6.3 `SymbolResolverPort` — graph breadth + LSP precision (Serena, agent-side)

Because graph call-resolution is ~7.8–15–18% LSP (TS, point-in-time) / ~14% LSP (Java) with the rest heuristic,
Serena (live LSP) is **not** redundant.

**Important deployment constraint:** Serena runs ONLY as an agent-side MCP (configured in the agent
container, `agents/opencode.json`). It is NOT callable from the orchestrator process. The
orchestrator produces the blast radius deterministically via `CodeGraphPort` and injects it into
the agent session as `staticSignal` / `contextBrief`. The LSP-escalation step (going from the graph's
heuristic hit to a precise call-graph answer) happens INSIDE the agent session via Serena, not via
an orchestrator-side port.

The recommended framing is therefore **agent-side escalation**:

```
orchestrator: CodeGraphPort.impactedSymbols → blast radius (heuristic, confidence-filtered)
  → inject into OpencodeRunInput.staticSignal / contextBrief
agent session: graph result is the starting point; Serena (MCP) escalates low-confidence /
  polymorphic / interface-dispatch cases to LSP precision
```

A `SymbolResolverPort` in the orchestrator is NOT needed for this path. If a future design requires
the orchestrator to call Serena directly (e.g. to pre-resolve symbols before the session starts),
that would require a separate Serena client deployment in the orchestrator container — a deliberate
architectural choice, not a consequence of the current design. This document does not propose that.

`SymbolResolverPort` (if kept in the codebase) is **agent-side, documentation-only** — it is not
implemented or called by the orchestrator today. It exists solely to document the contract that a
future orchestrator-side Serena client would satisfy. If listed in §8, mark it with
`// agent-side / future orchestrator client — NOT wired in the current design`.

```ts
// agent-side / future orchestrator client — NOT wired in the current design
/** Resolved symbol shape returned by SymbolResolverPort.resolve (future; agent-side/LSP).
 *  Exact shape deferred — the port is agent-side/future and the LSP response format is
 *  Serena-specific. This is a minimum structural placeholder. */
export interface ResolvedSymbol {
  ref: LocalSymbolRef;
  kind: string;       // e.g. "function" | "class" | "method"
  signature?: string; // e.g. "(input: RunInput) => Promise<void>"
}

export interface SymbolResolverPort {
  resolve(repoDir: string, ref: LocalSymbolRef): Promise<ResolvedSymbol>;
  referencesTo(repoDir: string, ref: LocalSymbolRef): Promise<LocalSymbolRef[]>;
}
```

Serena's footprint shrinks: the orchestrator now produces the blast radius via `CodeGraphPort` and
injects it, so the agent stops doing primary exploration and uses Serena for point verification only.

### 6.4 `resolveCrossRepoImpact` — the composition

No single component yields cross-repo impact; it is the composition of §6.1 and §6.2.

**`BlastRadius` is a single-repo concept** (class with private constructor; constructed exclusively
via `BlastRadius.of(sha, changedFiles)` — verified in `qa-engine/src/shared-kernel/blast-radius.ts`).
It is keyed to a single SHA and cannot span repos. A new output VO **`CrossRepoImpact`** lives in the `service-topology` domain and
represents the multi-shard result:

```ts
// service-topology — domain
export interface CrossRepoImpact {
  /** One shard per repo involved in the cross-repo change set.
   *  Shards carry repo identity only — never filesystem paths.
   *  The application layer maps repo → repoDir via MirrorRegistryPort (new port, Phase 1). */
  shards: Array<{
    repo: string;              // repo identity (e.g. "ArielFalcon/portfolio"), NOT a filesystem path
    sha: Sha;
    changedFiles: string[];
    impacted: LocalSymbolRef[];   // transitive symbols within this repo, from CodeGraphPort
  }>;
}
```

The composition:

```
changed back-end symbol
  → ServiceBoundaryResolverPort.resolveLinks → ServiceLink(to == changed)
  → ServiceLink.from = front-end call-site (ServiceSymbolRef, cross-repo)
  → application layer: resolve from.repo → repoDir
      via MirrorRegistryPort.mirrorDir(from.repo)   // NEW port (Phase 1); NOT WorkspacePort
      // WorkspacePort.prepare(sha) only returns specDir for the current run's SHA — it does NOT map repo→mirrorDir
      frontSha = Sha.of(workingCopyHeadString)   // Sha has a private constructor; always use Sha.of()
  → CodeGraphPort.impactedSymbols(
        repoDir,
        BlastRadius.of(frontSha, [from.file]),   // BlastRadius private constructor — always use BlastRadius.of()
        opts: { depth: 3, minConfidence: 0.55 },
      )
      → intra-front transitive expansion → LocalSymbolRef[]
  = CrossRepoImpact { shards: [{ repo: backRepo, ... }, { repo: frontRepo, impacted: [...] }] }
```

A `resolveCrossRepoImpact` use-case in `service-topology/application/` orchestrates the two ports
and returns `CrossRepoImpact` — replacing the legacy LLM-derived `feBe`. The graph supplies the
intra-repo islands; the resolver supplies the cross-repo bridges; the use-case composes them.

### 6.5 Freshness — where `syncTo` runs

The orchestrator calls `CodeGraphPort.syncTo(mirrorDir, changedFiles)` in the **setup step**, after
checkout to the run's SHA and before generation. Incremental hashing makes it ~20 ms (no change) to
sub-second (typical commit). `fast` mode for the critical path; `moderate` only when semantic search
is needed. The domain is unaware a re-index happened.

`syncTo` returns `Result<{ nodeCount: number }, IndexFailed>` — the setup step MUST surface a loud
error on `IndexFailed` (whole-index failure: empty or crashed). A silent `[]` on graph failure violates
"surface errors loudly". The two failure modes are distinct: `syncTo` returns `IndexFailed` ONLY for
a whole-index failure; when `syncTo` succeeds but a specific file is absent from the index, the
subsequent `extract()` call for that file returns `ExtractorSkipped` (per-file parse failure — never
a silent empty array, and never an `IndexFailed`).

### 6.6 Generation seam — how it reaches the agent

The enriched `StaticSignal` (graph-backed), the `CrossRepoImpact`, the `ServiceLink[]`, and the
`SpecCoverage[]` (existing test coverage for the blast radius) are rendered into the agent prompt.
**This is NOT a zero-change seam** — the generation side requires one of two adaptations:

**Real types verified in `generation/application/ports/generation-ports.ts`:**
- `OpencodeRunInput.contextMap?: ArchitectureContext` — where `ArchitectureContext = { builtAtSha: string; routes: RouteEntry[]; api: ApiOperation[]; feBe: FeBeLink[]; flows?: FlowEntry[] }`
  and `FeBeLink = { route: string; operationId: string; via?: string }`.
  (`builtAtSha` is the first field — provenance/staleness signal; verified in `generation/application/ports/generation-ports.ts`.)
- `ServiceLink` (from `service-topology`) is structurally incompatible with `FeBeLink` — a
  `ServiceLink` has `from: ServiceSymbolRef` / `to: ServiceSymbolRef` / `transport` / `confidence`,
  while `FeBeLink` has `route` / `operationId` / `via?`.

**Required choice — pick one:**

**Option A (projection adapter — requires route resolution):** A `ServiceLinkToArchitectureContextAdapter`
in `generation/infrastructure/` projects `ServiceLink[]` → `ArchitectureContext`. **Verified
constraint:** `FeBeLink.route` is a UI URL path (a `RouteEntry.path`, e.g. `"/checkout"`) — it is
NOT a source file path. `ServiceSymbolRef.from.file` / `.from.symbol` are a source file path and
method name — they are NOT a `route`. A direct mapping from `from.file` to `FeBeLink.route` is
semantically invalid. Option A is only viable if the resolver carries the `routes: RouteEntry[]`
registry so the adapter can look up which route declares the source file (`RouteEntry.source`), then
extract `RouteEntry.path` as the `route`. If that registry is not available at projection time,
Option A produces a broken `ArchitectureContext` and must not be used.

**Option B (new field — recommended safe path):** Add `serviceLinks?: ServiceLink[]` to
`OpencodeRunInput` and update `PromptRenderingPort.renderMain` to render it as a separate prompt
section. Avoids the source-path-to-route mapping entirely. Requires a prompt rendering change but
produces a semantically correct model.

**Recommendation:** Use Option B as the default safe path. Attempt Option A only if the route
registry is reliably available at projection time and the mapping is unit-tested with real
`RouteEntry` data.

Until Phase 5 (resolver yield is proven), the change stays isolated to infrastructure regardless of
which option is chosen. Once yield is confirmed, the option choice can be revisited.

**`SpecCoverage[]` rendering:** The `existingCoverage` result (which existing specs cover the
blast radius) is rendered into `staticSignal` as a "COVERED BY EXISTING TESTS" section, so the
generator targets gaps rather than regenerating covered code. This is signal-only, fail-open (empty
`SpecCoverage[]` = no hint added).

The agent keeps Serena (agent-side MCP, §6.3) for ad-hoc LSP precision during the session.

---

## 7. How the existing tools are adapted

| Tool | Today (legacy `src/qa/static-signal`) | In qa-engine after integration | Rationale (measured) |
|---|---|---|---|
| **tree-sitter** (symbols, relations) | `extractSymbols`, `extractRelations` | **Retained as required fallback adapter** behind `SymbolExtractorPort`/`RelationExtractorPort` until Phase 3 parity tests (including parse-failure cases) are green; retired for ≥2 release cycles after the graph proves stable. `CodebaseMemoryGraphAdapter` is the primary implementation once parity is confirmed. | The graph already holds symbols and imports; but retirement requires parity evidence AND parse-failure degradation tests — do not remove early |
| **lizard** | `extractComplexity` | **Retained as required fallback adapter** behind `ComplexityExtractorPort` until Phase 2 parity characterization against graph output is confirmed. Graph gives cyclomatic + cognitive + more, multi-language, in one query — but retirement is parity-gated. | Graph gives more than ccn; but lizard stays alive until the Phase 2 gate clears |
| **difftastic** | `extractSemanticDiff` | **Kept** as `SemanticDiffExtractorPort` adapter | Cosmetic-vs-semantic gates `skip`; the graph has no equivalent (`detect_changes` is impact, not cosmesis) |
| **ast-grep** | `extractPatterns` | **Kept and promoted** — stays `PatternExtractorPort`; becomes the extraction engine of `OpenApiHttpResolver` (annotations, call-sites) | Structural pattern extraction is exactly what boundary ingress/egress needs |
| **Serena** (LSP, agent-side MCP) | primary agent exploration | **Kept, reduced role — agent-side only.** Serena runs as an MCP in the agent container (`agents/opencode.json`), NOT callable from the orchestrator. The orchestrator injects the graph-derived blast radius; Serena escalates low-confidence / polymorphic / interface-dispatch cases to LSP precision INSIDE the agent session. No orchestrator-side `SymbolResolverPort` implementation. | Graph TS LSP coverage is only ~7.8–15–18% (point-in-time measurement; re-measure per run); Serena precision is essential and cannot move to the orchestrator without a dedicated deployment |

---

## 8. Where it lives (folder layout)

```
qa-engine/src/
├── shared-kernel/
│   ├── code/
│   │   ├── local-symbol-ref.ts            # LocalSymbolRef { file, symbol } — intra-repo; used by CodeGraphPort + SymbolResolverPort
│   │   ├── code-graph-unavailable.ts      # CodeGraphUnavailable { reason } + IndexFailed { reason } — error types for CodeGraphPort Result returns
│   │   ├── spec-coverage.ts               # SpecCoverage { specFile, testName, coveredSymbol? } — coveredSymbol optional: set for TESTS (symbol-level), absent for TESTS_FILE (file-level)
│   │   └── coupled-file.ts                # CoupledFile VO (co-change coupling)
│   └── ports/
│       ├── code-graph.port.ts             # CodeGraphPort — cross-context shared-kernel port (import via @kernel/ports/...); matches agent-runtime.port.ts / clock.port.ts pattern
│       └── mirror-registry.port.ts        # MirrorRegistryPort { mirrorDir(repo: string): Promise<string> } — Phase 1; resolves repo identity → on-disk mirror path; consumed by service-topology use-case
├── contexts/
│   ├── change-analysis/
│   │   ├── application/ports/             # extractor ports + ExtractionContext; CodeGraphPort is in shared-kernel/ports/, NOT here
│   │   └── infrastructure/
│   │       ├── code-graph/
│   │       │   ├── codebase-memory-graph.adapter.ts   # implements extractor ports + CodeGraphPort; filters to changedFiles; degrades via ExtractorSkipped on parse failure
│   │       │   ├── knowledge-graph-store.ts           # local raw MCP/CLI surface (injected)
│   │       │   └── stub-code-graph.adapter.ts
│   │       └── extractors/                # difftastic + ast-grep adapters STAY; tree-sitter/lizard KEPT as fallback adapters until parity-gated retirement
│   ├── service-topology/                  # NEW bounded context
│   │   ├── domain/
│   │   │   ├── service-symbol-ref.ts      # ServiceSymbolRef { repo, file, symbol } — cross-repo ONLY
│   │   │   ├── service-link.ts            # ServiceLink VO
│   │   │   ├── cross-repo-impact.ts       # CrossRepoImpact { shards: [...] } — output of resolveCrossRepoImpact
│   │   │   └── repo-ref.ts
│   │   ├── application/
│   │   │   ├── ports/                     # ServiceBoundaryResolverPort
│   │   │   └── resolve-cross-repo-impact.use-case.ts  # returns CrossRepoImpact, not BlastRadius
│   │   └── infrastructure/
│   │       ├── composite-resolver.adapter.ts          # fail-open with per-resolver timeout + dedup
│   │       ├── openapi-http-resolver.adapter.ts       # uses ast-grep + OpenAPI; single-hop first (Phase 5)
│   │       ├── stub-resolver.adapter.ts
│   │       └── stub-mirror-registry.adapter.ts        # Phase 1 stub for MirrorRegistryPort (throws NotImplemented; replaced by repo-mirror adapter in Phase 3)
│   └── generation/
│       └── infrastructure/
│           └── service-link-to-architecture-context.adapter.ts  # Option A projection (route-registry required): ServiceLink[] → ArchitectureContext; prefer Option B (serviceLinks field) as the safe path — see §6.6
```

The composition root (the only module importing concrete adapters) wires the adapters to the ports,
selecting boundary strategies from `app-catalog` config. It stays outside `generation/*` and
`agent-runtime/*`, preserving the arch-lint VCS-write/security boundary.

**VO placement rule:** `LocalSymbolRef` lives in `shared-kernel/code/` (used across
`change-analysis`, `SymbolResolverPort`, and any adapter that reasons about intra-repo symbols).
`ServiceSymbolRef` lives in `service-topology/domain/` (cross-repo only, never in intra-repo ports).
Do not place a `repo`-bearing ref in `CodeGraphPort` or any intra-repo port.

**`SymbolResolverPort`** is agent-side, documentation-only — not wired in the orchestrator today
(see §6.3). If listed in the folder layout, mark it `// agent-side / future — NOT wired`.

**`CodeGraphPort`** is a shared-kernel port (§6.1): it lives at `shared-kernel/ports/code-graph.port.ts`,
imported via `@kernel/ports/...`, matching `agent-runtime.port.ts` and `clock.port.ts`. It is consumed
by both change-analysis and generation. If context isolation requires a split, introduce
`CodeStructurePort` (change-analysis) and `CodeKnowledgePort` (generation) explicitly; do not split
silently.

---

## 9. Product-agnosticism & extensibility

- **New transport** (gRPC, GraphQL, events): add one `ServiceBoundaryResolverPort` adapter + declare
  the capability in config. Zero change to the domain, the use case, or other adapters.
- **New language** for structure: the graph already covers 9 LSP languages / 158 tree-sitter; gate via
  the existing single-record `LanguageRegistry`.
- **New backend for structure** (if the tool is ever swapped): re-implement `CodeGraphPort`; the
  domain is untouched.
- **A project with no machine-readable contract**: the resolver's lowest cascade tier degrades to
  low-confidence links + the agent/LSP fallback — never a hard failure.

---

## 10. Adoption phases (incremental, stub-first, parity-gated)

1. **Port skeletons + stubs + VO split.** Add `CodeGraphPort`, `ServiceBoundaryResolverPort`,
   `MirrorRegistryPort { mirrorDir(repo: string): Promise<string> }` (at `shared-kernel/ports/mirror-registry.port.ts`),
   `ServiceLink`, `CrossRepoImpact`, `LocalSymbolRef`, `ServiceSymbolRef`, `SpecCoverage`; the
   `service-topology` context; wire stubs (including `StubMirrorRegistryAdapter`). Engine behavior unchanged. (Pure structure, low risk.)

2. **Graph adapter for complexity (parity-gated).** Re-back `ComplexityExtractorPort` with the graph;
   characterize against `lizard` output; lizard adapter remains ACTIVE as fallback until parity
   characterization is confirmed, then retired. Smallest, safest first win.

3. **Graph adapter for symbols/relations + `syncTo` (parity-gated, parse-failure required).**
   Re-back the two extractor ports; add the setup-step `syncTo`; validate the `changedFiles`
   filtering using the graph's `file_path` property (already repo-relative, slash-separated — do NOT
   normalize `qualified_name`); test the parse-failure degradation path (adapter must emit
   `ExtractorSkipped`, not a silent empty array); add post-`syncTo` health check (verify every
   `changedFile` exists as a graph node, not just `nodeCount > 0`). tree-sitter adapters remain
   ACTIVE as fallback until all parity tests — including parse-failure — are green. Do not retire
   until ≥2 release cycles of stable graph evidence.

4. **`CodeGraphPort` transitive, co-change, TESTS coverage.** Wire `impactedSymbols`/`coChangeCoupling`
   and `existingCoverage` (TESTS/TESTS_FILE edges). Render into `staticSignal`: impacted symbols
   advisory, existing-coverage as "COVERED BY EXISTING TESTS" section **for repos that carry unit
   tests (TESTS/TESTS_FILE edges) — in BOTH e2e and code mode** (e.g. name-webapp: 248 TESTS_FILE
   edges, e2e mode). **Silence `existingCoverage` only for repos with 0 TESTS and 0 TESTS_FILE edges**
   (e.g. the 4 Spring microservices: 0/0) — Playwright e2e specs themselves generate 0 TESTS edges
   (URL/DOM navigation, no static symbol imports); do not render an empty result as a "no coverage"
   warning for those repos. Keep advisory (`signal`) throughout this phase. Calibrate precision/recall
   on known changes — this phase **produces the calibration data Phase 7 uses to gate `enforce`**; it
   does NOT itself enable enforce.

5. **`OpenApiHttpResolver` — VALIDATED (spike 2026-06-27: 10 deterministic `ServiceLink`s vs the
   tool's 0); now being formalized in `service-topology`.** Proven mechanism (§6.2): the OpenAPI spec
   is ingress ground truth; the `name-{service}-api/{resource}` path is read **directly from the
   `.api.ts` call-site** (the resource path is already there — no `RestClientService` indirection to
   follow); join by structural segment-match → `operationId`; FE↔BE drift surfaced as a bonus output.
   Formalization: port the spike to `ast-grep`/tree-sitter (regex was the spike's only shortcut), which
   also resolves the 2 dynamic cases (a path built with an inline `encodeURIComponent` call; a stub).
   Wire the generation seam via Option B (`serviceLinks?: ServiceLink[]` on `OpencodeRunInput`).
   **Proven gotchas to carry into the AST impl:** multiline `this.rest⏎.{verb}(...)` chaining (missing
   it hid 2 real matches); const resolution incl. cross-file `${BASE}`; structural match (front
   `/countries/ES` ↔ contract `/countries/{countryCode}`), NOT string equality; exclude
   openapi-generator **Petstore-sample** specs (`notifications` shipped one). Retire LLM-derived `feBe`
   only once the AST impl meets/beats the spike's yield on the full system.

6. **Harden + extend the resolver.** Close the dynamic-egress cases the spike left unresolved (paths
   built with inline calls, multi-segment template composition) via the AST extractor; promote
   `ContractDrift` to a first-class run output (a free cross-repo contract linter — the spike surfaced
   11 real drifts). Future transports (gRPC, events) are new strategies behind the same
   `ServiceBoundaryResolverPort` (§6.2), zero domain change.

7. **Confidence floor calibration + escalation formalization (the enforce gate).** Using Phase 4
   precision/recall data, set the advisory threshold (~0.55) and the blocking threshold (0.85+)
   explicitly. Formalize the graph → Serena (agent-side) escalation path. Only after this phase may
   `enforce` mode use graph-derived blast radius for PR-gating.

Each step is independently shippable and parity-gated; nothing trusts a graph signal for a
PR-blocking decision until it has earned it through measured calibration.

---

## 11. Open risks / PoC-gated

- **Resolver yield — VALIDATED (was the #1 open risk).** The spike (2026-06-27) resolved **10
  deterministic `ServiceLink`s** over the real `nname` system vs the tool's **0**, plus 11 FE↔BE
  contract-drift findings — reading the `name-{service}-api/{resource}` path directly from the
  `.api.ts` call-site (no indirection to follow) and joining structurally to the OpenAPI `operationId`.
  The earlier "two-hop generated-client indirection" assumption is dropped. **Residual risk:** the
  spike was regex-based — the production `ast-grep`/tree-sitter impl must match that yield AND close the
  2 dynamic cases (inline-call path, stub). Match rate is bounded by **back-contract completeness** (a
  property of the watched system: restaurants 11 ops → 7 links; users 1 op → drift), not by the
  resolver — incomplete contracts surface as drift, not failure. Retire LLM-derived `feBe` only once
  the AST impl meets/beats the spike yield on the full system.

- **Confidence floor calibration — dual threshold required.** `0.85` is a starting hypothesis for
  the blocking threshold; it excludes ~62% of CALL edges (3583/5799 — `ai-pipeline` repo, point-in-time 2026-06-27; re-measure per run). Phase 4 collects
  calibration data; **Phase 7 is the enforce gate** — it sets both the advisory threshold (~0.55)
  and the blocking threshold (0.85+) and formally enables `enforce` mode. Before Phase 7, all graph
  blast radius use is advisory only. FALSE-NEGATIVES (a hollow blast radius → missed regressions)
  are a distinct anti-Goodhart risk from false-positives — a floor that is too high starves the blast
  radius and defeats the purpose. The advisory threshold (~0.55) must be set separately and
  independently, so the generator sees a meaningful signal even when the blocking threshold is strict.
  Keep 0.85 blocking-only until Phase 7.

- **Tree-sitter / lizard retirement is parity-gated.** Do NOT retire either until their Phase 2/3
  parity tests — including parse-failure degradation cases — are green. Both remain as required
  fallback adapters behind their ports for ≥2 release cycles. A silent empty array on parse
  failure is not acceptable; the adapter must emit `ExtractorSkipped`.

- **Java structural depth.** Java call resolution is ~86% heuristic; the graph's intra-Java blast
  radius may need a higher floor or Serena LSP assist more often than TS.

- **Serena is agent-side only.** Any future design that moves LSP resolution to the orchestrator
  requires a separate Serena client deployment in the orchestrator container. This is a deliberate
  architectural decision, not a consequence of the current design, and should be explicitly
  approved before implementation.

- **Tool maturity (v0.8.1).** Keep the stub + tree-sitter/lizard fallback adapters alive until the
  graph proves stable in real runs (post-Phase 3).
