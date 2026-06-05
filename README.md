# ai-pipeline

**Centralized, AI-assisted E2E QA.** A service that **watches a team's repos** and
**tests against DEV**: when a commit is deployed to DEV, an agent generates E2E
tests for the change's blast radius, runs them against DEV, and opens a **GitHub
Issue** if something fails.

It is a **template**: no app is bundled. Each watched app is onboarded via
`config/apps/<app>.yaml`. Secrets are injected at runtime by **Doppler** (nothing
is committed).

## Architecture

Two long-lived services (see `docker-compose.yml`):

```
   GitHub (push → deploy to DEV)
            │  webhook { repo, sha }
            ▼
 ┌─────────────────────┐        HTTP        ┌──────────────────────────┐
 │   orchestrator      │  ───────────────▶  │   opencode  (serve)      │
 │  (this repo, Node)  │  session + prompt  │  qa-generator agent      │
 │                     │ ◀───────────────   │   └─ qa-reviewer subagent │
 │  webhook + queue    │   specs written    │  MCP: serena, engram     │
 │  gate · working copy│   in the copy      └──────────────────────────┘
 │  execution · report │         ▲  cwd = working copy (shared volume)
 └─────────────────────┘─────────┘
```

- **`orchestrator`** (this repo): the **deterministic infrastructure** — receives
  the webhook, enqueues a run, waits for the deploy (SHA gate), prepares a
  **working copy of the repo** (only so the agent can READ code and so the tests in
  `e2e/` can be versioned; **the app is never built or started**), **triggers
  OpenCode**, runs the E2E tests with Playwright **against DEV**, and publishes/
  reports. Everything with injectable dependencies → verifiable by unit tests.
- **`opencode`**: the **agentic engine**. `opencode serve` runs the agents defined
  in `opencode/opencode.json` and the MCPs: **`serena`** (semantic code navigation
  via LSP — blast radius with `find_referencing_symbols`, reading by signatures
  rather than whole files) and `engram` (episodic memory). The agent writes the
  `.spec.ts` files into the working copy (a shared volume) and we collect them.

### Agents (opencode/)

| Agent | Model | Role |
|---|---|---|
| `qa-generator` (primary) | **DeepSeek V4 Pro** | generates the E2E tests, invokes the reviewer, iterates |
| `qa-reviewer` (subagent) | **Qwen 3.7 Max** | independent quality judge; emits a verdict |

The primary↔reviewer loop lives **inside** OpenCode. Different models guarantee
independent judgment. Instructions are layered: shared rules in
`opencode/AGENTS.md`, per-agent role/procedure in `opencode/agent/*.md`, and
**skills** (on-demand craft knowledge) in `opencode/skill/`:
`playwright-authoring` (authoring + this app's capabilities: two-layer Keycloak,
geolocation, mobile/offline, cookies/cache, photo upload) and `test-value-review`
(false-positive catalog for the reviewer).

> **Model credentials:** a **single** key — your **OpenCode Go** (or Zen)
> subscription — in `OPENCODE_API_KEY`. OpenCode exposes its models by name with
> the `opencode-go/` prefix (no per-provider keys). The IDs
> (`opencode-go/deepseek-v4-pro`, `opencode-go/qwen3.7-max`) live in
> `opencode/opencode.json`; verify them with `opencode models` if your plan changes.

## Run flow (`src/pipeline.ts`)

1. **Gate** — wait until DEV runs that SHA and is healthy (`/version`).
2. **Working copy + classification** — clone/fetch + checkout the SHA; extract the
   diff and message. **Classify the commit** (Conventional Commits, cross-checked
   against the diff): `style/docs/chore` without logic → `skipped` (nothing tested);
   `refactor/perf` → regression only (no generation); `feat/fix` (or a `refactor`
   the diff reveals **does** add logic) → generate. Filters noise and cost before
   spending a token.
3. **Generate** — open an OpenCode session with cwd = working copy; the agent
   derives the **objective** from the commit intent, writes/improves the tests in
   the **repo's `e2e/`** (source of truth in git) with their **metadata**
   (`e2e/.qa/manifest.json`: objective, flow, targets), and reviews them. If the
   repo has no `e2e/`, it is seeded from `config/e2e/`.
4. **Validate (Filter B)** — `npm ci` in `e2e/` + static gate: typecheck + lint
   (`eslint-plugin-playwright`) + `playwright --list` + **valid metadata**. If any
   fails, the run is `invalid` and is not executed.
5. **Execute (Filter C)** — run the specs with Playwright against DEV, with
   namespaced data `qa-bot-<sha>`, and classify `pass`/`fail`/`flaky` (retries as a
   flakiness signal). The output is **sanitized** before reuse.
6. **Decision** — before executing, DEV **health is re-checked**; if it is down,
   the run is `infra-error` (not reported as a bug). On green **and with the
   reviewer approving**, the agent commits `e2e/` and a **PR with auto-merge** is
   opened, so the suite improves itself, versioned. Green but **reviewer rejects** →
   Issue (not published). `fail`/`invalid` → Issue; failure with DEV down →
   `infra-error` (no Issue); `flaky` → quarantine; green with no changes → no PR, no noise.

