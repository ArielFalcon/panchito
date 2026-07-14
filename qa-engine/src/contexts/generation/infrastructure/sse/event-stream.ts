// qa-engine/src/contexts/generation/infrastructure/sse/event-stream.ts
// migration-tier-4c Slice 3 (D-4c-2, the SSE two-tier split). Mirrors Slice 2's own transport split
// exactly (agent-transport-policy.ts): the genuinely-raw @opencode-ai/sdk primitive — opening ONE
// scoped `event.subscribe({directory})` and handing back the raw async-iterable of SDK-shaped events
// — stays shell-injected (`RawEventStreamOpener`, a qa-engine-LOCAL mirror type, NOT importing the
// shell's own type). Everything else — the refcounted per-directory subscription lifecycle
// (EventStreamManager), the reconnect-with-backoff wrapper, and the per-event mapping/routing policy
// (RE-2 re-exploration tracking, liveness-watchdog notify, contract RunEvent mapping, LiveActivity
// display-string assembly) — is SDK-free and lives HERE.
//
// `setRawEventStreamOpener` is a late-bound singleton dependency: EventStreamManager's default
// openStream (defaultOpenStream, below) is only ever INVOKED once a directory is attached AND the
// sink is set (see ensureStream) — never at module-load time — so the shell composition root
// (src/integrations/opencode-client.ts) calls setRawEventStreamOpener ONCE at its own module load,
// exactly as eagerly as the ORIGINAL shell module constructed its own `defaultOpenStream` closure
// (a function value, not an immediate SDK call). Mirrors the "composition root wires a late-bound raw
// primitive" shape already used for the shared SDK client (getSharedClient's own lazy-cached pattern).

import type { RunEventBody } from "@kernel/contract/events.ts";
import { ActivityRouter, type ActivityKind } from "./agent-activity.ts";
import { mapOpencodeEvent, eventRunId } from "./activity-mapper.ts";
import { reexploreKindFromEvent, reexploreTracker } from "./reexplore.ts";
import { notifySessionActivity } from "../agent-transport-policy.ts";

// One routed, display-ready activity handed to the SSE consumer: the structured
// fields (for the live panel) plus a human-readable `display` line (for the log
// feed the chat assistant reads).
export interface LiveActivity {
  runId: string;
  kind: ActivityKind;
  text: string;
  status?: "pending" | "in_progress" | "completed";
  display: string;
}

// Genuinely raw @opencode-ai/sdk primitive: opens ONE scoped v2 subscription for a directory and
// returns the raw async-iterable of SDK-shaped events (or undefined if the transport returned no
// stream). Injected from shell via setRawEventStreamOpener below — qa-engine never constructs the
// client or calls event.subscribe itself.
export interface RawEventStreamOpener {
  open(directory: string): Promise<AsyncIterable<{ type?: string; properties?: Record<string, unknown> }> | undefined>;
}

let rawOpener: RawEventStreamOpener | undefined;

// Called ONCE by the composition root (src/integrations/opencode-client.ts, at its own module load)
// before any run attaches a session. A stream attempted before this is wired throws loudly — never a
// silent no-op (CLAUDE.md's "surface integration errors loudly" invariant).
export function setRawEventStreamOpener(opener: RawEventStreamOpener): void {
  rawOpener = opener;
}

// SSE live activity: routes OpenCode events to RunRecord logs in real time. Zero SDK dependency
// (ActivityRouter's constructor takes nothing), so — unlike eventStreams below — this singleton needs
// no late-bound wiring at all.
export const activityRouter = new ActivityRouter();

