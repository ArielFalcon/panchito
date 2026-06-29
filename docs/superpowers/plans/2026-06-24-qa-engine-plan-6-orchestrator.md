# QA Engine — Plan 6: The Core Orchestrator (`qa-run-orchestration`) + `LegacyPipelineAdapter`

> **Sub-skill:** `superpowers:writing-plans` → executed via `superpowers:executing-plans`.
> Each task is TDD: write a failing test → run it (see it fail) → minimal impl → run it (see it pass) →
> parity/characterization check → isolated gate → commit. Conventional commits, **NO `Co-Authored-By` /
> NO AI-attribution trailer**. One logical change per commit.
> **Commit discipline (every task):** stage **explicit `qa-engine/` paths only**. NEVER `git add -A`.
> The ONLY permitted `src/` touch in the entire plan is the single runner/CLI flag-dispatch seam in
> **Slice E (Task E.3)** — dispatch only, the default-legacy path's behavior is unchanged. The user has
> heavy uncommitted WIP under `src/qa/*` (`dom-snapshot.ts`, `context-pack.ts`, `changed-elements.ts/.test.ts`,
> `selector-check`), `agents/`, and `agent*/` — **protect it. DO NOT EDIT `src/qa/dom-snapshot.ts`.**

## Goal

Build the **integrator** context — `qa-run-orchestration` — that replaces the 3,276-line `runPipeline`
god-function, AND the strangler safety net that proves the replacement is behavior-equivalent BEFORE any
rewritten decision logic is trusted. This is the plan where the false-green risk (the dominant risk of the
whole rewrite) is contained by a **literal ordering gate**.

The deliverables, in dependency order (the order IS the safety property):

1. **`LegacyPipelineAdapter`** (WRAP) — implements `RunPipelinePort.run(RunInput)` by delegating to the
   **unchanged** `src/pipeline.ts` `runPipeline` and mapping its `QaRunResult` + saved `RunOutcome` to the
   port's `RunOutcome`. The strangler net.
2. **A live byte-equivalence proof** — extend `golden-parity.test.ts` to assert
   `runOutcomeEquivalent(LegacyAdapter.run(scenario), golden)` for all 10 goldens + separate side-effect
   assertions; add `parity-allowlist.json = []`. **GATE: 10/10 green before any domain code is trusted.**
3. **The 186-scenario harness** (`golden-outcome.harness.ts`) — replays all 182 `pipeline.test.ts` + 4
   `pipeline-codex.test.ts` invocations through the adapter, closing the Codex false-green blind spot.
4. **Port widening** — `ReviewPort` carries `parsed` + `blockingCount` BEFORE the domain `FixLoop` is built.
5. **The domain build** — `Run` aggregate, `RunDecisionService`, value objects, the NEW `FixLoop` (the
   hardest, riskiest port), and `RunQaUseCase` — driven ONLY through the 11 ports.
6. **The 11 bridge/facade adapters** — NO concrete adapter in `qa-engine/src` currently implements ANY of the
   11 `qa-run-orchestration`-facing port interfaces (verified vs HEAD: `rg implements (…11 ports…)` returns
   ZERO). Each sibling context exposes its OWN internal ports/entry points (e.g. `GenerateTestsUseCase`,
   `static-gate.adapter.ts`, the execution strategies, `DecideCoverageService` + `coverage-collector.adapter.ts`,
   the github-pr/github-issue/shadow-log adapters, the mirror logic), but NONE implements the orchestration
   port. `DeployGatePort` and `RunHistoryPort` have only kernel/port declarations — no concrete adapter
   anywhere. **Plan 6 must BUILD these 11 thin bridge adapters** (Task E.0) so the composition root has
   something REAL to wire and the `RewrittenOrchestratorAdapter` can be COMPLETE. They are NOT assumed to
   exist from Plans 1–5 — they do not. This is in scope here.
7. **The composition root** — wires ALL 11 ports to the bridge adapters from Task E.0 (the COMPLETE rewritten
   engine), behind a `PIPELINE_ENGINE=legacy|rewritten` flag that SELECTS the engine at the runner/CLI seam
   (default `legacy`, the SHADOW SEAM, not the cutover).
8. **The shadow run** — run the COMPLETE new engine end-to-end with `PIPELINE_ENGINE=rewritten` against a
   live Spring-microservice DEV (petclinic/jhipster, `shadow:true`) and compare its `RunOutcome` to legacy
   on the same SHA. The user's real-execution proof BEFORE the cutover. **Buildable only once Task E.0's 11
   bridge adapters exist** — Slice F's CI-gated build/comparison logic is a Plan 6 deliverable; the actual
   operator run is gated on those adapters plus operator infra (docker DEV + `OPENCODE_API_KEY`).

**Non-negotiable invariants this plan preserves:**

- **THE SLICE ORDER IS THE SAFETY PROPERTY.** Slice A (adapter + proof gate, 10/10 green) MUST pass before
  any rewritten decision logic (Slice D) is trusted. This is the only barrier against a false-green
  auto-merge (R1).
- **The keystone is carried verbatim, mutation-pinned, never weakened.** `decideCoverage`/`blocksPublish`
  with `unknown` NEVER blocks. The rewritten engine consumes the already-ported `DecideCoverageService`
  (Plan-5 era) through `ObjectiveSignalPort` — Plan 6 adds NO new coverage logic.
- **`RunDecisionService` PORTS the ≥6 verdict branches (consolidates), never rewrites the policy.** The
  `FixLoop` preserves the legacy logic exactly (`deriveCycleBackstop`/`adjudicate`/`bestRunSoFar`/
  filtered-retry), parity/characterization-covered.
- **`ReviewPort` is widened to carry `parsed` + `blockingCount` BEFORE the domain `FixLoop`.** `parsed` is
  the #1 fail-closed invariant — without it the `FixLoop` burns a regen on every parse miss.
- **Security boundary:** the composition root is the ONLY module that imports concrete adapters; it sits
  OUTSIDE `generation/*` and `agent-runtime/*`, so the arch-lint VCS-write gate stays green. The agent is
  read-only on watched repos; nothing here grants write capability outside `workspace-and-publication`.
- **Seam-3 is DEFERRED to Plan 7.** The `execute ⇄ dom-snapshot` `killTree` cycle stays live. Plan 6 wraps
  the UNCHANGED `pipeline.ts` (which keeps the cycle) and builds the rewritten engine in `qa-engine/`.
  **DO NOT EDIT `src/qa/dom-snapshot.ts` or `src/qa/validate.ts`.**
- **Surface integration errors loudly** — the parity suite asserts `infra-error` is *emitted*, not absorbed
  (R3). The adapter inherits the proven throwing behavior of `runPipeline`.

## Architecture

```
qa-engine/src/contexts/qa-run-orchestration/
  application/
    ports/index.ts                       ← EXISTING 75-line barrel (ReviewPort widened in Slice C)
    run-qa.use-case.ts                    ← NEW (Slice D) — the structural replacement for runPipeline's body
  domain/
    run.aggregate.ts                      ← NEW (Slice D) — identity RunId+Sha+App; guarded lifecycle
    run-decision.service.ts               ← PORT (Slice D) — the ≥6 verdict branches consolidated, pure
    run-decision.ts                       ← NEW VO (Slice D) — verdict + chosen side-effect
    fix-loop.aggregate.ts                 ← NEW structure / PORT logic (Slice D) — THE HARDEST BUILD
    cycle-budget.ts  wall-clock-budget.ts ← NEW VOs (Slice D)
    helpers/derive-cycle-backstop.ts      ← PORT verbatim (Slice C) from pipeline.ts
    helpers/should-distill-learning.ts    ← PORT verbatim (Slice C) from pipeline.ts
  infrastructure/
    legacy-pipeline.adapter.ts            ← WRAP (Slice A) — RunPipelinePort over unchanged runPipeline
    rewritten-orchestrator.adapter.ts     ← NEW (Slice D/E) — RunPipelinePort over RunQaUseCase + domain
    bridges/                              ← NEW (Slice E / Task E.0) — the 11 port→sibling-context bridges
      change-analysis-port.adapter.ts     ← wraps change-analysis AnalyzeChangeUseCase
      generation-port.adapter.ts          ← wraps generation GenerateTestsUseCase
      review-port.adapter.ts              ← bridges generation's reviewer flow (parsed + blockingCount)
      validation-port.adapter.ts          ← wraps test-execution static-gate.adapter.ts
      execution-port.adapter.ts           ← wraps test-execution e2e/code strategy dispatch
      objective-signal-port.adapter.ts    ← wraps DecideCoverageService + coverage-collector.adapter.ts
      publication-port.adapter.ts         ← wraps github-pr/github-issue/shadow-log adapters
      learning-port.adapter.ts            ← wraps cross-run-learning (fold/retrieve; v1 stub ok)
      workspace-port.adapter.ts           ← wraps workspace-and-publication mirror prepare
      deploy-gate-port.adapter.ts         ← HTTP gate over waitForDeploy + a Null gate (no versionUrl)
      run-history-port.adapter.ts         ← wraps the persisted-outcome save (SQLite or in-memory)
  composition/
    composition-root.ts                   ← NEW (Slice E) — buildProduction/buildShadow; ALL 11 ports wired
    pipeline-engine-flag.ts               ← NEW (Slice E) — PIPELINE_ENGINE constant + selector

qa-engine/test/characterization/
  golden-parity.test.ts                   ← EXTEND (Slice A) — assert adapter output ≡ golden + side effects
  parity-allowlist.json                   ← NEW (Slice A) — []  (undeclared-divergence gate)
  golden-outcome.harness.ts               ← NEW (Slice B) — 186-scenario replay through the adapter
  side-effects.ts                         ← NEW (Slice A) — side-effect probe (publish/openIssue/neither)

qa-engine/test/contexts/qa-run-orchestration/   ← NEW mirror (Slices C/D)
  domain/*.test.ts  application/*.test.ts  infrastructure/*.test.ts
```

**Dependency rule.** The composition root (Slice E) is the only module that imports concrete adapters; it
replaces `defaultPipelineDeps()`. Parity/characterization tests that import the legacy `src/` original as an
oracle are **excluded from the qa-engine typecheck** (the established pattern — they run via `tsx` at
runtime). The legacy originals are deleted at the Plan 7 cutover, not here.

## The Slices and their HARD gates (READ THIS BEFORE STARTING)

This plan is **six slices in a strict dependency chain**. The chain is the safety property; do not reorder.

