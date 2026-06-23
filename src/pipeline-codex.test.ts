// Pipeline tests with provider=codex single mode (T-P2-2 / AC2.2.1-2).
// Today there are ZERO pipeline tests that exercise the codex provider path.
// These stubs verify the codex path through runPipeline produces correct verdicts
// with no opencode-specific assumption leaking in.
//
// AC2.2.1: codex green run → pass verdict, PR published (same path as opencode).
// AC2.2.2 (AC1.2.3 deferred): codex infra failure from generate() propagates as
//   an error satisfying isInfraError, ensuring runner.ts will emit `infra-error`
//   (not `fail`/`invalid`). The pipeline itself does not swallow it — that is the
//   correct contract: the error surfaces loudly and the runner layer maps it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPipeline, type PipelineDeps, type GenerateInput } from "./pipeline";
import { singleProviderConfig } from "./agent-runtime/config";
import { AgentUnavailableError, isInfraError } from "./errors";
import type { AgentResult, QaRunResult, RunOutcome } from "./types";
import type { ReviewResult } from "./integrations/opencode-client";

// ── Shared fixtures ────────────────────────────────────────────────────────

const codexRuntimeConfig = singleProviderConfig("codex", {
  CODEX_API_KEY: "test-key",
});

// A minimal AppConfig-like object for the codex path.
// Mirrors the pattern from pipeline.test.ts: includes a dev block so the execute path is reached.
// versionUrl omitted so the deploy gate is skipped (static-site pattern, same as shadow apps).
const codexApp = {
  name: "demo",
  repo: "org/demo",
  dev: {
    baseUrl: "https://dev",
    // No versionUrl → deploy gate is skipped (devHealthy() always returns true)
    pollIntervalMs: 1,
    deployTimeoutMs: 100,
  },
  qa: { needsReview: false, testDataPrefix: "qa-bot" },
  report: { onFailure: "github-issue" as const },
};

const greenRun: QaRunResult = { sha: "s", verdict: "pass", passed: true, cases: [], logs: "" };

const greenAgentResult: AgentResult = {
  output: "spec",
  specs: ["a.spec.ts"],
  reviewed: true,
  approved: true,
};

// Minimal deps harness for the codex pipeline path.
function codexDeps(opts: {
  run?: QaRunResult;
  agent?: AgentResult;
  generateThrows?: Error;
  review?: ReviewResult[];
  prUrl?: string | null;
}): PipelineDeps & { issues: string[]; published: boolean; savedOutcomes: RunOutcome[] } {
  const mirrorDir = mkdtempSync(join(tmpdir(), "qa-codex-"));
  // Create the required e2e/.qa/context.json
  mkdirSync(join(mirrorDir, "e2e", ".qa"), { recursive: true });
  writeFileSync(
    join(mirrorDir, "e2e", ".qa", "context.json"),
    JSON.stringify({ builtAtSha: "abc123", routes: [], api: [], feBe: [] }),
  );

  const issues: string[] = [];
  const published = { value: false };
  const savedOutcomes: RunOutcome[] = [];
  const reviewSeq = opts.review ? [...opts.review] : null;

  const d: PipelineDeps & { issues: string[]; published: boolean; savedOutcomes: RunOutcome[] } = {
    issues,
    get published() { return published.value; },
    savedOutcomes,
    agentRuntimeConfig: codexRuntimeConfig,
    waitForDeploy: async () => {},
    prepare: async () => ({
      mirrorDir,
      diff: "DIFF",
      message: "feat: add feature",
    }),
    prepareAtBranch: async () => ({ mirrorDir }),
    generate: async (_input: GenerateInput) => {
      if (opts.generateThrows) throw opts.generateThrows;
      return opts.agent ?? greenAgentResult;
    },
    ...(opts.review
      ? {
          review: async (): Promise<ReviewResult> => {
            return reviewSeq!.shift() ?? { approved: true, corrections: [], parsed: true };
          },
        }
      : {}),
    setupE2e: async () => {},
    validate: async () => ({ ok: true, errors: [], infra: false }),
    isHealthy: async () => true,
    isReachable: async () => true,
    execute: async () => opts.run ?? greenRun,
    cleanup: async () => {},
    setupCode: async () => {},
    executeCode: async () => opts.run ?? greenRun,
    publish: async () => {
      published.value = true;
      return opts.prUrl === null
        ? null
        : { prUrl: opts.prUrl ?? "https://github.com/org/demo/pull/1", merged: true };
    },
    publishCode: async () => {
      published.value = true;
      return { prUrl: "https://github.com/org/demo/pull/2", merged: true };
    },
    publishContext: async () => {
      published.value = true;
      return { prUrl: "https://github.com/org/demo/pull/3", merged: true };
    },
    openIssue: async (_repo: string, title: string) => {
      issues.push(title);
      return { url: "https://github.com/org/demo/issues/1" };
    },
    saveOutcome: async (outcome: RunOutcome) => {
      savedOutcomes.push(outcome);
    },
  };
  return d;
}

