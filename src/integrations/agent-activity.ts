// Phase 4 (SSE live activity) — pure, advisory-only routing. Now WIRED.
//
// OpenCode's /global/event is a SERVER-GLOBAL firehose: every event carries a
// directory (not sessionID directly). Session-scoped events (file.edited,
// command.executed, todo.updated) have the sessionID in their properties. The
// router demuxes by sessionID → runId and stays ADVISORY-ONLY.
//
// Design note — why model prose is dropped: streaming `message.part.updated`
// deltas are arbitrary fragments of the model's output (often mid-word or
// mid-JSON). Rendering them produced broken status lines like `"file": "s`. We
// keep ONLY events whose payload carries clean, structured fields (the file it
// wrote, the command it ran, the todo it is on). The agent's reasoning text is
// never surfaced.

import { ActivityKind } from "../types";

// The router's output for one event: the semantic fields plus the run it belongs
// to. The persisted/TUI `AgentActivity` (types.ts) adds a `ts` stamped at write.
export interface RoutedActivity {
  runId: string;
  kind: ActivityKind;
  text: string;
  status?: "pending" | "in_progress" | "completed";
}

// The minimal view of an incoming OpenCode event the router needs.
export interface RawEvent {
  type: string;
  properties?: Record<string, unknown>;
}

export type DropReason = "no-session" | "unknown-session" | "unknown-kind";

// Allowlist of OpenCode event types worth surfacing — every one carries a clean
// structured field. `message.*` is intentionally absent (raw stream prose).
const DEFAULT_ALLOW: Record<string, ActivityKind> = {
  "file.edited": "file",          // agent wrote a file
  "command.executed": "command",  // agent ran a command
  "todo.updated": "todo",         // agent task progress (carries status)
  "session.status": "phase",      // session lifecycle (display layer may ignore)
  "session.error": "error",       // session error (critical for debugging)
};

export interface RouteResult {
  activity?: RoutedActivity;
  dropped?: DropReason;
}

// Normalizes the many status spellings OpenCode may emit into our three states.
function normalizeStatus(raw: unknown): RoutedActivity["status"] {
  const s = String(raw ?? "").toLowerCase();
  if (s === "completed" || s === "done" || s === "complete") return "completed";
  if (s === "in_progress" || s === "in-progress" || s === "active" || s === "running") return "in_progress";
  return "pending";
}

function basename(path: string): string {
  return path.split("/").pop() || path;
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

  const p = event.properties ?? {};
  let text = "";
  let status: RoutedActivity["status"] | undefined;

  if (kind === "file" && p.file) {
    text = basename(String(p.file));
  } else if (kind === "command" && p.command) {
    text = String(p.command).trim();
  } else if (kind === "todo" && p.todo) {
    const todo = p.todo as { content?: string; status?: string };
    text = (todo.content ?? "").trim();
    status = normalizeStatus(todo.status);
  } else if (kind === "error") {
    text = `error: ${String(p.error ?? event.type)}`;
  } else if (kind === "phase") {
    // Session lifecycle — keep a terse, structured signal (e.g. "idle"/"working").
    text = String(p.status ?? p.state ?? event.type);
  }

  // No usable content → drop (e.g. a todo with no content). Errors/phases keep a
  // minimal text because they signal a state change the operator must see.
  if (!text) {
    if (kind === "error" || kind === "phase") text = event.type;
    else return { dropped: "unknown-kind" };
  }

  return { activity: { runId, kind, text: text.slice(0, 500), ...(status ? { status } : {}) } };
}

// Stateful registry that routes events AND tracks per-session context for
// enriched heartbeat messages (current task, last file edited).
export class ActivityRouter {
  private readonly sessions = new Map<string, string>();
  private readonly context = new Map<string, SessionContext>();
  readonly drops: Record<DropReason, number> = { "no-session": 0, "unknown-session": 0, "unknown-kind": 0 };

  register(sessionId: string, runId: string): void {
    this.sessions.set(sessionId, runId);
    this.context.set(sessionId, { lastFile: undefined, lastTodo: undefined, fileCount: 0 });
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.context.delete(sessionId);
  }

  route(event: RawEvent): RoutedActivity | null {
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
      if (a.kind === "file") { ctx.lastFile = a.text; ctx.fileCount++; }
      else if (a.kind === "todo") ctx.lastTodo = a.text;
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
    if (ctx.fileCount > 0) parts.push(`files edited: ${ctx.fileCount}`);
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
  lastFile?: string;
  lastTodo?: string;
  fileCount: number;
}
