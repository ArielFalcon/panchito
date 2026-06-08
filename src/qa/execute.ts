// Harness Filter C: runs the persisted E2E tests against DEV and classifies the
// outcome (pass/fail/flaky). The runner is injected: the default uses Playwright
// with the base config (retries → flakiness detection, trace on-first-retry); in
// tests it is stubbed. The output is SANITIZED before being returned (it may
// carry PII/DEV data that would later feed an Issue).

import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QaRunResult, QaCase, CaseStatus } from "../types";
import { scrubEnv } from "./code-runner";
import { parsePlaywrightReport } from "./playwright-report";
import { sanitizeText, containsSecrets, recordAudit } from "../orchestrator/sanitizer";

export interface ExecuteOptions {
  baseUrl: string;
  namespace: string;
  onCase?: (c: QaCase) => void;        // called per test as it completes (live bar/history)
  onRunning?: (title: string) => void; // called when a test starts (focus card)
}

// One streamed test-lifecycle event, parsed from the custom NDJSON reporter's stdout.
export type StreamEvent =
  | { phase: "begin"; total: number }
  | { phase: "testbegin"; title: string; file?: string }
  | { phase: "testend"; title: string; status: string };

// Pure parser of one NDJSON line emitted by the stream reporter. Returns null for
// blank/non-JSON/unknown lines (the reporter shares stdout with nothing, but stay
// defensive). Isolated so it is unit-testable without spawning Playwright.
export function parseStreamEvent(line: string): StreamEvent | null {
  const s = line.trim();
  if (!s || s[0] !== "{") return null;
  let obj: { e?: string; total?: number; title?: string; file?: string; status?: string };
  try { obj = JSON.parse(s); } catch { return null; }
  if (obj.e === "begin" && typeof obj.total === "number") return { phase: "begin", total: obj.total };
  if (obj.e === "testbegin" && typeof obj.title === "string") return { phase: "testbegin", title: obj.title, ...(obj.file ? { file: String(obj.file) } : {}) };
  if (obj.e === "testend" && typeof obj.title === "string") return { phase: "testend", title: obj.title, status: String(obj.status ?? "") };
  return null;
}

// Maps a Playwright per-attempt status to our case status. `skipped` did not execute
// → not a case. Anything not clearly green is fail-closed (never a silent pass).
export function streamStatusToCase(status: string): CaseStatus | null {
  if (status === "passed" || status === "expected") return "pass";
  if (status === "skipped") return null;
  return "fail";
}

export interface RunOutput {
  report: unknown; // Playwright JSON report
  logs: string;
  ran: boolean; // false when the runner did NOT produce a parseable JSON report
                // (a crashed runner, not a test failure) — must never look green.
  exitCode?: number; // the runner process exit code (informational)
}

export interface ExecuteDeps {
  // onEvent streams test-lifecycle events as they happen (advisory: the verdict is
  // still decided from the final report). Absent in unit stubs.
  runSuite(args: { dir: string; baseUrl: string; namespace: string; onEvent?: (ev: StreamEvent) => void }): Promise<RunOutput>;
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
  // Bridge streamed events to the live callbacks: a test starting → focus card,
  // a test finishing → one incremental case (fills the pass/fail bar + history).
  const onEvent = (opts.onCase || opts.onRunning)
    ? (ev: StreamEvent): void => {
        if (ev.phase === "testbegin") opts.onRunning?.(ev.title);
        else if (ev.phase === "testend") {
          const st = streamStatusToCase(ev.status);
          if (st) opts.onCase?.({ name: ev.title, status: st });
        }
      }
    : undefined;

  const { report, logs, ran } = await deps.runSuite({
    dir: specDir,
    baseUrl: opts.baseUrl,
    namespace: opts.namespace,
    onEvent,
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

// A tiny Playwright reporter (CJS, no imports) that emits one NDJSON line per test
// lifecycle event to stdout. Written to a temp dir at run time and passed by
// absolute path — it never lives in (or is committed to) the watched repo. The
// authoritative JSON report goes to a FILE in parallel, so classification is
// unchanged and a missing report still forces infra-error.
const STREAM_REPORTER = `
class QaStreamReporter {
  onBegin(_config, suite) { this._w({ e: "begin", total: suite.allTests().length }); }
  onTestBegin(test) { this._w({ e: "testbegin", title: this._name(test), file: test.location && test.location.file }); }
  onTestEnd(test, result) { this._w({ e: "testend", title: this._name(test), status: result.status }); }
  _name(test) { return test.titlePath().filter(Boolean).slice(1).join(" \\u203a "); }
  _w(o) { try { process.stdout.write(JSON.stringify(o) + "\\n"); } catch (_e) {} }
}
module.exports = QaStreamReporter;
`;

export const defaultExecuteDeps: ExecuteDeps = {
  runSuite: ({ dir, baseUrl, namespace, onEvent }) =>
    new Promise((resolve, reject) => {
      const work = mkdtempSync(join(tmpdir(), "qa-pw-"));
      const reporterPath = join(work, "qa-stream-reporter.cjs");
      const jsonPath = join(work, "report.json");
      writeFileSync(reporterPath, STREAM_REPORTER);

      // JSON → file (authoritative, via PLAYWRIGHT_JSON_OUTPUT_NAME); NDJSON → stdout
      // (live feed). The two reporters never collide on stdout.
      const child = spawn("npx", ["playwright", "test", `--reporter=${reporterPath},json`], {
        cwd: dir,
        // Agent-written specs are untrusted code: scrub orchestrator secrets, keep DEV_* creds.
        env: { ...scrubEnv(/^DEV_/), PW_BASE_URL: baseUrl, PW_NAMESPACE: namespace, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonPath },
      });

      let stderr = "";
      let buf = "";
      child.stdout.on("data", (d) => {
        buf += String(d);
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const ev = parseStreamEvent(line);
          if (ev && onEvent) { try { onEvent(ev); } catch { /* advisory: never let the feed break the run */ } }
        }
      });
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) => { try { rmSync(work, { recursive: true, force: true }); } catch { /* best-effort */ } reject(err); });
      child.on("close", (code) => {
        let report: unknown = {};
        let ran = false;
        try {
          report = JSON.parse(readFileSync(jsonPath, "utf8"));
          ran = true; // we got a JSON report file (whatever its verdict)
        } catch {
          // No parseable JSON report file → the runner crashed before reporting,
          // rather than reporting a test failure. `ran:false` forces infra-error.
          ran = false;
        }
        try { rmSync(work, { recursive: true, force: true }); } catch { /* best-effort */ }
        resolve({ report, logs: stderr, ran, exitCode: code ?? undefined });
      });
    }),
};
