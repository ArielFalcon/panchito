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
  durationMs: z.number().nonnegative().optional(),
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

// Version/capability handshake (Phase D). A Homebrew binary lags the server in
// time, so the server is the single authority on compatibility: it returns its
// version + the oldest client it supports + what it can do, and decides
// `compatible` from the client version the connect screen sends.
export const VersionInfoSchema = z.object({
  serverVersion: z.string(),
  apiVersion: z.string(),
  minClientVersion: z.string(),
  compatible: z.boolean(),
  capabilities: z.array(z.string()),
  message: z.string().optional(),
});

// ── Command DTOs (request → response) ─────────────────────────────────────────
export const CreateRunInputSchema = z.object({
  app: z.string(),
  target: TestTargetSchema,
  mode: RunModeSchema,
  sha: z.string().optional(),
  ref: z.string().optional(),
  guidance: z.string().optional(),
  shadow: z.boolean().optional(),
  // diff mode only: how many commits ending at the run's SHA the diff spans (default 1).
  // Lets a run analyze a short series as one blast radius, not just the tip commit.
  commits: z.number().int().min(1).max(20).optional(),
});

export const CreateRunResultSchema = z.object({
  id: z.string(),
  app: z.string(),
  sha: z.string(),
  target: TestTargetSchema,
  mode: RunModeSchema,
  status: z.string(),
});

export const AskRequestSchema = z.object({
  question: z.string(),
  history: z.array(ChatEntrySchema).optional(),
});

export const AskResponseSchema = z.object({ answer: z.string() });

export const ContinueRequestSchema = z.object({
  cases: z.array(z.string()).optional(),
  guidance: z.string().optional(),
});

export const ContinueResultSchema = z.object({
  id: z.string(),
  parentRunId: z.string(),
});

// ── App onboarding DTOs ──────────────────────────────────────────────────────
export const OnboardServiceInputSchema = z.object({
  repo: z.string(),
  openapi: z.string().optional(),
  versionUrl: z.string().optional(),
});

export const RepoInfoSchema = z.object({
  name: z.string(),
  fullName: z.string(),
  private: z.boolean(),
  defaultBranch: z.string(),
  description: z.string().nullable(),
});

export const CreateAppInputSchema = z.object({
  repo: z.string(),
  name: z.string().optional(),
  baseUrl: z.string().optional(),
  versionUrl: z.string().optional(),
  target: TestTargetSchema.optional(),
  needsReview: z.boolean().optional(),
  shadow: z.boolean().optional(),
  testDataPrefix: z.string().optional(),
  services: z.array(OnboardServiceInputSchema).optional(),
  env: z.record(z.string(), z.string()).optional(),
  dryRun: z.boolean().optional(),
  validateOnly: z.boolean().optional(),
});

export const UpdateAppInputSchema = z.object({
  repo: z.string().optional(),
  baseUrl: z.string().optional(),
  versionUrl: z.string().optional(),
  target: TestTargetSchema.optional(),
  needsReview: z.boolean().optional(),
  shadow: z.boolean().optional(),
  testDataPrefix: z.string().optional(),
  services: z.array(OnboardServiceInputSchema).optional(),
  env: z.record(z.string(), z.string()).optional(),
  dryRun: z.boolean().optional(),
});

export const CreateAppResultSchema = z.object({
  ok: z.boolean(),
  errors: z.array(z.string()).optional(),
  repoInfo: RepoInfoSchema.optional(),
  yaml: z.string().optional(),
  name: z.string().optional(),
  path: z.string().optional(),
  envApplied: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
});

export const DeleteAppResultSchema = z.object({
  removed: z.array(z.string()),
});

export const RepoListItemSchema = z.object({
  fullName: z.string(),
  private: z.boolean(),
  description: z.string().nullable(),
});

export const RepoListResponseSchema = z.object({
  repos: z.array(RepoListItemSchema),
  hasMore: z.boolean(),
});

// ── Agent runtime DTOs ───────────────────────────────────────────────────────
export const AgentProviderSchema = z.enum(["opencode", "codex"]);
export const AgentModeSchema = z.enum(["single", "dual"]);
export const AgentRoleSchema = z.enum(["primary", "reviewer", "chat", "worker", "workerCode", "maintainer"]);

