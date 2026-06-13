import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  runE2E,
  ExecuteDeps,
  parseStreamEvent,
  streamStatusToCase,
  allFailuresAreRunnerInfra,
  killTree,
  playwrightArgs,
  e2eTimeoutMs,
  DEFAULT_E2E_TIMEOUT_MS,
} from "./execute";
import { QaCase } from "../types";

test("allFailuresAreRunnerInfra: a browser-launch failure is infra (runner fault), not a test failure", () => {
  const launchFail: QaCase[] = [
    { name: "owner-registration.spec.ts › register owner", status: "fail", detail: "Error: browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium_headless_shell-1155/chrome-linux/headless_shell" },
    { name: "cleanup.spec.ts › cleanup", status: "fail", detail: "Error: browserType.launch: Executable doesn't exist" },
  ];
  assert.equal(allFailuresAreRunnerInfra(launchFail), true);

  // A GENUINE test failure (assertion/timeout) is NOT infra — it stays `fail`.
  const realFail: QaCase[] = [
    { name: "owner › appears in list", status: "fail", detail: "Error: expect(locator).toBeVisible() failed: timed out" },
  ];
  assert.equal(allFailuresAreRunnerInfra(realFail), false);

  // A MIX (one infra, one genuine) is conservatively NOT reclassified — stays `fail`.
  const mixed: QaCase[] = [launchFail[0]!, realFail[0]!];
  assert.equal(allFailuresAreRunnerInfra(mixed), false);

  // No failures at all → not infra.
  assert.equal(allFailuresAreRunnerInfra([{ name: "x", status: "pass" }]), false);
});

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
  assert.deepEqual(parseStreamEvent('{"e":"discovered","title":"checkout › buys","file":"c.spec.ts"}'), { phase: "discovered", title: "checkout › buys", file: "c.spec.ts" });
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

// ── Integration tests: Playwright boundary failure modes ─────────────────────

test("runE2E propagates error when deps.runSuite throws (runner crash / spawn error)", async () => {
  const deps: ExecuteDeps = {
    runSuite: async () => { throw new Error("Playwright runner crashed: spawn ENOENT"); },
  };
  await assert.rejects(
    () => runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-crash" }, deps),
    /spawn ENOENT/,
  );
});

test("runE2E handles a malformed report shape by returning infra-error", async () => {
  const deps: ExecuteDeps = {
    runSuite: async () => ({ report: { notSuites: "x" }, logs: "weird output", ran: true }),
  };
  const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-malformed" }, deps);
  assert.equal(run.verdict, "infra-error");
  assert.equal(run.passed, false);
});

test("runE2E handles a null report by returning infra-error", async () => {
  const deps: ExecuteDeps = {
    runSuite: async () => ({ report: null, logs: "null report", ran: true }),
  };
  const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-null" }, deps);
  assert.equal(run.verdict, "infra-error");
  assert.equal(run.passed, false);
});

// ── Process safeguards: timeout, abort, kill-tree, --project ─────────────────

test("a hung runner is timed out and classified infra-error, never a test failure", async () => {
  const deps: ExecuteDeps = {
    runSuite: () => new Promise(() => { /* hangs forever, like a wedged browser */ }),
  };
  const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-hang", timeoutMs: 30 }, deps);
  assert.equal(run.verdict, "infra-error");
  assert.equal(run.passed, false);
  assert.equal(run.cases.length, 0);
  assert.match(run.logs, /timed out after 30ms — killed/);
});

test("an abort signal kills a hung runner and classifies infra-error", async () => {
  const controller = new AbortController();
  const deps: ExecuteDeps = {
    runSuite: () => new Promise(() => { /* hangs until aborted */ }),
  };
  setTimeout(() => controller.abort(), 10);
  const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-abort", signal: controller.signal }, deps);
  assert.equal(run.verdict, "infra-error");
  assert.equal(run.passed, false);
  assert.match(run.logs, /aborted by operator cancel/);
});

