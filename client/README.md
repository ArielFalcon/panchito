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
- ⏳ The Bubble Tea screens (connect / home / launcher / live / summary / chat),
  `theme.json`, OS token storage.

## Commands

```bash
make gen     # regenerate contract types from ../contract/openapi.json
make build   # go build ./...
make test    # go test ./...
```
