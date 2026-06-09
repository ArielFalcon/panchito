# Interactive QA Layer (TUI → control plane)

**Status:** **Implemented** — Phases 0-3 done and gate-verified (155 unit tests); Phase 4 is a tested, OFF-by-default router scaffold (live SSE subscription gated on the live spike). Hardened after adversarial review; supersedes the accumulated TUI discussion.
**Scope:** the Ink TUI, the control API as the single contract, live activity, human-in-the-loop continuation, and a lite read-only chat. Built against the invariants in `CLAUDE.md`. OpenClaw is a known **future** channel client and is explicitly out of scope here.

---

## 1. Problem & objectives

`ai-pipeline` speaks two machine languages (webhook, CLI flags). A human cannot intuitively launch/track a run, cannot **see what the AI is doing** during the long blocking generation turn (the "black box"), cannot see what code was analyzed or which specs ran, and cannot fix a silly failure (a misconfig, a flaky selector) without restarting the whole run. The objectives:

1. **Launch + track** runs intuitively.
2. **See live activity** — break the black box (what the agent is doing, what was analyzed, which tests ran, human-readable failure summaries).
3. **Mark failed cases + add hot guidance** and re-run *focused* generation without re-deriving everything (a continuation, not a fresh run).
4. **Lite read-only chat** about the *current* run from inside the TUI.

**Priority order, above features (from `CLAUDE.md`): stable, reliable, deterministic.** This doc deliberately sequences *value-first* and *risk-down*: the TUI ships over the existing API before any new orchestrator machinery, and the speculative infra in the original proposal is cut or deferred until a concrete gap demands it.

---

## 2. What already exists (do not rebuild)

- **Control API** (`src/server/api.ts`, DI via `ApiDeps`, unit-tested): `POST /api/runs`, `GET /api/runs/:id`, `GET /api/runs?app`, `GET /api/apps`, `POST /api/apps` (server-side onboarding), `DELETE /api/apps/:name[?purge=1]` (config + optional mirror/history purge), `GET /api/queue`, `GET /api/health`. Optional bearer auth.

  **Server-side onboarding** (`POST /api/apps`) validates the repo against GitHub
  (the token lives in the orchestrator, NOT the TUI — this is what fixed the
  "GITHUB_TOKEN not found" wizard error), validates the YAML against the schema,
  writes `config/apps/<name>.yaml`. Body flags: `validateOnly` (repo check →
  `repoInfo` only), `dryRun` (returns the YAML, writes nothing), `env`
  (key→value map applied to the live `process.env` *and* persisted to `.env` — each var
  on its own line; values are never echoed back, only the applied key names). With
  Doppler, the response includes a warning: persist the vars there too or they die
  with the container. `services[]` lets one e2e app declare its microservice repos
  (a webhook from any service then triggers an e2e run of the app).

  **App deletion** (`DELETE /api/apps/:name`) removes the YAML; with `?purge=1`,
  also removes the PRIMARY repo mirror (service mirrors may be shared and are
  regenerable caches anyway) and the app's run history. The watched repo is
  never touched.
- **Persistent run history** (`src/server/history.ts`): `RunRecord` with `step/stepDetail/cases/verdict/passed/failed/note/retrying/logs`. `addCase` upserts by name. Durable SQLite (survives restarts via `better-sqlite3` at `HISTORY_DB_PATH`); pruned at 30 days.
- **Progress callbacks**: `runPipeline(onStep, onCase)` fire at coarse boundaries (classify/generate/validate/execute/retry/done), wired into the record by `enqueueApiRun` (`src/index.ts`).
- **bin/qa**: a bash TUI (curl+jq) that already renders a live-ish dashboard over polling — the proof that polling suffices for objectives 1 and most of 2.
- **fixCases re-generation**: `pipeline.ts` already feeds failed cases back into `deps.generate` on auto-retry (`MAX_RETRIES=1`); `buildPrompt` has a `fixCases` block. The continuation reuses this.

---

## 3. Architecture

### 3.1 The control API is the single contract — make it actually single

The orchestrator must not know whether a request came from the Ink TUI, the CLI, or a future channel: it receives `{app, sha, mode, guidance}` (and the new `{cases, guidance}` / `{question}`) through the **same queue** and the **same sanitizer**.

**Precondition (must land first):** `src/cli.ts` currently calls `runPipeline` directly — no `RunRecord`, not enqueued, not API-addressable, and able to run QA against DEV **concurrently** with a webhook/API run (violating "one run at a time against DEV"). Route the CLI through the same `enqueue` path so every run is **one queued, recorded, addressable entity**. A test asserts the CLI cannot start a run that bypasses the queue.

### 3.2 The run lifecycle has exactly ONE authority: `src/pipeline.ts`

