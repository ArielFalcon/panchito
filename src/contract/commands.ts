// Command-side DTOs + the shared wire entities clients render — the other half
// of the Channel Gateway contract (events.ts is the live-stream half). Defined in
// zod so the server gets types via `z.infer` (server ≡ schema) and the same
// schemas emit the OpenAPI artifact (openapi.ts). These MIRROR src/types.ts and
// src/tui/client.ts exactly; commands.test.ts holds a compile-time drift guard
// so the two cannot silently diverge during the migration. See docs/tui-vnext.md §3.

import { z } from "zod";
import { TestTargetSchema, RunModeSchema, RunVerdictSchema } from "./events";

// ── Shared wire entities (mirror src/types.ts) ────────────────────────────────
export const CaseStatusSchema = z.enum(["pass", "fail", "flaky"]);

export const QaCaseSchema = z.object({
  name: z.string(),
  status: CaseStatusSchema,
  detail: z.string().optional(),
  flow: z.string().optional(),
  objective: z.string().optional(),
  reason: z.string().optional(),
});

export const SpecRecordSchema = z.object({
  name: z.string(),
  objective: z.string().optional(),
  flow: z.string().optional(),
});

// The persisted live-activity feed on RunRecord (legacy ActivityKind from
// src/types.ts). Distinct from events.ts AgentActivityKind — the two coexist
// during the migration; this one mirrors what history.ts stores today.
export const ActivityKindSchema = z.enum(["file", "command", "todo", "phase", "error"]);

export const AgentActivitySchema = z.object({
  kind: ActivityKindSchema,
  text: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]).optional(),
  ts: z.string(),
});

export const RunStatusSchema = z.enum(["enqueued", "running", "done"]);

export const RunRecordSchema = z.object({
  id: z.string(),
  app: z.string(),
  sha: z.string(),
  ref: z.string().optional(),
  target: TestTargetSchema,
  mode: RunModeSchema,
  status: RunStatusSchema,
  step: z.string().optional(),
  stepDetail: z.string().optional(),
  verdict: RunVerdictSchema.optional(),
  passed: z.number().int().nonnegative().optional(),
  failed: z.number().int().nonnegative().optional(),
  note: z.string().optional(),
  retrying: z.boolean().optional(),
  parentRunId: z.string().optional(),
  triggerRepo: z.string().optional(),
  cases: z.array(QaCaseSchema),
  specs: z.array(SpecRecordSchema).optional(),
  logs: z.array(z.string()),
  activity: z.array(AgentActivitySchema).optional(),
  stepStartedAt: z.string().optional(),
  at: z.string(),
});

// The app projection clients render — mirrors src/tui/client.ts AppView.
export const AppServiceViewSchema = z.object({
  repo: z.string(),
  openapi: z.string().optional(),
  versionUrl: z.string().optional(),
});

export const AppViewSchema = z.object({
  name: z.string(),
  repo: z.string(),
  baseUrl: z.string(),
  versionUrl: z.string(),
  code: z.boolean(),
  shadow: z.boolean(),
  needsReview: z.boolean(),
  testDataPrefix: z.string(),
  services: z.array(AppServiceViewSchema),
});

export const QueueStatusSchema = z.object({
  pending: z.number().int().nonnegative(),
  running: z.object({ id: z.string(), app: z.string() }).nullable(),
});

export const ChatEntrySchema = z.object({ role: z.string(), text: z.string() });

// ── Command DTOs (request → response) ─────────────────────────────────────────
export const CreateRunInputSchema = z.object({
  app: z.string(),
  target: TestTargetSchema,
  mode: RunModeSchema,
  sha: z.string().optional(),
  ref: z.string().optional(),
  guidance: z.string().optional(),
  shadow: z.boolean().optional(),
});

export const CreateRunResultSchema = z.object({
  id: z.string(),
  app: z.string(),
  sha: z.string(),
  mode: RunModeSchema,
  status: z.string(),
});

export const AskRequestSchema = z.object({
  question: z.string(),
  history: z.array(ChatEntrySchema).optional(),
});

export const AskResponseSchema = z.object({ answer: z.string() });

export const ContinueRequestSchema = z.object({
  cases: z.array(z.string()),
  guidance: z.string().optional(),
});

export const ContinueResultSchema = z.object({
  id: z.string(),
  parentRunId: z.string(),
});

// ── Inferred types (what the server and tests import) ─────────────────────────
export type QaCase = z.infer<typeof QaCaseSchema>;
export type SpecRecord = z.infer<typeof SpecRecordSchema>;
export type AgentActivity = z.infer<typeof AgentActivitySchema>;
export type RunRecord = z.infer<typeof RunRecordSchema>;
export type AppView = z.infer<typeof AppViewSchema>;
export type QueueStatus = z.infer<typeof QueueStatusSchema>;
export type ChatEntry = z.infer<typeof ChatEntrySchema>;
export type CreateRunInput = z.infer<typeof CreateRunInputSchema>;
export type CreateRunResult = z.infer<typeof CreateRunResultSchema>;
export type AskRequest = z.infer<typeof AskRequestSchema>;
export type AskResponse = z.infer<typeof AskResponseSchema>;
export type ContinueRequest = z.infer<typeof ContinueRequestSchema>;
export type ContinueResult = z.infer<typeof ContinueResultSchema>;
