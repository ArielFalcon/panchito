# panchito (Go / Bubble Tea client)

The installable terminal client for the Panchito control plane — an **independent
channel** of the orchestrator's Channel Gateway, alongside (eventually replacing)
the Ink TUI. See [docs/tui-vnext.md](../docs/tui-vnext.md) for the full design.

Its own Go module inside the monorepo: Go cannot import the TS orchestrator, so the
language boundary enforces the contract. The wire types are **generated** from the
orchestrator's published `contract/openapi.json` (no hand-written drift).

## Status — Phase E, in progress

- ✅ Module scaffold + contract codegen (`internal/contract/types.gen.go`) for the
  command/entity types (RunRecord, QaCase, AppView, the command DTOs). Builds + a
  round-trip test proves the contract decodes in Go.
- ✅ **RunEvent decoding** (`internal/events`): a hand-written envelope +
  type-switch decoder for the 15-variant SSE union (which does not codegen into
  idiomatic Go). Tolerant reader — an unknown event type becomes `UnknownEvent`,
  never an error. Round-trip tested against canonical contract JSON.
- ✅ HTTP + SSE client (`internal/api`): typed command verbs over the contract
  DTOs, and a `text/event-stream` reader that decodes RunEvents with `Last-Event-ID`
  reconnect (stops on the terminal `run.verdict`). UI-agnostic, stdlib-only.
- ✅ Bubble Tea skeleton (`internal/ui`, `cmd/panchito`): an Elm root model routing
  to per-screen sub-models, the brand palette in `theme.go`. **connect** (host +
  token, probes ListApps as the auth check) and **home** (app list) screens wired
  to `api.Client`.
- ✅ **launcher** (target → mode → shadow → CreateRun) and a **live** screen that
  consumes the RunEvent SSE stream end-to-end (a goroutine pushes events onto a
  channel; a read-next `tea.Cmd` hands each to the loop, so the model mutates only
  in `Update`). E4b renders a simple event feed + verdict.
- ✅ E4c: the live screen folds the stream into structured state and renders the
  dedicated **PhaseProgress** (gate→…→decide stepper), **AgentActivityPane**
  (running tool with an animated spinner, by callID), **PlanChecklist** (☐◐☑), and
  **TestList** (spinner→✓/✗ + duration, failure detail) components.
- ✅ E4d: **chat** — read-only run Q&A (the qa-assistant) with Markdown answers
  rendered by **Glamour**; and **continue** (`c` on a finished run re-runs the
  failed cases as a new run). Opened from the live screen with `a` / `c`.
- ⏳ OS token storage (go-keyring); parity screens (onboarding, history) before
  the Phase F cutover that replaces the Ink TUI.

## Run

```bash
go run ./cmd/panchito     # connects to localhost:8080 by default
```

## Commands

```bash
make gen     # regenerate contract types from ../contract/openapi.json
make build   # go build ./...
make test    # go test ./...
```
