// Harness Filter C: runs the persisted E2E tests against DEV and classifies the
// outcome (pass/fail/flaky). The runner is injected: the default uses Playwright
// with the base config (retries → flakiness detection, trace on-first-retry); in
// tests it is stubbed. The output is SANITIZED before being returned (it may
// carry PII/DEV data that would later feed an Issue).

import { spawn } from "node:child_process";
import { QaRunResult } from "../types";
import { parsePlaywrightReport } from "./playwright-report";
import { sanitizeText } from "../orchestrator/sanitizer";

export interface ExecuteOptions {
  baseUrl: string;
  namespace: string;
}

export interface RunOutput {
  report: unknown; // Playwright JSON report
  logs: string;
}

export interface ExecuteDeps {
  runSuite(args: { dir: string; baseUrl: string; namespace: string }): Promise<RunOutput>;
}

// Cleanup of the namespaced data does NOT live here: each test does it in its
// teardown via the `cleanup` fixture (config/e2e/fixtures.ts), where it knows how
// to undo each entity. Here we only run and classify.
export async function runE2E(
  specDir: string,
  opts: ExecuteOptions,
  deps: ExecuteDeps,
): Promise<QaRunResult> {
  const { report, logs } = await deps.runSuite({
    dir: specDir,
    baseUrl: opts.baseUrl,
    namespace: opts.namespace,
  });
  const parsed = parsePlaywrightReport(report);

  return {
    sha: opts.namespace,
    verdict: parsed.verdict,
    passed: parsed.passed,
    cases: parsed.cases,
    logs: sanitizeText(logs),
  };
}

// Default runner: runs Playwright in the repo's `e2e/` project (with its own
// config/fixtures) and the JSON reporter. Playwright is not a dependency of this
// template (it would pull in browsers): it lives in the environment where the
// service runs (the orchestrator image is based on the Playwright image).
// PW_BASE_URL points to DEV; PW_NAMESPACE is the run's data prefix (read by the fixtures).
export const defaultExecuteDeps: ExecuteDeps = {
  runSuite: ({ dir, baseUrl, namespace }) =>
    new Promise((resolve, reject) => {
      const child = spawn("npx", ["playwright", "test", "--reporter=json"], {
        cwd: dir,
        env: { ...process.env, PW_BASE_URL: baseUrl, PW_NAMESPACE: namespace },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", () => {
        let report: unknown = {};
        try {
          report = JSON.parse(stdout);
        } catch {
          /* stdout was not parseable JSON */
        }
        resolve({ report, logs: stderr || stdout });
      });
    }),
};
