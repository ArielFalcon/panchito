import { test } from "node:test";
import assert from "node:assert/strict";
import { runE2E, ExecuteDeps, parseStreamEvent, streamStatusToCase } from "./execute";
import { QaCase } from "../types";

test("runs, maps cases and SANITIZES the logs", async () => {
  const deps: ExecuteDeps = {
    runSuite: async () => ({
      report: {
        suites: [
          {
            title: "login.spec.ts",
            specs: [
              { title: "ok", ok: true },
              {
                title: "broken",
                ok: false,
                tests: [{ results: [{ status: "failed", error: { message: "boom" } }] }],
              },
            ],
          },
        ],
      },
      // a log with a secret that must NOT reach the LLM/Issue
      logs: "running... token: ghs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa end",
      ran: true,
    }),
  };

  const run = await runE2E("/mirrors/org__app/e2e", { baseUrl: "https://dev", namespace: "qa-bot-abc1234" }, deps);

  assert.equal(run.verdict, "fail");
  assert.equal(run.passed, false);
  assert.equal(run.cases.length, 2);
  assert.doesNotMatch(run.logs, /ghs_aaaa/); // secret redacted
  assert.match(run.logs, /\[REDACTED_SECRET\]/);
});

test("classifies flaky when there are unstable cases and none fail", async () => {
  const deps: ExecuteDeps = {
    runSuite: async () => ({
      report: { suites: [{ specs: [{ title: "x", tests: [{ status: "flaky" }] }] }] },
      logs: "ok",
      ran: true,
    }),
  };
  const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-f" }, deps);
  assert.equal(run.verdict, "flaky");
  assert.equal(run.passed, false);
});

test("all green => verdict pass", async () => {
  const deps: ExecuteDeps = {
    runSuite: async () => ({ report: { stats: { expected: 2, unexpected: 0 } }, logs: "ok", ran: true }),
  };
  const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-zzz" }, deps);
  assert.equal(run.passed, true);
  assert.equal(run.verdict, "pass");
});

test("a crashed runner (no parseable report) is infra-error, NEVER pass", async () => {
  // The default runner sets ran:false when stdout is not JSON (Playwright failed
  // to launch / config error). This must not be swallowed into a green run.
  const deps: ExecuteDeps = {
    runSuite: async () => ({ report: {}, logs: "Error: browserType.launch failed", ran: false }),
  };
  const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-crash" }, deps);
  assert.equal(run.verdict, "infra-error");
  assert.equal(run.passed, false);
  assert.equal(run.cases.length, 0);
});

test("a ran-but-empty report ({}) is infra-error, not a false pass", async () => {
  const deps: ExecuteDeps = {
    runSuite: async () => ({ report: {}, logs: "weird", ran: true }),
  };
  const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-empty" }, deps);
  assert.equal(run.verdict, "infra-error");
  assert.equal(run.passed, false);
});

test("parseStreamEvent parses the NDJSON reporter lines and ignores noise", () => {
  assert.deepEqual(parseStreamEvent('{"e":"begin","total":3}'), { phase: "begin", total: 3 });
  assert.deepEqual(parseStreamEvent('{"e":"testbegin","title":"checkout › buys","file":"c.spec.ts"}'), { phase: "testbegin", title: "checkout › buys", file: "c.spec.ts" });
  assert.deepEqual(parseStreamEvent('{"e":"testend","title":"checkout › buys","status":"passed"}'), { phase: "testend", title: "checkout › buys", status: "passed" });
  assert.equal(parseStreamEvent(""), null);
  assert.equal(parseStreamEvent("not json"), null);
  assert.equal(parseStreamEvent('{"e":"other"}'), null);
});

test("streamStatusToCase maps green to pass, skipped to null, everything else fail-closed", () => {
  assert.equal(streamStatusToCase("passed"), "pass");
  assert.equal(streamStatusToCase("expected"), "pass");
  assert.equal(streamStatusToCase("skipped"), null);
  assert.equal(streamStatusToCase("failed"), "fail");
  assert.equal(streamStatusToCase("timedOut"), "fail");
});

test("runE2E streams testbegin → onRunning and testend → onCase incrementally", async () => {
  const running: string[] = [];
  const cases: QaCase[] = [];
  const deps: ExecuteDeps = {
    runSuite: async ({ onEvent }) => {
      onEvent?.({ phase: "begin", total: 2 });
      onEvent?.({ phase: "testbegin", title: "home › hero" });
      onEvent?.({ phase: "testend", title: "home › hero", status: "passed" });
      onEvent?.({ phase: "testbegin", title: "cart › total" });
      onEvent?.({ phase: "testend", title: "cart › total", status: "failed" });
      onEvent?.({ phase: "testend", title: "skip › me", status: "skipped" }); // not a case
      return { report: { stats: { expected: 1, unexpected: 1 } }, logs: "ok", ran: true };
    },
  };
  await runE2E("/dir", {
    baseUrl: "https://dev",
    namespace: "qa-bot-stream",
    onRunning: (t) => running.push(t),
    onCase: (c) => cases.push(c),
  }, deps);

  assert.deepEqual(running, ["home › hero", "cart › total"]);
  assert.deepEqual(cases.map((c) => `${c.name}:${c.status}`), ["home › hero:pass", "cart › total:fail"]);
});

test("a ran report that executed zero tests is infra-error, not a false pass", async () => {
  // A shaped report (suites present) but with no executed test — e.g. testMatch
  // matched nothing, or every spec was filtered/skipped. Ran, but proved nothing.
  const deps: ExecuteDeps = {
    runSuite: async () => ({ report: { suites: [], stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 } }, logs: "Error: No tests found", ran: true }),
  };
  const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-zero" }, deps);
  assert.equal(run.verdict, "infra-error");
  assert.equal(run.passed, false);
});