`runPipeline` **is** the macro state machine: a linear `gate → classify → setup → generate → validate → health → execute → (retry ≤1) → decide`, with a closed `RunVerdict` union (`pass|fail|flaky|invalid|infra-error|skipped`) as its transition table, side effects threaded through closures, and exhaustive DI-stub tests (`PipelineDeps`).

- **No XState.** The "many cases" that motivated a formal FSM (reviewer-corrects-tester → re-execute → re-validate → rectify) live **inside OpenCode** (one opaque `session.prompt` round-trip), not in `src/`. Adding XState *alongside* `pipeline.ts` creates two authorities for one truth that must be hand-synced with every future branch (change-coverage gate, `context` mode, continuation) — a non-load-bearing duplicate of the most determinism-critical surface. A read-only **state label** for the TUI is *derived* from the existing `onStep` boundaries; no new runtime state.
- If a formal machine is ever justified (genuine concurrency, operator pause/resume that plain control flow cannot express), it must **replace** `runPipeline`, proven with a transition table mapping 1:1 to today's verdicts — never ship both.

### 3.3 Live activity: polling now, SSE later (advisory-only)

Objective 2's core — what the agent is doing, what was analyzed, which tests ran — is already served by `RunRecord.step/stepDetail/cases/logs` over **polling** (the OpenClaw doc's Decision 6 chose this for the same trade-off). The TUI ships on polling.

**OpenCode SSE is a later, flagged increment**, not a v1 foundation, because (verified):
- `event.subscribe()` hits a **server-global** `/event` firehose (`sdk.gen.js:842`); every event carries a `sessionID` you must filter by. There is no per-session stream.
- The **maintainer** agent (`triggerMaintainer`) opens its own session **outside the JobQueue**, so the firehose interleaves concurrent sessions.
- The stream has **no event ids / no replay** (Last-Event-ID ignored): dropped events are lost.

When SSE is added (Phase 4, gated on a spike): wrap it behind a **narrow, `src`-owned `AgentActivity` type** in `opencode-client.ts`; capture each run's session id (and the reviewer child via `session.children`) at create; route an event to a run **only** if its `sessionID` is in that run's known-session set (log+count drops, **never swallow** — `CLAUDE.md` invariant); hard-allowlist a few event kinds; pass through `src/orchestrator/sanitizer.ts`. **Advisory-only:** it updates `step`/activity fields, never a verdict.

### 3.4 The EventBus and RunRecord projection (deferred, and strictly read-side if ever built)

- Keep `RunRecord` as a **directly-mutated** projection of `onStep/onCase`. With SQLite persistence, an event-sourcing layer would still be over-engineering for the current scale — the DB already provides durability and the finalizer handles restart recovery. Prevent illegal states with a discriminated `RunStatus` type + a couple of transition guards if needed.
- **If** a typed `EventBus<RunEvent>` is ever introduced (the SSE-replay endpoint is the first plausible *second* consumer), it is a **strictly read-side fan-out**: `pipeline.ts` callbacks are the **only** producer of lifecycle events; consumers (history projection, SSE replay) **never** feed state back. This is what makes the bus **orthogonal** to the lifecycle authority — zero edges from consumers back to the producer. Human feedback and maintainer incidents enter only via the **command side** (API verbs that enqueue jobs), never as events into a machine.

### 3.5 The continuation model (objective 3)

A continuation is a **new, first-class, queued run**, not a resurrection of a mutated working copy or a kept-alive session.

