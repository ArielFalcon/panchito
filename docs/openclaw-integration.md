# OpenClaw Integration — Definitive Implementation Spec

**Status**: Spec — ready to implement. Supersedes the 2026-06-05 proposal.
**Scope**: Add a conversational channel (Telegram first, others free) over the
existing control API, powered by the same OpenCode Go subscription. **No change to
the orchestrator's run lifecycle or to the opencode agents.** The engine does not
change; a fourth interface is added.
**Audience**: whoever implements this. It is grounded in the code as it exists
today (see §2), not in the older `interactive-layer.md` description.

---

## 1. Goal

`ai-pipeline` already speaks webhook, CLI, and a TUI. This adds a **chat** interface
("clawbot") so a human can drive and interrogate the engine in natural language. The
definition of done is the four capabilities the owner asked for:

1. **Talk to it over Telegram** (and other channels out-of-the-box, no bespoke code).
2. **Act on the engine on demand** — trigger and steer runs through a typed, detailed
   mapping of the engine's own REST API.
3. **Run test cycles, report and analyze current *and past* executions, and answer
   questions** scoped to a specific app and (when needed) a specific execution.
4. **Use the same OpenCode Go subscription** that already powers the test models as
   the chatbot's model provider.

Everything else in this document exists to make those four solid, safe, and
deterministic — the project's stated priority order (**stable > reliable >
deterministic > features**).

---

## 2. Ground truth — what already exists (do NOT rebuild)

This is the single most important section: most of what the original proposal wanted
to "add" is already built. The plan reuses it.

| Building block | Where | Reused for |
|---|---|---|
| **Control API** — `POST /api/runs` (accepts `app`, `sha`\|`ref`, `mode`, `target`, `guidance`), `GET /api/runs/:id`, `GET /api/runs?app=&limit=`, `GET /api/apps`, `GET /api/apps/:name`, `GET /api/queue`, `GET /api/health`, `POST /api/runs/:id/ask`, `POST /api/runs/:id/continue`. Bearer auth (`QA_API_TOKEN`); `/api/health` is unauthenticated. | `src/server/api.ts`, wired in `src/index.ts` | The sole contract OpenClaw calls |
| **Single funnel** — `enqueueTrackedRun(queue, {app,sha,target,mode,guidance,source,...})`; every trigger (webhook/CLI/API) goes through it; one sequential run at a time. `source: "webhook" \| "manual"`. | `src/server/runner.ts` | Chat-triggered runs are normal queued jobs |
| **Durable run history (SQLite, `better-sqlite3`)** — `runs`/`cases`/`specs`/`run_activity` tables at `HISTORY_DB_PATH` on the `qa-data` volume; **survives restarts**; 30-day retention. `createRecord/getRecord/listRecords/currentRun/updateRecord/addCase/appendLog/appendActivity`. | `src/server/history.ts` | **This is the "durable ledger"** the chat needs for past runs. **No new store is built.** |
| **Learning layer (persisted)** — `run_outcomes` (verdict, `errorClass`, `gateSignals`: static/coverageRatio/valueScore/reviewerCorrections/flaky/retries), `learning_rules` (trigger/action/confidence/successRate), `curriculum` (archetypes proven by real bugs). `listRunOutcomes/listLearningRules/loadCurriculum`; CLI `npm run qa -- --app X --learning`. | `src/server/history.ts`, `src/qa/learning/*` | The **fragility/value analysis** for reports — reuse, don't reinvent |
| **Read-only run Q&A** — `askAssistant({context,question})` opens a bounded, tool-less `qa-assistant` session; context is assembled + **sanitized on ingress** by `buildRunContext`, answer **sanitized on egress**. | `src/integrations/opencode-client.ts`, `src/server/chat.ts`, `opencode/agent/qa-assistant.md` | `qa_ask_run` reuses this; egress stays in `src/` |
| **Ref resolution** — `resolveRef(repo, ref)` via `git ls-remote`; already used by `POST /api/runs` when `ref` is sent instead of `sha`. | `src/integrations/repo-mirror.ts` | Triggering by branch name needs no extra step |
| **GitHub client** — `openIssue`, `createPullRequest`, `getPrStatus`, `getPullRequest`, `getRepo` (singleton `github`). | `src/integrations/github.ts` | Read-only Issue/PR context (needs a `list` helper added) |
| **Egress sanitizer** — `sanitizeText()` redacts ~12 secret classes, private IPs, emails; `containsSecrets()` gate. | `src/orchestrator/sanitizer.ts` | All chat-bound data must pass it |
| **Deploy topology** — two services (`orchestrator`, `opencode`) sharing `mirrors`; volumes `mirrors`/`qa-data`/`engram-data`/`serena-cache`/`opencode-data`; engram is a Go binary (`v1.16.1`) exposed as an MCP on `engram-data`; the single `OPENCODE_API_KEY` unlocks all OpenCode Go models. | `docker-compose.yml`, `Dockerfile`, `opencode/Dockerfile`, `opencode/opencode.json` | OpenClaw is a third service in the same shape |

