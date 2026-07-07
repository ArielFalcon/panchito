# QA Engine — Hexagonal + Clean Architecture Rewrite (Design)

**Status:** Draft — 2026-06-24

This document specifies a full rewrite of `panchito` into a new `qa-engine/`
package, built in parallel to the running `src/` orchestrator (branch-by-abstraction)
and switched in behind a single feature flag. The target is a **Hexagonal + Clean
Architecture** with **tactical, selective DDD**: exactly **10 bounded contexts** as
swappable-implementation boundaries, value objects and ubiquitous language everywhere,
but aggregates only where a real invariant exists. The migration runs in two phases —
build-in-parallel guarded by a characterization golden net, a transparent legacy
adapter, and wrap-then-replace ports (Phase 1); then a shadow-strangle cutover with
instant rollback by flag (Phase 2). The non-negotiable priority is **stable, reliable,
deterministic above features**; the catastrophic risk we design against is **false
green** — a rewritten decide step committing a broken test into a watched repo via
PR + auto-merge. This is a design artifact; no source code is touched by it.

---

## 1. Summary

`panchito` today is a working but structurally entangled QA engine whose entire
orchestration, verdict policy, prompt assembly, budget management, coverage measurement,
learning fold, cross-repo routing, and security confinement live inside a single
~2080-line `runPipeline` function (`runPipeline` in `src/pipeline.ts` (≈:816 at HEAD)).
The latent domain is clear and the ubiquitous language is already strong; what is missing is the structure.

We extract that latent domain into 10 hexagonal modules under a new `qa-engine/` tree,
keep `src/` running untouched throughout Phase 1, and prove behavioral equivalence before
any real-repo traffic moves. The primary seam already exists: `runPipeline(opts, deps)` is
a 44-out apex in no import cycle (`dependency-graph` cut); 2 module importers, 1 function
call site — so a parallel engine satisfies the **sole direct caller** (`src/server/runner.ts:120`,
`enqueueTrackedRun`), not the 44 downstream modules. `src/index.ts:22` imports
`defaultPipelineDeps` and wires deps through the composition root — a distinct concern, not a port call.

---

## 2. Goal & Non-Goals

### 2.1 Goals

- **G1 — Decompose the god function.** Replace the `runPipeline` monolith with a `Run`
  aggregate + `RunDecision` policy + `FixLoop` budgets, orchestrated through segregated
  driven ports (`pipeline-orchestration` map; `qa-run-orchestration` context).
- **G2 — Make swappability structural.** The 10 bounded contexts are hexagonal modules =
  swappable-implementation boundaries. Ports deliver that value; adapters are replaceable
  behind them.
- **G3 — Make the security boundary structural, not conventional.** Only
  `workspace-and-publication` holds `VcsWritePort`; the arch-lint gate
  (`qa-engine/test/arch/vcs-write-confinement.test.ts`, run as part of `npm test`, backed
  by `dependency-cruiser` as an explicit devDependency) forbids any `generation/*` or
  `agent-runtime/*` module from importing `VcsWritePort` or `vcs-write.adapter`; this gate
  is a prerequisite before context code is written (`risks[3]`).
- **G4 — Keep the objective signal (change-coverage) in the domain core, outside the
  agent** — the only non-LLM signal that breaks the generate/review circularity
  (`objective-signal` context; CLAUDE.md value/trust risk).
- **G5 — Preserve behavior exactly.** Equivalence is two-tier: internal (structurally
  equivalent `RunOutcome` — same verdict, sideEffect, coverageRatio, rationale — for
  identical `PipelineDeps`) + external (`contract/openapi.json` byte-identical). See §10.
- **G6 — Bring E2E-only capabilities to code-mode** as the second adapter on shared
  ports (§6), within the hard limits of §3.
- **G7 — Produce a genuinely extractable engine** (the stated Phase-2 library goal):
  the contexts must be separable without re-entangling generation/agent-runtime or
  execution/objective-signal.

### 2.2 Non-Goals

- **N1 — No prompt tuning as "quality" work.** New quality logic leans on the coverage
  signal, not on another LLM proxy (CLAUDE.md value/trust risk).
- **N2 — No change to the external contract.** `contract/openapi.json` and the SDK are
  frozen end to end; clients must never observe the swap (`risks[7]`).
- **N3 — No rewrite of the deliberately-uncovered boundaries up front.** opencode-client,
  execute, and git stay intact behind clean port faces in Phase 1; native replacement is
  scheduled post-cutover (`migrationPlan.phase2Switch[6]`; `risks[4]`).
- **N4 — Self-maintenance is not rebuilt early.** It stays on the old code path and
  migrates dead-last (§7, §8); only incidents move to durable storage early.
- **N5 — Cross-run learning ships stubbed in v1.** It is off-path and never gates publish
  (`cross-run-learning` context; `tradeoffs[6]`).
- **N6 — No collapse below 10 contexts.** Workspace+Publication are already merged from
  the 11-context purist split; we do not collapse further (locked decision).

### 2.3 Cross-cutting cleanups carried by the rewrite

The rewrite is the moment to land five cleanups that would be costly to retrofit later:

- **C1 — Unify naming under `panchito`.** Erase every trace of the old name `panchito`: the `package.json` name, the docker service/container names and `docker-compose*`, env/config references, and any in-code identifiers/strings. Scope = internal nomenclature, docker, and configs; renaming the git remote/repo is a separate, optional call (out of this spec unless requested). The new engine module stays named `qa-engine/` (descriptive) inside project `panchito`.
- **C2 — Tests in a mirror `test/` tree.** Production code under `qa-engine/src/`; tests under `qa-engine/test/` mirroring the `src/` scaffolding (the Java `src/main`/`src/test` convention), NOT colocated `*.test.ts`. tsconfig path aliases (`@kernel/*`, `@contexts/*`, `@interface/*`) keep the mirrored imports clean. The Phase-1 mechanism is the **glob extension**: `"qa-engine/test/**/*.test.ts"` is added to the root `npm test` command alongside `--import ./test-setup.mjs` (resolved relative to the repo root — the same per-process SQLite isolation path already in use). "npm workspace" is a documented fallback only, not an unresolved OR. For typecheck: the root `tsc --noEmit` covers only `src/`; qa-engine type errors are caught by adding a TypeScript project reference (`references: [{ path: "./qa-engine" }]` in the root tsconfig) or an explicit `tsc -p qa-engine` step in `npm run typecheck`. See §7.2 Step 3 for the settled mechanism.
- **C3 — Deep comment cleanup.** The current code is full of decision-log and intermediate-process comments. Final comments must be clean and useful: keep ONLY what helps a human or AI agent understand something the code does not state explicitly; delete the rest. (Already a CLAUDE.md invariant: comments describe the final state, not the process.)
- **C4 — Code-mode ports ready, depth deferred.** All code-mode ports/adapters are defined, encapsulated, and fragmented in v1 (the §6 seams), but their DEEP implementation is a later stage — after the current (e2e) flow is switched in and stable. The interface is the v1 deliverable; the heavy adapters (real non-invasive JaCoCo injection, backend authoring, backend reviewer rubric) are YAGNI until stage 2. Consistent, not contradictory: the seam is cheap and buys the fragmentation; the expensive impl waits until needed.
- **C5 — SOLID + DRY + KISS + YAGNI.** Apply throughout: remove dead, duplicated, and needless code; reduce accidental complexity WITHOUT behavioral regression (the characterization net is the guardrail). The re-analysis already found the concrete DRY targets — **3 duplicate diff-content parsers** (`parseDiffHunks` at `src/qa/change-coverage.ts:75`, `parseChangedFiles` at `src/qa/commit-classify.ts:91`, `changedFilesFromDiff` at `src/qa/static-signal/semantic-diff.ts:84`) consolidated into one `DiffParserService` in the kernel (the other 2 git-output parsers — `parseStatusOutput` and `parsePorcelain` — parse `git status --porcelain`, not diffs, and stay in their respective bounded contexts); near-duplicate circuit breakers with independent per-provider state; **`killTree` in 4 files** (`src/qa/execute.ts:64`, `src/qa/code-runner.ts:64`, `src/qa/static-signal/exec.ts:6`, `src/qa/learning/mutation-code.ts:10`) consolidated into one `ProcessKillPort`/adapter in the kernel; **`scrubEnv`: 1 definition** (`src/qa/code-runner.ts:73`) **+ 8 import sites** (`setup.ts`, `validate.ts`, `execute.ts`, `dom-snapshot.ts`, `learning/mutation-code.ts`, `server/maintainer-runtime.ts`, `static-signal/exec.ts`, `static-signal/semantic-diff.ts`) — move the definition to the kernel and update all 8 imports (this is an import migration, not a dedup); two divergent redaction implementations (§4.2). KISS/YAGNI reinforce the tactical-DDD stance: no ceremony without a real invariant.

---

## 3. Hard Limits of Code-Mode (the boundary we do NOT build on)

Code-mode parity (§6) is bounded by three limits that are out of scope **by definition**,
not by schedule. Stating them up front prevents the rewrite from over-promising:

| Hard limit | Why it cannot be crossed |
|---|---|
| **No DOM / observable-UX signal** | Code-mode has no browser. There is no aria tree, no route DOM, no selector grounding, no reviewer DOM evidence. The `DomGroundingPort` carries no signal for the code target — it is wired to a `NullDomGroundingAdapter` (no-op, empty grounding) so the generation use-case runs uniformly (`generation` context). |
| **No universal coverage instrument** | Coverage is per-ecosystem only (c8 for node, JaCoCo for JVM, etc.) behind `CoverageCollectorPort`. There is no single instrument that covers every language; an unsupported ecosystem yields `unknown`, which **never blocks** (`objective-signal` invariant). |
| **No live-deployed-system validation** | Code-mode classifies by the repo's own test-suite exit code with no deploy gate and no live DEV. There is no health pre-flight, no `infra-error` from a down site, no flaky classification (`test-execution` `CodeExecutionStrategy`; CLAUDE.md "Test targets"). |

Additionally: **cross-repo code-mode is debt, not impossible** — browser coverage cannot
map service-repo lines today, and code-mode inherits the same limitation. We model it as a
known gap, not a blocker.

---

## 4. Current State (evidence-based)

> **Note on line numbers.** Line numbers cite the re-analysis snapshot (`pipeline.ts` was
> 3021 lines then; HEAD has since moved — e.g. `runPipeline` is now ≈:816, file ≈3010 lines).
> Treat all `file:line` references below as grep-able-identifier hints, not exact addresses;
> re-verify against HEAD at implementation time.

All claims below cite the 15-agent re-analysis (`maps` for subsystem evidence, `cuts`
for cross-cutting analysis). The repo is **251 files** (126 source + 125 test, ~1:1;
`test-architecture` cut). The directory weight is concentrated: **qa/ 103 files,
server/ 65, integrations/ 37** (locked-decision framing; consistent with the per-area
test distribution in the `test-architecture` cut).

