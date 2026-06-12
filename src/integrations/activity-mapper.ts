// Maps ONE raw OpenCode event to 0..N contract RunEvent bodies for a known run.
// This is the v2-ready, enriched successor to agent-activity.ts's router: it uses
// every SDK signal worth surfacing (docs/tui-vnext.md §6) and NEVER surfaces model
// prose — only structured tool/todo/command facts. Pure: `seq`/`ts`/dedup are the
// gateway's concern, and it is unit-tested with synthetic fixtures shaped from the
// @opencode-ai/sdk types, so it needs no live engine to validate.
//
// SDK facts used (types.gen.d.ts):
//   message.part.updated → properties.part: Part   (sessionID lives on the part)
//     ToolPart { tool, callID, state: ToolState }
//       ToolState .status running|completed|error · .title (OpenCode-authored label)
//       · .input (filePath/command/description) · .output
//     text/reasoning/step parts → PROSE → dropped
//   todo.updated     → { sessionID, todos: [{ content, status }] }
//   command.executed → { sessionID, name, arguments }
//   session.error    → { sessionID?, error }

import type { RunEventBody } from "../contract/events";

export interface RawOpencodeEvent {
  type: string;
  properties?: Record<string, unknown>;
}

type ActivityKind = "analyzing" | "writing" | "command" | "subagent";

// Tool name → domain activity kind. read-like tools are the "analyzing" signal the
// old router dropped; they are what break the generation black box.
const WRITE_TOOLS = /^(write|edit|multiedit|create|apply_patch|patch)$/i;
const SHELL_TOOLS = /^(bash|shell|run|exec)$/i;
const SUBAGENT_TOOLS = /^(task|agent|subtask|dispatch)$/i;

function kindForTool(tool: string): ActivityKind {
  if (WRITE_TOOLS.test(tool)) return "writing";
  if (SHELL_TOOLS.test(tool)) return "command";
  if (SUBAGENT_TOOLS.test(tool)) return "subagent";
  return "analyzing"; // read/grep/glob/list/webfetch and unknown tools
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}
function cap(s: string, n = 200): string {
  return s.length > n ? s.slice(0, n) : s;
}

interface ToolStateLike {
  status?: string;
  title?: string;
  input?: Record<string, unknown>;
  output?: string;
}

// Prefer OpenCode's own ToolState.title ("Reading Header.astro"); fall back to
// reconstructing a label from the tool input so a missing title never blanks the line.
function targetFor(tool: string, state: ToolStateLike): string {
  if (state.title && state.title.trim()) return cap(state.title.trim());
  const input = state.input ?? {};
  const file = input.filePath ?? input.path ?? input.file ?? input.filename;
  if (typeof file === "string" && file) return basename(file);
  const cmd = input.command ?? input.cmd ?? input.script;
  if (typeof cmd === "string" && cmd) return cap(cmd.trim());
  const desc = input.description ?? input.prompt;
  if (typeof desc === "string" && desc) return cap(desc.trim());
  return tool;
}

function specFile(state: ToolStateLike): string | undefined {
  const input = state.input ?? {};
  const f = input.filePath ?? input.path ?? input.file;
  if (typeof f === "string" && /\.spec\.[tj]sx?$/.test(f)) return basename(f);
  return undefined;
}

interface PartLike {
  type?: string;
  sessionID?: string;
  tool?: string;
  callID?: string;
  state?: ToolStateLike;
}
interface TodoLike { content?: string; status?: string }

function normalizeTodoStatus(raw: unknown): "pending" | "in_progress" | "completed" | "cancelled" {
  const v = String(raw ?? "").toLowerCase();
  if (v === "in_progress" || v === "in-progress" || v === "active" || v === "running") return "in_progress";
  if (v === "completed" || v === "done" || v === "complete") return "completed";
  if (v === "cancelled" || v === "canceled") return "cancelled";
  return "pending";
}

function toolActivity(part: PartLike, workerId?: string): RunEventBody[] {
  const tool = String(part.tool ?? "");
  const state = part.state ?? {};
  const status = String(state.status ?? "");

  if (status === "error") {
    return [{ type: "agent.error", detail: cap(state.output || state.title || `tool ${tool} failed`) }];
  }
  // `pending` carries no result yet; only `running` (live, in-place) and
  // `completed` are surfaced. (Narrowing a `string` by `!==` keeps it `string`,
  // so derive the literal explicitly for the contract's status union.)
  if (status !== "running" && status !== "completed") return [];
  const liveStatus: "running" | "completed" = status === "running" ? "running" : "completed";

  const base = { type: "agent.activity" as const, kind: kindForTool(tool), target: targetFor(tool, state), status: liveStatus };
  const activity: RunEventBody = {
    ...base,
    ...(part.callID ? { callId: part.callID } : {}),
    ...(workerId ? { workerId } : {}),
  };

  const out: RunEventBody[] = [activity];
  if (status === "completed" && base.kind === "writing") {
    const spec = specFile(state);
    if (spec) out.push({ type: "spec.written", file: spec });
  }
  return out;
}

// Resolves the run an event belongs to via its sessionID (top-level on most
// events, on the part for message.part.updated). Exported so the stream consumer
// can publish each mapped body to the right run without re-deriving the session.
export function eventRunId(
  event: RawOpencodeEvent,
  sessions: ReadonlyMap<string, string>,
): string | undefined {
  const p = event.properties ?? {};
  const part = p.part as PartLike | undefined;
  const sessionID = (p.sessionID as string | undefined) ?? part?.sessionID;
  return sessionID ? sessions.get(sessionID) : undefined;
}

// Maps one raw OpenCode event to 0..N contract event bodies. Returns [] when the
// event cannot be attributed to a known session or carries only prose/control.
export function mapOpencodeEvent(
  event: RawOpencodeEvent,
  sessions: ReadonlyMap<string, string>,
  workers?: ReadonlyMap<string, string>,
): RunEventBody[] {
  if (!eventRunId(event, sessions)) return [];
  const p = event.properties ?? {};
  const part = p.part as PartLike | undefined;
  const sessionID = (p.sessionID as string | undefined) ?? part?.sessionID;
  const workerId = sessionID ? workers?.get(sessionID) : undefined;

  switch (event.type) {
    case "message.part.updated":
      return part?.type === "tool" ? toolActivity(part, workerId) : []; // text/reasoning/step → prose → drop

    case "todo.updated": {
      const todos = Array.isArray(p.todos) ? (p.todos as TodoLike[]) : [];
      const mapped = todos
        .filter((t) => (t.content ?? "").trim())
        .map((t) => ({ content: cap(t.content!.trim()), status: normalizeTodoStatus(t.status) }));
      return mapped.length ? [{ type: "plan.updated", todos: mapped }] : [];
    }

    case "command.executed": {
      const cmd = [p.name, p.arguments].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ");
      return cmd ? [{ type: "agent.activity", kind: "command", target: cap(cmd), status: "completed" }] : [];
    }

    case "session.error":
      return [{ type: "agent.error", detail: cap(String(p.error ?? "unknown error")) }];

    default:
      return []; // session.idle, file.edited (no sessionID), etc. are not surfaced here
  }
}
