# TUI VNext — installable Go/Bubble Tea client over an abstracted control plane

Replace the host-only Ink TUI with a standalone **Go + Bubble Tea** client that is
an **independent channel** of a new, abstracted, encapsulated control-plane layer.
The same layer later serves OpenClaw with zero orchestrator change. The bet is
**not** "Bubble Tea looks better" (the visual ceiling is identical and Claude
Code itself is Ink); it is **distribution** (single static binary) plus a
**real-time, domain-parsed live view** of what the agent and the tests are doing.

> **Status:** Planning — consolidated and ready to implement. Phase A (spike) not started.
> **Scope:** the client, the control-plane contract, the live-event pipeline, the read-side event bus.
> **Relationship:** extends and supersedes [interactive-layer.md](interactive-layer.md) for the client + live-activity surface. The orchestrator engine (pipeline, queue, harness) is **untouched** — this changes the interface, not the engine.
> **Base:** engram entry #363 (TUI VNext requirements guide) + decisions #366.

---

## Decisions at a glance

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Go + Bubble Tea**, replace Ink entirely (no coexistence) | Single-user personal project — no maintainability/migration tax. The win is a distributable binary, not visuals. |
| D2 | **zod is the single source of truth** for the wire contract | `z.infer` for server types (server ≡ schema by construction) → OpenAPI → codegen Go. Replaces the lost `import "../types"` guarantee. |
| D3 | **Channel Gateway** = the only client-facing layer | Encapsulates commands + events; shared by VNext *and* OpenClaw. The contract work is paid once. |
| D4 | **Real-time = two hops, replay on the hop we own** | OpenCode firehose → domain events → SSE with `seq` + `Last-Event-ID` resume. Breaks the minutes-long "black box". |
| D5 | **OpenCode SDK v2 for the event path** (gated on Phase A) | v2 adds workspace-scoped subscribe + per-aggregate replay — the headless gap v1 had. Verdict path keeps the blocking prompt. |
| D6 | **Domain events, never raw prose/logs** | Tests, agent activity, and the plan each get a dedicated component. Model prose (`delta`/`TextPart`) is dropped. |
| D7 | **Read-side event bus**, hand-rolled (`node:events`), no broker | Single-process orchestrator; the bus observes, never coordinates. Implemented: [src/server/event-bus.ts](../src/server/event-bus.ts). |
| D8 | **Go client lives in the same repo**, own `go.mod` | Monorepo already has two services; the module boundary (not the repo) enforces the language seam. |

---

## 1. Problem & objectives

The orchestrator speaks webhook + CLI flags. A human cannot intuitively launch a
run, **cannot see what the agent is doing** during the multi-minute blocking
generation turn (the "black box"), and gets raw log lines instead of structured
state. VNext targets three priorities, in order:

1. **Optimal UI/UX** — dynamic, modern terminal aesthetic.
2. **Real-time OpenCode feedback** — no waiting minutes to see a state change.
3. **Every resource parsed into domain logic** — a running test is a dedicated
   component with its own aesthetic and logic, never a generic log line.

All three are enabled by the same thing: an **abstracted, encapsulated layer**
between the orchestrator and its clients. That layer is defined first.

---

## 2. Architecture — the Channel Gateway

Today the contract is implicit (the Ink TUI imports `../types`). An independent
client in another language cannot. The fix is to promote the contract to an
**explicit, versioned, published artifact** that is the only surface clients touch.

```
                         ┌──────────────────────────────────────────┐
   OpenCode serve        │            ORCHESTRATOR (src/)            │
   /event (v2 scoped) ───┼─► agent-activity  ┐                      │
   demux by sessionID    │   (demux+sanitize)│                      │
                         │                   ▼                      │
   pipeline.ts ──onStep──┼─► ┌─────────────────────────────┐        │
   execute.ts ──per-test─┼─► │   EventBus<RunEvent>         │        │
                         │   │   (read-side fan-out)        │        │
                         │   └──────────────┬──────────────┘        │
                         │                  ▼                       │
   commands ────POST─────┼──────► ┌───────────────────────┐         │
   (createRun, ask,      │        │   CHANNEL GATEWAY      │         │
    continue, cancel)    │        │  command verbs → queue │         │
                         │        │  SSE events + replay   │         │
                         │        │  auth + version h/s    │         │
                         │        │  sanitize egress       │         │
                         │        └───────┬───────┬───────┘         │
                         └────────────────┼───────┼─────────────────┘
                                 contract │       │ contract (openapi.json, versioned)
                              ┌───────────▼──┐  ┌─▼──────────────┐
                              │ panchito (Go)│  │ OpenClaw        │
                              │ Bubble Tea   │  │ (future)        │
                              └──────────────┘  └─────────────────┘
```

