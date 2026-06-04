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
  verdict: RunVerdict; // "pass" | "fail" | "flaky" (never "invalid": that is the static gate)
  passed: boolean; // shorthand for verdict === "pass"
  cases: PwCase[];
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
  stats?: { unexpected?: number; flaky?: number };
}

const OK_STATUSES = new Set(["passed", "expected"]);

export function parsePlaywrightReport(json: unknown): ParsedReport {
  const report = (json ?? {}) as PwReport;
  const cases: PwCase[] = [];

  const walk = (suites: PwSuite[] | undefined, prefix: string): void => {
    for (const suite of suites ?? []) {
      const title = [prefix, suite.title].filter(Boolean).join(" › ");
      for (const spec of suite.specs ?? []) {
        const status = specStatus(spec);
        cases.push({
          name: [title, spec.title].filter(Boolean).join(" › "),
          status,
          detail: status === "pass" ? undefined : firstError(spec),
        });
      }
      walk(suite.suites, title);
    }
  };
  walk(report.suites, "");

  const verdict = aggregate(cases, report);
  return { verdict, passed: verdict === "pass", cases };
}

// A spec's status, preferring Playwright's per-test `status` when present
// (expected/unexpected/flaky); otherwise falls back to the legacy `ok`/results.
function specStatus(spec: PwSpec): CaseStatus {
  const statuses = (spec.tests ?? []).map((t) => t.status).filter(Boolean) as string[];
  if (statuses.length) {
    if (statuses.includes("unexpected")) return "fail";
    if (statuses.includes("flaky")) return "flaky";
    return "pass";
  }
  // Fallback (reports without per-test status): cannot distinguish flaky.
  const ok =
    spec.ok ??
    (spec.tests ?? []).every((t) =>
      (t.results ?? []).every((r) => OK_STATUSES.has(r.status ?? "")),
    );
  return ok ? "pass" : "fail";
}

function aggregate(cases: PwCase[], report: PwReport): RunVerdict {
  if (cases.length > 0) {
    if (cases.some((c) => c.status === "fail")) return "fail";
    if (cases.some((c) => c.status === "flaky")) return "flaky";
    return "pass";
  }
  // No specs detected: use the global stats.
  if ((report.stats?.unexpected ?? 0) > 0) return "fail";
  if ((report.stats?.flaky ?? 0) > 0) return "flaky";
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
