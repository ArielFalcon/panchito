// Phase 4 (SSE live activity) — pure, advisory-only routing. Now WIRED.
//
// OpenCode's /global/event is a SERVER-GLOBAL firehose: every event carries a
// directory (not sessionID directly). Session-scoped events (message.part.updated,
// file.edited) have the sessionID in their properties. The router demuxes by
// sessionID → runId and stays ADVISORY-ONLY.

export type ActivityKind = "tool" | "file" | "step" | "review" | "message";

export interface AgentActivity {
  runId: string;
  kind: ActivityKind;
  text: string;
}

// The minimal view of an incoming OpenCode event the router needs.
export interface RawEvent {
  type: string;
  properties?: Record<string, unknown>;
}

export type DropReason = "no-session" | "unknown-session" | "unknown-kind";

// Allowlist of real OpenCode event types worth surfacing. Anything else is dropped.
const DEFAULT_ALLOW: Record<string, ActivityKind> = {
  "message.part.updated": "message",  // streaming delta — the most valuable
  "message.updated": "message",       // full message update
  "file.edited": "file",              // agent wrote a file
  "command.executed": "tool",         // agent ran a command
  "session.status": "step",           // session lifecycle
};

export interface RouteResult {
  activity?: AgentActivity;
  dropped?: DropReason;
}

// Routes ONE event to a run, or drops it with a reason.
export function routeEvent(
  event: RawEvent,
  sessions: ReadonlyMap<string, string>,
  allow: Record<string, ActivityKind> = DEFAULT_ALLOW,
): RouteResult {
  const kind = allow[event.type];
  if (!kind) return { dropped: "unknown-kind" };
  const sessionID = event.properties?.sessionID as string | undefined;
  if (!sessionID) return { dropped: "no-session" };
  const runId = sessions.get(sessionID);
  if (!runId) return { dropped: "unknown-session" };

  // Build a human-readable text from the event properties.
  let text = event.type;
  if (kind === "message" && event.properties) {
    const delta = event.properties.delta as string | undefined;
    const part = event.properties.part as { type?: string; text?: string } | undefined;
    text = delta ?? part?.text ?? event.type;
  } else if (kind === "file" && event.properties?.file) {
    text = `edited ${String(event.properties.file)}`;
  } else if (kind === "tool" && event.properties?.command) {
    text = `ran: ${String(event.properties.command)}`;
  }

  return { activity: { runId, kind, text: text.slice(0, 500) } };
}

// Stateful registry over routeEvent that COUNTS drops (logged+counted, never swallowed).
export class ActivityRouter {
  private readonly sessions = new Map<string, string>();
  readonly drops: Record<DropReason, number> = { "no-session": 0, "unknown-session": 0, "unknown-kind": 0 };

  register(sessionId: string, runId: string): void {
    this.sessions.set(sessionId, runId);
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  route(event: RawEvent): AgentActivity | null {
    const r = routeEvent(event, this.sessions);
    if (r.dropped) {
      this.drops[r.dropped]++;
      return null;
    }
    return r.activity ?? null;
  }
}
