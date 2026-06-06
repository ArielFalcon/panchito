import { test } from "node:test";
import assert from "node:assert/strict";
import { runE2E, ExecuteDeps } from "./execute";

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
    runSuite: async () => ({ report: { stats: { unexpected: 0 } }, logs: "ok", ran: true }),
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
