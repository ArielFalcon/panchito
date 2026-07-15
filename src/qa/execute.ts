// Harness Filter C: runs the persisted E2E tests against DEV and classifies the
// outcome (pass/fail/flaky). The runner is injected: the default uses Playwright
// with the base config (retries → flakiness detection, trace on-first-retry); in
// tests it is stubbed. The output is SANITIZED before being returned (it may
// carry PII/DEV data that would later feed an Issue).

import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QaRunResult, QaCase, CaseStatus } from "../types";
// migration-tier-4b Slice 1: src/qa/code-runner.ts (scrubEnv's prior home) is deleted this slice;
// execute.ts is a Slice-1 "survivor" (its own migration is seam-pinned to 4d) and re-points to the
// qa-engine twin — the NARROW legacy allowlist, unchanged, per the design's consumer sweep.
import { scrubEnv } from "../../qa-engine/src/shared-infrastructure/process-sandbox/scrub-env";
// migration-tier-4d Slice 1a (prep step ahead of this file's own Slice 1b body-move): playwright-report.ts
// relocated to qa-engine's test-execution context; this transitional shell→engine import mirrors the
// scrubEnv one immediately above (this file itself is the LAST src/qa/execute.ts survivor, seam-pinned
// to Slice 1b, which deletes it and this import along with it).
import { parsePlaywrightReport } from "../../qa-engine/src/contexts/test-execution/infrastructure/playwright-report";
import { sanitizeText, containsSecrets, recordAudit } from "../orchestrator/sanitizer";
import { parseAriaSnapshot } from "./dom-snapshot";

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

// Spec file basenames the orchestrator may pass as positional args for a filtered retry
// (e.g. "login.spec.ts", "flows/checkout.spec.ts"). The allowlist keeps the spawn
// arg-injection surface closed: each value reaches a child-process argv directly.
// Rejects path traversal ("../"), leading dashes, and non-.spec.ts extensions.
export const SPEC_FILE_RE = /^[A-Za-z0-9._/-]+\.spec\.ts$/;

function assertSpecFiles(specFiles: string[]): void {
  for (const f of specFiles) {
    if (f.startsWith("-")) {
      throw new Error(`invalid spec file ${JSON.stringify(f)}: must not start with "-"`);
    }
    if (f.includes("../")) {
      throw new Error(`invalid spec file ${JSON.stringify(f)}: path traversal not allowed`);
    }
    if (!SPEC_FILE_RE.test(f)) {
      throw new Error(`invalid spec file ${JSON.stringify(f)}: must match ${String(SPEC_FILE_RE)}`);
    }
  }
}

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
  testIdAttribute?: string;            // the configured testIdAttribute; injected as PW_TEST_ID_ATTRIBUTE so playwright.config.ts resolves getByTestId correctly
  // Filtered-retry optimization: when present and non-empty, only these spec file basenames
  // are passed as positional args to Playwright (e.g. ["login.spec.ts"]).
  // Each value is validated against SPEC_FILE_RE before it reaches the child-process argv.
  specFiles?: string[];
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

// Playwright RUNNER-infrastructure failure signatures: the browser could not launch / is missing /
// the host lacks deps. These are a `fallo del runner` = INFRASTRUCTURE, NOT a test-logic failure
// (an assertion, or a timeout against DEV). Matched from Playwright's OWN error strings — the only
// channel it offers — and kept narrow so a genuine failure is never relabeled as infra.
//
// `Target (page|context|browser) ... closed` is DELIBERATELY excluded: the app under test crashing
// the tab (a real defect the test SHOULD surface) produces the same string, so reclassifying it
// fail→infra-error would HIDE a genuine bug. Only unambiguous launch/host signatures stay here.
export const PLAYWRIGHT_INFRA_RE =
  /browserType\.(?:launch|connect)|Executable doesn't exist|Failed to launch|missing dependencies to run browsers|Host system is missing dependencies/i;

