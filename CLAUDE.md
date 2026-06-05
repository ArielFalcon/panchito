# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Deep context lives in `HANDOFF.md` (origin, rejected designs, the value/trust
> meta-risk, and the full roadmap). Read it before any non-trivial change. This
> file is the operational distillation.

## What this is

`ai-pipeline` is an **app-agnostic, centralized AI-assisted E2E QA engine** (a
template — no app is bundled). It watches a team's repos; when a commit is
deployed to DEV, an OpenCode agent generates Playwright E2E tests for the
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
npm test                    # unit tests — node:test via tsx; 96 tests, network/OpenCode/Playwright stubbed
npm run typecheck           # tsc --noEmit (strict, noUncheckedIndexedAccess)

# Run a single test file or filter by name:
node --import tsx --test src/qa/commit-classify.test.ts
node --import tsx --test --test-name-pattern="skip" src/qa/commit-classify.test.ts

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
| `opencode` | **The agentic engine** — `opencode serve` running the agents + MCPs (Serena for code nav; engram for memory). Writes `.spec.ts` files into the working copy. | `opencode/` |

The **fundamental split**: deterministic infra (`src/`) is kept rigorously
separate from the non-deterministic agent (`opencode/`). They communicate over
one HTTP boundary (`src/integrations/opencode-client.ts` ↔ `opencode serve`).

### The run flow — start here

`src/pipeline.ts` is the whole orchestration; read it first. One `runPipeline`
serves both triggers (webhook `src/index.ts`, manual `src/cli.ts`), default
`diff` mode shown:

1. **Gate** — wait until DEV serves this SHA and is healthy (`/version`).
   Skipped entirely when `dev.versionUrl` is absent (already-deployed/static sites).
2. **Working copy + classify** — clone/checkout the SHA; extract diff + message;
   `classifyCommit` (Conventional Commits, **cross-checked against the diff** — a
   `refactor`/`style` whose diff adds net logic escalates to `generate`).
   `skip` → returns `skipped` without spending a token.
3. **Setup** — bootstrap the `config/e2e/` seed into the repo's `e2e/` if missing,
   then `npm ci`. Runs **before** generation so the agent has the fixtures/config.
4. **Generate** — OpenCode session; the agent derives the objective from the
   commit intent, writes/improves specs + `e2e/.qa/manifest.json`, invokes the
   reviewer. **If the agent approves with zero specs → no-op → `skipped`** (clean).
5. **Validate (Filter B)** — static gate: `tsc` + ESLint (`eslint-plugin-playwright`)
   + `playwright --list` + manifest validity. Fail → `invalid`.
6. **Health pre-flight** — DEV down now → `infra-error` (not a code bug).
7. **Execute (Filter C)** — run with Playwright against DEV; classify
   `pass`/`fail`/`flaky` (a pass only after retry = flaky → quarantine).
8. **Decide** — green + reviewer-approved → PR w/ auto-merge. Green but reviewer
   rejected, or `fail`/`invalid` → Issue. Failure with DEV down → `infra-error`.
   `flaky` → quarantine. Green with no `e2e/` changes → nothing.

**Verdicts** (`src/types.ts` `RunVerdict`): `pass | fail | flaky | invalid | infra-error | skipped`.

**Shadow mode** (`qa.shadow: true` in app config) replaces every PR/Issue side
effect with a log line — used to onboard a repo without dirtying it.

### Run modes (`RunOptions.mode`, CLI `--mode`, default `diff`)

- **diff** — the flow above: test the blast radius of one commit. The **only** mode
  that runs `classifyCommit` (skip/regression/generate); the others always generate.
- **complete** — analyze the whole repo + existing suite, persist a coverage/
  importance map to `e2e/.qa/analysis.json`, generate tests for important UNCOVERED flows.
- **exhaustive** — like complete, but re-evaluate every existing test and regenerate
  the suite, not just the delta.
- **manual** — generation focused by `--guidance`.

