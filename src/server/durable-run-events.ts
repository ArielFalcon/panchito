import type { RunEvent } from "../contract/events";
import { createRunEventStore, type RunEventStore } from "./run-events";
import { saveRunEvent as defaultSaveRunEvent, loadRunEvents as defaultLoadRunEvents } from "./history";

export interface DurableRunEventDeps {
  saveRunEvent?: (event: { runId: string; seq: number; ts: number; body: unknown }) => void;
  loadRunEvents?: (runId: string, afterSeq: number) => Array<{ runId: string; seq: number; ts: number; body: unknown }>;
}

// The orchestrator's run-event store + its durable backing (OBS-01), assembled in ONE place so
// EVERY trigger that owns a queue — the long-lived server (src/index.ts) and the manual CLI
// (src/cli.ts) — persists run events identically. A CLI run uses its own in-process queue, and
// previously wired no run-event store at all, so it wrote zero run_events; the TUI attaching to
// it through the server then saw an empty, never-closing SSE stream. Routing both processes
// through this factory means an out-of-process run's events land in the shared store, where the
// server's durable poll (handleRunEvents) can replay and tail them. The save/load collaborators
// are injected for tests; production uses the real SQLite-backed history functions.
export function createDurableRunEventStore(deps: DurableRunEventDeps = {}): RunEventStore {
  const save = deps.saveRunEvent ?? defaultSaveRunEvent;
  const load = deps.loadRunEvents ?? defaultLoadRunEvents;
  return createRunEventStore({
    persist: (e) => save({ runId: e.runId, seq: e.seq, ts: e.ts, body: e.body }),
    loadPersisted: (runId, afterSeq) =>
      load(runId, afterSeq).map((r) => ({ seq: r.seq, runId: r.runId, ts: r.ts, body: r.body }) as RunEvent),
  });
}