**Implication:** the only `src/` work is a handful of small, additive, **unit-tested**
API endpoints (§5). Everything conversational lives in the new service (§6).

### 2.1 Gaps and one security finding (surfaced by the code read)

- **Security — chat is a new, less-trusted egress.** `GET /api/runs/:id` returns the
  run record with **raw `logs`** (sanitization today is applied only to the `ask`
  context and to Issue bodies). Acceptable for the localhost TUI/CLI; **not**
  acceptable for a chat channel. The chat-facing read endpoints (§5) **must** sanitize
  `logs`/`note`/`stepDetail` on egress.
- **Issue/PR URL is not stored** on the run record — "link me the issue for that
  failure" can't be answered from history yet. Persist it (§5).
- **`TriggerSource` is `"webhook" | "manual"`** — add `"chat"` for provenance/audit.
- **API `MODES` omits `context`** (`src/server/api.ts` lists only
  `diff/complete/exhaustive/manual` while `RunMode`/CLI include `context`).
- **`cancelRun` is wired in `apiDeps` but has no HTTP route** — expose one so chat can
  abort a runaway run.
- **`opencode-ai` is installed unpinned** in `opencode/Dockerfile`. The new service
  must pin its gateway (and this is a good moment to pin opencode too).

---

## 3. Architecture decisions

### D1 — OpenClaw is a third Docker service, never embedded in the orchestrator
The orchestrator is deterministic and DI-tested; embedding an LLM agent would break
that. A separate service that talks **only** over the REST API preserves the
invariant boundary for free. (Unchanged from the original proposal.)

### D2 — The REST API is the *sole* integration contract — including history
OpenClaw calls HTTP endpoints and nothing else. Critically, even though the SQLite
history file lives on a Docker volume, **OpenClaw must not read it directly** — that
would create a second consumer coupled to the storage format and silently break "the
API is the single contract." History and reports are reached through new read
endpoints (§5). OpenClaw never mounts `mirrors` or `qa-data`, never runs git, never
holds DEV credentials.

### D3 — Three focused plugins, not one monolith
`qa-pipeline-tools` (the bridge — required), `qa-guardian` (safety — recommended),
`qa-copilot` (history/analysis/memory — advanced). Independent failure domains;
enable what you need. (Unchanged in spirit; the per-plugin contracts in §4 are
rewritten against the real API.)

### D4 — Model provider = the existing OpenCode Go subscription *(req #4)*
OpenCode Go is OpenAI-compatible at `https://opencode.ai/zen/go/v1`, authenticated by
the **same `OPENCODE_API_KEY`** the test models use. OpenClaw declares it as a custom
provider (§7). One subscription powers generation, review, the run-assistant, and now
the chatbot — different models for different jobs, one key.

### D5 — Reuse SQLite as the durable ledger; add reports, don't add storage
The original proposal assumed run history was ephemeral and proposed a new ledger.
The code moved on: history is already durable SQLite with a learning layer. The plan
therefore **adds read/aggregation endpoints over the existing tables** and persists
the Issue/PR URL — no parallel store, no event-sourcing rewrite.

