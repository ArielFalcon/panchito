// Harness Filter C: runs the persisted E2E tests against DEV and classifies the
// outcome (pass/fail/flaky). The runner is injected: the default uses Playwright
// with the base config (retries → flakiness detection, trace on-first-retry); in
// tests it is stubbed. The output is SANITIZED before being returned (it may
// carry PII/DEV data that would later feed an Issue).

import { spawn } from "node:child_process";
import { QaRunResult } from "../types";
import { scrubEnv } from "./code-runner";
import { parsePlaywrightReport } from "./playwright-report";
import { sanitizeText, containsSecrets, recordAudit } from "../orchestrator/sanitizer";

export interface ExecuteOptions {
  baseUrl: string;
  namespace: string;
}

export interface RunOutput {
  report: unknown; // Playwright JSON report
  logs: string;
  ran: boolean; // false when the runner did NOT produce a parseable JSON report
                // (a crashed runner, not a test failure) — must never look green.
  exitCode?: number; // the runner process exit code (informational)
}

export interface ExecuteDeps {
  runSuite(args: { dir: string; baseUrl: string; namespace: string }): Promise<RunOutput>;
}

// A Playwright JSON report always carries `suites` and/or `stats`. An empty `{}`
// means the runner emitted no report (e.g. it crashed before reporting): that is
// infrastructure, not a passing run.
function isReportShaped(report: unknown): boolean {
  if (typeof report !== "object" || report === null) return false;
  const r = report as Record<string, unknown>;
  return "suites" in r || "stats" in r;
}

// Cleanup of the namespaced data does NOT live here: each test does it in its
// teardown via the `cleanup` fixture (config/e2e/fixtures.ts), where it knows how
// to undo each entity. Here we only run and classify.
export async function runE2E(
  specDir: string,
  opts: ExecuteOptions,
  deps: ExecuteDeps,
): Promise<QaRunResult> {
  const { report, logs, ran } = await deps.runSuite({
    dir: specDir,
    baseUrl: opts.baseUrl,
    namespace: opts.namespace,
  });

  if (containsSecrets(logs)) {
    console.warn("[sanitizer] Secrets detected in E2E execution logs — redacting before publish");
  }
  const sanitized = sanitizeText(logs);
  recordAudit(opts.namespace, sanitized.detection);

  // A runner that produced no parseable report did not actually run the suite —
  // it crashed (bad config, browser launch failure, OOM). That is INFRASTRUCTURE,
  // not a pass: never let a swallowed parse error surface as green (the #1 invariant).
  if (!ran || !isReportShaped(report)) {
    return {
      sha: opts.namespace,
      verdict: "infra-error",
      passed: false,
      cases: [],
      logs: sanitized.text || "the E2E runner produced no report (it crashed before reporting results)",
    };
  }

  const parsed = parsePlaywrightReport(report);

  // The inverse of the crashed-runner guard above: a report that PARSED but
  // executed zero tests (testMatch matched nothing, or every spec was skipped)
  // ran nothing and must never surface as green. Inconclusive infrastructure.
  if (parsed.executed === 0) {
    return {
      sha: opts.namespace,
      verdict: "infra-error",
      passed: false,
      cases: parsed.cases,
      logs: sanitized.text || "the E2E suite ran but executed zero tests (no tests matched, or all were skipped)",
    };
  }

  return {
    sha: opts.namespace,
    verdict: parsed.verdict,
    passed: parsed.passed,
    cases: parsed.cases,
    logs: sanitized.text,
  };
}

// Default runner: runs Playwright in the repo's `e2e/` project (with its own
// config/fixtures) and the JSON reporter. Playwright is not a dependency of this
// template (it would pull in browsers): it lives in the environment where the
// service runs (the orchestrator image is based on the Playwright image).
// PW_BASE_URL points to DEV; PW_NAMESPACE is the run's data prefix (read by the fixtures).
// Orphan-data cleanup: runs ONLY cleanup.spec.ts with PW_CLEANUP=1 and the interrupted
// run's namespace, so a crashed run's namespaced test data is deleted before the next
// run. Best-effort: it never throws and never blocks the new run (failures are warnings).
export interface CleanupDeps {
  runCleanup(args: { dir: string; baseUrl: string; namespace: string }): Promise<void>;
}

export const defaultCleanupDeps: CleanupDeps = {
  runCleanup: ({ dir, baseUrl, namespace }) =>
    new Promise((resolve) => {
      const child = spawn("npx", ["playwright", "test", "cleanup.spec.ts", "--reporter=line"], {
        cwd: dir,
        // Agent-written specs run here: scrub the orchestrator's secrets (GITHUB_TOKEN etc.)
        // while keeping the app's DEV_* login creds the fixtures need.
        env: { ...scrubEnv(/^DEV_/), PW_BASE_URL: baseUrl, PW_NAMESPACE: namespace, PW_CLEANUP: "1" },
      });
      child.on("error", () => resolve()); // best-effort
      child.on("close", () => resolve());
    }),
};

export const defaultExecuteDeps: ExecuteDeps = {
  runSuite: ({ dir, baseUrl, namespace }) =>
    new Promise((resolve, reject) => {
      const child = spawn("npx", ["playwright", "test", "--reporter=json"], {
        cwd: dir,
        // Agent-written specs are untrusted code: scrub orchestrator secrets, keep DEV_* creds.
        env: { ...scrubEnv(/^DEV_/), PW_BASE_URL: baseUrl, PW_NAMESPACE: namespace },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => {
        let report: unknown = {};
        let ran = false;
        try {
          report = JSON.parse(stdout);
          ran = true; // we got a JSON report (whatever its verdict)
        } catch {
          // stdout was not parseable JSON → the runner crashed before reporting,
          // rather than reporting a test failure. `ran:false` forces infra-error.
          ran = false;
        }
        resolve({ report, logs: stderr || stdout, ran, exitCode: code ?? undefined });
      });
    }),
};
