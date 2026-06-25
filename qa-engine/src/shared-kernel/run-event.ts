// qa-engine/src/shared-kernel/run-event.ts
// The closed RunEvent domain-event vocabulary. Defines the Zod schema locally so the kernel compiles
// without crossing the qa-engine rootDir boundary — the frozen wire source of truth remains
// src/contract/events.ts, and contract/index.ts re-exports it for adapters that bridge the trees;
// the kernel keeps a self-contained, schema-identical copy here so the standalone typecheck passes.
// Adding a variant means adding it to src/contract/events.ts FIRST, then mirroring here.

import { z } from "zod";
export type { AgentRole, RoleAssignment, AgentProvider } from "./agent-role.ts";

// ── Wire enums ────────────────────────────────────────────────────────────────
const RunVerdictSchema = z.enum(["pass", "fail", "flaky", "invalid", "infra-error", "skipped"]);
const RunEngineStatusSchema = z.enum(["success", "error"]);
const RunModeSchema = z.enum(["diff", "complete", "exhaustive", "manual", "context"]);
const TestTargetSchema = z.enum(["e2e", "code"]);
const RunStepSchema = z.enum([
  "gate", "classify", "setup", "generate", "validate", "health", "execute", "coverage", "retry", "decide", "done",
]);
const AgentActivityKindSchema = z.enum(["analyzing", "writing", "command", "subagent"]);
const ActivityStatusSchema = z.enum(["running", "completed"]);
const TodoStatusSchema = z.enum(["pending", "in_progress", "completed", "cancelled"]);
const LogLevelSchema = z.enum(["info", "warn", "error"]);

// ── The event body ─────────────────────────────────────────────────────────────
export const RunEventBodySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run.started"), app: z.string(), sha: z.string(), mode: RunModeSchema, target: TestTargetSchema }),
  z.object({ type: z.literal("step.changed"), step: RunStepSchema, detail: z.string().optional() }),
  z.object({
    type: z.literal("agent.activity"),
    kind: AgentActivityKindSchema,
    target: z.string(),
    status: ActivityStatusSchema,
    callId: z.string().optional(),
    workerId: z.string().optional(),
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
  z.object({ type: z.literal("run.verdict"), verdict: RunVerdictSchema, engineStatus: RunEngineStatusSchema, passed: z.number().int().nonnegative().optional(), failed: z.number().int().nonnegative().optional(), outcome: z.string().optional() }),
  z.object({ type: z.literal("agent.error"), detail: z.string() }),
  z.object({ type: z.literal("log.line"), level: LogLevelSchema, text: z.string() }),
]);

// ── The wire envelope ─────────────────────────────────────────────────────────
export const RunEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  runId: z.string(),
  ts: z.number().int().nonnegative(),
  body: RunEventBodySchema,
});

export type RunEventBody = z.infer<typeof RunEventBodySchema>;
export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunEventType = RunEventBody["type"];
