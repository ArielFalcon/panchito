// Read-side, in-process typed event bus — the single fan-out point from the
// lifecycle/agent-activity PRODUCERS (pipeline callbacks, the OpenCode activity
// router) to OBSERVABILITY consumers: the SSE endpoints (TUI / future OpenClaw),
// the history projection, metrics. It is STRICTLY read-side: it never schedules
// or coordinates work — commands flow through the JobQueue and pipeline control
// flow, and no consumer ever feeds state back to a producer. That orthogonality
// is what keeps the lifecycle authority single (src/pipeline.ts); see
// docs/interactive-layer.md §3.4.
//
// Built on node:events (zero dependencies). `stream()` exposes an AbortSignal-
// aware async iterator so an SSE handler can `for await` the events for one run
// and terminate cleanly the instant the HTTP connection closes (abort the
// signal) — matching the request lifecycle without manual listener bookkeeping.

import { EventEmitter, on, once } from "node:events";

export type Unsubscribe = () => void;

export class TypedEventBus<Events extends Record<string, unknown>> {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Unbounded: many concurrent SSE connections may subscribe to the same key
    // (one per watching client), which would trip the default 10-listener warning.
    this.emitter.setMaxListeners(0);
  }

  /** Publish a payload. Synchronous, fire-and-forget — a consumer never blocks a producer. */
  emit<K extends keyof Events & string>(key: K, payload: Events[K]): void {
    this.emitter.emit(key, payload);
  }

  /** Subscribe with a callback. Returns an unsubscribe function. */
  on<K extends keyof Events & string>(key: K, handler: (payload: Events[K]) => void): Unsubscribe {
    const wrapped = (payload: unknown): void => handler(payload as Events[K]);
    this.emitter.on(key, wrapped);
    return () => { this.emitter.off(key, wrapped); };
  }

  /** Resolve once with the next payload for `key`. Rejects if `signal` aborts first. */
  async next<K extends keyof Events & string>(key: K, signal?: AbortSignal): Promise<Events[K]> {
    const args = (await once(this.emitter, key, signal ? { signal } : undefined)) as Events[K][];
    return args[0] as Events[K];
  }

  /**
   * Async iterator over every payload for `key`, in emission order. Ends cleanly
   * (returns, never throws) when `signal` aborts — i.e. the SSE connection closes.
   */
  async *stream<K extends keyof Events & string>(key: K, signal: AbortSignal): AsyncGenerator<Events[K]> {
    try {
      for await (const args of on(this.emitter, key, { signal })) {
        yield (args as Events[K][])[0] as Events[K];
      }
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      throw err;
    }
  }
}
