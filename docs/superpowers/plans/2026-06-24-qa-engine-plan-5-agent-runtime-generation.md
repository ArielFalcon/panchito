# QA Engine — Plan 5: Agent-Runtime + Generation (the non-deterministic core, wrapped)

> **Sub-skill:** `superpowers:writing-plans` → executed via `superpowers:executing-plans`.
> Each task is TDD: write a failing test → run it (see it fail) → minimal impl → run it (see it pass) → commit.
> Conventional commits, **NO `Co-Authored-By` / NO AI-attribution trailer**. One logical change per commit.
> **Commit discipline (every task):** stage **explicit `qa-engine/` paths only**. NEVER `git add -A`,
> NEVER stage anything under `src/` except the single Phase-B `prompts.ts` re-root (Task B.4, one line,
> types-only). The user has uncommitted WIP under `src/qa/*`, `agents/`, and `agent*/` — protect it.

## Goal

Build the last two bounded contexts in `qa-engine/src/contexts/` by **wrapping** the already-correct,
provider-abstracted `src/agent-runtime/` and `src/integrations/` runtime (strangler pattern), not
rewriting it:

1. **agent-runtime** — provider-agnostic session management. `OpenCodeRuntimeStrategy` /
   `CodexRuntimeStrategy` adapters wrapping `src/agent-runtime/`; `SingleAgentFacade`/`DualAgentFacade`
   behind an `AgentFacadePort` (the single-vs-dual `getStatus`/`startEventStream`/`deps` orchestration —
   Task A.9b), each resolving roles via the `RoleAssignmentResolver`;
   `configFromEnv`/`validateAgentRuntimeConfig`/`publicAgentConfig`
   behind a `ConfigPort`; the SSE/turn bridge behind `TurnTelemetrySink`; the stall watchdog behind
   `StallWatchdogPort`. **ONE PORT exception:** `codexErrorToInfra` (a pure error classifier — verbatim
   copy + contract-parity). ALL else is WRAP (delegate to the live `src/`).
2. **generation** — non-deterministic authoring behind a deterministic shell. `context-assembler`
   and `exploration-brief` (pure) WRAP; the 14 stable `prompts.ts` builders behind `PromptRenderingPort`;
   the `opencode-client` session lifecycle behind `AgentRuntimePort`; manifest plumbing behind
   `ManifestRepositoryPort`; `parsePlan`/`parseVerdict`/`parseReviewerVerdict` behind `VerdictParserPort`
   (+`PlanParserPort`). `roleWindowBytes`/`PromptBudgetPort` wrapping. The Seam-2 type-cycle break
   (`generation-ports.ts`). The `GenerateTestsUseCase` characterization-test extraction.

**Non-negotiable invariants this plan preserves:**
- **WRAP-then-replace.** Adapters **delegate** to the verified `src/` functions. Parity/delegation tests
  validate **delegation fidelity** (the adapter forwards correctly and maps shapes faithfully), NEVER
  legacy correctness. We do NOT rewrite the OpenCode/Codex SDK plumbing, the SSE bridge, or the prompt
  strings. Only the listed pure functions (`codexErrorToInfra`) are PORT (copy+parity).
- **Provider-agnostic runtime.** `AgentProvider = "opencode" | "codex"`, `AgentMode = "single" | "dual"`,
  `role → provider+model` (`RoleAssignment`) must survive end to end. No adapter collapses the dual-runtime
  independence (a Codex outage must never trip the OpenCode breaker; two different models guarantee
  independent judgment).
- **Security boundary.** The agent stays **READ-ONLY** on watched repos. The generation context NEVER
  gains write access. `VcsWritePort` stays only in `workspace-and-publication` (Plan 4); nothing in this
  plan imports it, re-exports it, or grants a generation/agent-runtime module any write capability.
- **The keystone is untouched.** `unknown` coverage NEVER blocks; the deterministic signal lives OUTSIDE
  the agent. Plan 5 adds no LLM proxy and no quality gate — it only relocates the existing generation
  surface behind ports.

## Architecture

```
qa-engine/src/shared-kernel/ports/
  agent-runtime.port.ts ← AgentRuntimePort + AgentSession + OpenSessionOpts + AgentTurnEvent +
                          AgentOpenDescriptor (kernel-resident — §5.2; generation consumes it FROM here)
qa-engine/src/contexts/
  agent-runtime/
    domain/            ← codexErrorToInfra (pure classifier — copy+parity)
    infrastructure/    ← OpenCode/Codex strategy adapters, AgentFacadeAdapter (SingleAgentFacade/
                          DualAgentFacade behind AgentFacadePort), RoleAssignmentResolver,
                          ConfigAdapter, TurnTelemetry/SSE bridge, StallWatchdog adapter
                          (all WRAP src/agent-runtime/*)
  generation/
    application/ports/ ← generation-ports.ts (Seam-2 canonical input types) + port-shape extensions
    application/       ← GenerateTestsUseCase (PORT — characterization-extracted, Phase B)
    domain/            ← (pure prompt-policy lifted later; v1 ships the rendering seam)
    infrastructure/    ← PromptRenderingAdapter (14 builders), AgentRuntimeAdapter (session lifecycle),
                          ManifestRepositoryAdapter, VerdictParserAdapter, PlanParserAdapter,
                          PromptBudgetAdapter (roleWindowBytes) — all WRAP src/integrations/*
```

**Dependency rule.** Adapters depend inward on the ports (extended here) and on the kernel (`@kernel/*`).
Parity/delegation tests that import the legacy `src/` original as the oracle are **excluded from the
qa-engine typecheck** (the established pattern — they run via `tsx` at runtime). The legacy originals are
deleted at Plan 7 cutover, not here.

## The Phase A / Phase B boundary (READ THIS BEFORE STARTING)

This plan is split into **two phases with a HARD gate between them.** The split exists because the user is
editing `src/` in parallel and the model-window catalog is mid-change.

- **PHASE A** — qa-engine-only, **executable NOW**. Touches ZERO `src/` files. Its gate is the
  **qa-engine isolated typecheck + the qa-engine test glob** — deliberately NOT the root `npm test`,
  because the user currently has 2 RED `src/` tests (a verified FALSE-RED from the incomplete catalog,
  not a regression). Phase A is immune to those. Phase A covers: Task 0 (re-verify), the port-stub edits
  (Tasks A.1–A.4), the `agent-runtime` adapters (Tasks A.5–A.9, all WRAP + `codexErrorToInfra` PORT),
  the **stable** generation wrappers (Tasks A.10–A.15), and the **qa-engine half of Seam-2** — the
  `generation-ports.ts` type extraction WITHOUT touching `prompts.ts:19` (Task A.16).

- **PHASE B** — **GATED behind the "catalog-green" checkpoint.** Entry condition: the user adds
  `deepseek-v4-pro` to `MODEL_WINDOW_TOKENS` in `src/integrations/model-window-catalog.ts` so the 2
  seam-d pinning tests go green and the root `npm test` is clean. Phase B covers: the
  `roleWindowBytes`/`PromptBudgetPort` wrapping (Task B.1), the `GenerateTestsUseCase`
  characterization-test extraction (Tasks B.2–B.3, needs a trustworthy full-suite gate), and the
  **single `src/` touch** — the `prompts.ts:19` Seam-2 re-root (Task B.4, types-only, needs a green
  global gate to prove cleanliness).

**The Phase B entry checkpoint is a LITERAL gate the executor runs (Task B.0).** Do NOT start any Phase B
task until Task B.0 passes. If it does not pass, STOP and report that Phase B is blocked on the user's
one-line catalog change — do not work around it.

### Why these three pieces are Phase B and not Phase A

- **`roleWindowBytes`/`PromptBudgetPort`:** `roleWindowBytes("qa-generator")` reads the real
  `agents/opencode.json`, which now references `opencode-go/deepseek-v4-pro`. Until that model is in the
  catalog, the function falls to `DEFAULT_WINDOW_TOKENS` (32k tokens → `floor(32000 × 0.75 × 4)` = **96 000
  bytes**) instead of the intended window (64k tokens → **192 000 bytes**). A delegation test written now
  would either encode the wrong number or be flaky across the user's edit. We wrap it only once the
  catalog is green. **The adapter never hardcodes 192k/96k — it asserts delegation only** (see Hard rules).
- **`GenerateTestsUseCase` extraction:** a PORT (not a WRAP). It needs the **full-suite** golden gate to be
  trustworthy before extracting deterministic logic out of `opencode-client.ts`. The full suite is only
  clean once the catalog is green.
- **`prompts.ts:19` re-root:** the one `src/` touch. It must land on a **green global gate** to prove the
  cycle break introduced no breakage. A red baseline makes "did I break it?" unanswerable.

## Tech Stack

- TypeScript, `tsx` runtime (no build step), `node:test` + `node:assert/strict`, colocated under
  `qa-engine/test/` mirroring `qa-engine/src/`.
- `@kernel/*` → `qa-engine/src/shared-kernel/*`, `@contexts/*` → `qa-engine/src/contexts/*`. Import
  kernel/ports with explicit `.ts` extensions (`allowImportingTsExtensions`); import sibling context files
  by relative path with `.ts`.
- Phase A gate (per task): `npx tsc --noEmit -p qa-engine/tsconfig.json` + the relevant qa-engine test glob
  `node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/<ctx>/**/*.test.ts"`.
- Phase B gate (per task): the Phase A gate PLUS the root `npm test` (clean only after catalog-green).
- Adapters inject their wrapped fn (constructor seam) so adapter tests run **without** OpenCode/Codex, the
  HTTP transport, or the filesystem. Parity tests run the real `src/` pure functions (no network).

## File Structure

New files (all under `qa-engine/`), plus port-barrel edits and ONE `src/` line in Phase B:

```
PHASE A
  src/shared-kernel/ports/agent-runtime.port.ts                  (NEW — realizes §5.2: AgentRuntimePort + AgentSession + OpenSessionOpts + AgentTurnEvent + AgentOpenDescriptor kernel-resident)
  src/contexts/agent-runtime/application/ports/index.ts          (EDIT: re-export the kernel port + ConfigPort/RoleAssignmentResolver/strategy extensions)
  src/contexts/agent-runtime/domain/codex-error-to-infra.ts      (PORT — pure classifier)
  src/contexts/agent-runtime/infrastructure/role-assignment-resolver.ts
  src/contexts/agent-runtime/infrastructure/config.adapter.ts
  src/contexts/agent-runtime/infrastructure/opencode-runtime.strategy.ts
  src/contexts/agent-runtime/infrastructure/codex-runtime.strategy.ts
  src/contexts/agent-runtime/infrastructure/agent-facade.adapter.ts  (WRAP SingleAgentFacade/DualAgentFacade behind AgentFacadePort)
  src/contexts/agent-runtime/infrastructure/turn-telemetry.adapter.ts
  src/contexts/agent-runtime/infrastructure/stall-watchdog.adapter.ts
  src/contexts/generation/application/ports/index.ts             (EDIT: port-stub extensions, remove Seam-2 DEFERRED comment)
  src/contexts/generation/application/ports/generation-ports.ts  (NEW — Seam-2 canonical types; qa-engine half)
  src/contexts/generation/infrastructure/prompt-rendering.adapter.ts
  src/contexts/generation/infrastructure/agent-runtime.adapter.ts
  src/contexts/generation/infrastructure/manifest-repository.adapter.ts
  src/contexts/generation/infrastructure/verdict-parser.adapter.ts
  src/contexts/generation/infrastructure/plan-parser.adapter.ts
PHASE B
  src/contexts/generation/infrastructure/prompt-budget.adapter.ts
  src/contexts/generation/application/generate-tests.use-case.ts
  src/integrations/prompts.ts                                    (EDIT: line 19 import re-root ONLY)
```

Each `src/...` file has a `test/...` mirror. Parity/delegation tests that import the legacy `src/` original
are added to `qa-engine/tsconfig.json`'s `exclude` list.

---

# PHASE A — qa-engine-only (executable now; gate = qa-engine isolated typecheck + qa-engine test glob)

## Task 0 — Re-verify the brief against HEAD (the user edits `src/` in parallel)

> Run BEFORE writing any code. The brief was verified against HEAD on 2026-06-26, but the user has live WIP
> in `src/qa/*` (`dom-snapshot`, `context-pack`, `changed-elements`, `selector-check`), `agents/`, and the
> prompt mirrors. **None of those is in Plan 5's wrap set** — Plan 5 wraps `src/agent-runtime/*` and the
> STABLE `src/integrations/*` surface (`opencode-client`, `prompts`, `model-window-catalog`,
> `context-assembler`, `exploration-brief`, `verdict-parse`, `verdict-validate`). Confirm the exports the
> wraps depend on still exist, then confirm the catalog-green checkpoint state (drives the Phase split).

- [ ] Confirm the agent-runtime wrapped exports still match (grep, not line numbers):
  ```bash
  cd /Users/arielyumn/Desktop/TRABAJO/panchito
  rg -n "export (class|function) (OpenCodeRuntimeStrategy|CodexRuntimeStrategy|codexErrorToInfra)" src/agent-runtime/opencode-strategy.ts src/agent-runtime/codex-strategy.ts
  rg -n "export (class|function) (SingleAgentFacade|DualAgentFacade|configFromEnv|validateAgentRuntimeConfig|publicAgentConfig|capabilitiesForRole|assignmentForRole)" src/agent-runtime/facades.ts src/agent-runtime/config.ts src/agent-runtime/types.ts
  rg -n "export type (AgentProvider|AgentMode|AgentRole)" src/agent-runtime/types.ts
  ```
  Expected: `OpenCodeRuntimeStrategy`, `CodexRuntimeStrategy`, `codexErrorToInfra`, the two facades,
  `configFromEnv`/`validateAgentRuntimeConfig`/`publicAgentConfig`, `capabilitiesForRole`/`assignmentForRole`,
  and the three union types all present.
- [ ] Confirm the generation wrapped exports still match:
  ```bash
  rg -n "export (async )?function (runOpencode|reviewIndependently|maybeExplore|runOpencodeParallel|generateParallel|parsePlan|parsePlanResult)" src/integrations/opencode-client.ts
  rg -n "export interface (OpencodeRunInput|ReviewInput|ParallelWorkerInput|ReviewResult|AgentDeps|AgentSession|AgentOpenDescriptor)" src/integrations/opencode-client.ts
  rg -n "export function (buildWorkerPromptAssembled|buildReviewerPromptAssembled|buildExplorerPrompt|buildFollowupPrompt|buildPromptAssembled|buildPlanPromptAssembled|buildContextTask|reviewObjective|renderArchitectureContext|renderReviewSpecs|renderExecutionResult|specFileForFlow)" src/integrations/prompts.ts
  rg -n "export (function|interface) (parseVerdict|parseReviewerVerdict|checkGeneratorVerdict|extractJsonObjects|FinalVerdict)" src/integrations/verdict-parse.ts src/integrations/verdict-validate.ts
  rg -n "export function (assemble|section)|export (type|interface) AssembledPrompt" src/integrations/context-assembler.ts
  rg -n "export (function|const|type) (parseExplorationBrief|coerceExplorationBrief|renderExplorationBrief|ExplorationBrief)" src/integrations/exploration-brief.ts src/qa/exploration-brief.ts
  rg -n "export function (roleWindowBytes|modelWindowBytes|normalizeModelName)|export const (BYTES_PER_TOKEN|INPUT_PROMPT_SAFETY_MARGIN|DEFAULT_WINDOW_TOKENS)" src/integrations/model-window-catalog.ts
  ```
  Note the EXACT signatures — the skeletons below assume:
  `AgentSession.prompt(text, opts?: { textOnly?; round?; isRepair?; sectionSizes?: Record<string,number>|null })`;
  `AgentDeps.open(agent, cwd, opts?: { signal?; timeoutMs?; model?; onUsage?; onTurn?; descriptor?: AgentOpenDescriptor })`
  + `cleanupOrphans?(maxAgeMs)`; `ReviewResult` carries `blockingCount?: number` + `parsed?: boolean`;
  `roleWindowBytes(role: string, agentsConfigPath?: string): number`. If any drifted, adjust the skeleton
  before writing — the delegation test is the guard.
