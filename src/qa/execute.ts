// Harness Filter C: runs the persisted E2E tests against DEV and classifies the
// outcome (pass/fail/flaky). The runner is injected: the default uses Playwright
// with the base config (retries → flakiness detection, trace on-first-retry); in
// tests it is stubbed. The output is SANITIZED before being returned (it may
// carry PII/DEV data that would later feed an Issue).

import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QaRunResult, QaCase, CaseStatus } from "../types";
import { scrubEnv } from "./code-runner";
import { parsePlaywrightReport } from "./playwright-report";
import { sanitizeText, containsSecrets, recordAudit } from "../orchestrator/sanitizer";

// Default wall-clock budget for one Playwright suite run. A hung browser must never
// freeze the sequential queue (one run blocks ALL apps); on expiry the whole process
// TREE is SIGKILLed and the run is classified infra-error, never a test failure.
// Override per-deploy via the QA_E2E_TIMEOUT_MS env var. The seed playwright config
// sets globalTimeout to 12 min so Playwright normally exits cleanly on its own first.
export const DEFAULT_E2E_TIMEOUT_MS = 900_000; // 15 min

// Budget for the best-effort orphan-data cleanup pass (a single spec — far shorter).
export const DEFAULT_CLEANUP_TIMEOUT_MS = 300_000; // 5 min