test("an already-aborted signal returns infra-error without starting the runner", async () => {
  const controller = new AbortController();
  controller.abort();
  let started = false;
  const deps: ExecuteDeps = {
    runSuite: async () => { started = true; return { report: { stats: {} }, logs: "", ran: true }; },
  };
  const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-preabort", signal: controller.signal }, deps);
  assert.equal(run.verdict, "infra-error");
  assert.equal(started, false);
});

test("runE2E passes project, signal and timeoutMs through to the runner deps", async () => {
  const controller = new AbortController();
  let seen: { project?: string; signal?: AbortSignal; timeoutMs?: number } = {};
  const deps: ExecuteDeps = {
    runSuite: async (args) => {
      seen = { project: args.project, signal: args.signal, timeoutMs: args.timeoutMs };
      return { report: { stats: { expected: 1 } }, logs: "ok", ran: true };
    },
  };
  await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-proj", project: "desktop", signal: controller.signal, timeoutMs: 5_000 }, deps);
  assert.equal(seen.project, "desktop");
  assert.equal(seen.signal, controller.signal);
  assert.equal(seen.timeoutMs, 5_000);
});

test("runE2E rejects a project name outside the allowlist (arg-injection surface)", async () => {
  let started = false;
  const deps: ExecuteDeps = {
    runSuite: async () => { started = true; return { report: { stats: {} }, logs: "", ran: true }; },
  };
  await assert.rejects(
    () => runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-inj", project: "desktop --workers=99" }, deps),
    /invalid Playwright project name/,
  );
  await assert.rejects(
    () => runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-inj2", project: "a;rm -rf /" }, deps),
    /invalid Playwright project name/,
  );
  assert.equal(started, false);
});

test("playwrightArgs appends --project only when set, and validates it", () => {
  assert.deepEqual(playwrightArgs("/tmp/rep.cjs"), ["playwright", "test", "--reporter=/tmp/rep.cjs,json"]);
  assert.deepEqual(
    playwrightArgs("/tmp/rep.cjs", "desktop"),
    ["playwright", "test", "--reporter=/tmp/rep.cjs,json", "--project=desktop"],
  );
  assert.throws(() => playwrightArgs("/tmp/rep.cjs", "desktop mobile"), /invalid Playwright project name/);
  assert.throws(() => playwrightArgs("/tmp/rep.cjs", "$(reboot)"), /invalid Playwright project name/);
});

test("e2eTimeoutMs honors QA_E2E_TIMEOUT_MS and falls back to the default on garbage", () => {
  const prev = process.env.QA_E2E_TIMEOUT_MS;
  try {
    process.env.QA_E2E_TIMEOUT_MS = "123456";
    assert.equal(e2eTimeoutMs(), 123456);
    process.env.QA_E2E_TIMEOUT_MS = "not-a-number";
    assert.equal(e2eTimeoutMs(), DEFAULT_E2E_TIMEOUT_MS);
    process.env.QA_E2E_TIMEOUT_MS = "-5";
    assert.equal(e2eTimeoutMs(), DEFAULT_E2E_TIMEOUT_MS);
    delete process.env.QA_E2E_TIMEOUT_MS;
    assert.equal(e2eTimeoutMs(), DEFAULT_E2E_TIMEOUT_MS);
  } finally {
    if (prev === undefined) delete process.env.QA_E2E_TIMEOUT_MS;
    else process.env.QA_E2E_TIMEOUT_MS = prev;
  }
});

test("killTree SIGKILLs a detached child (the helper behind every QA spawn)", async () => {
  // A real, cheap child that would otherwise hang forever — same shape as a wedged runner.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true });
  await new Promise((resolve) => child.once("spawn", resolve));
  const closed = new Promise<NodeJS.Signals | null>((resolve) => child.on("close", (_code, signal) => resolve(signal)));
  killTree(child);
  assert.equal(await closed, "SIGKILL");
});