- [ ] Confirm the kernel-port relocation (Task A.0b) is still required and resolve its exact home — the design
  (§5.2) wants `AgentRuntimePort` kernel-resident, but Plans 1-4 left it in the agent-runtime context barrel:
  ```bash
  fd "agent-runtime.port.ts" qa-engine/src/shared-kernel/ports/ || echo "kernel port ABSENT → Task A.0b relocation required"
  rg -n "export interface AgentRuntimePort" qa-engine/src/contexts/agent-runtime/application/ports/index.ts
  rg -n "@kernel/ports/" qa-engine/src/contexts/*/application/ports/index.ts | head -3   # confirm the kernel-port path convention
  ```
  Expected: the kernel file is ABSENT (relocation needed); `AgentRuntimePort` is defined in the agent-runtime
  context barrel; other contexts already import kernel ports as `@kernel/ports/<name>.port.ts` (the pattern
  Task A.0b follows). If the kernel file is already PRESENT (a prior plan landed it), skip A.0b and point
  A.1/A.2's edits + A.14's import at the existing `@kernel/ports/agent-runtime.port.ts`.
- [ ] Confirm the `exploration-brief` exports live at `src/qa/exploration-brief.ts` (NOT `src/integrations/`)
  — Task A.15's wrapper + parity import depend on this exact path:
  ```bash
  fd "exploration-brief.ts" src/ | rg -v ".test.ts"
  rg -n "export (function|const|type|interface) (parseExplorationBrief|coerceExplorationBrief|renderExplorationBrief|ExplorationBrief)" src/qa/exploration-brief.ts
  ```
  Expected: the file is `src/qa/exploration-brief.ts`; the schema fns are present there. (There is NO
  `src/integrations/exploration-brief.ts` — the Task A.15 parity import must target `src/qa/`.)
- [ ] Confirm the reviewer bounded-repair fields exist on the legacy verdict (Tasks A.3/A.12/B.3 depend on them):
  ```bash
  rg -n "valid:|issues:|export interface ReviewerVerdict" src/integrations/verdict-validate.ts | head
  rg -n "!v.valid|repairInstruction\(\"reviewer\"|!genCheck.valid|repairInstruction\(\"generator\"" src/integrations/opencode-client.ts
  ```
  Expected: `ReviewerVerdict` carries REQUIRED `valid: boolean` + `issues: string[]`; `opencode-client.ts`
  fires `repairInstruction("reviewer", v.issues)` when `!v.valid` (and the generator-side equivalent). These
  are the bounded contract-repair signals `ReviewJudgment` (A.3) must carry through to the use-case (B.3).