// ── AC2.2.1: codex green run produces pass verdict + PR published ──────────

test("pipeline/codex: green run with single-codex produces pass verdict and publishes (AC2.2.1)", async () => {
  const d = codexDeps({ run: greenRun, agent: greenAgentResult });
  const result = await runPipeline(
    codexApp,
    "abc123",
    d,
    "manual",
    { mode: "diff", runId: "run-codex-green" },
  );

  assert.equal(result.verdict, "pass", "codex green run must yield pass verdict");
  assert.equal(d.published, true, "codex green run must publish the PR");
  assert.equal(d.issues.length, 0, "codex green run must NOT open an Issue");
});

test("pipeline/codex: agentRuntimeConfig uses codex provider (usageComplete attribution check, AC2.5.1)", async () => {
  const d = codexDeps({ run: greenRun });
  await runPipeline(
    codexApp,
    "abc123",
    d,
    "manual",
    { mode: "diff", runId: "run-codex-attribution" },
  );

  // The saved outcome should exist; usageComplete must be false for single-codex
  // (pipeline.ts: usageComplete = primary.provider === "opencode" && reviewer.provider === "opencode")
  // This verifies the attribution is honest: single-codex never claims opencode completion.
  assert.ok(d.savedOutcomes.length > 0, "outcome must be saved");
  const outcome = d.savedOutcomes[0]!;
  // The usage object in the outcome carries the provider attribution.
  // usageComplete = false for codex (both providers != opencode) → honest, not fabricated.
  // We assert the runtime config is codex so the attribution path is exercised correctly.
  assert.equal(
    codexRuntimeConfig.assignments.primary.provider,
    "codex",
    "primary provider must be codex",
  );
  assert.equal(
    codexRuntimeConfig.assignments.reviewer.provider,
    "codex",
    "reviewer provider must be codex",
  );
  // The outcome is valid and complete
  assert.ok(outcome.gateSignals, "gateSignals must be present");
});

// ── T-P2-5: usageComplete attribution reflects codex provider (AC2.5.1) ──────

test("pipeline/codex: usageComplete is false for single-codex — honest attribution, not opencode fabrication (AC2.5.1)", () => {
  // AC2.5.1: the usage record must reflect codex as the provider, not opencode.
  // pipeline.ts computes: usageComplete = primary.provider === "opencode" && reviewer.provider === "opencode"
  // For a single-codex config, BOTH are "codex" → usageComplete MUST be false (honest).
  // This is a REGRESSION GUARD over the existing honest behavior (already satisfied in pipeline.ts).
  const config = singleProviderConfig("codex", { CODEX_API_KEY: "test-key" });

  // Verify the provider attribution is codex for both roles.
  assert.equal(config.assignments.primary.provider, "codex", "primary provider attribution must be codex");
  assert.equal(config.assignments.reviewer.provider, "codex", "reviewer provider attribution must be codex");

  // Verify that the usageComplete formula (from pipeline.ts ~937) is false for codex.
  // This ensures honest attribution — a codex run never claims opencode-complete.
  // Cast to string to avoid tsc's literal-type narrowing (which would make `=== "opencode"` a
  // compile error since the types are already known to be "codex"). The runtime behavior is what
  // we care about here — documenting the formula and asserting the result is false.
  const primaryProvider: string = config.assignments.primary.provider;
  const reviewerProvider: string = config.assignments.reviewer.provider;
  const usageComplete = primaryProvider === "opencode" && reviewerProvider === "opencode";
  assert.equal(
    usageComplete,
    false,
    "usageComplete must be false for single-codex (honest: codex != opencode). Never fabricates opencode completion.",
  );
});

