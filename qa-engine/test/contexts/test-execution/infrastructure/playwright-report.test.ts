// qa-engine/test/contexts/test-execution/infrastructure/playwright-report.test.ts
// Moved from src/qa/playwright-report.test.ts (migration-tier-4d Slice 1a — playwright-report
// migration, prep step ahead of the execute.ts body-move in Slice 1b). Byte-identical assertions
// to the legacy file — only the import path changes, plus the inline QaCase type-only import,
// which now reads from the qa-engine kernel's own canonical copy instead of src/types.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlaywrightReport, firstErrorContext } from "@contexts/test-execution/infrastructure/playwright-report.ts";

test("maps nested specs to pass/fail cases", () => {
  const report = {
    suites: [
      {
        title: "login.spec.ts",
        specs: [
          { title: "logs in with valid credentials", ok: true },
          {
            title: "rejects invalid credentials",
            ok: false,
            tests: [{ results: [{ status: "failed", error: { message: "expected 401" } }] }],
          },
        ],
      },
    ],
  };
  const parsed = parsePlaywrightReport(report);
  assert.equal(parsed.cases.length, 2);
  assert.equal(parsed.passed, false);
  const failed = parsed.cases.find((c) => c.status === "fail");
  assert.match(failed!.name, /rejects invalid/);
  assert.equal(failed!.detail, "expected 401");
});

test("all green => passed true", () => {
  const report = {
    suites: [{ title: "s", specs: [{ title: "a", ok: true }, { title: "b", ok: true }] }],
  };
  const parsed = parsePlaywrightReport(report);
  assert.equal(parsed.passed, true);
  assert.equal(parsed.cases.length, 2);
});

test("with no specs uses stats to detect failures (and requires execution to pass)", () => {
  assert.equal(parsePlaywrightReport({ stats: { expected: 2, unexpected: 0 } }).passed, true);
  assert.equal(parsePlaywrightReport({ stats: { expected: 0, unexpected: 2 } }).passed, false);
});

test("marks flaky when a test passed after a retry (status flaky)", () => {
  const report = {
    suites: [
      {
        title: "checkout.spec.ts",
        specs: [
          { title: "stable", tests: [{ status: "expected" }] },
          { title: "unstable", tests: [{ status: "flaky" }] },
        ],
      },
    ],
  };
  const parsed = parsePlaywrightReport(report);
  assert.equal(parsed.verdict, "flaky"); // no fail, but there is a flaky
  assert.equal(parsed.passed, false);
  assert.equal(parsed.cases.find((c) => c.status === "flaky")?.name.includes("unstable"), true);
});

test("a consistent fail wins over a flaky", () => {
  const report = {
    suites: [
      {
        specs: [
          { title: "a", tests: [{ status: "flaky" }] },
          { title: "b", tests: [{ status: "unexpected", results: [{ error: { message: "boom" } }] }] },
        ],
      },
    ],
  };
  assert.equal(parsePlaywrightReport(report).verdict, "fail");
});

test("derives ok from results when there is no spec.ok", () => {
  const report = {
    suites: [
      {
        specs: [{ title: "c", tests: [{ results: [{ status: "passed" }] }] }],
      },
    ],
  };
  assert.equal(parsePlaywrightReport(report).passed, true);
});

// Filter C invariant (the inverse of "no parseable report => infra-error"): a
// report that PARSED but executed ZERO tests must NEVER classify as pass. A
// suite that ran nothing proves nothing and must not publish a green PR.
test("a report that executed zero tests is never a pass", () => {
  assert.equal(parsePlaywrightReport({ suites: [] }).passed, false);
  assert.equal(parsePlaywrightReport({ suites: [] }).verdict, "infra-error");
  assert.equal(parsePlaywrightReport({}).passed, false);
});

test("a spec whose tests are all skipped does not count as a pass", () => {
  const report = { suites: [{ specs: [{ title: "skipped one", tests: [{ status: "skipped" }] }] }] };
  const parsed = parsePlaywrightReport(report);
  assert.equal(parsed.passed, false);
  assert.equal(parsed.cases.some((c) => c.status === "pass"), false);
});

test("an unrecognized per-test status fails closed, never a silent pass", () => {
  const report = { suites: [{ specs: [{ title: "timed out", tests: [{ status: "timedOut" }] }] }] };
  assert.equal(parsePlaywrightReport(report).passed, false);
});

test("stats-only report passes only when tests actually executed", () => {
  assert.equal(parsePlaywrightReport({ stats: { expected: 3, unexpected: 0, flaky: 0, skipped: 0 } }).passed, true);
  assert.equal(parsePlaywrightReport({ stats: { expected: 1, unexpected: 2 } }).passed, false);
});

test("a spec with one executed pass and one skipped test still passes", () => {
  const report = { suites: [{ specs: [{ title: "mixed", tests: [{ status: "expected" }, { status: "skipped" }] }] }] };
  assert.equal(parsePlaywrightReport(report).passed, true);
});

// ── firstErrorContext + PwCase.errorContext (Unit 2 — Task 2.11) ───────────────

