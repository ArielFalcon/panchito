// Command-side DTOs + the shared wire entities clients render — the other half
// of the Channel Gateway contract (events.ts is the live-stream half). Defined in
// zod so the server gets types via `z.infer` (server ≡ schema) and the same
// schemas emit the OpenAPI artifact (openapi.ts). These MIRROR src/types.ts and
// src/tui/client.ts exactly; commands.test.ts holds a compile-time drift guard
// so the two cannot silently diverge during the migration. See docs/tui-vnext.md §3.

import { z } from "zod";
import { TestTargetSchema, RunModeSchema, RunVerdictSchema, RunEngineStatusSchema } from "./events";

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
  // Derived from `verdict` once the run is `done` (src/types.ts engineStatus). OPTIONAL — absent while
  // the run is enqueued/running and has no verdict yet; a still-running run is not an "error".
  engineStatus: RunEngineStatusSchema.optional(),
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
  // The server's GitHub OAuth App client id (public). Present when GitHub login is configured,
  // so the console can run the device flow without the id being baked into the binary.
  githubClientId: z.string().optional(),
});

// ── Auth (GitHub device flow → server session) ────────────────────────────────
// The client runs the GitHub OAuth device flow itself, then exchanges the resulting
// GitHub user token for a short-lived server session. The server verifies the token's
// identity and that the user can push to a watched repo before issuing the session.
export const LoginRequestSchema = z.object({
  githubToken: z.string().min(1),
});

export const LoginResponseSchema = z.object({
  token: z.string(), // the server session (JWT) the client stores and sends as Bearer
  username: z.string(), // the authenticated GitHub login, for display
  expiresAt: z.string(), // ISO-8601 session expiry, so the client can refresh ahead of time
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
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type LoginResponse = z.infer<typeof LoginResponseSchema>;
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
  // "pending" is a RETIRED status (kept in the enum only for backward-compat with rows an older
  // build may have written; nothing inserts it anymore — correction-sourced rules now enter as
  // "candidate", see distiller.ts). Included in the contract so the ledger CLI and intelligence view
  // can still surface any legacy pending rows to the operator.
  status: z.enum(["pending", "candidate", "active", "deprecated", "superseded"]),
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
  // ◆/⚠ change-coverage: of runs that produced coverage data, what fraction of the changed
  // lines did the tests actually exercise? avgRatio is null (→ "not measured") when no run
  // carried a ratio — never a hard 0 painted as a reading.
  coverage: z.object({
    measured: z.boolean(),
    avgRatio: z.number().nullable(),
    measuredRuns: z.number().int().nonnegative(),
    totalRuns: z.number().int().nonnegative(),
  }),
});

export type SignalsView = z.infer<typeof SignalsViewSchema>;

// ── Trends & report (period-over-period analytics the report surface renders) ──────────────
// Derived from persisted run outcomes (change-coverage ratio, value-oracle score, verdict,
// error class) split into a current vs previous window — nothing invented. The report ranks
// these by how much they MOVED (interestingness) and picks a chart per metric shape.
export const TrendWindowSchema = z.object({
  current: z.number().int().nonnegative(),
  previous: z.number().int().nonnegative(),
});

export const CoverageTrendSchema = z.object({
  measured: z.boolean(),
  ratio: z.number().nullable(),
  previousRatio: z.number().nullable(),
  minRatio: z.number(),
  series: z.array(z.number()),
});

export const ValueTrendSchema = z.object({
  measured: z.boolean(),
  avgScore: z.number().nullable(),
  previousAvgScore: z.number().nullable(),
  series: z.array(z.number()),
});

export const FlakyTrendSchema = z.object({
  rate: z.number().nullable(),
  previousRate: z.number().nullable(),
  runs: z.number().int().nonnegative(),
});

export const ErrorClassCountSchema = z.object({
  errorClass: z.string(),
  count: z.number().int().nonnegative(),
  previousCount: z.number().int().nonnegative(),
  multiplier: z.number().nullable(),
});

// Suite execution time (sum of case durations per run), averaged per window — a perf trend.
export const DurationTrendSchema = z.object({
  avgMs: z.number().nullable(),
  previousMs: z.number().nullable(),
  runs: z.number().int().nonnegative(),
});

