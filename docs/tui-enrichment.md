# Enriching the ai-pipeline TUI — grounded plan

The TUI (`src/tui/`) is a thin Ink/React **client** of the control API (`src/server/api.ts`). It renders one ephemeral `RunRecord` (`src/types.ts`) and never runs the pipeline. The deterministic core (`src/pipeline.ts`, `src/qa/*`, `src/integrations/*`) is off-limits except for **additive, optional** fields fed through the existing injected callbacks. Everything below respects: the core stays deterministic and untouched in behavior; the TUI is a client; secrets go via env/Doppler and are never committed; data is sanitized on every boundary.

## Current state (verified)

| Concern | Today | File:line |
|---|---|---|
| Live view | One `RunRecord`, 4-step linear tracker, case list capped at 12, verdict banner | `Dashboard.tsx:12,27,52,71` |
| Case stream | `onCase` → `addCase` upsert-by-name | `pipeline.ts:146`, `runner.ts:51`, `history.ts:55` |
| Case shape | `{ name, status, detail? }` — no flow/objective/reason | `types.ts:61` |
| Specs | `specs.objective?` declared but filled as `{ name }` only | `types.ts:91`, `runner.ts:52` |
| Metadata | `QaTestMeta { id, objective, flow, ... }` validated then **discarded** | `metadata.ts:8`, `pipeline.ts:269` |
| PW names | `suite.title › spec.title` — not aligned to manifest ids | `playwright-report.ts:53` |
| Code target | `runCodeTests` returns `cases: []` | `execute.ts:92` |
| Launcher | Two bare `SelectInput`s, no descriptions, no add-repo | `app.tsx:72` |
| Chat | One run-scoped route `/api/runs/:id/ask`; CLI-only, prints & exits | `api.ts:43`, `index.tsx:133` |
| Assistant | Read-only, no-tools `qa-assistant`, neutral `/tmp` cwd | `index.ts:157,168`, `opencode.json` |

## Requirement 1 — real-time test view with history