- [ ] Confirm the facades are wrappable and read their actual surface (Task A.9b wraps these):
  ```bash
  rg -n "export class (SingleAgentFacade|DualAgentFacade)" src/agent-runtime/facades.ts
  rg -n "export interface AgentFacade" src/agent-runtime/types.ts
  sed -n '/export interface AgentFacade {/,/^}/p' src/agent-runtime/types.ts
  ```
  Expected: both facade classes present; `AgentFacade` surface is `config`/`deps()`/`getStatus()`/
  `listModels()`/`startEventStream?()` (it does NOT carry a `run(input)` — the single-vs-dual orchestration
  is in status/streaming/deps, which is exactly what Task A.9b's `AgentFacadePort` wraps).
- [ ] Confirm the Seam-2 cycle still has the exact shape the break depends on:
  ```bash
  rg -n "from \"./opencode-client\"|from \"./prompts\"" src/integrations/prompts.ts src/integrations/opencode-client.ts | rg "OpencodeRunInput|ParallelWorkerInput|ReviewInput|buildWorkerPromptAssembled"
  ```
  Expected: `prompts.ts:19` imports `OpencodeRunInput, ParallelWorkerInput, ReviewInput` from
  `./opencode-client` as `import type` (runtime-erased); `opencode-client.ts:51` re-imports the 14 prompt
  builders from `./prompts` as values. This is the type-only cycle Seam-2 breaks.
- [ ] Confirm `prompts.ts` / `opencode-client.ts` / `model-window-catalog.ts` are NOT in the user's WIP set
  (the Phase B src/ touch must not collide):
  ```bash
  git status --short | rg "prompts.ts|opencode-client.ts|model-window-catalog"
  ```
  Expected: **no output** (the user's WIP is in `src/qa/*` + `agent*/`, not these three files).
- [ ] Confirm no qa-engine WIP collision (none of Plan 5's new files already modified by the user):
  ```bash
  git status --short | rg "qa-engine/"
  ```
  Expected: no output (qa-engine is clean).
- [ ] **CONFIRM THE CATALOG-GREEN CHECKPOINT STATE** (this drives the Phase A/B split):
  ```bash
  rg -c "deepseek-v4-pro" src/integrations/model-window-catalog.ts || echo "CATALOG NOT GREEN"
  rg -n "opencode-go/deepseek-v4-pro" agents/opencode.json
  ```
  Expected at plan-authoring time: `deepseek-v4-pro` is **ABSENT** from `MODEL_WINDOW_TOKENS` (catalog NOT
  green) while `agents/opencode.json` already references it. **This is the Phase B gate.** Record the
  result. If it is now PRESENT (the user landed the change), Phase B is unblocked — but still run Task B.0
  to confirm a clean global gate before starting Phase B.
- [ ] Phase A baseline: the qa-engine isolated gate is green (the user's 2 RED `src/` tests do NOT affect it):
  ```bash
  npx tsc --noEmit -p qa-engine/tsconfig.json
  node --import ./test-setup.mjs --import tsx --test "qa-engine/test/**/*.test.ts" 2>&1 | tail -5
  ```
  Expected: typecheck passes; qa-engine test summary shows `0` failures. (Do NOT gate Phase A on root
  `npm test` — it carries the user's catalog false-red.)

---

## Task A.0b — Relocate `AgentRuntimePort` into the kernel (realize §5.2; un-break the A.14 import)

> **Do this BEFORE A.1/A.2/A.4 — they edit the relocated types in their new kernel home.** The design (§5.2)
> says **generation consumes `AgentRuntimePort` FROM the kernel**, decoupled from the agent-runtime context.
> Plans 1-4 did NOT realize this: `AgentRuntimePort` (and `AgentSession`/`OpenSessionOpts`/`AgentTurnEvent`)
> physically live in `qa-engine/src/contexts/agent-runtime/application/ports/index.ts` (verified at HEAD —
> the barrel comment *claims* "kernel-facing" but the type is context-resident). The kernel (`@kernel/*` →
> `src/shared-kernel/*`) holds only `clock.port.ts`, `deploy-gate.port.ts`, `redaction.port.ts`. So
> `Task A.14`'s `import … from "@kernel/agent-runtime-port.ts"` would fail `tsc` with "Cannot find module".
> Relocate the kernel-facing port into a real kernel file so BOTH contexts import it from one place — the
> established kernel-port pattern (other contexts already do `export type { DeployGatePort } from
> "@kernel/ports/deploy-gate.port.ts"`).

**Files:** `qa-engine/src/shared-kernel/ports/agent-runtime.port.ts` (NEW),
`qa-engine/src/contexts/agent-runtime/application/ports/index.ts` (re-export, no longer defines these),
`test/shared-kernel/ports/agent-runtime.port.test.ts`

- [ ] Confirm the port is NOT already kernel-resident (drives this task's necessity):
  ```bash
  cd /Users/arielyumn/Desktop/TRABAJO/panchito
  fd "agent-runtime.port.ts" qa-engine/src/shared-kernel/ports/ || echo "ABSENT — kernel relocation required"
  rg -n "export interface AgentRuntimePort" qa-engine/src/contexts/agent-runtime/application/ports/index.ts
  ```
  Expected: the kernel file is ABSENT; `AgentRuntimePort` is defined in the agent-runtime context barrel.
- [ ] Create the kernel port file holding the kernel-facing session types (the names match the current barrel
  so A.1/A.2 extend them in place; the barrel becomes a re-export):
  ```ts
  // qa-engine/src/shared-kernel/ports/agent-runtime.port.ts
  // Kernel-resident session-management seam (design §5.2). Generation depends on AgentRuntimePort FROM the
  // kernel so it is decoupled from the agent-runtime context. The agent-runtime context barrel re-exports
  // these and extends them with provider-strategy concerns (AgentRuntimeStrategy, ConfigPort, …).
  import type { AgentRole, AgentProvider } from "@kernel/agent-role.ts";

  export interface UsageSnapshot { inputTokens: number; outputTokens: number; provider: AgentProvider; }
  // AgentOpenDescriptor / the widened prompt opts / AgentTurnEvent telemetry fields are ADDED by Tasks
  // A.1 + A.2 (they edit THIS file now, not the context barrel).
  export interface AgentTurnEvent { runId: string; role: AgentRole; objective?: string; }
  export interface AgentSession {
    prompt(text: string): Promise<{ output: string }>;
    dispose(): Promise<void> | void;
  }
  export interface OpenSessionOpts {
    signal?: AbortSignal;
    timeoutMs?: number;
    model?: string;
    onUsage?: (u: UsageSnapshot) => void;
    onTurn?: (t: AgentTurnEvent) => void;
  }
  export interface AgentRuntimePort {
    openSession(role: AgentRole, cwd: string, opts?: OpenSessionOpts): Promise<AgentSession>;
  }
  ```
- [ ] Convert the agent-runtime context barrel to RE-EXPORT the kernel port (delete the local definitions of
  `UsageSnapshot`/`AgentTurnEvent`/`AgentSession`/`OpenSessionOpts`/`AgentRuntimePort`; keep
  `AgentRuntimeStrategy`/`TransportPort`/`TurnTelemetrySink`/`StallWatchdogPort`/`RoleAssignmentResolver`/
  health+model read-models, now importing the moved types from the kernel):
  ```ts
  // qa-engine/src/contexts/agent-runtime/application/ports/index.ts (top)
  export type { UsageSnapshot, AgentTurnEvent, AgentSession, OpenSessionOpts, AgentRuntimePort }
    from "@kernel/ports/agent-runtime.port.ts";
  import type { AgentRuntimePort, AgentSession } from "@kernel/ports/agent-runtime.port.ts";
  import type { AgentProvider, AgentRole, RoleAssignment } from "@kernel/agent-role.ts";
  // AgentRuntimeStrategy extends the kernel AgentRuntimePort (unchanged below); the rest of the barrel stays.
  ```
- [ ] Add a kernel re-export test (the generation side imports the port from the kernel — guards the seam):
  ```ts
  // test/shared-kernel/ports/agent-runtime.port.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import type { AgentRuntimePort } from "@kernel/ports/agent-runtime.port.ts";
  test("AgentRuntimePort is importable from the kernel (generation depends on it FROM here, §5.2)", () => {
    const _typecheck: AgentRuntimePort | null = null; // compile-time guard; tsc is the real assertion
    assert.equal(_typecheck, null);
  });
  ```
- [ ] Typecheck IMMEDIATELY (the barrel's consumers must still resolve through the re-export):
  ```bash
  npx tsc --noEmit -p qa-engine/tsconfig.json
  ```
  Expected: exits 0.
- [ ] Commit:
  ```bash
  git add qa-engine/src/shared-kernel/ports/agent-runtime.port.ts \
          qa-engine/src/contexts/agent-runtime/application/ports/index.ts \
          qa-engine/test/shared-kernel/ports/agent-runtime.port.test.ts
  git commit -m "feat(kernel): relocate AgentRuntimePort into shared-kernel/ports (realize §5.2; barrel re-exports)"
  ```

## Task A.1 — Port-stub edit: `descriptor` on `OpenSessionOpts` (agent-runtime ports)

> **Port-stub edit FIRST, before the adapters that depend on it.** The Plan-2 `OpenSessionOpts` omits the
> session-scoped `descriptor` the legacy `AgentDeps.open` carries (`runId`/`role`/`objective`). Without it,
> the strategy adapters cannot wire `registerRunSession` SSE/telemetry — the run→session mapping is lost.
> Add the descriptor as a structural type (mirrors `AgentOpenDescriptor` in `opencode-client.ts` — declared
> locally so the port does not import from `src/`). **Edit the kernel port file** (`agent-runtime.port.ts`,
> created in Task A.0b) — `OpenSessionOpts` now lives there; the context barrel re-exports it.

**Files:** `qa-engine/src/shared-kernel/ports/agent-runtime.port.ts`

- [ ] Edit the kernel port file — add `AgentOpenDescriptor` and thread it onto `OpenSessionOpts`:
  ```ts
  // qa-engine/src/shared-kernel/ports/agent-runtime.port.ts (add near OpenSessionOpts)
  // Session-scoped identity descriptor, forwarded by every openSession call-site that has a run context.
  // Mirrors AgentOpenDescriptor in src/integrations/opencode-client.ts — declared locally so the port
  // never imports from src/. runId/objective are optional so inapplicable call-sites (maintainer) omit them.
  export interface AgentOpenDescriptor {
    runId?: string;
    role?: string;
    objective?: string;
  }

  export interface OpenSessionOpts {
    signal?: AbortSignal;
    timeoutMs?: number;
    model?: string;
    onUsage?: (u: UsageSnapshot) => void;
    onTurn?: (t: AgentTurnEvent) => void;
    // Threads the run→session mapping so the strategy adapter can wire SSE/telemetry registration.
    descriptor?: AgentOpenDescriptor;
  }
  ```
- [ ] Typecheck the port edit IMMEDIATELY (before any adapter code):
  ```bash
  npx tsc --noEmit -p qa-engine/tsconfig.json
  ```
  Expected: exits 0.
- [ ] Commit:
  ```bash
  git add qa-engine/src/shared-kernel/ports/agent-runtime.port.ts
  git commit -m "feat(agent-runtime): add AgentOpenDescriptor to OpenSessionOpts port"
  ```

## Task A.2 — Port-stub edit: widen `AgentSession.prompt` + add `TelemetryPort` carry (agent-runtime ports)

> The Plan-2 `AgentSession.prompt(text)` drops the per-call telemetry/contract-repair opts the legacy
> session carries: `round`, `isRepair`, `sectionSizes`, `textOnly`. Without them the funnel cannot
> distinguish generation rounds from in-session contract-repair re-prompts, and the per-section byte map
> (from the ContextAssembler) is lost. Widen `prompt` to carry the opts AND surface the per-turn telemetry
> via the existing `TurnTelemetrySink` (the brief's "or add a TelemetryPort" — we extend the EXISTING sink
> rather than add a parallel port, keeping the seam count down). **Edit the kernel port file** —
> `AgentSession` and `AgentTurnEvent` now live in `agent-runtime.port.ts` (Task A.0b); `TurnTelemetrySink`
> stays in the context barrel and consumes the kernel `AgentTurnEvent`.

**Files:** `qa-engine/src/shared-kernel/ports/agent-runtime.port.ts`

- [ ] Edit the kernel port file — widen `prompt` and enrich `AgentTurnEvent` so telemetry is not silently dropped:
  ```ts
  // AgentTurnEvent gains the per-turn telemetry fields the legacy funnel records (round/isRepair distinguish
  // generation rounds from contract-repair re-prompts; sectionSizes is the ContextAssembler byte map, null
  // for non-assembled prompts). The TurnTelemetrySink (already defined) records these — no new port needed.
  export interface AgentTurnEvent {
    runId: string | null;
    role: AgentRole;
    objective?: string;
    round: number;
    isRepair: boolean;
    sectionSizes: Record<string, number> | null;
  }

  export interface AgentSession {
    // Widened to carry the per-call telemetry/repair opts the legacy session exposes. The opts are
    // forwarded verbatim to the wrapped session so no capability is dropped at the port boundary.
    prompt(
      text: string,
      opts?: { textOnly?: boolean; round?: number; isRepair?: boolean; sectionSizes?: Record<string, number> | null },
    ): Promise<{ output: string }>;
    dispose(): Promise<void> | void;
  }
  ```
- [ ] Typecheck the port edit IMMEDIATELY:
  ```bash
  npx tsc --noEmit -p qa-engine/tsconfig.json
  ```
  Expected: exits 0. (If `AgentRole` import is missing in the kernel port file, it is already imported at the
  top — confirm; otherwise add `import type { AgentRole } from "@kernel/agent-role.ts";`.)
- [ ] Commit:
  ```bash
  git add qa-engine/src/shared-kernel/ports/agent-runtime.port.ts
  git commit -m "feat(agent-runtime): widen AgentSession.prompt + AgentTurnEvent for round/isRepair/sectionSizes telemetry"
  ```

## Task A.3 — Port-stub edit: `ReviewJudgment` carries `blockingCount` + `parsed` + `valid` + `issues` (generation ports)

> The Plan-2 `ReviewJudgment` is `{ approved, corrections, rationale? }` — it silently DROPS four legacy
> `ReviewerVerdict` fields the publish + repair logic depends on:
> - `blockingCount` (the blocking-vs-advisory gate: the caller approves when only advisory corrections remain),
> - `parsed` (the parse-miss round-saver: `approved:false` because NO verdict JSON could be parsed, distinct
>   from a real rejection),
> - **`valid` + `issues`** — the **bounded-repair signal**. `parseReviewerVerdict` returns REQUIRED
>   `valid: boolean` + `issues: string[]` (verified at `src/integrations/verdict-validate.ts:73-75`); the
>   reviewer loop at `opencode-client.ts:979-983` reads them: `if (!v.valid) { ...repairInstruction("reviewer", v.issues)... }`.
>   Without `valid`/`issues` on the port, `GenerateTestsUseCase` (Task B.3) **cannot fire the one bounded
>   contract-repair re-prompt** — a silent behavioral regression. (`valid:false` ≠ `approved:false`: `valid`
>   is "the reviewer JSON satisfied the schema", `approved` is "the reviewer passed the suite".)
>
> Dropping any of these is a behavioral regression. Extend the port to carry all four.

**Files:** `qa-engine/src/contexts/generation/application/ports/index.ts`

- [ ] Edit the generation port barrel — extend `ReviewJudgment`:
  ```ts
  // ReviewJudgment is the authoritative publish gate. blockingCount distinguishes blocking corrections
  // (must regenerate) from advisory ones (may approve); parsed is FALSE only on a parse miss (no verdict
  // JSON), NOT a real rejection — the caller uses it to re-prompt once instead of burning a fix round.
  // valid + issues are the BOUNDED-REPAIR signal: valid is FALSE when the reviewer JSON failed the typed
  // contract (schema miss, not a real rejection) and issues carries the schema problems — the use-case
  // (B.3) fires ONE repairInstruction("reviewer", issues) re-prompt before giving up (opencode-client.ts:979-983).
  // All four are carried from the legacy ReviewerVerdict so the wrap drops no behavior.
  export interface ReviewJudgment {
    approved: boolean;
    corrections: string[];
    rationale?: string;
    blockingCount?: number;
    parsed?: boolean;
    valid?: boolean;     // reviewer JSON satisfied the typed contract (FALSE ⇒ one bounded repair, not rejection)
    issues?: string[];   // schema problems, fed verbatim to repairInstruction("reviewer", issues)
  }
  ```
- [ ] Remove the `Seam-2 DEFERRED to Plan 5` comment from the generation port barrel header (it is resolved
  by Task A.16). Replace it with a one-line note that `generation-ports.ts` now holds the canonical Seam-2
  input types.
- [ ] Typecheck IMMEDIATELY:
  ```bash
  npx tsc --noEmit -p qa-engine/tsconfig.json
  ```
  Expected: exits 0.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/generation/application/ports/index.ts
  git commit -m "feat(generation): ReviewJudgment carries blockingCount + parsed + valid + issues (no behavior drop)"
  ```

## Task A.4 — Port-stub edit: `RoleAssignmentResolver` + `ConfigPort` shape (agent-runtime ports)

> The strategy adapters and the facade resolver depend on a config seam and the assignment resolver. The
> resolver is already declared in the Plan-2 stub (`RoleAssignmentResolver.resolve(role)`). Add the
> `ConfigPort` the `config.adapter.ts` (Task A.6) implements — wrapping `configFromEnv` /
> `validateAgentRuntimeConfig` / `publicAgentConfig`. Define it now so the adapter has a named port.

**Files:** `qa-engine/src/contexts/agent-runtime/application/ports/index.ts`

- [ ] Add the `ConfigPort` and its read-models to the agent-runtime port barrel:
  ```ts
  // Wraps configFromEnv / validateAgentRuntimeConfig / publicAgentConfig. publicAgentConfig is the
  // redacted view safe to expose over the API; validation reports per-provider key presence. The config
  // shapes are structural (no src/ import) — the adapter maps the legacy AgentRuntimeConfig onto them.
  export interface AgentRuntimeConfigView {
    mode: "single" | "dual";
    assignments: { role: string; provider: AgentProvider; model: string }[];
  }
  export interface AgentConfigValidationView {
    valid: boolean;
    errors: string[];
  }
  export interface ConfigPort {
    fromEnv(env?: Record<string, string | undefined>): AgentRuntimeConfigView;
    validate(cfg: AgentRuntimeConfigView, keys: Record<string, boolean>): AgentConfigValidationView;
    publicView(cfg: AgentRuntimeConfigView): AgentRuntimeConfigView; // redacted (no secrets)
  }
  ```
- [ ] Typecheck IMMEDIATELY:
  ```bash
  npx tsc --noEmit -p qa-engine/tsconfig.json
  ```
  Expected: exits 0.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/agent-runtime/application/ports/index.ts
  git commit -m "feat(agent-runtime): add ConfigPort over configFromEnv/validate/publicAgentConfig"
  ```

---

## Task A.5 — `codexErrorToInfra` (PORT — pure error classifier, copy+parity)

> The ONLY PORT exception in agent-runtime. `codexErrorToInfra` is a pure classifier: maps an unknown Codex
> `exec` error to an `AgentUnavailableError` (infra) or `null` (a real failure the run must surface). Carry
> it VERBATIM into the domain; pin it to the legacy original with a parity test across a sample table.

**Files:** `qa-engine/src/contexts/agent-runtime/domain/codex-error-to-infra.ts`,
`test/contexts/agent-runtime/domain/codex-error-to-infra.test.ts`,
`test/contexts/agent-runtime/domain/codex-error-to-infra-parity.test.ts`

- [ ] Re-read the legacy classifier body (it may be edited; copy the CURRENT HEAD shape):
  ```bash
  rg -n "export function codexErrorToInfra" src/agent-runtime/codex-strategy.ts
  sed -n '/export function codexErrorToInfra/,/^}/p' src/agent-runtime/codex-strategy.ts
  ```
- [ ] Write the failing unit test (module not found):
  ```ts
  // test/contexts/agent-runtime/domain/codex-error-to-infra.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { codexErrorToInfra } from "@contexts/agent-runtime/domain/codex-error-to-infra.ts";

  test("classifies a codex-not-found exec error as infra (AgentUnavailableError)", () => {
    const r = codexErrorToInfra(new Error("codex: command not found"));
    assert.ok(r, "a missing-binary error must be infra, not a code failure");
  });

  test("a genuine non-infra error returns null (the run must surface it)", () => {
    const r = codexErrorToInfra(new Error("the model produced no JSON verdict"));
    assert.equal(r, null);
  });
  ```
  > Adjust the EXACT match strings to the legacy body read above — the classifier's signatures are the
  > contract, not these placeholders.
- [ ] Run it, see it fail.
- [ ] Minimal impl — copy the classifier body VERBATIM from the current HEAD of `codex-strategy.ts`, with
  `AgentUnavailableError` imported from the kernel (it is a kernel VO in the `InfraError` taxonomy —
  `@kernel/domain-error.ts`). No behavioral change:
  ```ts
  // src/contexts/agent-runtime/domain/codex-error-to-infra.ts
  // PORT (pure classifier, copy+parity). Carried VERBATIM from src/agent-runtime/codex-strategy.ts
  // codexErrorToInfra. Maps an unknown Codex exec error to an AgentUnavailableError (infra — a Codex
  // outage, never a code bug) or null (a real failure the run must surface). Per-provider isolation:
  // a Codex outage classified here must never trip the OpenCode breaker (that lives in the strategy).
  import { AgentUnavailableError } from "@kernel/domain-error.ts";
  // <copy the codexErrorToInfra body verbatim from HEAD>
  ```
- [ ] Run it, see it pass.
- [ ] Write the parity test (pins the copy to legacy across a sample table):
  ```ts
  // test/contexts/agent-runtime/domain/codex-error-to-infra-parity.test.ts
  // PARITY: the lifted classifier must match codex-strategy.ts byte-for-byte until Plan 7 deletes the
  // legacy original. Imports from src/ — excluded from qa-engine typecheck; runs via tsx.
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { codexErrorToInfra } from "@contexts/agent-runtime/domain/codex-error-to-infra.ts";
  import { codexErrorToInfra as legacy } from "../../../../../src/agent-runtime/codex-strategy.ts";

  test("PARITY: classification matches legacy across a sample error table", () => {
    const samples: unknown[] = [
      new Error("codex: command not found"),
      new Error("ENOENT"),
      new Error("model produced no JSON"),
      "a string error",
      null,
      { code: "ETIMEDOUT" },
    ];
    for (const e of samples) {
      // Compare the CLASSIFICATION (infra vs not), not object identity — both construct fresh errors.
      assert.equal(Boolean(codexErrorToInfra(e)), Boolean(legacy(e)), JSON.stringify(String(e)));
    }
  });
  ```
- [ ] Add the parity file to the qa-engine typecheck exclude list:
  ```jsonc
  // qa-engine/tsconfig.json — append to "exclude"
  "test/contexts/agent-runtime/domain/codex-error-to-infra-parity.test.ts"
  ```
- [ ] Run both + the isolated gate:
  ```bash
  node --import ./test-setup.mjs --import tsx --test \
    "qa-engine/test/contexts/agent-runtime/domain/codex-error-to-infra.test.ts" \
    "qa-engine/test/contexts/agent-runtime/domain/codex-error-to-infra-parity.test.ts"
  npx tsc --noEmit -p qa-engine/tsconfig.json
  ```
  Expected: all pass; typecheck exits 0.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/agent-runtime/domain/codex-error-to-infra.ts \
          qa-engine/test/contexts/agent-runtime/domain/codex-error-to-infra.test.ts \
          qa-engine/test/contexts/agent-runtime/domain/codex-error-to-infra-parity.test.ts \
          qa-engine/tsconfig.json
  git commit -m "feat(agent-runtime): codexErrorToInfra ported from codex-strategy with parity oracle"
  ```

## Task A.6 — `ConfigAdapter` (WRAP `configFromEnv`/`validateAgentRuntimeConfig`/`publicAgentConfig`)

> Implements `ConfigPort` by **delegating** to the three injected config fns. Inject them so the adapter
> test needs no env. The adapter maps the legacy `AgentRuntimeConfig` ↔ the structural `AgentRuntimeConfigView`.

**Files:** `qa-engine/src/contexts/agent-runtime/infrastructure/config.adapter.ts`,
`test/contexts/agent-runtime/infrastructure/config.adapter.test.ts`

- [ ] Write the failing delegation test (inject fakes recording args — a gutted impl that ignores them FAILS):
  ```ts
  // test/contexts/agent-runtime/infrastructure/config.adapter.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { ConfigAdapter } from "@contexts/agent-runtime/infrastructure/config.adapter.ts";

  test("fromEnv delegates to the injected configFromEnv and maps the view", () => {
    let seenEnv: Record<string, string | undefined> | undefined;
    const adapter = new ConfigAdapter({
      configFromEnv: (env) => { seenEnv = env; return { mode: "dual", assignments: { primary: { provider: "opencode", model: "m1" } } } as never; },
      validateAgentRuntimeConfig: () => ({ valid: true, errors: [] }) as never,
      publicAgentConfig: (c) => c as never,
    });
    const view = adapter.fromEnv({ AGENT_MODE: "dual" });
    // DELEGATION assertion: the injected fn received the env (a gutted impl that returns a literal FAILS).
    assert.deepEqual(seenEnv, { AGENT_MODE: "dual" });
    assert.equal(view.mode, "dual");
  });

  test("validate delegates to the injected validator and surfaces errors", () => {
    let called = false;
    const adapter = new ConfigAdapter({
      configFromEnv: () => ({ mode: "single", assignments: {} }) as never,
      validateAgentRuntimeConfig: () => { called = true; return { valid: false, errors: ["missing key"] } as never; },
      publicAgentConfig: (c) => c as never,
    });
    const r = adapter.validate({ mode: "single", assignments: [] }, { OPENCODE_API_KEY: false });
    assert.equal(called, true);
    assert.equal(r.valid, false);
    assert.deepEqual(r.errors, ["missing key"]);
  });
  ```
  > **NEVER hardcode a model id, a provider name, or a budget number as an "expected" literal beyond the
  > fake's own input.** Assert that the injected fn was CALLED and its result was forwarded — delegation, not
  > legacy correctness.
- [ ] Run it, see it fail.
- [ ] Minimal impl (delegate; map the legacy config shape to the view at the boundary):
  ```ts
  // src/contexts/agent-runtime/infrastructure/config.adapter.ts
  // WRAP of src/agent-runtime/config.ts (configFromEnv / validateAgentRuntimeConfig / publicAgentConfig).
  // All three injected so the adapter test needs no env / no keys. Maps the legacy AgentRuntimeConfig onto
  // the structural AgentRuntimeConfigView — delegates, does not reimplement config parsing.
  import type { ConfigPort, AgentRuntimeConfigView, AgentConfigValidationView } from "../application/ports/index.ts";

  // Structural shapes of the legacy fns (no src/ import at runtime — only the optional parity test may).
  export interface ConfigFns {
    configFromEnv(env?: Record<string, string | undefined>): unknown;            // returns legacy AgentRuntimeConfig
    validateAgentRuntimeConfig(cfg: unknown, keys: Record<string, boolean>): { valid: boolean; errors: string[] };
    publicAgentConfig(cfg: unknown): unknown;
  }

  export class ConfigAdapter implements ConfigPort {
    constructor(private readonly fns: ConfigFns) {}
    fromEnv(env?: Record<string, string | undefined>): AgentRuntimeConfigView {
      return toView(this.fns.configFromEnv(env));
    }
    validate(cfg: AgentRuntimeConfigView, keys: Record<string, boolean>): AgentConfigValidationView {
      return this.fns.validateAgentRuntimeConfig(cfg, keys);
    }
    publicView(cfg: AgentRuntimeConfigView): AgentRuntimeConfigView {
      return toView(this.fns.publicAgentConfig(cfg));
    }
  }
  // Map the legacy AgentRuntimeConfig (mode + assignments record) onto the structural view. The exact
  // legacy field names are resolved at Plan-6 wiring; this boundary map keeps the adapter src/-free.
  function toView(legacy: unknown): AgentRuntimeConfigView { /* shape map; see Plan-6 wiring */ return legacy as AgentRuntimeConfigView; }
  ```
- [ ] Run it, see it pass.
- [ ] `npx tsc --noEmit -p qa-engine/tsconfig.json` → 0.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/agent-runtime/infrastructure/config.adapter.ts \
          qa-engine/test/contexts/agent-runtime/infrastructure/config.adapter.test.ts
  git commit -m "feat(agent-runtime): ConfigAdapter wrapping configFromEnv/validate/publicAgentConfig (injected)"
  ```

## Task A.7 — `RoleAssignmentResolver` adapter (WRAP `assignmentForRole`, preserve the deliberate fallback)

> Implements `RoleAssignmentResolver.resolve(role)` by delegating to the legacy `assignmentForRole`. The
> 3-explicit / 5-fallback assignment behavior is a DELIBERATE design choice (§5.3(4)) — the resolver MUST
> preserve it, never "fix" it by demanding all 8 keys. Delegation test only.

**Files:** `qa-engine/src/contexts/agent-runtime/infrastructure/role-assignment-resolver.ts`,
`test/contexts/agent-runtime/infrastructure/role-assignment-resolver.test.ts`

- [ ] Write the failing delegation test (a fallback role resolves via the injected fn — assert delegation):
  ```ts
  // test/contexts/agent-runtime/infrastructure/role-assignment-resolver.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { RoleAssignmentResolverAdapter } from "@contexts/agent-runtime/infrastructure/role-assignment-resolver.ts";

  test("resolve delegates to assignmentForRole for an explicit role", () => {
    let seenRole = "";
    const resolver = new RoleAssignmentResolverAdapter(
      { mode: "dual", assignments: {} } as never,
      (_cfg, role) => { seenRole = role; return { provider: "opencode", model: "m-primary" }; },
    );
    const a = resolver.resolve("primary");
    assert.equal(seenRole, "primary"); // DELEGATION: a gutted impl returning a literal FAILS this
    assert.equal(a.provider, "opencode");
  });

  test("a fallback role (worker) still resolves via the SAME injected fn — fallback preserved, not 'fixed'", () => {
    const calls: string[] = [];
    const resolver = new RoleAssignmentResolverAdapter(
      { mode: "single", assignments: {} } as never,
      (_cfg, role) => { calls.push(role); return { provider: "opencode", model: "m-fallback" }; },
    );
    resolver.resolve("worker");
    // The adapter MUST NOT pre-filter to "3 explicit roles" — it forwards EVERY role to assignmentForRole,
    // which owns the 3-explicit / 5-fallback policy. A resolver that rejects "worker" would regress it.
    assert.deepEqual(calls, ["worker"]);
  });
  ```
- [ ] Run it, see it fail.
- [ ] Minimal impl (delegate; the resolver is constructed with the config + the injected `assignmentForRole`):
  ```ts
  // src/contexts/agent-runtime/infrastructure/role-assignment-resolver.ts
  // WRAP of src/agent-runtime/types.ts assignmentForRole. Preserves the DELIBERATE 3-explicit / 5-fallback
  // policy (§5.3(4)): the adapter forwards EVERY role to the injected fn, which owns the fallback. It does
  // NOT pre-filter roles. Config + fn injected so the test needs no opencode.json.
  import type { RoleAssignmentResolver } from "../application/ports/index.ts";
  import type { AgentRole, RoleAssignment } from "@kernel/agent-role.ts";

  type AssignmentForRole = (cfg: unknown, role: AgentRole) => RoleAssignment;

  export class RoleAssignmentResolverAdapter implements RoleAssignmentResolver {
    constructor(private readonly config: unknown, private readonly assignmentForRole: AssignmentForRole) {}
    resolve(role: AgentRole): RoleAssignment {
      return this.assignmentForRole(this.config, role);
    }
  }
  ```
- [ ] Run it, see it pass. `npx tsc --noEmit -p qa-engine/tsconfig.json` → 0.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/agent-runtime/infrastructure/role-assignment-resolver.ts \
          qa-engine/test/contexts/agent-runtime/infrastructure/role-assignment-resolver.test.ts
  git commit -m "feat(agent-runtime): RoleAssignmentResolver wrapping assignmentForRole (fallback preserved)"
  ```

## Task A.8 — `OpenCodeRuntimeStrategy` + `CodexRuntimeStrategy` adapters (WRAP the two strategies)

> The provider-agnostic core. Each adapter implements `AgentRuntimeStrategy` by **delegating** to the live
> `OpenCodeRuntimeStrategy` / `CodexRuntimeStrategy`. The injected legacy strategy is the seam, so the
> adapter test needs no `opencode serve` / `codex exec`. **Per-provider isolation is the invariant**: the
> two adapters share NO breaker state — verify it with a test (a Codex restart must not perturb the OpenCode
> strategy). `openSession` threads the `descriptor` (Task A.1) so SSE/telemetry registration survives.

**Files:** `qa-engine/src/contexts/agent-runtime/infrastructure/opencode-runtime.strategy.ts`,
`.../codex-runtime.strategy.ts` + mirrored tests.

- [ ] Write the failing delegation test for the OpenCode adapter (inject a fake legacy strategy):
  ```ts
  // test/contexts/agent-runtime/infrastructure/opencode-runtime.strategy.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { OpenCodeRuntimeStrategyAdapter } from "@contexts/agent-runtime/infrastructure/opencode-runtime.strategy.ts";

  test("openSession delegates to the injected strategy.open with the role+cwd+descriptor", async () => {
    let seen: { agent: string; cwd: string; descriptor?: unknown } | null = null;
    const fakeSession = { id: "s1", prompt: async () => "out", dispose: async () => {} };
    const adapter = new OpenCodeRuntimeStrategyAdapter({
      provider: "opencode",
      open: async (agent, cwd, opts) => { seen = { agent, cwd, descriptor: opts?.descriptor }; return fakeSession as never; },
      health: async () => ({ provider: "opencode", status: "ok", configured: true }),
      listModels: async () => [{ id: "m1" }],
    } as never,
      { resolve: () => ({ provider: "opencode", model: "m1" }) } as never,
      // the injected role→legacy-name map (inverse of LEGACY_AGENT_TO_ROLE) — the agent assertion checks it
      (role) => ({ primary: "qa-generator", reviewer: "qa-reviewer", explorer: "qa-explorer" } as Record<string, string>)[role] ?? role,
    );
    const session = await adapter.openSession("primary", "/m", { descriptor: { runId: "r1", role: "qa-generator" } });
    // DELEGATION: the legacy open received the mapped agent name + cwd + descriptor.
    assert.equal(seen!.cwd, "/m");
    assert.deepEqual(seen!.descriptor, { runId: "r1", role: "qa-generator" });
    // Assert the AGENT argument too, so a wrong roleToAgentName map (e.g. the identity stub passing "primary"
    // instead of "qa-generator") is CAUGHT here, not silently passed. Update the expected legacy name when
    // the real inverse map (Plan-6) lands; with the stub this test documents the placeholder gap explicitly.
    assert.equal(seen!.agent, "qa-generator");
    const out = await session.prompt("hi", { round: 1, isRepair: false });
    assert.equal(out.output, "out");
  });

  test("health/listModels/restart delegate to the wrapped strategy", async () => {
    const calls: string[] = [];
    const adapter = new OpenCodeRuntimeStrategyAdapter({
      provider: "opencode",
      open: async () => ({ id: "s", prompt: async () => "", dispose: async () => {} }) as never,
      health: async () => { calls.push("health"); return { provider: "opencode", status: "ok", configured: true }; },
      listModels: async () => { calls.push("models"); return []; },
      restart: async () => { calls.push("restart"); return { provider: "opencode", status: "ok", configured: true }; },
    } as never,
      { resolve: () => ({ provider: "opencode", model: "m1" }) } as never,
      (role) => role, // identity is fine here — this test never asserts the agent name
    );
    await adapter.health(); await adapter.listModels(); await adapter.restart?.();
    assert.deepEqual(calls, ["health", "models", "restart"]);
  });
  ```
  > NEVER assert a hardcoded model id / budget as the expected value — only that the injected strategy was
  > called and its return forwarded. Provider name in the fake is the fake's own input, not a frozen literal.
- [ ] Run it, see it fail.
- [ ] Minimal impl (delegate; map `AgentRole` → the legacy agent name via the INJECTED `roleToAgentName`;
  resolve the assignment via the resolver; thread `descriptor`):
  ```ts
  // src/contexts/agent-runtime/infrastructure/opencode-runtime.strategy.ts
  // WRAP of src/agent-runtime/opencode-strategy.ts OpenCodeRuntimeStrategy. Delegates openSession/health/
  // listModels/restart to the injected legacy strategy. The RoleAssignmentResolver maps AgentRole → the
  // provider+model the legacy open() expects; the descriptor (Task A.1) threads the run→session SSE mapping.
  // PER-PROVIDER ISOLATION: this adapter holds NO breaker state — the wrapped strategy owns its own
  // independent circuit-breaker (a Codex outage must never trip this one). Do not add shared global state.
  import type { AgentRuntimeStrategy, AgentSession, OpenSessionOpts, RoleAssignmentResolver,
    AgentProviderHealth, AgentModelInfo } from "../application/ports/index.ts";
  import type { AgentRole } from "@kernel/agent-role.ts";

  // Structural shape of the legacy strategy (no src/ import at runtime — only the optional parity test may).
  interface LegacyStrategy {
    provider: "opencode" | "codex";
    open(agent: string, cwd: string, opts?: { signal?: AbortSignal; timeoutMs?: number; model?: string;
      onUsage?: (u: unknown) => void; onTurn?: (t: unknown) => void; descriptor?: unknown }): Promise<LegacySession>;
    health(): Promise<AgentProviderHealth>;
    listModels(): Promise<AgentModelInfo[]>;
    restart?(opts?: { apiKey?: string; reason?: string }): Promise<AgentProviderHealth>;
    dispose?(): void | Promise<void>;
  }
  interface LegacySession {
    id: string;
    prompt(text: string, opts?: { textOnly?: boolean; round?: number; isRepair?: boolean; sectionSizes?: Record<string, number> | null }): Promise<string>;
    dispose(): Promise<void>;
  }

  export class OpenCodeRuntimeStrategyAdapter implements AgentRuntimeStrategy {
    readonly provider = "opencode" as const;
    // roleToAgentName is INJECTED (like AgentRuntimeAdapter, Task A.14) so the test supplies the real inverse
    // map and a wrong mapping is caught by the agent-argument assertion — not hidden behind a module stub.
    constructor(
      private readonly legacy: LegacyStrategy,
      private readonly resolver: RoleAssignmentResolver,
      private readonly roleToAgentName: (r: AgentRole) => string,
    ) {}

    async openSession(role: AgentRole, cwd: string, opts?: OpenSessionOpts): Promise<AgentSession> {
      const assignment = this.resolver.resolve(role);
      const session = await this.legacy.open(this.roleToAgentName(role), cwd, {
        ...(opts?.signal ? { signal: opts.signal } : {}),
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        model: opts?.model ?? assignment.model,
        ...(opts?.onUsage ? { onUsage: opts.onUsage } : {}),
        ...(opts?.onTurn ? { onTurn: opts.onTurn } : {}),
        ...(opts?.descriptor ? { descriptor: opts.descriptor } : {}),
      });
      // Adapt the legacy session (prompt → string) to the port session (prompt → { output }).
      return {
        prompt: async (text, o) => ({ output: await session.prompt(text, o) }),
        dispose: () => session.dispose(),
      };
    }
    health(): Promise<AgentProviderHealth> { return this.legacy.health(); }
    listModels(): Promise<AgentModelInfo[]> { return this.legacy.listModels(); }
    restart(o?: { apiKey?: string; reason?: string }): Promise<AgentProviderHealth> {
      return this.legacy.restart ? this.legacy.restart(o) : this.legacy.health();
    }
    dispose(): void | Promise<void> { return this.legacy.dispose?.(); }
  }

  // The role→legacy-name map is INJECTED (constructor param above), NOT a module stub — so the test supplies
  // the real map and the agent-argument assertion catches a wrong one. The canonical map is the INVERSE of
  // LEGACY_AGENT_TO_ROLE in src/agent-runtime/facades.ts ("qa-generator"→primary, "qa-reviewer"→reviewer,
  // "qa-explorer"→explorer, …); Plan-6 wiring constructs the adapter with it. Exporting a default inverse-map
  // helper here is optional — keep it OUT of the adapter so no wrong identity-default can leak into wiring.
  ```
- [ ] Run it, see it pass.
- [ ] Build `CodexRuntimeStrategyAdapter` the same way (delegate to `CodexRuntimeStrategy`, `provider="codex"`).
  Then add the **isolation test** (a single test asserting the two adapters share no mutable state):
  ```ts
  // test/contexts/agent-runtime/infrastructure/provider-isolation.test.ts
  // Per-provider isolation invariant: restarting the Codex adapter must not perturb the OpenCode adapter
  // (no shared breaker/global). Each adapter wraps an INDEPENDENT legacy strategy — verify they don't alias.
  // ... construct both with separate fakes; restart codex; assert opencode health untouched ...
  ```
- [ ] Run the agent-runtime infrastructure test set + isolated gate:
  ```bash
  node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/agent-runtime/infrastructure/**/*.test.ts"
  npx tsc --noEmit -p qa-engine/tsconfig.json
  ```
  Expected: all pass; typecheck 0.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/agent-runtime/infrastructure/opencode-runtime.strategy.ts \
          qa-engine/src/contexts/agent-runtime/infrastructure/codex-runtime.strategy.ts \
          qa-engine/test/contexts/agent-runtime/infrastructure/
  git commit -m "feat(agent-runtime): OpenCode/Codex strategy adapters wrapping the two runtimes (per-provider isolation)"
  ```

## Task A.9 — `TurnTelemetryAdapter` + `StallWatchdogAdapter` (WRAP the SSE bridge + stall watchdog)

> `TurnTelemetryAdapter` implements `TurnTelemetrySink.record` by delegating to the injected `saveAgentTurn`
> (the SSE/turn persistence bridge). `StallWatchdogAdapter` implements `StallWatchdogPort.attach` by
> delegating to `createStallWatchdog`/`withStallWatchdog`. Both injected — no DB, no timers in the test.
> The watchdog stays a SEPARATE port (Option B): its per-session attach/detach lifecycle is distinct from the
> breaker's retry loop and must not be coupled to it.

**Files:** `qa-engine/src/contexts/agent-runtime/infrastructure/turn-telemetry.adapter.ts`,
`.../stall-watchdog.adapter.ts` + mirrored tests.

- [ ] Write the failing delegation test for the telemetry adapter (inject a fake `saveAgentTurn`):
  ```ts
  // test/contexts/agent-runtime/infrastructure/turn-telemetry.adapter.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { TurnTelemetryAdapter } from "@contexts/agent-runtime/infrastructure/turn-telemetry.adapter.ts";

  test("record delegates to the injected saveAgentTurn with the mapped event", () => {
    let seen: unknown = null;
    const adapter = new TurnTelemetryAdapter((row) => { seen = row; });
    adapter.record({ runId: "r1", role: "primary", round: 2, isRepair: true, sectionSizes: { task: 100 } });
    assert.ok(seen, "saveAgentTurn must be called — a gutted impl that no-ops FAILS this");
  });
  ```
- [ ] Run it, see it fail.
- [ ] Minimal impl (delegate; map `AgentTurnEvent` → the legacy turn row shape):
  ```ts
  // src/contexts/agent-runtime/infrastructure/turn-telemetry.adapter.ts
  // WRAP of src/server/history.ts saveAgentTurn (the SSE/turn persistence bridge). Replaces the direct
  // saveAgentTurn import in the legacy strategies with a clean sink. Injected so the test needs no DB.
  // Maps the port AgentTurnEvent (runId/role/round/isRepair/sectionSizes) onto the legacy row shape.
  import type { TurnTelemetrySink, AgentTurnEvent } from "../application/ports/index.ts";
  type SaveAgentTurn = (row: unknown) => void;
  export class TurnTelemetryAdapter implements TurnTelemetrySink {
    constructor(private readonly saveAgentTurn: SaveAgentTurn) {}
    record(event: AgentTurnEvent): void { this.saveAgentTurn(toRow(event)); }
  }
  function toRow(e: AgentTurnEvent): unknown { /* map to the legacy agent_turns row; see Plan-6 wiring */ return e; }
  ```
- [ ] Run it, see it pass.
- [ ] Build `StallWatchdogAdapter` the same way (delegate to `createStallWatchdog`; `attach` returns the
  detach fn; unit-test that attach calls the injected factory and the returned detach is callable). Each:
  failing test → impl → pass.
- [ ] Run the test set + isolated gate:
  ```bash
  node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/agent-runtime/infrastructure/{turn-telemetry,stall-watchdog}.adapter.test.ts"
  npx tsc --noEmit -p qa-engine/tsconfig.json
  ```
  Expected: all pass; typecheck 0.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/agent-runtime/infrastructure/turn-telemetry.adapter.ts \
          qa-engine/src/contexts/agent-runtime/infrastructure/stall-watchdog.adapter.ts \
          qa-engine/test/contexts/agent-runtime/infrastructure/{turn-telemetry,stall-watchdog}.adapter.test.ts
  git commit -m "feat(agent-runtime): TurnTelemetry + StallWatchdog adapters wrapping the SSE bridge + watchdog"
  ```

---

## Task A.9b — `AgentFacadeAdapter` (WRAP `SingleAgentFacade` / `DualAgentFacade` behind `AgentFacadePort`)

> **The single-vs-dual dispatch seam the brief's ALL-WRAP mandate requires** ("facades behind
> RoleAssignmentResolver", brief line 29). `SingleAgentFacade`/`DualAgentFacade` (`src/agent-runtime/facades.ts`)
> own the mode-aware orchestration: `getStatus()` (one provider vs. both), `listModels(provider?)`,
> `startEventStream()` (single SSE stream vs. multiplexing two providers), and `deps()`. Without wrapping
> them the hexagonal boundary for single vs. dual mode is incomplete at Plan 5's end — the strategy adapters
> (A.8) cover ONE provider each, but the facade is what selects/combines them per `AgentMode`. Verified at
> HEAD: `AgentFacade` (src/agent-runtime/types.ts) is `config`/`deps()`/`getStatus()`/`listModels()`/
> `startEventStream?()` — there is **no `run(input)`** method; the dispatch lives in status/streaming/deps.
> The adapter DELEGATES to the injected legacy facade (single or dual) — it never re-implements the
> mode logic, and never collapses dual into single.

**Files:** `qa-engine/src/contexts/agent-runtime/application/ports/index.ts` (add `AgentFacadePort`),
`qa-engine/src/contexts/agent-runtime/infrastructure/agent-facade.adapter.ts`,
`test/contexts/agent-runtime/infrastructure/agent-facade.adapter.test.ts`

- [ ] Add `AgentFacadePort` to the agent-runtime port barrel (mirrors the legacy `AgentFacade` surface;
  structural, no `src/` import):
  ```ts
  // qa-engine/src/contexts/agent-runtime/application/ports/index.ts (add)
  // The mode-aware (single/dual) facade seam. Wraps SingleAgentFacade/DualAgentFacade — getStatus reports
  // one provider (single) or both (dual); startEventStream multiplexes the dual streams. The adapter
  // delegates to whichever legacy facade it was constructed with; it never collapses dual into single.
  export interface AgentFacadePort {
    getStatus(): Promise<{ mode: "single" | "dual"; providers: AgentProviderHealth[] }>;
    listModels(provider?: AgentProvider): Promise<AgentModelInfo[]>;
    startEventStream?(onActivity: (a: unknown) => void, signal?: AbortSignal,
      onRunEvent?: (runId: string, body: unknown) => void): Promise<void>;
  }
  ```
  Run `npx tsc --noEmit -p qa-engine/tsconfig.json` → 0.
- [ ] Write the failing delegation test (inject a fake legacy facade; assert mode + provider forwarding —
  a single fake reports one provider, a dual fake reports two; a gutted impl that ignores the facade FAILS):
  ```ts
  // test/contexts/agent-runtime/infrastructure/agent-facade.adapter.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { AgentFacadeAdapter } from "@contexts/agent-runtime/infrastructure/agent-facade.adapter.ts";

  test("getStatus delegates to the wrapped DUAL facade and forwards BOTH providers (mode not collapsed)", async () => {
    let called = false;
    const adapter = new AgentFacadeAdapter({
      getStatus: async () => { called = true; return { mode: "dual", providers: [
        { provider: "opencode", status: "ok", configured: true }, { provider: "codex", status: "ok", configured: true }] }; },
      listModels: async () => [],
    } as never);
    const s = await adapter.getStatus();
    assert.equal(called, true);
    assert.equal(s.mode, "dual");                    // DELEGATION: the wrapped facade's mode, not a literal
    assert.equal(s.providers.length, 2);             // dual is NOT collapsed to one provider
  });

  test("startEventStream delegates to the wrapped facade (the dual SSE multiplex survives)", async () => {
    const calls: string[] = [];
    const adapter = new AgentFacadeAdapter({
      getStatus: async () => ({ mode: "single", providers: [] }),
      listModels: async () => [],
      startEventStream: async () => { calls.push("stream"); },
    } as never);
    await adapter.startEventStream?.(() => {});
    assert.deepEqual(calls, ["stream"]);             // a wrapper that dropped the optional stream would FAIL
  });
  ```
- [ ] Run it, see it fail.
- [ ] Minimal impl (delegate to the injected legacy facade; forward every method, keep `startEventStream`
  optional so a facade without it is honored):
  ```ts
  // src/contexts/agent-runtime/infrastructure/agent-facade.adapter.ts
  // WRAP of src/agent-runtime/facades.ts SingleAgentFacade / DualAgentFacade behind AgentFacadePort. The
  // legacy facade (single OR dual) is injected — the adapter forwards getStatus/listModels/startEventStream
  // verbatim. It NEVER decides single-vs-dual itself (the wrapped facade owns that) and NEVER collapses dual
  // into single. The two-provider independence (a Codex outage must not trip OpenCode) lives in the wrapped
  // facade + the strategy adapters (A.8), not here.
  import type { AgentFacadePort, AgentProviderHealth, AgentModelInfo } from "../application/ports/index.ts";
  import type { AgentProvider } from "@kernel/agent-role.ts";

  // Structural shape of the legacy AgentFacade (no src/ import at runtime — only the optional parity test may).
  interface LegacyFacade {
    getStatus(): Promise<{ mode: "single" | "dual"; providers: AgentProviderHealth[] }>;
    listModels(provider?: AgentProvider): Promise<AgentModelInfo[]>;
    startEventStream?(onActivity: (a: unknown) => void, signal?: AbortSignal,
      onRunEvent?: (runId: string, body: unknown) => void): Promise<void>;
  }

  export class AgentFacadeAdapter implements AgentFacadePort {
    constructor(private readonly facade: LegacyFacade) {}
    getStatus() { return this.facade.getStatus(); }
    listModels(provider?: AgentProvider) { return this.facade.listModels(provider); }
    startEventStream(onActivity: (a: unknown) => void, signal?: AbortSignal,
      onRunEvent?: (runId: string, body: unknown) => void) {
      // Honor the optional method: only delegate if the wrapped facade exposes it.
      return this.facade.startEventStream
        ? this.facade.startEventStream(onActivity, signal, onRunEvent)
        : Promise.resolve();
    }
  }
  ```
  > Construct ONE adapter per facade instance (single OR dual) at Plan-6 wiring — the adapter does not choose
  > the mode. NEVER add shared state across two adapters (the per-provider isolation invariant, like A.8).
- [ ] Run it, see it pass. `npx tsc --noEmit -p qa-engine/tsconfig.json` → 0.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/agent-runtime/application/ports/index.ts \
          qa-engine/src/contexts/agent-runtime/infrastructure/agent-facade.adapter.ts \
          qa-engine/test/contexts/agent-runtime/infrastructure/agent-facade.adapter.test.ts
  git commit -m "feat(agent-runtime): AgentFacadeAdapter wrapping Single/DualAgentFacade (mode not collapsed)"
  ```

## Task A.10 — Seam-2 (qa-engine half): `generation-ports.ts` canonical input types

> **The qa-engine half of the Seam-2 cycle break.** Create `generation-ports.ts` holding the CANONICAL
> `OpencodeRunInput` / `ReviewInput` / `ParallelWorkerInput` definitions. The cycle is:
> `opencode-client.ts:51` imports the 14 prompt builders from `./prompts` as VALUES; `prompts.ts:19`
> imports the 3 input types from `./opencode-client` as `import type`. The break re-roots `prompts.ts:19`
> onto `generation-ports.ts` (Phase B, Task B.4) so the type-only cycle disappears.
>
> **CRITICAL — do NOT copy-freeze a subset.** `OpencodeRunInput` has ~25 fields and is GROWING (the user's
> deterministic-signal builders feed `contextPack`/`domSnapshot`/`staticSignal`/`diffArchetypes` into it).
> Define the canonical types here CLEANLY (the full current field set), and at Phase B the
> `opencode-client.ts` definitions become **re-export ALIASES** of these so its 10+ external callers
> (`pipeline.ts`, `index.ts`, the four `agent-runtime/*` files, `server/{maintainer-runtime,runner,api}.ts`)
> keep compiling unchanged. This task ONLY creates the qa-engine module; it touches NO `src/` file.

**Files:** `qa-engine/src/contexts/generation/application/ports/generation-ports.ts`,
`test/contexts/generation/application/ports/generation-ports.test.ts`,
`test/contexts/generation/application/ports/generation-ports-parity.test.ts`

- [ ] Re-read the CURRENT HEAD field sets (the user grows these — copy the live shape, not the snapshot):
  ```bash
  sed -n '/^export interface OpencodeRunInput/,/^}/p' src/integrations/opencode-client.ts
  sed -n '/^export interface ReviewInput/,/^}/p' src/integrations/opencode-client.ts
  sed -n '/^export interface ParallelWorkerInput/,/^}/p' src/integrations/opencode-client.ts
  ```
- [ ] Write a failing structural test (the canonical type accepts a full input; `tsc` is the real guard):
  ```ts
  // test/contexts/generation/application/ports/generation-ports.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import type { OpencodeRunInput, ReviewInput, ParallelWorkerInput } from "@contexts/generation/application/ports/generation-ports.ts";

  test("OpencodeRunInput accepts the full deterministic-signal field set (contextPack/domSnapshot/staticSignal/diffArchetypes)", () => {
    const input: OpencodeRunInput = {
      repo: "o/a", sha: "abc", diff: "d", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "qa-bot-abc",
      needsReview: true, target: "e2e", mode: "diff", appName: "a",
      contextPack: "pack", domSnapshot: "dom", staticSignal: "sig", diffArchetypes: ["auth-flow"],
    };
    assert.equal(input.target, "e2e"); // compile-time is the real assertion; this keeps node:test happy
  });
  ```
- [ ] Run it, see it fail (module not found).
- [ ] Minimal impl — define the canonical types CLEANLY, importing the supporting types from the kernel
  where they already live (`TestTarget`/`RunMode`/`QaCase` are kernel VOs in the new tree; `CommitIntent`/
  `ArchitectureContext`/`ExplorationBrief` are referenced structurally or via kernel re-exports). Copy the
  FULL current field set with comments preserved:
  ```ts
  // src/contexts/generation/application/ports/generation-ports.ts
  // Seam-2 cycle break: the canonical OpencodeRunInput / ReviewInput / ParallelWorkerInput live HERE,
  // cycle-free. At Phase B the legacy src/integrations/opencode-client.ts definitions become re-export
  // ALIASES of these, and prompts.ts:19 re-roots onto this module — dissolving the opencode-client ⇄
  // prompts type-only cycle (design §7.1 Seam-2, §7.2 Step 4b). These are the FULL current field sets
  // (not a frozen subset) so the user's growing deterministic-signal fields flow through unchanged.
  import type { TestTarget, RunMode, QaCase } from "@kernel/qa-case.ts"; // resolve exact kernel homes in Task 0
  // <define OpencodeRunInput with the full ~25-field set copied from HEAD, comments preserved>
  // <define ReviewInput with the full field set>
  // <define ParallelWorkerInput with the full field set>
  ```
  > If a supporting type (`CommitIntent`, `ArchitectureContext`, `ExplorationBrief`) is not yet kernel-resident,
  > declare a minimal structural alias locally and leave a `// Plan-6: re-home to kernel` note — do NOT import
  > it from `src/` (that would recreate a cross-tree coupling the typecheck rejects).
- [ ] Run it, see it pass.
- [ ] Write a Phase-A **structural parity** test that the qa-engine canonical type is assignable from a
  legacy value (proves no field was dropped). This imports from `src/` → exclude from typecheck, run via tsx:
  ```ts
  // test/contexts/generation/application/ports/generation-ports-parity.test.ts
  // PARITY (structural): a legacy OpencodeRunInput value must satisfy the canonical type and vice-versa —
  // proving the canonical definition dropped no field. Imports from src/ → excluded from qa-engine typecheck.
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import type { OpencodeRunInput as Canonical } from "@contexts/generation/application/ports/generation-ports.ts";
  import type { OpencodeRunInput as Legacy } from "../../../../../../src/integrations/opencode-client.ts";

  test("PARITY: a Legacy input is assignable to Canonical (no field dropped)", () => {
    // Compile-time check via a typed identity round-trip. If a required field exists in Legacy but not
    // Canonical, this file fails to typecheck under tsx; the runtime assert is a formality.
    const roundTrip = (x: Legacy): Canonical => x;
    assert.equal(typeof roundTrip, "function");
  });
  ```
- [ ] Add BOTH the parity file AND `generation-ports.test.ts` exclusion decisions: the parity file goes to
  the typecheck exclude list; the structural unit test stays in (it imports only from `@contexts`). Append:
  ```jsonc
  // qa-engine/tsconfig.json — append to "exclude"
  "test/contexts/generation/application/ports/generation-ports-parity.test.ts"
  ```
- [ ] Run both + the isolated gate:
  ```bash
  node --import ./test-setup.mjs --import tsx --test \
    "qa-engine/test/contexts/generation/application/ports/generation-ports.test.ts" \
    "qa-engine/test/contexts/generation/application/ports/generation-ports-parity.test.ts"
  npx tsc --noEmit -p qa-engine/tsconfig.json
  ```
  Expected: all pass; typecheck 0.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/generation/application/ports/generation-ports.ts \
          qa-engine/test/contexts/generation/application/ports/ qa-engine/tsconfig.json
  git commit -m "feat(generation): generation-ports.ts canonical Seam-2 input types (qa-engine half)"
  ```

## Task A.11 — `PromptRenderingAdapter` (WRAP the 14 stable `prompts.ts` builders)

> Implements `PromptRenderingPort` by delegating to the STABLE prompt builders (`buildWorkerPromptAssembled`,
> `buildReviewerPromptAssembled`, `buildExplorerPrompt`, `buildFollowupPrompt`, `renderArchitectureContext`,
> `buildContextTask`, `reviewObjective`, `renderReviewSpecs`, `renderExecutionResult`, `specFileForFlow`, +
> the assembled variants). All injected so the adapter test needs no real builders. **`buildPromptAssembled`
> / `buildPlanPromptAssembled` are IN-FLUX** (they call `roleWindowBytes`, which is catalog-dependent) — the
> adapter WRAPS them (delegation inherits the user's fix); their budget concern is Phase B (Task B.1). Here
> we wrap the stable string-rendering builders only.

**Files:** `qa-engine/src/contexts/generation/infrastructure/prompt-rendering.adapter.ts`,
`test/contexts/generation/infrastructure/prompt-rendering.adapter.test.ts`

- [ ] Write the failing delegation test (inject fake builders recording inputs):
  ```ts
  // test/contexts/generation/infrastructure/prompt-rendering.adapter.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { PromptRenderingAdapter } from "@contexts/generation/infrastructure/prompt-rendering.adapter.ts";

  test("renderWorker delegates to buildWorkerPromptAssembled and returns its assembled text", () => {
    let seen: unknown = null;
    const adapter = new PromptRenderingAdapter({
      buildWorkerPromptAssembled: (w) => { seen = w; return { text: "WORKER", sectionSizes: { task: 7 } } as never; },
      buildReviewerPromptAssembled: () => ({ text: "REV", sectionSizes: {} }) as never,
      buildExplorerPrompt: () => "EXP",
      specFileForFlow: (flow) => `e2e/${flow}.spec.ts`,
    } as never);
    const out = adapter.renderWorker({ flow: "login" } as never);
    assert.ok(seen, "the builder must be called — a gutted impl FAILS this");
    assert.equal(out.text, "WORKER");
    assert.deepEqual(out.sectionSizes, { task: 7 }); // sectionSizes forwarded for telemetry (not dropped)
  });

  test("specFileForFlow delegates (path mapping preserved)", () => {
    const adapter = new PromptRenderingAdapter({
      buildWorkerPromptAssembled: () => ({ text: "", sectionSizes: {} }) as never,
      buildReviewerPromptAssembled: () => ({ text: "", sectionSizes: {} }) as never,
      buildExplorerPrompt: () => "",
      specFileForFlow: (flow) => `e2e/${flow}.spec.ts`,
    } as never);
    assert.equal(adapter.specFileForFlow("checkout"), "e2e/checkout.spec.ts");
  });
  ```
  > NEVER assert a rendered prompt's exact STRING content or a budget number as a frozen literal — the
  > builders' text drifts with the user's edits. Assert that the injected builder was called and its return
  > (text + sectionSizes) was forwarded faithfully.
- [ ] Run it, see it fail.
- [ ] Minimal impl (a struct of injected builders; the adapter forwards inputs and returns `{ text, sectionSizes }`):
  ```ts
  // src/contexts/generation/infrastructure/prompt-rendering.adapter.ts
  // WRAP of the STABLE src/integrations/prompts.ts builders behind PromptRenderingPort. Every builder is
  // injected so the adapter test needs none of them. The adapter forwards the typed input and returns the
  // assembled { text, sectionSizes } — sectionSizes flows on so the telemetry funnel (AgentTurnEvent) keeps
  // the per-section byte map. Delegates — does NOT reimplement any prompt string.
  import type { PromptRenderingPort } from "../application/ports/index.ts";
  import type { OpencodeRunInput, ReviewInput, ParallelWorkerInput } from "../application/ports/generation-ports.ts";

  export interface PromptBuilders {
    buildWorkerPromptAssembled(w: ParallelWorkerInput): { text: string; sectionSizes: Record<string, number> };
    buildReviewerPromptAssembled(input: ReviewInput): { text: string; sectionSizes: Record<string, number> };
    buildExplorerPrompt(input: OpencodeRunInput): string;
    specFileForFlow(flow: string): string;
    // The remaining stable builders (buildFollowupPrompt, buildContextTask, reviewObjective,
    // renderArchitectureContext, renderReviewSpecs, renderExecutionResult) are added the same way as the
    // generation use-case needs them; each is a thin forward.
  }

  export class PromptRenderingAdapter implements PromptRenderingPort {
    constructor(private readonly b: PromptBuilders) {}
    renderWorker(w: ParallelWorkerInput) { return this.b.buildWorkerPromptAssembled(w); }
    renderReviewer(input: ReviewInput) { return this.b.buildReviewerPromptAssembled(input); }
    renderExplorer(input: OpencodeRunInput) { return this.b.buildExplorerPrompt(input); }
    specFileForFlow(flow: string) { return this.b.specFileForFlow(flow); }
  }
  ```
  > The `AssembledPrompt` shape (`{ text, sectionSizes }`) is re-verified in Task 0 — adjust the field names
  > if the legacy `assemble()` returns differently. `PromptRenderingPort` (Plan-2) `render(sections)` stays
  > the generic seam; these named methods are the concrete builder forwards the use-case consumes.
- [ ] Run it, see it pass. `npx tsc --noEmit -p qa-engine/tsconfig.json` → 0.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/generation/infrastructure/prompt-rendering.adapter.ts \
          qa-engine/test/contexts/generation/infrastructure/prompt-rendering.adapter.test.ts
  git commit -m "feat(generation): PromptRenderingAdapter wrapping the stable prompts builders (injected)"
  ```

## Task A.12 — `VerdictParserAdapter` + `PlanParserAdapter` (WRAP `parseVerdict`/`parseReviewerVerdict`/`parsePlan`)

> `VerdictParserAdapter` implements `VerdictParserPort` by delegating to `parseVerdict` (generator) +
> `parseReviewerVerdict` (reviewer). **Fail-closed on an unparseable verdict** is the legacy contract —
> the wrap inherits it (do NOT "improve" it to fail-open). The reviewer parse MUST forward `blockingCount`
> + `parsed` **AND `valid` + `issues`** (Task A.3 port edit) — without `valid`/`issues` the use-case (B.3)
> cannot fire the bounded contract-repair re-prompt (`opencode-client.ts:979-983`), a silent regression.
> `PlanParserAdapter` implements `PlanParserPort.parse` by delegating to `parsePlan`/`parsePlanResult`.

**Files:** `qa-engine/src/contexts/generation/infrastructure/verdict-parser.adapter.ts`,
`.../plan-parser.adapter.ts` + mirrored tests.

- [ ] First add `PlanParserPort` to the generation port barrel (the use-case needs the plan→objectives seam):
  ```ts
  // qa-engine/src/contexts/generation/application/ports/index.ts (add)
  export interface PlanObjectiveView { flow: string; objective: string; reason?: string }
  export interface PlanParserPort { parse(text: string): PlanObjectiveView[]; }
  ```
  Run `npx tsc --noEmit -p qa-engine/tsconfig.json` → 0.
- [ ] Write the failing delegation test for the verdict adapter (inject fake parsers; assert blockingCount+parsed forward):
  ```ts
  // test/contexts/generation/infrastructure/verdict-parser.adapter.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { VerdictParserAdapter } from "@contexts/generation/infrastructure/verdict-parser.adapter.ts";

  test("parseReview delegates and forwards blockingCount + parsed + valid + issues (no behavior drop)", () => {
    const adapter = new VerdictParserAdapter({
      parseVerdict: () => ({ parsed: true, specs: ["a.spec.ts"] }) as never,
      parseReviewerVerdict: () => ({ approved: true, corrections: [], blockingCount: 0, parsed: true, valid: true, issues: [] }) as never,
    } as never);
    const j = adapter.parseReview("…json…");
    assert.equal(j.approved, true);
    assert.equal(j.blockingCount, 0);   // forwarded — a port that dropped it would be undefined here
    assert.equal(j.parsed, true);       // forwarded — the parse-miss round-saver survives
    assert.equal(j.valid, true);        // forwarded — the bounded-repair signal survives
    assert.deepEqual(j.issues, []);     // forwarded — fed to repairInstruction on a contract miss
  });

  test("a contract-miss reviewer verdict forwards valid:false + issues (the bounded-repair re-prompt fuel)", () => {
    const adapter = new VerdictParserAdapter({
      parseVerdict: () => ({ parsed: true, specs: [] }) as never,
      parseReviewerVerdict: () => ({ approved: false, corrections: [], blockingCount: 0, parsed: true, valid: false, issues: ["contract failure"] }) as never,
    } as never);
    const j = adapter.parseReview("…malformed reviewer json…");
    // valid:false ≠ a real rejection — the use-case (B.3) fires ONE repairInstruction("reviewer", issues).
    assert.equal(j.valid, false);
    assert.deepEqual(j.issues, ["contract failure"]); // a port that dropped issues would be undefined — gutted-impl-proof
  });

  test("a parse MISS is fail-closed (approved:false, parsed:false) — inherited from legacy, not 'fixed'", () => {
    const adapter = new VerdictParserAdapter({
      parseVerdict: () => ({ parsed: false, specs: [] }) as never,
      parseReviewerVerdict: () => ({ approved: false, corrections: ["no parseable verdict"], blockingCount: 0, parsed: false, valid: false, issues: ["no reviewer verdict JSON found"] }) as never,
    } as never);
    const j = adapter.parseReview("garbage");
    assert.equal(j.approved, false);
    assert.equal(j.parsed, false);
  });
  ```
- [ ] Run it, see it fail.
- [ ] Minimal impl (delegate; map the legacy verdict shapes → the port's `GeneratorDeliverable`/`ReviewJudgment`):
  ```ts
  // src/contexts/generation/infrastructure/verdict-parser.adapter.ts
  // WRAP of src/integrations/verdict-parse.ts parseVerdict + verdict-validate.ts parseReviewerVerdict.
  // FAIL-CLOSED on an unparseable verdict is the legacy contract — inherited, not changed. The reviewer
  // path forwards blockingCount + parsed so the blocking-vs-advisory gate and the parse-miss round-saver
  // survive. Both parsers injected — no LLM text fixtures needed beyond the test's own.
  import type { VerdictParserPort, GeneratorDeliverable, ReviewJudgment } from "../application/ports/index.ts";
  interface LegacyVerdict { parsed: boolean; specs?: string[]; note?: string }
  // Mirrors src/integrations/verdict-validate.ts ReviewerVerdict. valid + issues are REQUIRED in the legacy
  // shape (the bounded-repair signal) — declare them here so parseReview can forward them; dropping them
  // would make the use-case's contract-repair re-prompt (Task B.3) structurally impossible.
  interface LegacyReviewer { approved: boolean; corrections: string[]; rationale?: string; blockingCount?: number; parsed?: boolean; valid: boolean; issues: string[] }
  export interface VerdictParsers {
    parseVerdict(text: string): LegacyVerdict;
    parseReviewerVerdict(text: string): LegacyReviewer;
  }
  export class VerdictParserAdapter implements VerdictParserPort {
    constructor(private readonly p: VerdictParsers) {}
    parseGenerator(text: string): GeneratorDeliverable {
      const v = this.p.parseVerdict(text);
      return { specs: v.specs ?? [], ...(v.note ? { note: v.note } : {}) };
    }
    parseReview(text: string): ReviewJudgment {
      const r = this.p.parseReviewerVerdict(text);
      return {
        approved: r.approved, corrections: r.corrections,
        ...(r.rationale ? { rationale: r.rationale } : {}),
        ...(r.blockingCount !== undefined ? { blockingCount: r.blockingCount } : {}),
        ...(r.parsed !== undefined ? { parsed: r.parsed } : {}),
        // valid + issues forwarded verbatim — the use-case (B.3) reads them to fire the bounded reviewer repair.
        ...(r.valid !== undefined ? { valid: r.valid } : {}),
        ...(r.issues !== undefined ? { issues: r.issues } : {}),
      };
    }
  }
  ```
- [ ] Run it, see it pass.
- [ ] Build `PlanParserAdapter` the same way (delegate to `parsePlan`; map `PlanObjective` → `PlanObjectiveView`;
  unit-test delegation). Failing test → impl → pass.
- [ ] Run the test set + isolated gate:
  ```bash
  node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/generation/infrastructure/{verdict-parser,plan-parser}.adapter.test.ts"
  npx tsc --noEmit -p qa-engine/tsconfig.json
  ```
  Expected: all pass; typecheck 0.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/generation/application/ports/index.ts \
          qa-engine/src/contexts/generation/infrastructure/{verdict-parser,plan-parser}.adapter.ts \
          qa-engine/test/contexts/generation/infrastructure/{verdict-parser,plan-parser}.adapter.test.ts
  git commit -m "feat(generation): VerdictParser + PlanParser adapters (fail-closed, blockingCount/parsed forwarded)"
  ```

## Task A.13 — `ManifestRepositoryAdapter` (WRAP the manifest plumbing)

> Implements `ManifestRepositoryPort.read`/`reconcile` by delegating to the injected manifest fns
> (`ManifestEntrySchema` validation + the read/reconcile-against-disk plumbing from `opencode-client.ts`).
> The reconcile invariant — ids unique, every entry maps to an on-disk spec — is the legacy behavior; the
> wrap inherits it. File read injected so the test needs no disk.

**Files:** `qa-engine/src/contexts/generation/infrastructure/manifest-repository.adapter.ts`,
`test/contexts/generation/infrastructure/manifest-repository.adapter.test.ts`

- [ ] Write the failing delegation test (inject fake read + reconcile fns):
  ```ts
  // test/contexts/generation/infrastructure/manifest-repository.adapter.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { ManifestRepositoryAdapter } from "@contexts/generation/infrastructure/manifest-repository.adapter.ts";

  test("read delegates to the injected manifest reader", async () => {
    let seenDir = "";
    const adapter = new ManifestRepositoryAdapter({
      readManifest: async (dir) => { seenDir = dir; return [{ id: "1", file: "e2e/a.spec.ts", flow: "login", objective: "o" }]; },
      reconcileManifest: async (_dir, entries) => entries,
    });
    const entries = await adapter.read("/m/e2e");
    assert.equal(seenDir, "/m/e2e");
    assert.equal(entries[0]?.id, "1");
  });

  test("reconcile delegates and forwards the on-disk-pruned entries", async () => {
    let called = false;
    const adapter = new ManifestRepositoryAdapter({
      readManifest: async () => [],
      reconcileManifest: async (_dir, entries) => { called = true; return entries.filter((e) => e.id !== "stale"); },
    });
    const out = await adapter.reconcile("/m/e2e", [{ id: "1", file: "e2e/a.spec.ts", flow: "f", objective: "o" }, { id: "stale", file: "e2e/x.spec.ts", flow: "f", objective: "o" }]);
    assert.equal(called, true);
    assert.deepEqual(out.map((e) => e.id), ["1"]); // stale entry pruned by the injected reconcile
  });
  ```
- [ ] Run it, see it fail.
- [ ] Minimal impl (delegate to the injected read/reconcile fns):
  ```ts
  // src/contexts/generation/infrastructure/manifest-repository.adapter.ts
  // WRAP of the manifest plumbing in src/integrations/opencode-client.ts (ManifestEntrySchema-validated
  // read + reconcile-against-disk). The reconcile invariant (ids unique, every entry maps to an on-disk
  // spec) is the LEGACY behavior — inherited via delegation, not reimplemented. Fns injected — no disk in test.
  import type { ManifestRepositoryPort, ManifestEntry } from "../application/ports/index.ts";
  export interface ManifestFns {
    readManifest(specDir: string): Promise<ManifestEntry[]>;
    reconcileManifest(specDir: string, entries: readonly ManifestEntry[]): Promise<ManifestEntry[]>;
  }
  export class ManifestRepositoryAdapter implements ManifestRepositoryPort {
    constructor(private readonly fns: ManifestFns) {}
    read(specDir: string): Promise<ManifestEntry[]> { return this.fns.readManifest(specDir); }
    reconcile(specDir: string, entries: readonly ManifestEntry[]): Promise<ManifestEntry[]> {
      return this.fns.reconcileManifest(specDir, entries);
    }
  }
  ```
- [ ] Run it, see it pass. `npx tsc --noEmit -p qa-engine/tsconfig.json` → 0.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/generation/infrastructure/manifest-repository.adapter.ts \
          qa-engine/test/contexts/generation/infrastructure/manifest-repository.adapter.test.ts
  git commit -m "feat(generation): ManifestRepositoryAdapter wrapping the manifest read/reconcile plumbing"
  ```

## Task A.14 — `AgentRuntimeAdapter` (WRAP the `opencode-client` session lifecycle behind `AgentRuntimePort`)

> The generation context consumes `AgentRuntimePort` FROM the kernel (decoupled from agent-runtime, §5.2).
> This adapter implements the kernel `AgentRuntimePort.openSession` by delegating to the injected legacy
> `AgentDeps.open` (the `opencode serve` HTTP boundary). It threads the `descriptor` (Task A.1) and adapts
> the legacy session (`prompt → string`) to the port session (`prompt → { output }`), forwarding
> `round`/`isRepair`/`sectionSizes`. This is the SAME boundary the strategy adapter wraps (Task A.8) but
> from the GENERATION side — the use-case calls THIS one. Injected — no `opencode serve` in the test.

**Files:** `qa-engine/src/contexts/generation/infrastructure/agent-runtime.adapter.ts`,
`test/contexts/generation/infrastructure/agent-runtime.adapter.test.ts`

- [ ] Write the failing delegation test (inject a fake `AgentDeps`):
  ```ts
  // test/contexts/generation/infrastructure/agent-runtime.adapter.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { AgentRuntimeAdapter } from "@contexts/generation/infrastructure/agent-runtime.adapter.ts";

  test("openSession delegates to AgentDeps.open and adapts prompt → { output }, forwarding round/isRepair/sectionSizes", async () => {
    let promptOpts: unknown = null;
    const adapter = new AgentRuntimeAdapter({
      open: async (_agent, _cwd, _opts) => ({
        id: "s1",
        prompt: async (_t, o) => { promptOpts = o; return "RESULT"; },
        dispose: async () => {},
      }) as never,
    }, (role) => role);
    const session = await adapter.openSession("primary", "/m", { descriptor: { runId: "r1" } });
    const out = await session.prompt("go", { round: 3, isRepair: true, sectionSizes: { task: 9 } });
    assert.equal(out.output, "RESULT");
    assert.deepEqual(promptOpts, { round: 3, isRepair: true, sectionSizes: { task: 9 } }); // opts NOT dropped
  });
  ```
- [ ] Run it, see it fail.
- [ ] Minimal impl (delegate; map role→agent-name; adapt the session):
  ```ts
  // src/contexts/generation/infrastructure/agent-runtime.adapter.ts
  // WRAP of the src/integrations/opencode-client.ts session lifecycle (AgentDeps.open) behind the kernel
  // AgentRuntimePort. Generation consumes this port from the kernel (§5.2). The descriptor threads the
  // run→session SSE mapping; the prompt opts (round/isRepair/sectionSizes) are forwarded verbatim so the
  // telemetry funnel keeps them. AgentDeps injected — no opencode serve in tests. Delegates only.
  import type { AgentRuntimePort, AgentSession, OpenSessionOpts } from "@kernel/ports/agent-runtime.port.ts"; // kernel-resident (Task A.0b)
  import type { AgentRole } from "@kernel/agent-role.ts";
  interface LegacyAgentDeps {
    open(agent: string, cwd: string, opts?: { signal?: AbortSignal; timeoutMs?: number; model?: string;
      onUsage?: (u: unknown) => void; onTurn?: (t: unknown) => void; descriptor?: unknown }): Promise<{
        id: string; prompt(text: string, o?: { textOnly?: boolean; round?: number; isRepair?: boolean; sectionSizes?: Record<string, number> | null }): Promise<string>; dispose(): Promise<void>;
      }>;
  }
  export class AgentRuntimeAdapter implements AgentRuntimePort {
    constructor(private readonly deps: LegacyAgentDeps, private readonly roleToAgentName: (r: AgentRole) => string) {}
    async openSession(role: AgentRole, cwd: string, opts?: OpenSessionOpts): Promise<AgentSession> {
      const s = await this.deps.open(this.roleToAgentName(role), cwd, {
        ...(opts?.signal ? { signal: opts.signal } : {}),
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts?.model ? { model: opts.model } : {}),
        ...(opts?.onUsage ? { onUsage: opts.onUsage } : {}),
        ...(opts?.onTurn ? { onTurn: opts.onTurn } : {}),
        ...(opts?.descriptor ? { descriptor: opts.descriptor } : {}),
      });
      return {
        prompt: async (text, o) => ({ output: await s.prompt(text, o) }),
        dispose: () => s.dispose(),
      };
    }
  }
  ```
  > The kernel `AgentRuntimePort` lives at `@kernel/ports/agent-runtime.port.ts` after Task A.0b relocates it
  > (realizing §5.2). Generation consumes it FROM the kernel — do NOT import it from the agent-runtime context
  > barrel (that would re-couple the two contexts). The barrel re-exports the same type for agent-runtime's
  > own use.
  > **`cleanupOrphans`:** the real `AgentDeps` (`src/integrations/opencode-client.ts`) also carries
  > `cleanupOrphans?(maxAgeMs: number): Promise<number>`. The kernel `AgentRuntimePort` does NOT expose orphan
  > cleanup — it is an out-of-band janitor, not a session-lifecycle method, and is wired separately at Plan-6.
  > So `LegacyAgentDeps` here intentionally omits it (this adapter only forwards `open`). If a Plan-6 wire-up
  > needs orphan cleanup, it injects the legacy fn directly; do NOT smuggle it through this session adapter.
- [ ] Run it, see it pass. `npx tsc --noEmit -p qa-engine/tsconfig.json` → 0.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/generation/infrastructure/agent-runtime.adapter.ts \
          qa-engine/test/contexts/generation/infrastructure/agent-runtime.adapter.test.ts
  git commit -m "feat(generation): AgentRuntimeAdapter wrapping the opencode-client session lifecycle (injected)"
  ```

## Task A.15 — `context-assembler` + `exploration-brief` wrappers (WRAP the pure assembly fns)

> Wrap the two pure generation helpers: `assemble`/`section` (the ContextAssembler at
> `src/integrations/context-assembler.ts` — pure band/priority shedding) and the exploration-brief schema fns
> (`parseExplorationBrief`/`coerceExplorationBrief`/`renderExplorationBrief`) at **`src/qa/exploration-brief.ts`**
> (NOT `src/integrations/` — verified at HEAD; there is no `src/integrations/exploration-brief.ts`). These are
> pure, so the wrappers are thin delegators (no injection needed beyond the fn itself) and each gets a parity
> test pinning the wrapper to the legacy pure fn.

**Files:** `qa-engine/src/contexts/generation/infrastructure/context-assembler.adapter.ts`,
`.../exploration-brief.adapter.ts` + mirrored unit + parity tests.

- [ ] Write the failing unit test for the context-assembler wrapper (delegation):
  ```ts
  // test/contexts/generation/infrastructure/context-assembler.adapter.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { ContextAssemblerAdapter } from "@contexts/generation/infrastructure/context-assembler.adapter.ts";

  test("assemble delegates to the injected assemble fn and returns its AssembledPrompt", () => {
    let seenSections: unknown = null;
    const adapter = new ContextAssemblerAdapter(
      (sections, opts) => { seenSections = sections; return { text: "ASM", sectionSizes: { task: 3 } } as never; },
      (heading, band, body, opts) => ({ heading, band, body, ...opts }) as never,
    );
    const s = adapter.section("task", "task", "do x", { priority: 1 });
    const out = adapter.assemble([s], { budgetBytes: 1000 });
    assert.ok(seenSections, "assemble must be called");
    assert.equal(out.text, "ASM");
  });
  ```
  > **NEVER pass a hardcoded `budgetBytes` derived from a model window (192k/96k) as a frozen expectation.**
  > The test supplies an arbitrary `budgetBytes` and asserts the fn was CALLED with it — delegation only.
- [ ] Run it, see it fail.
- [ ] Minimal impl (thin delegators over the injected pure fns):
  ```ts
  // src/contexts/generation/infrastructure/context-assembler.adapter.ts
  // WRAP of src/integrations/context-assembler.ts assemble/section (pure band/priority shedding). Thin
  // delegators — the fns are pure so no side-effect injection is needed beyond the fns themselves. The
  // parity test pins the wrapper to the legacy pure fn. Does NOT reimplement the shedding algorithm.
  // ... ContextAssemblerAdapter { assemble(...) { return this.assembleFn(...) } section(...) { ... } }
  ```
- [ ] Run it, see it pass.
- [ ] Write the parity test (call BOTH the wrapper and the legacy `assemble`/`section` on a shared section
  table; `deepEqual` the assembled text + sectionSizes). Imports from `src/` → exclude from typecheck.
  > The parity FIXTURE supplies an arbitrary budget — it must NOT be `roleWindowBytes(...)` (catalog-dependent).
- [ ] Build the `exploration-brief.adapter.ts` the same way (delegate to the schema fns; parity test
  round-trips a brief through both). Each: failing test → impl → pass + parity. **The legacy source is
  `src/qa/exploration-brief.ts`** — the parity test imports from there, NOT `src/integrations/`:
  ```ts
  // test/contexts/generation/infrastructure/exploration-brief.adapter-parity.test.ts (parity import)
  import { parseExplorationBrief as legacy } from "../../../../../src/qa/exploration-brief.ts";
  ```
  The wrapper's impl comment must name the same path:
  ```ts
  // src/contexts/generation/infrastructure/exploration-brief.adapter.ts
  // WRAP of src/qa/exploration-brief.ts schema fns (parseExplorationBrief/coerceExplorationBrief/
  // renderExplorationBrief) — pure, thin delegators. Parity test pins the round-trip to the legacy fn.
  ```
- [ ] Add both parity files to the qa-engine typecheck exclude list.
- [ ] Run the generation infrastructure test set + isolated gate:
  ```bash
  node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/generation/infrastructure/{context-assembler,exploration-brief}.adapter*.test.ts"
  npx tsc --noEmit -p qa-engine/tsconfig.json
  ```
  Expected: all pass; typecheck 0.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/generation/infrastructure/{context-assembler,exploration-brief}.adapter.ts \
          qa-engine/test/contexts/generation/infrastructure/ qa-engine/tsconfig.json
  git commit -m "feat(generation): context-assembler + exploration-brief wrappers with parity"
  ```

## Task A.16 — Phase A completion gate (qa-engine isolated)

> The boundary marker. Phase A is done when the qa-engine isolated gate is fully green and nothing under
> `src/` was touched. This is NOT a code task — it is the explicit hand-off to the catalog-green checkpoint.

- [ ] Confirm zero `src/` modifications across all of Phase A (the user's WIP is untouched, no Phase-B leak):
  ```bash
  git status --short | rg "^.M src/|^ M src/" || echo "no src/ modifications in Phase A (correct)"
  git log --oneline -16 --name-only | rg "^src/" || echo "no src/ files in the last 16 commits (correct)"
  ```
  Expected: no `src/` files. (Any `src/` change in Phase A is a discipline failure — back it out.)
- [ ] Run the full qa-engine isolated gate:
  ```bash
  npx tsc --noEmit -p qa-engine/tsconfig.json
  node --import ./test-setup.mjs --import tsx --test \
    "qa-engine/test/contexts/{agent-runtime,generation}/**/*.test.ts" \
    "qa-engine/test/shared-kernel/ports/agent-runtime.port.test.ts" 2>&1 | tail -5
  ```
  Expected: typecheck 0; agent-runtime + generation test summary shows `0` failures.
- [ ] **STOP. Phase A complete.** Do NOT start Phase B until Task B.0 (the catalog-green checkpoint) passes.

---

# PHASE B — gated behind the catalog-green checkpoint

> **Phase B is BLOCKED until the catalog-green checkpoint (Task B.0) passes.** The checkpoint is the user
> adding `deepseek-v4-pro` to `MODEL_WINDOW_TOKENS` in `src/integrations/model-window-catalog.ts` so the 2
> seam-d pinning tests go green and the root `npm test` is clean. Phase B contains: the
> `roleWindowBytes`/`PromptBudgetPort` wrapping (B.1), the `GenerateTestsUseCase` characterization-test
> extraction (B.2–B.3), and the ONE `src/` touch — the `prompts.ts:19` Seam-2 re-root (B.4).

## Task B.0 — Catalog-green checkpoint (the LITERAL Phase B entry gate)

> The executor runs this gate BEFORE any other Phase B task. It is a hard gate, not advisory.

- [ ] Confirm `deepseek-v4-pro` is now in the catalog (the user's one-line change landed):
  ```bash
  cd /Users/arielyumn/Desktop/TRABAJO/panchito
  rg -n "deepseek-v4-pro" src/integrations/model-window-catalog.ts
  ```
  **GATE:** if there is NO match → STOP. Phase B is blocked. Report: "Phase B blocked — the catalog-green
  checkpoint is not met: `deepseek-v4-pro` is absent from `MODEL_WINDOW_TOKENS`. The user must add it (one
  line) before the budget wrap, the use-case extraction, and the `prompts.ts:19` re-root can land on a
  trustworthy gate." Do NOT add the catalog entry yourself — it is the user's deliberate WIP.
- [ ] Confirm the 2 seam-d pinning tests are now GREEN and the root suite is clean:
  ```bash
  node --import tsx --test src/integrations/model-window-catalog.test.ts 2>&1 | rg -E "^# (tests|pass|fail)"
  npm test 2>&1 | rg -E "^# (tests|pass|fail)|^not ok" | tail -20
  ```
  **GATE:** root `npm test` must report `0` failures. If it does not → STOP, report the failing tests, do not
  proceed. A red global baseline makes the `prompts.ts:19` cleanliness proof (Task B.4) meaningless.
- [ ] Record the checkpoint as met. Phase B is unblocked.

## Task B.1 — `PromptBudgetAdapter` (WRAP `roleWindowBytes`, catalog-green)

> Implements `PromptBudgetPort` by delegating to `roleWindowBytes` (the per-role byte budget that drives the
> ContextAssembler's shedding) and the `capDiff`/`capText` cappers. **The adapter NEVER hardcodes 192k/96k
> or any budget threshold** — those are exactly what the catalog change moves. The test asserts ONLY that
> the injected `roleWindowBytes` was called with the role and its result forwarded (delegation), never a
> specific byte count.

**Files:** `qa-engine/src/contexts/generation/application/ports/index.ts` (REQUIRED port edit — see step 1),
`qa-engine/src/contexts/generation/infrastructure/prompt-budget.adapter.ts`,
`test/contexts/generation/infrastructure/prompt-budget.adapter.test.ts`

- [ ] **REQUIRED port edit FIRST (not conditional).** Verified at HEAD: the Plan-2 `PromptBudgetPort`
  declares ONLY `capDiff(diff)` + `capText(text)` — it has **no** `budgetForRole`. The adapter below
  implements `budgetForRole`, so the port MUST gain it before the adapter compiles. Add it, typecheck, and
  commit it as a port-stub edit (same structure as Tasks A.1-A.4) BEFORE writing the failing adapter test:
  ```ts
  // qa-engine/src/contexts/generation/application/ports/index.ts (add to PromptBudgetPort)
  // budgetForRole resolves the per-role byte budget (model → window → bytes) from the catalog; the adapter
  // FORWARDS roleWindowBytes(role) — the port carries no threshold, the catalog owns it.
  export interface PromptBudgetPort {
    capDiff(diff: string): string;
    capText(text: string): string;
    budgetForRole(role: string): number;
  }
  ```
  ```bash
  npx tsc --noEmit -p qa-engine/tsconfig.json   # → 0 (the stub typechecks before any adapter exists)
  git add qa-engine/src/contexts/generation/application/ports/index.ts
  git commit -m "feat(generation): add budgetForRole to PromptBudgetPort (catalog-owned byte budget)"
  ```
- [ ] Write the failing delegation test (inject a fake `roleWindowBytes` returning a SENTINEL, not a real budget):
  ```ts
  // test/contexts/generation/infrastructure/prompt-budget.adapter.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { PromptBudgetAdapter } from "@contexts/generation/infrastructure/prompt-budget.adapter.ts";

  test("budgetForRole delegates to roleWindowBytes with the role (NO hardcoded byte count asserted)", () => {
    let seenRole = "";
    const SENTINEL = 123_456; // an arbitrary marker — proves forwarding, NOT a real model budget
    const adapter = new PromptBudgetAdapter(
      (role) => { seenRole = role; return SENTINEL; },
      (diff) => diff.slice(0, 10),
      (text) => text.slice(0, 10),
    );
    const bytes = adapter.budgetForRole("qa-generator");
    assert.equal(seenRole, "qa-generator");   // DELEGATION: the role was forwarded
    assert.equal(bytes, SENTINEL);             // the result was forwarded verbatim — no 192k/96k literal
  });

  test("capDiff/capText delegate to the injected cappers", () => {
    const adapter = new PromptBudgetAdapter(() => 0, (d) => `D:${d}`, (t) => `T:${t}`);
    assert.equal(adapter.capDiff("x"), "D:x");
    assert.equal(adapter.capText("y"), "T:y");
  });
  ```
  > **HARD RULE.** No `192_000`, `96_000`, `192k`, `96k`, `64_000`, `32_000`, or any `roleWindowBytes`-derived
  > number appears as an expected literal anywhere in this adapter or its test. The catalog owns those; the
  > adapter only forwards. A delegation-only assertion is gutted-impl-proof: a wrapper that returned a
  > hardcoded budget would FAIL the SENTINEL forwarding test.
- [ ] Run it, see it fail.
- [ ] Minimal impl (delegate to the three injected fns):
  ```ts
  // src/contexts/generation/infrastructure/prompt-budget.adapter.ts
  // WRAP of src/integrations/model-window-catalog.ts roleWindowBytes + the capDiff/capText cappers behind
  // PromptBudgetPort. The per-role byte budget is OWNED by the catalog (model → window → bytes); this
  // adapter FORWARDS it. It NEVER hardcodes a budget threshold — the value is whatever roleWindowBytes
  // returns for the role given the current catalog. Inherits the user's catalog fix via delegation.
  import type { PromptBudgetPort } from "../application/ports/index.ts";
  type RoleWindowBytes = (role: string) => number;
  type Cap = (s: string) => string;
  export class PromptBudgetAdapter implements PromptBudgetPort {
    constructor(private readonly roleWindowBytes: RoleWindowBytes, private readonly _capDiff: Cap, private readonly _capText: Cap) {}
    budgetForRole(role: string): number { return this.roleWindowBytes(role); }
    capDiff(diff: string): string { return this._capDiff(diff); }
    capText(text: string): string { return this._capText(text); }
  }
  ```
  > `budgetForRole` was added to `PromptBudgetPort` in this task's REQUIRED port edit (step 1) — the adapter
  > now compiles against it. Do NOT also assert any catalog-derived byte count; assert SENTINEL forwarding only.
- [ ] Run it, see it pass.
- [ ] Run the isolated gate AND the root gate (catalog-green, so root is clean):
  ```bash
  node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/generation/infrastructure/prompt-budget.adapter.test.ts"
  npx tsc --noEmit -p qa-engine/tsconfig.json
  npm test 2>&1 | rg -E "^# (tests|pass|fail)" | tail -3
  ```
  Expected: all pass; typecheck 0; root suite `0` failures.
- [ ] Commit (the `budgetForRole` port edit already landed in step 1 — stage ONLY the adapter + its test):
  ```bash
  git add qa-engine/src/contexts/generation/infrastructure/prompt-budget.adapter.ts \
          qa-engine/test/contexts/generation/infrastructure/prompt-budget.adapter.test.ts
  git commit -m "feat(generation): PromptBudgetAdapter wrapping roleWindowBytes (delegation-only, no budget literals)"
  ```

## Task B.2 — `GenerateTestsUseCase` characterization tests (write BEFORE extraction)

> **PORT, not WRAP.** The deterministic logic in `opencode-client.ts` (the generate→review→reconcile
> orchestration: `:759-797` plan/fan-out, `:1221-1483` manifest reconcile + spec-on-disk verification) is
> pulled OUT into a `GenerateTestsUseCase`. Per the design (§7.2 Step 8) this logic is covered with
> **characterization tests BEFORE extraction** so the move is provably behavior-preserving. This task writes
> those characterization tests against the CURRENT `opencode-client.ts` behavior (the golden); Task B.3
> extracts the use-case and proves it produces the identical outcome.

**Files:** `test/contexts/generation/application/generate-tests.characterization.test.ts`

- [ ] Identify the orphan/relocatable tests first (design §7.2 Step 8 pre-extraction exploration):
  ```bash
  rg -ln "runOpencode|generateParallel|reconcile|parsePlan" src/integrations/*.test.ts
  ```
  Note which `src/integrations/*.test.ts` cover logic moving to `generation/` — they will be re-homed in
  Task B.3. Do NOT move them yet; record them.
- [ ] Write characterization tests that pin the CURRENT generate→reconcile behavior through the injected
  `AgentDeps` seam (no real agent). Reuse EXISTING fixtures — author no new scenarios. Assert the OUTCOME
  tuple (specs written, manifest entries reconciled, review approved/blockingCount, fail-closed on parse
  miss), not internal structure:
  ```ts
  // test/contexts/generation/application/generate-tests.characterization.test.ts
  // CHARACTERIZATION: pins the CURRENT opencode-client generate→review→reconcile outcome BEFORE the
  // GenerateTestsUseCase extraction (design §7.2 Step 8). Drives runOpencode/generateParallel through a
  // stub AgentDeps; asserts the (specs, manifest, review) outcome. Reuses existing fixtures. Imports from
  // src/ → excluded from qa-engine typecheck; runs via tsx. This is the golden the extracted use-case must match.
  // ... replay a representative set of existing scenarios through the legacy entrypoints; snapshot the outcome ...
  ```
- [ ] Add the characterization file to the qa-engine typecheck exclude list (it imports from `src/`).
- [ ] Run it green against the CURRENT code (it characterizes existing behavior — must pass now):
  ```bash
  node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/generation/application/generate-tests.characterization.test.ts"
  ```
  Expected: pass (it pins what exists). If it fails, the characterization is WRONG — fix it to match reality
  before extracting; never change `src/` to make a characterization pass.
- [ ] Commit:
  ```bash
  git add qa-engine/test/contexts/generation/application/generate-tests.characterization.test.ts qa-engine/tsconfig.json
  git commit -m "test(generation): characterization tests pinning the generate→reconcile outcome before extraction"
  ```

## Task B.3 — `GenerateTestsUseCase` extraction (PORT the deterministic orchestration)

> Extract the deterministic generate→review→reconcile orchestration into `GenerateTestsUseCase`, driven
> ENTIRELY through the Phase-A ports (`AgentRuntimePort`, `PromptRenderingPort`, `VerdictParserPort`,
> `PlanParserPort`, `ManifestRepositoryPort`, `PromptBudgetPort`, `DomGroundingPort`). No inline IO. The
> characterization tests (B.2) are the oracle: the use-case must produce the identical outcome.

**Files:** `qa-engine/src/contexts/generation/application/generate-tests.use-case.ts`,
`test/contexts/generation/application/generate-tests.use-case.test.ts`

- [ ] Write the failing use-case unit test (inject port stubs; assert the orchestration sequence + outcome):
  ```ts
  // test/contexts/generation/application/generate-tests.use-case.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { GenerateTestsUseCase } from "@contexts/generation/application/generate-tests.use-case.ts";

  test("plans → renders → opens session → parses deliverable → reconciles manifest (orchestration only)", async () => {
    const calls: string[] = [];
    const useCase = new GenerateTestsUseCase({
      runtime: { openSession: async () => { calls.push("session"); return { prompt: async () => ({ output: "JSON" }), dispose: () => {} }; } },
      rendering: { renderWorker: () => { calls.push("render"); return { text: "P", sectionSizes: {} }; } } as never,
      verdicts: { parseGenerator: () => { calls.push("parse"); return { specs: ["e2e/a.spec.ts"] }; }, parseReview: () => ({ approved: true, corrections: [], valid: true, issues: [] }) } as never,
      manifest: { read: async () => [], reconcile: async (_d, e) => { calls.push("reconcile"); return [...e]; } } as never,
      // ... plan/budget/grounding stubs ...
    } as never);
    const out = await useCase.generate(/* a fixture OpencodeRunInput */ {} as never);
    assert.deepEqual(calls, ["render", "session", "parse", "reconcile"]); // the deterministic sequence
    assert.deepEqual(out.specs, ["e2e/a.spec.ts"]);
  });

  test("a reviewer contract miss (valid:false) fires exactly ONE bounded repair re-prompt, then proceeds", async () => {
    const prompts: string[] = [];
    let reviewCalls = 0;
    const useCase = new GenerateTestsUseCase({
      runtime: { openSession: async () => ({ prompt: async (t: string) => { prompts.push(t); return { output: "JSON" }; }, dispose: () => {} }) },
      rendering: { renderWorker: () => ({ text: "P", sectionSizes: {} }) } as never,
      verdicts: {
        parseGenerator: () => ({ specs: ["e2e/a.spec.ts"] }),
        // first parse is a contract MISS (valid:false), second is clean — the use-case must re-prompt ONCE.
        parseReview: () => (++reviewCalls === 1
          ? { approved: false, corrections: [], valid: false, issues: ["bad reviewer json"] }
          : { approved: true, corrections: [], valid: true, issues: [] }),
      } as never,
      manifest: { read: async () => [], reconcile: async (_d, e: unknown[]) => [...e] } as never,
      repair: { instruction: (kind: string, issues: string[]) => `REPAIR ${kind}: ${issues.join(";")}` }, // injected, not reimplemented
      // ... plan/budget/grounding stubs ...
    } as never);
    await useCase.generate({} as never);
    // EXACTLY ONE repair re-prompt — a use-case that dropped valid/issues would never fire it (regression),
    // one that looped unbounded would fire more than one. The repair text comes from the injected instruction.
    assert.equal(prompts.filter((p) => p.startsWith("REPAIR reviewer")).length, 1);
  });
  ```
  > **NEVER hardcode a budget or a priority number in the use-case or its test.** Budget comes from the
  > injected `PromptBudgetPort`; priorities are inside the (wrapped) builders. Assert orchestration sequence
  > + outcome — a gutted use-case that skipped reconcile or the review gate FAILS.
- [ ] Run it, see it fail.
- [ ] Minimal impl — port the deterministic orchestration body from `opencode-client.ts` into the use-case,
  calling the injected ports in the same order. NO Playwright/SDK/git inline. Preserve: the fail-closed
  review gate, the blocking-vs-advisory `blockingCount` decision, **the bounded contract-repair re-prompt**
  (when `parseReview(...).valid === false`, fire exactly ONE re-prompt with the reviewer repair instruction
  built from `.issues` — `opencode-client.ts:979-983`; `valid`/`issues` arrive on `ReviewJudgment` via the
  Task A.3 port edit, so the use-case can read `r.valid`/`r.issues` directly), the spec-on-disk verification
  before trusting a parsed spec name (the legacy "a parsed name is a CLAIM, not proof" guard), and the
  manifest reconcile invariant.
  > The same bounded-repair pattern exists on the GENERATOR side (`checkGeneratorVerdict(...).valid` →
  > `repairInstruction("generator", issues)`, `opencode-client.ts:731-736`). Preserve both — one bounded
  > re-prompt per side, never an unbounded loop. The repair instruction string is owned by the legacy
  > `repairInstruction` (injected, do NOT reimplement it).
  ```ts
  // src/contexts/generation/application/generate-tests.use-case.ts
  // PORT of the deterministic generate→review→reconcile orchestration from src/integrations/opencode-client.ts
  // (:759-797 plan/fan-out, :1221-1483 reconcile + on-disk verification). Driven ENTIRELY through ports —
  // no inline IO. The review gate is FAIL-CLOSED (unparseable verdict ⇒ not approved); blockingCount gates
  // blocking-vs-advisory; a parsed spec NAME is verified on disk before trust. Characterized BEFORE this
  // extraction (Task B.2) — the use-case must match that golden outcome.
  // ... GenerateTestsUseCase { constructor(private ports: GenerationPorts) {} async generate(input) { ... } }
  ```
- [ ] Run it, see it pass.
- [ ] Re-home the orphan tests identified in B.2 into `qa-engine/test/contexts/generation/` (move, adjust
  imports to the use-case + ports). Run them green.
- [ ] Run the characterization + use-case + isolated gate + root gate:
  ```bash
  node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/generation/application/**/*.test.ts"
  npx tsc --noEmit -p qa-engine/tsconfig.json
  npm test 2>&1 | rg -E "^# (tests|pass|fail)" | tail -3
  ```
  Expected: characterization + use-case pass identically; typecheck 0; root suite `0` failures.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/generation/application/generate-tests.use-case.ts \
          qa-engine/test/contexts/generation/
  git commit -m "feat(generation): extract GenerateTestsUseCase (characterized; ports-only orchestration)"
  ```

## Task B.4 — Seam-2 (src/ half): re-root `prompts.ts:19` onto `generation-ports.ts` (THE ONE src/ TOUCH)

> **The single `src/` modification in this entire plan.** Types-only, no behavior change. `prompts.ts:19`
> currently imports `OpencodeRunInput`/`ParallelWorkerInput`/`ReviewInput` from `./opencode-client` as
> `import type`. Re-root that import onto the qa-engine `generation-ports.ts` (Task A.10), so the
> `opencode-client ⇄ prompts` type-only cycle dissolves. `opencode-client.ts` keeps its definitions as
> re-export ALIASES of the canonical types so its 10+ external callers compile unchanged.
>
> **GATE:** this lands ONLY on a green global gate (Task B.0 confirmed root `npm test` is clean). The proof
> of the cycle break is "the green suite stayed green after the re-root."
>
> **COMMIT DISCIPLINE:** stage `src/integrations/prompts.ts` (and `src/integrations/opencode-client.ts` IF
> the alias re-export is needed) EXPLICITLY. NEVER `git add -A`. Confirm the user's WIP files
> (`src/qa/dom-snapshot.ts`, `context-pack.ts`, `changed-elements.ts`, the mirrors) are NOT staged.

**Files:** `src/integrations/prompts.ts` (line 19 import), possibly `src/integrations/opencode-client.ts`
(alias re-export of the canonical types).

- [ ] Re-confirm `prompts.ts` is still NOT in the user's WIP set (do this immediately before editing):
  ```bash
  git status --short | rg "prompts.ts|opencode-client.ts" || echo "prompts.ts / opencode-client.ts clean — safe to touch"
  ```
  **GATE:** if `prompts.ts` is now in the WIP set → STOP. Report the collision; do not edit a file the user
  has uncommitted changes in. Coordinate before proceeding.
- [ ] Decide the canonical-source direction. Two equivalent shapes — choose the one that compiles with the
  fewest touches (prefer A; it touches only `prompts.ts`):
  - **A (preferred):** `opencode-client.ts` keeps the type DEFINITIONS; `generation-ports.ts` re-exports
    them. Then `prompts.ts:19` imports from `generation-ports.ts`. But this keeps the value-cycle direction
    (`prompts` → `generation-ports` → … ) — verify it actually breaks the cycle; if `generation-ports`
    importing from `opencode-client` recreates it, use B.
  - **B (canonical in qa-engine):** `generation-ports.ts` holds the DEFINITIONS (Task A.10 already did this);
    `opencode-client.ts` re-exports them as ALIASES (`export type { OpencodeRunInput } from "<generation-ports>"`);
    `prompts.ts:19` imports from `generation-ports.ts`. This fully dissolves the cycle (prompts no longer
    depends on opencode-client for types). **B is the design's intent (§7.2 Step 4b) — use B unless the
    cross-tree import path is unavailable from `src/`.**
  > NOTE on cross-tree import: `src/` importing a `qa-engine/` type requires the path to resolve. If the
  > root `tsconfig.json` project-references qa-engine (it does — `references: [{ path: "./qa-engine" }]`),
  > a type-only import resolves. If it does NOT resolve cleanly from `src/`, fall back to A and document why.
- [ ] Make the EXACT one-line edit in `prompts.ts:19` (and the alias re-export in `opencode-client.ts` if B):
  ```ts
  // src/integrations/prompts.ts:19 — re-rooted onto the cycle-free canonical module (Seam-2, design §7.2 Step 4b)
  import type { OpencodeRunInput, ParallelWorkerInput, ReviewInput } from "<path to generation-ports.ts>";
  ```
- [ ] Prove the cycle break + no behavior change with the FULL global gate (this is the whole point):
  ```bash
  npm run typecheck
  npm test 2>&1 | rg -E "^# (tests|pass|fail)|^not ok" | tail -20
  ```
  **GATE:** typecheck passes AND root `npm test` reports `0` failures. If anything goes red, the re-root
  broke something — revert `prompts.ts` and re-investigate; do NOT paper over a red with a workaround.
- [ ] Confirm ONLY the intended `src/` files are staged (protect the user's WIP):
  ```bash
  git status --short | rg "^M |^ M " | rg "src/"
  ```
  Expected: only `src/integrations/prompts.ts` (and `src/integrations/opencode-client.ts` if B). The user's
  `src/qa/*` WIP must NOT appear in the staged set.
- [ ] Commit (explicit paths, no `-A`, no AI-attribution trailer):
  ```bash
  git add src/integrations/prompts.ts
  # if shape B was used and an alias re-export was added:
  # git add src/integrations/opencode-client.ts
  git commit -m "refactor(generation): re-root prompts.ts onto generation-ports (Seam-2 cycle break, types-only)"
  ```

## Task B.5 — Phase B completion gate (global green)

> Final marker. Phase B is done when the full global gate is green and the Seam-2 cycle is provably broken.

- [ ] Run the full global gate one last time:
  ```bash
  npm run typecheck
  npm test 2>&1 | rg -E "^# (tests|pass|fail)" | tail -3
  ```
  Expected: typecheck passes; root suite `0` failures.
- [ ] Confirm exactly ONE `src/` file changed across all of Phase B (the `prompts.ts` re-root; `opencode-client.ts`
  only if shape B's alias was needed):
  ```bash
  git log --oneline -6 --name-only | rg "^src/" | sort -u
  ```
  Expected: at most `src/integrations/prompts.ts` (+ `src/integrations/opencode-client.ts` if B). NOTHING
  under `src/qa/`, `src/agent-runtime/`, or `agents/`.
- [ ] Confirm the cycle is gone:
  ```bash
  rg -n "from \"./opencode-client\"" src/integrations/prompts.ts | rg "OpencodeRunInput|ReviewInput|ParallelWorkerInput" || echo "prompts.ts no longer imports the input TYPES from opencode-client — Seam-2 broken"
  ```
  Expected: the "Seam-2 broken" message.
- [ ] **Plan 5 complete.** Both contexts (`agent-runtime`, `generation`) are wrapped behind ports; the
  Seam-2 type cycle is broken; the security boundary, provider-agnostic runtime, and keystone are intact.

---

## Hard rules (apply to EVERY task)

- **WRAP means DELEGATE.** Every adapter forwards to an injected legacy fn. Parity/delegation tests prove
  the adapter forwards correctly (a gutted impl that ignores the injected fn FAILS) — they NEVER assert
  legacy correctness. Only `codexErrorToInfra` is PORT (copy+parity).
- **NEVER hardcode a priority number (`priority: 2`) or a budget threshold (`192k`/`96k`/`192_000`/`96_000`/
  `64_000`/`32_000`) in any adapter or test.** Those are exactly what's in flux (the user's catalog + prompt
  edits). Priorities live inside the wrapped builders; budgets come from the injected `roleWindowBytes`.
  Assert DELEGATION only — forward a SENTINEL and check it round-trips.
- **Security boundary.** Nothing in `generation/*` or `agent-runtime/*` imports, re-exports, or constructs
  `VcsWritePort` or any write capability. The agent stays read-only. (Plan-4 arch-lint enforces this — do
  not give it a reason to fire.)
- **Provider-agnostic.** No adapter collapses `opencode`/`codex` or `single`/`dual`. The two strategy
  adapters share no mutable state (the per-provider isolation test guards it).
- **Keystone untouched.** Plan 5 adds no quality gate and no LLM proxy. It relocates the existing generation
  surface behind ports; the deterministic signal stays outside the agent.
- **Commit discipline.** Stage explicit `qa-engine/` paths only (Phase A) or the single `prompts.ts` line
  (Phase B). NEVER `git add -A`, NEVER stage `src/` in Phase A, NEVER stage the user's `src/qa/*` WIP. NO
  `Co-Authored-By` / NO AI-attribution trailer. One logical change per commit; conventional messages.
- **Phase gate.** Phase A gates on the qa-engine isolated typecheck + qa-engine test glob (immune to the
  user's catalog false-red). Phase B gates on the catalog-green checkpoint (Task B.0) + the full global gate.
  Do NOT run Phase B work on a red baseline.