`POST /api/runs/:id/continue { cases, guidance }`:
1. Creates a **new** `RunRecord` carrying `(parentRunId, marked cases, guidance)` — captured at request time so they survive parent eviction.
2. Enqueues on the **same sequential queue** (mirror-mutation serialization preserved).
3. Inside the job, **revalidate preconditions atomically**: record exists + terminal; mirror `HEAD == sha` (else `infra-error` "mirror moved on"); marked cases still exist. Fail loudly otherwise (409 / clear message).
4. Re-derive the working copy via the **normal `ensureMirror`** (re-checkout the **same sha**, do **not** skip `clean -fd` — the pristine-checkout contract is load-bearing).
5. Run **focused generation** through the **existing `fixCases`** path with a **fresh** OpenCode session (the human's marked cases map onto `fixCases`, guidance onto `guidance`).
6. Traverse `validate + execute + reviewer` (+ future change-coverage) with **no skip**.

**Anti-coercion rails** (the human guides, does not coerce green): the manifest `changeRef`/`objective` is **immutable** across a continuation (validate/reviewer reject objective downgrades; only **add/strengthen** assertions for marked cases); cap continuation rounds (mirror `MAX_RETRIES=1`); stamp a **`human-steered continuation`** provenance flag on the resulting PR.

**Cut:** v1.5 "deep reuse" of the same OpenCode session (`openCodeSessionId`). Sessions are disposed in a `finally` block and "never auto-cleaned"; a kept-alive session leaks server memory, a stored id is dangling after restart, and a full-context resume can re-derive an unintended verdict. A fresh session seeded via `fixCases` reconstructs context, survives restart, and is strictly safer.

### 3.6 The lite chat capability (objective 4)

A read-only OpenCode agent **`qa-assistant`** (cheap flash/lite model, confirmed via `opencode models`; **no** write/edit/bash; **no** repo tools in v1) answers questions about the **current** run via `POST /api/runs/:id/ask { question }`.

- **Read-only is infra-enforced, not prompt-trusted:** `src/` assembles a **bounded** context blob (recent N cases + truncated logs + verdict), passes it through `sanitizer.ts` on **ingress**, gives the assistant **no** session `cwd` into a watched working copy, and sanitizes the answer on **egress** (`logs→chat` is a **new** egress that must be added to sanitizer coverage). A missing model **throws/logs loudly**, never degrades.
- **Scope seam vs OpenClaw:** the lite chat is bounded to recent runs in the persistent history (30-day SQLite retention); historical questions beyond that window are OpenClaw's job and need the **future deterministic ledger**.

---

## 4. Cross-cutting decisions (with rationale)

| Decision | Rationale |
|---|---|
| Control API = single contract; CLI routed through the queue first | The whole control plane (TUI, continue, chat, future OpenClaw) assumes every run is one queued, recorded, addressable entity; the CLI currently breaks that and can run concurrent QA against DEV. |
| `pipeline.ts` is the sole lifecycle authority; no XState | It already is the tested state machine; the reviewer micro-loop stays in OpenCode, so there is no state explosion. A second authority is a sync-drift bug farm. |
| Polling for live activity v1; SSE deferred, advisory-only | `/event` is a global, no-replay firehose with concurrent maintainer sessions; polling already works. SSE must never gate a verdict. |
| RunRecord stays directly-mutated; no event-sourcing rewrite | Unpersisted event log = all cost, no durability payoff; preserves the just-stabilized finalizer. |
| EventBus (if ever) is read-side only; lifecycle inputs are command-side verbs | Makes bus/lifecycle orthogonality literally true; prevents the bus→FSM→bus feedback cycle. |
| Continuation = new queued run, deterministic re-checkout, fresh session, fixCases reuse | Preserves the queue, determinism, the pristine-mirror invariant, and restart-survivability. |
| Blocking `session.prompt` is the sole verdict authority | Two writers with no precedence = flapping state; the fail-closed gate needs one source. |
| `qa-assistant` read-only enforced in infra; both ingress + egress sanitized | Read-only is a structural invariant, not a config assertion; the Q&A surface is a new egress. |
| Pin `@opencode-ai/sdk` exactly; isolate event/session surface behind one adapter | New reliance on event/session APIs on a young SDK; matches the "pin the execution path" invariant. |

---

## 5. Persistence boundary

- **Durable:** git (the suite, in the app repo's `e2e/`), engram (**distilled, per-app lessons only** — never a decision/metrics system-of-record), SQLite `RunRecord` history (30-day retention), and the **future deterministic queryable ledger** (its own scoped initiative; not built here).
- **Ephemeral, no persistence:** the JobQueue, any future event bus, the derived state label. A restart abandons the in-flight run; the operator re-triggers. (The `finalizeInterruptedRuns` boot-time recovery already marks non-terminal rows `infra-error` on restart — mirroring `recoverMaintainerState`; **never** engram for this.)
- **Explicitly cut:** the Spring-Batch-style job/step/step-execution store and "decisions in engram like a hash table" — it duplicates the future ledger and violates the engram-is-distilled-lessons invariant. ("No persistence needed" and "add Spring-Batch persistence" cannot both stand.)

---

## 6. Invariants preserved

- Deterministic infra (`src/`) stays rigorously separate from the agent (`opencode/`); SSE, if added, maps OpenCode events into one narrow `src`-owned type and never exposes OpenCode's event vocabulary upward.
- The LLM agent stays **read-only** on watched repos; only the orchestrator does git writes; `qa-assistant` gets no watched-repo cwd.
- **Sequential queue** — continuations and CLI runs are normal queued jobs; one run against DEV at a time.
- **Surface integration errors loudly** — SSE demux drops are logged+counted, never swallowed; missing models throw.
- **Sanitize all data leaving the system** — continuation inputs and chat ingress/egress pass `sanitizer.ts`; `logs→chat` is added as a covered egress.
- **Gates always bind** — continuations traverse validate+execute+reviewer (+future change-coverage) with no skip; the human cannot coerce green.

---

## 7. Phased roadmap (value-first, risk-down)

| Phase | Status | Ships | Risk |
|---|---|---|---|
| **0. Single-funnel + spike** | ✅ done | `cli.ts` through the queue (`src/server/runner.ts`); SDK pinned exact; static spike (§10) | Low |
| **1. Ink TUI (poll)** | ✅ done | Host-only Ink TUI (`src/tui/`, `bin/panchito`) over the existing API + polling; `bin/qa` kept | Low |
| **2. Lite chat** | ✅ done | `qa-assistant` agent + `POST /api/runs/:id/ask`; ingress+egress sanitization (`src/server/chat.ts`) | Low-med |
| **3. Continuation** | ✅ done | `POST /api/runs/:id/continue`; new queued run, same-sha checkout, `fixCases` reuse, anti-coercion prompt rail | Med-high |
| **4. SSE live activity** | ⏳ scaffold | Pure, tested, OFF-by-default router (`src/integrations/agent-activity.ts`); live subscription gated on the live spike | High |

> **Implemented deltas vs. the plan (deferred refinements, not regressions):** the PR
> *provenance label* (Phase 3) is recorded as `RunRecord.parentRunId` + the anti-coercion
> prompt rail, but is **not yet stamped onto the PR body** (threading `publish.ts`) — a
> follow-up. The `qa-assistant` **model id** (`opencode-go/deepseek-v4-flash`) is a
> candidate to **confirm via `opencode models`**; a wrong id fails loudly (no silent
> degrade). The interactive Ink **launcher** (`ink-select-input`) ships but is only
> exercised on a TTY (not headless-tested). Phase 4's **live subscription** is intentionally
> unwired pending the live spike.

---

## 8. Open questions

- Exact context budget for `qa-assistant` (N cases + log truncation length) and the flash/lite model id (confirm via `opencode models`).
- Whether the maintainer's out-of-queue execution should be formally documented as a carve-out to "one run at a time" (non-DEV-touching; may overlap) before SSE demux relies on it.
- Whether Phase-4 introduces the first real `EventBus` consumer (SSE-replay endpoint) and therefore the smallest read-side emitter — decide when the second consumer is concrete, not before.
- Restart-recovery: accept "re-trigger after restart" (documented) vs. a minimal durable run log for boot reconciliation — pick when continuation usage shows whether mid-run restarts are painful.

---

## 9. Forward note: OpenClaw (future, out of scope)

OpenClaw is a **known future channel client** of this same control API — a separate service (Telegram/WhatsApp/web chat) that absorbs the TUI's capabilities for non-terminal humans and adds **historical** Q&A. It changes the *interface*, not the engine. Design every verb here channel-agnostically (`{app, sha, mode, guidance}`, `{cases, guidance}`, `{question}` over the queue + sanitizer) so OpenClaw is later "just another client" with zero orchestrator change. No OpenClaw implementation detail belongs in this doc; its historical-Q&A scope is what the future deterministic ledger serves, distinct from this layer's live-run chat.

---

## 10. Phase 0 spike notes (static SDK inspection)

The live-server part of the spike (run `opencode serve`, subscribe, observe taxonomy under concurrency) is **owed before Phase 4** — it needs the key + a running engine. The **static** part is done by reading the installed `@opencode-ai/sdk`:

- **`/event` is a server-global SSE firehose** (`dist/gen/sdk.gen.js:842`), not a per-session stream. Events carry a `sessionID` — any feed MUST demux by it. Confirms the Phase-4 design (capture each run's session id + reviewer child via `session.children`, route by an allowlisted `sessionId→runId` set, advisory-only).
- **SSE has no replay**: `Last-Event-ID` is handled by the transport (`core/serverSentEvents.gen.js:17`) but the `/event` stream emits no per-event ids — dropped events are lost. So SSE can never be authoritative for a verdict.
- **`EventSessionIdle`** exists — usable as a "turn finished" signal, but the **blocking `session.prompt` result stays the sole verdict authority** (idle can precede the parsed verdict).
- **Sessions**: `session.create/list/delete` exist; the current client disposes per turn. No evidence of a safe long-lived resume contract → **session-resume stays cut** (Phase 3 uses a fresh session seeded via `fixCases`).
- **SDK version skew**: root resolves `@opencode-ai/sdk@1.15.13`; `opencode/` resolves `1.16.0` (via `@opencode-ai/plugin@1.16.0`); the global `opencode-ai` in `opencode/Dockerfile` is unpinned. **Decision:** pin root to exact `1.15.13` now (deterministic, gate-green). Aligning the client to the server's actual `opencode` version is a Phase-4 follow-up, resolved by the live spike (tracked with `HANDOFF.md` §5.7's version-pinning).

**Phase 0 status: DONE** — `src/cli.ts` routed through the shared funnel (`src/server/runner.ts`); the funnel is unit-tested (`runner.test.ts`, incl. the "no synchronous bypass" assertion); SDK pinned exact; static spike recorded. The live SSE/session spike is gated to Phase 4.
