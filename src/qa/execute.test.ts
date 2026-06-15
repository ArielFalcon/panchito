import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
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
  matchFailureDumps,
  segmentsAreTail,
  titleSegments,
  readFailureDumps,
  type FailureDump,
} from "./execute";
import { QaCase } from "../types";
import { buildFailureDomLines } from "../pipeline";
import { selectorPresent } from "./selector-check";
import { parseAriaSnapshot } from "./dom-snapshot";

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

  // A "Target page/context/browser closed" failure is NOT runner infra: the app crashing the tab
  // is a real defect the test SHOULD surface. It must stay `fail`, never be hidden as infra-error.
  const tabCrash: QaCase[] = [
    { name: "checkout › completes", status: "fail", detail: "Error: Target page has been closed" },
  ];
  assert.equal(allFailuresAreRunnerInfra(tabCrash), false);
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

// CROSS-BOUNDARY (W6): the temp failureCaptureDir must be removed even when deps.runSuite REJECTS.
// Previously the dir was minted and the runSuite awaited OUTSIDE the cleanup try, so a spawn-error
// reject escaped before the finally's rmSync → the dir leaked. We capture the dir runE2E handed the
// runner, then reject; after the rejection the dir must NOT exist on disk.
test("runE2E removes the temp failureCaptureDir on the runSuite REJECT path (no leak)", async () => {
  const { existsSync } = await import("node:fs");
  let handedDir: string | undefined;
  const deps: ExecuteDeps = {
    runSuite: async (args) => {
      handedDir = args.failureCaptureDir;
      // The dir must exist while the runner holds it (the fixture writes into it).
      assert.ok(handedDir && existsSync(handedDir), "failureCaptureDir should exist while the runner runs");
      throw new Error("Playwright runner crashed: spawn ENOENT");
    },
  };
  await assert.rejects(
    () => runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-leak" }, deps),
    /spawn ENOENT/,
  );
  assert.ok(handedDir, "the runner should have been handed a failureCaptureDir");
  assert.equal(existsSync(handedDir!), false, "the temp failureCaptureDir must be removed on the reject path");
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

// CROSS-BOUNDARY (C1): the errorContext fallback (PW 1.60 expect() failures, no fixture dump) is RAW
// ariaSnapshot YAML (`- role "name"`). It MUST be flattened through parseAriaSnapshot to "role: name"
// — the EXACT shape every consumer expects — or Lever-2, the absent/unique checks and the real-bug
// branch are all inert for expect() failures. This walks the full seam: report errorContext (raw
// YAML) → runE2E harvest → QaCase.failureDom → buildFailureDomLines → selectorPresent finds the role.
test("runE2E flattens a RAW errorContext aria YAML so the Lever-2 seam can read role:name", async () => {
  const rawAriaYaml = [
    "- banner:",
    "  - link \"Home\"",
    "- main:",
    "  - heading \"Find Owners\" [level=1]",
    "  - button \"Add Owner\"",
    "  - table:",
    "    - row \"Name City\"",
  ].join("\n");

  const deps: ExecuteDeps = {
    runSuite: async () => ({
      report: {
        suites: [
          {
            title: "owners.spec.ts",
            specs: [
              {
                title: "lists owners",
                ok: false,
                tests: [
                  {
                    status: "unexpected",
                    results: [{ status: "failed", error: { message: "expect(received).toHaveText(expected) failed" }, errors: [{ errorContext: rawAriaYaml }] }],
                  },
                ],
              },
            ],
          },
        ],
      },
      logs: "ok",
      ran: true,
    }),
  };

  const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-ec" }, deps);
  assert.equal(run.verdict, "fail");
  const failed = run.cases.find((c) => c.name.endsWith("lists owners"));
  assert.ok(failed, "the failing case should be present");

  // The stored failureDom must be the FLATTENED "role: name" form, never the raw "- role \"name\"" YAML.
  assert.ok(failed!.failureDom, "errorContext must have been harvested into failureDom");
  assert.doesNotMatch(failed!.failureDom!, /- button "Add Owner"/, "must NOT store the raw YAML form");
  assert.deepEqual(failed!.failureDom!.split("\n"), parseAriaSnapshot(rawAriaYaml), "failureDom must equal parseAriaSnapshot of the errorContext");

  // The downstream consumers must now find a known role:name (they were inert on raw YAML).
  const lines = buildFailureDomLines(failed!.failureDom);
  assert.ok(lines.includes("button: Add Owner"), `expected flattened 'button: Add Owner' in ${JSON.stringify(lines)}`);
  const present = selectorPresent({ kind: "role", role: "button", name: "Add Owner" }, lines);
  assert.equal(present.present, true, "selectorPresent must locate the button against the flattened tree");
  assert.equal(present.verifiable, true);
});

// CROSS-BOUNDARY (W2): the per-case harvest — the errorContext fallback AND the loud "no grounding"
// WARNING — must run even when failureCaptureDir is UNDEFINED (mkdtempSync failed, e.g. no /tmp space).
// Previously the whole harvest was gated behind failureCaptureDir, so a failed mkdtemp silently
// dropped grounding (violating the never-swallow invariant). We force mkdtempSync to throw by pointing
// TMPDIR at a non-existent path, then assert: (1) the errorContext case still gets failureDom, and
// (2) the no-dump/no-errorContext case still emits the WARNING.
test("W2: errorContext fallback + the no-grounding WARNING still fire when the capture dir can't be minted", async () => {
  const rawAriaYaml = "- main:\n  - button \"Add Owner\"";
  const deps: ExecuteDeps = {
    runSuite: async (args) => {
      // The dir could not be minted, so the runner is handed no capture dir at all.
      assert.equal(args.failureCaptureDir, undefined, "failureCaptureDir must be undefined when mkdtempSync throws");
      return {
        report: {
          suites: [
            {
              title: "owners.spec.ts",
              specs: [
                {
                  title: "has errorContext",
                  ok: false,
                  tests: [{ status: "unexpected", results: [{ status: "failed", error: { message: "expect(received).toHaveText(expected) failed" }, errors: [{ errorContext: rawAriaYaml }] }] }],
                },
                {
                  title: "has nothing",
                  ok: false,
                  tests: [{ status: "unexpected", results: [{ status: "failed", error: { message: "expect(received).toHaveText(expected) failed" } }] }],
                },
              ],
            },
          ],
        },
        logs: "ok",
        ran: true,
      };
    },
  };

  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); };
  const prevTmp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  const bogus = join(tmpdir(), `definitely-missing-${Date.now()}`, "nope");
  process.env.TMPDIR = bogus; process.env.TMP = bogus; process.env.TEMP = bogus;
  let run;
  try {
    run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-w2" }, deps);
  } finally {
    console.warn = realWarn;
    for (const [k, v] of Object.entries(prevTmp)) { if (v === undefined) delete (process.env as Record<string, string | undefined>)[k]; else (process.env as Record<string, string>)[k] = v; }
  }

  assert.equal(run.verdict, "fail");
  // (1) The errorContext fallback still populated failureDom for the first case (needs no temp dir).
  const ec = run.cases.find((c) => c.name.endsWith("has errorContext"));
  assert.ok(ec?.failureDom, "errorContext must still be harvested into failureDom with no capture dir");
  assert.ok(buildFailureDomLines(ec!.failureDom).includes("button: Add Owner"));
  // (2) The case with neither dump nor errorContext still triggers the loud WARNING (never swallowed).
  assert.ok(
    warnings.some((w) => /no failure-point DOM captured/i.test(w) && /has nothing/.test(w)),
    `expected a 'no failure-point DOM captured' WARNING for the empty case; warnings: ${JSON.stringify(warnings)}`,
  );
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

// ── matchFailureDumps (Unit 2 — Task 2.8) ────────────────────────────────────

test("matchFailureDumps: a fan-out spec under flows/ matches its basename-keyed dump", () => {
  // The whole parallel fan-out writes specs to flows/<flow>.spec.ts (specFileForFlow), and
  // Playwright names the file suite with the path RELATIVE to rootDir → the case name carries
  // `flows/checkout.spec.ts`, while the fixture records only the basename `checkout.spec.ts`.
  // The match must accept the basename as the trailing `/<basename>` of a segment.
  const dump: FailureDump = { project: "desktop", file: "checkout.spec.ts", title: "Checkout › applies a discount", retry: 0, yaml: "- button: Pay" };
  const caseName = "desktop › flows/checkout.spec.ts › Checkout › applies a discount";
  assert.equal(matchFailureDumps(caseName, [dump])?.yaml, "- button: Pay");
  // A different file with a confusable basename must NOT match (no loose suffix).
  const wrong = "desktop › flows/add-checkout.spec.ts › Checkout › applies a discount";
  assert.equal(matchFailureDumps(wrong, [dump]), null);
});

// CROSS-BOUNDARY (C3): the fixture keys a dump off `testInfo.titlePath.slice(1).join(" › ")`
// = the describe › test chain (NO file prefix), while the JSON report's case name is
// `file.spec.ts › describe › test` (file IS the top suite). The harvest matches the two
// SEGMENT-WISE: the dump's segments must be a contiguous tail of the case's segments. This
// realistic pairing must match — it is the exact seam that silently produced [] before.
test("matchFailureDumps: report-name (with file prefix) matches the fixture's describe›test title", () => {
  const dumpTitle = "owner registration › create owner"; // what the fixture wrote (titlePath sans project+file)
  const reportName = "owners.spec.ts › owner registration › create owner"; // what the JSON report calls the case
  const dumps: FailureDump[] = [
    { project: "desktop", title: dumpTitle, retry: 0, yaml: "- button \"Submit\"" },
    { project: "desktop", title: "unrelated › other", retry: 0, yaml: "- link \"Home\"" },
  ];
  const match = matchFailureDumps(reportName, dumps);
  assert.ok(match, "the report name should match the fixture's file-prefix-stripped title");
  assert.equal(match!.title, dumpTitle);
  assert.equal(match!.yaml, "- button \"Submit\"");
});

test("matchFailureDumps: prefers the HIGHEST retry within a project (the final attempt's DOM)", () => {
  const title = "my suite › my test";
  const dumps: FailureDump[] = [
    { project: "desktop", title, retry: 0, yaml: "y0" },
    { project: "desktop", title, retry: 2, yaml: "y2" },
    { project: "desktop", title, retry: 1, yaml: "y1" },
  ];
  const match = matchFailureDumps("a.spec.ts › my suite › my test", dumps);
  assert.equal(match!.retry, 2, "the last attempt's dump is the one the next round must fix");
  assert.equal(match!.yaml, "y2");
});

// W1(a): two PROJECT dumps for ONE spec (desktop + mobile run every spec) must NOT clobber — both
// survive into the parsed list and the match is DETERMINISTIC (project name asc), never readdir order.
test("matchFailureDumps: two project dumps for one spec do not clobber and resolve deterministically", () => {
  const title = "owner registration › create owner";
  const caseName = "owners.spec.ts › owner registration › create owner";
  const desktop: FailureDump = { project: "desktop", title, retry: 0, yaml: "- button \"Submit\" [desktop]" };
  const mobile: FailureDump = { project: "mobile", title, retry: 0, yaml: "- button \"Submit\" [mobile]" };
  // Both orderings (readdir is unordered) must yield the SAME pick: project name ascending → desktop.
  assert.equal(matchFailureDumps(caseName, [desktop, mobile])!.project, "desktop");
  assert.equal(matchFailureDumps(caseName, [mobile, desktop])!.project, "desktop");
});

// W1(b): a case "add owner" must NOT match a dump "owner" — the old `slug(case).endsWith(slug(dump))`
// char-suffix cross-matched them; segment-wise EXACT-per-segment matching rejects it.
test("matchFailureDumps: case 'add owner' does NOT match a dump 'owner' (no char-suffix cross-match)", () => {
  const dumps: FailureDump[] = [{ project: "desktop", title: "owner", retry: 0, yaml: "y" }];
  assert.equal(matchFailureDumps("owners.spec.ts › add owner", dumps), null);
  // The exact-segment dump, however, still matches.
  const exact: FailureDump[] = [{ project: "desktop", title: "add owner", retry: 0, yaml: "y" }];
  assert.equal(matchFailureDumps("owners.spec.ts › add owner", exact)!.yaml, "y");
});

// W1(c): two titles whose first 80 chars are identical (the old truncation collision) but whose full
// titles differ must NOT cross-match — segment matching uses the FULL title, never a truncated slug.
test("matchFailureDumps: a long title past 80 chars does not collide with another sharing its prefix", () => {
  const prefix = "suite › " + "x".repeat(90); // > 80 chars before the distinguishing tail
  const titleA = prefix + " ALPHA";
  const titleB = prefix + " BETA";
  const dumps: FailureDump[] = [
    { project: "desktop", title: titleA, retry: 0, yaml: "yA" },
    { project: "desktop", title: titleB, retry: 0, yaml: "yB" },
  ];
  // The case for B must select B's dump, never A's (the 80-char prefix is identical).
  assert.equal(matchFailureDumps("specs.spec.ts › " + titleB, dumps)!.yaml, "yB");
  assert.equal(matchFailureDumps("specs.spec.ts › " + titleA, dumps)!.yaml, "yA");
});

test("matchFailureDumps: returns null when no dump title is a segment-tail of the case", () => {
  const dumps: FailureDump[] = [{ project: "desktop", title: "completely › different", retry: 0 }];
  assert.equal(matchFailureDumps("file.spec.ts › owner › create", dumps), null);
});

test("matchFailureDumps: returns null for an empty dump list", () => {
  assert.equal(matchFailureDumps("any case name", []), null);
});

test("matchFailureDumps: a dump with no title never matches (defensive)", () => {
  const dumps: FailureDump[] = [{ project: "desktop", title: "", retry: 0, yaml: "y" }];
  assert.equal(matchFailureDumps("file.spec.ts › x › y", dumps), null);
});

test("matchFailureDumps: identical title and case name match (no file prefix present)", () => {
  // Some reporters emit a flat name with no file suffix; the single segment is a reflexive tail.
  const dumps: FailureDump[] = [{ project: "desktop", title: "flat test name", retry: 0, yaml: "y" }];
  assert.equal(matchFailureDumps("flat test name", dumps)!.yaml, "y");
});

// segmentsAreTail / titleSegments unit coverage (the new matching core).
test("segmentsAreTail: exact contiguous tail with per-segment equality", () => {
  assert.equal(segmentsAreTail(["a.spec.ts", "suite", "test"], ["suite", "test"]), true);
  assert.equal(segmentsAreTail(["a.spec.ts", "suite", "test"], ["test"]), true);
  assert.equal(segmentsAreTail(["a.spec.ts", "suite", "test"], ["a.spec.ts", "suite", "test"]), true);
  // A NON-tail (middle) match is rejected.
  assert.equal(segmentsAreTail(["a.spec.ts", "suite", "test"], ["suite"]), false);
  // A longer "tail" than the full path is rejected.
  assert.equal(segmentsAreTail(["suite", "test"], ["x", "suite", "test"]), false);
  // Empty tail is rejected.
  assert.equal(segmentsAreTail(["a", "b"], []), false);
  // Partial-character segment ("add owner" vs "owner") is rejected — exact per-segment only.
  assert.equal(segmentsAreTail(["spec", "add owner"], ["owner"]), false);
});


// CROSS-BOUNDARY (W1 FS seam): the fixture's NEW filename `${project}__${hash}__${retry}.json` (hash =
// sha1 of `${file}/${title}`) and body `{ project, file, title, retry, yaml }` must round-trip through
// readFailureDumps, and two projects running the SAME spec must produce TWO distinct files (no clobber).
// This mirrors what the fixture writes at runtime, byte-for-byte in shape.
test("readFailureDumps: two project dumps for one spec are both read (new filename, no clobber)", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-fail-test-"));
  try {
    const title = "owner registration › create owner";
    const file = "owners.spec.ts";
    const hash = createHash("sha1").update(`${file}/${title}`).digest("hex").slice(0, 12);
    // Exactly what the fixture writes: project-prefixed filename + project/file in the body.
    writeFileSync(join(dir, `desktop__${hash}__0.json`), JSON.stringify({ project: "desktop", file, title, retry: 0, yaml: "- button \"Submit\"" }));
    writeFileSync(join(dir, `mobile__${hash}__0.json`), JSON.stringify({ project: "mobile", file, title, retry: 0, yaml: "- button \"Submit\"" }));

    const dumps = readFailureDumps(dir);
    assert.equal(dumps.length, 2, "both project dumps must survive (the old shared filename clobbered one)");
    assert.deepEqual([...new Set(dumps.map((d) => d.project))].sort(), ["desktop", "mobile"]);
    assert.ok(dumps.every((d) => d.file === file && d.title === title && d.yaml === "- button \"Submit\""));

    // And the match is deterministic regardless of readdir order.
    const m = matchFailureDumps("owners.spec.ts › owner registration › create owner", dumps);
    assert.equal(m!.project, "desktop");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// CROSS-BOUNDARY (W1 cross-FILE collision): two tests with the SAME `describe › test` chain in
// DIFFERENT spec files share a `title` — only the recorded `file` tells them apart. Without folding
// the file into the dump identity + the match, the harvest attached the WRONG file's DOM. Here two
// distinct files (owners.spec.ts, vets.spec.ts) carry the identical title but different YAML; each
// report case (whose leading suite IS the file) must select ITS OWN file's dump, never the other's.
test("matchFailureDumps: same title in two different files does NOT collide — the right file's DOM attaches", () => {
  const title = "registration › create entity";
  const ownersDump: FailureDump = { project: "desktop", file: "owners.spec.ts", title, retry: 0, yaml: "- button \"Add Owner\"" };
  const vetsDump: FailureDump = { project: "desktop", file: "vets.spec.ts", title, retry: 0, yaml: "- button \"Add Vet\"" };
  const dumps = [ownersDump, vetsDump];

  const ownersMatch = matchFailureDumps(`owners.spec.ts › ${title}`, dumps);
  assert.ok(ownersMatch, "the owners case must match a dump");
  assert.equal(ownersMatch!.yaml, "- button \"Add Owner\"", "owners.spec.ts must attach the OWNERS dump, not vets");

  const vetsMatch = matchFailureDumps(`vets.spec.ts › ${title}`, dumps);
  assert.ok(vetsMatch, "the vets case must match a dump");
  assert.equal(vetsMatch!.yaml, "- button \"Add Vet\"", "vets.spec.ts must attach the VETS dump, not owners");
});

// W1 round-trip on disk: the two same-titled, different-file dumps must produce two distinct files
// (the file is folded into the hash) and read back with the right file → right DOM per case.
test("readFailureDumps + match: same title, different files round-trip to distinct files and the right DOM", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-fail-xfile-"));
  try {
    const title = "registration › create entity";
    const ownersHash = createHash("sha1").update(`owners.spec.ts/${title}`).digest("hex").slice(0, 12);
    const vetsHash = createHash("sha1").update(`vets.spec.ts/${title}`).digest("hex").slice(0, 12);
    assert.notEqual(ownersHash, vetsHash, "the file must change the hash so the two dumps land in distinct files");
    writeFileSync(join(dir, `desktop__${ownersHash}__0.json`), JSON.stringify({ project: "desktop", file: "owners.spec.ts", title, retry: 0, yaml: "- button \"Add Owner\"" }));
    writeFileSync(join(dir, `desktop__${vetsHash}__0.json`), JSON.stringify({ project: "desktop", file: "vets.spec.ts", title, retry: 0, yaml: "- button \"Add Vet\"" }));

    const dumps = readFailureDumps(dir);
    assert.equal(dumps.length, 2, "both same-titled dumps must survive on disk (distinct filenames)");
    assert.equal(matchFailureDumps(`owners.spec.ts › ${title}`, dumps)!.yaml, "- button \"Add Owner\"");
    assert.equal(matchFailureDumps(`vets.spec.ts › ${title}`, dumps)!.yaml, "- button \"Add Vet\"");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// W1 backward-compat: a dump with NO recorded file (pre-change dump) still matches title-only — the
// file check is skipped when either side lacks a file, so old dumps keep working.
test("matchFailureDumps: a dump with no file still matches a file-prefixed case (title-only fallback)", () => {
  const dumps: FailureDump[] = [{ project: "desktop", title: "suite › test", retry: 0, yaml: "y" }];
  assert.equal(matchFailureDumps("legacy.spec.ts › suite › test", dumps)!.yaml, "y");
});

// CROSS-BOUNDARY (C1): the seed playwright.config defines TWO projects (desktop, mobile) and the
// pipeline runs the suite with NO --project, so Playwright nests every spec under the PROJECT
// top-suite → the report case name is `desktop › owners.spec.ts › Owners › add owner` (PROJECT leads,
// FILE is the SECOND segment). The Round-3 file discriminator assumed file = caseSegs[0] (= "desktop")
// and rejected the dump whose file = "owners.spec.ts" → it dropped EVERY dump under the default config.
// The fix matches the dump's file against ANY case segment. The dump's title may be the bare
// describe›test (fixture form) OR include the file — both are a contiguous tail, both must match.
test("matchFailureDumps: PROJECT-FIRST case name (two-project default config) matches the file dump (C1)", () => {
  const projectFirst = "desktop › owners.spec.ts › Owners › add owner"; // project is caseSegs[0], file is caseSegs[1]
  // Fixture-form title (describe › test, no file prefix).
  const bareTitle: FailureDump[] = [{ project: "desktop", file: "owners.spec.ts", title: "Owners › add owner", retry: 0, yaml: "- button \"Submit\"" }];
  const m1 = matchFailureDumps(projectFirst, bareTitle);
  assert.ok(m1, "the dump must MATCH a project-first case name (file is not the leading segment)");
  assert.equal(m1!.yaml, "- button \"Submit\"");
  // File-prefixed title form must also match (still a contiguous tail of the case segments).
  const fileTitle: FailureDump[] = [{ project: "desktop", file: "owners.spec.ts", title: "owners.spec.ts › Owners › add owner", retry: 0, yaml: "- button \"Add\"" }];
  assert.equal(matchFailureDumps(projectFirst, fileTitle)!.yaml, "- button \"Add\"");
  // A WRONG file must still be rejected even though the project segment is present (no cross-file attach).
  const wrongFile: FailureDump[] = [{ project: "desktop", file: "vets.spec.ts", title: "Owners › add owner", retry: 0, yaml: "y" }];
  assert.equal(matchFailureDumps(projectFirst, wrongFile), null, "a dump for a different file must not match");
});

// C1 single-project: the SAME helper must keep working when the suite IS run with --project (file leads,
// no project segment) — the case name is `owners.spec.ts › Owners › add owner`. file === caseSegs[0] here.
test("matchFailureDumps: single-project case name (file leads) still matches the file dump", () => {
  const fileFirst = "owners.spec.ts › Owners › add owner";
  const dumps: FailureDump[] = [{ project: "desktop", file: "owners.spec.ts", title: "Owners › add owner", retry: 0, yaml: "- button \"Submit\"" }];
  assert.equal(matchFailureDumps(fileFirst, dumps)!.yaml, "- button \"Submit\"");
});

test("killTree SIGKILLs a detached child (the helper behind every QA spawn)", async () => {
  // A real, cheap child that would otherwise hang forever — same shape as a wedged runner.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true });
  await new Promise((resolve) => child.once("spawn", resolve));
  const closed = new Promise<NodeJS.Signals | null>((resolve) => child.on("close", (_code, signal) => resolve(signal)));
  killTree(child);
  assert.equal(await closed, "SIGKILL");
});
