# qa-engine Plan 7 — Cutover Implementation Plan (Roadmap + Sub-Plans)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each sub-plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the legacy `src/` QA pipeline and make the `qa-engine/` hexagonal rewrite the sole, live engine — safely, gated on real shadow-run equivalence evidence.

**Architecture:** Plans 1–6 built the rewritten engine coexisting with legacy `src/` behind a `PIPELINE_ENGINE` flag (default `legacy`). Plan 7 makes the rewritten engine SELF-SUFFICIENT (no `src/` dependency), PROVES it equivalent against live DEV, then FLIPS the default and DELETES `src/`. Non-destructive self-sufficiency work sequences first; the destructive flip+delete is last and gated.

**Tech Stack:** TypeScript (strict, `tsx`), `node:test`, Playwright, hexagonal/DDD, dependency-cruiser arch-lint, Stryker.

---

## Why this is a ROADMAP of sub-plans (not one monolithic plan)

Plan 7 spans **six independent subsystems**, each producing working, testable software on its own. Per the writing-plans scope check ("break multi-subsystem specs into separate plans") and the migration's own methodology (Plans 1–6 were authored and executed **one at a time**), each sub-plan below is authored in full bite-sized TDD detail **at the moment it becomes the next executable slice** — not all upfront, because 7.3/7.4's exact steps depend on 7.2's extracted surfaces, and 7.6 is gated on 7.5's live evidence which does not yet exist.

**This document is the decomposition + sequencing + gates.** Sub-plan 7.1 is detailed to bite-sized steps below as the ready-to-execute starting slice; 7.2–7.6 give concrete scope, files (grounded in the current tree), acceptance gates, and dependencies — each to be expanded to full TDD steps as it comes up.

## Dependency graph & destructive gate

```
7.1 cancellation ─┐
7.2 leaf adapters ─┼─► 7.3 sever src/ imports ─► 7.4 grounding migration ─► 7.5 SHADOW PROOF (evidence) ═╗
                   │                                                                                       ║ (gate)
7.1, 7.2 independent┘                                                        DESTRUCTIVE, user-confirmed ◄═╝
                                                                            7.6 flip default + delete src/
```

- **7.1–7.4 are NON-DESTRUCTIVE** (add/port/refactor inside qa-engine; `src/` untouched, default stays `legacy`). They can proceed autonomously with per-slice review.
- **7.5 is the GATE**: an operator runs `shadow-run.operator.ts` against live DEV (docker + `OPENCODE_API_KEY`) and records equivalence evidence. Cannot be automated.
- **7.6 is DESTRUCTIVE and REQUIRES: (a) 7.5 evidence green, (b) explicit user confirmation.** Never run 7.6 without both.

**Invariants carried from the whole migration (every sub-plan must preserve):** the objective-signal keystone (`unknown` NEVER blocks publish); fail-closed review (`parsed:false` never approved); the security boundary (agent read-only on watched repos; only the orchestrator does git writes — dependency-cruiser `no-vcs-write-in-agent-contexts`); `npm run typecheck`=0 and the full suite green after every slice; project-agnostic (no app-specific branches in `src/` or qa-engine).

---

## Sub-Plan 7.1 — Widen `RunPipelinePort.run` with `AbortSignal` (cancellation)

**Why:** Plan 6 E.3 documented that the rewritten path drops the queue's `AbortSignal` (engram obs #913): a cancelled rewritten run keeps executing headless and its late resolution overwrites the finalized record. Dormant today (no production caller), but a hard blocker before the default flips (7.6). Small, self-contained, non-destructive — the ideal first slice.

