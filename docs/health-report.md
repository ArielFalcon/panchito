# ai-pipeline — Code Health & Functionality Report

_Date: 2026-06-06 · Reviewed commit: `f65e65b` (origin/main)_

## 1. Executive summary

**The system is functional and healthy.** It builds with zero TypeScript errors,
its full test suite passes (**224 tests**), and a real end-to-end run has already
succeeded (an agent generated 3 Playwright specs and executed them against the live
DEV site). The codebase has grown to ~7,100 LOC of source across 28 test files and
is well structured: a deterministic Node orchestrator, a separate OpenCode agent
engine, a TUI, an HTTP control API, live SSE activity streaming, a SQLite run
history, and a self-maintenance/hot-swap loop.

| Dimension | Verdict |
|---|---|
| Build (typecheck) | ✅ clean |
| Tests | ✅ 224/224 pass |
| Architecture / separation | ✅ strong (deterministic infra vs agent; DI throughout) |
| Core flows integrated | ✅ verified (diff + complete ran end-to-end) |
| Security posture | ✅ good (scoped agent container, fail-closed webhook, token API) |
| Main risk | ⚠️ **autonomous self-merge + hot-swap of its own code is ON by default** |
| Long-term keystone | ⏳ real coverage/sensitivity instrumentation still pending |

**Bottom line:** it works and the integration between components is coherent. The
items below are refinements and risk controls, not blockers — with one design
decision (self-modification autonomy) that warrants an explicit operator choice.

---

## 2. What the system is now (architecture snapshot)

Two long-lived containers (`docker-compose.yml`):

- **orchestrator** (Node, `src/`): the deterministic infrastructure.
  - HTTP server (`src/index.ts`): webhook endpoint (fail-closed on unsigned
    POSTs), token-authenticated control API (`/api/*`), unauthenticated liveness
    (`/api/health`), and a maintainer API.
  - Single run funnel (`src/server/runner.ts → enqueueTrackedRun`): every trigger
    (webhook, API, CLI) creates one tracked `RunRecord` and goes through the
    sequential queue — nothing bypasses the queue or the history.
  - Live observability: an SSE stream from OpenCode routes agent activity (tool
    calls, file edits, streamed text) into the run logs in real time, plus a 15s
    heartbeat during generation.
  - Run history in SQLite (`src/server/history.ts`), persisted on a volume.
  - **Self-maintenance**: a health poller records incidents → a `qa-maintainer`
    agent diagnoses and fixes ai-pipeline's _own_ code → PR → (gated) merge +
    hot-swap, with a root-level `boot-guard.mjs` that rolls back a bad swap.
- **opencode** (the agent engine): `opencode serve` with agents (`qa-generator`,
  `qa-reviewer`, `qa-worker`, `qa-assistant`, `qa-maintainer`) and MCPs — Serena
  (LSP, via uvx), engram (memory, baked binary), and the Playwright MCP (baked).
  Its env is **scoped**: only the model key + DEV credentials, never the GitHub
  token or webhook secret.
- **TUI** (`src/tui/`, ink/React): dashboard, run history, chat assistant,
  onboarding wizard — talks to the control API.