The mode-specific prompt is assembled by `buildTask` in `opencode-client.ts`.

### Dependency injection is the testing strategy

Every side-effecting step in `runPipeline` is injected via `PipelineDeps`
(`defaultPipelineDeps()` wires the real ones). The orchestration logic — ordering,
branches, verdict decisions — is unit-tested with stubs. The **real integrations
are the deliberately-uncovered boundaries**: the OpenCode SDK call, the Playwright
runner, git operations. Each integration module exports its own `*Deps` and a
`default*Deps` in the same pattern (`opencode-client`, `repo-mirror`, `validate`,
`execute`, `setup`, `publish`). Follow this pattern for any new side-effecting code.

### The agent (opencode/) — three prompt layers

Generation, the reviewer subagent, and the MCP tools all live **inside** OpenCode.
Config in `opencode/opencode.json`. Two **different models** guarantee independent
judgment, via a **single** OpenCode Go key (`OPENCODE_API_KEY`); models are named
with the `opencode-go/` prefix (no per-provider keys):

- `qa-generator` (primary, `deepseek-v4-pro`) — writes tests, can read/edit/bash.
- `qa-reviewer` (subagent, `qwen3.7-max`) — read-only quality judge, emits a JSON verdict.

Prompts are layered: `opencode/AGENTS.md` (shared rules + anti-degradation
protocols) → `opencode/agent/*.md` (per-role procedure + JSON output contract) →
`opencode/skill/` (on-demand craft: `playwright-authoring`, `test-value-review`).

### Persistence & onboarding surface

- **Source of truth for the suite = git**, in the app repo's `e2e/` folder
  (versioned, reviewable, survives host loss). `config/e2e/` is the **seed** copied
  in on first run. engram memory (`engram-data` volume) is the only non-regenerable
  data; Serena index and working copies are regenerable caches.
- **Onboarding a watched app is `config/apps/<app>.yaml` + `.env` only.** Copy
  `config/apps/example.yaml`. `${VARS}` in the YAML expand from the environment.

## Invariants — do not break these

- **Security boundary:** the LLM agent is **read-only** on watched repos. Only the
  deterministic orchestrator does git writes (push/PR). Never give the agent (or
  any future chat/operator layer) direct write to a watched repo.
- **App-specificity lives only in `config/`; agents/models only in `opencode/`;
  nothing app-specific in `src/`.**
- **Sequential queue** — one run at a time; never run concurrent QA against DEV.
- **Honor the agent's no-op decision** — approved + zero specs is a *valid*
  `skipped`, never `invalid`.
- **Surface integration errors loudly** — never swallow OpenCode SDK / runner / git
  errors into an empty result (a swallowed error once looked like "no tests
  written"). Throw and log.
- **Sanitize data leaving the system** — diff → model, and execution logs → Issue,
  both pass through `src/orchestrator/sanitizer.ts`.
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
- **Serena needs a language server per watched-repo language.** The `opencode` image
  bakes in JDK (Java/Spring), python3, and the TypeScript LS (Angular); add the
  runtime in `opencode/Dockerfile` when onboarding a new language.

## The value/trust risk — read before adding "quality" logic

The quality loop is **circular**: one LLM generates, another LLM reviews, and the
only objective gate (the harness) checks a test *runs green*, not that it is
*meaningful*. There is no ground-truth signal yet, so the system optimizes a proxy
and can drift into a large suite that never catches anything (Goodhart). The work
that breaks this is **change-coverage gating** (does executing the test cover the
lines the diff changed?) — the keystone of the §5 roadmap in `HANDOFF.md` — **not
more prompt tuning**. Keep this front of mind before expanding the agent or the
reviewer.

## Current state

`main` runs end-to-end against `ArielFalcon/portfolio` (a public Astro static site
on Vercel) in **shadow mode** with the deploy gate skipped (no `/version`). engram
is temporarily disabled (`enabled: false` in `opencode.json`) to keep the smoke
minimal. The roadmap and pending decisions are in `HANDOFF.md` §5.