### 4.1 The god files

| File | Size | The smell | Evidence |
|---|---|---|---|
| `src/pipeline.ts` `runPipeline` | ~2080-line single function | Entire orchestration + verdict policy + prompt assembly + budgets + coverage + learning fold + cross-repo routing + confinement, all as closures over shared mutable state (`cycleCount`, `MAX_CYCLES`, `wallClockBudget`, `result`). | `pipeline-orchestration` map (GOD FILE) |
| `src/integrations/opencode-client.ts` | 1940 lines | Conflates SDK transport, SSE streaming, verdict orchestration, the plan→fan-out use-case, deterministic manifest reconciliation, and resilience wrappers. The dependency hotspot: 30 total degree, 10 in / 20 out. | `integrations` map (GOD FILE #1); `dependency-graph` cut §4 (#4) |
| `src/integrations/prompts.ts` | 1499 lines | Core **domain policy** (what makes a valuable test, grounding/regen discipline, reviewer severity contract) trapped purely as string templates — untestable business logic. | `integrations` map (GOD FILE #2) |
| `src/server/api.ts` | 1167 lines | One regex switch routes ~35 endpoints; `ApiDeps` has 40+ optional fields with `absent ⇒ 501` as the wiring contract. No controllers, no middleware. | `server-http` map (GOD FILE api.ts) |
| `src/server/history.ts` | 1083 lines | One SQLite handle behind which **four bounded contexts** hide — run history, SSE event durability, agent-turn telemetry, the learning ledger. `computeTelemetryAnalysis` (`:932`) is ~120 lines of statistical domain logic in SQL. | `server-http` map (GOD FILE history.ts) |
| `src/qa/code-runner.ts` | 815 lines | Fuses code-mode detection, install, execute+classify, c8 coverage, AND the `scrubEnv` sandbox layer — so e2e modules depend on the code-mode file. | `qa-core` map (GOD FILE) |
| `src/qa/learning/learning-rule.ts` | 325 lines | Fuses ≥5 responsibilities: entity, promotion/demotion state machine, retrieval ranking, prompt rendering for generator + reviewer, dedup, attribution scoping. | `qa-learning` map (GOD FILE) |

### 4.2 The concrete smells

**Scattered verdict policy (the false-green seed).** The six-verdict decision is not in
one place: `skipped` at `pipeline.ts:1112/1936`, `invalid`/`infra-error` at
`:2094-2128`/`:2256-2278`, `fail`/Issue via `report()` at `:2956`, and the green
publish/Issue/coverage-block tree at `:2818-2875`. Reconstructing "when does each verdict
happen" requires reading the whole file (`pipeline-orchestration` map).

**Cross-run global in a per-run function.** Module-level `consecutiveReviewerFailures`
(`pipeline.ts:80`) is mutable state shared across **all** runs — a cross-run side effect
inside a per-run function (`pipeline-orchestration` map).

**Leaky layer inversion.** `pipeline.ts` dynamically `import()`s `./server/history`
(SQLite) and `./server/maintainer` from inside its own default deps (`:487-619`); the
orchestrator core reaches **down** into the server persistence layer it should not know
about (`pipeline-orchestration` map).

**The DI seam conflates ports with side-channels.** `PipelineDeps` (~45 members,
`pipeline.ts:132`) mixes genuine ports (execute, publish, validate, generate) with
persistence (`saveOutcome`), telemetry, and the entire learning flywheel
(`retrieveRules`, `reflectAndDistill`, `runOracle`, `auditProcess`). Most are optional,
so every call site is guarded with `if (deps.x)` — the seam leaks rather than abstracts
(`di-ports-inventory` cut; `pipeline-orchestration` map).

**The illegal kernel forward-edge.** `src/types.ts` (the ~45-importer kernel) imports
**forward** into downstream contexts: `ErrorClass` from `qa/learning/taxonomy`
(`types.ts:214/223/266`) and `RunUsage` from `qa/usage` (`types.ts:245`). A kernel that
depends on its own consumers is an inverted dependency (`contracts-and-shared` map;
`oldToNewMapping` types.ts entry).

**Triple-defined enums held by drift-guard tape.** `RunVerdict`/`RunMode`/`TestTarget`
literals exist in `types.ts`, `contract/events.ts` (zod), inline in
`orchestrator/schemas.ts:184-185`, and raw-literal in `index.ts:259`. Lockstep is enforced
only by runtime/compile-time drift tests (`contracts-and-shared` map).

**Two divergent secret-redaction implementations.** `orchestrator/sanitizer.ts`
(`sanitizeText`, `[REDACTED_SECRET]`) and `util/redact.ts` (`redactSecrets`,
`[REDACTED_CREDENTIAL]`) — different patterns, different placeholders, can diverge
silently (`contracts-and-shared` map). The canonical placeholder in the rewrite is
`[REDACTED]`; the legacy variants (`[REDACTED_SECRET]`, `[REDACTED_CREDENTIAL]`) are
swept to `[REDACTED]` in Step 3/4 (shared-kernel `RedactionPort` + `workspace-and-publication`
egress sanitization adapter).

**Duplicated infrastructure primitives.** `killTree` is defined identically in 4 files:
`src/qa/execute.ts:64`, `src/qa/code-runner.ts:64`, `src/qa/static-signal/exec.ts:6`, and
`src/qa/learning/mutation-code.ts:10` — `ProcessKillPort` consolidates all 4;
`codex-circuit-breaker.ts` is near-duplicate logic of `circuit-breaker.ts` with deliberately
SEPARATE per-provider global state (a Codex outage must never trip the OpenCode breaker) — the
`ResilienceDecorator` (§5.3(4)) consolidates this with INDEPENDENT state per provider instance,
verified by a test before deleting the originals; there are **5 git-output
parser functions** in the codebase, but only **3 parse diff content** and belong in the kernel:
`parseDiffHunks` (`src/qa/change-coverage.ts:75`), `parseChangedFiles`
(`src/qa/commit-classify.ts:91`), and `changedFilesFromDiff`
(`src/qa/static-signal/semantic-diff.ts:84`) — consolidated into `DiffParserService` in the
kernel. The other 2 parse `git status --porcelain` output and are NOT diff parsers:
`parseStatusOutput` (`src/qa/confinement.ts:69`) is write-confinement semantics — it stays in
`workspace-and-publication`'s `WriteConfinementService`; `parsePorcelain`
(`src/qa/code-runner.ts:402`) is code-mode changed-file detection — it stays in
`test-execution`'s `CodeExecutionStrategy`. Pulling status parsers into the kernel `DiffParserService` would leak confinement semantics into the core and violate the security boundary (§5 Principle 5) (`qa-core` map; `integrations` map; `agent-runtime` map).

**Real runtime import cycle.** `execute.ts ⇄ dom-snapshot.ts` is a genuine value cycle
(`killTree` is misplaced in `execute.ts`); extracting it to a leaf breaks the cycle
(`dependency-graph` cut §3).

**The keystone's one weak spot.** `defaultCollectCoverage` hard-codes FS reads
(lcov/Istanbul/JaCoCo/V8) with **no `*Deps` interface** — the only part of the harness
stubbable only by wholesale replacement (`qa-core` map; `objective-signal` context
critical fix).

**Persistence asymmetry in the most dangerous code.** Incidents live in an in-memory
ring of 30 (lost on restart) while runs/outcomes are durable SQLite — yet incidents drive
**irreversible self-deploys** (`server-http` map).

**The characterization risk for the rewrite itself.** The verdict policy's only spec is
**186 `runPipeline` invocations total**: **182 in `pipeline.test.ts`** (the `test-architecture`
cut; the `pipeline-orchestration` map says "191 tests" — the larger figure includes
non-`runPipeline` assertions in the same file) plus **4 in `pipeline-codex.test.ts`**
(Codex provider scenarios — omitting these creates a Codex false-green blind spot). These stub
the full `PipelineDeps` and assert exact branch behavior; all 186 must be carried forward as a
parallel characterization suite or the switch cannot be validated (`test-architecture`
cut §2; `pipeline-orchestration` map).

---

## 5. Target Architecture

### 5.1 Principles

1. **Hexagonal + Clean.** Domain core (entities, value objects, pure services) depends
   only on the shared kernel; application use-cases orchestrate **driven ports**;
   infrastructure adapters implement them. The composition root is the only module that
   imports concrete adapters.
2. **Selective DDD.** Value objects + ubiquitous language everywhere. **Aggregates only
   where a real invariant exists**: `Run`, `FixLoop`, `LearningRule`, `Manifest`,
   `App`, `RunQueue`, `Incident` — **7 settled aggregates** (see §9.1 for per-aggregate
   invariant justifications; `TestRun` is an implementation-level aggregate in
   `test-execution`, not locked at this level). `WriteConfinement` is a stateless
   `WriteConfinementService` (domain service) + `ConfinementResult` VO — no identity,
   no lifecycle. No repositories/aggregates/domain-events imposed by default.
3. **The kernel depends on nothing downstream.** The `types.ts:214/223/245/266` forward
   edge is severed by **inversion**, not absorption: `ErrorClass` stays in
   `cross-run-learning`, `RunUsage` stays in `agent-runtime` (`tradeoffs[0]`). Conversely,
   any type that appears in a kernel port's signature MUST live in the kernel: `AgentRole`
   and `RoleAssignment` (used by `AgentRuntimePort.openSession()`) are placed in
   `shared-kernel/` as shared vocabulary so the kernel never forward-depends on
   `agent-runtime/` (§5.3(4)).
4. **Swappability is the value.** Each context boundary = a swappable implementation
   boundary. Ports marked **[SWAP]** below are where that value is delivered.
5. **The security invariant is structural** (§2 G3): `VcsWritePort` lives only in
   `workspace-and-publication`; arch-lint enforces it.
6. **The objective signal lives in the core, outside the agent** (§2 G4).
7. **Single source of truth for the wire contract.** The kernel owns the zod schemas that
   codegen the SDK; `openapi.json` is frozen.
8. **SOLID, DRY, KISS, YAGNI** (§2.3 C5). Single-responsibility modules; depend on ports not concretions; one canonical implementation per concept (no duplicate parsers/breakers/util); the simplest design that satisfies the invariant; no speculative generality. Tactical DDD is the YAGNI of modeling — aggregates only where an invariant demands one.
9. **Comment hygiene** (§2.3 C3). Comments explain intent the code cannot — invariants, non-obvious constraints, security/determinism rationale — never narrate process or decisions.
10. **Tests mirror the source** (§2.3 C2). `test/` mirrors `src/`; no colocated tests; path aliases keep imports clean. Phase-1 mechanism: glob extension — `"qa-engine/test/**/*.test.ts"` added to the root `npm test` with `--import ./test-setup.mjs` resolved from the repo root; `tsc` coverage added via project references or explicit `tsc -p qa-engine` (see §7.2 Step 3).

### 5.2 The `qa-engine/` folder tree

```
panchito/                               # project root — renamed from "panchito" everywhere
│                                       # (package.json name, docker service/container, compose, configs, code)
└── qa-engine/                          # the NEW engine, built in parallel to src/, switched in by a flag
    ├── package.json  tsconfig.json     # strict + noUncheckedIndexedAccess; path aliases @kernel/* @contexts/*
    │                                   # @interface/* so the mirrored test/ imports stay clean. Path-mapped
    │                                   # into the root gate: `npm test` + `npm run typecheck` cover both trees.
    │
    ├── src/                            # ALL production code. NO colocated tests (Java src/main convention).
    │   ├── shared-kernel/              # cross-context vocabulary — depends on NOTHING downstream
    │   │   ├── run-verdict.ts  run-mode.ts  sha.ts  objective.ts  blast-radius.ts
    │   │   ├── run-event.ts  qa-case.ts  result.ts  domain-error.ts
    │   │   ├── run-outcome.ts                              # SHARED-KERNEL type: RunOutcome (immutable record;
    │   │   │                                               # consumed from here by qa-run-orchestration AND
    │   │   │                                               # cross-run-learning; neither context depends on the other)
    │   │   ├── ports/{redaction,clock}.port.ts   adapters/{regex-redaction,system-clock}.adapter.ts
    │   │   ├── diff-parser/diff-parser.service.ts          # ONE canonical diff parser (consolidates 3 diff-content
    │   │   │                                               # parsers: parseDiffHunks, parseChangedFiles,
    │   │   │                                               # changedFilesFromDiff); status parsers (parseStatusOutput,
    │   │   │                                               # parsePorcelain) stay in their own bounded contexts
    │   │   │                                               # shared by change-analysis + objective-signal
    │   │   ├── process-sandbox/                            # kernel holds types + port interfaces ONLY
    │   │   │   ├── process-kill.port.ts                    # port interface (shared by validate/setup/
    │   │   │   └── scrub-env.ts                            # dom-snapshot/execute/static-signal); pure scrubEnv
    │   │   │                                               # helper stays kernel-adjacent (no child_process);
    │   │   │                                               # concrete spawn adapters → shared-infrastructure/
    │   │   ├── ports/agent-runtime.port.ts                 # AgentRuntimePort lives here (prerequisite for OQ1
    │   │   │   agent-role.ts  role-assignment.ts           # extraction; generation + agent-runtime both depend
    │   │   │                                               # on it without coupling to each other).
    │   │   │                                               # AgentRole + RoleAssignment live here: port signature
    │   │   │                                               # takes AgentRole; RoleAssignment appears in openSession()
    │   │   │                                               # — both must be kernel-resident so the kernel never
    │   │   │                                               # forward-depends on agent-runtime/ (§5.1 P3).
    │   │   └── contract/{events,commands,openapi}.ts        # FROZEN external surface
    │   │
    │   ├── shared-infrastructure/       # concrete infra helpers shared across contexts (child_process)
    │   │   └── process-sandbox/
    │   │       ├── process-kill.adapter.ts                 # concrete killTree impl (child_process) — NOT kernel
    │   │       └── sandboxed-binary-runner.ts              # spawn wrapper (child_process) — NOT kernel
    │   │
    │   ├── contexts/                   # 9 domain contexts (the 10th — control-plane — is interface/ + composition/)
    │   │   ├── qa-run-orchestration/   # ★ CORE (replaces pipeline.ts)
    │   │   │   ├── domain/{run,run-decision,fix-loop}.ts
    │   │   │   ├── application/{run-qa.use-case,run-pipeline.port}.ts + ports/*.port.ts
    │   │   │   └── adapters/{legacy-pipeline,rewritten-orchestrator}.adapter.ts
    │   │   ├── change-analysis/        # classify + static-signal extractors (diff-parser consumed from kernel)
    │   │   │   └── domain/ · application/ports/ · infrastructure/extractors/
    │   │   ├── generation/             # plan/author/review; the 1499 prompt lines → a rendering adapter
    │   │   │   └── domain/{manifest,architecture-context}.ts
    │   │   │       · application/{generate-tests,fan-out,review,context-pack-assembler}.use-case.ts
    │   │   │       + ports/{prompt-budget,dom-grounding,manifest-repository,verdict-parser,prompt-rendering}.port.ts
    │   │   │       · infrastructure/
    │   │   ├── agent-runtime/          # opencode ↔ codex; ONE resilience.decorator (no duplicate breakers)
    │   │   │   └── domain/ · application/ports/ · infrastructure/{opencode,codex}/ + resilience.decorator.ts
    │   │   │       + stall-watchdog.port.ts  stall-watchdog.adapter.ts  # separate StallWatchdogPort (Option B:
    │   │   │                                                            # independent from ResilienceDecorator)
    │   │   ├── test-execution/         # e2e ↔ code strategies; extracted process-kill breaks the dom cycle
    │   │   │   └── domain/ · application/ports/ · infrastructure/{e2e,code}/
    │   │   ├── objective-signal/       # ★ KEYSTONE — coverage + oracle, in the core, outside the agent
    │   │   │   └── domain/ · application/ports/ · infrastructure/{coverage,oracle}/
    │   │   ├── cross-run-learning/     # off-path flywheel (stubbed in v1)
    │   │   │   └── domain/ · application/ports/ · infrastructure/
    │   │   ├── workspace-and-publication/  # the ONLY git-write context (VcsWritePort lives here only)
    │   │   │   └── domain/ · application/ports/ · infrastructure/
    │   │   └── app-catalog/            # watched-app config + cross-repo routing
    │   │       └── domain/ · application/ports/ · infrastructure/
    │   │
    │   ├── interface/                  # control-plane (the 10th context): the DRIVING side only
    │   │   ├── http/{server,controllers/*,sse-streaming.adapter}.ts
    │   │   ├── queue/{job-queue,run-funnel}.ts      # run-funnel consumes RunPipelinePort
    │   │   └── self-maintenance/                    # most dangerous code — isolated, migrated dead-last
    │   │
    │   │   # NOTE: persistence is INFRASTRUCTURE (driven side), not the driving side.
    │   │   # It lives under contexts/control-plane/infrastructure/persistence/ in the
    │   │   # full DDD layout — kept under interface/ here only for practical Phase-1
    │   │   # bootstrapping (co-locates with control-plane concerns before full extraction).
    │   │   # Final address: contexts/control-plane/infrastructure/persistence/
    │   │   # Trigger for the move: after the FIRST repo cutover (§7.3 Step 4/5) confirms
    │   │   # the persistence layer is stable under the rewritten engine, migrate it to its
    │   │   # final DDD address in the same step as control-plane extraction (§7.3 Step 6).
    │   │   #   {sqlite-run-history.repository.ts, durable-run-event.store.ts}
    │   │
    │   └── composition/composition-root.ts          # ONLY module importing concrete adapters; replaces
    │                                                # defaultPipelineDeps(); buildProduction/buildShadow + engine flag
    │
    └── test/                           # MIRROR of src/ — tests only (Java src/test convention)
        ├── shared-kernel/…             # e.g. test/shared-kernel/sha.test.ts mirrors src/shared-kernel/sha.ts
        ├── contexts/…/{domain,application}/*.test.ts
        ├── interface/…
        └── characterization/           # ★ the strangler safety net (Phase-1 deliverable, built FIRST)
            ├── golden-outcome.harness.ts       # replays the pipeline.test.ts scenarios through BOTH engines
            ├── outcomes/*.json                 # 10 sanitized RunOutcome goldens:
            │                                   #   green-pr, fail-issue, flaky-quarantine, no-op-skip,
            │                                   #   invalid-issue, infra-error, code-mode, cross-repo,
            │                                   #   shadow, context
            └── old-vs-new-parity.test.ts       # identical (verdict, sideEffect, RunOutcome); divergence fails CI
```

> **Note on count.** The shared-kernel is a peer module, **not** one of the 10. **Nine** of
> the ten bounded contexts are the directories under `contexts/`; the tenth — `control-plane`
> (§5.3-10) — is the driving/interface context, realized under `interface/` + `composition/` +
> `interface/persistence/` rather than under `contexts/`. `characterization/` is the
> safety-net scaffolding, not a context. (If a reviewer prefers, `control-plane` can be framed
> as "the interface layer around 9 domain contexts" — same modules, same count of 10 named
> units; this is a labeling choice, not a structural one.)

### 5.3 The 10 bounded contexts

For each: responsibility, the key ports (with **[SWAP]** marking the swappability seam),
adapters, and the **selective** aggregates / value objects kept.

#### (1) `qa-run-orchestration` — the application core (replaces `runPipeline`)

- **Responsibility.** Owns the `Run` aggregate and the deterministic lifecycle
  (gate → analyze → generate → validate → health → execute → measure-objective-signal →
  review → fix-loop → decide), composing every other context through driven ports.
  Contains **no inline IO, no prompt strings, no learning side-effects**. The scattered
  six-verdict decision collapses into ONE pure `RunDecision`. The module-level
  `consecutiveReviewerFailures` (`pipeline.ts:80`) is **eliminated**.
- **Ports.** `RunPipelinePort` **(driving — THE strangler seam)**; driven:
  `ChangeAnalysisPort`/`GenerationPort`/`ReviewPort`/`ValidationPort`/`ExecutionPort`/
  `ObjectiveSignalPort`/`PublicationPort`/`LearningPort`/`DeployGatePort`/`WorkspacePort`;
  `ObserverPort` (replaces the 7 positional callbacks); `RunHistoryPort` (inverts the
  leaky dynamic `import()` at `pipeline.ts:487-619`).
- **Adapters.** `LegacyPipelineAdapter` (Phase-1, wraps unchanged `runPipeline`),
  `RewrittenOrchestratorAdapter` (Phase-2, composes context ports).
- **Aggregates.** **`Run`** (identity = RunId+Sha+App; transitions guarded by invariants;
  replaces in-place-mutated `QaRunResult`/`RunRecord`), **`FixLoop`** (cycle/wall-clock
  budgets as invariants).
- **Domain services.** `RunDecisionService` (the six-verdict policy in ONE auditable pure
  place — no identity, no lifecycle; demoted from aggregate because verdict selection is
  a pure stateless computation over `Run` evidence, not a guarded state transition).
- **VOs.** `CycleBudget`, `WallClockBudget`, `RunDecision` (the verdict + chosen side-effect,
  returned by `RunDecisionService`). `RunOutcome` is **consumed from the shared-kernel**
  (`shared-kernel/run-outcome.ts`) — it is not defined here.

#### (2) `change-analysis` — deterministic blast-radius analysis

- **Responsibility.** Pure analysis of a commit. Owns `classifyCommit` (the token-spend
  gate), and consumes the **single canonical diff parser** from the shared-kernel
  (consolidating the 3 duplicate diff-content parsers — `parseDiffHunks`, `parseChangedFiles`,
  `changedFilesFromDiff`), and the five static-signal extractors fanned out fail-open with
  **typed degradation events** (replacing opaque `skipped` strings). **Signal-only by contract:
  never blocks publish.**
- **Ports.** `VcsReadPort` **[SWAP]** (typed read side; no raw git argv leaking),
  `SymbolExtractorPort`/`RelationExtractorPort`/`ComplexityExtractorPort`/
  `SemanticDiffExtractorPort`/`PatternExtractorPort` **[SWAP]** (all-optional fail-open map).
  `DiffParserService` and `SandboxedBinaryRunner`/`scrubEnv` and `ProcessKillPort` are
  consumed FROM the shared-kernel (not owned here — see §5.2 kernel tree).
- **Adapters.** `GitMirrorReadAdapter`; `TreeSitter*`/`Lizard`/`Difftastic`/`AstGrep`
  extractor adapters (semantic-diff's git-blob `execFileSync` is routed through the
  kernel's `SandboxedBinaryRunner`).
- **Domain services.** `PlanGenerationService` (plans objectives from static signal — pure
  computation, no lifecycle).
- **VOs / read-models.** `StaticSignal` (Sha-keyed read-model — no guarded state
  transitions; demoted from aggregate), `CommitClassification` (pure classification result;
  demoted from aggregate), `CommitIntent`, `CommitType`, `CommitAction`, `DiffHunk`,
  `ChangedSymbol`, `RelationEdge`, `ComplexityHotspot`, `FileChangeKind`, `ChangePattern`,
  `LanguageId` (ONE registry — kills the `SUPPORTED_LANGUAGES` vs `AST_GREP_LANGUAGES`
  drift), `ExtractorSkipped` (typed degradation event).

#### (3) `generation` — non-deterministic authoring behind a deterministic shell

- **Responsibility.** Plan the blast radius into objectives, fan out workers, author/repair
  specs, and reconcile the manifest against disk (deterministic logic pulled OUT of
  `opencode-client.ts:759-797` and `:1221-1483`). Prompt **policy** becomes domain
  objects/services; prompt **strings** become a thin rendering adapter (the 1499 lines).
  The reviewer severity gate (`GRAVE_TAGS` override, fail-closed on unparseable verdict)
  lives here.
- **Ports.** `AgentRuntimePort` (consumed FROM the shared-kernel — see §5.2; this decouples
  `generation` from `agent-runtime` and is a prerequisite for OQ1 library extraction),
  `ManifestRepositoryPort`, `VerdictParserPort` (free-form LLM text → structured
  deliverable/judgment), `PromptRenderingPort` **[SWAP]** (render domain prompt objects to
  provider strings), `DomGroundingPort` **[SWAP]** (e2e-only behavior; **degraded to a
  no-op for the code target** — see §3): the use-case ALWAYS receives a `DomGroundingPort`
  (never `undefined`), so it is called uniformly with no `if` branching. The composition root
  wires the real `PlaywrightDomGroundingAdapter` for e2e and a `NullDomGroundingAdapter`
  (returns an empty grounding context) for code-mode — absence is handled at the adapter
  boundary, not in the use-case.
- **Adapters.** `ManifestFileAdapter`, `PromptTemplateAdapter` (isolated strings),
  `PlaywrightDomGroundingAdapter` (e2e), `NullDomGroundingAdapter` (code-mode no-op).
- **`context` mode components** (mapped from `src/qa/context.ts` + `src/qa/context-pack.ts`).
  `architecture-context` VO (`ArchitectureContext` — validated provenance + well-formed
  sections; staleness flag); `ContextPackAssemblerUseCase` (assembles a per-objective
  `ContextPackResult` from architecture context + diff + extractor outputs; maps from
  `buildContextPack`). These live in `generation/application/` (the context pack is
  assembled before generation prompts are rendered, shaping what the generator sees).
- **Aggregates.** **`Manifest`** (root; `ManifestEntry` set reconciled against the working
  copy — a real invariant: ids unique, every entry maps to an on-disk spec).
- **VOs.** `GenerationPlan` (immutable value returned by `PlanGenerationService` —
  demoted from aggregate because it has no guarded state transitions; planned objectives +
  fan-out routing are a pure planning output), `GeneratorDeliverable` (was
  `GeneratorVerdict`), `ReviewJudgment` (was `ReviewerVerdict`; the authoritative publish
  gate), `Correction` (text + severity; plain string ⇒ blocking), `GraveTag`,
  `PlanObjective`, `ExplorationBrief`, `GroundingDiscipline`, `PromptSection`.

#### (4) `agent-runtime` — provider-agnostic session management (supporting/generic)

- **Responsibility.** Models WHO (`AgentRole`), WHICH (provider+model `RoleAssignment`),
  HOW (single/dual mode), plus health/restart, model catalogs, resilience, and the
  read-only role-capability security policy. Collapses the near-duplicate circuit-breaker
  logic (deliberately SEPARATE per-provider global state — a Codex outage must never trip
  the OpenCode breaker) and the copy-pasted `supervisorHealth`/`restart` into ONE
  provider-parameterized `ResilienceDecorator` that maintains INDEPENDENT state per provider
  instance (not one shared breaker keyed by provider). This isolation invariant is verified
  by a test BEFORE Step 6 deletes the originals. **Deletes the legacy `AgentDeps` string
  round-trip** (role→'qa-generator'→role); role is first-class end to end.
- **Ports.** `AgentRuntimePort` is defined in the shared-kernel (see §5.2) and implemented
  here by this context's adapters. Because `AgentRuntimePort`'s `openSession()` signature
  takes `role: AgentRole` (and `RoleAssignment` appears in the port surface), **`AgentRole`
  and `RoleAssignment` MUST co-locate in `shared-kernel/`** as shared vocabulary — otherwise
  the kernel forward-depends on `agent-runtime`, recreating the inverted dependency (§5.1
  Principle 3). See VOs below. `AgentRuntimeStrategy` **[SWAP — one per provider]**
  (`openSession`/`health`/`models`/`restart`), `TurnTelemetrySink` (replaces the direct
  `saveAgentTurn` import in both strategies), `TransportPort` **[SWAP]** (opencode serve
  HTTP / codex exec), `ModelCatalogPort`. `ProcessKillPort` is consumed FROM the
  shared-kernel (not owned here).
- **Adapters.** `OpenCodeStrategy`/`OpenCodeTransport`, `CodexStrategy`/`CodexExecTransport`,
  `ResilienceDecorator` (near-duplicate circuit-breaker logic with INDEPENDENT per-provider
  state — see Responsibility above), `StallWatchdogAdapter` (wraps `createStallWatchdog`/
  `withStallWatchdog` from `src/integrations/stall-watchdog.ts`; exposed as a **separate
  `StallWatchdogPort` alongside `ResilienceDecorator`** — Option B, committed: independent
  swappability per Principle 2; the stall watchdog's per-session attach/detach lifecycle is
  distinct from the breaker's retry loop and must not be coupled to it), `SseActivityAdapter`.
- **Aggregates.** none.
- **VOs / kernel-shared types.** `AgentRole` (8 members; **lives in `shared-kernel/`** as
  shared vocabulary required by `AgentRuntimePort`), `RoleAssignment` (**lives in
  `shared-kernel/`** — it appears in `AgentRuntimePort.openSession()` and must be
  kernel-resident so the kernel port never forward-depends on `agent-runtime/`; see §5.1 P3).
  The
  existing `AgentRuntimeConfig.assignments` covers 3 explicit roles (`primary`, `reviewer`,
  `chat`); the 5 extra roles resolve via the `assignmentForRole` fallback
  (`src/agent-runtime/types.ts:119-126`) — this is intentional simplification, NOT a bug.
  Extending `assignments` to all 8 keys would be a BREAKING change to the `opencode.json`
  config schema and requires a config-schema migration path; **preserve the fallback as a
  deliberate design choice**. `AgentRuntimeStatus` stays in `agent-runtime/`. `RunUsage`/
  `UsageSnapshot` **stay here** (no kernel leak). `StalledAgentError` is a kernel VO in
  the `InfraError` taxonomy (already defined in `src/errors.ts`; placed in
  `shared-kernel/domain-error.ts` in the new tree).

#### (5) `test-execution` — the deterministic harness (Filter B → Filter C → adjudicate)

- **Responsibility.** Static gate (tsc/eslint-playwright/playwright --list/manifest) →
  execute vs live DEV via Playwright OR run the repo's own suite by exit code → adjudicate
  failures and gate the fix-loop. The e2e/code split becomes TWO strategy adapters behind
  one port, not a 30-conditional fork. `killTree` is extracted to `ProcessKillPort` to
  break the `execute ⇄ dom-snapshot` runtime cycle. The three names for "app is broken"
  consolidate under `AppDefect`. `devHealthy()` is lifted out of the decision point into
  evidence assembly.
- **Ports.** `ExecutionStrategyPort` **[SWAP — two adapters e2e/code]**,
  `DeployGatePort` **[SWAP]** (absent for static sites and code target). `ProcessKillPort`
  is consumed FROM the shared-kernel `process-sandbox` module (see §5.2; consolidates the 4
  `killTree` definitions: `src/qa/execute.ts:64`, `src/qa/code-runner.ts:64`,
  `src/qa/static-signal/exec.ts:6`, `src/qa/learning/mutation-code.ts:10`); it is NOT
  defined here. Pure domain services `AdjudicateService`/`ProgressGateService`/
  `SelectorCheckService`/`NavGateService`.
- **Adapters.** `E2eExecutionStrategy`, `CodeExecutionStrategy` (per-language: node/python/
  go/rust/maven/gradle; exit-code classify, no browser, no flaky, no deploy gate),
  `StaticGateAdapter`/`CodeStaticGateAdapter`, `HttpDeployGateAdapter`, `StreamReporterAdapter`.
- **Domain services.** `AdjudicateService` (pure precedence-ordered failure classification —
  demoted from aggregate because adjudication is a stateless computation over evidence with
  no guarded lifecycle; returns `AdjudicationResult` VO), `ProgressGateService`,
  `SelectorCheckService`, `NavGateService`.
- **Aggregates.** `TestRun` (root — kept only because it guards a multi-round lifecycle
  invariant: a run in `running` state cannot be finalized twice; flaky classification
  requires round-by-round state tracking that cannot be collapsed to a VO).
- **VOs.** `AdjudicationResult` (returned by `AdjudicateService`; immutable record of the
  adjudicated verdict — replaces `FailureAdjudication` aggregate), `AdjudicationDecision`
  (was `AdjudicatorVerdict`), `AdjudicatorClass`/`AdjudicatorAction`/
  `AdjudicatorConfidence`, `AdjudicatorEvidence`, `RoundResult`, `GateDecision`,
  `AppDefect` (with 5xx httpStatus evidence), `DeployTarget`/`VersionInfo`, `CheckResult`.

#### (6) `objective-signal` — THE TRUST KEYSTONE (in the core, outside the agent)

- **Responsibility.** The non-LLM signal that breaks the generate/review circularity. Owns
  change-coverage (three modes `off|signal|enforce`) and the invariant **`decideCoverage`
  returns `unknown` ⇒ NEVER blocks**. Owns the value-oracle (mutation for code,
  fault-injection for e2e) behind ONE port, replacing today's `pipeline.ts:564` ternary.
  **Critical fix:** coverage collection gets a real `CoverageCollectorPort` (today
  `defaultCollectCoverage` hard-codes FS reads — the keystone's one weak spot).
- **Ports.** `DecideCoverageService` (pure domain service — the keystone gate),
  `CoverageCollectorPort` **[SWAP — NEW DI seam]**, `ValueOraclePort` **[SWAP — one port,
  two adapters]**, `SourceMapPort` (V8 byte-offset → original line).
- **Adapters.** `V8BrowserCoverageAdapter`/`C8CoverageAdapter`/`JaCoCoCoverageAdapter`/
  `LcovCoverageAdapter`; `StrykerMutationOracleAdapter` (code; injected FS — Stryker config
  is **never** written into the watched repo); `FaultInjectionOracleAdapter` (e2e; the
  `_faultInject` fixture / `.qa` marker convention).
- **VOs / read-models.** `ChangeCoverage` (Sha-keyed read-model — demoted from aggregate
  because it is a pure measurement result with no guarded state transitions; computed once
  per Sha and immutable), `Scorecard` (per-app read-model — demoted from aggregate; it is
  a projection of oracle results, not an entity with a protected lifecycle),
  `CoveragePolicy` (mode, `minRatio` default 0.7), `CoverageStatus`
  (`pass|fail|unknown`), `CoveredLines`/`CoveredBranches`, `ValueOracleResult`,
  `coverageCreditConfirmed` (the anti-Goodhart promotion anchor consumed by learning).
- **Carried forward VERBATIM:** `decideCoverage`/`blocksPublish`
  (verified at `change-coverage.ts:173/179`).

#### (7) `cross-run-learning` — the off-path flywheel (supporting; stub-able in v1)

- **Responsibility.** Turns each run's outcome into governed `LearningRule`s (asymmetric
  hysteresis), folds the objective value-score in, audits its own process, and retrieves
  high-value rules/exemplars into the prompt before generation. **Off-path by contract** —
  a failure is logged and swallowed, **never gates publish**. The cleanest removable slice:
  stub it in v1 and verdicts are unaffected. **Critical fix:** invert the two-way SQLite
  coupling (`history.ts` imports `applyOutcome`; distiller/retrieval import `history`) into
  a `LearningRepositoryPort`, making `RuleGovernance` the single source of ranking truth
  and deleting the duplicate `ORDER BY` in SQL (`history.ts:297`).
- **Ports.** `LearningRepositoryPort` **[SWAP]** (inverts the SQLite coupling),
  `RuleGovernanceService` (pure — single source of ranking/promotion), `RuleRetrievalService`
  (pure), `ReflectorPort` (LLM reflection, uses `AgentRuntimePort`), `ProcessAuditPort`.
- **Adapters.** `SqliteLearningRepository`, `LlmReflectorAdapter`, `LedgerReportRenderer`.
- **Aggregates.** **`LearningRule`** (root; trigger/action/errorClass/archetype/confidence/
  successRate/status; `applyOutcome` governance — a real invariant).
- **VOs / read-models.** `Curriculum` (read-model — demoted from aggregate; it is a
  retrieval projection of `LearningRule` rankings with no guarded state transitions).
  `RunOutcome` is **consumed from the shared-kernel** (`shared-kernel/run-outcome.ts`) —
  it is not defined here (see §5.3(1) and §5.2 kernel tree).
  `RuleStatus` (`candidate|active|deprecated|superseded` — **`pending` dropped**),
  `Confidence` (`high` reserved for oracle-proven), `ErrorClass` (**stays here, no kernel
  leak**), `StructuredReflection`, `ScenarioArchetype`, `SkillExemplar`, `StructuralPattern`,
  `ProcessFinding`/`Disposition`.

#### (8) `workspace-and-publication` — the VCS boundary + outbound side-effects (MERGED)

- **Responsibility.** The read/write git split and the PR/Issue side effect are the **same
  security-invariant concern** for a one-maintainer repo, so they are one context. The
  security invariant is made **structural**: only the write side mutates, and **only this
  context holds `VcsWritePort`** (generation and agent-runtime get `VcsReadPort`/none).
  Turns a `RunDecision` into a PR with auto-merge (green+approved), an Issue
  (fail/invalid/rejected), or a shadow-mode log line. Owns publish policy
  (skip-when-no-changes, auto-merge-then-direct-merge fallback, verdict-preservation on
  push failure) as a domain service (today mislabeled as adapters in `publish.ts`). Owns
  write-confinement. The `getPrStatus` promote-gate policy moves UP to control-plane
  self-maintenance. Egress sanitization enforced here.
- **Ports.** `VcsWritePort` **[SWAP — orchestrator-only; the security seam]**,
  `GitHubPrPort` **[SWAP — typed, not raw fetch]**, `GitHubIssuePort` **[SWAP]**,
  `MirrorGcPort`. `RedactionPort` is **consumed FROM the shared-kernel** (see §5.2
  `ports/redaction.port.ts`); this context does NOT own an independent redaction
  implementation — it applies the kernel's canonical `RedactionPort` adapter to egress
  sanitization. Prompt-budget capping (`capDiff`/`capText`) is a GENERATION concern, not
  a redaction concern: it lives at `generation/application/ports/prompt-budget.port.ts`,
  separate from `RedactionPort`.
- **Adapters.** `GitWriteAdapter`, `GitHubRestGraphqlAdapter`, `ShadowLogAdapter`
  (**the production strangler mechanism**), `ConfinementGitAdapter`, `MirrorPruneAdapter`.
- **Aggregates.** none. Write-confinement is stateless classification (`parseStatusOutput`
  → `isE2eStray`/`isCodeDenied`/`isDangerousPath` → result) with no identity and no
  lifecycle — it is a domain service, not an aggregate.
- **Domain services.** `WriteConfinementService` (pure stateless classification — maps
  `parseStatusOutput` output through confinement rules to a `ConfinementResult`; `parseStatusOutput`
  (`src/qa/confinement.ts:69`) stays here, NOT pulled into the kernel `DiffParserService`).
  `PublishService` (pure: decide PR vs Issue vs shadow vs quarantine vs no-op).
- **VOs.** `Publication` (result VO — demoted from aggregate; it is the immutable record of
  a completed publication side-effect with no guarded lifecycle after creation),
  `PublishDecision`, `PullRequest`/`PrState`/`Issue`, `AutoMergePolicy`,
  `ConfinementResult`, `IssueContext`.

#### (9) `app-catalog` — the watched-application aggregate + cross-repo routing

- **Responsibility.** Loads/validates app config (repo, baseBranch, dev, qa policy,
  `services[]`), resolves which app a webhook SHA belongs to (primary vs service repo),
  onboards/admins apps. Domain invariants currently trapped as zod refinements
  (dev-required-unless-code, unique service repos) become a real domain model.
  **App-specificity lives ONLY here** (CLAUDE.md invariant).
- **Ports.** `AppRepositoryPort` **[SWAP]**, `RepoResolutionService` (pure: SHA → App +
  RepoRole), `RepoInfoPort`.
- **Adapters.** `YamlAppConfigAdapter` (`${VAR}` expansion), `GitHubRepoInfoAdapter`.
- **Aggregates.** **`App`** (root; AppConfig — a real invariant set: dev required unless
  code target; service repo slugs unique WITHIN this app's `services[]` — an INTRA-app
  invariant; cross-catalog uniqueness, if ever needed, is enforced at the `AppRepository`
  level, not inside the aggregate).
- **VOs.** `ServiceConfig`, `RepoRole` (`primary|service`), `RepoMatch`, `DevTarget`,
  `QaPolicy`, `TriggerSource`.

#### (10) `control-plane` — HTTP driving side + persistence + self-maintenance

> In the folder tree this context is realized under `interface/` (http, queue,
> self-maintenance) + `composition/`. Persistence (`sqlite-run-history.repository`,
> `durable-run-event.store`) is infrastructure (driven side) and belongs under
> `contexts/control-plane/infrastructure/persistence/` in the final DDD layout — it is
> temporarily co-located under `interface/` for Phase-1 bootstrapping convenience. It is
> **not** the rewrite's gating target — it **drives** the seam.

- **Responsibility.** Webhook trigger, the **sequential `JobQueue`** (one run vs DEV — a
  hard invariant), the single run funnel (consuming `RunPipelinePort`), the Bearer REST/SSE
  API, Prometheus, auth, app onboarding, and the guarded self-maintenance pipeline
  (incident→fix→merge-guard→canary→boot-guard→promote — the most dangerous code, isolated
  behind one effect-bag). Decomposed (`api.ts` god switch → per-resource controllers;
  `history.ts` 4-context god file → four repositories behind ports; `computeTelemetryAnalysis`
  → a domain service) but its **external contract is FROZEN**. The `server/agent-runtime.ts`
  vs `agent-runtime/` name collision is resolved (server side becomes `agent-config-manager`).
- **Ports.** `WebhookPort` (driving: parse + verifySignature → RunRequest),
  `QueuePort` (driven: enqueue/cancel/drain — sequential one-at-a-time invariant),
  `RunHistoryRepositoryPort` **[SWAP]**, `RunQueryPort` (CQRS read side),
  `SelfMaintenancePort` (the guarded effect-bag).
- **Adapters.** `NodeHttpServerAdapter`, `WebhookController`/`RunController`/
  `AppAdminController`/`IntelligenceController`/`AuthController`, `SseStreamingAdapter`,
  `SqliteRunHistoryRepository`, `TypedEventBusAdapter`, `MergeGuardAdapter`/`CanarySwapAdapter`/
  `JwtAuthAdapter`.
- **Aggregates.** **`RunQueue`** (root; sequential one-at-a-time + continuation-depth
  invariant — a real lifecycle: a queued run blocks all others until completion),
  **`Incident`** (root; durable, drives irreversible self-deploy — **promoted to DURABLE
  storage** to match its irreversible consequences, fixing the in-memory-ring asymmetry).
- **VOs / entities.** `Session` (entity/VO — demoted from aggregate; a JWT principal has
  no guarded state transitions that require aggregate-level protection), `RunRequest`,
  `ApiVersion`/`Capabilities`, `ChangeStat`/`GateResult`, `SwapMarker`/`PendingPromote`,
  `TrendsView`/`ReportView`/`SignalsView`/`IntelligenceView` (CQRS read projections),
  `ContinuationDepth`.

---

## 6. How Code-Mode Reaches Parity

The original motivation was bringing E2E-only capabilities to code-mode. In the new
architecture **code-mode is the second adapter on shared ports**, not a forked branch.
The amber gaps map cleanly onto contexts:

| Amber gap (code-mode missing E2E capability) | Where it lands | Mechanism |
|---|---|---|
| **Static change analysis** | `change-analysis` (already has it) | tree-sitter/ast-grep/lizard already cover ts/js/java; code-mode reuses the same extractor ports. |
| **Objective signal (coverage)** | `objective-signal` `CoverageCollectorPort` | per-language coverage adapters: **c8 (done)**, **JaCoCo (new)** — injected **non-invasively at runtime, never committed to the watched repo**. Unsupported ecosystem ⇒ `unknown` ⇒ never blocks (§3). |
| **Authoring** | `generation` | a **code-authoring concern**: the agent writes tests in the repo's own framework; `PromptRenderingPort` renders backend-aware prompts; `DomGroundingPort` is **absent** (§3). |
| **Execution** | `test-execution` `CodeExecutionStrategy` | second `ExecutionStrategyPort` adapter: per-language runner, exit-code classify, no browser, no flaky, no deploy gate. |
| **Review** | `generation` reviewer | **backend-aware reviewer criteria** instead of DOM/selector evidence. |
| **Value oracle** | `objective-signal` `ValueOraclePort` | `StrykerMutationOracleAdapter` (code) vs `FaultInjectionOracleAdapter` (e2e) — one port, two adapters, replacing the `pipeline.ts:564` ternary. |

**Out of scope by definition (§3):** no DOM/observable-UX, no universal coverage instrument
(per-ecosystem only), no live-deployed-system validation. **Cross-repo code-mode is debt,
not impossible.**

**Staging (§2.3 C4).** In v1 every code-mode port and adapter in this table is **defined, encapsulated, and fragmented** — the seams exist and compile — but the **deep implementation is deferred to stage 2**, after the e2e flow is switched in and stable. v1 ships the interfaces (and thin/stub adapters where needed); the heavy code-mode work (real non-invasive JaCoCo injection, backend-aware authoring, backend reviewer rubric) lands once the current flow is trusted. The fragmentation is the v1 win; the depth is YAGNI until then.

---

## 7. Migration Plan

Two phases. The seams are pre-identified; the order is risk-minimizing (leaves first,
the verdict core last).

### 7.1 The seams (from the dependency-graph analysis)

| Seam | What it is | Prerequisite |
|---|---|---|
| **Seam 1 (PRIMARY)** | `RunPipelinePort` over `runPipeline(opts, deps)` — the strongest seam. `PipelineDeps` (~45 methods, `pipeline.ts:132`) + `runPipeline` (`:827`) already form a branch-by-abstraction interface with **1 function call site, 2 module importers**: the FUNCTION `runPipeline` has exactly 1 call site (`server/runner.ts:120`, `enqueueTrackedRun`); the MODULE `pipeline.ts` has 2 importers (`runner.ts:9` and `index.ts:22`). `index.ts` is the composition root: `currentPipelineDeps()` (`index.ts:129`) builds the deps and passes them to `enqueueTrackedRun` at two sites (`index.ts:210`, `index.ts:479`). 44-out apex, 2 module importers, 1 function call site — no import cycle. | none |
| **Seam 2** | `AgentRuntimePort` over `opencode-client` `AgentDeps` — the deterministic↔non-deterministic HTTP boundary (hotspot, 30 total degree). | break the opencode-client ⇄ prompts **type-only** cycle by moving `OpencodeRunInput`/`ReviewInput`/`ParallelWorkerInput` into a cycle-free generation-ports module. |
| **Seam 3** | `ExecutionStrategyPort` over `execute` `defaultExecuteDeps` + `code-runner` — the Playwright/exit-code boundary, already DI-shaped. | extract `killTree` to `process-kill.adapter.ts` to break the `execute ⇄ dom-snapshot` **runtime** cycle (a real cycle, not optional). |
| **Seam 4** | `LearningPort` over the cross-run-learning ⇄ server/history two-way SQLite coupling — the cleanest **removable** slice (off-path, fail-open). | can be **stubbed entirely** in v1. |
| **Seam 5 (the cutover lever)** | shadow mode (`qa.shadow:true`) — the production strangler. | none — no new infrastructure. |

### 7.2 Phase 1 — Build in parallel (no `src/` behavior change)

Guarded by **three safety mechanisms** (locked decision):
**(a)** a characterization golden net built FIRST; **(b)** a transparent `LegacyPipelineAdapter`
shipped first and proven byte-identical before any rewrite; **(c)** wrap-then-replace the
deliberately-uncovered boundaries behind clean ports.

| Step | Action |
|---|---|
| **0 — FREEZE** | Freeze two boundaries for the whole migration: the `PipelineDeps` interface (`pipeline.ts:132`) + `runPipeline(opts, deps)` signature (the immovable seam), and `contract/openapi.json` (its drift-guard fails CI if regenerated). The rewrite strangles `pipeline.ts` orchestration **only**; no `src/` change perturbs the running E2E flow. |
| **1 — Safety net (a)** | Build `qa-engine/test/characterization/` FIRST, before any engine code: a golden-outcome harness that replays ALL `runPipeline` call sites in **both** test files — the **182 `pipeline.test.ts` stub scenarios** AND the **4 Codex scenarios in `pipeline-codex.test.ts`** (= **186 total** `runPipeline` invocations) — through both engines and asserts `(verdict, sideEffect, persisted RunOutcome)` tuples. Scope must include both files; omitting `pipeline-codex.test.ts` creates a Codex false-green blind spot. Plus the **10-scenario** sanitized `RunOutcome` JSON matrix (green-PR, fail-Issue, flaky-quarantine, no-op-skip, invalid-Issue, infra-error, code-mode, cross-repo, shadow, **context** — the context-mode run using `ArchitectureContext` + staleness from `src/qa/context.ts` and `buildContextPack` from `src/qa/context-pack.ts`). **Reuse existing fixtures — author no new scenarios.** |
| **2 — Verify the net** | Wire and run **Stryker** on `decideCoverage`/`blocksPublish` (`qa/change-coverage.ts`) to **confirm the characterization tests kill mutants**. Concrete plan: install `@stryker-mutator/core` + `@stryker-mutator/node-test-runner` + `@stryker-mutator/typescript-checker` (the typescript-checker ensures only semantically-valid mutations count — transpile-error kills do not inflate the kill rate). Config lives at `qa-engine/stryker.conf.json` (an explicit dedicated config, separate from `src/qa/learning/mutation-code.ts`'s generated config). `--mutate` is scoped to `src/qa/change-coverage.ts` only with absolute paths. `thresholds.break` is set to a concrete kill rate (≥ 80%) — NOT `null`; a failing threshold fails CI. Mutant budget cap (~30 sampled) keeps runtime to minutes. Non-negotiable: verify the net has no holes before trusting it. |
| **3 — Scaffold** | Scaffold `qa-engine/` (own package.json + strict tsconfig + node:test) path-mapped into the root gate so `npm test` + `npm run typecheck` cover BOTH trees. **Settled mechanism for tests:** add `"qa-engine/test/**/*.test.ts"` to the root `npm test` glob alongside `--import ./test-setup.mjs` (resolved relative to the repo root — the same per-process SQLite isolation path already in use); `test-setup.mjs` is **preserved verbatim** and the path resolves from the repo root. `qa-engine` as an npm workspace is a fallback only. **Settled mechanism for typecheck:** add TypeScript project references (`references: [{ path: "./qa-engine" }]` in the root tsconfig.json, and a composite `qa-engine/tsconfig.json`) OR add an explicit `tsc -p qa-engine` to `npm run typecheck` — either ensures qa-engine type errors are caught at the root gate. `qa-engine/test/**/*.test.ts` starts as pure unit tests (no server/DB dependencies), so the glob extension is low-risk for Phase 1. Establish the shared-kernel with ZERO downstream dependencies — sever the `types.ts`→taxonomy/usage leak by inversion. |
| **4 — Ports only** | Define ALL bounded-context ports (interfaces only, no adapters). Pure type modules compiling against nothing external. Lift the cleanest existing ports nearly as-is (`AgentRuntimeStrategy`, the extractor map, `ExecuteDeps`/`ValidateDeps`/`SetupDeps`/`CaptureDomDeps`, `FaultInjectionDeps`, `DurableRunEventDeps`). |
| **4b — Break the Seam-2 type cycle** | Move `OpencodeRunInput`, `ReviewInput`, and `ParallelWorkerInput` out of `src/integrations/opencode-client.ts` into a cycle-free `generation-ports` module (e.g. `qa-engine/src/contexts/generation/application/ports/generation-ports.ts`). Update `src/integrations/prompts.ts` to import these types from the new module rather than from `opencode-client.ts`. This breaks the `opencode-client ⇄ prompts` type-only cycle (Seam-2 prerequisite) and is required before `AgentRuntimePort` can be extracted cleanly in Step 8. No behavior change; types only. |
| **5 — Leaf/pure contexts** | Build LEAF/PURE contexts first (lowest risk, highest reuse): `objective-signal` (carry `decideCoverage`/`blocksPublish` **VERBATIM**, add the real `CoverageCollectorPort`), `change-analysis` (lift `classifyCommit` + static-signal; the 3 diff-content parsers — `parseDiffHunks`, `parseChangedFiles`, `changedFilesFromDiff` — are already consolidated into `DiffParserService` in the shared-kernel at Step 3; `parseStatusOutput` stays in `workspace-and-publication`'s `WriteConfinementService`, `parsePorcelain` stays in `test-execution`'s `CodeExecutionStrategy`), and the pure `test-execution` decision cores (adjudicator/progress-gate/selector-check/nav-gate). Each ships tests green. |
| **6 — Wrap (c)** | Build adapters by **wrapping the proven `src/` integrations** (delegate, don't rewrite): opencode/codex strategy adapters delegate to existing `opencode-client`; execution-strategy adapters delegate to existing `execute.ts`/`code-runner.ts`; coverage adapters delegate to existing collectors. The PURE cores (Step 5) are ported by **copy+characterize**, not wrapped. **Migrate `killTree` import sites:** `validate.ts`, `setup.ts`, and `dom-snapshot.ts` currently import `killTree` from `execute.ts` — update all three to import from the kernel's `process-kill.adapter.ts` instead. Without this, the `execute ⇄ dom-snapshot` runtime cycle is not actually broken in Phase 1 (both still share `execute.ts` as the `killTree` source). |
| **7 — Supporting contexts** | Build `workspace-and-publication` (read/write `VcsPort` split = the security invariant made structural) and `app-catalog` (app invariants as domain rules). Invert `cross-run-learning` off its SQLite coupling via `LearningRepositoryPort` (delete the duplicate SQL ranking `ORDER BY`). |
| **7b — Incident durability migration** | Add a durable `incidents` table to the SQLite schema (column set: id, app, sha, message, at, resolved, metadata JSON). Update `src/server/maintainer.ts` read and write paths to use this table instead of the in-memory ring. Add a restart-survival regression test at `qa-engine/test/contexts/control-plane/incident-durability.test.ts`: boot → write an Incident → restart the process → assert the Incident is readable. This step is a strict improvement (durability ↑, no behavior regression), isolated from the active self-maintenance code path, and is the ONLY control-plane step that lands in Phase 1 — everything else in `control-plane`/`interface/` migrates in Phase 2. |
| **8 — Runtime + generation** | Build `agent-runtime` as the clean port (collapse duplicated breakers into one `ResilienceDecorator`, delete the legacy `AgentDeps` round-trip, role first-class). Then `generation`: pull `GenerateTestsUseCase` + `FanOutUseCase` + manifest reconciliation out of `opencode-client.ts`; isolate the 1499 prompt lines behind `PromptRenderingPort`; cover manifest-reconcile + fan-out with characterization tests BEFORE extraction. A pre-extraction exploration (part of this step) identifies the orphan test files — test files in `src/integrations/` that test logic now being moved to `generation/` but whose module boundaries no longer align with the source they cover — so they can be re-homed in `qa-engine/test/contexts/generation/` before the extraction begins. |
| **9 — Legacy adapter (b)** | Implement `legacy-pipeline.adapter.ts` satisfying `RunPipelinePort` by calling the **unchanged** `src/ runPipeline`. Run the golden harness against it: it must produce **structurally equivalent `RunOutcome`** to direct `runPipeline` — same verdict, sideEffect chosen, coverageRatio, and persisted rationale per §10 (fields such as `at` (timestamp) and `runId` (uuid) differ per invocation and are excluded from the equivalence check). This proves the facade is transparent BEFORE any orchestration rewrite ships — the safest possible first switch. `contract/openapi.json` remains byte-identical throughout (external equivalence is the stricter standard). |
| **10 — The core LAST** | Build `qa-run-orchestration` (it depends on every port): the `Run` aggregate, the single `RunDecision`, the `FixLoop` budgets, `RunQaUseCase`. Drive it entirely through segregated ports — **no inline IO**. After each phase (gate, analyze, generate, review, validate, execute, coverage, decide) is wired, run the golden harness comparing rewritten-orchestrator output against legacy-pipeline output; a phase is "done" only when its slice of the **186 scenarios** (182 `pipeline.test.ts` + 4 `pipeline-codex.test.ts`) passes identically. Stand up `composition/composition-root.ts` (`buildProduction`/`buildShadow`). **Undeclared divergence fails CI.** Map the post-function exported helpers from `pipeline.ts` to their new homes: `foldRunLearning` → `cross-run-learning` application; `buildFailureDom`/`foldValueLearning` → `test-execution` domain; `deriveCycleBackstop`/`shouldDistillLearning` → `qa-run-orchestration` domain helpers. |

### 7.3 Phase 2 — The switch (flag + shadow strangle)

| Step | Action |
|---|---|
| **1 — Formalize the seam** | Formalize `RunPipelinePort` over `runPipeline` (the abstraction is 90% there). The FUNCTION `runPipeline` has exactly 1 call site (`runner.ts:120`, `enqueueTrackedRun`) — update it to dispatch via `RunPipelinePort` instead of calling `runPipeline` directly. The MODULE `pipeline.ts` has 2 importers (`runner.ts:9` and `index.ts:22`). The complete switch surface is **THREE sites**, all of which must be updated in this step: (a) `runner.ts:120` — dispatch via `RunPipelinePort` instead of calling `runPipeline` directly; (b) `index.ts`'s `currentPipelineDeps()` (`index.ts:129`) — wire through the composition-root factory (`buildProduction`/`buildShadow`) so `index.ts` never builds raw `PipelineDeps` outside the flag; (c) `cli.ts:116` — `enqueueTrackedRun` is called here WITHOUT a `pipeline:` dep in `RunnerDeps`, so `runner.ts:103`'s `?? defaultPipelineDeps()` fallback fires regardless of the flag — `cli.ts` must explicitly pass `pipeline: buildProduction()` (or `buildShadow()` when `appCfg.qa.shadow`) in its `RunnerDeps` to the `enqueueTrackedRun` call, and `runner.ts`'s `?? defaultPipelineDeps()` fallback must be made flag-aware (consult the composition root) rather than hardwiring the legacy path. Without (c), every manual `npm run qa` run bypasses the flag and always executes legacy. Do NOT add a second port-call site in `index.ts`; `currentPipelineDeps()` is the composition-root concern (it supplies deps to `enqueueTrackedRun` at `index.ts:210` and `index.ts:479`), not a port invocation. No behavior change; default the factory to `LegacyPipelineAdapter`. |
| **2 — The flag** | Add a single feature flag `PIPELINE_ENGINE=legacy\|rewritten` (default `legacy`) in composition-root selecting `LegacyPipelineAdapter` vs `RewrittenOrchestratorAdapter` behind `RunPipelinePort`. Both satisfy the same port + same `PipelineDeps` inputs, so **neither caller nor the 44 downstream modules change**. The switch surface is all three entry points updated in Step 1: `index.ts` (webhook), `cli.ts` (manual), and `runner.ts`'s fallback (now flag-aware). |
| **3 — Shadow strangle** | Enable the rewritten engine via `buildShadow()` for repos already in `qa.shadow:true`. Run BOTH engines **SEQUENTIALLY within the same queue slot** — legacy engine first (full run, side effects as normal), then the rewritten engine in shadow (no side effects; substitutes every PR/Issue with a log line) — and diff verdicts at job completion via the parity allowlist. This preserves the `RunQueue` one-run-against-DEV invariant: only one agent touches DEV at a time. **Working-copy isolation:** the shadow run MUST begin with a full `prepare()` (working-copy reset: `git checkout -f` + `git clean -fd`) so it sees a clean tree after the legacy run wrote spec files; without this, the shadow sees legacy-authored spec files as pre-existing and its verdict may diverge for the wrong reason. **Read-state isolation:** the shadow engine's `RunHistoryRepositoryPort` MUST read a pre-run snapshot of run history (or open a read-only DB connection before the legacy run starts) so the legacy run's persisted outcome does NOT contaminate the shadow engine's verdict; the shadow reads the state the world was in BEFORE the legacy run, not after. **Scope restriction:** limit initial shadow rollout to repos with `qa.parallelDiff: false`. When `qa.parallelDiff: true` is active, the legacy engine fans out parallel worker slots; the parent-slot shadow does not cover these child continuation slots, so a shadow verdict from the parent alone does not represent the full parallel run — parallel-diff shadowing requires a separate mechanism and is out of scope for the initial shadow window. Scope shadow to a small repo set (all with `parallelDiff: false`) and a bounded soak window. The intended shadow-mode onboarding path repurposed as the cutover mechanism. |
| **4 — Promote one repo** | Promote ONE real (non-shadow) repo at a time behind the flag once its shadow verdicts have matched legacy for a sustained window. **Start with the lowest-stakes app — the public Astro static portfolio.** Keep legacy one flag-flip away for **instant rollback with zero code change**. |
| **5 — Incremental cutover** | Cut over remaining repos incrementally; each gated on sustained shadow parity for that repo. |
| **6 — Delete + replace** | After the rewritten engine runs clean across all repos for the agreed soak window, delete `LegacyPipelineAdapter` and `src/pipeline.ts`. Then progressively replace the wrapped `src/` integrations with native `qa-engine` implementations context-by-context, lowest-risk first (change-analysis cores → objective-signal → execution → **generation last**), removing the temporary wrap scaffolding. Migrate the control plane (`server/`, `index.ts`, `cli.ts`) onto `qa-engine/interface/*`. **Self-maintenance migrates dead-last** (§8). |
| **7 — Final** | `contract/openapi.json` + the SDK are unchanged end to end — external clients never observed the swap. |

---

## 8. Risks & Mitigations

Ordered by blast radius. **FALSE GREEN first** — it is the catastrophic class.

| # | Risk | Mitigation |
|---|---|---|
| **R1** | **FALSE GREEN (catastrophic).** A rewritten decide step that flips one branch commits a meaningless/broken test into a watched repo via PR + auto-merge. The whole project's risk is **trust, not engineering**. | `RunDecision`/verdict-policy is the **FIRST** thing characterized (182 scenarios) and the **LAST** thing trusted (shadow-diff before any real side effect). **Never flip `PIPELINE_ENGINE` on a non-shadow repo until shadow parity is clean.** |
| **R2** | Losing **"unknown coverage NEVER blocks"** (and "signal never blocks"). A reimplemented `decideCoverage` that starts blocking would freeze every cross-repo and unmeasured run. | `decideCoverage`/`blocksPublish` ported by **copy** (pure, verified at `change-coverage.ts:173/179`), pinned by a dedicated golden assertion + Stryker. |
| **R3** | **Swallowed integration errors** (a CLAUDE.md invariant). A swallowed agent/runner/git error once looked like a silent false no-op ("no tests written"). | `Result<T,E>` + loud-throw discipline enforced; the parity suite asserts `infra-error` is **emitted**, not absorbed; the wrap-existing-integration strategy inherits the proven throwing behavior. |
| **R4** | **Security-boundary inversion.** The read/write `VcsPort` split must guarantee generation/agent-runtime NEVER hold `VcsWritePort` (agent-is-read-only invariant). | **Structural:** only `workspace-and-publication` imports a write adapter; the arch-lint gate is a `node:test` test at `qa-engine/test/arch/vcs-write-confinement.test.ts` using `dependency-cruiser` (added as an explicit devDependency) to assert that no module under `generation/*` or `agent-runtime/*` imports `vcs-write.adapter.ts` or `VcsWritePort`. Known limitation: `dependency-cruiser` may miss dynamic imports and barrel re-exports — these are listed as test-scope exclusions in the config and flagged for manual audit on any pattern change. This test runs as part of `npm test` **and is a prerequisite before any context code is written in Step 4** — the gate must be green before the boundaries it enforces are populated. Fails CI on violation. |
| **R5** | **Wrap-then-replace can ossify leaks.** Wrapping a leaky `src/` integration behind a clean port risks the leak surviving forever. | Phase-2 Step 6 explicitly schedules native replacement context-by-context post-cutover, lowest-risk first; the port face is the contract, the wrap is temporary scaffolding. |
| **R6** | **Context-boundary over-isolation.** 10 contexts is a large remodel for a one-maintainer project; per-context boilerplate can stall delivery. | Build leaf contexts first for early wins; keep supporting subdomains (learning, agent-runtime) thin; Workspace+Publication already merged. Treat the count as a **target, not a mandate** — collapse another pair if a boundary proves artificial. |
| **R7** | **Test-process DB isolation loss** (`test-setup.mjs`) — drops determinism and erodes trust in the net itself. | Preserved verbatim; `qa-engine` tests run under the same `--import ./test-setup.mjs`. |
| **R8** | **Contract drift.** Regenerating `contract/openapi.json` mid-rewrite breaks every SDK consumer. | The byte-identical drift-guard is frozen; never run `contract:gen` during migration unless a deliberate, versioned API change is intended. Equivalence is two-tier (§10). |
| **R9** | **Dual-engine cost + queue-slot extension during the shadow window** — two FULL pipeline executions (each including agent generation AND Playwright execution) per shadowed job slot (legacy first, then shadow), doubling wall-clock and browser time per slot while shadow is active. Running them in parallel would violate the `RunQueue` one-run-against-DEV invariant (two agents would race on DEV simultaneously). | **Operational mitigation:** engines run sequentially within the same queue slot (legacy → shadow), never concurrently against DEV. A working-copy `prepare()` and a pre-run read-state snapshot separate the two runs (§7.3 Step 3). Scope shadow to a small repo set, a bounded soak window, and off-peak scheduling if slot-duration cost is unacceptable. The `RunQueue` invariant is preserved. |
| **R10** | **Self-maintenance is the most dangerous and least-decomposed code.** Rebuilding it under the new architecture in Phase 1 risks the irreversible canary/promote/hot-swap path. | Keep it running on the **OLD** code path and migrate it **dead-last** (its merge-guard, named-required-CI-check, and boot-guard rollback are the outer safety net); only move incidents to durable storage (a strict improvement) early. |

---

## 9. Decisions: Settled vs Open

### 9.1 Settled (locked by the user — do not relitigate)

- **Full rewrite into a new `qa-engine/` folder, parallel to `src/`** (branch-by-abstraction),
  Hexagonal + Clean + **tactical/selective DDD**.
- **Exactly 10 bounded contexts** (Workspace+Publication already merged; no further collapse).
- **Selective aggregates** only where a real invariant exists. Settled set — **7 aggregates**
  (each with invariant justification):
  - `Run` — guarded lifecycle (gate→analyze→generate→validate→execute→decide); identity = RunId+Sha+App.
  - `FixLoop` — cycle and wall-clock budget invariants; transitions guarded (cannot exceed MAX_CYCLES or wallClockBudget).
  - `LearningRule` — promotion/demotion state machine (`candidate→active→deprecated→superseded`); `applyOutcome` governance guards confidence and successRate transitions.
  - `Manifest` — ManifestEntry set reconciled against disk; invariant: ids unique, every entry maps to an on-disk spec.
  - `App` — dev required unless code target; service repo slugs unique within `services[]` (INTRA-app invariant).
  - `RunQueue` — sequential one-at-a-time invariant; a queued run blocks all others; continuation-depth is bounded.
  - `Incident` — durable record driving irreversible self-deploy (canary→promote); must survive restart.
  `WriteConfinement` is NOT an aggregate: it is a stateless `WriteConfinementService` (domain
  service — `parseStatusOutput` → classification → `ConfinementResult` VO) with no identity
  and no lifecycle; demoted accordingly (§5.3(8)). `TestRun` (multi-round lifecycle,
  `test-execution` context) is an implementation-level aggregate not locked at this level —
  see §5.3(5). Value objects + ubiquitous language YES; no aggregates/repositories/
  domain-events imposed everywhere. Everything else is a VO, read-model, domain service,
  or entity as noted in §5.3.
- **Three Phase-1 safety mechanisms:** characterization golden net first + Stryker
  verification; transparent `LegacyPipelineAdapter` proven byte-identical first;
  wrap-then-replace the uncovered boundaries.
- **Phase-2 switch:** single flag `PIPELINE_ENGINE=legacy|rewritten` + shadow strangle;
  promote one repo at a time starting with the Astro portfolio; instant rollback by flag flip.
- **Primary seam:** `RunPipelinePort` over `runPipeline(opts, deps)` — 1 function call site
  (`runner.ts:120`, `enqueueTrackedRun`), 2 module importers (`runner.ts:9` and `index.ts:22`).
  `index.ts` is the composition root: `currentPipelineDeps()` (`index.ts:129`) builds deps and
  passes them to `enqueueTrackedRun` at `index.ts:210` and `index.ts:479` — a distinct concern,
  not a port call. No import cycle.
- **Renames DEFERRED to post-cutover** (`Verdict`×4 → `RunVerdict`/`GeneratorDeliverable`/
  `ReviewJudgment`/`AdjudicationDecision`; `app-is-broken`×3 → `AppDefect`) to minimize
  parity-diff noise.
- **Self-maintenance migrates DEAD-LAST** (only incidents move to durable storage early).
- **Cross-run learning ships STUBBED in v1** (off-path, never gates publish).
- **Five cross-cutting cleanups (§2.3):** unify naming under `panchito` (C1); tests in a mirror `test/` tree with path aliases (C2); deep comment cleanup (C3); code-mode ports ready in v1 with deep impl deferred to stage 2 (C4); SOLID/DRY/KISS/YAGNI throughout, no regressions (C5).

### 9.2 Open (recommended default given for each)

| # | Open question | Recommended default |
|---|---|---|
| **OQ1** | **Library-extraction scope** (the stated Phase-2 goal): which slice is the "portable QA engine" — just `qa-run-orchestration` + `objective-signal` + `test-execution` + `generation`, or also `cross-run-learning` and `agent-runtime`? | **Hold 10 contexts; keep `agent-runtime` separable** as a generic subdomain inside the engine with its own published port, so it can later become a peer dependency. Do NOT fold it into `generation` — that re-entangles the extraction seam. |
| **OQ2** | **Soak window + rollout granularity:** how long should the rewritten engine run clean in shadow per repo before flipping, and is cutover strict repo-by-repo or a global flip once parity holds? | **Strict repo-by-repo**, starting with the Astro portfolio, with a bounded per-repo soak window (sets the dual-maintenance + doubled-agent-cost duration). Global flip only after every repo has individually held parity. |
| **OQ3** | **Learning-parity timing:** ship the rewritten engine with learning STUBBED initially (off-path, never gates publish) and fill adapters after the core switch, or require learning parity before the first real-repo cutover? | **Ship stubbed**, fill learning adapters post-cutover. The engine is fully correct without learning (fail-open by contract). |
| **OQ4** | **Persistence backend for the learning ledger:** keep better-sqlite3 behind `LearningRepositoryPort`, or design the port for a swappable store now? | **SQLite-only behind the port until extraction.** The port already inverts the coupling; design a second store only when library extraction (OQ1) is actually scheduled. |

> A fifth secondary question from the synthesis — **renames during cutover vs after** — is
> already resolved by the locked decisions (§9.1: defer to post-cutover). It is listed here
> only for traceability, not as open.

---

## 10. Success Criteria / Equivalence

Equivalence is **two-tier** and both tiers must hold before any non-shadow cutover:

1. **Internal equivalence.** For **identical `PipelineDeps` inputs**, the rewritten engine
   produces a **structurally equivalent `RunOutcome`** — same `(verdict, RunRecord.outcome`
   (the human-readable side-effect string the rewritten engine maps to), `coverageRatio,
   persisted rationale)` — to the legacy engine. Fields that are inherently per-invocation
   (`at` timestamp, `runId` uuid) are excluded from the equivalence check;
   they will always differ. Proven by the golden-outcome harness replaying all **186
   `runPipeline` invocations** (182 from `pipeline.test.ts` + 4 from
   `pipeline-codex.test.ts`) + the **10-scenario** `RunOutcome` snapshot matrix through
   both engines. **Undeclared divergence fails CI.** Intentional divergences get a
   documented entry in `qa-engine/test/characterization/parity-allowlist.json` with the
   shape `{ scenarioFingerprint: string, divergenceDescription: string, approver: string }`;
   where `scenarioFingerprint` is a stable hash of the scenario NAME string (not fixture
   data) — so fixture edits never silently break allowlist entries; the golden harness reads
   this file and suppresses CI failure only for declared entries; any undeclared divergence
   fails the gate unconditionally.

2. **External equivalence.** `contract/openapi.json` is **byte-identical** end to end; the
   SDK is unchanged. External clients never observe the swap. The drift-guard test is frozen
   for the duration of the migration. Note: "byte-identical" applies ONLY to this external
   contract artifact, not to internal `RunOutcome` fields (see tier 1 above).

**Additional gates that must stay green throughout** (the existing project gate, extended to
both trees): `npm test`, `npm run typecheck` (strict, `noUncheckedIndexedAccess`), CI, and
Stryker confirming the characterization net kills mutants on the verdict policy and
`decideCoverage`/`blocksPublish`.

**Definition of done for the rewrite:** the rewritten engine has held shadow parity per repo,
every repo has been promoted behind the flag, `LegacyPipelineAdapter` + `src/pipeline.ts` are
deleted, the wrapped `src/` integrations are natively replaced context-by-context, and the
control plane runs on `qa-engine/interface/*` — with the external contract never having moved.

---

## 11. Implementation-time checklist (deferred to writing-plans / apply)

Items the design doc intentionally does NOT resolve — tracked here so they are not lost.

- **`RuleStatus.pending` back-compat.** The `SqliteLearningRepository` read path must map
  legacy `'pending'` rows → `'candidate'` before typing. Current `learning-rule.ts:12`
  preserves `pending` for legacy DB rows; the migration must retain this mapping or existing
  SQLite data will fail to deserialize after the schema upgrade.

- **C1 panchito-rename checklist.** Complete set of rename sites to sweep in a single
  clean-state step (after scaffold at §7.2 Step 3, before ports at Step 4):
  - `package.json` `name` field
  - `docker-compose.yml` and `docker-compose.override.yml` service names and container names
  - `PANCHITO_REPO` and `PANCHITO_ROOT` env vars (all references in `src/`, compose,
    and docs)
  - `SELF_REPO` default value in `src/index.ts`
  - `CLAUDE.md` strings that reference the old name
  - Any remaining in-code string literals, log prefixes, or config keys

- **Persistence move trigger.** The design defers persistence to `interface/` for Phase-1
  bootstrapping and targets a move to `contexts/control-plane/infrastructure/persistence/`
  in the same step as control-plane extraction (§7.3 Step 6). The trigger for the move
  should be measurable — e.g. "after 2 repos have held parity for a sustained soak window
  under the rewritten engine" — not vague "after Step 4/5". Define the concrete gate before
  §7.3 Step 6 is scheduled.

- **Re-run dependency-graph re-analysis at implementation time.** All `file:line` references
  in this doc cite the re-analysis snapshot (§4 note). Re-run the 15-agent analysis against
  HEAD before Phase 1 begins to refresh line numbers, file sizes, and import counts.

- **Redaction sweep.** Two divergent placeholder strings exist in `src/`:
  `[REDACTED_SECRET]` (`orchestrator/sanitizer.ts`) and `[REDACTED_CREDENTIAL]`
  (`util/redact.ts`). The canonical placeholder in the rewrite is `[REDACTED]`. Before
  migrating either redaction adapter, sweep all call sites to replace the non-canonical
  placeholders with `[REDACTED]` so the unification is complete at migration time.
