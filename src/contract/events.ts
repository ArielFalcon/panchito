// The RunEvent domain model — the single source of truth for the live event
// stream the Channel Gateway pushes to clients (the Go TUI, future OpenClaw).
// Defined in zod so the server gets the TS type via `z.infer` (server ≡ schema)
// and the same schemas later emit the OpenAPI artifact that codegens the Go
// types. This is OUR vocabulary, not OpenCode's: producers (pipeline callbacks,
// the activity router, the Playwright stream) map their raw signals ONTO these
// events; model prose (`delta`/TextPart/ReasoningPart) is never represented here.
//
// See docs/tui-vnext.md §4 (event model) and §6 (SDK resource → component map).

import { z } from "zod";

// ── Wire enums ────────────────────────────────────────────────────────────────
// Mirror src/types.ts EXACTLY. The migration direction eventually inverts
// (types.ts derives from here); until then events.test.ts asserts lockstep.
export const TestTargetSchema = z.enum(["e2e", "code"]);
export const RunModeSchema = z.enum(["diff", "complete", "exhaustive", "manual", "context"]);
export const RunVerdictSchema = z.enum(["pass", "fail", "flaky", "invalid", "infra-error", "skipped"]);

// Canonical pipeline phases for the PhaseProgress stepper. The orchestrator's
// `onStep` callback is a loose string today; the producer adapter normalizes it
// onto this enum (an unknown step is omitted, never invented).
export const RunStepSchema = z.enum([
  "gate", "classify", "setup", "generate", "validate", "health", "execute", "coverage", "retry", "decide", "done",
]);

// What the agent is doing — derived from OpenCode's ToolPart, never from prose.
// analyzing = read/grep/glob/list/webfetch · writing = write/edit/patch ·
// command = bash · subagent = task.
export const AgentActivityKindSchema = z.enum(["analyzing", "writing", "command", "subagent"]);
// A tool surfaces while RUNNING (live, in-place, spinner) then COMPLETED.
export const ActivityStatusSchema = z.enum(["running", "completed"]);
export const TodoStatusSchema = z.enum(["pending", "in_progress", "completed", "cancelled"]);
export const LogLevelSchema = z.enum(["info", "warn", "error"]);

// ── The event body: a discriminated union on `type` ───────────────────────────
// Each variant feeds a dedicated TUI component (docs/tui-vnext.md §6). Adding a
// variant here is the ONLY way to surface a new live signal — there is no raw
// passthrough.
export const RunEventBodySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run.started"), app: z.string(), sha: z.string(), mode: RunModeSchema, target: TestTargetSchema }),
  z.object({ type: z.literal("step.changed"), step: RunStepSchema, detail: z.string().optional() }),
  z.object({
    type: z.literal("agent.activity"),
    kind: AgentActivityKindSchema,
    target: z.string(), // the file/pattern/command/subagent label (from ToolState.title)
    status: ActivityStatusSchema,
    callId: z.string().optional(), // OpenCode ToolPart.callID — stable key for in-place running→completed
    workerId: z.string().optional(), // set on parallelDiff fan-out, for the multi-worker view
  }),
  z.object({ type: z.literal("plan.updated"), todos: z.array(z.object({ content: z.string(), status: TodoStatusSchema })) }),
  z.object({ type: z.literal("spec.written"), file: z.string() }),
  z.object({ type: z.literal("test.discovered"), name: z.string(), file: z.string().optional() }),
  z.object({ type: z.literal("test.started"), name: z.string() }),
  z.object({ type: z.literal("test.passed"), name: z.string(), durationMs: z.number().nonnegative() }),
  z.object({ type: z.literal("test.failed"), name: z.string(), durationMs: z.number().nonnegative().optional(), detail: z.string().optional() }),
  z.object({ type: z.literal("test.flaky"), name: z.string(), attempts: z.number().int().positive() }),
  z.object({ type: z.literal("reviewer.verdict"), approved: z.boolean(), reasons: z.array(z.string()) }),
  z.object({ type: z.literal("coverage.computed"), changedLines: z.number().int().nonnegative(), coveredLines: z.number().int().nonnegative() }),
  z.object({ type: z.literal("run.verdict"), verdict: RunVerdictSchema, passed: z.number().int().nonnegative().optional(), failed: z.number().int().nonnegative().optional() }),
  z.object({ type: z.literal("agent.error"), detail: z.string() }),
  z.object({ type: z.literal("log.line"), level: LogLevelSchema, text: z.string() }), // fallback: only what is NOT a domain event
]);

// ── The wire envelope ─────────────────────────────────────────────────────────
// The gateway stamps `seq` (monotonic per run = the SSE event id and the
// Last-Event-ID resume cursor), `ts`, and `runId`. Producers emit only the body;
// transport identity is the gateway's to assign.
export const RunEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  runId: z.string(),
  ts: z.number().int().nonnegative(),
  body: RunEventBodySchema,
});

export type RunEventBody = z.infer<typeof RunEventBodySchema>;
export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunEventType = RunEventBody["type"];