// Per-flow stability: of the cases tagged with a user flow, how many flaked/failed in the window —
// shows WHERE the instability concentrates. Only unstable flows are surfaced.
export const FlowStabilitySchema = z.object({
  flow: z.string(),
  runs: z.number().int().nonnegative(),
  flaky: z.number().int().nonnegative(),
  fail: z.number().int().nonnegative(),
});

export const TrendsViewSchema = z.object({
  app: z.string(),
  generatedAt: z.string(),
  window: TrendWindowSchema,
  coverage: CoverageTrendSchema,
  valueOracle: ValueTrendSchema,
  verdictMix: z.record(z.string(), z.number().int().nonnegative()),
  reviewerPassRate: z.number().nullable(),
  flaky: FlakyTrendSchema,
  errorClasses: z.array(ErrorClassCountSchema),
  duration: DurationTrendSchema,
  flows: z.array(FlowStabilitySchema),
});

export type TrendsView = z.infer<typeof TrendsViewSchema>;

export const ReportChartSchema = z.enum([
  "big-number", "gauge", "paired-bars", "ranked-bars", "stacked-bar", "line", "area", "donut",
]);

// The data SHAPE of an insight. Clients render BY INTENT: a client that cannot draw the preferred
// `chart` (e.g. a terminal has no good pie) falls back to the best native form for the intent
// (terminal composition → stacked bar / percentages; web composition → donut). This keeps the
// contract multi-client without the backend knowing which client consumes it.
export const InsightIntentSchema = z.enum([
  "single-value", "comparison", "trend", "composition", "distribution",
]);

// How `value` should be read/formatted, so every client formats it consistently.
export const InsightUnitSchema = z.enum(["ratio", "percent", "count", "ms", "score"]);

// One slice of a composition/distribution. `semantic` lets the backend say "this slice is good/bad"
// (pass=good, fail=bad) so every client colours it identically without hardcoding domain names.
export const BreakdownItemSchema = z.object({
  label: z.string(),
  value: z.number(),
  semantic: z.enum(["good", "bad", "neutral"]).optional(),
});

// One ranked insight in an ad-hoc report: a metric that moved, fully SELF-DESCRIBING so any client
// can render it without domain knowledge. `intent` + `chart` drive the visual; `score` is the
// interestingness ranking; `goodWhen` lets the client colour the direction (a coverage rise is
// good, a flaky rise is not).
export const ReportInsightSchema = z.object({
  id: z.string(),
  title: z.string(),
  intent: InsightIntentSchema,
  chart: ReportChartSchema, // preferred chart; clients may fall back to the intent's native form
  value: z.number().nullable(),
  unit: InsightUnitSchema.optional(),
  target: z.number().nullable().optional(), // a threshold line (e.g. coverage minRatio) for gauge/line
  delta: z.number().nullable(),
  multiplier: z.number().nullable(),
  direction: z.enum(["up", "down", "flat"]),
  goodWhen: z.enum(["up", "down", "neutral"]),
  caption: z.string().optional(), // a short human one-liner the client can show under the chart
  series: z.array(z.number()).optional(),
  breakdown: z.array(BreakdownItemSchema).optional(),
  score: z.number(),
});

export const ReportViewSchema = z.object({
  app: z.string(),
  generatedAt: z.string(),
  window: TrendWindowSchema,
  headline: z.string(),
  insights: z.array(ReportInsightSchema),
});

export type ReportView = z.infer<typeof ReportViewSchema>;

// A run-scoped report bundles the TWO analyses the post-run summary surface shows: `current` — the
// self-describing report about THE RUN THAT FINISHED (its verdict, case mix, this run's
// change-coverage / value-oracle / duration) — and `evolution` — the period-over-period report of
// the same app as it stood at that run, or null when there is not yet enough history to compare
// against. Both halves are the SAME ReportView shape, so a client renders them with one renderer.
export const RunReportViewSchema = z.object({
  current: ReportViewSchema,
  evolution: ReportViewSchema.nullable(),
});

export type RunReportView = z.infer<typeof RunReportViewSchema>;
