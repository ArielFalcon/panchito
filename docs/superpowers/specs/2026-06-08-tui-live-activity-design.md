# TUI live activity — real-time agent feedback (design)

**Date:** 2026-06-08
**Status:** implemented (Phase 1 + Phase 2) — `npm test` (446) + `npm run typecheck` green.
**Scope:** Phase 1 (generate panel + focus card + message fix) **and** Phase 2 (live execute streaming).

## Problem

During a run, the TUI shows a single status line next to the active phase. For the
`generate` phase — which can run 10–30 minutes — that line is both **uninformative**
(one cropped line, no history, no counters) and **broken** (e.g. `generate tests —
"file": "s`).

Root cause, traced through the channel:

1. **The source is noise.** `routeEvent` ([agent-activity.ts:56-60](../../../src/integrations/agent-activity.ts))
   takes the `delta` of `message.part.updated` events. A delta is an arbitrary fragment
   of the model's stream — a few tokens, often mid-word or mid-JSON (when the agent is
   writing/echoing JSON).
2. **It is cropped blindly.** [Dashboard.tsx:53-59](../../../src/tui/components/Dashboard.tsx)
   takes that fragment and does `line.slice(0, 80)`. A fragment like `... "file": "src/...`
   becomes `"file": "s`.
3. **The good signal is thrown away.** Clean structured events — `file.edited` (which spec),
   `command.executed` (what ran), `todo.updated` (the agent's plan) — are flattened into a
   single prefixed string in [opencode-client.ts:98-116](../../../src/integrations/opencode-client.ts),
   losing `kind`. The TUI then shows only **one** line, usually overwritten by the noisy deltas.

Proof the signal already exists: the `qa-assistant` chat correctly reported "wrote 61 tests,
running the existing suite, 7 min elapsed" — because that comes from `activityRouter.contextForRun()`
([agent-activity.ts:133-149](../../../src/integrations/agent-activity.ts)), the same context used to
enrich the 15s heartbeat in [runner.ts:88-104](../../../src/server/runner.ts). The data is there; it
is just not surfaced in the dashboard and the wrong (prose) source is shown instead.

Execution is **batch**, not streaming: [execute.ts:125-147](../../../src/qa/execute.ts) runs
`--reporter=json`, accumulates all stdout, and parses the full report only on `close`. So there is
no per-test signal during `execute` today; `cases` appear all at once.

## Goals

- Kill the broken-fragment text at the root: never render raw model-stream deltas.
- Under the active phase, a live panel: the agent's **todo checklist**, **files/specs written**
  (+ count), **commands run**, and a **focus card** highlighting the current unit of work with its
  own nested info.
- A per-phase **elapsed clock** so a long phase never looks frozen.
- Phase 2: stream Playwright execution so the **current test** and the **pass/fail bar** update live.

## Non-goals

- No change to verdict classification logic (Phase 2 only changes where the JSON report is read from).
- No new network endpoints; the TUI keeps polling `GET /api/runs/:id` at 1200ms.
- The live feed stays **advisory-only** (same contract as the existing SSE router): it never gates a
  verdict.

## Architecture

Today: `SSE → onActivity(runId, string) → appendLog → logs (TEXT) → split('\n') → lastMeaningfulLog.slice(0,80)`.

New (keeps `logs` for the chat assistant, adds a structured stream in parallel):

```
SSE event
  → routeEvent       classify + extract clean fields; DROP message prose
  → AgentActivity { kind, status?, text, ts }
  → appendActivity(runId, activity)        new — run_activity table (capped)
  → RunRecord.activity: AgentActivity[]    new field, parsed in rowToRecord
  → deriveActivityView(activity, step, stepStartedAt)   pure (format.ts), unit-tested
        { todos[], filesWritten[], commands[], focus, counts, elapsed }
  → <LiveActivity> + <FocusCard>           new components under the active Section
```

This respects the repo's DI/testing strategy: `deriveActivityView` is pure (testable without Ink),
components only place strings/colors, persistence is one more prepared statement.

## Data model

```ts
// types.ts
export type ActivityKind = "file" | "command" | "todo" | "phase" | "error";

export interface AgentActivity {
  kind: ActivityKind;
  text: string;            // already clean: basename / full command / todo content
  status?: "pending" | "in_progress" | "completed";  // todos only
  ts: string;              // ISO — for elapsed and ordering
}

// RunRecord gains:
//   activity?: AgentActivity[];
```

Persistence: new table `run_activity (id INTEGER PK, run_id TEXT, ts TEXT, kind TEXT, status TEXT, text TEXT)`,
append-only, **capped to the last ~200 rows per run** (delete the excess on insert, same style as the
learning tables). `rowToRecord` reads it into `record.activity`. The `logs` column is untouched.

Per-phase clock: add `step_started_at TEXT` to `runs`, set whenever `step` changes (the `onStep`
callback in [runner.ts:109](../../../src/server/runner.ts)). `elapsed` is computed at render against
the current time, so it ticks every poll (~1.2s).

## Capture & sanitize — fixing the root

In `routeEvent` / the `onActivity` formatting:

- **Drop model prose** (`message.part.updated` deltas) — the source of the broken fragments. Keep only
  events with clean, structured fields:
  - `file.edited`  → `{ kind: "file", text: basename(path) }`
  - `command.executed` → `{ kind: "command", text: fullCommand }` (never split mid-arg)
  - `todo.updated` → `{ kind: "todo", status, text: content }` — **status and content preserved
    separately** (today they are flattened into `todo [status] content`)
  - `session.error` → `{ kind: "error", text }`
- **Dedup at capture:** consecutive writes to the same file collapse; a todo update replaces the prior
  status for the same content instead of appending.
- **No blind slices.** Any truncation for display happens on a **word boundary** and only at render —
  never on the stored value.

Regression guarantee: with prose dropped, a raw-JSON fragment can no longer reach the screen, so
`"file": "s` cannot recur. A unit test feeds the exact offending fragment and asserts it is dropped.

## Aggregation — `deriveActivityView` (pure)

Signature: `deriveActivityView(activity: AgentActivity[], step: string, stepStartedAt?: string): ActivityView`.

```ts
interface FocusItem { title: string; progress?: string; lastFile?: string; lastCommand?: string; }
interface ActivityView {
  todos: { text: string; status: "pending" | "in_progress" | "completed" }[];
  filesWritten: string[];   // unique, write order
  fileCount: number;
  commands: string[];       // last N
  focus: FocusItem | null;  // the in_progress todo (generate) / running test (execute)
  elapsedMs: number;        // from stepStartedAt
}
```

Rules: latest status wins per todo; `focus.title` = the `in_progress` todo (or, in execute, the running
test); when there are no recent events, `focus` keeps the **last known action** plus the ticking clock
(decided: "reloj + última acción"), never invented data.

## UI

### `generate` phase
```
   ✓  classify commit
   ⠹  generate tests · 61 specs · 8m 12s
      ╭─ now ─────────────────────────────────────────╮
      │ ⠹ generate checkout specs                3/5  │   FocusCard (round border, cyan)
      │    ✎ wrote checkout.spec.ts                   │
      │    ⚙ npx playwright test --list               │
      ╰───────────────────────────────────────────────╯
      plan   ✓ map repo structure
             ✓ read existing suite
             ⠹ generate checkout specs
             · document learnings to memory
      wrote  checkout.spec.ts · nav.spec.ts · auth.spec.ts   +58
      ran    npm ci · npx playwright test --list
   ·  validate specs
   ·  execute tests
```

- **FocusCard** = `<Box borderStyle="round" borderColor="cyan">` with nested info: current todo +
  progress + last file + last command. When quiet: last action + ticking clock + "working…".
- **LiveActivity** = the `plan / wrote / ran` block, fed by `deriveActivityView`.
- The clock re-renders every poll (1.2s); the spinner animates independently via `ink-spinner`.

### `execute` phase (Phase 2)
```
   ✓  generate tests · 61 specs
   ✓  validate specs
   ⠹  execute tests · 12/61 · 11 passed 1 failed
      ╭─ running ─────────────────────────────────────╮
      │ ⠹ checkout › completes purchase          4.2s │
      │    checkout.spec.ts                           │
      ╰───────────────────────────────────────────────╯
      ✓ home › renders hero
      ✗ cart › updates total
      ▓▓▓▓░░░░░░░░░░░░░░░░░░  12/61
```
The existing case list + `progressBar` are kept; they now fill incrementally.

## Phase 2 — live execution

`defaultExecuteDeps.runSuite` ([execute.ts:122-149](../../../src/qa/execute.ts)) changes from a single
JSON-on-stdout run to:

- JSON report written to a **file** (`PLAYWRIGHT_JSON_OUTPUT_NAME=results.json --reporter=json`), so the
  authoritative parse/classification (`parsePlaywrightReport`) is unchanged — it reads the file at `close`.
- A streaming reporter (`--reporter=line`, combined as `line,json`) on **stdout**, parsed line-by-line to
  emit a live "current test" + per-test result as **advisory** `AgentActivity` (`kind: "phase"`/case
  updates), feeding the focus card and incremental `addCase`.

The invariant holds: if the JSON file is missing/unparseable → `ran:false` → `infra-error` (never green).
Playwright stays pinned to `1.50.0`.

For **code** mode ([code-runner.ts](../../../src/qa/code-runner.ts)), per-test streaming is
ecosystem-specific; the focus card degrades to `running <test command>` + elapsed (no per-test list).

## Testing

- `routeEvent` saneo: unit tests including the exact JSON fragment that produced `"file": "s` (asserts
  dropped) and todo status/content preservation.
- `deriveActivityView`: pure unit tests — dedup, focus selection, elapsed, quiet-state fallback.
- `appendActivity` + cap + `rowToRecord`: against the in-memory SQLite pattern already used.
- `LiveActivity` / `FocusCard`: minimal render assertions following `Dashboard.test.tsx`.
- Phase 2: stdout line-stream parser unit-tested with captured Playwright `line` output; `runSuite`
  stays the uncovered integration boundary.
- Gate: `npm test` + `npm run typecheck` green.

## Build sequence

1. `types.ts`: `AgentActivity`, `ActivityKind`, `RunRecord.activity`.
2. `agent-activity.ts`: structured `routeEvent` (drop prose, preserve todo status), structured router output.
3. `history.ts`: `run_activity` table + `appendActivity` + cap + `rowToRecord` + `step_started_at`.
4. Wire `onActivity` ([index.ts:893](../../../src/index.ts)) to `appendActivity`; set `step_started_at` in `onStep`.
5. `format.ts`: `deriveActivityView` (pure) + tests.
6. `Dashboard.tsx` / new `LiveActivity.tsx` + `FocusCard.tsx`: render the panel; remove `lastMeaningfulLog`.
7. Phase 2: `execute.ts` streaming runner + line parser + incremental `addCase`; execute focus card.
8. Typecheck + tests green.
