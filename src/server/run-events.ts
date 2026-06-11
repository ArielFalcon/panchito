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
      bus.emit(eventKey(runId), event);
      return event;
    },

    replay(runId, afterSeq = -1) {
      return [...(buffers.get(runId) ?? [])].filter((event) => event.seq > afterSeq);
    },

    subscribe(runId, handler) {
      return bus.on(eventKey(runId), handler);
    },
  };
}