export const RoleAssignmentSchema = z.object({
  provider: AgentProviderSchema,
  model: z.string(),
});

export const AgentAssignmentsSchema = z.object({
  primary: RoleAssignmentSchema,
  reviewer: RoleAssignmentSchema,
  chat: RoleAssignmentSchema,
});

export const KeyPresenceSchema = z.object({
  opencode: z.boolean(),
  codex: z.boolean(),
});

export const AgentConfigValidationSchema = z.object({
  ok: z.boolean(),
  errors: z.array(z.string()),
  requiresSingleDowngradeConfirmation: z.boolean().optional(),
  downgradeProvider: AgentProviderSchema.optional(),
});

export const AgentRuntimeStatusSchema = z.enum(["stopped", "starting", "healthy", "degraded", "failed", "needs_config"]);

export const AgentProviderHealthSchema = z.object({
  provider: AgentProviderSchema,
  status: AgentRuntimeStatusSchema,
  configured: z.boolean(),
  error: z.string().optional(),
});

export const AgentHealthMapSchema = z.object({
  opencode: AgentProviderHealthSchema.optional(),
  codex: AgentProviderHealthSchema.optional(),
});

export const PublicAgentConfigSchema = z.object({
  mode: AgentModeSchema,
  singleProvider: AgentProviderSchema,
  assignments: AgentAssignmentsSchema,
  keys: KeyPresenceSchema,
  validation: AgentConfigValidationSchema,
  health: AgentHealthMapSchema.optional(),
});

export const AgentConfigUpdateSchema = z.object({
  mode: AgentModeSchema.optional(),
  singleProvider: AgentProviderSchema.optional(),
  assignments: AgentAssignmentsSchema.partial().optional(),
  apiKeys: z.object({
    opencode: z.string().optional(),
    codex: z.string().optional(),
  }).optional(),
  confirmSingleDowngrade: z.boolean().optional(),
});

export const AgentModelInfoSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  provider: AgentProviderSchema.optional(),
});

export const AgentModelsResponseSchema = z.object({
  provider: AgentProviderSchema,
  models: z.array(AgentModelInfoSchema),
});

export const AgentConfigApplyResultSchema = z.object({
  config: PublicAgentConfigSchema,
  restarted: z.array(AgentProviderSchema),
  downgraded: z.boolean().optional(),
});

export const AgentRestartRequestSchema = z.object({
  provider: AgentProviderSchema,
});

export const AgentRestartResponseSchema = z.object({
  health: AgentProviderHealthSchema,
});

// ── Inferred types (what the server and tests import) ─────────────────────────
export type QaCase = z.infer<typeof QaCaseSchema>;
export type SpecRecord = z.infer<typeof SpecRecordSchema>;
export type AgentActivity = z.infer<typeof AgentActivitySchema>;
export type RunRecord = z.infer<typeof RunRecordSchema>;
export type AppView = z.infer<typeof AppViewSchema>;
export type QueueStatus = z.infer<typeof QueueStatusSchema>;
export type ChatEntry = z.infer<typeof ChatEntrySchema>;
export type VersionInfo = z.infer<typeof VersionInfoSchema>;
export type CreateRunInput = z.infer<typeof CreateRunInputSchema>;
export type CreateRunResult = z.infer<typeof CreateRunResultSchema>;
export type AskRequest = z.infer<typeof AskRequestSchema>;
export type AskResponse = z.infer<typeof AskResponseSchema>;
export type ContinueRequest = z.infer<typeof ContinueRequestSchema>;
export type ContinueResult = z.infer<typeof ContinueResultSchema>;
export type OnboardServiceInput = z.infer<typeof OnboardServiceInputSchema>;
export type RepoInfo = z.infer<typeof RepoInfoSchema>;
export type CreateAppInput = z.infer<typeof CreateAppInputSchema>;
export type UpdateAppInput = z.infer<typeof UpdateAppInputSchema>;
export type CreateAppResult = z.infer<typeof CreateAppResultSchema>;
export type DeleteAppResult = z.infer<typeof DeleteAppResultSchema>;
export type RepoListItem = z.infer<typeof RepoListItemSchema>;
export type RepoListResponse = z.infer<typeof RepoListResponseSchema>;
export type AgentProvider = z.infer<typeof AgentProviderSchema>;
export type AgentMode = z.infer<typeof AgentModeSchema>;
export type AgentRole = z.infer<typeof AgentRoleSchema>;
export type RoleAssignment = z.infer<typeof RoleAssignmentSchema>;
export type PublicAgentConfig = z.infer<typeof PublicAgentConfigSchema>;
export type AgentConfigUpdate = z.infer<typeof AgentConfigUpdateSchema>;
export type AgentModelInfo = z.infer<typeof AgentModelInfoSchema>;
export type AgentConfigApplyResult = z.infer<typeof AgentConfigApplyResultSchema>;
export type AgentRestartRequest = z.infer<typeof AgentRestartRequestSchema>;
export type AgentRestartResponse = z.infer<typeof AgentRestartResponseSchema>;