| Slice | What it builds | Entry gate (must pass before starting) |
|---|---|---|
| **A — Adapter + proof** | `LegacyPipelineAdapter` (WRAP) + extend `golden-parity.test.ts` to assert `equivalence(adapter.run(scenario), golden)` for all 10 + side-effect assertions + `parity-allowlist.json=[]` | Task 0 (re-verify) green |
| **B — 186-scenario harness** | `golden-outcome.harness.ts` replaying 182+4 invocations through the adapter; closes the Codex blind spot | **GATE A: 10/10 goldens green** (Task A.4) |
| **C — Port widening + relocations** | `ReviewPort` (`parsed`+`blockingCount`); verbatim helper moves (`deriveCycleBackstop`, `shouldDistillLearning`) | Slice B green |
| **D — Domain build** | `Run` aggregate + `RunDecisionService` + VOs + the NEW `FixLoop` + `RunQaUseCase`; each validated against Slice A/B | **GATE A still green** + Slice C green + `ReviewPort` widened |
| **E — Bridge adapters + composition root + flag** | **Task E.0 first:** the 11 thin bridge/facade adapters implementing each `qa-run-orchestration` port over its sibling-context entry point (NONE exist at HEAD). Then `composition-root.ts` wiring ALL 11 ports to those REAL bridges (COMPLETE rewritten engine) behind `PIPELINE_ENGINE`; the single runner/CLI dispatch seam | Slice D green; `RewrittenOrchestratorAdapter` COMPLETE |
| **F — Shadow run** | the COMPLETE new engine end-to-end vs live DEV (petclinic/jhipster, `shadow:true`), `RunOutcome` compared to legacy on the same SHA | Slice E CI-gated green (**incl. Task E.0's 11 bridge adapters built**); operator infra (docker DEV + `OPENCODE_API_KEY`) |

**GATE A is the literal barrier (Task A.4).** Slice B, C, D, E, F do NOT start until `golden-parity.test.ts`
asserts `LegacyPipelineAdapter.run(scenario) ≡ golden` for all 10 scenarios AND the side-effect assertions
pass. If GATE A is not green, STOP and report — the strangler net is the precondition for every downstream
slice. **Slice D (rewritten decision logic) cannot begin until GATE A has been green at least once.**

**Deferred to Plan 7 (out of scope here):** the actual CUTOVER (flip the default to `rewritten`, rename to
`panchito`, delete `LegacyPipelineAdapter` + `src/pipeline.ts`), justified by the Slice F evidence; and the
Seam-3 `killTree` decoupling (after the user's `dom-snapshot.ts` WIP lands, via `CaptureDomDeps` injection).

## Tech Stack

- TypeScript, `tsx` runtime (no build step), `node:test` + `node:assert/strict`, tests under
  `qa-engine/test/` mirroring `qa-engine/src/`.
- `@kernel/*` → `qa-engine/src/shared-kernel/*`, `@contexts/*` → `qa-engine/src/contexts/*`. Import
  kernel/ports with explicit `.ts` extensions (`allowImportingTsExtensions`); import sibling context files by
  relative path with `.ts`.
- **Per-task gate (Slices A–E):** `npx tsc --noEmit -p qa-engine/tsconfig.json` + the relevant qa-engine
  test glob, e.g. `node --import ./test-setup.mjs --import tsx --test "qa-engine/test/characterization/**/*.test.ts"`
  or `"qa-engine/test/contexts/qa-run-orchestration/**/*.test.ts"`.
- Adapters inject their wrapped deps (constructor seam) so adapter tests run **without** OpenCode/Codex, the
  HTTP transport, Playwright, or git. Characterization tests reuse the existing `scenarios.ts` stubs (no new
  scenarios authored).

## Flags (preconditions baked into the plan)

1. **Widen `ReviewPort`** (`parsed` + `blockingCount`) BEFORE the domain `FixLoop` slice — Slice C / Task C.1.
2. **Create `parity-allowlist.json = []`** on day 1 — Slice A / Task A.3.
3. **Decide the context-mode convention** (synthesize vs `saveOutcome`) up front and record it in the
   allowlist if it diverges — Task A.2 resolves this; the legacy adapter matches the synthesis convention so
   no divergence is needed for Slice A. If the rewritten engine (Slice D) chooses to call `saveOutcome` for
   context mode, that divergence gets an allowlist entry in Task D.10.

---

# Slice A — Adapter + proof gate (BUILD THIS FIRST)

## Task 0 — Re-verify the brief's facts against HEAD (the user edits `src/` in parallel)

> Run BEFORE writing any code. The brief was verified against HEAD on 2026-06-26, but the user has live WIP
> in `src/qa/*` (`dom-snapshot`, `context-pack`, `changed-elements`). **None of those is in Plan 6's wrap
> set** — Plan 6 wraps the UNCHANGED `runPipeline` and builds in `qa-engine/`. Confirm the runPipeline verdict
> branches, the ports barrel gaps, the goldens, and CONFIRM `dom-snapshot.ts` is untouched by this plan.

- [ ] Confirm the `runPipeline` signature + verdict set are unchanged (grep, not line numbers):
  ```bash
  cd /Users/arielyumn/Desktop/TRABAJO/ai-pipeline
  rg -n "export async function runPipeline" src/pipeline.ts
  rg -n "export interface PipelineDeps" src/pipeline.ts
  rg -n "verdict: \"(pass|fail|flaky|invalid|infra-error|skipped)\"|verdict = \"" src/pipeline.ts | head -20
  ```
  Expected: `runPipeline(app, sha, deps, source, opts, …8 positional callbacks)`; `PipelineDeps` present; the
  six verdicts (`pass|fail|flaky|invalid|infra-error|skipped`) reachable. Record the CURRENT line of
  `runPipeline` — the skeletons cite identifiers, not line numbers.
- [ ] Confirm the ≥6 verdict decision SITES still exist (RunDecisionService consolidates exactly these):
  ```bash
  rg -n "verdict: \"skipped\"|verdict === \"pass\"|verdict !== \"pass\"|verdict: \"flaky\"|verdict: \"infra-error\"|verdict: \"invalid\"" src/pipeline.ts | head -30
  rg -n "consecutiveReviewerFailures" src/pipeline.ts        # the module-level cross-run let (R2)
  ```
  Expected: skipped (classify + agent no-op), invalid (context + static), infra-error (≥2 sites), the
  green/fail/flaky switch in `report()`, flaky quarantine. `consecutiveReviewerFailures` is a module-level
  `let` (line ~82) read at ~1567 — a cross-run side effect the Run aggregate must make per-run (Task D.1).
- [ ] Confirm the ports barrel gaps the brief named are still present:
  ```bash
  rg -n "export interface ReviewPort" qa-engine/src/contexts/qa-run-orchestration/application/ports/index.ts
  sed -n '/export interface ReviewPort/,/^}/p' qa-engine/src/contexts/qa-run-orchestration/application/ports/index.ts
  rg -n "export interface (RunPipelinePort|RunInput|WorkspacePort|PublicationPort|ObserverPort)" qa-engine/src/contexts/qa-run-orchestration/application/ports/index.ts
  ```
  Expected: `ReviewPort.review(specDir, cases) => { approved, corrections, rationale? }` — a STUB missing
  `parsed` + `blockingCount` (widened in Task C.1). `RunPipelinePort`/`RunInput`/`WorkspacePort`/
  `PublicationPort`/`ObserverPort` all present.
- [ ] Confirm the characterization net is captured, clean, and idempotent:
  ```bash
  ls qa-engine/test/characterization/goldens/*.json | wc -l        # expect 10
  git diff --stat qa-engine/test/characterization/goldens/         # expect EMPTY (goldens committed clean)
  rg -n "reviewerApproved" qa-engine/test/characterization/goldens/cross-repo.json || echo "cross-repo has NO reviewerApproved (needsReview:false) — expected"
  rg -n "preExecAmbiguityCatches" qa-engine/test/characterization/goldens/context.json || echo "context golden has NO preExec fields (synthesized) — expected"
  ```
  Expected: 10 goldens; `git diff` empty; `cross-repo.json` has no `reviewerApproved`; `context.json` has
  neither `preExecAmbiguityCatches` nor `deterministicSelectorBlocks` (it is synthesized — Task A.2 handles
  this).
- [ ] **CONFIRM `dom-snapshot.ts` IS UNTOUCHED by this plan and Seam-3 is still live (deferred to Plan 7):**
  ```bash
  rg -n "import \{ killTree \}" src/qa/dom-snapshot.ts src/qa/validate.ts
  git status --short | rg "src/qa/(dom-snapshot|context-pack|changed-elements|selector-check)"
  ```
  Expected: both `killTree` imports present (the cycle is LIVE — leave it). `dom-snapshot.ts` appears in the
  user's WIP. **This plan must NOT stage or edit any of these files.** Record that Seam-3 is deferred.
- [ ] Confirm no qa-engine WIP collision (none of Plan 6's new files already exist/modified):
  ```bash
  ls qa-engine/src/contexts/qa-run-orchestration/domain/ 2>/dev/null || echo "domain/ ABSENT — expected (Slice D creates it)"
  ls qa-engine/src/contexts/qa-run-orchestration/infrastructure/ 2>/dev/null || echo "infrastructure/ ABSENT — expected (Slice A creates it)"
  ls qa-engine/src/contexts/qa-run-orchestration/composition/ 2>/dev/null || echo "composition/ ABSENT — expected (Slice E creates it)"
  ls qa-engine/test/characterization/parity-allowlist.json 2>/dev/null || echo "allowlist ABSENT — expected (Task A.3 creates it)"
  ls qa-engine/src/shared-infrastructure/process-sandbox/process-kill.adapter.ts   # Seam-3 fix, READY, defer wiring
  ```
  Expected: domain/infrastructure/composition absent; allowlist absent; the process-kill adapter present (do
  NOT wire it in Plan 6). qa-engine is otherwise clean.
- [ ] Slice-A baseline: the qa-engine isolated gate is green at HEAD WIP:
  ```bash
  npx tsc --noEmit -p qa-engine/tsconfig.json
  node --import ./test-setup.mjs --import tsx --test "qa-engine/test/**/*.test.ts" 2>&1 | tail -5
  ```
  Expected: typecheck passes; qa-engine test summary shows `0` failures. (Do NOT gate Slice A on root `npm
  test` if the user has unrelated RED `src/` tests — the qa-engine isolated gate is immune.)

---

## Task A.1 — `LegacyPipelineAdapter` (WRAP `runPipeline` behind `RunPipelinePort`)

> The #1 deliverable: the strangler net. Implements `RunPipelinePort.run(RunInput)` by translating to
> `runPipeline(app, sha, deps, source, opts, …callbacks)` and mapping the legacy result back to a port
> `RunOutcome`. It WRAPS the unchanged `src/pipeline.ts`; it does NOT reimplement any decision. All
> side-effecting deps (`PipelineDeps`) and the `AppConfig` are INJECTED (constructor seam) so the adapter
> test drives it with the existing `scenarios.ts` stubs — no OpenCode/Playwright/git.

**Files:** `qa-engine/src/contexts/qa-run-orchestration/infrastructure/legacy-pipeline.adapter.ts`,
`qa-engine/test/contexts/qa-run-orchestration/infrastructure/legacy-pipeline.adapter.test.ts`

- [ ] Re-read the exact `runPipeline` return + the RunOutcome shape (they may have moved):
  ```bash
  rg -n "Promise<QaRunResult>|export interface QaRunResult" src/pipeline.ts src/types.ts
  sed -n '/export interface RunOutcome {/,/^}/p' src/types.ts
  ```
  Note: `runPipeline` returns `QaRunResult`; the behavioral `RunOutcome` is what `deps.saveOutcome` receives
  (or, for context mode, is synthesized — see Task A.2). The adapter must surface the **saved** `RunOutcome`,
  not re-derive it from `QaRunResult`.
- [ ] Write the failing delegation test (drive the adapter with the `scenarios.ts` green-pr stub; assert it
  forwards to `runPipeline` and returns the saved outcome — a gutted impl returning a literal FAILS):
  ```ts
  // test/contexts/qa-run-orchestration/infrastructure/legacy-pipeline.adapter.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { LegacyPipelineAdapter } from "@contexts/qa-run-orchestration/infrastructure/legacy-pipeline.adapter.ts";
  import { buildScenarioDeps } from "../../../characterization/scenarios.ts";

  test("run() delegates to runPipeline and returns the SAVED RunOutcome (verdict pass for green-pr)", async () => {
    const { app, sha, source, opts, deps } = buildScenarioDeps("green-pr");
    // The adapter receives app + PipelineDeps + the legacy runPipeline fn injected (no real runtime).
    const adapter = new LegacyPipelineAdapter({ app, deps, runPipeline: (await import("../../../../../src/pipeline.ts")).runPipeline });
    const outcome = await adapter.run({ app: app.name, sha, source, mode: opts.mode, target: "e2e", runId: opts.runId });
    assert.equal(outcome.verdict, "pass");
    assert.equal(deps.savedOutcomes.length >= 1, true, "the wrapped runPipeline must have saved an outcome");
  });
  ```
  > The adapter test imports `runPipeline` from `src/` as the wrapped dependency — the test file is added to
  > the qa-engine typecheck `exclude` list (parity-import pattern). The adapter SOURCE never imports `src/`;
  > it receives `runPipeline` (or the whole `PipelineDeps` + a runner fn) by constructor injection.
- [ ] Run it, see it fail (module not found).
- [ ] Minimal impl — translate `RunInput` → `runPipeline` args; surface the saved `RunOutcome`. Handle the
  context-mode early-return (no saveOutcome) by synthesizing per Task A.2's resolved convention:
  ```ts
  // src/contexts/qa-run-orchestration/infrastructure/legacy-pipeline.adapter.ts
  // WRAP of src/pipeline.ts runPipeline. The strangler net (design §7.2 Step 9). Translates a RunInput into
  // the legacy positional call and surfaces the RunOutcome the wrapped pipeline persisted via saveOutcome.
  // NO decision logic lives here — it delegates to the proven function. AppConfig + PipelineDeps + the
  // runPipeline fn are injected so the adapter is src/-free at type level and testable with the scenarios stubs.
  import type { RunPipelinePort, RunInput } from "../application/ports/index.ts";
  import type { RunOutcome } from "@kernel/run-outcome.ts";

  // Structural shapes of the wrapped legacy surface (no src/ import at type level; the composition root in
  // Slice E supplies the real runPipeline + PipelineDeps + AppConfig).
  export interface LegacyRunner {
    app: unknown;                                   // legacy AppConfig
    deps: { savedOutcomes?: RunOutcome[] } & Record<string, unknown>;  // legacy PipelineDeps (+ capture hook)
    legacyOpts?: Record<string, unknown>;           // per-run legacy-only opts (e.g. triggerRepo) — opaque, spread over derived opts
    runPipeline: (app: unknown, sha: string, deps: unknown, source: string, opts: unknown, ...cbs: unknown[]) => Promise<{ verdict: string }>;
  }

  export class LegacyPipelineAdapter implements RunPipelinePort {
    constructor(private readonly legacy: LegacyRunner) {}
    async run(input: RunInput): Promise<RunOutcome> {
      // legacyOpts carries cross-repo routing (triggerRepo) opaquely — the composition root / scenario supplies
      // it; RunInput is NOT widened (cross-repo stays opaque inside the adapter for Plan 6).
      const opts = { mode: input.mode, target: input.target, guidance: input.guidance, runId: input.runId,
        ...this.legacy.legacyOpts };
      const result = await this.legacy.runPipeline(this.legacy.app, input.sha, this.legacy.deps, input.source, opts);
      // R2 — consecutiveReviewerFailures is a module-level let in pipeline.ts that survives between queue
      // entries (a cross-run side effect). The adapter delegates to the unchanged function, so it INHERITS
      // this defect for the legacy path. Documented here; the Run aggregate (Task D.1) makes reviewer-outage
      // per-run for the rewritten path. The legacy adapter does NOT attempt to reset the global.
      return mapToOutcome(result, this.legacy.deps, input);
    }
  }
  // Surfaces the RunOutcome the wrapped pipeline saved. Context mode returns early without saveOutcome —
  // synthesize per the Task A.2 convention (matches capture-goldens.ts synthesizeContextOutcome).
  function mapToOutcome(result: { verdict: string }, deps: LegacyRunner["deps"], input: RunInput): RunOutcome {
    const saved = deps.savedOutcomes?.[deps.savedOutcomes.length - 1];
    if (saved) return saved;
    return synthesizeContextOutcome(result.verdict, input);   // see Task A.2
  }
  ```
  > **Cross-repo note (the `triggerRepo` thread) — RESOLVED HERE, not deferred to A.4.** The 10-scenario
  > `cross-repo` stub passes `opts.triggerRepo: "org/orders-svc"`; the adapter's `RunInput` deliberately has NO
  > `triggerRepo` field (the port surface stays app-name + sha + source — do NOT widen the strangler seam for a
  > cross-repo concern the brief says to keep OPAQUE). **Chosen shape (option b): the `LegacyRunner` carries a
  > per-run `legacyOpts` bag, supplied by the test/composition root, that the adapter spreads over the derived
  > `opts` when calling `runPipeline`.** This threads `triggerRepo` (and any other legacy-only opts) without
  > touching `RunInput`, and keeps cross-repo routing opaque inside the adapter/composition wiring (brief:
  > WorkspacePort stays opaque for Plan 6). The failing test below is written against THIS shape, so A.4 is not
  > the first discovery point:
  > ```ts
  > export interface LegacyRunner {
  >   app: unknown;
  >   deps: { savedOutcomes?: RunOutcome[] } & Record<string, unknown>;
  >   legacyOpts?: Record<string, unknown>;   // per-run legacy-only opts (e.g. triggerRepo) — spread over derived opts
  >   runPipeline: (app: unknown, sha: string, deps: unknown, source: string, opts: unknown, ...cbs: unknown[]) => Promise<{ verdict: string }>;
  > }
  > // in run(): const opts = { mode: input.mode, target: input.target, guidance: input.guidance, runId: input.runId, ...this.legacy.legacyOpts };
  > ```
  > The `green-pr` test constructs the adapter with no `legacyOpts`; the `cross-repo` scenario (A.4) constructs
  > it with `legacyOpts: { triggerRepo: "org/orders-svc" }`. GATE A's cross-repo scenario therefore reproduces
  > the service-mirror diff + `issueRepo != app.repo` behavior with NO `RunInput` schema change.
- [ ] Run it, see it pass.
- [ ] Add the adapter test to the qa-engine typecheck exclude (it imports `src/pipeline.ts`):
  ```jsonc
  // qa-engine/tsconfig.json — append to "exclude"
  "test/contexts/qa-run-orchestration/infrastructure/legacy-pipeline.adapter.test.ts"
  ```
- [ ] Isolated gate:
  ```bash
  node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/qa-run-orchestration/infrastructure/legacy-pipeline.adapter.test.ts"
  npx tsc --noEmit -p qa-engine/tsconfig.json
  ```
  Expected: passes; typecheck exits 0.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/qa-run-orchestration/infrastructure/legacy-pipeline.adapter.ts \
          qa-engine/test/contexts/qa-run-orchestration/infrastructure/legacy-pipeline.adapter.test.ts \
          qa-engine/tsconfig.json
  git commit -m "feat(qa-run-orchestration): LegacyPipelineAdapter wrapping runPipeline behind RunPipelinePort"
  ```

## Task A.2 — Side-effect probe + the context-mode synthesis convention

> The comparator (`equivalence.ts`) covers verdict + coverageRatio but does NOT model side effects (PR
> created? Issue opened? neither?). The byte-equivalence proof must add a SEPARATE side-effect assertion (the
> brief's crux #1) — closed in the HARNESS, not the comparator. This task builds the probe and resolves the
> context-mode synthesis convention (Flag 3) the adapter (A.1) and the proof (A.4) both consume.

**Files:** `qa-engine/test/characterization/side-effects.ts`

- [ ] Build a side-effect probe that wraps a `scenarios.ts` deps bag and records which publish/issue path
  fired (the comparator is blind to this — the stubs already exist, just observe them):
  ```ts
  // test/characterization/side-effects.ts
  // The runOutcomeEquivalent comparator does NOT model side effects (§10 covers verdict/coverage only).
  // The byte-equivalence proof asserts side effects SEPARATELY: which publish/issue path fired. This probe
  // wraps the existing scenarios.ts CaptureDeps and records the side effect without changing behavior.
  import type { CaptureDeps } from "./scenarios.ts";

  export type SideEffect = "pr" | "issue" | "shadow-log" | "none";

  export function probeSideEffects(deps: CaptureDeps): { deps: CaptureDeps; seen: () => SideEffect } {
    let effect: SideEffect = "none";
    const wrap = <A extends unknown[], R>(orig: ((...a: A) => R) | undefined, tag: SideEffect) =>
      orig ? (...a: A): R => { effect = tag; return orig(...a); } : orig;
    deps.publish = wrap(deps.publish, "pr");
    deps.publishCode = wrap(deps.publishCode, "pr");
    deps.publishContext = wrap(deps.publishContext, "pr");
    deps.openIssue = wrap(deps.openIssue, "issue");
    return { deps, seen: () => effect };
  }
  ```
- [ ] Resolve the context-mode convention and write it down (Flag 3). The legacy adapter (A.1) MUST match the
  capture-goldens.ts `synthesizeContextOutcome` convention — context mode returns before `saveOutcome`, so the
  adapter synthesizes the same fields/defaults. Add the shared synthesizer next to the probe so A.1 and A.4
  import ONE source of truth:
  ```ts
  // test/characterization/side-effects.ts (append) — also imported by legacy-pipeline.adapter.ts via the
  // composition wiring in Slice E; for Slice A the adapter inlines an identical synthesizer (kept in sync).
  // Convention (Flag 3): context mode does NOT call saveOutcome; both the legacy adapter and the golden
  // synthesize the outcome from the QaRunResult using persistOutcome's defaults. NO allowlist entry needed
  // for the legacy path (it matches the golden). If the rewritten engine (Slice D) calls saveOutcome for
  // context mode instead, that divergence is declared in parity-allowlist.json at Task D.10.
  export function synthesizeContextOutcome(verdict: string, app: string, sha: string) {
    return { app, sha, mode: "context", target: "e2e", verdict, errorClass: null,
      gateSignals: { static: false, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
      rulesRetrieved: [] };
  }
  ```
- [ ] No test for this helper alone (it is test infrastructure exercised by A.4). Typecheck:
  ```bash
  npx tsc --noEmit -p qa-engine/tsconfig.json
  ```
  Expected: exits 0 (the probe is excluded from typecheck if it imports `src/`; it imports only the
  `scenarios.ts` type — keep it src/-free, or add to exclude if it transitively pulls `src/`).
- [ ] Commit:
  ```bash
  git add qa-engine/test/characterization/side-effects.ts qa-engine/tsconfig.json
  git commit -m "test(characterization): side-effect probe + context-mode synthesis convention (Flag 3)"
  ```

## Task A.3 — `parity-allowlist.json = []` (the undeclared-divergence gate)

> Flag 2: create the allowlist as `[]` on day 1 so the proof and the 186-harness gate on UNDECLARED
> divergences only. Shape per design §10: `{ scenarioFingerprint, divergenceDescription, approver }`.
> `scenarioFingerprint` = a stable hash of the scenario NAME string (not fixture data), so fixture edits
> never silently break entries.

**Files:** `qa-engine/test/characterization/parity-allowlist.json`,
`qa-engine/test/characterization/parity-allowlist.ts`

- [ ] Create the empty allowlist + a typed reader (a loader the proof and harness both consume):
  ```jsonc
  // qa-engine/test/characterization/parity-allowlist.json
  []
  ```
  ```ts
  // qa-engine/test/characterization/parity-allowlist.ts
  // Declared, intentional legacy-vs-rewritten divergences (design §10). Empty on day 1. The proof and the
  // 186-harness suppress a CI failure ONLY for a declared fingerprint; any UNDECLARED divergence fails the
  // gate unconditionally. scenarioFingerprint is a stable hash of the scenario NAME (not fixture data).
  import { readFileSync } from "node:fs";
  import { createHash } from "node:crypto";
  import { join } from "node:path";

  export interface AllowlistEntry { scenarioFingerprint: string; divergenceDescription: string; approver: string; }
  export function fingerprint(scenarioName: string): string {
    return createHash("sha256").update(scenarioName).digest("hex").slice(0, 16);
  }
  export function loadAllowlist(): Set<string> {
    const raw = readFileSync(join(import.meta.dirname, "parity-allowlist.json"), "utf8");
    const entries = JSON.parse(raw) as AllowlistEntry[];
    return new Set(entries.map((e) => e.scenarioFingerprint));
  }
  ```
- [ ] Typecheck:
  ```bash
  npx tsc --noEmit -p qa-engine/tsconfig.json
  ```
  Expected: exits 0.
- [ ] Commit:
  ```bash
  git add qa-engine/test/characterization/parity-allowlist.json qa-engine/test/characterization/parity-allowlist.ts
  git commit -m "test(characterization): parity-allowlist.json = [] + typed reader (undeclared-divergence gate)"
  ```

## Task A.4 — GATE A: extend `golden-parity.test.ts` to prove `adapter ≡ golden` for all 10 + side effects

> **THE LITERAL GATE.** This converts the dormant net (which today only round-trips goldens against
> themselves) into a live regression gate: for each of the 10 scenarios, run `LegacyPipelineAdapter.run()`
> and assert `runOutcomeEquivalent(adapter output, golden) === true`, PLUS the expected side effect.
> **Nothing downstream (Slices B–F) proceeds until this is 10/10 green.**

**Files:** `qa-engine/test/characterization/golden-parity.test.ts` (EXTEND)

- [ ] Keep the existing round-trip block; ADD the adapter-vs-golden block. Map each scenario's expected side
  effect from its golden verdict (green-pr→pr, fail-issue→issue, flaky→none, no-op-skip→none,
  invalid-issue→issue, infra-error→none, code-mode→pr, cross-repo→pr, shadow→shadow-log, context→pr):
  ```ts
  // test/characterization/golden-parity.test.ts (append; the test file is in the qa-engine typecheck exclude
  // list because it imports the legacy runPipeline via the adapter constructor).
  import { runPipeline } from "../../../src/pipeline.ts";
  import { LegacyPipelineAdapter } from "@contexts/qa-run-orchestration/infrastructure/legacy-pipeline.adapter.ts";
  import { buildScenarioDeps, type ScenarioKey } from "./scenarios.ts";
  import { probeSideEffects, type SideEffect } from "./side-effects.ts";
  import { runOutcomeEquivalent, type ComparableOutcome } from "./equivalence.ts";
  import { loadAllowlist, fingerprint } from "./parity-allowlist.ts";

  const EXPECTED_SIDE_EFFECT: Record<ScenarioKey, SideEffect> = {
    "green-pr": "pr", "fail-issue": "issue", "flaky-quarantine": "none", "no-op-skip": "none",
    "invalid-issue": "issue", "infra-error": "none", "code-mode": "pr", "cross-repo": "pr",
    "shadow": "shadow-log", "context": "pr",
  };

  const allow = loadAllowlist();
  for (const key of Object.keys(EXPECTED_SIDE_EFFECT) as ScenarioKey[]) {
    test(`GATE A — ${key}: LegacyPipelineAdapter output ≡ golden + side effect`, async () => {
      const golden = JSON.parse(readFileSync(join(dir, `${key}.json`), "utf8")) as Partial<ComparableOutcome>;
      const { app, sha, source, opts, deps } = buildScenarioDeps(key);
      const { deps: probed, seen } = probeSideEffects(deps);
      const adapter = new LegacyPipelineAdapter({ app, deps: probed, runPipeline });
      const outcome = await adapter.run({ app: app.name, sha, source, mode: opts.mode, target: opts.target ?? "e2e", guidance: undefined, runId: opts.runId });

      const declared = allow.has(fingerprint(key));
      const cmp = runOutcomeEquivalent(
        { runId: "x", at: "y", ...(golden as object) } as ComparableOutcome,
        { runId: "x", at: "y", ...(outcome as object) } as ComparableOutcome,
      );
      if (!declared) assert.equal(cmp.equal, true, `${key}: ${cmp.diff}`);     // undeclared divergence FAILS
      assert.equal(seen(), EXPECTED_SIDE_EFFECT[key], `${key}: wrong side effect`);

      // Shape assertion OUTSIDE the comparator (crux #4 hazard #2): the comparator ignores these fields, so a
      // 0-vs-undefined mismatch is invisible. The context golden OMITS them (synthesized), so skip the assert
      // for the context scenario; for every other scenario the legacy adapter MUST emit the NUMBER 0, not
      // undefined. This pins the field SHAPE at GATE A — not deferred to D.7 — so the legacy adapter can never
      // silently drop them.
      if (key !== "context") {
        assert.equal(typeof outcome.gateSignals.preExecAmbiguityCatches, "number", `${key}: preExecAmbiguityCatches must be a number, not undefined`);
        assert.equal(typeof outcome.gateSignals.deterministicSelectorBlocks, "number", `${key}: deterministicSelectorBlocks must be a number, not undefined`);
      }
    });
  }
  ```
  > **Handle the 3 comparator hazards (brief crux #4):**
  > 1. `rulesRetrieved` is excluded from `behavioralProjection` and is `[]` in all goldens — fine for the
  >    legacy adapter (its `LearningPort.retrieve` is the stub returning `[]`). Do NOT add it to the
  >    comparator in Slice A; flag it for Slice D (when a real retrieve is wired, declare any divergence).
  > 2. `preExecAmbiguityCatches`/`deterministicSelectorBlocks` are `0` in most goldens but ABSENT in
  >    `context.json` — the comparator ignores them, so a `0`-vs-`undefined` mismatch is invisible. This is
  >    SAFE for the legacy adapter (it produces the same shape as the golden). Note it for Slice D: the
  >    rewritten engine MUST emit `0` (not `undefined`) when W1/W2 is wired, or the mismatch stays silent.
  > 3. `context.json` is synthesized — the legacy adapter's context path also synthesizes (Task A.2), so they
  >    match. No allowlist entry needed for the legacy path.
- [ ] Run the proof — **this is GATE A. Require 10/10 green:**
  ```bash
  node --import ./test-setup.mjs --import tsx --test "qa-engine/test/characterization/golden-parity.test.ts" 2>&1 | tail -20
  ```
  Expected: all 10 `GATE A — <scenario>` tests pass; side-effect assertions pass. **If ANY scenario fails,
  STOP. Do not start Slice B/C/D/E/F.** Diagnose: a real adapter mapping bug (fix A.1), a golden drift
  (re-capture only if `runPipeline` legitimately changed and the change is intentional), or a genuine,
  intentional divergence (add a `parity-allowlist.json` entry with an approver — NOT silently).
- [ ] Typecheck:
  ```bash
  npx tsc --noEmit -p qa-engine/tsconfig.json
  ```
  Expected: exits 0 (the extended test file is in `exclude` — A.1 added it).
- [ ] Commit:
  ```bash
  git add qa-engine/test/characterization/golden-parity.test.ts
  git commit -m "test(characterization): GATE A — prove LegacyPipelineAdapter ≡ all 10 goldens + side effects"
  ```

---

# Slice B — 186-scenario harness (closes the Codex blind spot)

> **Entry gate: GATE A is 10/10 green.** The 10 JSON goldens are a matrix snapshot; the design mandates
> replaying ALL 182 `pipeline.test.ts` + 4 `pipeline-codex.test.ts` invocations through the adapter. Building
> only against the 10 leaves a CODEX false-green blind spot (the 4 codex scenarios — provider attribution,
> usageComplete, codex infra-error — are in ZERO goldens).

## Task B.1 — `golden-outcome.harness.ts` skeleton + the 182 `pipeline.test.ts` replay

**Files:** `qa-engine/test/characterization/golden-outcome.harness.ts`

- [ ] Inventory the legacy `runPipeline` invocations so the harness is exhaustive (grep, record counts):
  ```bash
  rg -c "runPipeline\(" src/pipeline.test.ts          # expect ~182 invocations
  rg -c "runPipeline\(" src/pipeline-codex.test.ts     # expect 4
  ```
  Record the exact counts. The harness must replay EVERY invocation through `LegacyPipelineAdapter`, not a
  hand-picked subset.
- [ ] Decide the replay mechanism — run the greppable check FIRST, then pick the branch it dictates (do NOT
  guess; the grep result is the decision):
  ```bash
  rg -n "export (function|const) (deps|makeDeps|buildDeps|cases|scenarios)|function deps\(" src/pipeline.test.ts | head
  ```
  - **(preferred — grep finds a shared export) Shared scenario table.** If `pipeline.test.ts` already builds
    its deps via a reusable exported helper/table, the harness imports that helper and iterates the same table
    through the adapter (no fixture duplication).
  - **(fallback — grep finds NOTHING exported) Export the deps factory, then mirror.** If the test inlines its
    deps per-`test()` with no shared export, the reconstruction of 182 scenario deps from test inlines is
    error-prone and risks fixture drift. Avoid that: **add a one-line mechanical `export` to `pipeline.test.ts`
    for its deps-construction helper/table** (a behavior-preserving change — it only exposes what the tests
    already build) so the harness imports the SAME factory the legacy tests use. This file is in the user's
    protected `src/` set but the edit is a pure additive `export` with no logic change; if the user's WIP makes
    even that undesirable, fall back to mirroring ONLY the families not covered by the 10 goldens (notably the
    4 codex scenarios) in `scenarios.ts` style — **reuse fixtures, author no new behavior** (design §7.2 Step 1).
    Record which path was taken in the harness header comment so the fixture origin is auditable.
- [ ] Write the harness as a loop that, per replayed scenario: runs the adapter, asserts the outcome against
  the captured/expected tuple `(verdict, sideEffect, persisted RunOutcome)`, and consults the allowlist:
  ```ts
  // test/characterization/golden-outcome.harness.ts
  // Replays ALL 182 pipeline.test.ts + 4 pipeline-codex.test.ts runPipeline invocations through
  // LegacyPipelineAdapter and asserts (verdict, sideEffect, persisted RunOutcome) per scenario. Undeclared
  // divergence fails CI; declared fingerprints (parity-allowlist.json) are suppressed. Closes the Codex
  // false-green blind spot (the 4 codex scenarios are in ZERO of the 10 JSON goldens). In the qa-engine
  // typecheck exclude list (imports the legacy runPipeline). Reuses fixtures — authors no new scenarios.
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { runPipeline } from "../../../src/pipeline.ts";
  import { LegacyPipelineAdapter } from "@contexts/qa-run-orchestration/infrastructure/legacy-pipeline.adapter.ts";
  import { probeSideEffects } from "./side-effects.ts";
  import { runOutcomeEquivalent, type ComparableOutcome } from "./equivalence.ts";
  import { loadAllowlist, fingerprint } from "./parity-allowlist.ts";
  // import the shared scenario table (preferred) OR the mirrored families (fallback)

  const allow = loadAllowlist();
  for (const scn of allScenarios /* 186 */) {
    test(`186-harness — ${scn.name}: adapter ≡ expected (verdict + side effect + outcome)`, async () => {
      const { deps: probed, seen } = probeSideEffects(scn.deps);
      const adapter = new LegacyPipelineAdapter({ app: scn.app, deps: probed, runPipeline });
      const outcome = await adapter.run(scn.input);
      assert.equal(outcome.verdict, scn.expected.verdict, scn.name);
      assert.equal(seen(), scn.expected.sideEffect, scn.name);
      if (scn.expected.outcome && !allow.has(fingerprint(scn.name))) {
        const cmp = runOutcomeEquivalent(scn.expected.outcome as ComparableOutcome, outcome as unknown as ComparableOutcome);
        assert.equal(cmp.equal, true, `${scn.name}: ${cmp.diff}`);
      }
    });
  }
  ```
- [ ] Add the harness to the qa-engine typecheck exclude list (it imports `src/pipeline.ts`).
- [ ] Run the 182 `pipeline.test.ts` replay subset:
  ```bash
  node --import ./test-setup.mjs --import tsx --test "qa-engine/test/characterization/golden-outcome.harness.ts" 2>&1 | tail -20
  ```
  Expected: all replayed `pipeline.test.ts` scenarios pass. Triage any failure as in Task A.4 (mapping bug
  vs intentional divergence → allowlist).
- [ ] Typecheck → 0. Commit:
  ```bash
  git add qa-engine/test/characterization/golden-outcome.harness.ts qa-engine/tsconfig.json
  git commit -m "test(characterization): 186-harness replaying pipeline.test.ts through LegacyPipelineAdapter"
  ```

## Task B.2 — Add the 4 `pipeline-codex.test.ts` scenarios (close the Codex blind spot)

> The 4 codex scenarios — Codex green pass, `usageComplete` attribution, honest `usageComplete=false`,
> persisted `RunUsage` provider attribution, and Codex infra-error propagation — are in ZERO goldens.
> Without them, the rewritten engine's provider-attribution paths are never regression-pinned.

**Files:** `qa-engine/test/characterization/golden-outcome.harness.ts` (extend the scenario table)

- [ ] Read the 4 codex invocations and their assertions (the harness must replay these EXACT deps):
  ```bash
  rg -n "runPipeline\(|agentRuntimeConfig|usageComplete|provider|infra-error" src/pipeline-codex.test.ts
  ```
  Note the `deps.agentRuntimeConfig` shape (provider attribution drives `usageComplete` at pipeline.ts ~963)
  and the codex infra-error path. Mirror those deps into the harness table (reuse the test's fixtures).
- [ ] Add the 4 codex entries to `allScenarios` with their expected `(verdict, sideEffect, outcome)` —
  including the `usage` provider attribution fields the comparator does NOT cover (assert those SEPARATELY,
  like side effects, since `behavioralProjection` excludes `usage`):
  ```ts
  // For codex scenarios, the comparator ignores gateSignals.usage (per-invocation). Assert the persisted
  // provider attribution + usageComplete flag explicitly — they are the Codex regression anchor.
  // e.g. assert.equal(outcome.gateSignals.usage?.complete, scn.expected.usageComplete);
  //      assert.equal(outcome.gateSignals.usage?.attribution?.primaryProvider, "codex");
  ```
- [ ] Run the FULL 186 harness:
  ```bash
  node --import ./test-setup.mjs --import tsx --test "qa-engine/test/characterization/golden-outcome.harness.ts" 2>&1 | tail -10
  ```
  Expected: 186/186 pass (182 + 4 codex). The Codex blind spot is closed.
- [ ] Typecheck → 0. Commit:
  ```bash
  git add qa-engine/test/characterization/golden-outcome.harness.ts
  git commit -m "test(characterization): replay the 4 pipeline-codex scenarios (close the Codex false-green blind spot)"
  ```

---

# Slice C — Port widening + helper relocations (pure, parity-covered)

> **Entry gate: Slice B green (186/186).** Pure, mechanical work that the domain `FixLoop` (Slice D) depends
> on. Task C.1 (ReviewPort widening) is Flag 1 — it MUST land before the FixLoop.

## Task C.1 — Widen `ReviewPort` to carry `parsed` + `blockingCount` (Flag 1, BEFORE the FixLoop)

> The barrel `ReviewPort.review(specDir, cases) => { approved, corrections, rationale? }` is a STUB. The
> legacy `ReviewResult` carries `blockingCount` (advisory-vs-blocking gate) and `parsed` (parse-miss vs real
> rejection — the #1 fail-closed invariant). Without `parsed`, the FixLoop burns a regen on every parse
> miss. Widen the port now; tsc immediately.

**Files:** `qa-engine/src/contexts/qa-run-orchestration/application/ports/index.ts`

- [ ] Confirm the legacy `ReviewResult` fields the port must carry (grep, not line numbers):
  ```bash
  rg -n "blockingCount|parsed" src/integrations/opencode-client.ts | head
  ```
  Expected: `ReviewResult` carries `blockingCount?: number` + `parsed?: boolean` (parse miss ⇒ `parsed:false`,
  distinct from a real `approved:false` rejection).
- [ ] Edit the barrel — widen `ReviewPort`'s return:
  ```ts
  // ReviewPort is the authoritative publish gate's seam. blockingCount distinguishes blocking corrections
  // (must regenerate) from advisory ones (may approve when only advisory remain); parsed is FALSE only on a
  // parse miss (no verdict JSON could be parsed) — NOT a real rejection — so the FixLoop re-prompts once
  // instead of burning a fix round. Both are carried from the legacy ReviewResult so the domain drops no
  // behavior (the #1 fail-closed invariant: parsed).
  export interface ReviewPort {
    review(specDir: string, cases: readonly QaCase[]): Promise<{
      approved: boolean;
      corrections: string[];
      rationale?: string;
      blockingCount?: number;
      parsed?: boolean;
    }>;
  }
  ```
- [ ] Typecheck IMMEDIATELY (the barrel's downstream consumers must still resolve):
  ```bash
  npx tsc --noEmit -p qa-engine/tsconfig.json
  ```
  Expected: exits 0.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/qa-run-orchestration/application/ports/index.ts
  git commit -m "feat(qa-run-orchestration): widen ReviewPort with parsed + blockingCount (fail-closed invariant)"
  ```

## Task C.2 — Relocate `deriveCycleBackstop` (PORT verbatim) into qa-run-orchestration domain helpers

> Brief: `deriveCycleBackstop` and `shouldDistillLearning` move verbatim into qa-run-orchestration domain
> helpers (design §7.2 Step 10). PORT (copy + parity), no logic change. The legacy original stays until Plan 7
> cutover; a parity test pins the copy.

**Files:** `qa-engine/src/contexts/qa-run-orchestration/domain/helpers/derive-cycle-backstop.ts`,
`test/contexts/qa-run-orchestration/domain/helpers/derive-cycle-backstop.test.ts`,
`test/contexts/qa-run-orchestration/domain/helpers/derive-cycle-backstop-parity.test.ts`

- [ ] Read the legacy body VERBATIM (copy the CURRENT HEAD shape):
  ```bash
  rg -n "export function deriveCycleBackstop" src/pipeline.ts
  sed -n '/export function deriveCycleBackstop/,/^}/p' src/pipeline.ts
  ```
- [ ] Write a failing unit test for the ported fn (boundary cases: maxRetries 0/2/5), see it fail, copy the
  body VERBATIM into the helper, see it pass.
- [ ] Write the parity test pinning the copy to the legacy original across a sample table of `maxRetries`
  values; add it to the qa-engine typecheck `exclude` list (imports `src/pipeline.ts`):
  ```ts
  // PARITY: the lifted backstop must match pipeline.ts across the maxRetries domain until Plan 7 deletes it.
  import { deriveCycleBackstop } from "@contexts/qa-run-orchestration/domain/helpers/derive-cycle-backstop.ts";
  import { deriveCycleBackstop as legacy } from "../../../../../../src/pipeline.ts";
  test("PARITY: backstop matches legacy across maxRetries 0..6", () => {
    for (let r = 0; r <= 6; r++) assert.equal(deriveCycleBackstop(r), legacy(r), `maxRetries=${r}`);
  });
  ```
- [ ] Run both + typecheck → 0. Commit:
  ```bash
  git add qa-engine/src/contexts/qa-run-orchestration/domain/helpers/derive-cycle-backstop.ts \
          qa-engine/test/contexts/qa-run-orchestration/domain/helpers/derive-cycle-backstop.test.ts \
          qa-engine/test/contexts/qa-run-orchestration/domain/helpers/derive-cycle-backstop-parity.test.ts \
          qa-engine/tsconfig.json
  git commit -m "feat(qa-run-orchestration): port deriveCycleBackstop into domain helpers with parity oracle"
  ```

## Task C.3 — Relocate `shouldDistillLearning` (PORT verbatim) into qa-run-orchestration domain helpers

> Same PORT+parity pattern as C.2. `shouldDistillLearning` gates the reflect/distill learning fold (off-path).

**Files:** `qa-engine/src/contexts/qa-run-orchestration/domain/helpers/should-distill-learning.ts`,
`test/.../should-distill-learning.test.ts`, `test/.../should-distill-learning-parity.test.ts`

- [ ] Read the legacy body VERBATIM:
  ```bash
  rg -n "export function shouldDistillLearning" src/pipeline.ts
  sed -n '/export function shouldDistillLearning/,/^}/p' src/pipeline.ts
  ```
- [ ] Failing unit test (the gating predicate across its input space) → see fail → copy VERBATIM → see pass.
- [ ] Parity test pinning to legacy across a sample table; add to the typecheck `exclude` list.
- [ ] Run both + typecheck → 0. Commit:
  ```bash
  git add qa-engine/src/contexts/qa-run-orchestration/domain/helpers/should-distill-learning.ts \
          qa-engine/test/contexts/qa-run-orchestration/domain/helpers/should-distill-learning.test.ts \
          qa-engine/test/contexts/qa-run-orchestration/domain/helpers/should-distill-learning-parity.test.ts \
          qa-engine/tsconfig.json
  git commit -m "feat(qa-run-orchestration): port shouldDistillLearning into domain helpers with parity oracle"
  ```

> **Note on the other relocations** (`buildFailureDom`/`buildFailureDomLines`/`foldValueLearning` →
> test-execution; `foldRunLearning` → cross-run-learning): the brief assigns these to their target contexts,
> NOT qa-run-orchestration. They are consumed by Plan 6 through `LearningPort`/`ExecutionPort` (already
> wired). Do NOT relocate them in Plan 6 — they belong to the test-execution / cross-run-learning plans; the
> rewritten engine calls them via ports. Leaving them is correct: Plan 6 wraps, it does not re-home another
> context's helpers.

---

# Slice D — Domain build (the rewritten decision logic — GATE A must be green)

> **Entry gate: GATE A green (Task A.4 passed at least once), Slice C green, `ReviewPort` widened.** This is
> where rewritten decision logic is built. Each task validates against the Slice A goldens + Slice B harness
> as it lands. The dependency order inside the slice: value objects → `Run` aggregate → `RunDecisionService`
> → the NEW `FixLoop` → `RunQaUseCase` → `RewrittenOrchestratorAdapter`.

## Task D.1 — `Run` aggregate (identity RunId+Sha+App; guarded lifecycle; per-run reviewer-outage)

> NEW. Replaces the in-place-mutated `QaRunResult` local. Identity = RunId+Sha+App; guarded transitions
> gate→analyze→generate→validate→execute→decide. Critically, it makes `consecutiveReviewerFailures` (the
> module-level cross-run `let`, R2) PER-RUN state — the rewritten engine must not leak reviewer-outage across
> queue entries.

**Files:** `qa-engine/src/contexts/qa-run-orchestration/domain/run.aggregate.ts`,
`test/contexts/qa-run-orchestration/domain/run.aggregate.test.ts`

- [ ] Failing tests for the lifecycle invariants: (a) identity is RunId+Sha+App; (b) a guarded transition
  cannot skip a phase or finalize twice; (c) `recordReviewerFailure()` is per-instance (two `Run` instances
  do NOT share the counter — pins R2). See them fail.
- [ ] Minimal impl — the aggregate holds the run state + guarded transitions + per-run reviewer-outage:
  ```ts
  // src/contexts/qa-run-orchestration/domain/run.aggregate.ts
  // The Run aggregate (design §5.3(1)). Identity = RunId+Sha+App; the lifecycle (gate→analyze→generate→
  // validate→execute→decide) is guarded so a phase cannot be skipped and a finalized run cannot transition.
  // consecutiveReviewerFailures is PER-RUN here (eliminates the module-level cross-run let at pipeline.ts:82,
  // R2): reviewer-outage detection is instance state, not a process global.
  import type { Sha } from "@kernel/sha.ts";
  // ... RunPhase union, guarded transition methods, recordReviewerFailure()/reviewerOutage() per-instance.
  ```
- [ ] Run → pass. Typecheck → 0. Commit:
  ```bash
  git add qa-engine/src/contexts/qa-run-orchestration/domain/run.aggregate.ts \
          qa-engine/test/contexts/qa-run-orchestration/domain/run.aggregate.test.ts
  git commit -m "feat(qa-run-orchestration): Run aggregate with guarded lifecycle + per-run reviewer-outage (fixes R2)"
  ```

## Task D.2 — `CycleBudget` + `WallClockBudget` value objects

> NEW VOs for what are today raw `let` variables (`MAX_CYCLES`, `wallClockBudget`, `cycleCount`). They give
> the FixLoop's invariants a first-class representation. `CycleBudget` consumes the ported
> `deriveCycleBackstop` (C.2); the Phase-6b retroactive raise (from `objectiveCount`) is a guarded method.

**Files:** `qa-engine/src/contexts/qa-run-orchestration/domain/cycle-budget.ts`,
`wall-clock-budget.ts`, `test/.../cycle-budget.test.ts`, `test/.../wall-clock-budget.test.ts`

- [ ] Failing tests: `CycleBudget` derives from `deriveCycleBackstop(maxRetries)` unless `iterationBudget`
  overrides; `tick()` increments `cycleCount`; `exhausted()` is true past `MAX_CYCLES`; `raiseTo(objectiveCount)`
  is the Phase-6b bump and never lowers. `WallClockBudget` derives `MAX_CYCLES * agentTimeout(mode)` unless
  `wallClockBudgetMs` overrides (wins unconditionally, never recomputed), and recomputes ONLY when
  `CycleBudget.raiseTo` fires. See fail.
- [ ] Minimal impl → run → pass. Typecheck → 0. Commit:
  ```bash
  git add qa-engine/src/contexts/qa-run-orchestration/domain/cycle-budget.ts \
          qa-engine/src/contexts/qa-run-orchestration/domain/wall-clock-budget.ts \
          qa-engine/test/contexts/qa-run-orchestration/domain/cycle-budget.test.ts \
          qa-engine/test/contexts/qa-run-orchestration/domain/wall-clock-budget.test.ts
  git commit -m "feat(qa-run-orchestration): CycleBudget + WallClockBudget value objects"
  ```

## Task D.3 — `RunDecision` value object + `RunDecisionService` (PORT the ≥6 verdict branches into ONE pure fn)

> **PORT, the R1 anti-false-green piece.** The six-verdict policy is scattered across ≥6 sites. Consolidate
> into ONE pure auditable function by PORTING the branches — never rewriting the policy. A parity test pins
> EACH verdict path against the Slice A goldens.

**Files:** `qa-engine/src/contexts/qa-run-orchestration/domain/run-decision.ts` (VO),
`qa-engine/src/contexts/qa-run-orchestration/domain/run-decision.service.ts`,
`test/.../run-decision.service.test.ts`

- [ ] Catalog the exact verdict branches to port (grep the live sites; copy each predicate VERBATIM):
  ```bash
  rg -n "verdict: \"skipped\"|verdict: \"invalid\"|verdict: \"infra-error\"|verdict: \"flaky\"|verdict === \"pass\"|verdict !== \"pass\"" src/pipeline.ts
  sed -n '/function report(/,/^  }/p' src/pipeline.ts   # the green/fail/flaky switch in report()
  ```
  The branches to consolidate: `skipped` (classify-skip + agent no-op), `invalid` (context + static gate),
  `infra-error` (DEV-down sites), the green→PR / fail→Issue / flaky→quarantine switch, and the coverage
  `blocksPublish` hold (→Issue). Each maps to a `RunDecision = { verdict, sideEffect }`.
- [ ] `RunDecision` VO — verdict + the chosen side-effect (`pr` | `issue` | `shadow-log` | `quarantine` |
  `none`). Failing test that the VO is immutable and carries both fields.
- [ ] `RunDecisionService.decide(evidence): RunDecision` — a PURE function over the `Run` aggregate's
  evidence (verdict, generating, needsReview, reviewerApproved, blocksPublish, shadow). Write a failing test
  per verdict path FIRST (one test per branch), see them fail.
  ```ts
  // src/contexts/qa-run-orchestration/domain/run-decision.service.ts
  // PORT (not a rewrite). The six-verdict policy (scattered across ≥6 sites in pipeline.ts) consolidated
  // into ONE pure, auditable function. Each branch is copied from its legacy site; the parity tests pin
  // every verdict path against the Slice A goldens. This is the R1 (false-green) hotspot — characterized
  // first (Slice A) and trusted last.
  export function decide(ev: RunEvidence): RunDecision { /* ported branches, precedence-ordered */ }
  ```
- [ ] Minimal impl porting the branches in their legacy precedence order → run → pass.
- [ ] **Parity pin against the goldens:** a test that feeds each of the 10 scenarios' evidence into `decide()`
  and asserts the `RunDecision.verdict` + `sideEffect` match the golden + `EXPECTED_SIDE_EFFECT` table from
  Task A.4. This proves the consolidation reproduces the scattered policy EXACTLY.
  ```bash
  node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/qa-run-orchestration/domain/run-decision.service.test.ts"
  ```
  Expected: every verdict path pins to its golden.
- [ ] Typecheck → 0. Commit:
  ```bash
  git add qa-engine/src/contexts/qa-run-orchestration/domain/run-decision.ts \
          qa-engine/src/contexts/qa-run-orchestration/domain/run-decision.service.ts \
          qa-engine/test/contexts/qa-run-orchestration/domain/run-decision.service.test.ts
  git commit -m "feat(qa-run-orchestration): RunDecisionService — consolidate the 6-verdict policy by porting (R1 pinned)"
  ```

## Task D.4 — The NEW `FixLoop` aggregate (THE HARDEST + RISKIEST BUILD — flag it)

> ⚠️ **THIS IS THE HARDEST TASK IN THE PLAN.** The ~340-line block (pipeline.ts ~2416–2760) interleaves IO +
> decisions with no existing port equivalent. PORT the logic VERBATIM into a guarded aggregate;
> characterization-cover it; validate against Slice A/B. Do NOT rewrite the policy — preserve
> `deriveCycleBackstop`/`adjudicate`/`bestRunSoFar`/filtered-retry exactly. Build it incrementally with a
> failing test per sub-decision.

**Files:** `qa-engine/src/contexts/qa-run-orchestration/domain/fix-loop.aggregate.ts`,
`qa-engine/src/contexts/qa-run-orchestration/domain/adjudicate.service.ts` (re-ported VERBATIM from
test-execution's `adjudicate.service.ts` — see the resolution step below), `test/.../fix-loop.aggregate.test.ts`,
`test/.../fix-loop-characterization.test.ts`, `test/.../adjudicate-parity.test.ts` (pins the re-ported copy to
the test-execution original)

- [ ] Read the WHOLE legacy fix-loop block VERBATIM before writing anything (it is the contract):
  ```bash
  rg -n "MAX_RETRIES|adjudicate\(|bestRunSoFar|checkSpecSelectors|absentKeys|filtered|retryNs|coverageNs" src/pipeline.ts | head -40
  sed -n '/const MAX_RETRIES =/,/regression guard/p' src/pipeline.ts | head -200   # adjust the end anchor to the block
  ```
  Map each sub-decision: (1) loop condition (`retry < MAX_RETRIES && verdict==='fail' && generating`);
  (2) Lever-2 selector check (`checkSpecSelectors` per failed case vs failure-point trees); (3) pure
  `adjudicate(evidence) → 'break-issue' | 'break-needs-human' | 'continue'`; (4) `break-issue` with
  RUNNER_INFRA/DEV_INFRA → infra-error else realBugDetected; (5) regen via `generateAndReview({fixCases,
  selectorContradictions, domSnapshot}, {review:'skip'})`; (6) Lever-2 short-circuit (`absentKeys.size>0` →
  skip re-execute, loop again); (7) e2e re-validate + devHealthy + execute under `retryNs`; (8) filtered-retry
  (scope to failing spec files when `!coverageWillMeasure`); (9) merge filtered results; (10) `coverageNs`
  tracks the winning run; (11) `bestRunSoFar` regression guard (fewest failures) after the loop.
- [ ] Resolve the `adjudicate` dependency EXPLICITLY (it is confirmed to live in the test-execution domain at
  `qa-engine/src/contexts/test-execution/domain/adjudicate.service.ts`, and there is NO `AdjudicatePort` in the
  qa-run-orchestration ports barrel). The qa-run-orchestration domain MUST NOT import directly from the
  test-execution domain — a cross-context domain dependency violates the hexagonal structure. **Decision
  (chosen): re-port `adjudicate()` VERBATIM into a qa-run-orchestration domain helper/service**
  (`domain/adjudicate.service.ts`), exactly like `deriveCycleBackstop` (C.2): copy the pure body, pin it with a
  PARITY test against the test-execution original across a sample evidence table, and add that parity test to
  the qa-engine typecheck `exclude` list if it imports the sibling original as an oracle. `adjudicate` is part
  of the FixLoop's ported logic; re-homing the pure predicate keeps the domain self-contained with NO
  cross-context coupling and NO new port. (The rejected alternative — adding an `AdjudicatePort` to the barrel
  and wiring it in the composition root — is avoided because `adjudicate` is a pure function, not an IO
  capability; a port would add ceremony without inversion value.) Confirm the original shape before copying:
  ```bash
  rg -n "adjudicate" qa-engine/src/contexts/test-execution/domain/adjudicate.service.ts src/pipeline.ts | head
  sed -n '/export function adjudicate/,/^}/p' qa-engine/src/contexts/test-execution/domain/adjudicate.service.ts
  ```
- [ ] Write failing tests for the sub-decisions IN ISOLATION (the FixLoop drives stub `ExecutionPort`/
  `GenerationPort`/`SelectorCheckService`): (a) `break-issue` with infra → infra-error, no regen; (b)
  `break-issue` real-bug → Issue; (c) Lever-2 `absentKeys` short-circuit skips re-execute; (d) filtered-retry
  scopes to failing files only when coverage won't measure; (e) `bestRunSoFar` keeps the fewest-failures run.
  See them fail.
- [ ] Minimal impl — the aggregate with cycle/wall-clock budget invariants (consuming D.2's VOs), driving the
  injected ports. PORT each branch verbatim; the budget guards run at every regen entry:
  ```ts
  // src/contexts/qa-run-orchestration/domain/fix-loop.aggregate.ts
  // FixLoop aggregate (design §5.3(1)). PORTS pipeline.ts ~2416–2760 VERBATIM into a guarded structure:
  // per retry — Lever-2 selector check → adjudicate (pure) → regen (review:skip) → Lever-2 short-circuit →
  // re-validate + devHealthy + execute under a per-attempt namespace → filtered-retry → bestRunSoFar
  // regression guard. Budget invariants (CycleBudget/WallClockBudget) guard every regen entry. NO policy
  // rewrite — this is the riskiest port; the characterization test validates it against the Slice A/B net.
  ```
- [ ] Run → pass. Then write the **characterization test** that drives the FixLoop through the `fail-issue`
  and `invalid-issue` scenarios' retry counts (`fail-issue` has `retries:1`, `invalid-issue` has `retries:2`
  per the goldens) and asserts the loop reproduces those exact retry counts + final verdict:
  ```bash
  node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/qa-run-orchestration/domain/fix-loop-characterization.test.ts"
  ```
  Expected: retry counts + verdicts match the goldens (`fail-issue` retries:1, `invalid-issue` retries:2).
- [ ] Typecheck → 0. Commit:
  ```bash
  git add qa-engine/src/contexts/qa-run-orchestration/domain/fix-loop.aggregate.ts \
          qa-engine/src/contexts/qa-run-orchestration/domain/adjudicate.service.ts \
          qa-engine/test/contexts/qa-run-orchestration/domain/fix-loop.aggregate.test.ts \
          qa-engine/test/contexts/qa-run-orchestration/domain/fix-loop-characterization.test.ts \
          qa-engine/test/contexts/qa-run-orchestration/domain/adjudicate-parity.test.ts \
          qa-engine/tsconfig.json
  git commit -m "feat(qa-run-orchestration): FixLoop aggregate + re-ported adjudicate (verbatim, parity-pinned), characterized"
  ```

## Task D.5 — `RunQaUseCase` (the structural replacement for the runPipeline body, ports-only)

> NEW. The main deliverable — composes `Run`, `RunDecisionService`, `FixLoop`, and the 11 ports through the
> full lifecycle. NO inline IO, NO prompt strings, NO learning side-effects (those go through `LearningPort`,
> off-path). Build phase-by-phase; validate each wired phase against the goldens.

**Files:** `qa-engine/src/contexts/qa-run-orchestration/application/run-qa.use-case.ts`,
`test/contexts/qa-run-orchestration/application/run-qa.use-case.test.ts`

- [ ] Failing test: drive `RunQaUseCase` with FULLY STUBBED ports (the same shapes the `scenarios.ts` stubs
  provide) for the `green-pr` path → assert it reaches `decide` and returns the `pass`/PR `RunDecision`. See
  fail.
- [ ] **Failing test — the silent-mismatch invariant, written HERE not discovered in D.7.** When W1/W2
  (pre-exec ambiguity / deterministic selector) is NOT wired, `RunQaUseCase` MUST emit
  `preExecAmbiguityCatches: 0` and `deterministicSelectorBlocks: 0` — the NUMBER `0`, never `undefined`/absent.
  The comparator ignores these fields, so a `0`-vs-`undefined` mismatch would be INVISIBLE at the gate; this
  test closes the hole BEFORE the impl, so D.7's cross-validation confirms it rather than first finding it:
  ```ts
  test("RunQaUseCase emits preExecAmbiguityCatches:0 + deterministicSelectorBlocks:0 (number, not undefined) when W1/W2 unwired", async () => {
    const out = await useCase.run(/* green-pr stubbed ports, no W1/W2 wiring */);
    assert.equal(typeof out.gateSignals.preExecAmbiguityCatches, "number");
    assert.equal(out.gateSignals.preExecAmbiguityCatches, 0);
    assert.equal(typeof out.gateSignals.deterministicSelectorBlocks, "number");
    assert.equal(out.gateSignals.deterministicSelectorBlocks, 0);
  });
  ```
  See it fail (the field is `undefined`/absent until the impl explicitly emits `0`).
- [ ] Minimal impl — the lifecycle, ports-only. Wire the phases in legacy order: gate (`DeployGatePort`) →
  prepare (`WorkspacePort`) → classify (`ChangeAnalysisPort`, diff mode → skip short-circuit) → generate
  (`GenerationPort`) → validate (`ValidationPort`, static-fix loop) → health → execute (`ExecutionPort`) →
  FixLoop (D.4) → measure (`ObjectiveSignalPort`, the keystone) → review (`ReviewPort`) → decide
  (`RunDecisionService`) → publish (`PublicationPort`) → persist (`RunHistoryPort`) → fold (`LearningPort`,
  off-path). The agent no-op (`approved && specs.length===0`) → `skipped`, honored exactly:
  ```ts
  // src/contexts/qa-run-orchestration/application/run-qa.use-case.ts
  // RunQaUseCase (design §5.3(1)) — the structural replacement for runPipeline's 2400-line body. Drives the
  // Run lifecycle ENTIRELY through the 11 segregated ports: no inline IO, no prompt strings, no learning
  // side-effects on the verdict path. The agent's no-op decision (approved + zero specs) is a VALID skipped,
  // never invalid (CLAUDE.md invariant). The keystone (ObjectiveSignalPort: unknown NEVER blocks) is consumed
  // here, never re-implemented. gateSignals.preExecAmbiguityCatches / deterministicSelectorBlocks are
  // emitted as the NUMBER 0 (not undefined) when W1/W2 is unwired — pins the comparator's silent-mismatch hole.
  ```
- [ ] Validate phase-by-phase against the goldens: after wiring each phase, run the use-case for the
  scenarios that exercise it and assert the verdict matches. Add a use-case-level scenario test that drives
  ALL 10 scenarios through `RunQaUseCase` with the stubbed ports and asserts `RunDecision` ≡ golden +
  expected side effect (mirrors Task A.4 but for the rewritten core):
  ```bash
  node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/qa-run-orchestration/application/run-qa.use-case.test.ts"
  ```
  Expected: all 10 scenario verdicts + side effects match the goldens through the rewritten use-case.
- [ ] Typecheck → 0. Commit:
  ```bash
  git add qa-engine/src/contexts/qa-run-orchestration/application/run-qa.use-case.ts \
          qa-engine/test/contexts/qa-run-orchestration/application/run-qa.use-case.test.ts
  git commit -m "feat(qa-run-orchestration): RunQaUseCase — the ports-only lifecycle replacing runPipeline's body"
  ```

## Task D.6 — `RewrittenOrchestratorAdapter` (RunPipelinePort over the domain — STUB-FREE shell)

> NEW. Implements `RunPipelinePort.run(RunInput)` by composing `RunQaUseCase` + the domain. In this task it
> is wired against the SAME stubbed ports as D.5 (so its scenario test runs without real infra); Slice E
> swaps the stubs for REAL adapters at the composition root so it becomes the COMPLETE engine. **It is NOT a
> stub — its `run()` fully drives the use-case; only the port IMPLEMENTATIONS are swapped at wiring time.**

**Files:** `qa-engine/src/contexts/qa-run-orchestration/infrastructure/rewritten-orchestrator.adapter.ts`,
`test/.../rewritten-orchestrator.adapter.test.ts`

- [ ] Failing test: construct the adapter with the stubbed ports + run the `green-pr` `RunInput` → assert
  `RunOutcome.verdict === "pass"`. See fail.
- [ ] Minimal impl — map `RunInput` → `RunQaUseCase` invocation → map the resulting `RunDecision` + `Run`
  evidence to a `RunOutcome` (the same shape `RunHistoryPort.save` persists). NO decision lives here; it
  composes:
  ```ts
  // src/contexts/qa-run-orchestration/infrastructure/rewritten-orchestrator.adapter.ts
  // RewrittenOrchestratorAdapter (design §5.3(1)) — RunPipelinePort over the rewritten domain. COMPLETE: it
  // fully drives RunQaUseCase through the 11 ports. The composition root (Slice E) supplies REAL port
  // adapters so this runs a full QA run end-to-end (required for the Slice F shadow run). Only the port
  // implementations are swapped between the unit test (stubs) and production (real adapters) — the adapter
  // logic is identical.
  ```
- [ ] Run → pass. Run the 10-scenario equivalence (rewritten adapter vs golden, mirroring A.4):
  ```bash
  node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/qa-run-orchestration/infrastructure/rewritten-orchestrator.adapter.test.ts"
  ```
  Expected: rewritten adapter ≡ all 10 goldens through the stubbed ports.
- [ ] Typecheck → 0. Commit:
  ```bash
  git add qa-engine/src/contexts/qa-run-orchestration/infrastructure/rewritten-orchestrator.adapter.ts \
          qa-engine/test/contexts/qa-run-orchestration/infrastructure/rewritten-orchestrator.adapter.test.ts
  git commit -m "feat(qa-run-orchestration): RewrittenOrchestratorAdapter — complete RunPipelinePort over the domain"
  ```

## Task D.7 — Cross-validate the rewritten engine against the 186-harness (the false-green gate)

> The decisive validation: replay the SAME 186 scenarios through BOTH `LegacyPipelineAdapter` AND
> `RewrittenOrchestratorAdapter` (with stubbed ports matching the scenario deps) and assert
> `runOutcomeEquivalent(legacy, rewritten)` + identical side effects, consulting the allowlist. Undeclared
> divergence FAILS. This is what makes the rewritten decision logic trusted (R1).

**Files:** `qa-engine/test/characterization/golden-outcome.harness.ts` (extend to drive BOTH engines)

- [ ] **Stub-fidelity precondition (close the vacuous-green hole).** The `RewrittenOrchestratorAdapter` runs
  through STUBBED ports here, while the `LegacyPipelineAdapter` runs through the legacy `scenarios.ts`
  `PipelineDeps`. If a rewritten stub returns a different shape than the legacy dep it stands in for, the
  cross-validation can be vacuously green. Before the dual-engine loop:
  - Derive the rewritten stub ports for each scenario FROM the same `scenarios.ts` source (one fixture origin —
    do NOT author a parallel stub set), so a `GenerationPort.generate` stub returns the SAME specs/approved the
    legacy `deps.generateAndReview` stub returns, an `ExecutionPort.execute` stub returns the SAME
    `{verdict, cases, logs}` the legacy `deps.execute` stub returns, etc.
  - Add an explicit assertion (or a header-comment contract enumerating each mapping) that documents WHICH
    ports are stubbed vs real in this harness and that each stub's return shape is structurally identical to
    the legacy dep it mirrors. A divergent stub shape FAILS this precondition before the equivalence loop runs.
- [ ] Extend the harness loop to run both engines per scenario and compare them to EACH OTHER (not just to a
  golden), so families beyond the 10 goldens are also pinned:
  ```ts
  // For each of the 186 scenarios: run BOTH engines, assert runOutcomeEquivalent(legacy, rewritten) +
  // identical side effect. The comparator does NOT model side effects — assert those separately (probe).
  // Both engines are driven from the SAME scenarios.ts fixture origin (stub-fidelity precondition above) so
  // the comparison is real behavioral divergence, never a stub-shape artifact.
  // Undeclared divergence fails; declared fingerprints (parity-allowlist.json) are suppressed.
  ```
  > Handle the comparator hazards (brief crux #4) HERE: `rulesRetrieved` (declare if the rewritten engine
  > wires a real `LearningPort.retrieve` and the legacy stub returns `[]`); `preExecAmbiguityCatches`/
  > `deterministicSelectorBlocks` (the rewritten engine MUST emit `0`, not `undefined`, when W1/W2 isn't
  > wired — otherwise the `0`-vs-`undefined` mismatch is INVISIBLE to the comparator). The `0`-not-`undefined`
  > invariant is already enforced by a Task D.5 unit test; this step CONFIRMS it across all 186 via an explicit
  > shape-equality assertion for these two fields OUTSIDE the comparator (`typeof === "number"` on BOTH the
  > legacy and rewritten outcome), closing the silent-mismatch hole at the cross-validation gate too — D.5
  > catches a regression in the rewritten core, D.7 catches a legacy-vs-rewritten shape divergence.
- [ ] Run the dual-engine 186-harness:
  ```bash
  node --import ./test-setup.mjs --import tsx --test "qa-engine/test/characterization/golden-outcome.harness.ts" 2>&1 | tail -10
  ```
  Expected: legacy ≡ rewritten for all 186 (+ the explicit pre-exec/usage field assertions). Any divergence →
  triage (rewritten bug → fix D.3/D.4/D.5; intentional → allowlist entry with approver).
- [ ] Typecheck → 0. Commit:
  ```bash
  git add qa-engine/test/characterization/golden-outcome.harness.ts
  git commit -m "test(characterization): cross-validate legacy ≡ rewritten across all 186 scenarios (R1 gate)"
  ```

---

# Slice E — Bridge adapters + composition root + the PIPELINE_ENGINE flag (the COMPLETE engine, behind the shadow seam)

> **Entry gate: Slice D green (legacy ≡ rewritten, 186).** Wire ALL 11 ports to REAL adapters so the
> rewritten engine can run a full QA run end-to-end (required for Slice F). The flag SELECTS the engine at the
> runner/CLI seam, DEFAULT `legacy`. This is the SHADOW SEAM, not the cutover — the default never changes in
> Plan 6.
>
> ⚠️ **The 11 bridge adapters do NOT exist yet — Task E.0 builds them FIRST.** Verified vs HEAD:
> `rg implements (ChangeAnalysisPort|GenerationPort|ReviewPort|ValidationPort|ExecutionPort|ObjectiveSignalPort|PublicationPort|LearningPort|WorkspacePort|DeployGatePort|RunHistoryPort)`
> over `qa-engine/src/` returns **ZERO**. Each sibling context has its own internal ports and adapters
> (`GenerateTestsUseCase` uses generation's `GenerationPorts`, `ShadowLogAdapter` implements
> `ShadowPublicationPort`, `static-gate.adapter.ts`/the execution strategies implement test-execution's
> internal ports), but NONE implements the `qa-run-orchestration`-facing interface. `DeployGatePort` and
> `RunHistoryPort` have ONLY a kernel/port declaration — no concrete adapter at all. So the composition root
> (Task E.2) would have nothing REAL to wire and its inventory grep would trip the STOP gate. **Task E.0
> closes this gap by building the 11 thin bridges — this is in Plan 6's scope, not assumed from Plans 1–5.**

## Task E.0 — Build the 11 bridge/facade adapters (one `qa-run-orchestration` port → its sibling-context entry point)

> **NEW, and the prerequisite for the whole slice.** No concrete adapter in `qa-engine/src` implements ANY of
> the 11 orchestration ports today. Each bridge is a THIN adapter: it implements the `qa-run-orchestration`
> port interface (`ports/index.ts`) and delegates to the sibling context's existing entry point (use-case /
> adapter / service), translating shapes only. NO new policy — the sibling logic is reused verbatim. Build
> them with a failing test per bridge (construct with a fake/real collaborator, assert the port method
> delegates and maps the shape), minimal impl, isolated gate, one commit per bridge (or grouped by context if
> trivial). Two bridges have NO existing concrete adapter to wrap and need a minimal REAL implementation:
> `DeployGatePort` (an HTTP gate over the `/version` poll + a Null gate for no-`versionUrl` apps) and
> `RunHistoryPort` (a save over the persisted-outcome store — SQLite if the control-plane repo exists, else a
> minimal in-memory/file impl). The bridges live in
> `qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/`.

**Files:** `qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/*.adapter.ts` (11),
`test/contexts/qa-run-orchestration/infrastructure/bridges/*.adapter.test.ts`

- [ ] Re-confirm the gap and the sibling entry points to wrap (grep — record the exact symbols/paths so each
  bridge wraps a REAL collaborator, not an invented one):
  ```bash
  cd /Users/arielyumn/Desktop/TRABAJO/ai-pipeline
  rg -n "implements (ChangeAnalysisPort|GenerationPort|ReviewPort|ValidationPort|ExecutionPort|ObjectiveSignalPort|PublicationPort|LearningPort|WorkspacePort|DeployGatePort|RunHistoryPort)" qa-engine/src/ || echo "ZERO — bridges absent, Task E.0 builds them (expected)"
  rg -ln "class GenerateTestsUseCase"                          qa-engine/src/contexts/generation/
  rg -ln "class AnalyzeChangeUseCase|analyze-change.use-case"  qa-engine/src/contexts/change-analysis/
  rg -ln "StaticGateAdapter|e2e-execution.strategy|code-execution.strategy" qa-engine/src/contexts/test-execution/
  rg -ln "DecideCoverageService|coverage-collector.adapter"    qa-engine/src/contexts/objective-signal/
  rg -ln "ShadowLogAdapter|GitHubPrAdapter|GitHubIssueAdapter|mirror-gc.adapter" qa-engine/src/contexts/workspace-and-publication/
  rg -ln "deploy-gate.port"                                    qa-engine/src/shared-kernel/ports/
  ```
  Expected: the `implements` grep is EMPTY (confirms the bridges are absent). The sibling entry points resolve
  to: generation `GenerateTestsUseCase`; change-analysis `AnalyzeChangeUseCase`; test-execution
  `static-gate.adapter.ts` (validate) + `e2e/code-execution.strategy.ts` (execute); objective-signal
  `DecideCoverageService` + `coverage-collector.adapter.ts`; workspace-and-publication
  github-pr/github-issue/shadow-log + `mirror-gc.adapter.ts`; the kernel `deploy-gate.port.ts` interface (no
  adapter — E.0 writes one). `RunHistoryPort` has NO sibling adapter — E.0 writes the save impl.
- [ ] Build the 11 bridges, each TDD (failing delegation test → minimal map → pass). The mapping per port:
  - **`ChangeAnalysisPortAdapter`** → `AnalyzeChangeUseCase` (analyze→`BlastRadius`, classify→action/reason).
  - **`GenerationPortAdapter`** → `GenerateTestsUseCase` (objectives+specDir → `{specs, approved, note}`).
  - **`ReviewPortAdapter`** → the generation reviewer flow; MUST surface `parsed` + `blockingCount` (the
    Slice C widening — this is the bridge that consumes it; a parse miss ⇒ `parsed:false`, distinct from a
    real `approved:false`). The #1 fail-closed invariant lands HERE.
  - **`ValidationPortAdapter`** → `static-gate.adapter.ts` (`{ok, errors, infra?}`).
  - **`ExecutionPortAdapter`** → the e2e/code strategy dispatch (`{verdict, cases, logs}`).
  - **`ObjectiveSignalPortAdapter`** → `DecideCoverageService` + `coverage-collector.adapter.ts`. **The
    keystone passes through UNCHANGED** — `unknown` NEVER blocks; this bridge adds NO coverage logic, it only
    adapts `measure()` onto the already-ported decide service.
  - **`PublicationPortAdapter`** → github-pr/github-issue/shadow-log adapters (one `publish(decision)` routes
    to PR / Issue / shadow-log per verdict — the legacy E2e/Code/Context/Subset fan-out collapsed here).
  - **`LearningPortAdapter`** → cross-run-learning fold/retrieve. **Off-path by contract** — a fold failure is
    logged and swallowed, NEVER gates publish (carry that invariant). v1 `retrieve` may be the `[]` stub.
  - **`WorkspacePortAdapter`** → the mirror prepare (`prepare(sha) → {specDir}`). Cross-repo routing stays
    OPAQUE inside this bridge (brief: WorkspacePort opaque for Plan 6).
  - **`DeployGatePortAdapter`** → a REAL minimal HTTP gate over the `/version` poll (`waitForDeploy`-equivalent)
    PLUS a `NullDeployGateAdapter` returning ready immediately for no-`versionUrl`/static/code targets. NO
    sibling adapter exists — write this one.
  - **`RunHistoryPortAdapter`** → a REAL `save(outcome)`. NO sibling adapter exists — write a minimal impl
    (SQLite via the control-plane repo if present; otherwise a small in-memory/file store). This inverts the
    leaky dynamic `import()` the legacy uses at `pipeline.ts:487-619`.
- [ ] Isolated gate per bridge + typecheck → 0:
  ```bash
  node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/qa-run-orchestration/infrastructure/bridges/**/*.test.ts" 2>&1 | tail -10
  npx tsc --noEmit -p qa-engine/tsconfig.json
  ```
  Expected: every bridge test passes; typecheck exits 0; the inventory grep in Task E.2 will now find 11
  `implements`.
- [ ] Commit (one per bridge, or grouped by sibling context — qa-engine paths only):
  ```bash
  git add qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/ \
          qa-engine/test/contexts/qa-run-orchestration/infrastructure/bridges/
  git commit -m "feat(qa-run-orchestration): 11 bridge adapters wiring each orchestration port to its sibling context"
  ```
  > Split into per-context commits if the diff is large (chained-PR discipline). The two REAL impls
  > (`DeployGatePortAdapter` + `RunHistoryPortAdapter`) get their own commits since they are not thin wrappers.

## Task E.1 — `pipeline-engine-flag.ts` (the named selector, default legacy)

**Files:** `qa-engine/src/contexts/qa-run-orchestration/composition/pipeline-engine-flag.ts`,
`test/.../pipeline-engine-flag.test.ts`

- [ ] Failing test: `selectEngine(env)` returns `"legacy"` when `PIPELINE_ENGINE` is absent/`"legacy"` and
  `"rewritten"` only on the exact `"rewritten"` value (fail-safe default). See fail.
- [ ] Minimal impl:
  ```ts
  // src/contexts/qa-run-orchestration/composition/pipeline-engine-flag.ts
  // PIPELINE_ENGINE selects LegacyPipelineAdapter (default) vs RewrittenOrchestratorAdapter behind
  // RunPipelinePort (design §7.3 Step 2). DEFAULT legacy — the shadow seam, NOT the cutover. Plan 6 never
  // ships rewritten as the default; the cutover (flip default) is Plan 7, justified by the Slice F evidence.
  export const PIPELINE_ENGINE = "PIPELINE_ENGINE" as const;
  export type EngineChoice = "legacy" | "rewritten";
  export function selectEngine(env: Record<string, string | undefined>): EngineChoice {
    return env[PIPELINE_ENGINE] === "rewritten" ? "rewritten" : "legacy";
  }
  ```
- [ ] Run → pass. Typecheck → 0. Commit:
  ```bash
  git add qa-engine/src/contexts/qa-run-orchestration/composition/pipeline-engine-flag.ts \
          qa-engine/test/contexts/qa-run-orchestration/composition/pipeline-engine-flag.test.ts
  git commit -m "feat(qa-run-orchestration): PIPELINE_ENGINE flag selector (default legacy — shadow seam)"
  ```

## Task E.2 — `composition-root.ts` (`buildProduction`/`buildShadow` — ALL 11 ports → REAL adapters)

> NEW. The ONLY module that imports concrete adapters (arch-lint permits it — it sits outside generation/
> agent-runtime). It wires every port to the REAL bridge adapter **built in Task E.0** so the rewritten
> engine is COMPLETE (not stubbed) and can run a full QA run. `buildShadow()` selects the publication bridge's
> shadow-log path and a read-only history snapshot. Returns a `RunPipelinePort` chosen by the flag.

**Files:** `qa-engine/src/contexts/qa-run-orchestration/composition/composition-root.ts`,
`test/.../composition-root.test.ts`

- [ ] Inventory the 11 bridge adapters to wire (one per port) — confirm each was built by **Task E.0** (the
  sibling-context concrete adapters do NOT implement these interfaces; only the E.0 bridges do):
  ```bash
  rg -n "implements (ChangeAnalysisPort|GenerationPort|ReviewPort|ValidationPort|ExecutionPort|ObjectiveSignalPort|PublicationPort|LearningPort|DeployGatePort|WorkspacePort|RunHistoryPort)" qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/ -l
  ```
  Expected: **11** bridge adapters matched under `infrastructure/bridges/` — one per port. Each bridge
  delegates to its sibling-context entry point (`ChangeAnalysisPortAdapter`→`AnalyzeChangeUseCase`;
  `GenerationPortAdapter`→`GenerateTestsUseCase`; `ReviewPortAdapter`→generation reviewer with
  `parsed`+`blockingCount`; `ValidationPortAdapter`→`static-gate.adapter.ts`; `ExecutionPortAdapter`→the
  e2e/code strategies; `ObjectiveSignalPortAdapter`→`DecideCoverageService` keystone, consumed verbatim;
  `PublicationPortAdapter`→github-pr/github-issue/shadow-log; `LearningPortAdapter`→cross-run-learning (v1
  stub); `WorkspacePortAdapter`→mirror prepare; `DeployGatePortAdapter`→the HTTP/Null gate E.0 wrote;
  `RunHistoryPortAdapter`→the save impl E.0 wrote). **If the grep returns fewer than 11, STOP and report —
  Task E.0 is incomplete; the rewritten engine cannot be COMPLETE and Slice F is blocked. Go back and finish
  E.0; do NOT stub the missing port to proceed.**
- [ ] Failing test: `buildProduction(env, cfg)` returns a `RunPipelinePort`; with `PIPELINE_ENGINE=legacy`
  it is a `LegacyPipelineAdapter`, with `=rewritten` a `RewrittenOrchestratorAdapter`; `buildShadow(cfg)`
  wires `ShadowLogAdapter` (no PR/Issue). Use lightweight fakes for the heavy adapters in THIS unit test
  (the real wiring is exercised end-to-end in Slice F). See fail.
- [ ] Minimal impl — the factory that selects the engine by flag and wires all 11 ports:
  ```ts
  // src/contexts/qa-run-orchestration/composition/composition-root.ts
  // The composition root (design §5.2). The ONLY module that imports concrete adapters — it sits outside
  // generation/* and agent-runtime/*, so the arch-lint VCS-write gate stays green. Wires ALL 11 ports to the
  // REAL bridge adapters built in Task E.0 so the rewritten engine is COMPLETE and runs a full QA run e2e.
  // buildShadow() swaps PublicationPort for ShadowLogAdapter and reads a pre-run history snapshot (no side
  // effects). The flag (E.1) picks LegacyPipelineAdapter (default) vs RewrittenOrchestratorAdapter behind
  // one RunPipelinePort. Replaces defaultPipelineDeps().
  export function buildProduction(env, cfg): RunPipelinePort { /* select + wire */ }
  export function buildShadow(cfg): RunPipelinePort { /* rewritten + ShadowLogAdapter + read-only history */ }
  ```
- [ ] Run → pass. Typecheck → 0. Commit:
  ```bash
  git add qa-engine/src/contexts/qa-run-orchestration/composition/composition-root.ts \
          qa-engine/test/contexts/qa-run-orchestration/composition/composition-root.test.ts
  git commit -m "feat(qa-run-orchestration): composition root wiring all 11 ports to real adapters (buildProduction/buildShadow)"
  ```

## Task E.3 — The single runner/CLI flag-dispatch seam (the ONLY `src/` touch in Plan 6)

> ⚠️ **THE ONLY PERMITTED `src/` EDIT.** Dispatch only — the default-legacy path's behavior is UNCHANGED. The
> brief allows exactly this: read the flag at the runner/CLI seam and select the engine. Do NOT touch any
> other `src/` file. Do NOT change `runPipeline`. The `runner.ts:103` `?? defaultPipelineDeps()` fallback
> becomes flag-aware; `cli.ts` passes the composition-root engine. With `PIPELINE_ENGINE` absent, behavior is
> byte-identical to today.

**Files:** `src/server/runner.ts` (flag-aware dispatch only), `src/cli.ts` (pass the composition-root engine)

- [ ] Confirm the seam shape is unchanged at HEAD (the user may have edited the runner):
  ```bash
  rg -n "deps.pipeline \?\? defaultPipelineDeps\(\)|await runPipeline\(|enqueueTrackedRun" src/server/runner.ts
  rg -n "enqueueTrackedRun|RunnerDeps|pipeline:" src/cli.ts
  ```
  Expected: `runner.ts` has the `deps.pipeline ?? defaultPipelineDeps()` fallback (~line 103) and a single
  `await runPipeline(...)` call (~line 120); `cli.ts` calls `enqueueTrackedRun` WITHOUT a `pipeline:` dep.
- [ ] Write a failing test at the qa-engine boundary FIRST (the dispatch decision is unit-testable without
  booting the server): assert that the flag-aware selector returns the rewritten `RunPipelinePort` when
  `PIPELINE_ENGINE=rewritten` and legacy otherwise — this lives in `composition-root.test.ts` (E.2) or a thin
  dispatch test. See fail (if not already covered by E.1/E.2, add it).
- [ ] Minimal `src/` edit — DISPATCH ONLY. Make the runner consult the composition root for the engine while
  preserving the EXACT legacy path when the flag is absent. The smallest change: when `PIPELINE_ENGINE` is
  unset/`legacy`, keep calling `runPipeline` with `defaultPipelineDeps()` exactly as today; when `rewritten`,
  route through `RunPipelinePort.run(input)` from `buildProduction(process.env, appConfig)`. Guard so the
  default path is untouched:
  ```ts
  // src/server/runner.ts — dispatch seam (legacy path behavior UNCHANGED when PIPELINE_ENGINE is absent).
  // When the flag is unset/"legacy", this is the existing runPipeline(appConfig, …, defaultPipelineDeps()).
  // When "rewritten", route through the composition root's RunPipelinePort. NO change to runPipeline itself.
  ```
  ```ts
  // src/cli.ts — pass the composition-root engine into RunnerDeps so manual `npm run qa` honors the flag
  // (otherwise runner.ts's ?? defaultPipelineDeps() fallback always fires legacy). Default stays legacy.
  ```
  > **Keep the diff MINIMAL and dispatch-only.** This is a hot path (CLAUDE.md: pin behavior). The PR rule
  > fires — a fresh-context adversarial review of this `src/` diff is REQUIRED before commit (the orchestrator
  > handles that gate). Confirm the legacy path is byte-identical with the flag absent.
- [ ] Run the FULL gate (this touches `src/`, so the root suite must be green):
  ```bash
  npx tsc --noEmit -p qa-engine/tsconfig.json
  npm run typecheck
  npm test 2>&1 | tail -15
  ```
  Expected: typecheck + the full suite green; the 186-harness still passes; the legacy path unchanged.
- [ ] Commit (the ONE `src/` commit — qa-engine paths if any test files, plus the two `src/` dispatch files):
  ```bash
  git add src/server/runner.ts src/cli.ts
  git commit -m "feat(runner): PIPELINE_ENGINE flag-dispatch seam (default legacy; shadow seam, no cutover)"
  ```

---

# Slice F — Shadow run (the real-execution proof BEFORE the cutover — the user's explicit ask)

> **Entry gate: Slice E CI-gated green — which REQUIRES Task E.0's 11 bridge adapters to be built.** Without
> them the composition root cannot wire a COMPLETE `RewrittenOrchestratorAdapter` and the shadow run has
> nothing real to run. The fire-test: run the COMPLETE rewritten engine end-to-end with
> `PIPELINE_ENGINE=rewritten` against a live Spring-microservice DEV (petclinic/jhipster, `shadow:true`) and
> compare its `RunOutcome` to the legacy engine on the SAME SHA. shadow:true ⇒ NO PR/Issue (logs only).
> **Structure: the build/wiring + comparison logic are CI-gated (the Plan 6 deliverable); the actual run is an
> OPERATOR-INVOKED documented command** (it needs docker DEV up + `OPENCODE_API_KEY` — not available in CI).
> The CI-gated build is reachable ONLY once Slice E (incl. E.0) is green; if E.0 is incomplete, Slice F STOPS
> at the Task E.2 inventory gate, not here.

## Task F.1 — The shadow-comparison harness (CI-gated build; the comparison logic is unit-tested)

> Build the comparison harness that, given two `RunOutcome`s (legacy + rewritten) from the same SHA, asserts
> `runOutcomeEquivalent` + identical side-effect intent and emits a human-readable report. The COMPARISON
> LOGIC is CI-testable with fixture outcomes; the actual engine RUN is operator-invoked (F.2).

**Files:** `qa-engine/test/characterization/shadow-comparison.ts`,
`test/characterization/shadow-comparison.test.ts`

- [ ] Failing test: `compareShadowRun(legacyOutcome, rewrittenOutcome)` returns `{ equal, diff }` via the
  comparator + flags any side-effect divergence, and renders a report line. Feed it two fixture outcomes
  (one equal pair, one divergent pair). See fail.
- [ ] Minimal impl — reuse `runOutcomeEquivalent`; add the report renderer:
  ```ts
  // test/characterization/shadow-comparison.ts
  // Compares a legacy RunOutcome to a rewritten RunOutcome from the SAME sha (the Slice F shadow proof).
  // Reuses runOutcomeEquivalent (§10). Emits a report proving equivalence in production. shadow:true means
  // NO side effects fired by either engine — the comparison is on the persisted RunOutcome only.
  export function compareShadowRun(legacy, rewritten): { equal: boolean; diff?: string; report: string } { /* … */ }
  ```
- [ ] Run → pass. Typecheck → 0. Commit:
  ```bash
  git add qa-engine/test/characterization/shadow-comparison.ts qa-engine/test/characterization/shadow-comparison.test.ts
  git commit -m "test(characterization): shadow-comparison harness (legacy vs rewritten RunOutcome, same sha)"
  ```

## Task F.2 — The operator-invoked shadow run command + the documented procedure

> The actual fire-test. shadow:true + `PIPELINE_ENGINE=rewritten`, both engines run SEQUENTIALLY in the same
> queue slot (preserving the one-run-vs-DEV invariant), the rewritten run begins with a clean working-copy
> `prepare()` and a pre-run history snapshot (§7.3 Step 3 isolation), and `compareShadowRun` proves
> equivalence. This is operator infra (docker DEV + key) — structure it as a documented command, NOT a CI
> test.

**Files:** `qa-engine/test/characterization/shadow-run.operator.ts` (an operator script, NOT a `*.test.ts`),
`docs/superpowers/plans/2026-06-24-qa-engine-plan-6-orchestrator.md` (the procedure block below is the doc)

- [ ] Confirm a Spring-microservice app is configured in `shadow:true` (petclinic or jhipster-store):
  ```bash
  rg -n "shadow:|versionUrl|services:" config/apps/petclinic.yaml config/apps/jhipster-store.yaml
  ```
  Expected: `shadow: true`; a `versionUrl` (or none → gate skipped); `services[]` for the microservice
  topology. Pick the app whose DEV is bootable via `docker compose up`.
- [ ] Write the operator script (drives BOTH engines on the same SHA via the composition root; NOT a CI
  test — it imports real infra and needs the key):
  ```ts
  // qa-engine/test/characterization/shadow-run.operator.ts  (operator-invoked; NOT in the test glob)
  // Runs the COMPLETE rewritten engine (PIPELINE_ENGINE=rewritten) against a live Spring-microservice DEV
  // in shadow mode, then the legacy engine on the SAME sha, and prints compareShadowRun's report. Requires:
  //   docker compose up (DEV serving), OPENCODE_API_KEY, an app with qa.shadow:true. NO PR/Issue side effects.
  // Sequence (preserves one-run-vs-DEV): legacy run (clean prepare) → rewritten run (clean prepare + pre-run
  // history snapshot) → compareShadowRun(legacy, rewritten) → exit non-zero on undeclared divergence.
  ```
- [ ] Document the operator procedure (this block is the deliverable — the run itself is manual):
  ```bash
  # SHADOW RUN — operator procedure (NOT CI; needs docker DEV + OPENCODE_API_KEY)
  # 1. Boot the microservice DEV:
  doppler run -- docker compose up --build        # or: cp .env.example .env (fill OPENCODE_API_KEY) && docker compose up --build
  # 2. Pick a SHA on the target app and run BOTH engines in shadow:
  SHA=$(git ls-remote https://github.com/<org>/<spring-app> main | cut -f1)
  PIPELINE_ENGINE=rewritten node --import ./test-setup.mjs --import tsx \
    qa-engine/test/characterization/shadow-run.operator.ts --app <petclinic|jhipster-store> --sha "$SHA"
  # 3. Read the printed compareShadowRun report. Equivalence proven ⇒ the rewritten engine ran a full real
  #    QA run (agent + Playwright + live DEV) and matched legacy. shadow:true ⇒ zero PR/Issue side effects.
  ```
- [ ] CI-gate the BUILD (the operator script must typecheck), but DO NOT add it to the test glob (it needs
  infra):
  ```bash
  npx tsc --noEmit -p qa-engine/tsconfig.json     # the operator script is excluded from the test run, included in typecheck-or-exclude per its src/ imports
  ```
  Expected: typecheck passes (or the script is in the `exclude` list if it imports `src/` — like the parity
  tests). It is NEVER part of `npm test`.
- [ ] Commit:
  ```bash
  git add qa-engine/test/characterization/shadow-run.operator.ts
  git commit -m "test(characterization): operator-invoked shadow run — rewritten engine vs legacy on live microservice DEV"
  ```

## Task F.3 — Record the shadow-run evidence (the cutover precondition)

> The Slice F output is the evidence Plan 7's cutover is gated on. Capture the comparison report so the
> decision to flip the default to `rewritten` (Plan 7) is justified by real-execution proof, not inference.

- [ ] After an operator runs F.2 against the live DEV, record the `compareShadowRun` report (equivalence
  result, any divergences + allowlist dispositions, the SHA, the app) in the project's artifact store (engram
  topic `sdd/qa-engine-plan-6/shadow-evidence` or a committed `docs/` note — match the project convention).
  This is a MANUAL step performed when DEV infra is available; the plan provides the command (F.2), the
  operator provides the run.
- [ ] **Plan 6 ends here.** The cutover (flip default to `rewritten`, rename to `panchito`, delete the legacy
  adapter + `src/pipeline.ts`), and the Seam-3 `killTree` decoupling (after the user's `dom-snapshot.ts` WIP
  lands), are **Plan 7**, justified by this evidence.

---

# Definition of done (Plan 6)

- **GATE A green:** `golden-parity.test.ts` proves `LegacyPipelineAdapter.run(scenario) ≡ golden` for all 10
  + side-effect assertions; `parity-allowlist.json` exists (`[]` or declared entries with approvers).
- **186-harness green:** all 182 `pipeline.test.ts` + 4 `pipeline-codex.test.ts` scenarios replay through the
  adapter AND cross-validate `legacy ≡ rewritten` (Codex blind spot closed; comparator silent-mismatch holes
  for `preExec*`/`usage`/`rulesRetrieved` explicitly closed).
- **`ReviewPort` widened** with `parsed` + `blockingCount` BEFORE the FixLoop.
- **The domain is built and pinned:** `Run` aggregate (per-run reviewer-outage, R2 fixed), `RunDecisionService`
  (≥6 verdict branches consolidated by PORTING, each path pinned to a golden), `CycleBudget`/`WallClockBudget`/
  `RunDecision` VOs, the NEW `FixLoop` (ported verbatim, characterized against `fail-issue`/`invalid-issue`
  retry counts), `RunQaUseCase` (ports-only).
- **The 11 bridge adapters exist** (Task E.0) — one per `qa-run-orchestration` port, each delegating to its
  sibling-context entry point; `DeployGatePortAdapter` (HTTP + Null) and `RunHistoryPortAdapter` are REAL
  minimal impls (no sibling adapter existed). `rg implements (…11 ports…)` over `infrastructure/bridges/`
  returns 11. The keystone passes through `ObjectiveSignalPortAdapter` UNCHANGED (`unknown` never blocks).
- **The composition root wires ALL 11 ports to those REAL bridge adapters** (the COMPLETE rewritten engine)
  behind `PIPELINE_ENGINE` (default `legacy`); the single runner/CLI dispatch seam is in place with the legacy
  path byte-identical when the flag is absent.
- **The shadow run is buildable and CI-gated** — buildable BECAUSE Task E.0's 11 real bridge adapters exist —
  with a documented operator command to run the COMPLETE new engine against a live Spring-microservice DEV
  (`shadow:true`) and compare its `RunOutcome` to legacy. The CI-gated build/comparison logic is the Plan 6
  deliverable; the actual run is operator-invoked (needs docker DEV + `OPENCODE_API_KEY`).
- **Gates green throughout:** `npx tsc --noEmit -p qa-engine/tsconfig.json`, the qa-engine test glob, and —
  after the single `src/` touch (E.3) — `npm test` + `npm run typecheck`. Stryker on `decideCoverage`/
  `blocksPublish` stays green (the keystone is untouched).
- **Invariants intact:** `src/qa/dom-snapshot.ts` and `src/qa/validate.ts` UNCHANGED (Seam-3 deferred to Plan
  7); only `src/server/runner.ts` + `src/cli.ts` touched (dispatch only); no AI-attribution trailer on any
  commit; every commit staged with explicit `qa-engine/` paths (plus the two `src/` dispatch files in E.3).