**Gateway properties:**
- It is the **only** thing clients see. Orchestrator internals (`pipeline.ts`,
  `opencode-client.ts`, `execute.ts`) never speak to clients directly.
- **Commands** (client→server): the existing verbs in [src/tui/client.ts](../src/tui/client.ts)
  (`createRun`, `getRun`, `ask`, `continue`, `cancel`, `apps`…), entering the
  **same sequential queue** and **same sanitizer**.
- **Events** (server→client): a typed `RunEvent` stream per run.
- VNext and OpenClaw consume it identically — the channel-agnostic contract
  [interactive-layer.md](interactive-layer.md) already mandated.

> **Why the EventBus is justified now:** interactive-layer.md §3.4 said build it
> "when the second consumer is concrete, not before." There are now **two**
> concrete consumers (live TUI + OpenClaw), so the threshold is crossed by the
> doc's own rule.

---

## 3. The contract layer — zod → OpenAPI → Go

```
src/contract/*.ts  (zod: command DTOs + RunEvent)   ← SINGLE source of truth
   │
   ├─ z.infer<>  ─────────────►  server TS types   (server ≡ schema: drift impossible)
   │
   └─ zod-to-openapi ─► contract/openapi.json (versioned: /api/v1)
                              │
                              └─ oapi-codegen ─► client/gen/ (Go structs + typed client)
```

| Concern | Decision |
|---------|----------|
| Source of truth | **zod** schemas. `z.infer` gives the server type → server and schema are the *same object*. Only the schema→Go edge remains. |
| Go types | **Generated, never hand-written.** Hand-maintained structs + "integration tests cover it" is the trap that reintroduces drift. |
| Contract test (CI) | Validate real handler + event outputs (existing fixtures in [src/server/api.test.ts](../src/server/api.test.ts)) against `openapi.json`. Server drift → CI red. **This replaces the lost shared-import guarantee.** |
| Versioning | `/api/v1`. A Homebrew binary lags the server *in time*; the server must evolve without breaking old binaries. |
| Version handshake | The **connect** screen sends client version → server returns its version + capabilities → "update panchito" on mismatch. |
| Evolution rule | Tolerant reader: ignore unknown fields, never require a maybe-absent field. |
| Tooling | `zod` (4.x **native** `z.toJSONSchema`, `target: "openapi-3.0"` — no extra dep) for emission; `oapi-codegen` on the Go side (Phase E). |

---

## 4. The domain event model

The stream is **not** logs. It is a discriminated union, defined in zod (so the
Go client receives it typed). Sketch:

```ts
RunEvent =
  | { type: "run.started",    runId, app, sha, mode, target }
  | { type: "step.changed",   step, detail }              // gate|classify|generate|validate|execute|decide
  | { type: "agent.activity", kind, target, status, workerId? }  // analyzing|writing|command|subagent
  | { type: "plan.updated",   todos: { content, status }[] }
  | { type: "spec.written",   file }
  | { type: "test.discovered",name, file }
  | { type: "test.started",   name }
  | { type: "test.passed",    name, durationMs }
  | { type: "test.failed",    name, durationMs, detail }
  | { type: "test.flaky",     name, attempts }
  | { type: "reviewer.verdict", approved, reasons[] }
  | { type: "coverage.computed", changedLines, coveredLines }   // future change-coverage
  | { type: "run.verdict",    verdict, passed, failed }
  | { type: "agent.error",    detail }
  | { type: "log.line",       level, text }              // fallback: only what is NOT a domain event
  // every event also carries a monotonic `seq` for replay
```