**Pipeline** (`src/pipeline.ts`), per run:
gate (e2e/code) → classify (diff mode only) → setup (seed/deps) → orphan-data
cleanup → generate (agent uses the Playwright MCP to verify selectors against the
live DOM; fix-mode + parallel workers for complete/exhaustive) → **independent
review** (a separate `qa-reviewer` session whose verdict overrides the generator's
self-approval) → no-op skip → static gate (e2e) → health pre-flight → execute
(e2e via Playwright / code via the repo's own suite) → infra-vs-quality reclass →
retry once with failure feedback → decide (PR / Issue / quarantine / shadow-log).

**Modes:** `diff | complete | exhaustive | manual`. **Targets:** `e2e | code`.

---

## 3. Build & test health

- `npx tsc --noEmit` → clean (strict, `noUncheckedIndexedAccess` on).
- `npm test` → **224 pass, 0 fail** (node:test, including ink TUI component tests).
- ~7,100 LOC source; 28 test files. Side-effecting collaborators are
  dependency-injected, so the deterministic logic is genuinely unit-tested with
  stubs; the network/agent/git boundaries are exercised in production, not in CI.

---

## 4. Flow-by-flow integration assessment

| Flow | State | How verified |
|---|---|---|
| Webhook → queue → tracked run → pipeline | ✅ Works | unit tests + live runs |
| `diff` mode (classify → generate → validate → execute → decide) | ✅ Works live | the portfolio run generated & executed |
| `complete` mode (whole-repo analysis → generate uncovered) | ✅ Works live | generated `home/neovim/theme` specs, executed |
| No-op skip (agent approves with zero specs) | ✅ Works live | README-typo commit → `skipped` |
| Independent review overriding generator approval | ✅ Integrated | unit tests; separate `qa-reviewer` session |
| Static gate (typecheck/lint/list/manifest) | ✅ Works live | empty-suite correctly rejected as `invalid` |
| Execute + flaky classification (retries as signal) | ✅ Works | unit tests + live `fail` verdict |
| Infra-vs-quality reclassification (DEV health) | ✅ Integrated | unit tests |
| Retry once with failure feedback + Playwright-MCP fix loop | ✅ Integrated | unit tests; prompt wired |
| `code` mode (repo's own suite by exit code) | ✅ Integrated | unit tests (not yet run live) |
| `manual` mode (guidance) | ✅ Integrated | unit tests |
| Continuation (`continueRun` fixing selected failed cases) | ✅ Integrated | API + runner tests |
| SSE live activity + heartbeat → run logs / TUI | ✅ Integrated | agent-activity tests; needs a long live run to fully exercise |
| Self-maintenance (incident → fix → gated merge → hot-swap → rollback) | ⚠️ Integrated, high-risk | self-update unit tests; full loop not safe to exercise casually |

**Conclusion:** the defined flows are wired correctly and the components integrate
cleanly. The two flows that are integrated but **not** fully exercised live are
`code` mode and the self-maintenance hot-swap — the latter is the one to treat
with caution (see §6.1).

---

## 5. Strengths (what is notably good)

- **Determinism boundary holds.** All non-deterministic work is delegated to the
  agent engine; `src/` stays deterministic and testable. App specificity lives only
  in `config/`, agents/models only in `opencode/`.
- **Security posture.** The agent container gets only the model key + DEV creds
  (never the GitHub token/webhook secret); the webhook is fail-closed on unsigned
  POSTs; the control API uses a constant-time bearer-token check; the liveness
  probe is the only unauthenticated surface.
- **The circular-quality risk is addressed.** The independent reviewer runs in a
  _separate_ session and its verdict overrides the generator's self-approval — the
  generator can no longer rubber-stamp its own tests.
- **The "agent invents selectors" risk is addressed.** The prompt mandates using
  the Playwright MCP to navigate the live DOM and verify selectors (and inspect
  console/network) before writing a test — and the fix loop re-inspects on failure.
- **Real observability.** SSE activity + heartbeat + SQLite history + TUI give live
  insight into what the agent is doing (the earlier "can't see OpenCode output" gap
  is closed).
- **Resilience.** Orphan test-data and orphan-session cleanup; interrupted runs are
  finalized on boot; retry-with-feedback; abort signals wired end-to-end for
  cancellation.
- **Self-update safety layering.** Mandatory justification, a pre-merge self-test
  gate (install + typecheck + test on the fix branch), and a boot-guard that rolls
  back a swap that fails to boot healthy.

---

## 6. Findings & risks (prioritized)

### 6.1 ⚠️ HIGH — Autonomous self-merge + hot-swap is ON by default, and the code contradicts its own comment
In `src/index.ts → triggerMaintainer()` there are two blocks labelled "Step 6".
The first logs `"fix PR opened — awaiting human review and merge"` and a comment
says _"NO auto-merge. A self-modifying agent must never merge its own code…"_ — but
execution then **continues** to the second block which, when
`AUTONOMOUS_MAINTAINER` (default **true**, i.e. `SELF_MAINTAINER_AUTOMERGE !==
"false"`) and a valid justification exist and the pre-merge gate passes, **merges
the PR and hot-swaps the running service**. So by default the system autonomously
rewrites, merges, and deploys changes to its _own_ code.
- **Why it matters:** this is the highest-leverage and highest-risk behavior in the
  system. The safety gates (justification + pre-merge `npm test` + boot-guard) are
  good, but they cannot catch a fix that is subtly wrong yet passes tests, or an
  agent that produces a plausible-but-hollow justification. The stale "NO
  auto-merge" comment/log will also mislead an operator into thinking it never
  self-merges.
- **Recommendation:** (a) fix the contradiction — make the comment/logging match
  the actual behavior; (b) seriously consider **defaulting `AUTONOMOUS_MAINTAINER`
  to `false`** (PR-only, human merges) and making autonomy explicit opt-in; (c) at
  minimum, document this default prominently in the README/HANDOFF.

### 6.2 MEDIUM — Hot-swap assumes `src/` is a writable bind mount
`performSwap` overwrites `src/` + `package*.json` in `process.cwd()`. In compose,
`./src`, `./package.json`, `./package-lock.json` are bind-mounted from the host, so
the swap writes back to the host and survives restarts. In a **baked production
image** (`COPY . .`, no bind mount) the swap would write to the container's
ephemeral FS and be **lost on `docker compose up --build`/recreate**. The
self-update model currently depends on the dev-style bind mount; document this or
move `src/` to a named volume for production.

### 6.3 MEDIUM — Serena is fetched at runtime (connectivity dependency)
`opencode.json` launches Serena via `uvx` at run time, so the first run (or any run
after the `serena-cache` volume is cleared) requires outbound access to GitHub +
PyPI. This is both a latency cost and a connectivity failure point. See §7 for the
fix (bake Serena at build time).

### 6.4 MEDIUM — Runtime cost of the maintainer self-test gate
The gate runs `npm install` + `npm run typecheck` + `npm test` via `execSync`
inside the orchestrator at runtime (and `npm install` again after the swap). It
requires the full dev toolchain in the production image and blocks while running.
Acceptable for a self-healing system, but heavy; consider running the gate in a
throwaway step or capping its frequency.

### 6.5 LOW — Model-call amplification
Per run, generation + independent review + (on failure) one retry + re-review, and
for `complete`/`exhaustive` N parallel `qa-worker` sessions. This multiplies token
cost/latency. Not a bug; budget/latency to monitor as usage grows.

### 6.6 LOW — JSON verdict parsing robustness
`reviewIndependently` parses the verdict via `output.slice(output.lastIndexOf("{"))`.
If a correction string contains a `{`, parsing can break and fail closed
("no parseable verdict" → rejection). Minor; consider the tolerant last-balanced-
object parse used elsewhere (`parseVerdict`).

### 6.7 INFO — The long-term "value" keystone is still pending
Real coverage instrumentation (frontend via Playwright CDP, backend via JaCoCo) and
the merit/ledger/selective-execution machinery from `HANDOFF.md §5` are not built;
`complete`/`exhaustive` still estimate coverage by LLM reading (documented). The
independent reviewer + live-DOM verification are strong partial mitigations, but the
durable anti-degradation work remains the most important future investment.

---

## 7. OpenCode container internet connectivity (the explicit question)

**What the `opencode` container needs outbound access to:**
1. The **OpenCode Go gateway** (`opencode.ai`) — to call the models. _Unavoidable._
2. The **live DEV/target site** (e.g. the Vercel URL) — the Playwright MCP
   navigates it to verify selectors. _Unavoidable; must be reachable from the
   container._
3. **GitHub + PyPI/astral** — only to fetch Serena via `uvx` at runtime (and uv
   itself). _Removable_ by baking Serena (see fix B).

**By default Docker gives containers outbound internet** (the default bridge
network NATs through the host). So in a normal setup nothing special is required —
and indeed a run already reached the models successfully. Connectivity problems
therefore come from a restricted environment (corporate proxy, VPN-only DEV, custom
DNS, or an egress firewall), or from the runtime Serena fetch.

### Step 1 — Diagnose from inside the container
```bash
docker compose exec opencode sh -lc '
  curl -fsS -o /dev/null -w "opencode.ai %{http_code}\n" https://opencode.ai;
  curl -fsS -o /dev/null -w "github %{http_code}\n"      https://github.com;
  curl -fsS -o /dev/null -w "devsite %{http_code}\n"     https://portfolio-arielfalcons-projects.vercel.app;
  node -e "fetch(\"https://opencode.ai\").then(r=>console.log(\"fetch ok\",r.status)).catch(e=>console.log(\"fetch FAIL\",e.message))"
'
```
If these succeed, connectivity is fine and any failure is elsewhere (model auth,
the target URL, etc.).

### Fix A — Behind a proxy / VPN (most common real cause)
A proxy must be applied at **two** layers: build-time (so `apt`, `uv`, `npm`,
`playwright`, the engram download work) and run-time (so opencode + uvx + the
Playwright MCP's browser use it).

**`opencode/Dockerfile`** — accept proxy build args and export them for the RUN:
```dockerfile
ARG HTTP_PROXY=
ARG HTTPS_PROXY=
ARG NO_PROXY=
ENV HTTP_PROXY=$HTTP_PROXY HTTPS_PROXY=$HTTPS_PROXY NO_PROXY=$NO_PROXY \
    http_proxy=$HTTP_PROXY https_proxy=$HTTPS_PROXY no_proxy=$NO_PROXY
# ...existing RUN steps...
```
**`docker-compose.yml`** — pass them at build and at run time for the `opencode` service:
```yaml
  opencode:
    build:
      context: ./opencode
      args:
        HTTP_PROXY: ${HTTP_PROXY:-}
        HTTPS_PROXY: ${HTTPS_PROXY:-}
        NO_PROXY: ${NO_PROXY:-}
    environment:
      HTTP_PROXY: ${HTTP_PROXY:-}
      HTTPS_PROXY: ${HTTPS_PROXY:-}
      NO_PROXY: ${NO_PROXY:-}
      # ...existing env...
```

### Fix B — Remove the runtime fetch: bake Serena into the image (recommended)
This eliminates the GitHub/PyPI runtime dependency (only the gateway + DEV site
remain, which are unavoidable), and makes startup faster and deterministic.

**`opencode/Dockerfile`** — install Serena at build time:
```dockerfile
# after `uv` is installed:
RUN uv tool install --python 3.11 "git+https://github.com/oraios/serena@<pin-a-tag>"
ENV PATH="/root/.local/bin:${PATH}"
```
**`opencode/opencode.json`** — call the baked binary instead of `uvx ... --from git`:
```json
"serena": { "command": ["serena", "start-mcp-server", "--transport", "stdio", "--context", "ide-assistant"] }
```
(Pin a Serena release tag for reproducibility.)

### Fix C — DNS / custom resolver
If name resolution fails inside the container, set a resolver on the service:
```yaml
  opencode:
    dns: ["1.1.1.1", "8.8.8.8"]
```

### Fix D — Internal/VPN-only DEV environment
If the DEV site the Playwright MCP must navigate is not publicly reachable, the
container needs a route to it: use `extra_hosts:` to map a hostname to an internal
IP, attach the container to the appropriate Docker network, or (last resort)
`network_mode: host` on the orchestrator side. The current portfolio (public
Vercel) needs none of this.

> Net: for a normal/public setup, no change is needed (it already worked). For
> restricted networks, apply Fix A (proxy) and/or C (DNS). Regardless of network,
> **Fix B (bake Serena) is worth doing** to remove a runtime fetch and a failure
> point.

---

## 8. Recommended next steps (prioritized)

1. **Decide the self-modification autonomy** (§6.1): fix the contradictory
   comment/log, and choose whether `AUTONOMOUS_MAINTAINER` should default to
   `false`. This is the most important call.
2. **Bake Serena at build time** (§7 Fix B) — removes a runtime connectivity
   dependency and speeds startup.
3. **Document the hot-swap's bind-mount assumption** (§6.2) or move `src/` to a
   volume for production deployments.
4. **Run `code` mode and the full self-maintenance loop once, deliberately**, in a
   safe setting, to verify the two integrated-but-unexercised flows.
5. **Start the value keystone** (§6.7): wire frontend coverage (Playwright CDP) as
   the first real sensitivity signal — the foundation for merit, dedup and
   selective execution.

_Overall: a genuinely functional, well-integrated system. Ship it in shadow mode on
real repos to gather signal; gate the one high-risk behavior (self-merge) behind an
explicit opt-in before relying on it._