// True when the run failed but EVERY failed case is a runner-infrastructure fault (e.g. the browser
// could not launch), so the run never actually exercised the app. The caller reclassifies it as
// `infra-error`, never `fail`: a runner fault must not open an Issue blaming the operator's tests
// (nor burn a regeneration round chasing a phantom bug). Conservative — a single genuine test-logic
// failure in the mix keeps the verdict `fail`.
export function allFailuresAreRunnerInfra(cases: QaCase[]): boolean {
  const failed = cases.filter((c) => c.status === "fail");
  return failed.length > 0 && failed.every((c) => PLAYWRIGHT_INFRA_RE.test(c.detail ?? ""));
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
    testIdAttribute?: string; // the configured testIdAttribute; injected as PW_TEST_ID_ATTRIBUTE so playwright.config.ts resolves getByTestId correctly
    faultInject?: boolean;
    project?: string;
    specFiles?: string[];
    signal?: AbortSignal;
    timeoutMs?: number;
    onEvent?: (ev: StreamEvent) => void;
    // Dir where the qa-failure-capture afterEach fixture writes per-case aria snapshots.
    // Minted by defaultExecuteDeps.runSuite as a temp dir; passed via QA_FAILURE_CAPTURE_DIR
    // in the child env so the fixture can write to it. The orchestrator reads and parses the
    // dumps after the run to populate QaCase.failureDom for each failed case.
    failureCaptureDir?: string;
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

  // Mint a temp dir for the qa-failure-capture afterEach to write aria snapshots into.
  // The dir is created here (the orchestration layer) so the harvest logic (below) can
  // read it after the run without coupling it to the defaultExecuteDeps boundary.
  // Best-effort: if mkdtempSync fails (e.g. no /tmp space), we skip capture gracefully.
  let failureCaptureDir: string | undefined;
  try { failureCaptureDir = mkdtempSync(join(tmpdir(), "qa-fail-")); } catch { /* no-op */ }

  // W6: the cleanup try is opened HERE — immediately after the dir is minted and BEFORE the
  // runSuite await — so the finally's rmSync also runs when deps.runSuite REJECTS (a spawn error),
  // not only on the return paths below. Previously the await sat outside this try and a reject
  // escaped before cleanup, leaking the temp dir.
  try {
  const runPromise = deps.runSuite({
    dir: specDir,
    baseUrl: opts.baseUrl,
    namespace: opts.namespace,
    faultInject: opts.faultInject,
    project: opts.project,
    testIdAttribute: opts.testIdAttribute,
    specFiles: opts.specFiles,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    onEvent,
    failureCaptureDir,
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

  // The temp capture dir is removed on EVERY exit path — the early infra-error returns below, the
  // main return, a throw from the harvest, AND a runSuite REJECT (W6) — via the finally at the end.
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

  // A report that PARSED with failures, but where EVERY failure is a runner-infrastructure fault
  // (the browser could not launch), did not actually test the app — same root principle as the
  // no-report guard above. Classify it infra-error, NEVER `fail`: a runner fault must not open an
  // Issue blaming the operator's tests, and must not trigger a (wasted) regeneration round.
  if (parsed.verdict === "fail" && allFailuresAreRunnerInfra(parsed.cases)) {
    return {
      sha: opts.namespace,
      verdict: "infra-error",
      passed: false,
      cases: parsed.cases,
      logs: sanitized.text,
      note: "Playwright could not launch the browser — runner infrastructure fault, not a test failure. Check the browser install / PLAYWRIGHT_BROWSERS_PATH.",
    };
  }

  // Post-run harvest: for each failed case, read the aria snapshot dump written by the
  // qa-failure-capture afterEach fixture and populate QaCase.failureDom. This gives the
  // fix-loop regeneration prompt the REAL post-failure DOM (the only reliable ground truth).
  //
  // failureDom is stored as the RAW parseAriaSnapshot lines ("role: name", no "- " markers)
  // joined by "\n" — the FULL line set, so Lever-2's selector check (pipeline.ts) sees the
  // COMPLETE tree (a table is never truncated away here; any size cap is applied later, only
  // on the prompt text). The pipeline splits this back into lines without re-parsing.
  //
  // Priority: fixture dump > errorContext from the JSON report (errorContext covers expect()
  // failures for free in PW 1.60; the fixture dump covers click/nav timeouts where no
  // errorContext is emitted). LOUD WARNING when a failed case yields neither — this is a
  // grounding gap (invariant: never swallow, per CLAUDE.md INV-4).
  // Post-run harvest over PwCase[] (before widening to QaCase[]): PwCase carries errorContext
  // from the 1.60 JSON report, which is needed as a fallback when no fixture dump exists.
  // We mutate the same objects (same references) — the cast to QaCase[] below picks up the
  // failureDom we set here because the runtime objects are identical.
  const failedPwCases = parsed.cases.filter((c) => c.status === "fail");
  if (failedPwCases.length > 0) {
    // W2: the per-case harvest runs whenever there are failed cases — NOT gated on failureCaptureDir.
    // Only the fixture-dump read needs the dir; when it is absent (e.g. mkdtempSync failed for lack of
    // /tmp space) `dumps` is simply [] and we fall through to the errorContext fallback (which needs no
    // temp dir) and, failing that, the loud "no grounding captured" WARNING. Gating the whole loop on
    // the dir silently dropped BOTH the fallback and the WARNING — violating the never-swallow invariant.
    // Read every dump ONCE into {file, title, retry, yaml}: matching keys off the dump's own `file` +
    // `title` (the describe›test chain the fixture wrote), which the report's case name ENDS WITH —
    // the report prepends the spec file as the top suite, the fixture records it as a separate `file`.
    const dumps = failureCaptureDir ? readFailureDumps(failureCaptureDir) : [];
    for (const c of failedPwCases) {
      // PwCase is structurally assignable to QaCase (all new QaCase fields are optional), so we can
      // safely treat it as QaCase here to write failureDom. TypeScript needs the cast because PwCase
      // is the narrower type and failureDom was added only to QaCase.
      const qa = c as unknown as QaCase;
      const dump = matchFailureDumps(c.name, dumps);
      if (dump?.yaml) {
        // Store the full parsed line set (NOT formatDomSnapshot output) so Lever-2 sees the
        // complete tree; the readable header + size cap are applied later on the prompt text.
        const nodes = parseAriaSnapshot(dump.yaml);
        if (nodes.length > 0) qa.failureDom = nodes.join("\n");
      }
      // D1/D2 runtime evidence: fold finalUrl and httpStatus onto the same QaCase object,
      // best-effort — absent on older dumps or when capture missed (no new warning beyond failureDom's).
      if (dump?.httpStatus !== undefined) qa.httpStatus = dump.httpStatus;
      if (dump?.finalUrl !== undefined) qa.finalUrl = dump.finalUrl;
      // Feature B runtime evidence: fold the captured console/pageerror entries onto the same QaCase
      // object — same best-effort, absent-warned contract (no new warning beyond failureDom's).
      if (dump?.runtimeErrors !== undefined) qa.runtimeErrors = dump.runtimeErrors;
      // Fallback: try errorContext from the JSON report (PW 1.60 expect() failures).
      // errorContext is the SAME raw ariaSnapshot YAML the fixture writes (Playwright's
      // `- role "name"` form), so it MUST be flattened through parseAriaSnapshot to the
      // "role: name" shape every consumer expects (buildFailureDomLines, selectorPresent,
      // capDomLines.isPriorityNode) — storing it RAW leaves Lever-2, the absent/unique
      // checks, and the real-bug branch inert for expect() failures (the common case).
      // c.errorContext is on PwCase; qa.failureDom is on QaCase — same runtime object, different views.
      if (!qa.failureDom && c.errorContext) {
        const nodes = parseAriaSnapshot(c.errorContext);
        if (nodes.length > 0) qa.failureDom = nodes.join("\n");
      }
      // Neither dump nor errorContext (or both unparseable): loud WARNING (grounding gap —
      // INV-4: never swallow, and never store a half-shape raw YAML the consumers can't read).
      if (!qa.failureDom) {
        console.warn(`[qa] WARNING: no failure-point DOM captured for failed case ${JSON.stringify(c.name)} (dump absent + no errorContext) — fix-loop will run without grounding.`);
      }
    }
  }

  // Cast to QaCase[] — the harvest above already wrote failureDom onto the runtime objects;
  // this cast makes the return type correct for QaRunResult.cases.
  const qaCases = parsed.cases as QaCase[];

  return {
    sha: opts.namespace,
    verdict: parsed.verdict,
    passed: parsed.passed,
    cases: qaCases,
    logs: sanitized.text,
  };
  } finally {
    // Remove the temp capture dir on ALL exit paths (early infra-error returns + the main
    // return + any throw). Best-effort: a failed unlink never breaks the run.
    if (failureCaptureDir) {
      try { rmSync(failureCaptureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

// Splits a Playwright case/dump title into its hierarchy segments on the " › " separator the
// stream reporter and the fixture both emit. Trims each and drops empties. Pure.
const TITLE_SEP = " › ";
export function titleSegments(title: string): string[] {
  return title.split(TITLE_SEP).map((s) => s.trim()).filter(Boolean);
}

// True when `tail` is a contiguous TAIL of `full` with EXACT per-segment equality. The report's
// case name is `file.spec.ts › describe › test`; the fixture's title is `describe › test` (no file
// prefix), so the dump's segments must equal the LAST k segments of the case's segments — never a
// loose character-suffix (which once cross-matched "add owner" to a dump titled "owner").
export function segmentsAreTail(full: string[], tail: string[]): boolean {
  if (tail.length === 0 || tail.length > full.length) return false;
  const offset = full.length - tail.length;
  for (let i = 0; i < tail.length; i++) {
    if (full[offset + i] !== tail[i]) return false;
  }
  return true;
}

// One parsed qa-failure-capture dump: the Playwright project name, the spec FILE (basename), the
// describe›test chain the fixture recorded (`title`), the retry index, and the aria-snapshot YAML at
// the failure point. `file` disambiguates two tests that share the SAME describe›test chain across
// DIFFERENT spec files (their `title` collides — only the file tells them apart). Optional for
// backward compatibility with dumps written before the file was recorded (then matching is title-only).
// httpStatus and finalUrl are runtime evidence fields added by the D1/D2 capture layer: both are
// optional for backward compatibility with dumps written before this change.
export interface FailureDump {
  project: string; // testInfo.project.name — disambiguates desktop/mobile runs of the same spec
  file?: string; // basename(testInfo.file) — disambiguates same-titled tests in different spec files
  title: string; // titlePath.filter(Boolean).slice(1).join(" › ") — the stream reporter's _name
  retry: number;
  yaml?: string;
  // D1/D2 runtime evidence (optional, best-effort, absent on older dumps and when capture missed).
  httpStatus?: number; // the attributed 5xx status (integer in [500,599]), or absent
  finalUrl?: string;   // page.url() at the failure point, or absent
  // Feature B runtime evidence: deduped, capped browser console `error`/`pageerror` entries observed
  // during the failing test (optional, best-effort, absent on older dumps and when capture missed).
  runtimeErrors?: { type: string; text: string }[];
}

// Reads every qa-failure-capture dump from the capture dir into a parsed list. Best-effort: an
// unreadable/malformed dump is skipped (warned), never fatal. The body is authoritative for
// `project`/`title`/`yaml`; the filename's trailing `__<n>.json` carries the retry index as a
// fallback when the body omits it (it always carries it now).
export function readFailureDumps(dir: string): FailureDump[] {
  let files: string[] = [];
  try { files = readdirSync(dir); } catch { return []; }
  const RETRY_RE = /__(\d+)\.json$/;
  const out: FailureDump[] = [];
  for (const f of files) {
    const m = RETRY_RE.exec(f);
    if (!m) continue;
    try {
      const body = JSON.parse(readFileSync(join(dir, f), "utf8")) as { project?: unknown; file?: unknown; title?: unknown; retry?: unknown; yaml?: unknown; httpStatus?: unknown; finalUrl?: unknown; runtimeErrors?: unknown };
      const runtimeErrors = parseRuntimeErrors(body.runtimeErrors);
      out.push({
        project: typeof body.project === "string" ? body.project : "",
        ...(typeof body.file === "string" ? { file: body.file } : {}),
        title: typeof body.title === "string" ? body.title : "",
        retry: typeof body.retry === "number" ? body.retry : parseInt(m[1]!, 10),
        ...(typeof body.yaml === "string" ? { yaml: body.yaml } : {}),
        // D1/D2 runtime evidence — parsed defensively: absent/garbage → undefined, never throw.
        ...(typeof body.httpStatus === "number" && Number.isInteger(body.httpStatus) ? { httpStatus: body.httpStatus } : {}),
        ...(typeof body.finalUrl === "string" ? { finalUrl: body.finalUrl } : {}),
        // Feature B runtime evidence — same defensive contract.
        ...(runtimeErrors.length > 0 ? { runtimeErrors } : {}),
      });
    } catch (err) {
      console.warn(`[qa] WARNING: failed to read failure capture dump ${f}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

// Defensively parses the `runtimeErrors` field of a capture dump: a malformed entry (wrong shape,
// non-string `text`/`type`) is DROPPED rather than throwing or poisoning the whole array — the fixture
// that writes these dumps is best-effort and self-contained (see qa-failure-capture in
// config/e2e/fixtures.ts), so the harvest side must tolerate a partially-garbage array. Never throws.
function parseRuntimeErrors(v: unknown): { type: string; text: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { type: string; text: string }[] = [];
  for (const entry of v) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as { type?: unknown }).type === "string" &&
      typeof (entry as { text?: unknown }).text === "string"
    ) {
      out.push({ type: (entry as { type: string }).type, text: (entry as { text: string }).text });
    }
  }
  return out;
}

// Matches a failed case to its capture dump. The report's case name is `[project ›] file › describe › test`
// (the fixture keys the dump off `describe › test` only — titlePath without the project + file prefix —
// and records the spec `file` separately). Match on TWO conditions:
//   1. FILE: the dump's `file` (basename) equals ANY segment of the case name — so two tests with the
//      SAME `describe › test` chain in DIFFERENT spec files never cross-attach the wrong DOM (W1). The
//      file is NOT assumed to be the leading segment: with the seed's two-project config the suite runs
//      with NO `--project`, so Playwright nests specs under the PROJECT top-suite and the case name is
//      `desktop › owners.spec.ts › …` (project leads, file is the SECOND segment). A single-project run
//      leads with the file. Matching `file === any segment` is correct for both (C1). Skipped for dumps
//      with no recorded file (older dumps) — then matching falls back to title-only, the pre-W1 behavior.
//   2. SEGMENT-WISE TITLE: the dump's title segments must be a contiguous TAIL of the case's segments
//      with EXACT per-segment equality (so "add owner" never matches a dump "owner", which the old
//      character `endsWith` wrongly did).
// Ties (two projects, same spec) are broken DETERMINISTICALLY — sort by project name, then take the
// HIGHEST retry — never readdirSync order. Pure over the parsed dumps so it is unit-testable without
// FS I/O. Returns null on no match.
export function matchFailureDumps(caseName: string, dumps: FailureDump[]): FailureDump | null {
  const caseSegs = titleSegments(caseName);
  const candidates = dumps.filter((d) => {
    if (!d.title || !segmentsAreTail(caseSegs, titleSegments(d.title))) return false;
    // The file must match SOME case segment when the dump carries one (the leading segment is the
    // PROJECT under the multi-project config, the FILE under single-project — so never assume it is
    // caseSegs[0]). The dump records `file` as the BASENAME (`checkout.spec.ts`), but Playwright names
    // the file suite with the path RELATIVE to rootDir — so a fan-out spec at `flows/checkout.spec.ts`
    // appears as the segment `flows/checkout.spec.ts`. Match the basename against a whole segment OR its
    // trailing `/<basename>` (every fan-out spec lives under `flows/`), while still rejecting
    // `add-checkout.spec.ts`. When the dump has no file (older dumps) fall back to the title-only match.
    if (d.file && !caseSegs.some((s) => s === d.file || s.endsWith(`/${d.file}`))) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  // Deterministic order: project name ascending, then highest retry first. Both projects run the
  // same spec, so either dump is a valid post-failure DOM; we just need a STABLE pick across runs.
  candidates.sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : b.retry - a.retry));
  return candidates[0]!;
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
  runCleanup(args: { dir: string; baseUrl: string; namespace: string; testIdAttribute?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
}

export const defaultCleanupDeps: CleanupDeps = {
  runCleanup: ({ dir, baseUrl, namespace, testIdAttribute, signal, timeoutMs }) =>
    new Promise((resolve) => {
      const child = spawn("npx", ["playwright", "test", "cleanup.spec.ts", "--reporter=line"], {
        cwd: dir,
        // Agent-written specs run here: scrub the orchestrator's secrets (GITHUB_TOKEN etc.)
        // while keeping the app's DEV_* login creds the fixtures need.
        env: { ...scrubEnv({ extraAllowed: /^DEV_/ }), PW_BASE_URL: baseUrl, PW_NAMESPACE: namespace, PW_CLEANUP: "1", ...(testIdAttribute ? { PW_TEST_ID_ATTRIBUTE: testIdAttribute } : {}) },
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
// the --project append, --specFiles append, and allowlists stay unit-testable without
// spawning Playwright.
export function playwrightArgs(reporterPath: string, project?: string, specFiles?: string[]): string[] {
  const args = ["playwright", "test", `--reporter=${reporterPath},json`];
  if (project !== undefined) {
    if (!PW_PROJECT_RE.test(project)) {
      throw new Error(`invalid Playwright project name ${JSON.stringify(project)}: must match ${String(PW_PROJECT_RE)}`);
    }
    args.push(`--project=${project}`);
  }
  if (specFiles !== undefined && specFiles.length > 0) {
    assertSpecFiles(specFiles);
    args.push(...specFiles);
  }
  return args;
}

export const defaultExecuteDeps: ExecuteDeps = {
  runSuite: ({ dir, baseUrl, namespace, testIdAttribute, faultInject, project, specFiles, signal, timeoutMs, onEvent, failureCaptureDir }) =>
    new Promise((resolve, reject) => {
      const work = mkdtempSync(join(tmpdir(), "qa-pw-"));
      const reporterPath = join(work, "qa-stream-reporter.cjs");
      const jsonPath = join(work, "report.json");
      writeFileSync(reporterPath, STREAM_REPORTER);

      // JSON → file (authoritative, via PLAYWRIGHT_JSON_OUTPUT_NAME); NDJSON → stdout
      // (live feed). The two reporters never collide on stdout.
      const child = spawn("npx", playwrightArgs(reporterPath, project, specFiles), {
        cwd: dir,
        // Agent-written specs are untrusted code: scrub orchestrator secrets, keep DEV_* creds.
        // QA_FAILURE_CAPTURE_DIR: the qa-failure-capture afterEach fixture writes per-case aria
        // snapshot dumps here on failure; the orchestrator harvests them post-run to populate
        // QaCase.failureDom for the fix-loop grounding prompt.
        // PW_TEST_ID_ATTRIBUTE: threads the configured testIdAttribute into the runner so
        // playwright.config.ts resolves getByTestId correctly for the app's convention.
        // PW_ACTION_TIMEOUT_MS: optional per-target override of the seed's action auto-wait
        // bound (default 8000) so a slower DEV can widen it without editing the seed config.
        env: { ...scrubEnv({ extraAllowed: /^DEV_/ }), PW_BASE_URL: baseUrl, PW_NAMESPACE: namespace, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonPath, ...(testIdAttribute ? { PW_TEST_ID_ATTRIBUTE: testIdAttribute } : {}), ...(process.env.PW_ACTION_TIMEOUT_MS ? { PW_ACTION_TIMEOUT_MS: process.env.PW_ACTION_TIMEOUT_MS } : {}), ...(faultInject ? { QA_FAULT_INJECT: "1" } : {}), ...(failureCaptureDir ? { QA_FAILURE_CAPTURE_DIR: failureCaptureDir } : {}) },
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