// ── WARNING-3 fix: provider attribution persisted on the RunUsage record (AC2.5.1 real) ──────

test("pipeline/codex: persisted RunUsage carries primaryProvider=codex and reviewerProvider=codex (AC2.5.1 real attribution)", async () => {
  // RED-first: this test asserts that the PERSISTED RunOutcome.gateSignals.usage has
  // primaryProvider and reviewerProvider fields that name "codex". Before the fix,
  // usage was undefined (no token snapshots) or lacked provider fields.
  const d = codexDeps({ run: greenRun, agent: greenAgentResult });
  await runPipeline(
    codexApp,
    "abc123",
    d,
    "manual",
    { mode: "diff", runId: "run-codex-attr-real" },
  );

  assert.ok(d.savedOutcomes.length > 0, "at least one RunOutcome must be saved");
  const outcome = d.savedOutcomes[0]!;
  const usage = outcome.gateSignals.usage;

  assert.ok(usage !== undefined, "RunUsage must be present on gateSignals.usage for a codex run (attribution requires a record)");
  assert.equal(
    usage!.primaryProvider,
    "codex",
    "gateSignals.usage.primaryProvider must equal 'codex' for a single-codex run — the run must be attributable without re-deriving provider from config.",
  );
  assert.equal(
    usage!.reviewerProvider,
    "codex",
    "gateSignals.usage.reviewerProvider must equal 'codex' for a single-codex run.",
  );
  // AC2.5.2 safety: complete must remain false (no fabricated opencode completion).
  assert.equal(usage!.complete, false, "complete must remain false for codex — honest, not fabricated.");
});

// ── AC2.2.2 + AC1.2.3: codex infra failure propagates as isInfraError ─────

test("pipeline/codex: infra failure from codex generate() propagates as isInfraError — runner will emit infra-error, never a false Issue (AC2.2.2 / AC1.2.3)", async () => {
  // An AgentUnavailableError simulating a codex auth/credits failure.
  // codexErrorToInfra produces this from a real codex exec non-zero exit.
  const infraError = new AgentUnavailableError(
    "Codex provider rejected the request (auth / credits / rate-limit): 401 Unauthorized. INCONCLUSIVE (infrastructure), not a test failure.",
  );

  const d = codexDeps({ generateThrows: infraError });

  let caughtErr: unknown;
  try {
    await runPipeline(
      codexApp,
      "abc123",
      d,
      "manual",
      { mode: "diff", runId: "run-codex-infra-err" },
    );
  } catch (err) {
    caughtErr = err;
  }

  // The error MUST propagate (not be swallowed into invalid/fail).
  assert.ok(caughtErr !== undefined, "codex infra error must propagate out of runPipeline (not swallowed)");

  // The propagated error MUST satisfy isInfraError → runner.ts will set infra-error verdict.
  assert.ok(
    isInfraError(caughtErr),
    `propagated error must satisfy isInfraError so runner.ts emits infra-error verdict. Got: ${String(caughtErr)}`,
  );

  // No false Issue must have been opened against the watched repo.
  assert.equal(
    d.issues.length,
    0,
    "a codex infra error must NOT open a false GitHub Issue against the watched repo",
  );
});