test("firstErrorContext returns the errorContext string from errors[0]", () => {
  // A spec with a result that carries errors[].errorContext (simulated 1.60 shape).
  const spec = {
    title: "fails",
    tests: [
      {
        status: "unexpected",
        results: [
          {
            status: "failed",
            error: { message: "expect failed" },
            errors: [{ message: "expect failed", errorContext: "- button \"Submit\"" }],
          },
        ],
      },
    ],
  };
  assert.equal(firstErrorContext(spec), "- button \"Submit\"");
});

test("firstErrorContext returns undefined when errors[] is absent (pre-1.60 report)", () => {
  const spec = {
    title: "fails",
    tests: [
      {
        status: "unexpected",
        results: [{ status: "failed", error: { message: "boom" } }],
      },
    ],
  };
  assert.equal(firstErrorContext(spec), undefined);
});

test("firstErrorContext returns undefined when errors[] is present but errorContext is absent", () => {
  const spec = {
    title: "fails",
    tests: [
      {
        status: "unexpected",
        results: [
          {
            status: "failed",
            errors: [{ message: "only message, no errorContext" }],
          },
        ],
      },
    ],
  };
  assert.equal(firstErrorContext(spec), undefined);
});

test("parsePlaywrightReport populates errorContext on a failed case when errors[] carries it", () => {
  const report = {
    suites: [
      {
        title: "s.spec.ts",
        specs: [
          {
            title: "fails with context",
            tests: [
              {
                status: "unexpected",
                results: [
                  {
                    status: "failed",
                    error: { message: "expect failed" },
                    errors: [{ message: "expect failed", errorContext: "- button \"Submit\"" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const parsed = parsePlaywrightReport(report);
  const failed = parsed.cases.find((c) => c.status === "fail");
  assert.ok(failed, "expected a failed case");
  assert.equal(failed!.errorContext, "- button \"Submit\"");
});

test("parsePlaywrightReport backward-compat: errorContext absent on pre-1.60 report", () => {
  const report = {
    suites: [
      {
        specs: [
          {
            title: "old fail",
            ok: false,
            tests: [{ results: [{ status: "failed", error: { message: "classic error" } }] }],
          },
        ],
      },
    ],
  };
  const parsed = parsePlaywrightReport(report);
  const failed = parsed.cases.find((c) => c.status === "fail");
  assert.ok(failed);
  assert.equal(failed!.errorContext, undefined);
});

// ── QaCase.file — spec file basename on parsed cases ─────────────────────────

test("parsePlaywrightReport: a parsed QaCase carries the spec file basename from the enclosing suite title", () => {
  const report = {
    suites: [
      {
        title: "login.spec.ts",
        specs: [
          { title: "logs in", ok: true },
          { title: "rejects bad pw", ok: false, tests: [{ results: [{ status: "failed", error: { message: "401" } }] }] },
        ],
      },
    ],
  };
  const parsed = parsePlaywrightReport(report);
  // Both cases must carry the enclosing suite title as .file
  for (const c of parsed.cases) {
    assert.equal((c as import("@kernel/qa-case.ts").QaCase).file, "login.spec.ts", `expected file="login.spec.ts" on case "${c.name}", got ${JSON.stringify((c as import("@kernel/qa-case.ts").QaCase).file)}`);
  }
});

test("parsePlaywrightReport: nested suite (describe block) — file is still the TOP-LEVEL suite title", () => {
  const report = {
    suites: [
      {
        title: "checkout.spec.ts",
        suites: [
          {
            title: "Checkout flow",
            specs: [{ title: "completes order", ok: true }],
          },
        ],
      },
    ],
  };
  const parsed = parsePlaywrightReport(report);
  assert.equal(parsed.cases.length, 1);
  assert.equal((parsed.cases[0]! as import("@kernel/qa-case.ts").QaCase).file, "checkout.spec.ts");
});

test("parsePlaywrightReport: a spec at the root suite (no file title) leaves file undefined", () => {
  // When there is no enclosing suite that looks like a spec file, file stays undefined.
  const report = {
    suites: [
      {
        // No title (or non-spec-file title) — file cannot be determined
        specs: [{ title: "orphan test", ok: true }],
      },
    ],
  };
  const parsed = parsePlaywrightReport(report);
  assert.equal(parsed.cases.length, 1);
  // file is either undefined or empty — must NOT be a meaningful path
  const file = (parsed.cases[0]! as import("@kernel/qa-case.ts").QaCase).file;
  assert.ok(!file || file === "", `orphan test should have no meaningful file; got ${JSON.stringify(file)}`);
});

test("firstErrorContext is defensive against null/undefined shape variants (no throw)", () => {
  // Empty spec — nothing crashes.
  assert.doesNotThrow(() => firstErrorContext({ title: "x", tests: [] }));
  // Test with no results.
  assert.doesNotThrow(() => firstErrorContext({ title: "x", tests: [{}] }));
  // Result with empty errors array.
  assert.doesNotThrow(() => firstErrorContext({ title: "x", tests: [{ results: [{ errors: [] }] }] }));
  // All return undefined — never throw.
  assert.equal(firstErrorContext({ title: "x", tests: [] }), undefined);
});