### D6 — Polling, not streaming
The chat creates a run, then polls `GET /api/runs/:id` (status/step/cases/verdict).
2-second-resolution updates are imperceptible in chat and require zero orchestrator
change. (Unchanged.)

### D7 — Approval gating for destructive operations (guardian)
A chat channel is reachable by humans, so a policy layer is mandatory before runs hit
the queue: identity→app authorization, confirmation for heavy modes
(`exhaustive`/`complete`), rate limiting, and a **durable** audit trail. (§4.2.)

### D8 — Copilot influences generation only through sanctioned channels
The copilot is **read/synthesis** for the human (reports, "what did we learn about
checkout"). Where it can usefully shape a run, it does so **only** by passing
`guidance` to `qa_create_run` and by writing engram lessons the `qa-generator`
already reads — **never** by reaching across the HTTP boundary into the generator's
prompt (that would violate "agents/models live only in `opencode/`; app-specifics
only in `config/`"). Per `CLAUDE.md`, the copilot is explicitly **not** the thing that
breaks the circular-quality loop (change-coverage gating is); it is assistance and
observability.

### D9 — Two-key security model
- **Model credential**: the shared `OPENCODE_API_KEY` (OpenCode Go) — req #4.
- **Control-plane credential**: a dedicated `QA_API_TOKEN` bearer for the REST API.

OpenClaw holds **only these two**. It has no `GITHUB_TOKEN`, no `WEBHOOK_SECRET`, no
`DEV_*` credentials, no git remote. Its blast radius is "can call the QA API with the
team's policy" — bounded by design. (This replaces the original proposal's vaguer
"separate API key" note, which conflated the two axes.)

### D10 — Shared engram, distinct namespace
OpenClaw mounts the same `engram-data` volume and runs engram as an MCP, but writes
its operational memories (audit, user preferences, conversation notes) under a
distinct project/topic-key prefix, and only **reads** the per-app lessons the
`qa-generator` writes. Two agents, one memory, no cross-contamination.

---

## 4. The three plugins

OpenClaw native plugins are: an `openclaw.plugin.json` manifest (declares
`id`/`name`/`contracts.tools`/`activation`/`configSchema`) plus a runtime module that
`export default definePluginEntry({ id, name, register(api){ ... } })`. Tools are
registered with `api.registerTool({ name, description, parameters: Type.Object({...}),
async execute(_id, params){ return { content: [{type:"text", text}] } } })` (TypeBox
schemas); lifecycle policy uses `api.on(...)`. Every runtime tool must also appear in
the manifest's `contracts.tools`.

> Pin `package.json` → `openclaw.compat.pluginApi` / `minGatewayVersion` to the
> deployed gateway version (confirm with `openclaw plugins inspect`). Pinning the
> execution path is a project invariant.

### 4.1 `qa-pipeline-tools` — the bridge *(req #2, req #3-trigger)*

Typed, validated tools mapping 1:1 to the **real** API. Each validates inputs, returns
human-readable summaries (not raw JSON), and surfaces API errors verbatim (never
swallows them — a project invariant).

| Tool | Method + endpoint | Notes |
|---|---|---|
| `qa_list_apps` | `GET /api/apps` | name, repo, baseUrl, shadow |
| `qa_get_app` | `GET /api/apps/:name` | config summary |
| `qa_resolve_ref` | `POST /api/refs/resolve` *(new, §5)* | "latest SHA on main" |
| `qa_create_run` | `POST /api/runs` | `{app, ref\|sha, mode: diff\|complete\|exhaustive\|manual\|context, target: e2e\|code, guidance?}`; tags `source:"chat"` + actor |
| `qa_get_run` | `GET /api/runs/:id` *(sanitized, §5)* | live status/step/cases/verdict; the polling target |
| `qa_list_runs` | `GET /api/runs?app=&limit=` | recent runs (now durable) |
| `qa_get_queue` | `GET /api/queue` | what's running / pending |
| `qa_continue_run` | `POST /api/runs/:id/continue` | `{cases, guidance}`; human-in-the-loop fix loop (depth-capped at 5) |
| `qa_cancel_run` | `POST /api/runs/:id/cancel` *(new route, §5)* | abort a run |
| `qa_ask_run` | `POST /api/runs/:id/ask` | delegates to `qa-assistant`; bounded + sanitized in `src/` |

**Why a product, not a wrapper:** validation with helpful errors ("`dashbord` is not a
configured app — did you mean `dashboard`?"), `ref` defaulting (a bare "test main"
resolves server-side), and target/mode guidance ("`exhaustive` regenerates the whole
suite; did you mean `diff`?").

### 4.2 `qa-guardian` — the safety net *(req #1 hardening)*

Policy via `api.on` hooks; no new tools.

| Policy | Mechanism | Detail |
|---|---|---|
| App authorization (RBAC) | `before` tool-call hook on `qa_create_run`/`qa_continue_run`/`qa_cancel_run` | identity (e.g. Telegram numeric user id) → allowed apps, defined in **config**, never in `src/`. Deny with an explanation. |
| Destructive-mode confirmation | same hook, when `mode ∈ {exhaustive, complete}` | requires an explicit "confirm" turn; explains cost/impact instead of just blocking |
| Rate limiting | rolling per-identity/per-app window | prevents queue saturation from rapid commands |
| Durable audit | `after` tool-call hook | append an immutable audit record. Write to engram (distilled) **and** a durable audit log so it survives restart — auditing only to volatile memory is not an audit trail |
| Failure notification | run-finished check (poll result of chat-triggered runs) | push back to the originating chat on `fail`/`invalid` so the user need not poll |

### 4.3 `qa-copilot` — history, analysis, memory *(req #3)*

Reads the durable history + learning layer + engram and **synthesizes** for the human.
It does not dump rows; it answers "the checkout flow failed 3 of the last 8 runs;
most common cause was selector ambiguity on the pay button (see Issue …)."

| Tool | Source | Answers |
|---|---|---|
| `qa_history` | `GET /api/runs?app=&limit=` | "show me the last 10 runs of dashboard" |
| `qa_get_history_run` | `GET /api/runs/:id` *(sanitized)* | a specific past run incl. its Issue/PR link |
| `qa_report` | `GET /api/reports?app=&window=` *(new, §5)* | pass-rate, verdict breakdown, flaky/fragility, trend — **computed deterministically in `src/`**; the LLM only narrates |
| `qa_learning` | `GET /api/apps/:name/learning` *(new, §5)* | error-class distribution, value scores, rules, archetypes proven by real bugs |
| `qa_lessons` | engram search (shared volume, read-only) | distilled per-app lessons (fragile flows, reliable selector patterns) |
| `qa_github_context` | `GET /api/apps/:name/issues` *(new, §5)* | recent Issues/PRs the engine opened — proxied so OpenClaw holds no GitHub token |

**Pre-run assist (bounded):** before a run, the copilot may fold its synthesis into the
`guidance` field of `qa_create_run` (sanctioned input), and may write a lesson to
engram — never into the generator's prompt directly (D8).

---

## 5. Orchestrator changes (`src/`) — the only engine-side work

All additive, all behind the existing DI + unit-test pattern (`ApiDeps`,
`default*Deps`), all must keep `npm test` and `npm run typecheck` green.

1. **Sanitize the chat egress.** Add a read path that returns a run record with
   `logs`/`note`/`stepDetail`/case `detail` passed through `sanitizeText()`. Either a
   query flag (`GET /api/runs/:id?sanitized=1`) or a header set by the OpenClaw client;
   the chat tools (`qa_get_run`, `qa_get_history_run`) **must** use it. *(Security
   finding §2.1.)*
2. **Reports endpoint.** `GET /api/reports?app=&window=<e.g. 7d|30d|50runs>` → a
   deterministic aggregate computed over `runs`/`cases`/`run_outcomes`: counts by
   verdict, pass-rate, flaky list, top failing cases/flows, trend. New pure function in
   `src/server/` (unit-tested over stub rows); no LLM involved.
3. **Learning read endpoint.** `GET /api/apps/:name/learning?limit=` → wraps
   `listRunOutcomes` + `listLearningRules` + `loadCurriculum` (read-only projection of
   the existing learning layer).
4. **Persist Issue/PR URL on the run.** Add `issueUrl`/`prUrl` to `RunRecord` + a
   `runs` column (with the existing `columnExists` migration pattern); thread the URL
   from `report()`/`publish()` in `pipeline.ts` into `updateRecord`. Returned by
   `GET /api/runs/:id`.
5. **Provenance.** Extend `TriggerSource` to `"webhook" | "manual" | "chat"`; thread an
   optional actor (channel + identity) from `POST /api/runs` → `enqueueTrackedRun` →
   record, so audit/observability show chat origin. (Keep it optional; default
   behavior unchanged.)
6. **Cancel route.** Expose `POST /api/runs/:id/cancel` over the already-wired
   `cancelRun` dep.
7. **`refs/resolve` route.** `POST /api/refs/resolve { app|repo, ref }` → `{ sha }`
   (thin wrapper over the wired `resolveRef`). Optional but nice for Q&A.
8. **GitHub read context.** Add `github.listIssues(repo, {state, limit})` /
   `listPulls(...)` to the singleton + `GET /api/apps/:name/issues` (read-only). Keeps
   the GitHub token inside the orchestrator.
9. **API completeness.** Add `context` to the API `MODES` allowlist so chat can request
   it (it is a maintenance/map-build mode; the guardian may gate it like the heavy
   modes).

> None of these touch the run lifecycle, the queue, the gates, or the agents. They are
> read projections + two small write-throughs (URL persistence, provenance).

---

## 6. The OpenClaw service (deployment)

A new top-level `openclaw/` directory mirrors `opencode/`: a `Dockerfile`, an
`openclaw.json` (gateway config), and the three plugin packages. A new compose
service:

```yaml
  openclaw:
    build: ./openclaw           # pinned OpenClaw gateway (see openclaw/Dockerfile)
    restart: always
    dns: ["1.1.1.1", "8.8.8.8"] # same explicit resolvers as the others
    depends_on:
      orchestrator: { condition: service_started }
    environment:
      # req #4 — same subscription as the test models
      OPENCODE_API_KEY: ${OPENCODE_API_KEY}
      # control-plane credential (the ONLY way it reaches the engine)
      QA_API_URL: http://orchestrator:8080
      QA_API_TOKEN: ${QA_API_TOKEN}
      # channels
      TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN}
      # shared memory, distinct namespace
      ENGRAM_DATA_DIR: /data
    volumes:
      - ./openclaw:/root/.config/openclaw   # config + plugins
      - engram-data:/data                   # READ shared lessons; write its own namespace
      - openclaw-state:/root/.local/share/openclaw  # pairing/session state
    # NO mirrors, NO qa-data, NO git, NO DEV creds. Telegram long-polls →
    # no inbound port is exposed.
```

Notes:
- **No published port.** Telegram defaults to long polling, so the gateway only makes
  outbound connections. (If you later want the browser control UI or webhook-mode
  Telegram, expose a port and front it with auth — out of scope for v1.)
- **`depends_on` is soft** (`service_started`): per the reliability requirement, if the
  orchestrator is down the chat degrades gracefully ("the QA service is unavailable"),
  it does not crash-loop.
- **Pin the gateway** in `openclaw/Dockerfile` (and pin `opencode-ai` in
  `opencode/Dockerfile` while here — current unpinned install is latent drift).
- Add `openclaw-state` to the `volumes:` list; reuse `engram-data`.

---

## 7. Provider wiring *(req #4)* — concrete

In `openclaw/openclaw.json`:

```jsonc
{
  "models": {
    "providers": {
      "opencode-go": {
        "baseUrl": "https://opencode.ai/zen/go/v1",
        "apiKey": "${OPENCODE_API_KEY}",
        "api": "openai-completions",
        "models": [
          {
            "id": "deepseek-v4-flash",
            "name": "QA Chat",
            "reasoning": false,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 131072,
            "maxTokens": 8192
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "opencode-go/deepseek-v4-flash" },
      "models": { "opencode-go/deepseek-v4-flash": { "alias": "QA Chat" } }
    }
  }
}
```

**Hard requirement to verify before pinning:** the chosen Go model **must support
function/tool-calling**, or the plugin tools will never be invoked. `deepseek-v4-flash`
is the candidate (already used by `qa-assistant`); confirm tool-calling support and the
exact id/context window against `models.dev/api.json` (`.opencode.models`) /
`opencode models`. A wrong/unsupported id must fail loudly at boot, never silently
degrade. The model must be both declared in `models.providers` **and** allow-listed in
`agents.defaults.models`, or OpenClaw rejects it.

---

## 8. Channels *(req #1)*

### Telegram (first-class)

```jsonc
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "${TELEGRAM_BOT_TOKEN}",   // from @BotFather
      "dmPolicy": "allowlist",                // pairing | allowlist | open | disabled
      "allowFrom": ["<NUMERIC_USER_ID>"],     // numeric IDs, not @usernames
      "groupPolicy": "allowlist",
      "groups": { "-100xxxxxxxxxx": { "requireMention": true } }
    }
  }
}
```

- Default transport is **long polling** (no inbound port; works behind NAT/Docker).
- First DM under `pairing` emits a code approved with
  `openclaw pairing approve telegram <CODE>`; for a known owner, `allowlist` +
  `allowFrom` is simplest.
- The guardian's RBAC sits **on top** of channel allowlists: the channel decides *who
  may talk*; the guardian decides *what each identity may trigger, on which app*.

### Other channels — out-of-the-box

Slack, Discord, WhatsApp, WebChat, etc. are native OpenClaw channels: enabling them is
**configuration only** (their `channels.<name>` block + the relevant token env var),
no new plugin code. v1 ships Telegram enabled and documents the others as toggles, so
"other modes" cost nothing.

---

## 9. Invariants — preserved, line by line

| `CLAUDE.md` invariant | How this design honors it |
|---|---|
| LLM agent is **read-only on watched repos**; only the orchestrator does git writes | OpenClaw never mounts `mirrors`, has no `GITHUB_TOKEN`, no git. All writes happen inside the orchestrator, triggered by a queued job. |
| App-specifics only in `config/`; agents/models only in their service; nothing app-specific in `src/` | RBAC/app maps live in OpenClaw config; the chatbot model lives in `openclaw/`; the `src/` additions are app-agnostic projections. |
| **Sequential queue** — one run at a time against DEV | Chat runs are normal `enqueueTrackedRun` jobs on the same queue. |
| **Surface integration errors loudly** | Plugin tools return API errors verbatim; a missing/incapable model fails at boot; nothing is swallowed into an empty result. |
| **Sanitize data leaving the system** | The new chat-facing read path runs `sanitizeText()` on logs/notes; the `ask` path already sanitizes ingress+egress. Closes the raw-log gap (§2.1). |
| **Honor the agent's no-op decision** | Untouched — verdicts are still the pipeline's; chat only reads them. |
| Everything in English; comments describe final state | Plugin code and the new endpoints follow suit. |
| The API is the single contract | OpenClaw reaches history/reports only via REST, never the SQLite file (D2). |

---

## 10. Non-functional requirements

- **Reliability**: OpenClaw down ⇒ webhook/CLI/TUI unaffected. Orchestrator down ⇒ chat
  degrades with a clear message. The three plugins are independent failure domains.
- **Observability**: every chat-triggered run carries `source:"chat"` + actor; the
  guardian's durable audit answers "who ran what, when, why"; reports/learning give a
  fragility dashboard.
- **Security**: two-key model (D9); no inbound port; sanitized egress; policy gate
  before the queue.
- **UX**: "what can you do?" → lists apps + actions; "test main of dashboard" →
  resolves ref, gates policy, enqueues, polls, reports; "why did run X fail?" →
  `qa_ask_run` / `qa_get_history_run`; "how healthy is checkout?" → `qa_report` +
  `qa_learning` + `qa_lessons`.

---

## 11. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Chosen Go model can't tool-call → tools never fire | Medium | High | Verify against `models.dev`/`opencode models` before pinning; fail loud at boot |
| Raw logs leak secrets to a chat channel | Medium | High | §5.1 sanitized chat egress is a release blocker |
| LLM hallucinates app/SHA | Medium | Low | API validates server-side; helpful errors |
| Chat saturates the queue | Low | Medium | Guardian rate-limit + heavy-mode confirmation |
| OpenClaw reads SQLite directly, coupling to storage | Low | Medium | D2 forbids it; history only via REST |
| engram namespace collision | Low | Medium | Distinct project/topic-key prefix; copilot reads app lessons, writes its own |
| Gateway/plugin version drift | Medium | Low | Pin gateway + `pluginApi`/`minGatewayVersion`; pin `opencode-ai` too |

---

## 12. Phased rollout (re-sequenced for the real codebase)

**Phase 0 — Orchestrator API (the only `src/` work).** Sanitized chat-read path;
`GET /api/reports`; `GET /api/apps/:name/learning`; persist `issueUrl`/`prUrl`;
`source:"chat"` + actor; `POST /api/runs/:id/cancel`; `POST /api/refs/resolve`;
`GET /api/apps/:name/issues`; add `context` to `MODES`. Each unit-tested; gate green.

**Phase 1 — Service + bridge + Telegram (reqs #1, #2, #4).** `openclaw/` service,
`opencode-go` provider, `qa-pipeline-tools`, Telegram channel. Done when a teammate
triggers and tracks a run from their phone and it matches a CLI run.

**Phase 2 — Guardian (safety).** RBAC config, heavy-mode confirmation, rate limiting,
durable audit, failure notifications.

**Phase 3 — Copilot (req #3).** `qa_report`/`qa_learning`/`qa_history`/`qa_lessons`/
`qa_github_context`; synthesis prompts tuned for quality over quantity; bounded
pre-run `guidance` assist.

**Phase 4 — More channels + polish.** Enable Slack/Discord/WebChat by config; iterate
on prompts from real usage.

---

## 13. Success criteria

1. A newcomer triggers their first QA run from Telegram in <60s, no docs.
2. Chat handles ≥90% of interactive triggers that today need `bin/qa`/`npm run qa`.
3. No invariant is violated (queue stays sequential; orchestrator stays the sole git
   writer; gates unchanged; no unsanitized data reaches chat).
4. "Why did checkout fail last week?" is answerable from durable history + Issue/PR
   links + learning layer — without opening GitHub.
5. The audit trail answers "who triggered what, when, and why" after a restart.

---

## 14. Open questions / confirmations before/while building

- **Model id + tool-calling**: confirm `opencode-go/deepseek-v4-flash` (or the chosen
  Go model) supports function calling and its real context window (`models.dev`).
- **OpenClaw image/version**: pick a pinned gateway version; confirm the
  `definePluginEntry`/`api.registerTool`/`api.on` surface against that version's Plugin
  SDK (`openclaw plugins inspect`).
- **engram sharing mechanics**: confirm the OpenClaw gateway can run the engram MCP the
  same way `opencode.json` does (`engram mcp --tools=agent`, `ENGRAM_DATA_DIR=/data`),
  and settle the namespace/topic-key convention for chat-origin memories.
- **Audit log location**: a small append-only file on a new `openclaw-state` volume vs.
  reusing `qa-data` (kept orchestrator-owned). Default: `openclaw-state`, since the
  audit is the chat layer's own record.
- **Reports window semantics**: time-based (`7d`/`30d`) vs. count-based (`50runs`) — or
  both. Default: support both, time-based primary.