> **Shadow mode** (`qa.shadow: true`): runs the whole flow but **does not publish
> PRs or open Issues**, only logs what it would do. Meant for the initial rollout
> when onboarding a repo, without dirtying anything.

### Execution modes

The POST body accepts a `mode` (default `diff`). All modes share the same harness,
execution and publishing; only the agent's task and the commit-classification step
change:

| Mode | Body | What the agent does |
|---|---|---|
| `diff` (default) | `{repo, sha}` | Test the flows affected by the commit (its blast radius). The commit is classified to decide generate / regression / skip. |
| `complete` | `{repo, sha, mode:"complete"}` | Analyze the **whole repo** + existing suite, estimate coverage and importance (persisted to `e2e/.qa/analysis.json`), and generate tests for the important **uncovered** flows (the delta). |
| `exhaustive` | `{repo, sha, mode:"exhaustive"}` | Like `complete`, but **re-evaluate the whole suite** (audit every existing test for correctness/value/necessity and regenerate), not just the delta. |
| `manual` | `{repo, sha, mode:"manual", guidance:"..."}` | Generation focused by the user's `guidance`. |

Also available via the CLI: `npm run qa -- --app <app> --sha <sha> --mode complete`
(and `--guidance "..."` for `manual`).

> Note: until real coverage instrumentation exists (see HANDOFF §5.1), `complete`/
> `exhaustive` estimate coverage by reading the existing specs and the code.

### E2E harness (quality and consistency)

- **Layer A — standardization**: the `config/e2e/` seed (base Playwright config,
  shared fixtures — login, `namespace`, `ns()` — and lint rules) is seeded into the
  repo's `e2e/` the first time. From then on **the repo owns it** and the agent
  maintains/improves it; the real login is implemented once in the `authenticate`
  fixture. (Single app with standardized microservices → one shared fixtures
  library, not per-repo.)
- **Layer B — static gate** (`src/qa/validate.ts`): validates the specs without
  spending a browser (compile, lint, load, metadata).
- **Layer C — flakiness gate** (`src/qa/execute.ts` + `playwright-report.ts`): a
  test that only passes after a retry is marked `flaky` → quarantine; it is not
  accepted nor does it break as a real failure.

### Persistence (where each thing lives across restarts)

- **E2E suite (specs + fixtures)** → **git**, in the app repo's `e2e/`. The source
  of truth: versioned, reviewable, survives host loss. The agent improves it via PR.
- **engram** (episodic memory) → the `engram-data` volume. **Not regenerable**: the
  only thing worth backing up. Survives container restarts.
- **Serena index and working copies** → volumes (`serena-cache`, `mirrors`).
  **Regenerable** caches: if lost, they are rebuilt/re-cloned.

> Named volumes survive `restart`/`down`+`up`; they are lost with `down -v` or if
> the host is destroyed. That is why the source of truth lives in git.

## Sanitization

Repo source is already clean (Doppler injects secrets at runtime). The sanitizer
(`src/orchestrator/sanitizer.ts`) covers the residual: it redacts secrets/PII/
internal hosts in (a) the **diff** before sending it to OpenCode and (b) the
**execution output** before quoting it in an Issue — where DEV data could appear.
Test data is synthetic and namespaced.

## Usage

```bash
npm install
npm test          # unit tests of the infrastructure (network/OpenCode/Playwright stubbed)
npm run typecheck

# Onboard an app:
cp config/apps/example.yaml config/apps/my-app.yaml   # edit repo, dev, etc.

# Manually trigger a run (runs the SAME pipeline as the webhook):
npm run qa -- --app my-app --sha <commit-sha>
```

### Deployment (Docker)

```bash
# With Doppler injecting the secrets:
doppler run -- docker compose up --build
# (or copy .env.example → .env to run locally without Doppler)
```

- `orchestrator`: image based on Playwright (Node + browsers) + git. The e2e
  tooling (Filters B/C) is installed per run in the repo's `e2e/` (`npm ci`).
- `opencode`: the official OpenCode image + `uv` and the language runtimes Serena
  needs (JDK for Java, etc.) + `engram` (see `opencode/Dockerfile`).
- Volumes: `mirrors` (shared by both; Serena caches in `<repo>/.serena`),
  `serena-cache` (uv/Serena cache), `engram-data` (memory). The E2E suite uses no
  volume: it lives in git.

## Principles

1. Deterministic infrastructure (gate, working copy, execution, reporting) is
   separated from the agentic engine (OpenCode).
2. App specificity lives only in `config/`; agents and models only in `opencode/`.
   Neither lives in `src/`.
3. Sanitization on data leaving the system (diff → model, logs → Issue).
4. Independent reviewer (a different model from the primary), per-app conditional.
5. **Sequential** queue: one run at a time, no concurrent QA clobbering DEV.
