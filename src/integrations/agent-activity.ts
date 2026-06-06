// Phase 4 (SSE live activity) FOUNDATION — pure, advisory-only routing. OFF by default.
//
// OpenCode's /event is a SERVER-GLOBAL firehose (dist/gen/sdk.gen.js:842): every event
// carries a sessionID, there is no per-session stream, and no replay (no event ids).
// The qa-maintainer also runs sessions OUTSIDE the queue, so the firehose interleaves
// concurrent sessions. Therefore a live feed MUST:
//   - demux STRICTLY by sessionID → runId (a run owns its session + its reviewer child),
//   - drop unknown events with a COUNTED reason (never swallow — CLAUDE.md invariant),
//   - stay ADVISORY-ONLY: it may update a run's `activity` view, never a verdict (the
//     blocking session.prompt stays the sole authority).
//
// The narrow types here keep OpenCode's internal event union from leaking into src/.
// The LIVE subscription that feeds this router is gated on the Phase-0 live spike
// (docs/interactive-layer.md §10) and is intentionally NOT wired yet. This module is the
// tested router that wiring will use.

export type ActivityKind = "tool" | "file" | "step" | "review" | "message";

export interface AgentActivity {
  runId: string;
  kind: ActivityKind;
  text: string;
}

// The minimal view of an incoming OpenCode event the router needs (mapped at the SDK
// seam, so OpenCode's full event shape never reaches here).
export interface RawEvent {
  sessionID?: string;
  kind: string;
  text?: string;
}

export type DropReason = "no-session" | "unknown-session" | "unknown-kind";

// Hard allowlist of the few event kinds worth surfacing. Anything else is dropped.
const DEFAULT_ALLOW: Record<string, ActivityKind> = {
  "tool.invoked": "tool",
  tool: "tool",
  "file.edited": "file",
  file: "file",
  step: "step",
  review: "review",
  "message.part": "message",
};

export interface RouteResult {
  activity?: AgentActivity;
  dropped?: DropReason;
}

// Routes ONE event to a run, or drops it with a reason — never silently, never to the
// wrong run. `sessions` maps a KNOWN sessionID to its runId.
export function routeEvent(
  event: RawEvent,
  sessions: ReadonlyMap<string, string>,
  allow: Record<string, ActivityKind> = DEFAULT_ALLOW,
): RouteResult {
  if (!event.sessionID) return { dropped: "no-session" };
  const runId = sessions.get(event.sessionID);
  if (!runId) return { dropped: "unknown-session" };
  const kind = allow[event.kind];
  if (!kind) return { dropped: "unknown-kind" };
  return { activity: { runId, kind, text: (event.text ?? "").slice(0, 500) } };
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
