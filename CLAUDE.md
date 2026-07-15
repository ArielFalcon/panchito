# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`panchito` is an **app-agnostic, centralized AI-assisted E2E QA engine** (a
template — no app is bundled). It watches a team's repos; when a commit is
deployed to DEV, an AI agent (OpenCode and/or Codex) generates Playwright E2E tests for the
change's blast radius, runs them **against the live DEV site** (the app is never
built or started here), and — when green and reviewer-approved — commits the
tests into the app repo's `e2e/` folder via a **PR with auto-merge**. Failures
open a GitHub Issue. The suite lives in git and improves itself run after run.

**Priority order, above features: stable, reliable, deterministic.** The hardest
problem is not engineering but *trust* — see [The value/trust risk](#the-valuetrust-risk-read-before-adding-quality-logic).

## Commands

No build step — the service runs TypeScript directly via `tsx`.

```bash
npm install                 # required once (root has no node_modules until you do)
npm test                    # node:test via tsx; 900+ tests, network/OpenCode/Codex/Playwright stubbed
npm run typecheck           # tsc --noEmit (strict, noUncheckedIndexedAccess)

# Run a single test file or filter by name:
node --import tsx --test src/server/webhook-routing.test.ts
node --import tsx --test --test-name-pattern="skip" src/server/webhook-routing.test.ts

# Trigger one run manually (runs the SAME pipeline as the webhook). --mode defaults
# to "diff"; complete/exhaustive scan the whole repo, manual is guidance-driven:
npm run qa -- --app portfolio --sha <commit-sha>
npm run qa -- --app portfolio --sha <sha> --mode exhaustive
npm run qa -- --app portfolio --sha <sha> --mode manual --guidance "test the contact form"

npm run start               # the long-lived webhook + queue service (src/index.ts)
```

`npm test` and `npm run typecheck` must stay green — treat them as the gate for
any change to `src/`.

### Docker / full smoke

```bash
doppler run -- docker compose up --build      # prod: Doppler injects secrets
# or: cp .env.example .env  (fill OPENCODE_API_KEY) then `docker compose up --build`

# Once "listening for webhooks on :8080", trigger a run:
SHA=$(git ls-remote https://github.com/ArielFalcon/portfolio main | cut -f1)
curl -X POST localhost:8080 -H 'content-type: application/json' \
  -d "{\"repo\":\"ArielFalcon/portfolio\",\"sha\":\"$SHA\"}"
docker compose logs -f orchestrator
```

First boot is slow (Serena installs via `uvx`). For a shadow run only
`OPENCODE_API_KEY` is needed.

## Architecture

**Two long-lived services** (`docker-compose.yml`) sharing the `mirrors` volume
(the repo working copies; the agent's session `cwd` is a path valid in both):

| Service | What it is | Lives in |
|---|---|---|
| `orchestrator` | **Deterministic infrastructure** — webhook, sequential queue, deploy gate, working copy, harness (validate + execute), publish/report. Node/TS via `tsx`. | this repo, `src/` |
| `agents` | **The agentic engine** — a supervisor fronting both runtimes (OpenCode via `opencode serve`; Codex via `codex exec`) + MCPs (Serena for code nav; engram for memory). Writes `.spec.ts` files into the working copy. | `agents/` |

The **fundamental split**: deterministic infra (`src/`) is kept rigorously
separate from the non-deterministic agent (`agents/`). `src/integrations/
opencode-client.ts` is the shell-resident I/O closure that talks to `opencode
serve` over HTTP — but as of `migration-tier-4c` it is deliberately THIN: only
the genuinely-raw `@opencode-ai/sdk` primitives (client construction,
`session.create/prompt/abort/delete`, `event.subscribe`) plus a few permanent
D1-family control-plane wrappers (`askAssistant`, `getOpenSessions`/
`getOpenSessionCount`) stay here. Everything with domain/policy content —
session-transport policy (fallback-model retry, circuit-breaker gating,
turn/usage telemetry), the resilience primitives (`circuit-breaker.ts`,
`stall-watchdog.ts`), the SSE/`EventStreamManager` lifecycle, and the prompt
builders (`prompts.ts` and its riders) — lives in
`qa-engine/src/contexts/generation/infrastructure/`, consuming the shell's
raw primitives via injection (see
`docs/superpowers/2026-07-14-migration-tier-4c-decisions.md`).

**The permanent boundary rule** (settled by `migration-tier-4d`, the finale of
the `src/` → `qa-engine/` migration program that ran from `migration-remediation`
through `migration-tier-4d`): `qa-engine/src` never imports from `src/` —
`.dependency-cruiser.cjs`'s `no-src-import` rule enforces this mechanically
(`npm run arch:check`), not just by convention. `src/` is the settled shell
around the engine, made of four DECLARED, permanent roles — none of these is
migration debt waiting for a future slice:
  - **Composition root** — `src/server/rewritten-engine-factory.ts` maps each
    app's `AppConfig` into a qa-engine `CompositionConfig`. `AppConfig`-shaped
    config loading is irreducibly host-specific; this is NOT "zero policy" —
    its injected `historyLearningStore.recordOutcome` is a genuine off-path
    learning fold qa-engine's own `LearningRepositoryPort` expects to live
    shell-side.
  - **Control plane** — `src/server/*` (webhook, queue, TUI/API surface,
    `agent-runtime.ts`'s provider-config operator path) and `client/*`.
  - **Provider I/O edges** — `src/integrations/opencode-client.ts` (the raw
    `@opencode-ai/sdk` closure) and `src/agent-runtime/*` (the provider-agnostic
    facade + OpenCode/Codex runtime strategies) — genuinely raw SDK/process
    primitives, D1-family by declaration.
  - **Persistence** — `src/server/run-history-sqlite-adapter.ts` (bridges the
    kernel `RunOutcome` into `history.ts`'s SQLite store) and `history.ts`'s own
    learning CRUD (a deliberate two-store duality alongside qa-engine's
    `SqliteLearningRepository`, not silent drift).

`qa-engine/test/contract/seam-parity.contract.test.ts`'s (d)/(e) blocks are the
permanent boundary-contract tests pinning the persistence and composition-root
seams. See `docs/superpowers/2026-07-15-migration-tier-4d-decisions.md` for the
full declared end state and the program's closing summary.

### The run flow — start here

`qa-engine/src/contexts/qa-run-orchestration/application/run-qa.use-case.ts`
(`RunQaUseCase`) is the whole orchestration; read it first. It is the **only**
engine — one `RunQaUseCase.run()` serves both triggers (webhook `src/index.ts`,
manual `src/cli.ts`) via `src/server/runner.ts`'s single funnel
(`enqueueTrackedRun`), which drives it through the injected `RunnerDeps.engineFactory`
(the real one is `src/server/rewritten-engine-factory.ts`, mapping `AppConfig` into
a qa-engine `CompositionConfig`). Default `diff` mode shown:

1. **Gate** — wait until DEV serves this SHA and is healthy (`/version`).
   Skipped entirely when `dev.versionUrl` is absent (already-deployed/static sites).
2. **Working copy + classify** — clone/checkout the SHA; extract diff + message;
   `classifyCommit` (Conventional Commits, **cross-checked against the diff** — a
   `refactor`/`style` whose diff adds net logic escalates to `generate`).
   `skip` → returns `skipped` without spending a token.
3. **Setup** — bootstrap the `config/e2e/` seed into the repo's `e2e/` if missing,
   then `npm ci`. Runs **before** generation so the agent has the fixtures/config.
4. **Generate** — agent session (OpenCode or Codex per the role assignment); the agent derives the objective from the
   commit intent, writes/improves specs + `e2e/.qa/manifest.json`, invokes the
   reviewer. **If the agent approves with zero specs → no-op → `skipped`** (clean).
5. **Validate (Filter B)** — static gate: `tsc` + ESLint (`eslint-plugin-playwright`)
   + `playwright --list` + manifest validity. Fail → `invalid`.
6. **Health pre-flight** — DEV down now → `infra-error` (not a code bug).
7. **Execute (Filter C)** — run with Playwright against DEV; classify
   `pass`/`fail`/`flaky` (a pass only after retry = flaky → quarantine).
8. **Change-coverage (the value keystone)** — measure whether the green run actually
   exercised the diff's changed lines (`qa-engine/src/contexts/objective-signal/domain/
   {assemble-change-coverage,decide-coverage.service}.ts`). `signal` records
   only; `enforce` regenerates once at the uncovered lines and, if still short of
   `minRatio`, holds the PR. `unknown` (no usable coverage / cross-repo) never blocks.
9. **Decide** — green + reviewer-approved (+ coverage not blocking) → PR w/ auto-merge.
   Green but reviewer rejected, or `fail`/`invalid` → Issue. Failure with DEV down →
   `infra-error`. `flaky` → quarantine. Green with no `e2e/` changes → nothing.

**Verdicts** (`src/types.ts` `RunVerdict`): `pass | fail | flaky | invalid | infra-error | skipped`.

**Shadow mode** (`qa.shadow: true` in app config) replaces every PR/Issue side
effect with a log line — used to onboard a repo without dirtying it.

**Cross-repo runs (microservices).** An e2e app may declare `services[]` in its
YAML. A webhook from a service repo (sent by its CI **after** deploy — deploy-event
semantics) triggers an e2e run of the app: diff/classify/gate come from the service
mirror at the event SHA, while the suite runs from the primary mirror at `baseBranch`
HEAD. Issues open in the triggering service repo; the suite PR always targets the
primary repo. Change-coverage is `unknown` for these runs (browser coverage cannot
map service-repo lines).

### Run modes (`RunOptions.mode`, CLI `--mode`, default `diff`)

- **diff** — the flow above: test the blast radius of one commit. The **only** mode
  that runs `classifyCommit` (skip/regression/generate); the others always generate.
  Execution is single-agent: the run-event schema carries an optional `workerId?`
  field reserved for a future multi-worker view, but nothing in qa-engine drives or
  consumes it today — there is no parallel fan-out. Re-generation passes
  (fix/review/coverage) are also single-agent.
- **complete** — analyze the whole repo + existing suite, persist a coverage/
  importance map to `e2e/.qa/analysis.json`, generate tests for important UNCOVERED flows.
- **exhaustive** — like complete, but re-evaluate every existing test and regenerate
  the suite, not just the delta.
- **manual** — generation focused by `--guidance`.

The mode-specific prompt is assembled by `buildTask` in `opencode-client.ts`.

### Test targets (`RunOptions.target`, CLI `--target`, default `e2e`)

Orthogonal to mode. `e2e` runs Playwright against DEV (the flow above). **`code`**
tests source-code logic with **no web environment and no Playwright**: the agent writes
tests in the repo's own framework, then the orchestrator installs the repo's deps and
runs its own test suite, classifying by **exit code** (binary pass/fail — no flaky, no
deploy gate, no static gate). Code-mode apps set `code: true` in their config and omit
the `dev:` block. The runner auto-detects the ecosystem (node/python/go/…) in
`qa-engine/src/contexts/test-execution/infrastructure/code-execution.runner.ts`
(migrated from the former `src/qa/code-runner.ts` in `migration-tier-4b`); the
orchestrator image ships Node, Python, Go, Rust, Maven and Gradle (see root
`Dockerfile`). Publish commits the new tests anywhere in the repo (`publishCode`),
not just `e2e/`.

### Dependency injection is the testing strategy

`RunQaUseCase` is driven entirely through hexagonal ports (`qa-engine/src/contexts/
qa-run-orchestration/application/ports/index.ts`); `CompositionConfig`
(`qa-engine/.../composition/composition-root.ts`) wires each port to a real bridge
adapter. The orchestration logic — ordering, branches, verdict decisions — is
unit-tested with fakes built directly against the ports. The **real integrations
are the deliberately-uncovered boundaries**: the agent-runtime call (OpenCode SDK /
Codex exec), the Playwright runner, git operations. Each integration module exports its own `*Deps` and a
`default*Deps` in the same pattern (`opencode-client`, `repo-mirror`, `validate`,
`execute`, `setup`, `publish`). Follow this pattern for any new side-effecting code.

### The agent (agents/) — three prompt layers

The runtime is **provider-agnostic** (`src/agent-runtime/`, `AgentProvider = "opencode" | "codex"`):
each role (primary / reviewer / chat) is assigned a provider + model, in `single` mode (one provider
for all roles) or `dual` mode (e.g. primary on one runtime, reviewer on the other — two different
runtimes guarantee independent judgment). The description below is the **OpenCode runtime's** roster;
Codex runs the same roles via `codex exec` with the provider-neutral prompts in `agent/`.

For the OpenCode runtime: generation, the reviewer subagent, and the MCP tools all live **inside**
OpenCode. Config in `agents/opencode.json`. Two **different models** guarantee independent judgment,
via a **single** OpenCode Go key (`OPENCODE_API_KEY`); models are named with the `opencode-go/`
prefix (no per-provider keys):

- `qa-generator` (primary, `deepseek-v4-pro`) — writes tests, can read/edit/bash.
- `qa-reviewer` (subagent, `qwen3.7-max`) — read-only quality judge, emits a JSON verdict.
- `qa-maintainer` (primary, `deepseek-v4-pro`) — self-repair of THIS repo: diagnoses
  incidents, opens a fix PR; never touches watched repos. Used by `triggerMaintainer`.
  The fix is **auto-deployed only when explicitly opted in** (`SELF_MAINTAINER_AUTOMERGE="true"`;
  off by default) through layered safety gates (`src/server/merge-guard.ts`) + a
  **canary-before-promote** hot-swap with boot-guard rollback, gated by a **required `ci` check
  on `main`** (the outer guard). See
  [docs/self-maintenance.md](docs/self-maintenance.md) before touching this path.
- `qa-assistant` (`deepseek-v4-flash`) — read-only run Q&A for the TUI chat; no tools,
  answers only from the provided run context. Used by `/api/runs/:id/ask`.

(The model ids are OpenCode-Go names that should be confirmed against `opencode models`.)

Prompts are layered: `agents/AGENTS.md` (shared rules + anti-degradation
protocols) → `agents/agent/*.md` (per-role procedure + JSON output contract) →
`agents/skill/` (on-demand craft: `playwright-authoring`, `test-value-review`).
Codex consumes the **provider-neutral** mirror of these under `agent/` (`agent/roles/*.md`,
`agent/skills/`), assembled into a role preamble by `withCodexRolePreamble`.

### Persistence & onboarding surface

- **Source of truth for the suite = git**, in the app repo's `e2e/` folder
  (versioned, reviewable, survives host loss). `config/e2e/` is the **seed** copied
  in on first run. engram memory (`engram-data` volume) is the only non-regenerable
  data; Serena index and working copies are regenerable caches.
- **Onboarding a watched app is `config/apps/<app>.yaml` + `.env` only.** Copy
  `config/apps/example.yaml`. `${VARS}` in the YAML expand from the environment.

## Invariants — do not break these

- **Root-cause & project-agnostic — never tailor a fix to a configured test
  app.** Every fix and feature targets the underlying cause and must hold for
  ANY watched project. The apps in `config/apps/*` (`portfolio`, `petclinic`,
  `jhipster-store`, `panchito`, …) are *interchangeable test targets, not design
  inputs* — never shape a code path "so app X passes"; reproduce on one,
  diagnose the root, generalize the solution. The ONLY legitimate
  project-shaped constraint is **declared, deliberate scope** (e.g.
  structural-signal analysis covers Java + JavaScript/TypeScript by design
  *for now*, widened later) — and even that lives in `config/` / the language
  registry, never as an app-specific branch in `src/` (the next invariant). When
  a detected "bug" might be a deliberate guard from a past fix, confirm your
  change improves the root cause without regressing that guard before making it.
- **Security boundary:** the LLM agent is **read-only** on watched repos. Only the
  deterministic orchestrator does git writes (push/PR). Never give the agent (or
  any future chat/operator layer) direct write to a watched repo.
- **App-specificity lives only in `config/`; agents/models only in `agents/`;
  nothing app-specific in `src/`.**
- **Sequential queue** — one run at a time; never run concurrent QA against DEV.
- **Honor the agent's no-op decision** — approved + zero specs is a *valid*
  `skipped`, never `invalid`.
- **Surface integration errors loudly** — never swallow agent-runtime (OpenCode SDK /
  Codex exec) / runner / git errors into an empty result (a swallowed error once
  looked like "no tests written"). Throw and log.
- **Sanitize data leaving the system** — execution logs/audit trails → Issue pass
  through `src/orchestrator/sanitizer.ts`'s `RedactionPortAdapter` (shell-side,
  wired unconditionally in `rewritten-engine-factory.ts`). Diff/commit-body →
  model prompts pass through `qa-engine/src/contexts/generation/infrastructure/
  sanitize-text.ts` instead — a qa-engine-native twin (same redaction patterns,
  ported so prompt assembly never imports `src/`), not the same file.
- Everything in **English**; comments describe the final state, not the process.

## Conventions & gotchas

- **No build step.** `tsx` runs TS at runtime and is a devDependency — install ALL
  deps in Docker (not `--omit=dev`).
- **Pin exact versions on the execution path.** Playwright is pinned to `1.50.0`
  to match the browsers in the `playwright:v1.50.0` base image; a floating `^`
  breaks execution. Don't loosen it.
- **`.env` comments go on their own line.** `docker compose` `env_file` does NOT
  strip an inline `# comment` — it becomes part of the value (this once made an
  empty `WEBHOOK_SECRET` non-empty → 401s).
- Secrets are injected at runtime by **Doppler**; nothing is committed. `.env` is
  for local-without-Doppler only.
- Tests use `node:test` + `node:assert/strict`, colocated as `*.test.ts`.
- **OpenAPI is authoring context, agent-resolved.** When a watched app exposes
  backend OpenAPI specs, the **agent** locates and reads them (Serena/glob) to write
  contract-aware assertions; the orchestrator never parses them. An optional
  `openapi:` glob hint in `config/apps/<app>.yaml` says where to look. The agent
  exercises the backend **through the UI**, never by calling the API directly.
- **Long agent turns vs. undici.** A `session.prompt` is one long-held HTTP request
  (no response until the agent finishes). `defaultOpencodeDeps` raises undici's
  global `headersTimeout`/`bodyTimeout` above `OPENCODE_TIMEOUT_MS` so the
  `withTimeout` wrapper is the real deadline, not a transport-level abort.
- **Serena needs a language server per watched-repo language.** The `agents` image
  bakes in JDK (Java/Spring), python3, and the TypeScript LS (Angular); add the
  runtime in `agents/Dockerfile` when onboarding a new language.

## The value/trust risk — read before adding "quality" logic

The quality loop is **circular**: one LLM generates, another LLM reviews, and the
green/red harness checks a test *runs*, not that it is *meaningful*. Left alone the
system optimizes a proxy and drifts into a large suite that never catches anything
(Goodhart). The objective signal that breaks the circularity is **change-coverage**
(does executing the test actually cover the lines the diff changed?) — implemented
in `qa-engine/src/contexts/objective-signal/domain/` (`assemble-change-coverage.ts`,
`decide-coverage.service.ts`, `render-coverage-gap.ts`) and consumed by
`RunQaUseCase` (`qa-engine/src/contexts/qa-run-orchestration/application/
run-qa.use-case.ts`):

- Three policy modes (`qa.coveragePolicy.mode`, default `signal`): `off` (skip),
  `signal` (measure + record only), `enforce` (gate). `minRatio` default `0.7`.
- `DecideCoverageService.decide` → `pass | fail | unknown`; `.blocks(status)` is the
  SINGLE source of truth for whether a measured status blocks publish. **`unknown`
  NEVER blocks** (no usable coverage, or cross-repo runs where browser coverage
  can't map service lines) — determinism over zeal, and this invariant holds even
  after a regeneration attempt (below).
- In `enforce`, a `fail` triggers **exactly one** targeted regeneration against the
  uncovered lines (`renderCoverageGap`), executed and re-measured under a
  `${runId}-coverage-regen` namespace so the second measurement reads its own
  coverage dumps, never the first run's. The regen's own second `measure()` is the
  ONLY input to the final `blocksPublish` decision — a regen that throws, fails
  validation, doesn't re-pass, or produces zero specs KEEPS the first measurement's
  result untouched (never fabricated). This is genuinely a ONE-SHOT regeneration,
  never a second attempt within the same run.

So the keystone exists and enforce-mode regeneration is implemented — the remaining
work is *strengthening* it (better line mapping, raising apps from `signal` to
`enforce` as they earn trust), **not more prompt tuning**. Keep this front of mind
before expanding the agent or the reviewer: new "quality" logic should lean on the
coverage signal, not add another LLM proxy.

## Current state

Several apps are wired in `config/apps/` across the current **Java +
JavaScript/TypeScript** scope — all interchangeable test targets, never design
inputs (see Invariants): `jhipster-store` (Angular 21 gateway + Spring
microservices, monorepo), `petclinic` (Spring, monorepo) and `portfolio`
(static Astro) run in **e2e** mode against live DEV in **shadow mode**;
`panchito` runs in **code** mode (the engine tests its own source, `code:
true`). The deploy gate is skipped wherever no `versionUrl` is configured
(already-deployed/static targets). engram is enabled for persistent agent
memory across runs.

The agent runtime is **provider-agnostic** (`src/agent-runtime/`): OpenCode and Codex,
in `single` or `dual` mode, behind one facade (the `agents` container's supervisor
fronts both). Change-coverage is implemented and defaults to `signal` (measured, not
yet blocking) — see [The value/trust risk](#the-valuetrust-risk-read-before-adding-quality-logic).
The cross-run LLM failure-reflection flywheel (`qa-reflector` role) is live — a
`ReflectorPort` runs a fault-isolated, timeout-capped reflect pass after each
qualifying fold, distilling `candidate`/`low`-confidence rules only (never
active), gated stricter than the deterministic learning fold (flaky/infra-class
verdicts are excluded).

The `src/` → `qa-engine/` migration program (`migration-remediation` through
`migration-tier-4d`) is **complete**: every genuine engine-logic-in-exile module
has migrated, moved, or been deleted as dead code; the remaining `src/` surface
is the declared, permanent shell (composition root, control plane, provider I/O
edges, persistence) described above. New engine logic targets `qa-engine/`;
`src/` changes are shell/composition-root/control-plane work. See
`docs/superpowers/2026-07-15-migration-tier-4d-decisions.md` for the full
program summary and `docs/superpowers/2026-07-09-src-qa-engine-migration-triage.md`
for the historical disposition record.
