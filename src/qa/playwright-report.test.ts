import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlaywrightReport } from "./playwright-report";

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