// One scoped v2 subscription for a single run directory. v2 has NO global firehose:
// event.subscribe({directory}) yields ONLY that workspace's events, each DIRECTLY
// ({ id, type, properties } — no v1 GlobalEvent { directory, payload } wrapper).
// Returns on stream close/error; the manager's reconnect loop reopens it.
async function startScopedEventStream(
  directory: string,
  onActivity: (a: LiveActivity) => void,
  signal?: AbortSignal,
  // Contract RunEvent stream: each raw event is mapped (preserving ToolState.title/
  // callID, all tools, todos) and published to the run it belongs to. Advisory —
  // never authoritative, never allowed to break the stream loop.
  onRunEvent?: (runId: string, body: RunEventBody) => void,
): Promise<void> {
  if (!rawOpener) {
    throw new Error(
      "EventStreamManager: no RawEventStreamOpener wired — the composition root must call setRawEventStreamOpener before opening any stream",
    );
  }
  const stream = await rawOpener.open(directory);
  if (!stream) {
    console.warn(`[qa] SSE event stream returned no stream (${directory})`);
    return;
  }

  try {
    for await (const event of stream) {
      if (signal?.aborted) break;

      const evt = event as { type?: string; properties?: Record<string, unknown> };
      if (!evt.type) continue;

      const raw = { type: evt.type, properties: evt.properties };

      // RE-2: count re-exploration tool calls (browser_navigate/snapshot, serena) from the RAW
      // `part.tool` — before mapOpencodeEvent collapses every tool into a 4-value `kind`. Keyed by
      // session so each generation cycle gets its own counts. Observability only.
      const reexKind = reexploreKindFromEvent(raw);
      // Extract part.sessionID once for both reexplore tracking and the liveness watchdog.
      const rawPart = raw.properties?.part as { sessionID?: string; callID?: string } | undefined;
      if (reexKind && rawPart?.sessionID) {
        // Pass callID so the tracker dedups re-streamed updates for one tool call (a part emits many).
        reexploreTracker.record(rawPart.sessionID, reexKind, rawPart.callID);
      }
      // Notify the liveness watchdog for this session: any event proves the agent is alive.
      // Advisory-only: if the sessionID is not in the registry (no watchdog) this is a no-op.
      if (rawPart?.sessionID) notifySessionActivity(rawPart.sessionID);

      // Rich contract RunEvents (agent.activity/plan.updated/…) from the RAW event,
      // so ToolState.title/callID survive. Published to the owning run; a malformed
      // body must never break the loop.
      if (onRunEvent) {
        const rid = eventRunId(raw, activityRouter.sessionMap());
        if (rid) {
          for (const body of mapOpencodeEvent(raw, activityRouter.sessionMap(), activityRouter.workerMap())) {
            try { onRunEvent(rid, body); } catch { /* advisory */ }
          }
        }
      }

      const activities = activityRouter.route(raw);

      for (const activity of activities) {
        // Build a concise display line for the human log feed (chat-assistant context).
        // The structured fields below feed the live TUI panel; the text is already clean.
        let shown = activity.text;
        if (activity.kind === "command") {
          const parts = shown.split(/\s+/);
          if (parts.length > 4) shown = parts.slice(0, 4).join(" ") + " …";
        }
        // Match the TUI's visual identity: ✓/✗/·/⚠/⚙ — no emoji.
        const icon = activity.kind === "file" ? "✎" : activity.kind === "command" ? "⚙" : activity.kind === "error" ? "⚠" : "▸";
        const label = activity.kind === "file" ? `wrote ${shown}` : shown;
        onActivity({
          runId: activity.runId,
          kind: activity.kind,
          text: activity.text,
          ...(activity.status ? { status: activity.status } : {}),
          display: `[qa] ${icon} ${label}`,
        });
      }
    }
  } catch (err) {
    if (!signal?.aborted) {
      console.warn(`[qa] SSE event stream error (${directory}): ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    console.log(`[qa] SSE event stream closed (${directory})`);
  }
}

export interface EventStreamReconnectOptions {
  // The scoped stream opener to keep alive. Required: there is no global default
  // anymore (v2 has no global firehose). The manager closes over the directory.
  start: (onActivity: (a: LiveActivity) => void, signal?: AbortSignal, onRunEvent?: (runId: string, body: RunEventBody) => void) => Promise<void>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  initialDelayMs?: number;
  maxDelayMs?: number;
  log?: (msg: string) => void;
  onRunEvent?: (runId: string, body: RunEventBody) => void;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Keeps the OpenCode SSE bridge alive for the lifetime of the orchestrator. The
// underlying SDK stream can fail during startup or after a transient network blip;
// without this wrapper the TUI silently loses live activity until process restart.
export async function startEventStreamWithReconnect(
  onActivity: (a: LiveActivity) => void,
  signal?: AbortSignal,
  opts: EventStreamReconnectOptions = { start: () => { throw new Error("startEventStreamWithReconnect requires a scoped `start`"); } },
): Promise<void> {
  const start = opts.start;
  const sleep = opts.sleep ?? sleepWithAbort;
  const initialDelayMs = opts.initialDelayMs ?? 1_000;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;
  let delayMs = initialDelayMs;

  while (!signal?.aborted) {
    try {
      await start(onActivity, signal, opts.onRunEvent);
      delayMs = initialDelayMs;
      if (!signal?.aborted) opts.log?.(`[qa] OpenCode event stream closed; reconnecting in ${delayMs}ms`);
    } catch (err) {
      if (signal?.aborted) break;
      opts.log?.(`[qa] OpenCode event stream failed: ${err instanceof Error ? err.message : String(err)}; reconnecting in ${delayMs}ms`);
    }
    if (signal?.aborted) break;
    await sleep(delayMs, signal);
    delayMs = Math.min(delayMs * 2, maxDelayMs);
  }
}

// Opens (and keeps reconnecting) ONE scoped stream for a directory until `signal`
// aborts. Injectable so the manager is unit-testable without the SDK. Declared LOCALLY (gate
// rider) — mirrors Slice 2's own RawAgentTransport discipline; qa-engine never imports the shell's
// OpenStreamFn type.
export type OpenStreamFn = (
  directory: string,
  onActivity: (a: LiveActivity) => void,
  signal: AbortSignal,
  onRunEvent?: (runId: string, body: RunEventBody) => void,
) => void;

const defaultOpenStream: OpenStreamFn = (directory, onActivity, signal, onRunEvent) => {
  void startEventStreamWithReconnect(onActivity, signal, {
    onRunEvent,
    start: (oa, sig, ore) => startScopedEventStream(directory, oa, sig, ore),
    log: (m) => console.log(m),
  });
};

// Refcounted per-directory scoped subscriptions. v2 forces per-workspace streams,
// so the orchestrator opens one scoped stream per run directory (parallelDiff
// sessions in the same mirror share it) and closes it when the directory's last
// session unregisters. The sink (set once at boot via startActivitySink) is the
// same callback pair the single v1 global stream used.
export class EventStreamManager {
  private onActivity?: (a: LiveActivity) => void;
  private onRunEvent?: (runId: string, body: RunEventBody) => void;
  private shutdown?: AbortSignal;
  private readonly dirs = new Map<string, { refs: number; abort: AbortController; started: boolean }>();
  private readonly sessionDir = new Map<string, string>();

  constructor(private readonly openStream: OpenStreamFn = defaultOpenStream) {}

  setSink(onActivity: (a: LiveActivity) => void, shutdown?: AbortSignal, onRunEvent?: (runId: string, body: RunEventBody) => void): void {
    this.onActivity = onActivity;
    this.onRunEvent = onRunEvent;
    this.shutdown = shutdown;
    shutdown?.addEventListener("abort", () => this.closeAll(), { once: true });
    // Open any directory attached before the sink was set.
    for (const dir of this.dirs.keys()) this.ensureStream(dir);
  }

  attach(sessionId: string, directory: string): void {
    if (this.shutdown?.aborted) return;
    this.sessionDir.set(sessionId, directory);
    const existing = this.dirs.get(directory);
    if (existing) { existing.refs++; return; }
    this.dirs.set(directory, { refs: 1, abort: new AbortController(), started: false });
    this.ensureStream(directory);
  }

  detach(sessionId: string): void {
    const directory = this.sessionDir.get(sessionId);
    if (!directory) return;
    this.sessionDir.delete(sessionId);
    const entry = this.dirs.get(directory);
    if (!entry) return;
    entry.refs--;
    if (entry.refs <= 0) {
      entry.abort.abort();
      this.dirs.delete(directory);
    }
  }

  private ensureStream(directory: string): void {
    if (!this.onActivity) return; // sink not set yet — opened in setSink
    const entry = this.dirs.get(directory);
    if (!entry || entry.started) return;
    entry.started = true;
    this.openStream(directory, this.onActivity, entry.abort.signal, this.onRunEvent);
  }

  private closeAll(): void {
    for (const entry of this.dirs.values()) entry.abort.abort();
    this.dirs.clear();
    this.sessionDir.clear();
  }
}

const eventStreams = new EventStreamManager();

// Boot entry (called once by the facade): register the live-activity sink. v2 has
// no global stream to open here — per-directory streams start lazily as runs
// register sessions. Resolves when `signal` aborts, mirroring the old long-lived
// stream's lifetime so the facade's fire-and-forget call stays pending until shutdown.
export function startActivitySink(
  onActivity: (a: LiveActivity) => void,
  signal?: AbortSignal,
  opts: { onRunEvent?: (runId: string, body: RunEventBody) => void } = {},
): Promise<void> {
  eventStreams.setSink(onActivity, signal, opts.onRunEvent);
  return new Promise<void>((resolve) => {
    if (!signal) return; // boot always passes the shutdown signal; without it, stay pending
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

// Maps an OpenCode session to a run so SSE events are routed to the correct RunRecord.
export function registerRunSession(sessionId: string, runId: string, directory: string, workerId?: string): void {
  activityRouter.register(sessionId, runId, workerId);
  eventStreams.attach(sessionId, directory);
}

export function unregisterRunSession(sessionId: string): void {
  activityRouter.unregister(sessionId);
  eventStreams.detach(sessionId);
  reexploreTracker.clear(sessionId); // RE-2: free the per-session counts (read before this call).
}