// ── Intelligence (read-only projections of the persisted learning artifacts) ──────
// The operator console renders these; they are honest views of what the ledger, the
// value-oracle scorecard and the curriculum actually hold — no signal is invented.

export const LearningRuleViewSchema = z.object({
  trigger: z.string(),
  action: z.string(),
  errorClass: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
  usageCount: z.number().int().nonnegative(),
  outcomeCount: z.number().int().nonnegative(),
  successRate: z.number().nullable(),
  status: z.enum(["candidate", "active", "deprecated", "superseded"]),
});

export const ScorecardViewSchema = z.object({
  updatedAt: z.string(),
  totalRuns: z.number().int().nonnegative(),
  measuredRuns: z.number().int().nonnegative(),
  avgValueScore: z.number().nullable(),
  lastValueScore: z.number().nullable(),
  entries: z.array(
    z.object({
      valueScore: z.number().nullable(),
      mutantCount: z.number().int().nonnegative(),
      killedCount: z.number().int().nonnegative(),
      target: z.string(),
      at: z.string(),
    }),
  ),
});

export const CurriculumViewSchema = z.object({
  updatedAt: z.string(),
  archetypes: z.array(
    z.object({
      archetype: z.string(),
      caughtRealBug: z.boolean(),
      promotionCount: z.number().int().nonnegative(),
    }),
  ),
});

export const IntelligenceViewSchema = z.object({
  app: z.string(),
  rules: z.array(LearningRuleViewSchema),
  scorecard: ScorecardViewSchema.nullable(),
  curriculum: CurriculumViewSchema.nullable(),
});

export type IntelligenceView = z.infer<typeof IntelligenceViewSchema>;

// ── Signals (fleet-wide integrity readout — the anti-Goodhart panel) ───────────────
// The honest answer to "can I trust the fleet's green?". It juxtaposes the ground-truth
// value-oracle (◆, real, from the aggregated scorecards) against the proxy the rest of
// the console shows everywhere (◇ pass rate), and states plainly that change-coverage is
// not measured yet (⚠). Every field is derived from persisted data — nothing is invented.
export const SignalsViewSchema = z.object({
  // ◆ ground truth: do the tests actually catch injected bugs? (value-oracle scorecard)
  valueOracle: z.object({
    measured: z.boolean(),
    avgScore: z.number().nullable(), // 0..1, weighted by measured runs; null when unmeasured
    measuredRuns: z.number().int().nonnegative(),
    totalRuns: z.number().int().nonnegative(),
  }),
  // ◇ proxy: the LLM reviewer + harness produce a green/red verdict — useful, but circular.
  reviewer: z.object({
    passRate: z.number().nullable(), // fraction of quality-verdict runs that passed
    runs: z.number().int().nonnegative(), // runs that produced a quality verdict (pass/fail/flaky/invalid)
  }),
  // ⚠ keystone, not built yet: does executing the test cover the changed lines?
  coverage: z.object({
    measured: z.boolean(),
  }),
});

export type SignalsView = z.infer<typeof SignalsViewSchema>;
