// Pure parser of the Playwright JSON report → pass/fail/flaky cases. Isolated so
// it can be verified with a sample report without running browsers.
//
// Flaky is Filter C of the harness: Playwright marks a test "flaky" when it fails
// and then passes on a retry (retries are set in the base config). We treat that
// instability as NOT trustworthy → quarantine, not a real failure.

import { CaseStatus, RunVerdict } from "../types";

export interface PwCase {
  name: string;
  status: CaseStatus;
  detail?: string;
}

export interface ParsedReport {
  // "pass" | "fail" | "flaky", plus "infra-error" for the inverse of the crashed-runner
  // case: a report that PARSED but executed zero tests (it never reaches "invalid", which
  // is the static gate). A suite that ran nothing proves nothing and must never be green.
  verdict: RunVerdict;
  passed: boolean; // shorthand for verdict === "pass"
  cases: PwCase[];
  executed: number; // tests that actually ran (expected+unexpected+flaky; skipped excluded)
}

interface PwResult {
  status?: string;
  error?: { message?: string };
}
interface PwTest {
  results?: PwResult[];
  status?: string; // expected | unexpected | flaky | skipped
}
interface PwSpec {
  title?: string;
  ok?: boolean;
  tests?: PwTest[];
}
interface PwSuite {
  title?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}
interface PwReport {
  suites?: PwSuite[];
  // Playwright's summary counters. `expected` (passed) and `skipped` matter for
  // deciding whether anything actually ran — without them a zero-test report is
  // indistinguishable from a clean pass.
  stats?: { expected?: number; unexpected?: number; flaky?: number; skipped?: number };
}

const OK_STATUSES = new Set(["passed", "expected"]);

// A spec that executed nothing meaningful (all tests skipped, or no signal at all).
// Distinct from pass/fail/flaky so it can be excluded from the executed count.
type SpecOutcome = CaseStatus | "skipped";

export function parsePlaywrightReport(json: unknown): ParsedReport {
  const report = (json ?? {}) as PwReport;
  const cases: PwCase[] = [];

  const walk = (suites: PwSuite[] | undefined, prefix: string): void => {
    for (const suite of suites ?? []) {
      const title = [prefix, suite.title].filter(Boolean).join(" › ");
      for (const spec of suite.specs ?? []) {
        const outcome = specOutcome(spec);
        if (outcome === "skipped") continue; // executed nothing → not a case, not a pass
        cases.push({
          name: [title, spec.title].filter(Boolean).join(" › "),
          status: outcome,
          detail: outcome === "pass" ? undefined : firstError(spec),
        });
      }
      walk(suite.suites, title);
    }
  };
  walk(report.suites, "");

  const executed = countExecuted(report, cases);
  const verdict = aggregate(cases, report, executed);
  return { verdict, passed: verdict === "pass", cases, executed };
}

// A spec's outcome, preferring Playwright's per-test `status` when present
// (expected/unexpected/flaky/skipped); otherwise falls back to the legacy
// `ok`/results. Fail-closed: an unrecognized status is a fail, never a silent pass.
function specOutcome(spec: PwSpec): SpecOutcome {
  const statuses = (spec.tests ?? []).map((t) => t.status).filter(Boolean) as string[];
  if (statuses.length) {
    if (statuses.includes("unexpected")) return "fail";
    if (statuses.includes("flaky")) return "flaky";
    if (statuses.includes("expected")) return "pass";
    // No expected/unexpected/flaky: the spec ran nothing real.
    if (statuses.every((s) => s === "skipped")) return "skipped";
    return "fail"; // unknown status (timedOut/interrupted/…) → fail-closed
  }
  // Fallback (reports without per-test status): cannot distinguish flaky.
  const results = (spec.tests ?? []).flatMap((t) => t.results ?? []);
  const resultStatuses = results.map((r) => r.status ?? "").filter(Boolean);
  if (resultStatuses.length && resultStatuses.every((s) => s === "skipped")) return "skipped";
  if (spec.ok === undefined && resultStatuses.length === 0) return "skipped"; // no signal at all
  const ok = spec.ok ?? results.every((r) => OK_STATUSES.has(r.status ?? ""));
  return ok ? "pass" : "fail";
}

// How many tests actually executed. Prefer the report's own counters when present
// (they are authoritative even for reports with no per-spec detail); otherwise fall
// back to the number of non-skipped specs we classified.
function countExecuted(report: PwReport, cases: PwCase[]): number {
  const s = report.stats;
  if (s && (s.expected != null || s.unexpected != null || s.flaky != null || s.skipped != null)) {
    return (s.expected ?? 0) + (s.unexpected ?? 0) + (s.flaky ?? 0);
  }
  return cases.length; // each emitted case is a spec that executed
}

function aggregate(cases: PwCase[], report: PwReport, executed: number): RunVerdict {
  if (cases.some((c) => c.status === "fail")) return "fail";
  if (cases.some((c) => c.status === "flaky")) return "flaky";
  // Stats-level signal (for reports without per-spec detail).
  if ((report.stats?.unexpected ?? 0) > 0) return "fail";
  if ((report.stats?.flaky ?? 0) > 0) return "flaky";
  // Nothing failed or flaky: a pass requires that at least one test executed.
  // A suite that ran zero tests is inconclusive infrastructure, never green.
  if (executed === 0) return "infra-error";
  return "pass";
}

function firstError(spec: PwSpec): string | undefined {
  for (const t of spec.tests ?? []) {
    for (const r of t.results ?? []) {
      if (r.error?.message) return r.error.message;
    }
  }
  return undefined;
}
