# ai-pipeline — Project Handoff & Context

> Purpose of this document: transmit the full context of this project to a new
> model so it can continue from the exact current state, understanding the past
> (decisions and where we came from), the present (what works, what we just
> fixed, what's immediately next), and the future (the big pending objectives and
> the final goal). Read it top to bottom once before touching anything.

---

## 0. TL;DR

**What it is.** `ai-pipeline` is a centralized, AI-assisted end-to-end QA engine.
It watches a team's repos; when a commit is deployed to DEV, an OpenCode agent
generates Playwright E2E tests for the change's blast radius, runs them against
the live DEV site, and (when green and reviewer-approved) commits them into the
app repo's `e2e/` folder via a PR with auto-merge. A second model reviews the
tests; a deterministic "harness" gates quality; the suite lives in git and
improves itself run after run.

**Final goal.** A centralized, autonomous QA system that maintains a
self-improving E2E regression suite per repo, catches real regressions on every
deploy, and **stays trustworthy over time** (does not degrade into "green noise").
It replicates "what the user does with OpenCode locally" but centralized and
autonomous. **Priority order: stable, reliable, deterministic** — above features.

**Current moment.** The full pipeline runs end-to-end. It is connected to a real
test app (`ArielFalcon/portfolio`, an Astro static CV site on Vercel) in **shadow
mode** (runs everything but opens no PRs/Issues). The first real run succeeded:
the agent read the code and correctly decided a README-whitespace commit needs no
tests. We just fixed two bugs that surfaced from that run. Code is on `main`,
English, ~90 unit tests green, typecheck clean.

---

## 1. Where we started (origin & the big pivots)

The project began from an older "implementation guide" with a different shape and
was reshaped by a series of decisions. Understanding the *rejected* paths matters
as much as the chosen ones:

- **Hand-rolled agent → OpenCode.** The first design had a hand-written
  primary↔reviewer loop, custom HTTP providers (OpenCode/Gemini), and a custom
  MCP client. We **retired all of it** and delegate the agentic work to OpenCode
  (`opencode serve`): generation, the reviewer subagent, and the MCP tools
  (Serena, engram) all live *inside* OpenCode now. Rationale: the user already
  uses OpenCode locally; the goal is to centralize that, not rebuild an agent.
- **Ephemeral GitHub Actions → long-lived service.** QA is a permanent service
  (webhook + queue), not a per-PR Action.
- **GraphRAG → Serena (LSP).** We researched code-context tools. Conclusion:
  for *code*, AST/LSP-derived graphs beat LLM-extracted knowledge graphs
  (GraphRAG) on cost and precision. We rejected Microsoft GraphRAG and adopted
  **Serena** (an LSP-based MCP). Serena gives blast radius
  (`find_referencing_symbols`) and signature-level reading, which also solves the
  "Java context is too verbose" problem (read signatures, not whole files).