**Data/API.** Enrich `QaCase` → `{ name, status, detail?, flow?, objective?, reason? }` (additive; `QaRunResult`, `addCase`, chat context keep compiling). Add `PipelineDeps.loadManifest(e2eDir): Promise<QaTestMeta[]>` (default reads `e2e/.qa/manifest.json`, reusing `validateManifest`). After Filter B (`pipeline.ts:269-282`) build a `Map<id, QaTestMeta>`; in the `onCase` path attach `flow`/`objective` by matching the PW name to a manifest id (exact id-in-name → flow-prefix → no-match leaves fields `undefined` = today's behavior). Derive `reason` from `changeRef.type` + commit `intent`. Fill `specs.objective` at generation by changing the `onSpecs` payload to `Array<{ name; objective?; flow? }>` (`pipeline.ts:147,257`; `runner.ts:52`).

**TUI architecture.**
- **`HistoryList`** built on Ink `<Static>` — each finalized case is an immutable row: **title = flow**, **subtitle = reason + objective** while pending, flipping to a colored status line (`caseColor`/`caseIcon`, `format.ts:68`) on finish. `Static` only re-renders new items → no flicker.
- **`Section`** per `PIPELINE_STEP`: full detail while active; collapses to a one-line summary when done (`sectionSummary(cases)` → `"execute — 8 tests run, 7 passed, 1 failed"`). Only the active section is expanded.
- All string logic in `format.ts` (`title`, `subtitle`, `sectionSummary`) so it is unit-tested.
- **Code target** has no cases → render a single non-expandable pass/fail section and say so.

**Files:** `types.ts`, `pipeline.ts`, `qa/execute.ts`, `qa/metadata.ts`, `server/runner.ts`, `tui/format.ts` (+test), `tui/components/Dashboard.tsx` (+test), new `Section.tsx`, `HistoryList.tsx`.

## Requirement 2 — richer entry / dashboard menu

**Data/API.** `MODE_INFO`/`TARGET_INFO` description maps in `format.ts` (pure, testable) sourced from the doc comments already in `types.ts:6-22`. Optional `POST /api/apps` (`ApiDeps.addApp?`) that writes `config/apps/<name>.yaml` using **`${VAR}` references** and writes the secret to gitignored `.env` — **never the literal secret into YAML** (invariant). Launcher degrades to read-only selection when `addApp` is unconfigured.

**TUI architecture.** Convert `Launcher` into a state-machine **`Menu`** (`home | pick-app | add-repo | pick-mode | pick-target | running`). Home lists modes **with descriptions**, targets, configured apps (shadow/private badges from `/api/apps`), an **"Add a new repo…"** item, and an **"Ask about this tool"** item (feeds Requirement 3). The add-repo form collects repo + baseUrl and, **only when marked private**, prompts for a token via `<TextInput mask='*'>`; submit POSTs to `/api/apps` or prints manual-onboarding steps. `useFocus`/`useFocusManager` give each stage input ownership; Tab advances.

**Files:** `tui/app.tsx` (Launcher→Menu), new `Menu.tsx`, `AddRepoForm.tsx`, `ModeInfo.tsx` (+tests), `tui/format.ts` (+test), `tui/index.tsx`; optionally `server/api.ts`, `orchestrator/config-loader.ts`, `tui/client.ts`.

## Requirement 3 — chat visible & accessible throughout

**Data/API.** Add tool-level `POST /api/chat` (`ApiDeps.toolAsk?`) routed to a new **`qa-tool-assistant`** agent (broader prompt: modes, targets, onboarding; mirror `qa-assistant`'s read-only/no-tools config). Add `QaClient.chat(question)` alongside `ask`. Persist the run-scoped trail as `RunRecord.chat?: Array<{ q; a; at }>` appended in `handleAsk` so it survives the 1.2 s poll. Keep request/response (no SSE); the TUI runs chat on an **independent async path** so the poll loop never blocks.

**TUI architecture.** New **`ChatPanel`** (input via `ink-text-input`, scrollable transcript). Compose `Watch` as a split: `<Box flexDirection='row'>` [ Dashboard | ChatPanel ]; `useFocus('dashboard'|'chat')` + Tab to switch; `useInput(..., { isActive: isFocused })` so keystrokes route only to the focused pane and never race the poller. The same `ChatPanel`, fed by `client.chat`, is reachable from the Menu's "Ask about this tool" item before any run.

**Files:** `server/api.ts`, `server/chat.ts`, `types.ts`, `index.ts`, `opencode/agent/qa-tool-assistant.md`, `opencode/opencode.json`, `tui/client.ts`, new `tui/components/ChatPanel.tsx` (+test), `tui/app.tsx`.

## Phased rollout (value-first, each gate-verifiable)

0. **Refactor seam** — split Dashboard into presentational pieces, no visual change. Gate: existing tests + typecheck green.
1. **Req 2 launcher** — pure client, zero core change. Gate: ink-testing-library drives the wizard.
2. **Req 3 chat** — `/api/chat` + agent + ChatPanel + split pane. Gate: `api.test.ts` for the new route; ChatPanel test; poll-while-typing test.
3. **Req 1 data model** — QaCase fields + loadManifest + enrich + onSpecs. Gate: match/enrich unit tests; pipeline tests with stubs.
4. **Req 1 UI** — Static history + collapsible sections. Gate: format + HistoryList tests; Dashboard test.
5. **Req 2 add-repo write (optional, gated)** — POST /api/apps with `${VAR}` refs. Gate: test asserts the YAML holds `${VAR}` not the secret; `.env` stays gitignored.

## Cross-cutting concerns

- **Focus/keyboard:** every focusable region uses `useFocus`; inputs gate on `{ isActive: isFocused }` so the 1.2 s poller and chat input never fight for keystrokes.
- **Polling-while-typing:** chat is a separate async submit; the `tick()` loop (`app.tsx:31`) is untouched and keeps its 5-miss tolerance.
- **Secret handling:** add-repo writes **only** `${VAR}` references into YAML; secrets land in gitignored `.env`/Doppler. The TUI never echoes a token; `mask='*'`.
- **No orchestrator coupling:** all new core fields are additive/optional and flow through existing injected callbacks; the agent stays read-only; new assistants have no tools and run on `/tmp`.
- **Sanitize:** the tool-chat egress passes through `sanitizeText` like the run-scoped ask; the persisted `RunRecord.chat` trail is sanitized in/out.

## Open questions

See the structured `openQuestions` — chiefly: (1) is `POST /api/apps` write allowed or should add-repo stay advisory; (2) align PW spec titles to manifest ids in the agent prompt vs. best-effort matching; (3) derive `reason` vs. add an explicit `QaTestMeta` field; (4) per-test granularity for code mode; (5) server- vs TUI-side chat persistence; (6) streaming vs spinner; (7) alternate-screen vs inline.