Two parse points produce these:
- **Agent activity** — finish the [src/integrations/agent-activity.ts](../src/integrations/agent-activity.ts)
  router: consume OpenCode's event stream, **demux by `sessionID`**, map to
  `agent.activity`, drop model prose, sanitize on egress.
- **Live tests** — stream Playwright's reporter (JSON, line by line) in
  [src/qa/execute.ts](../src/qa/execute.ts) → `test.*` events as they happen.

All events are **advisory-only**: they never decide a verdict. The blocking
`session.prompt` result stays the sole verdict authority.

---

## 5. SDK v2 decision (gated on Phase A)

v2 ships in the **same installed package** (1.15.13, import `@opencode-ai/sdk/v2`)
— zero install cost — and is built for headless/server consumption like ours.

| v2 capability | Fixes |
|---------------|-------|
| `event.subscribe({ directory, workspace })` | Workspace-**scoped** subscription; kills v1's global-firehose maintainer interleaving. |
| `history.list({ body: { [aggregateID]: lastSeq } })` | Per-aggregate **resume-from-seq at the source** (v1 had no replay). |
| `sync.replay({ events })`, `sync.start()` | Ordered history replay; workspace sync loops. |
| `session.prompt({ delivery })` | Async/**queued** delivery vs v1's one long blocking request. |
| `createOpencodeClient({ directory, experimental_workspaceID })` | First-class multi-workspace headless. |

**Split decision (fits the existing seam):**

| Path | SDK | Where | Why |
|------|-----|-------|-----|
| Observability / live events | **v2** | [agent-activity.ts](../src/integrations/agent-activity.ts) | Advisory-only → zero verdict risk; workspace scoping fits one-serve-many-mirrors; replay closes the real-time gap. |
| Generation / verdict | **blocking prompt** (v1 semantics) | [opencode-client.ts](../src/integrations/opencode-client.ts) | Do not move the determinism keystone to queued delivery. The awaited prompt stays the sole verdict authority. |

Both modules already sit behind `OpencodeDeps`, so v1↔v2 is **one swappable
boundary**, never leaked upward (everything enters via the narrow `AgentActivity`
type). **Phase A must confirm** against a real `opencode serve`: (a) v2 scoped
subscribe + `history.list` replay work and carry tool/todo shapes with
`ToolState.title`; (b) a deterministic verdict path survives. If yes, v2 provides
hop-1 replay and we keep only the hop-2 ring buffer.

---

## 6. SDK resource → visual mapping

The "where to use each SDK resource." Source → domain event → component → visual.

### Agent activity pane (breaks the `generate` black box)
| SDK source | Fields | Domain event | Component | Visual |
|---|---|---|---|---|
| `ToolPart` state=`running` (read/grep/glob/list/webfetch) | `tool`, `callID`, `state.input`, `state.title` | `agent.activity{kind:analyzing,status:running}` | **AgentActivityPane** (active line) | spinner + verb ("Revisando X"), keyed by `callID`, in-place |
| `ToolPart` state=`completed` | `state.title`, `state.time` | `agent.activity{status:completed}` | AgentActivityPane (history) | ✓ dimmed, collapses |
| `ToolPart` tool=write/edit/patch | `state.input.filePath` | `spec.written` | **SpecList** | file row + "written" badge |
| `ToolPart` tool=bash | `state.input.command` | `agent.activity{kind:command}` | AgentActivityPane | `$ cmd` monospace |
| `ToolPart` tool=task (subagent) | `state.input.description` | `agent.activity{kind:subagent,workerId}` | **SubAgentPanel** | nested worker card |
| `delta` / `TextPart` / `ReasoningPart` | — | **DROPPED** | — | never shown (avoids cut prose fragments) |

> Use `state.title` (authored by OpenCode) instead of reconstructing from `input`.
> Surface **all** tools, not just write/edit/bash — read/grep/glob are the
> "analyzing" signals.

### Plan checklist (best "what it's thinking" source)
| `EventTodoUpdated` | `todos[].content`, `status` | `plan.updated` | **PlanChecklist** | live ☐ ◐ ☑ with pending→in_progress→completed |

### Live tests (dedicated component, not a log)
| Streaming Playwright reporter ([execute.ts](../src/qa/execute.ts), not SDK) | name, status, duration | `test.discovered/started/passed/failed/flaky` | **TestList** | row per test: spinner→icon, duration, expandable failure |

### Phases & verdict
| `pipeline.onStep` | `step` | `step.changed` | **PhaseProgress** | stepper gate→…→decide |
| `EventSessionIdle` | `sessionID` | `turn.idle` (hint) | PhaseProgress | "generation done" → validate |
| `EventSessionError` | `error` | `agent.error` | banner | red callout (`#c0392b`) |
| reviewer parse ([opencode-client.ts](../src/integrations/opencode-client.ts)) | approved, reasons | `reviewer.verdict` | **ReviewerCard** | approve/reject badge + reasons |
| v2 `history.list` / sync seq | `aggregateID`, `seq` | resume | — | gapless reconnect |

---

## 7. The read-side event bus

**Implemented** this iteration: [src/server/event-bus.ts](../src/server/event-bus.ts)
+ [test](../src/server/event-bus.test.ts) (6 tests green, typecheck clean).

| Aspect | Decision |
|--------|----------|
| Role | Single **read-side** fan-out: producers (pipeline callbacks, activity router, Playwright stream) → consumers (SSE→TUI, SSE→OpenClaw, history projection, metrics). |
| Hard boundary | **Never coordinates work.** Commands flow through the JobQueue + `pipeline.ts` control flow; no consumer feeds state back to a producer. Keeps the lifecycle authority single. |
| Sub-agents | The bus **observes**, does not schedule. `parallelDiff` workers are coordinated by `pipeline.ts` + the queue; the reviewer subagent is coordinated inside OpenCode. Activity is tagged with `workerId` for a multi-worker view. |
| Implementation | Zero-dep typed wrapper over `node:events` (**not** emittery): `on(emitter, key, { signal })` gives an AbortSignal-aware async iterator that matches the SSE request lifecycle; the project ethos is minimalist/pin-everything. |
| API | `emit(key, payload)` · `on(key, cb) → unsubscribe` · `next(key, signal?)` · `stream(key, signal)` (async iterator for SSE). |
| Not a broker | Single-process orchestrator with a sequential queue — Redis/NATS/Kafka would be over-engineering and contradict the "no Spring-Batch persistence" stance. |

---

## 8. The Go / Bubble Tea client

Bubble Tea's Elm architecture **is** an event fold — a natural fit for the stream.

```
SSE RunEvent ──► tea.Msg ──► Update(model, msg) ──► View(model)
                                                     ├─ ConnectScreen  (version handshake, token)
                                                     ├─ HomeScreen
                                                     ├─ Launcher       (app→target→mode→shadow)
                                                     ├─ LiveRun
                                                     │    ├─ PhaseProgress
                                                     │    ├─ AgentActivityPane
                                                     │    ├─ PlanChecklist
                                                     │    └─ TestList   ◄── dedicated
                                                     ├─ Summary
                                                     └─ Chat           (Glamour: markdown + highlight)
```

| Concern | Decision |
|---------|----------|
| Styling | Lip Gloss + Bubbles; **Glamour** for the markdown chat (the one real visual edge over Ink). |
| Brand colors | Extract the palette to a language-neutral **`contract/theme.json`** consumed by both the (legacy) TS theme and the Go client, so brand never drifts. Detected today in [theme.tsx](../src/tui/theme.tsx): `#3b7a57` success · `#c0392b` error · `#c2891b` warning · `#4a6877` info · `#6b685b` muted · `#c24e2c` accent. Lip Gloss takes hex directly (`lipgloss.Color("#3b7a57")`). |
| Reconnect | `Last-Event-ID` (hop-2) + v2 `history.list` (hop-1). |
| Token storage | Per-OS secret store (`zalando/go-keyring`: Keychain / secret-service / wincred), on the connect screen. |
| Watch semantics | Port the subtle keymap exactly: detach (`q`/Esc) never cancels; only `x`×2 cancels ([app.tsx:6-8](../src/tui/app.tsx)). |

---

## 9. Repo layout

The repo is already a monorepo (two services). The **module** boundary, not the
repo boundary, enforces the language seam — Go cannot import TS.

```
ai-pipeline/
├─ src/
│  └─ contract/   # zod schemas — the SOURCE OF TRUTH (TS; server uses z.infer)
├─ opencode/      # the agentic engine
├─ contract/      # GENERATED neutral artifacts: openapi.json + theme.json (Go vendors these)
└─ client/        # NEW: own go.mod, Bubble Tea, gen/ from contract/openapi.json
```

The zod source lives in `src/contract/` because it is TypeScript consumed by the
server (`z.infer`) and is already covered by tsconfig + the `src/**/*.test.ts`
gate. Only the **generated, language-neutral** artifacts (`openapi.json`,
`theme.json`) land in the root `contract/` for the Go client to vendor.

The orchestrator Docker image stays Node-only; the Go binary builds separately
(Homebrew), never into the container — zero image bloat.

---

## 10. Invariants preserved

- Deterministic infra (`src/`) stays separate from the agent (`opencode/`); v2
  events map into one narrow `src`-owned type, never leaking OpenCode's vocabulary up.
- The LLM agent stays **read-only** on watched repos; only the orchestrator does git writes.
- **Sequential queue** — commands and continuations are normal queued jobs.
- **Surface integration errors loudly** — firehose demux drops are logged+counted, never swallowed.
- **Sanitize all egress** — every `RunEvent` passes the sanitizer; `logs→chat` stays covered.
- **One verdict authority** — the blocking `session.prompt`; live events are advisory-only.

---

## 11. Phased roadmap

Sequenced to retire the biggest unknown first (priority #2 depends on the firehose).

| Phase | Ships | De-risks |
|-------|-------|----------|
| **A. OpenCode live spike** | Run `opencode serve`; confirm v2 scoped subscribe + `history.list` replay + `ToolState.title`; confirm a deterministic verdict path. | The granularity of the whole live view. **Prerequisite.** |
| **B. Contract layer** | ✅ RunEvent + command DTOs in zod ([events.ts](../src/contract/events.ts), [commands.ts](../src/contract/commands.ts)); native OpenAPI emission ([openapi.ts](../src/contract/openapi.ts), `npm run contract:gen` → [contract/openapi.json](../contract/openapi.json)); contract test + compile-time drift guard vs `src/types.ts`. **Remaining:** wire the contract test into CI; Go codegen happens in Phase E. | Drift; foundation shared with OpenClaw. |
| **C. Event bus + domain events** | Bus ✅ done; finish `agent-activity.ts` demux; stream Playwright reporter; emit `RunEvent`. | Produces the live data. |
| **D. Gateway SSE + replay** | `GET /api/v1/runs/:id/events` with `seq` + ring buffer + `Last-Event-ID`; version handshake. | The encapsulated client-facing layer. |
| **E. Go Bubble Tea TUI** | connect→home→launcher→live→summary→chat; TestList + AgentActivityPane + PlanChecklist; Glamour; reconnect; token store. | The product. |
| **F. Cutover** | `bin/panchito` → Go binary; delete `src/tui/`; drop `ink`/`react`/`ink-*`; Homebrew formula. | One switch + deletion; orchestrator repo ends with zero UI deps. |

---

## 12. Open decisions

- **Verdict on v2 vs v1 blocking prompt** — confirm in Phase A which blocking
  mode survives as the sole authority.
- **Hop-1 replay reliance** — if v2 `history.list` is solid, drop the custom
  hop-1 buffer and keep only hop-2; decide after the spike.
- **OpenClaw ordering** — VNext and OpenClaw share this layer; decide their
  relative priority once the gateway exists.

## 13. Explicitly cut

- Coexistence / paridad gates / Ink feature-freeze — N/A for a single-user project; Ink is deleted at cutover (F).
- A message broker for the bus — over-engineering for one process.
- Event-sourcing rewrite of `RunRecord` — it stays directly-mutated (per interactive-layer.md §3.4).
- Moving the verdict to v2 queued delivery — keeps the determinism keystone on the blocking prompt.
