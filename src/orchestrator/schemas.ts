import { z } from "zod";

// ── AppConfig schema ──────────────────────────────────────────────────────────
// Validates YAML config loaded from config/apps/<name>.yaml. Replaces the unsafe
// `parse(raw) as AppConfig` cast with runtime validation.
export const AppConfigSchema = z
  .object({
    name: z.string().min(1, { error: "app name is required" }),
    repo: z.string().min(1, { error: "repo is required (e.g. 'org/repo')" }),
    baseBranch: z.string().optional(),
    openapi: z.union([z.string(), z.array(z.string())]).optional(),
    // `services` (e2e apps only): the microservice repos that participate in this
    // app's flows. A deploy-event webhook from one of these repos triggers an e2e
    // run of THIS app with the service's diff as blast radius. openapi is a glob
    // INSIDE the service repo; versionUrl is an optional deploy-verification belt.
    services: z
      .array(
        z.object({
          repo: z.string().min(1, { error: "service repo is required (e.g. 'org/svc')" }),
          baseBranch: z.string().optional(),
          openapi: z.union([z.string(), z.array(z.string())]).optional(),
          versionUrl: z.url().optional(),
          pollIntervalMs: z.number().int().positive().optional(),
          deployTimeoutMs: z.number().int().positive().optional(),
        }),
      )
      .optional(),
    // `dev` is OPTIONAL: code-mode apps (code: true) test source-code logic with no
    // web environment, so they have no DEV URL. The refine below enforces presence
    // for e2e apps.
    dev: z
      .object({
        baseUrl: z.url({ error: "dev.baseUrl must be a valid URL" }),
        versionUrl: z.url().optional(),
        pollIntervalMs: z.number().int().positive().optional(),
        deployTimeoutMs: z.number().int().positive().optional(),
      })
      .optional(),
    qa: z.object({
      needsReview: z.boolean(),
      testDataPrefix: z.string().min(1, { error: "qa.testDataPrefix is required" }),
      shadow: z.boolean().optional(),
      // Diff-mode fan-out: when true, a diff run plans the blast radius into objectives
      // and dispatches parallel qa-workers (>=2 objectives; single-agent otherwise).
      // Default off: protects cost/determinism for simple apps.
      parallelDiff: z.boolean().optional(),
      // Change-coverage policy (the value keystone). off = skip; signal (default) = measure +
      // record only; enforce = also try to close the gap and block publishing if it stays low.
      changeCoverage: z
        .object({
          mode: z.enum(["off", "signal", "enforce"]).optional(),
          minRatio: z.number().min(0).max(1).optional(),
        })
        .optional(),
      // e2e value oracle (response fault-injection). off (default) = skip; signal = re-run the
      // green suite with corrupted responses and record the catch-rate. NEVER blocks publish, and
      // it DOUBLES the DEV run — so it is opt-in.
      valueOracle: z.enum(["off", "signal"]).optional(),
    }),
    code: z.boolean().optional(),
    report: z.object({
      onFailure: z.string().min(1),
    }),
  })
  .refine((c) => c.code === true || c.dev !== undefined, {
    error: "dev is required unless code: true (code mode has no web environment)",
    path: ["dev"],
  })
  .refine((c) => !(c.code === true && (c.services?.length ?? 0) > 0), {
    error: "services are only valid for e2e apps (code-mode apps have no E2E suite)",
    path: ["services"],
  })
  .refine(
    (c) => {
      const repos = [c.repo, ...(c.services ?? []).map((s) => s.repo)];
      return new Set(repos).size === repos.length;
    },
    { error: "service repos must be unique and different from the primary repo", path: ["services"] },
  );

export type ValidatedAppConfig = z.infer<typeof AppConfigSchema>;
export type ServiceConfig = NonNullable<ValidatedAppConfig["services"]>[number];

// ── Manifest entry schema ─────────────────────────────────────────────────────
// Per-test metadata that lives in e2e/.qa/manifest.json. Validates the day-one
// fields written by the agent; measured/derived fields are optional.
export const ManifestEntrySchema = z.object({
  id: z.string().min(1, { error: "manifest entry missing 'id'" }),
  objective: z.string().min(1, { error: "manifest entry missing 'objective'" }),
  flow: z.string().min(1, { error: "manifest entry missing 'flow'" }),
  useCase: z.string().optional(),
  targets: z.array(z.string()).min(1, { error: "manifest entry has empty 'targets'" }),
  changeRef: z.object({
    sha: z.string().min(1),
    type: z.string().min(1),
    pr: z.number().optional(),
    ticket: z.string().optional(),
  }),
  criticality: z.enum(["critical", "normal"]).optional(),
  owner: z.string().optional(),
  createdAt: z.string().optional(),
  coverage: z
    .object({
      files: z.array(z.string()).optional(),
      functions: z.array(z.string()).optional(),
    })
    .optional(),
  sensitivity: z
    .object({
      status: z.enum(["pass", "fail", "unknown"]),
      method: z.string().optional(),
      at: z.string().optional(),
    })
    .optional(),
  stability: z
    .object({
      runs: z.number(),
      flakyRuns: z.number(),
    })
    .optional(),
  ledger: z
    .object({
      caughtRegressions: z.number(),
      falsePositives: z.number(),
    })
    .optional(),
  merit: z.number().optional(),
});

export const ManifestSchema = z.array(ManifestEntrySchema);

export type ValidatedManifestEntry = z.infer<typeof ManifestEntrySchema>;

// ── Webhook payload schema ────────────────────────────────────────────────────
// Validates the incoming POST body from GitHub / manual triggers.
export const WebhookPayloadSchema = z.object({
  repo: z.string().min(1),
  sha: z.string().min(7),
  target: z.enum(["e2e", "code"]).optional(),
  mode: z.enum(["diff", "complete", "exhaustive", "manual"]).optional(),
  guidance: z.string().optional(),
});

export type ValidatedWebhookPayload = z.infer<typeof WebhookPayloadSchema>;

// ── Final verdict schema ──────────────────────────────────────────────────────
// Extracted from the AI agent's closing JSON. Used in parseVerdict.
export const SpecMetaSchema = z.object({
  file: z.string().min(1),
  flow: z.string().min(1),
  objective: z.string().min(1),
  targets: z.array(z.string()),
});

export const FinalVerdictSchema = z.object({
  approved: z.boolean(),
  specs: z.array(z.string()),
  specMetas: z.array(SpecMetaSchema).optional(),
  note: z.string().optional(),
});

export type ValidatedFinalVerdict = z.infer<typeof FinalVerdictSchema>;
