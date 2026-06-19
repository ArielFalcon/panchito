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
      // Fase 3: run a read-only explorer pass before the generator on single-agent diff runs, so the
      // generator gets a distilled blast-radius brief instead of re-exploring. Default off (cost/opt-in).
      explorer: z.boolean().optional(),
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
      // Run-intelligence report tuning. `weights` overrides the ranker's per-insight interestingness
      // weight by insight id (e.g. { "change-coverage": 1.5 }); ids left out keep their defaults.
      reports: z
        .object({
          weights: z.record(z.string(), z.number().nonnegative()).optional(),
        })
        .optional(),
      // Fix-loop budget: cap the number of grounded regeneration retries (default 2, max 5).
      // Set 0 to disable the loop entirely. The progress gate may stop sooner; this is the hard cap.
      fixLoop: z
        .object({
          maxRetries: z.number().int().min(0).max(5).optional(),
        })
        .optional(),
      // Phase 6a: shared iteration ceiling across ALL four regeneration loops (review, static-fix,
      // exec-fix, coverage-enforce) plus the two in-session contract-repair re-prompts (generator
      // and reviewer). When the counter reaches this value no further generateAndReview() call is
      // made; the run concludes with the last available state and logs the reason.
      // NOTE: generateParallel workers are intentionally excluded — they run inside their own
      // per-session timeout (OPENCODE_TIMEOUT_MS) and are bounded by that mechanism, not this
      // shared counter. This is by design: parallel workers are fire-and-join, not iterated loops.
      // Default (undefined) → a runaway BACKSTOP derived from the configured loop caps (review +
      // static-fix + exec-fix + coverage-enforce, plus repair headroom — see pipeline.ts
      // deriveCycleBackstop). It sits at the legitimate worst case so it never truncates a valid
      // run (including maxRetries=5); only a true runaway above it is stopped. Calibratable down
      // from Phase-0 telemetry. This is the safety backstop, NOT the symptom lever (Phases 3–4).
      iterationBudget: z.number().int().positive().optional(),
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
  // Content checksum of the spec file, written by the orchestrator at manifest time for
  // integrity verification. Declared here (optional) so the schema matches what the write
  // path actually emits and the read path preserves it instead of silently stripping it
  // (post-ADR-001, Phase 3.1 — write↔read expressed as one schema).
  sha256: z.string().optional(),
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
  mode: z.enum(["diff", "complete", "exhaustive", "manual", "context"]).optional(),
  guidance: z.string().optional(),
});

export type ValidatedWebhookPayload = z.infer<typeof WebhookPayloadSchema>;

// ── Agent verdict contract (post-ADR-001, Phase 1) ────────────────────────────
// The agent emits TWO distinct verdicts, validated against these schemas (see
// integrations/verdict-validate.ts). The ADR-001 evaluation rejected MCP-ifying the
// orchestrator↔agent boundary but kept its real improvement: make the agent's output a
// typed, validated contract instead of JSON scraped best-effort from free text.

// Per-spec metadata in the generator's closing JSON (and, post-reconciliation, the manifest).
export const SpecMetaSchema = z.object({
  file: z.string().trim().min(1),
  flow: z.string().trim().min(1),
  objective: z.string().trim().min(1),
  // targets may be empty: a spec need not name specific code symbols. Defaulting keeps the
  // contract as lenient here as parseSpecMetas is on extraction.
  targets: z.array(z.string()).default([]),
});

// The GENERATOR's deliverable. It no longer self-reports `approved` — the independent
// reviewer is the authoritative gate — so its closing JSON is just the specs it wrote plus
// optional per-spec metadata. An EMPTY specs array is a valid no-op (nothing worth testing),
// so `specs` is required-but-may-be-empty. A stray legacy `approved` is ignored (stripped).
export const GeneratorVerdictSchema = z.object({
  specs: z.array(z.string()),
  specMetas: z.array(SpecMetaSchema).optional(),
  note: z.string().optional(),
});

export type ValidatedGeneratorVerdict = z.infer<typeof GeneratorVerdictSchema>;

// The REVIEWER's verdict — the AUTHORITATIVE gate. Only `approved` is load-bearing for the
// publish decision, so it is the only strict field; `rationale` and `corrections` are
// tolerant (`.catch`) so a formatting slip in advisory fields can NEVER turn a genuine
// approval into a fail-closed rejection. A missing/non-boolean `approved` is the one thing
// worth a repair re-prompt.
//
// Phase 4: each correction entry may carry an optional `severity` field.
// The gate approves when zero BLOCKING corrections remain (advisory corrections are
// non-fatal notes — recorded but do not fail the gate).
// Backward-compat rule: a plain string correction (no severity) defaults to BLOCKING
// (fail-closed). A structured entry without a valid severity also defaults to BLOCKING.
// Entries are tolerant (.catch) so a formatting slip in any single correction never
// turns a genuine approval into a fail-closed rejection.
export const CorrectionEntrySchema = z.union([
  // Structured entry with severity: the Phase-4 contract.
  z.object({
    text: z.string(),
    severity: z.enum(["blocking", "advisory"]),
  }),
  // Legacy plain-string entry: treated as blocking (fail-closed backward compat).
  z.string(),
]);

export type CorrectionEntry = z.infer<typeof CorrectionEntrySchema>;

// Resolve a correction entry to its canonical text string.
export function correctionText(entry: CorrectionEntry): string {
  return typeof entry === "string" ? entry : entry.text;
}

// Resolve a correction entry's severity. Defaults to "blocking" for plain strings
// and any entry without an explicit severity (fail-closed backward compat).
export function correctionSeverity(entry: CorrectionEntry): "blocking" | "advisory" {
  if (typeof entry === "string") return "blocking";
  return entry.severity;
}

export const ReviewerVerdictSchema = z.object({
  approved: z.boolean(),
  rationale: z.string().optional().catch(undefined),
  // Tolerance is PER-ENTRY. An array-level `.catch([])` was fail-OPEN: a SINGLE malformed element
  // collapsed the WHOLE array to [], so a verdict carrying one blocking correction alongside one
  // unparseable element yielded blockingCount=0 → the severity gate APPROVED while silently dropping
  // the blocking finding. The inner per-entry `.catch` instead degrades a bad element to a BLOCKING
  // placeholder, so a malformed entry FAILS the gate closed (blockingCount>0) while the valid
  // siblings are preserved. The outer array-level `.catch([])` still guards the orthogonal case where
  // `corrections` is not an array at all (e.g. a stray string) — that advisory-shape slip must not
  // false-block a genuine approval, exactly as before.
  corrections: z
    .array(CorrectionEntrySchema.catch({ text: "(unparseable correction)", severity: "blocking" }))
    .catch([]),
});

export type ValidatedReviewerVerdict = z.infer<typeof ReviewerVerdictSchema>;
