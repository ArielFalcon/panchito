import type { RunEvent, RunEventBody } from "../contract/events";
import { RunEventBodySchema, RunEventSchema } from "../contract/events";
import { sanitizeText } from "../orchestrator/sanitizer";
import { TypedEventBus, type Unsubscribe } from "./event-bus";

type RunEventBus = TypedEventBus<Record<string, RunEvent>>;

export interface RunEventStore {
  publish(runId: string, body: RunEventBody): RunEvent;
  replay(runId: string, afterSeq?: number): RunEvent[];
  subscribe(runId: string, handler: (event: RunEvent) => void): Unsubscribe;
}

interface RunEventStoreOptions {
  maxEventsPerRun?: number;
  maxRuns?: number;
  now?: () => number;
  // Optional durable backing (OBS-01). When provided, every event is also persisted, and replay
  // falls back to the durable copy when the in-memory buffer was evicted or wiped by a restart.
  // Additive: absent ⇒ the store is purely in-memory as before.
  persist?: (event: RunEvent) => void;
  loadPersisted?: (runId: string, afterSeq: number) => RunEvent[];
}

function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === "string") return sanitizeText(value).text;
  if (Array.isArray(value)) return value.map(sanitizeUnknown);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = sanitizeUnknown(child);
    return out;
  }
  return value;
}

function eventKey(runId: string): string {
  return `run:${runId}`;
}

export function createRunEventStore(opts: RunEventStoreOptions = {}): RunEventStore {
  const maxEventsPerRun = opts.maxEventsPerRun ?? 500;
  // Cap the number of runs whose replay buffer is retained in memory. Without this
  // the buffers/nextSeq maps grow one entry per run forever (a slow leak in a
  // long-lived orchestrator). With the sequential queue the oldest run is always
  // terminal, so dropping its buffer only costs late-reconnect replay for an old run.
  const maxRuns = opts.maxRuns ?? 200;
  const now = opts.now ?? Date.now;
  const bus: RunEventBus = new TypedEventBus();
  const buffers = new Map<string, RunEvent[]>();
  const nextSeq = new Map<string, number>();

  return {
    publish(runId, body) {
      const cleanBody = RunEventBodySchema.parse(sanitizeUnknown(body));
      if (!buffers.has(runId) && buffers.size >= maxRuns) {
        const oldest = buffers.keys().next().value; // Map preserves insertion order
        if (oldest !== undefined) { buffers.delete(oldest); nextSeq.delete(oldest); }
      }
      const seq = nextSeq.get(runId) ?? 0;
      nextSeq.set(runId, seq + 1);
      const event = RunEventSchema.parse({ seq, runId, ts: now(), body: cleanBody });
      const buf = buffers.get(runId) ?? [];
      buf.push(event);
      if (buf.length > maxEventsPerRun) buf.splice(0, buf.length - maxEventsPerRun);
      buffers.set(runId, buf);
      if (opts.persist) {
        try {
          opts.persist(event);
        } catch {
          /* best-effort durability — never block the live stream */
        }
      }
      bus.emit(eventKey(runId), event);
      return event;
    },

    replay(runId, afterSeq = -1) {
      const inMem = [...(buffers.get(runId) ?? [])].filter((event) => event.seq > afterSeq);
      if (!opts.loadPersisted) return inMem;
      // If the in-memory buffer is empty (run evicted from the ring, or wiped by a restart) or has
      // a gap right after afterSeq, backfill from the durable copy so replay survives restarts.
      const needsBackfill = inMem.length === 0 || (inMem[0]?.seq ?? Infinity) > afterSeq + 1;
      if (!needsBackfill) return inMem;
      const persisted = opts.loadPersisted(runId, afterSeq);
      if (persisted.length === 0) return inMem;
      const bySeq = new Map<number, RunEvent>();
      for (const e of persisted) bySeq.set(e.seq, e);
      for (const e of inMem) bySeq.set(e.seq, e); // in-memory wins (freshest)
      return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    },

    subscribe(runId, handler) {
      return bus.on(eventKey(runId), handler);
    },
  };
}
