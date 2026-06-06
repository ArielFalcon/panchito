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
  "message.part.removed": "message",  // agent retracted text
  "file.edited": "file",              // agent wrote a file
  "command.executed": "tool",         // agent ran a command
  "session.status": "step",           // session lifecycle
  "session.error": "step",            // session error (critical for debugging)
  "todo.updated": "step",             // agent task progress
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
  let text = "";
  if (kind === "message" && event.properties) {
    // Streaming delta (incremental text) — the most common and useful case.
    const delta = event.properties.delta as string | undefined;
    if (delta?.trim()) {
      text = delta;
    } else {
      // No delta → extract from the full Part object.
      const part = event.properties.part as { type?: string; text?: string; tool?: string; title?: string } | undefined;
      if (part?.type === "text" && part.text) {
        text = part.text;
      } else if (part?.type === "tool") {
        text = `ran tool: ${part.tool ?? "?"}`;
      } else if (part?.type === "reasoning") {
        text = "(thinking…)";
      } else if (part?.type === "subtask") {
        text = `subtask: ${part.title ?? "?"}`;
      }
    }
  } else if (kind === "file" && event.properties?.file) {
    text = `edited ${String(event.properties.file)}`;
  } else if (kind === "tool" && event.properties?.command) {
    text = `ran: ${String(event.properties.command)}`;
  } else if (event.type === "session.error" && event.properties?.error) {
    text = `error: ${String(event.properties.error)}`;
  } else if (event.type === "todo.updated" && event.properties?.todo) {
    const todo = event.properties.todo as { content?: string; status?: string };
    text = `todo [${todo.status ?? "?"}] ${todo.content ?? ""}`;
  }
  if (!text) text = event.type;

  return { activity: { runId, kind, text: text.slice(0, 500) } };
}

// Stateful registry that routes events AND tracks per-session context for
// enriched heartbeat messages (current task, last file edited).
export class ActivityRouter {
  private readonly sessions = new Map<string, string>();
  private readonly context = new Map<string, SessionContext>();
  readonly drops: Record<DropReason, number> = { "no-session": 0, "unknown-session": 0, "unknown-kind": 0 };

  register(sessionId: string, runId: string): void {
    this.sessions.set(sessionId, runId);
    this.context.set(sessionId, { deltas: "", lastFile: undefined, lastTodo: undefined });
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.context.delete(sessionId);
  }

  route(event: RawEvent): AgentActivity | null {
    const r = routeEvent(event, this.sessions);
    if (r.dropped) {
      this.drops[r.dropped]++;
      return null;
    }
    const a = r.activity;
    if (!a) return null;

    // Track context for heartbeat enrichment — keep the last file and last todo.
    const sid = [...this.sessions.entries()].find(([, rid]) => rid === a.runId)?.[0];
    const ctx = sid ? this.context.get(sid) : undefined;
    if (ctx) {
      if (a.kind === "file") ctx.lastFile = a.text;
      else if (event.type === "todo.updated") ctx.lastTodo = a.text;
    }
    return a;
  }

  // Returns a short contextual summary for heartbeat enrichment: what the agent
  // is currently working on, based on the last observed todo and file edit.
  getContext(sessionId: string): string {
    const ctx = this.context.get(sessionId);
    if (!ctx) return "";
    const parts: string[] = [];
    if (ctx.lastTodo) parts.push(ctx.lastTodo);
    if (ctx.lastFile) parts.push(ctx.lastFile);
    return parts.join(" — ");
  }

  // Same as getContext but resolves by runId (finds the session for that run).
  contextForRun(runId: string): string {
    for (const [sid, rid] of this.sessions) {
      if (rid === runId) return this.getContext(sid);
    }
    return "";
  }
}

interface SessionContext {
  deltas: string;
  lastFile?: string;
  lastTodo?: string;
}