**Files:**
- Modify: `qa-engine/src/contexts/qa-run-orchestration/application/ports/index.ts` (`RunInput`/`RunPipelinePort.run` signature)
- Modify: `qa-engine/src/contexts/qa-run-orchestration/application/run-qa.use-case.ts` (thread signal into execute/generate phases)
- Modify: `qa-engine/src/contexts/qa-run-orchestration/infrastructure/rewritten-orchestrator.adapter.ts` (forward signal)
- Modify: `qa-engine/src/contexts/qa-run-orchestration/infrastructure/legacy-pipeline.adapter.ts` (accept + forward signal to `runPipeline`'s existing signal arg)
- Modify: `src/server/runner.ts` (`runViaRewrittenEngine` — thread `signal`; remove the "dormant gap" comment once real)
- Test: `qa-engine/test/contexts/qa-run-orchestration/application/run-qa.use-case.test.ts`, `src/server/runner.test.ts`

- [ ] **Step 1: Failing test — signal propagation.** In `run-qa.use-case.test.ts`, add a test: given an `AbortSignal` already aborted, `RunQaUseCase.run(input, signal)` short-circuits before calling `execution.run` (assert the execution port stub is never invoked).

```ts
test("run() honors an already-aborted signal — no execution, no publish", async () => {
  const controller = new AbortController();
  controller.abort();
  let executed = false;
  const deps = makeFakeDeps({ execution: { run: async () => { executed = true; return { verdict: "pass", cases: [], logs: "" }; } } });
  const uc = new RunQaUseCase(deps);
  const result = await uc.run(baseInput, controller.signal);
  assert.equal(executed, false);
  assert.equal(result.decision.verdict, "infra-error"); // or the agreed "aborted" mapping — see Step 3
});
```

- [ ] **Step 2: Run — verify it fails.** `node --import ./test-setup.mjs --import tsx --test qa-engine/test/contexts/qa-run-orchestration/application/run-qa.use-case.test.ts` → FAIL (`run` takes no second arg / signal ignored).
- [ ] **Step 3: Widen the port + thread the signal.** Add `signal?: AbortSignal` to `RunPipelinePort.run(input, signal?)` (NOT to `RunInput` — keep it a separate transport arg, mirroring `runPipeline`'s own trailing signal). In `RunQaUseCase.run`, accept `signal?` and (a) check `signal?.aborted` at each phase boundary (gate/generate/execute/fixloop), returning a clean aborted terminal outcome, (b) pass `signal` into `execution.run`/`generation.generate` where those ports accept it. Widen those port methods' signatures if needed (they wrap `runE2E`/`runPipeline` which already take a signal).
- [ ] **Step 4: Forward through both adapters.** `RewrittenOrchestratorAdapter.run(input, signal?)` → `useCase.run(input, signal)`. `LegacyPipelineAdapter.run(input, signal?)` → forward to the wrapped `runPipeline`'s signal parameter.
- [ ] **Step 5: Thread at the runner seam.** In `src/server/runner.ts`, change `runViaRewrittenEngine(port, req, runId, signal)` and call `port.run(input, signal)`; remove the DORMANT-gap comment block (the gap is now closed). Keep the legacy branch byte-identical.
- [ ] **Step 6: Failing test — runner cancels the rewritten path.** In `src/server/runner.test.ts`, add: with `PIPELINE_ENGINE=rewritten` + a fake `engineFactory` whose `run` observes the signal, `cancelTrackedRun` aborts it and the record is NOT overwritten by a late resolution.
- [ ] **Step 7: Run both test files → PASS.**
- [ ] **Step 8: Full gate.** `npm run typecheck` (exit 0) + `npm test` (0 fail).
- [ ] **Step 9: Fresh adversarial review** of the port-signature + runner diff (PR rule — hot path), then **Commit** `qa-engine/.../ports/index.ts`, `run-qa.use-case.ts`, both adapters, `src/server/runner.ts` + tests: `git commit -m "feat(qa-engine): thread AbortSignal through RunPipelinePort — close the rewritten cancellation gap (Plan 7.1)"`

**Acceptance gate:** cancellation propagates to the rewritten engine; a cancelled rewritten run never overwrites a finalized record; legacy path unchanged; typecheck 0, suite green.

---

## Sub-Plan 7.2 — Extract the `src/`-independent leaf-IO adapters (F.2 gaps)

**Why:** `shadow-run.operator.ts` (Plan 6 F.2) proved the rewritten engine can only be assembled today by borrowing real `src/` functions. Before `src/` can be deleted, qa-engine must ship concrete, `src/`-free implementations of the five leaf collaborators F.2 bridged. Non-destructive (adds adapters).

**Scope (each is its own concrete adapter + TDD test, one commit each):**
1. **`SandboxedBinaryRunnerAdapter`** — concrete impl of `qa-engine/src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts`'s `SandboxedBinaryRunner` (`run(SandboxedRunRequest): Promise<SandboxedRunResult>`) over `node:child_process`, wiring the declared `ProcessKillPort` for process-tree kill on timeout/abort (this is the **Seam-3 `killTree` decoupling**). Replaces F.2's inline `makeSpawnRunner`.
2. **Coverage collector** matching `CoverageCollectorPort` (`collect(specDir, namespace): Promise<CoverageReport>` = `{ covered: {file, lines}[] }`). Port the V8/lcov/istanbul/jacoco dump-reading logic currently private in `src/qa/change-coverage.ts` into `qa-engine/src/contexts/objective-signal/infrastructure/` so `V8BrowserCoverageAdapter`/`CoverageCollectorAdapter` become constructible without `defaultCollectCoverage`.
3. **`ManifestRepositoryAdapter` real fns** — `readManifest`/`reconcileManifest` as first-class qa-engine functions (port `upsertManifest`+`realManifestFs` from `src/integrations/opencode-client.ts`).
4. **`PromptBudgetPort.capDiff`** — a diff-aware capper distinct from `capText` (or a documented, tested decision that one capper serves both), ported from `src/orchestrator/sanitizer.ts`.
5. **AgentRuntime callback shapes** — reconcile the kernel `UsageSnapshot`/`AgentTurnEvent` vs `src/qa/usage.ts` shapes so `onUsage`/`onTurn` thread through `AgentRuntimeAdapter` without the F.2 drop (align the kernel type or add a boundary mapper).

**Files:** new adapters under `qa-engine/src/contexts/*/infrastructure/` + `shared-infrastructure/process-sandbox/`; tests colocated under `qa-engine/test/`.

**Acceptance gate:** each adapter has a passing behavioral test; `shadow-run.operator.ts` can be rewritten to use these qa-engine adapters INSTEAD of its inline `src/` bridges (proving self-sufficiency for these five); typecheck 0, suite green. Update `shadow-run.operator.ts` to drop the corresponding `GAP:` bridges.

---

## Sub-Plan 7.3 — Sever qa-engine's production imports of `src/`

**Why:** Two production import edges make `src/` deletion break qa-engine (grep-confirmed 2026-07-02):
- `qa-engine/src/shared-kernel/contract/index.ts` → `src/contract/events.ts` + `src/contract/commands.ts`
- `qa-engine/src/contexts/change-analysis/infrastructure/extractors/default-extractors.ts` → `src/qa/static-signal/{symbols,relations,complexity,semantic-diff,patterns}.ts`

**Scope:**
1. Move `src/contract/{events,commands}.ts` INTO the kernel (`qa-engine/src/shared-kernel/contract/`) as the source of truth; make legacy `src/` re-export from the kernel during coexistence (so `src/` still compiles until 7.6 deletes it).
2. Port the five `static-signal` extractors (`symbols/relations/complexity/semantic-diff/patterns`) into `qa-engine/src/contexts/change-analysis/infrastructure/extractors/` (they are the declared, deliberate Java+JS/TS scope — keep that scope in the language registry, not app branches). Remove `default-extractors.ts` from the tsconfig `exclude` list once it no longer imports `src/`.

**Files:** `qa-engine/src/shared-kernel/contract/`, `qa-engine/src/contexts/change-analysis/infrastructure/extractors/`, `qa-engine/tsconfig.json` (drop excludes), the legacy `src/contract/*` (convert to re-export).

**Acceptance gate:** `rg "from ['\"](\.\./)+src/" qa-engine/src` returns ZERO production edges; typecheck 0 (root + qa-engine + parity); suite green.

**Depends on:** 7.2 (some extractors may share the sandbox runner / leaf primitives).

---

## Sub-Plan 7.4 — Migrate the grounding suite (Pillars 1/2/3) into qa-engine

**Why:** The anti-hallucination grounding (the migration's whole value story) lives in `src/qa/` and is NOT in qa-engine: `route-catalog`, `catalog-gate`, `changed-elements`, `context-pack`, `dom-snapshot` (+ `testid-grounding`). qa-engine has only `selector-check` (2 files). The rewritten engine must carry this forward or it regresses test-generation quality.

**Scope:** Port each Pillar module into the appropriate qa-engine context (grounding is generation/test-execution-time context assembly → `contexts/generation/` and/or `contexts/test-execution/`), with its tests, preserving behavior (parity-pinned). Wire them into the generation/execution ports so the rewritten engine grounds selectors exactly as legacy does. Reconcile with any grounding already ported (`selector-check`).

**Files:** new modules under `qa-engine/src/contexts/generation/` + `contexts/test-execution/`; tests colocated; parity tests vs the `src/qa/` originals (like the existing `*-parity.test.ts` pattern) added to `tsconfig.parity.json`.

**Acceptance gate:** every Pillar module has a qa-engine home + parity test proving behavioral equivalence to its `src/qa/` original; typecheck 0; suite green. This is the largest sub-plan — likely its own chained sequence of per-module slices.

**Depends on:** 7.3 (grounding may consume static-signal / contract now in the kernel). Cross-check the live memory note [[e2e-remediation-state]] and [[audit-2026-07-flaky-selector-leaks]] before porting — port the CURRENT `src/` behavior, not the pre-fix behavior.

---

## Sub-Plan 7.5 — Run the shadow proof + record cutover evidence (MANUAL GATE)

**Why:** The single objective justification for the destructive cutover. The rewritten engine must produce a behaviorally-equivalent `RunOutcome` to legacy on real SHAs against live DEV.

**Scope (operator-invoked — needs docker DEV + `OPENCODE_API_KEY`, NOT CI):**
- [ ] Bring up a Spring-microservice DEV (`petclinic` or `jhipster-store`, `qa.shadow: true`).
- [ ] Run `PIPELINE_ENGINE=rewritten node --import ./test-setup.mjs --import tsx qa-engine/test/characterization/shadow-run.operator.ts --app <app> --sha <sha>` on **several representative SHAs** (a generate case, a skip case, a fail case, a cross-repo case).
- [ ] For each: `compareShadowRun` must report EQUIVALENT (or a divergence with an explicit, recorded operator disposition).
- [ ] Record the reports as evidence in engram topic `sdd/qa-engine-plan-6/shadow-evidence` (and/or a committed `docs/` note).

**Acceptance gate (the cutover precondition):** documented equivalence across the representative SHA set, with every divergence explained. **7.6 MUST NOT begin until this evidence exists and the user has reviewed it.**

**Depends on:** 7.1–7.4 (so the shadow run exercises the SELF-SUFFICIENT rewritten engine, not the F.2 `src/`-borrowing bridges — otherwise the proof is about the hybrid, not the real target).

---

## Sub-Plan 7.6 — Cutover finale: flip default + delete legacy (DESTRUCTIVE — GATED)

> **DO NOT START without (a) 7.5 evidence green AND (b) explicit user confirmation.** This deletes the live system's current engine.

**Scope:**
1. Wire `buildProduction(process.env, appConfig)` at the real entrypoints: `src/index.ts` (`currentPipelineDeps` → supply the `engineFactory`) and `src/cli.ts`, mapping `AppConfig` → `CompositionConfig` via the now-`src/`-free qa-engine adapters (7.2).
2. Flip the `PIPELINE_ENGINE` default from `legacy` to `rewritten` in `selectEngine` (`pipeline-engine-flag.ts`) — the ONE behavior-changing line, justified by 7.5 evidence.
3. Soak: run production (or a staging window) on the rewritten default; watch for regressions.
4. Delete legacy: `src/pipeline.ts` + the legacy QA modules it owns, `LegacyPipelineAdapter` + its tests, and the now-dead `runPipeline` wiring. Remove the parity harness's dependency on `src/` (or retire the parity nets whose legacy side no longer exists).
5. Rename to `panchito` (the product name) per the original Plan 7 intent, if still desired.
6. Remove the tsconfig `exclude` entries that only existed to keep `src/`-importing files out of scope.

**Files:** `src/index.ts`, `src/cli.ts`, `qa-engine/.../pipeline-engine-flag.ts`, then deletion of `src/pipeline.ts` + legacy modules + `legacy-pipeline.adapter.ts` + parity harness reconciliation, `package.json` scripts (`qa`/`start` → qa-engine entrypoints).

**Acceptance gate:** production runs on the rewritten engine; `src/` legacy pipeline is gone; typecheck 0; suite green (minus retired legacy-parity nets); a full real run against DEV produces a correct `RunOutcome`. Migration complete.

**Depends on:** ALL of 7.1–7.5 + user confirmation.

---

## Self-Review (against the F.2-surfaced scope + the migration invariants)

- **Scope coverage:** all 7 prerequisites from the task map to a sub-plan — cancellation→7.1, leaf adapters→7.2, sever imports→7.3, grounding→7.4, shadow proof→7.5, flip+delete+killTree→7.6 (killTree lands in 7.2's SandboxedBinaryRunnerAdapter). ✓
- **Destructive isolation:** only 7.6 is destructive; it is double-gated (evidence + user confirm). 7.1–7.4 keep `src/` and the `legacy` default untouched. ✓
- **Grounded in real state:** import edges (2 files), `SandboxedBinaryRunner` shape, and the grounding file list are grep-verified 2026-07-02, not assumed. ✓
- **Placeholders:** 7.1 is bite-sized now; 7.2–7.6 are scoped roadmaps to be expanded to full TDD steps per-slice at execution time (the migration's established sequential pattern), NOT vague TODOs — each has concrete files + acceptance gates. This is the writing-plans scope-check decomposition, not a placeholder plan.
- **Invariants:** keystone/fail-closed/security-boundary/typecheck-green/project-agnostic restated as carry-through constraints. ✓

## Execution Handoff

This roadmap is saved to `docs/superpowers/plans/2026-07-02-qa-engine-plan-7-cutover.md`. Sub-plan 7.1 is ready to execute now (non-destructive). Recommended: execute 7.1 → 7.4 as a chained sequence (subagent-driven, per-slice adversarial review), pause at the 7.5 manual gate, and require explicit confirmation before 7.6.