// Resolves the effective e2e timeout: QA_E2E_TIMEOUT_MS when set to a positive
// number of milliseconds, the default otherwise.
export function e2eTimeoutMs(): number {
  const raw = Number(process.env.QA_E2E_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_E2E_TIMEOUT_MS;
}

// Playwright project names the orchestrator may pass with --project. Strict
// allowlist keeps the spawn arg-injection surface closed (the value reaches a
// child-process argv).
export const PW_PROJECT_RE = /^[A-Za-z0-9_-]+$/;

// Kills a spawned process AND its descendants. Spawns are `detached: true` so the
// child is its own process-group leader; `process.kill(-pid)` signals the whole group
// (npx/playwright fork browser grandchildren that a plain `child.kill()` would orphan).
// Falls back to a direct kill if the group send fails (e.g. the child already exited).
// Same pattern as the code-mode runner (src/qa/code-runner.ts) — the in-repo standard.
export function killTree(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

export interface ExecuteOptions {
  baseUrl: string;
  namespace: string;
  onCase?: (c: QaCase) => void;        // called per test as it completes (live bar/history)
  onRunning?: (title: string) => void; // called when a test starts (focus card)
  onDiscovered?: (title: string, file?: string) => void; // the full test list, up front (the "next" preview)
  faultInject?: boolean;               // response-oracle pass: corrupt JSON response values (QA_FAULT_INJECT)
  signal?: AbortSignal;                // operator cancel: kills the runner's process tree → infra-error
  timeoutMs?: number;                  // wall-clock budget; defaults to e2eTimeoutMs()
  project?: string;                    // restrict to one Playwright --project (must match PW_PROJECT_RE)
}

// One streamed test-lifecycle event, parsed from the custom NDJSON reporter's stdout.
export type StreamEvent =
  | { phase: "begin"; total: number }
  | { phase: "discovered"; title: string; file?: string }
  | { phase: "testbegin"; title: string; file?: string }
  | { phase: "testend"; title: string; status: string; durationMs?: number };

// Pure parser of one NDJSON line emitted by the stream reporter. Returns null for
// blank/non-JSON/unknown lines (the reporter shares stdout with nothing, but stay
// defensive). Isolated so it is unit-testable without spawning Playwright.
export function parseStreamEvent(line: string): StreamEvent | null {
  const s = line.trim();
  if (!s || s[0] !== "{") return null;
  let obj: { e?: string; total?: number; title?: string; file?: string; status?: string; d?: number };
  try { obj = JSON.parse(s); } catch { return null; }
  if (obj.e === "begin" && typeof obj.total === "number") return { phase: "begin", total: obj.total };
  if (obj.e === "discovered" && typeof obj.title === "string") return { phase: "discovered", title: obj.title, ...(obj.file ? { file: String(obj.file) } : {}) };
  if (obj.e === "testbegin" && typeof obj.title === "string") return { phase: "testbegin", title: obj.title, ...(obj.file ? { file: String(obj.file) } : {}) };
  if (obj.e === "testend" && typeof obj.title === "string") return { phase: "testend", title: obj.title, status: String(obj.status ?? ""), ...(typeof obj.d === "number" ? { durationMs: obj.d } : {}) };
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
  runSuite(args: {
    dir: string;
    baseUrl: string;
    namespace: string;
    faultInject?: boolean;
    project?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    onEvent?: (ev: StreamEvent) => void;
  }): Promise<RunOutput>;
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
  // The project name reaches a child-process argv (`--project=<value>`): reject
  // anything outside the strict allowlist before it gets near a spawn.
  if (opts.project !== undefined && !PW_PROJECT_RE.test(opts.project)) {
    throw new Error(`invalid Playwright project name ${JSON.stringify(opts.project)}: must match ${String(PW_PROJECT_RE)}`);
  }

  // Already-aborted signal: don't even start the runner.
  if (opts.signal?.aborted) {
    return {
      sha: opts.namespace,
      verdict: "infra-error",
      passed: false,
      cases: [],
      logs: "e2e run aborted by operator cancel before the runner started",
    };
  }

  // Bridge streamed events to the live callbacks: a test starting → focus card,
  // a test finishing → one incremental case (fills the pass/fail bar + history).
  const onEvent = (opts.onCase || opts.onRunning || opts.onDiscovered)
    ? (ev: StreamEvent): void => {
        if (ev.phase === "discovered") opts.onDiscovered?.(ev.title, ev.file);
        else if (ev.phase === "testbegin") opts.onRunning?.(ev.title);
        else if (ev.phase === "testend") {
          const st = streamStatusToCase(ev.status);
          if (st) opts.onCase?.({ name: ev.title, status: st, ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}) });
        }
      }
    : undefined;

  const runPromise = deps.runSuite({
    dir: specDir,
    baseUrl: opts.baseUrl,
    namespace: opts.namespace,
    faultInject: opts.faultInject,
    project: opts.project,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    onEvent,
  });

  // Race the suite against timeout and operator cancel at the orchestration level
  // (defense in depth: defaultExecuteDeps also SIGKILLs the process tree on both —
  // this catch-all covers stubbed runners and edge cases). A `ran: false` output
  // routes through the crashed-runner branch below → infra-error, NEVER a test
  // failure and never a silent pass.
  const timeoutMs = opts.timeoutMs ?? e2eTimeoutMs();
  const timedOut: RunOutput = { report: {}, logs: `playwright runner timed out after ${timeoutMs}ms — killed`, ran: false };
  const abortedOut: RunOutput = { report: {}, logs: "playwright runner aborted by operator cancel — killed", ran: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const racers: Array<Promise<RunOutput>> = [
    runPromise,
    new Promise<RunOutput>((resolve) => { timer = setTimeout(() => resolve(timedOut), timeoutMs); }),
  ];
  if (opts.signal) {
    racers.push(new Promise<RunOutput>((resolve) => {
      onAbort = () => resolve(abortedOut);
      opts.signal!.addEventListener("abort", onAbort, { once: true });
    }));
  }

  let out: RunOutput;
  try {
    out = await Promise.race(racers);
  } finally {
    clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
  }
  const { report, logs, ran } = out;

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
  runCleanup(args: { dir: string; baseUrl: string; namespace: string; signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
}

export const defaultCleanupDeps: CleanupDeps = {
  runCleanup: ({ dir, baseUrl, namespace, signal, timeoutMs }) =>
    new Promise((resolve) => {
      const child = spawn("npx", ["playwright", "test", "cleanup.spec.ts", "--reporter=line"], {
        cwd: dir,
        // Agent-written specs run here: scrub the orchestrator's secrets (GITHUB_TOKEN etc.)
        // while keeping the app's DEV_* login creds the fixtures need.
        env: { ...scrubEnv(/^DEV_/), PW_BASE_URL: baseUrl, PW_NAMESPACE: namespace, PW_CLEANUP: "1" },
        detached: true, // own process group → killTree can reap browser grandchildren
      });
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
        resolve(); // best-effort: cleanup never throws and never blocks the next run
      };
      // Even best-effort cleanup must not wedge the sequential queue: kill the tree
      // on timeout/cancel and move on (orphan data is reaped by a later run).
      const ms = timeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
      const timer = setTimeout(() => {
        console.warn(`[qa] orphan-data cleanup timed out after ${ms}ms — killed (best-effort, continuing)`);
        killTree(child);
        settle();
      }, ms);
      const onAbort = signal
        ? () => { killTree(child); settle(); }
        : undefined;
      if (onAbort) signal!.addEventListener("abort", onAbort, { once: true });
      child.on("error", () => settle());
      child.on("close", () => settle());
    }),
};

// A tiny Playwright reporter (CJS, no imports) that emits one NDJSON line per test
// lifecycle event to stdout. Written to a temp dir at run time and passed by
// absolute path — it never lives in (or is committed to) the watched repo. The
// authoritative JSON report goes to a FILE in parallel, so classification is
// unchanged and a missing report still forces infra-error.
const STREAM_REPORTER = `
class QaStreamReporter {
  onBegin(_config, suite) {
    var tests = suite.allTests();
    this._w({ e: "begin", total: tests.length });
    for (var i = 0; i < tests.length; i++) this._w({ e: "discovered", title: this._name(tests[i]), file: tests[i].location && tests[i].location.file });
  }
  onTestBegin(test) { this._w({ e: "testbegin", title: this._name(test), file: test.location && test.location.file }); }
  onTestEnd(test, result) { this._w({ e: "testend", title: this._name(test), status: result.status, d: result.duration }); }
  _name(test) { return test.titlePath().filter(Boolean).slice(1).join(" \\u203a "); }
  _w(o) { try { process.stdout.write(JSON.stringify(o) + "\\n"); } catch (_e) {} }
}
module.exports = QaStreamReporter;
`;

// Builds the args for the suite spawn (after the `npx` binary). Pure and exported so
// the --project append + allowlist stay unit-testable without spawning Playwright.
export function playwrightArgs(reporterPath: string, project?: string): string[] {
  const args = ["playwright", "test", `--reporter=${reporterPath},json`];
  if (project !== undefined) {
    if (!PW_PROJECT_RE.test(project)) {
      throw new Error(`invalid Playwright project name ${JSON.stringify(project)}: must match ${String(PW_PROJECT_RE)}`);
    }
    args.push(`--project=${project}`);
  }
  return args;
}

export const defaultExecuteDeps: ExecuteDeps = {
  runSuite: ({ dir, baseUrl, namespace, faultInject, project, signal, timeoutMs, onEvent }) =>
    new Promise((resolve, reject) => {
      const work = mkdtempSync(join(tmpdir(), "qa-pw-"));
      const reporterPath = join(work, "qa-stream-reporter.cjs");
      const jsonPath = join(work, "report.json");
      writeFileSync(reporterPath, STREAM_REPORTER);

      // JSON → file (authoritative, via PLAYWRIGHT_JSON_OUTPUT_NAME); NDJSON → stdout
      // (live feed). The two reporters never collide on stdout.
      const child = spawn("npx", playwrightArgs(reporterPath, project), {
        cwd: dir,
        // Agent-written specs are untrusted code: scrub orchestrator secrets, keep DEV_* creds.
        env: { ...scrubEnv(/^DEV_/), PW_BASE_URL: baseUrl, PW_NAMESPACE: namespace, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonPath, ...(faultInject ? { QA_FAULT_INJECT: "1" } : {}) },
        detached: true, // own process group → killTree reaps npx/playwright/browser grandchildren
      });

      let stderr = "";
      let buf = "";
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
        fn();
      };

      // Timeout guard: a hung browser must not block the sequential queue forever.
      // Kill the whole PROCESS TREE and resolve `ran: false` → classified infra-error
      // by runE2E (a wedged runner, never a test failure and never a pass).
      const ms = timeoutMs ?? e2eTimeoutMs();
      const timer = setTimeout(() => {
        killTree(child);
        settle(() => resolve({ report: {}, logs: `playwright runner timed out after ${ms}ms — killed\n${stderr}`, ran: false }));
      }, ms);

      // Operator cancel: the pipeline's AbortSignal fires → kill the suite immediately.
      const onAbort = signal
        ? () => {
            killTree(child);
            settle(() => resolve({ report: {}, logs: `playwright runner aborted by operator cancel — killed\n${stderr}`, ran: false }));
          }
        : undefined;
      if (onAbort) signal!.addEventListener("abort", onAbort, { once: true });

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
      child.on("error", (err) => { try { rmSync(work, { recursive: true, force: true }); } catch { /* best-effort */ } settle(() => reject(err)); });
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
        settle(() => resolve({ report, logs: stderr, ran, exitCode: code ?? undefined }));
      });
    }),
};