- **Volume → git for persistence.** Generated tests are NOT stored in a Docker
  volume; the **source of truth is the app repo's `e2e/` folder in git**
  (versioned, reviewable, survives host loss). Decided explicitly with the user:
  `/e2e` lives **in the app repo** (it's a monorepo), and publishing is a **PR
  with auto-merge** gated by the harness + reviewer.
- **Fixtures (not Page Object Model).** Confirmed with the user. Fixtures are the
  backbone (less boilerplate, auto teardown, matches our standardization); POM
  only as small helpers for complex pages if ever needed.
- **One OpenCode key (not per-provider keys).** Important correction: OpenCode
  uses a **single** API key (the OpenCode **Go** subscription / Zen gateway) and
  references models by name with the `opencode-go/` prefix. We use
  `opencode-go/deepseek-v4-pro` (executor/generator) and `opencode-go/qwen3.7-max`
  (independent reviewer).

---

## 2. Architecture (so you understand the codebase)

**Two long-lived services** (`docker-compose.yml`):

- **`orchestrator`** (this repo, Node/TypeScript run via `tsx`): the
  **deterministic infrastructure**. Receives the webhook, enqueues runs
  (sequential, one at a time), waits for/skips the deploy gate, prepares a
  **working copy** of the repo (read-only for the agent; the app is **never built
  or started** — the System Under Test is the live DEV site), triggers OpenCode,
  runs the generated tests with Playwright **against DEV**, and publishes/reports.
  All side-effecting steps are injected via `PipelineDeps`, so the orchestration
  is unit-tested with stubs.
- **`opencode`** (the agentic engine): runs `opencode serve` with the agents in
  `opencode/opencode.json` and the MCPs (Serena; engram currently disabled). The
  agent writes `.spec.ts` files into the shared working copy; the orchestrator
  picks them up.

They share the `mirrors` volume (the working copies). The agent's session `cwd`
is the working copy, valid in both containers.

**Prompts are layered (3 layers):**
- `opencode/AGENTS.md` — shared rules + anti-degradation protocols.
- `opencode/agent/qa-generator.md` and `qa-reviewer.md` — per-agent role,
  procedure, and JSON output contract.
- `opencode/skill/` — on-demand craft knowledge: `playwright-authoring` (cribbed
  from TestDino, MIT, fixtures-first; includes this app's hard parts: Keycloak
  two-layer auth, geolocation, mobile/offline, cookies/cache, uploads) and
  `test-value-review` (our own catalog of false-positive anti-patterns).

**The run flow (`src/pipeline.ts`):**
1. **Gate** — wait until DEV serves this SHA and is healthy (`/version`).
   **Optional**: if `dev.versionUrl` is absent, the gate AND health checks are
   skipped (for already-deployed/static sites with no `/version`).
2. **Working copy + classify** — clone/fetch + `checkout -f` + `clean -fd` (keeps
   `node_modules`), extract diff + message. **Classify the commit** (Conventional
   Commits, cross-checked against the diff).
3. **Setup** — bootstrap the `config/e2e/` seed into the repo's `e2e/` if missing,
   then `npm ci`. (Runs *before* generation so the agent has the fixtures/config.)
4. **Generate** — OpenCode session; the agent derives the objective from the
   commit intent, writes/improves tests + metadata (`e2e/.qa/manifest.json`),
   invokes the reviewer. **If the agent approves with zero specs → the change
   needs no tests → the run is `skipped` (clean).**
5. **Validate (Filter B)** — static gate: `tsc` + ESLint (`eslint-plugin-playwright`)
   + `playwright --list` + manifest validity. Fail → `invalid`.
6. **Health pre-flight** — if DEV is now down → `infra-error` (not a code bug).
7. **Execute (Filter C)** — run with Playwright against DEV; classify
   `pass`/`fail`/`flaky` (retries = flakiness signal).
8. **Decide** — on green AND reviewer-approved → PR with auto-merge. Green but
   reviewer rejected → Issue. `fail`/`invalid` → Issue. Failure with DEV down →
   `infra-error`. `flaky` → quarantine. Green with no `e2e/` changes → nothing.
   **Shadow mode** (`qa.shadow: true`) replaces all PR/Issue side effects with logs.

**Verdicts** (`RunVerdict`): `pass | fail | flaky | invalid | infra-error | skipped`.

**Key source files:**
- `src/pipeline.ts` — the orchestration (start here).
- `src/integrations/opencode-client.ts` — triggers the OpenCode session (the SDK
  is the integration boundary; logic is unit-tested with stubs).
- `src/qa/` — `commit-classify`, `metadata` (the `QaTestMeta` schema + manifest
  validation), `validate` (Filter B), `execute` (Filter C), `playwright-report`,
  `setup` (seed bootstrap + install), `test-data` (namespacing).
- `src/integrations/` — `repo-mirror` (working copy + git), `github` (Issues, PRs,
  auto-merge), `publish` (branch+commit+push+PR).
- `src/env/deploy-gate`, `src/server/{webhook,queue}`,
  `src/orchestrator/{config-loader,sanitizer}`, `src/report/reporter`.
- `config/e2e/` — the **seed** (Playwright config, fixtures, lint, tsconfig, empty
  manifest, assets) copied into each repo's `e2e/`.
- `config/apps/<app>.yaml` — per-app config (the ONLY app-specific surface besides
  `opencode/`).

**Invariants you must preserve:**
- Deterministic infra (`src/`) is separate from the non-deterministic agent
  (`opencode/`).
- App specificity lives only in `config/`; agents/models only in `opencode/`;
  nothing app-specific in `src/`.
- **Security boundary:** the LLM agent is **read-only** on watched repos; only the
  deterministic orchestrator does git writes (push/PR). Do not give the agent (or
  any future chat layer) direct write to the watched repos.
- Sanitize data leaving the system (diff → model, logs → Issue).
- Sequential queue (one run at a time; no concurrent QA clobbering DEV).
- Honor the agent's no-op decision.
- Everything in English; comments describe the final state, not the process.

---

## 3. Errors we hit and the lessons (read these — they're load-bearing)

Most of these came from integration boundaries that could not be verified without
actually running the system. They are the kind of mistake to avoid repeating:

1. **Assumed an official `ghcr.io/sst/opencode:latest` image existed.** It does
   not (anonymous pull → 403). Fix: build the engine from `node:22-bookworm` and
   install the OpenCode CLI (`npm i -g opencode-ai`) + `uv` (Serena via uvx) +
   language runtimes. Lesson: don't assume a base image; verify or build.
2. **Assumed per-provider API keys (DeepSeek/DashScope).** Wrong — OpenCode uses
   ONE key + `opencode-go/<model>`. The user corrected this. Lesson: verify the
   tool's actual auth/config model before wiring it.
3. **`npm install --omit=dev` dropped `tsx`.** The service runs TypeScript via
   `tsx` at runtime (no build step), and `tsx` is a devDependency. Fix: install
   all deps.
4. **Inline comment in `.env.example` became the value.** `docker compose`
   `env_file` does NOT strip inline `#` comments; `WEBHOOK_SECRET= # comment`
   turned the secret non-empty → webhook rejected requests with 401. Fix: comments
   on their own line.
5. **Floating Playwright version.** `^1.50.0` resolved to `1.60.0`, whose browsers
   are not in the `playwright:v1.50.0` base image → would break execution. Fix:
   pin exact `1.50.0` in the seed.
6. **Silently ignored OpenCode SDK errors.** The client returned empty on
   `session.create`/`prompt` errors, so a failed generation looked like "no tests
   written". Fix: throw on `res.error` and log the agent's output. Lesson: surface
   integration errors loudly; never swallow them.
7. **Ordering bug: seed bootstrapped AFTER generation.** On a fresh repo the agent
   had no fixtures/config when it tried to write tests. Fix: `setupE2e` before
   `generate`.
8. **No-op marked as `invalid`.** The commit classifier forced `generate` (the
   commit message was non-conventional → `unknown` → generate), but the agent
   correctly judged a README-typo needs no tests and wrote none; the harness then
   failed on "No tests found". Fix: if the agent approves with zero specs, the run
   is `skipped` (clean). Lesson: the agent's judgment about *whether to test* is a
   first-class, valid outcome — honor it.

**The meta-lesson (from a deliberate pre-mortem).** The deepest risk is NOT
engineering; it is **value and trust**:
- The quality loop is **circular**: an LLM generates, another LLM reviews, and the
  only objective gate (the harness) checks that a test *runs green*, not that it is
  *meaningful*. Two LLMs agreeing does not make a test valuable.
- There is **no ground-truth signal** ("did this test ever catch a real bug?"), so
  the system optimizes a proxy (green + lint-clean + reviewer-approved) and can
  drift into a large suite that never catches anything (Goodhart's law).
- **Auto-merging machine-generated tests into humans' repos** is a trust landmine.
A new model must keep this front of mind: the work that breaks the circularity is
the **coverage/sensitivity** work in §5, not more prompt tuning.

---

## 4. Present state & immediate next steps

**State:** `main` is the trunk and default-ish branch. The orchestrator and
opencode containers build and run. The pipeline executes end-to-end against
`ArielFalcon/portfolio` in **shadow mode** with the deploy gate skipped (the site
has no `/version`). The model + Serena + reading code all work (the agent reasoned
correctly about a no-op change). `engram` (memory) is **temporarily disabled** to
keep the smoke minimal. ~90 unit tests green; typecheck clean.

**What was just fixed (the last commits):** surface OpenCode errors + log the
agent output; pin Playwright; honor no-op → `skipped`; setup before generate; log
validation errors + a clear `run finished: verdict=...` line; optional deploy gate.

**Immediate next steps (in order):**
1. The user rebuilds the orchestrator (`git pull && docker compose up -d --build
   orchestrator`) and re-runs. The README-typo SHA should now yield `verdict=skipped`.
2. **See a real generation:** trigger a portfolio commit that actually changed the
   site (something under `src/`), so the agent writes a real `.spec.ts`, the
   harness validates it, and Playwright runs it against the live Vercel site.
   This is the first true generation+execution to observe and tune.
3. Once shadow runs look good: turn off `shadow`, add `GITHUB_TOKEN`
   (contents + pull_requests), enable "Allow auto-merge" + branch protection on
   the repo, and wire a real webhook (Vercel/GitHub) instead of the manual `curl`.
4. Re-enable `engram` with a verified install (it is a single Go binary,
   `engram mcp`, SQLite+FTS5; pin its version).

**How to run a manual smoke (current):**
```bash
docker compose up --build              # builds both services; first boot is slow (Serena via uvx)
# in another terminal, once "listening for webhooks on :8080":
SHA=$(git ls-remote https://github.com/ArielFalcon/portfolio main | cut -f1)
curl -X POST localhost:8080 -H 'content-type: application/json' \
  -d "{\"repo\":\"ArielFalcon/portfolio\",\"sha\":\"$SHA\"}"
docker compose logs -f orchestrator
```
Env needed for shadow: just `OPENCODE_API_KEY` (the Go subscription key) in `.env`
(public repo → no `GITHUB_TOKEN` needed for clone; shadow → nothing published).

---

## 5. Future — the big pending objectives (the real roadmap)

These are designed and discussed but **not implemented**. They are listed roughly
by importance to the final goal. Details and pending decisions are included.

### 5.1 The "is this test valuable?" problem (the keystone)
"Green" only means it passes against current code; it says nothing about whether
it would go **red when the behavior breaks** (sensitivity). This is what breaks the
circular LLM-judges-LLM loop. Mechanisms, by rigor:
- **Change-coverage gating (most viable).** A test is only relevant if executing it
  covers the lines/functions the diff changed (`coverage ∩ diff ≠ ∅`). **Keystone
  insight:** the *same* coverage instrumentation powers (a) merit/sensitivity, (b)
  selective execution (code→test map), and (c) redundancy/dedup. **Pending
  decision:** frontend coverage is nearly free via Playwright's CDP JS coverage;
  backend coverage (Java microservices) needs a JaCoCo agent on the DEV JVM (an
  infra commitment). Recommendation: start with frontend coverage.
- **Differential old-vs-new (strongest, limited).** A test for a change should fail
  on the old behavior and pass on the new. Only feasible with **feature flags** or
  a second ephemeral deploy (DEV only runs the new SHA). Open.
- **Assertion mutation (cheap, weak).** Negate/weaken a test's asserts to confirm
  it would catch the change. Full source-mutation (Stryker/PIT) is impractical at
  the E2E level.

### 5.2 Test metadata, merit, and the failure ledger
- The `QaTestMeta` **schema exists and is validated** (`id, objective, flow,
  targets, changeRef` required; `coverage, sensitivity, stability, ledger, merit`
  optional). The optional measured fields are **not computed yet**.
- **Merit score:** defined as a *vector of measurable signals with a hard gate*,
  not one opaque number: `if sensitivity == fail → merit = 0`, else combine
  marginal-coverage + caught-regressions − false-positives − flakiness +
  criticality. **Pending decision:** weights tuned with real data; do NOT prune on
  merit until the track record matures (early merit is low-confidence).
- **Failure ledger (real bug vs false positive):** the ground-truth signal. Sources:
  red→later `fix:` on the same flow = real catch; flaky/infra = false positive;
  human label (future chat). **Pending decision:** the system-of-record should be a
  **deterministic, queryable store** (you compute metrics from it), with `engram`
  holding only the distilled lessons (do not use fuzzy memory as the metrics source).

### 5.3 Bounding the suite + selective execution
- **Pruning:** one objective = one test (dedup by objective/coverage); re-prove
  sensitivity periodically and demote tests that can no longer fail; use the ledger
  to retire long-green never-caught tests.
- **Selective execution (Test Impact Analysis):** per commit, run only the tests
  whose flow/coverage intersects the blast radius (we already have the blast
  radius); tiered cadence (per-commit impacted subset; nightly full suite;
  pre-release full). E2E is slow, so do NOT run everything every time. Needs the
  code→test coverage map from §5.1.

### 5.4 Reliability hardening (from the failure-mode analysis)
Not yet implemented: retries/backoff for transient git/network; skip stale runs if
DEV already serves a newer SHA; distinguish "tooling crashed" from "quality failed"
in Filter B; detect auth/login-fixture failure vs a mass bug; add a unique
run-id suffix to the namespace for true data isolation on re-runs; PR
merge-conflict handling; circuit breaker (pause + alert after N infra failures);
observability (per-run audit records + an alert channel).

### 5.5 Anti-degradation operations
- Persistent **flaky quarantine registry** (auto-skip known-flaky, periodically
  re-evaluate) — we detect flaky per run but don't yet remember it.
- A **maintenance agent** (cron, NOT per-commit) to compact/dedup memory and prune
  the suite. **Pending decision:** the *deletion/pruning* must be **deterministic
  rules** (TTL, supersession, dedup), not an autonomous LLM deleting by vibes; only
  bounded *consolidation/summarization* should use an LLM, with backups.

### 5.6 OpenClaw (phase 2, optional operator layer)
OpenClaw is an always-on autonomous gateway with chat channels (Telegram), memory,
schedules. **Decision:** it is NOT a substitute for OpenCode (different layer) and
must **never sit in the deterministic pipeline**. Its only justified use is an
**operator/observability/chat surface on top** (e.g. "re-run repo X", "show the
flaky list", alerts). It must act through a **small fixed control API on the
orchestrator** (verbs like `triggerRun`, `quarantineTest`, `deleteTest`,
`pauseRepo`) — never with direct git write — so a compromised chat can at worst
trigger a recorded, git-revertible action. Defer until the core is proven; secure
the channel (authz) before enabling tool access.

### 5.7 Known placeholders / ops still owed
- Pin the Serena version (currently tracks `main` via uvx).
- Re-enable engram + decide a backup strategy (memory is the only non-regenerable
  data; Serena index and working copies are regenerable caches).
- Language runtimes for Serena per watched-repo language (JDK present; add others).
- For the *real* target app (not the portfolio): a `/version` endpoint returning
  `{sha, healthy}`, the two-layer credentials (`DEV_ENV_*` HTTP Basic gate +
  `DEV_TEST_*` Keycloak), and the deploy→webhook wiring.

---

## 6. The target app (for the eventual real connection)

The system was designed for a **single app with several standardized
microservices**, all consumed **through one web entry point** (so one `baseUrl`;
microservices are exercised by navigating the UI, not hit directly). Its realities,
already wired into the seed/skills:
- **Two credential layers:** (1) an HTTP Basic gate on the whole DEV environment →
  `httpCredentials` from `DEV_ENV_*`; (2) the app login via **Keycloak** (external
  redirect) → the `authenticate` fixture from `DEV_TEST_*`. Public pages skip auth.
- **Geolocation** (map + nearby places on upload), **mobile/offline** modes,
  **cookies/cache** reads, and **photo upload** (assets in `e2e/assets/` with
  optional `assets.json` metadata describing what to test per asset).
The current test app (`ArielFalcon/portfolio`) is a much simpler stand-in: a public
Astro static CV site on Vercel, no login, no `/version` (gate skipped).

---

## 7. Quick orientation checklist for the new model

- Read `src/pipeline.ts` first (the whole flow), then `opencode/` (agents +
  skills), then `config/e2e/` (the seed), then `README.md`.
- Run `npm test` and `npm run typecheck` — both must stay green.
- Keep the invariants in §2. When in doubt about an integration (OpenCode SDK,
  Serena, Playwright, git/PR), assume it's an unverified boundary and surface
  errors loudly rather than guessing.
- The current priority is to **observe a real generation against the portfolio**
  and then start §5.1 (coverage), which is the keystone for everything else.
- Above all: protect **stability, reliability, determinism** over adding features,
  and remember the meta-risk in §3 — the value/trust of the tests is the thing the
  whole project lives or dies by.
