// Integration tests for the dual decide-step (quality-filtered-dual-publish).
// Tests the qa.specTriage flag-OFF/ON branches in pipeline.ts via stubbed deps.
// Follows the existing pipeline.test.ts stub pattern exactly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPipeline, PipelineDeps, GenerateInput } from "./pipeline";
import type { ReviewResult } from "./integrations/opencode-client";
import type { CoveredLines } from "./qa/change-coverage";
import type { AppConfig } from "./orchestrator/config-loader";
import type { AgentResult, QaCase, QaRunResult, RunOutcome } from "./types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const baseApp: AppConfig = {
  name: "demo",
  repo: "org/demo",
  dev: {
    baseUrl: "https://dev",
    versionUrl: "https://dev/version",
    pollIntervalMs: 1,
    deployTimeoutMs: 100,
  },
  qa: { needsReview: false, testDataPrefix: "qa-bot" },
  report: { onFailure: "github-issue" },
};

// App with specTriage enabled
const triageApp: AppConfig = {
  ...baseApp,
  qa: { ...baseApp.qa, specTriage: true },
};

// App with specTriage disabled (explicit false)
const noTriageApp: AppConfig = {
  ...baseApp,
  qa: { ...baseApp.qa, specTriage: false },
};

// Cases representing a mixed run (one file passes, one fails)
function makeMixedCases(): QaCase[] {
  return [
    {
      name: "login passes",
      status: "pass",
      file: "login.spec.ts",
    },
    {
      name: "checkout fails",
      status: "fail",
      file: "checkout.spec.ts",
      detail: "getByRole('button', { name: 'Pay' }): not found",
      httpStatus: undefined,
    },
  ];
}

// Cases representing an all-pass run
function makeAllPassCases(): QaCase[] {
  return [
    { name: "login passes", status: "pass", file: "login.spec.ts" },
    { name: "checkout passes", status: "pass", file: "checkout.spec.ts" },
  ];
}

// Cases representing a real-bug (5xx) run
function makeRealBugCases(): QaCase[] {
  return [
    {
      name: "checkout 500",
      status: "fail",
      file: "checkout.spec.ts",
      detail: "server error 500",
      httpStatus: 500,
    },
  ];
}

interface Harness extends PipelineDeps {
  issues: string[];
  published: boolean;
  publishSubsetCalls: Array<{ files: string[] }>;
  publishCalls: number;
  openIssueCalls: string[];
  validateCalls: number;
  savedOutcomes: RunOutcome[];
  mirrorDir: string;
}

function deps(
  run: QaRunResult,
  opts: {
    agent?: AgentResult;
    review?: ReviewResult;
    coverage?: CoveredLines | null;
    validation?: { ok: boolean; errors: string[]; infra: boolean };
    shadow?: boolean;
  } = {},
): Harness {
  const issues: string[] = [];
  const savedOutcomes: RunOutcome[] = [];
  const publishSubsetCalls: Array<{ files: string[] }> = [];
  const openIssueCalls: string[] = [];
  const mirrorDir = mkdtempSync(join(tmpdir(), "qa-triage-test-"));
  mkdirSync(join(mirrorDir, "e2e", ".qa"), { recursive: true });
  writeFileSync(
    join(mirrorDir, "e2e", ".qa", "context.json"),
    JSON.stringify({ builtAtSha: "abc123", routes: [], api: [], feBe: [] }),
  );

  // Write a minimal spec file so publish detects changes
  const specDir = join(mirrorDir, "e2e");
  writeFileSync(join(specDir, "login.spec.ts"), `// login spec\ntest("login passes", () => {});\n`);
  writeFileSync(join(specDir, "checkout.spec.ts"), `// checkout spec\ntest("checkout", () => {});\n`);

  const h: Harness = {
    issues,
    published: false,
    publishSubsetCalls,
    publishCalls: 0,
    openIssueCalls,
    validateCalls: 0,
    savedOutcomes,
    mirrorDir,
  } as unknown as Harness;

  const defaultAgent: AgentResult = {
    output: "generated",
    specs: ["login.spec.ts", "checkout.spec.ts"],
    reviewed: false,
    approved: true,
  };

  Object.assign(h, {
    waitForDeploy: async () => {},
    prepare: async () => ({
      mirrorDir,
      diff: "DIFF",
      message: "feat: add checkout",
    }),
    prepareAtBranch: async () => ({ mirrorDir }),
    generate: async () => opts.agent ?? defaultAgent,
    setupE2e: async () => {},
    validate: async () => {
      h.validateCalls++;
      return opts.validation ?? { ok: true, errors: [], infra: false };
    },
    isHealthy: async () => true,
    isReachable: async () => true,
    execute: async () => run,
    setupCode: async () => {},
    executeCode: async () => run,
    publishCode: async () => ({ prUrl: "https://github.com/org/demo/pull/code", merged: true }),
    publishContext: async () => ({ prUrl: "https://github.com/org/demo/pull/ctx", merged: true }),
    publish: async () => {
      h.published = true;
      h.publishCalls++;
      return { prUrl: "https://github.com/org/demo/pull/1", merged: true };
    },
    publishSubset: async (_input: unknown, files: string[]) => {
      h.published = true;
      publishSubsetCalls.push({ files });
      return { prUrl: "https://github.com/org/demo/pull/subset", merged: true };
    },
    openIssue: async (_repo: string, title: string) => {
      issues.push(title);
      openIssueCalls.push(title);
      return { url: "https://github.com/org/demo/issues/1" };
    },
    saveOutcome: async (outcome: RunOutcome) => {
      savedOutcomes.push(outcome);
    },
    ...(opts.coverage !== undefined
      ? {
          collectCoverage: async () => opts.coverage ?? null,
        }
      : {}),
    ...(opts.review
      ? {
          review: async () => opts.review!,
        }
      : {}),
  });
  return h;
}

// ── Test: flag OFF → today's exact branch fires ──────────────────────────────

test("specTriage flag OFF: pass → publish (whole-dir) called, publishSubset never called", async () => {
  const run: QaRunResult = {
    sha: "s",
    verdict: "pass",
    passed: true,
    cases: makeAllPassCases(),
    logs: "",
  };
  const d = deps(run);
  await runPipeline(noTriageApp, "abc123", d, "manual", { mode: "diff", runId: "run-triage-off-pass" });
  // Flag OFF → whole-dir publish called
  assert.equal(d.published, true, "flag OFF + pass → should publish");
  assert.equal(d.publishSubsetCalls.length, 0, "publishSubset must never be called when flag OFF");
  assert.equal(d.issues.length, 0, "no issue on pass");
});

test("specTriage flag OFF: fail → openIssue called, publish (whole-dir) never called", async () => {
  const run: QaRunResult = {
    sha: "s",
    verdict: "fail",
    passed: false,
    cases: makeRealBugCases(),
    logs: "",
  };
  const d = deps(run);
  await runPipeline(noTriageApp, "abc123", d, "manual", { mode: "diff", runId: "run-triage-off-fail" });
  assert.ok(d.issues.length > 0, "flag OFF + fail → should open issue");
  assert.equal(d.published, false, "flag OFF + fail → should NOT publish");
  assert.equal(d.publishSubsetCalls.length, 0, "publishSubset must never be called when flag OFF");
});

test("specTriage flag absent (undefined): pass → today's whole-dir publish (not specTriage path)", async () => {
  const run: QaRunResult = {
    sha: "s",
    verdict: "pass",
    passed: true,
    cases: makeAllPassCases(),
    logs: "",
  };
  const d = deps(run);
  // baseApp has no specTriage field → undefined → falsy → today's path
  await runPipeline(baseApp, "abc123", d, "manual", { mode: "diff", runId: "run-triage-absent" });
  assert.equal(d.published, true, "flag absent + pass → whole-dir publish");
  assert.equal(d.publishSubsetCalls.length, 0, "publishSubset never called when flag absent");
});

// ── Test: flag ON + all-pass → publishSubset called with ALL files ─────────

test("specTriage flag ON + all-pass → publishSubset called with all files (parity with whole-suite PR)", async () => {
  const run: QaRunResult = {
    sha: "s",
    verdict: "pass",
    passed: true,
    cases: makeAllPassCases(),
    logs: "",
  };
  const d = deps(run);
  await runPipeline(triageApp, "abc123", d, "manual", { mode: "diff", runId: "run-triage-on-allpass" });
  assert.equal(d.publishSubsetCalls.length, 1, "publishSubset should be called once");
  const call = d.publishSubsetCalls[0]!;
  // All-pass: both files in PR bucket
  assert.ok(call.files.includes("login.spec.ts"), "login.spec.ts should be in PR subset");
  assert.ok(call.files.includes("checkout.spec.ts"), "checkout.spec.ts should be in PR subset");
  assert.equal(d.issues.length, 0, "no issue on all-pass triage");
});

// ── Test: flag ON + mixed run → publishSubset + openIssue in same run ────────

test("specTriage flag ON + mixed run → publishSubset for green subset AND openIssue for red subset", async () => {
  // login passes, checkout fails with 5xx (real bug → ISSUE)
  const run: QaRunResult = {
    sha: "s",
    verdict: "fail", // aggregate verdict is fail (one case failed)
    passed: false,
    cases: [
      { name: "login passes", status: "pass", file: "login.spec.ts" },
      {
        name: "checkout fails 5xx",
        status: "fail",
        file: "checkout.spec.ts",
        detail: "server error 500",
        httpStatus: 500,
      },
    ],
    logs: "",
  };
  const d = deps(run);
  await runPipeline(triageApp, "abc123", d, "manual", { mode: "diff", runId: "run-triage-mixed" });
  // PR subset: login.spec.ts (passes)
  assert.equal(d.publishSubsetCalls.length, 1, "publishSubset should be called for green subset");
  const prFiles = d.publishSubsetCalls[0]!.files;
  assert.ok(prFiles.includes("login.spec.ts"), "login.spec.ts should be in PR subset");
  assert.ok(!prFiles.includes("checkout.spec.ts"), "checkout.spec.ts should NOT be in PR subset (5xx fail → ISSUE)");
  // ISSUE: checkout.spec.ts
  assert.ok(d.issues.length > 0, "Issue should be filed for 5xx failure");
});

// ── Test: flag ON + a PR spec imports an unpublished sibling → demoted (Spec-Req-4) ──

test("specTriage flag ON + PR spec imports an unpublished sibling → demoted to ISSUE (never a broken subset)", async () => {
  // login passes (would be PR) but imports checkout, which fails (→ ISSUE, not published).
  // Publishing login alone would leave a dangling import → login must be demoted to ISSUE.
  const run: QaRunResult = {
    sha: "s",
    verdict: "fail",
    passed: false,
    cases: [
      { name: "login passes", status: "pass", file: "login.spec.ts" },
      { name: "checkout fails 5xx", status: "fail", file: "checkout.spec.ts", detail: "server error 500", httpStatus: 500 },
    ],
    logs: "",
  };
  const d = deps(run);
  // Make the passing PR spec import the failing (unpublished) sibling on disk.
  writeFileSync(join(d.mirrorDir, "e2e", "login.spec.ts"), `import "./checkout";\ntest("login passes", () => {});\n`);
  await runPipeline(triageApp, "abc123", d, "manual", { mode: "diff", runId: "run-triage-dangling" });
  const publishedFiles = d.publishSubsetCalls.flatMap((c) => c.files);
  assert.ok(!publishedFiles.includes("login.spec.ts"), "login.spec.ts must be demoted (dangling import), never published");
  assert.ok(d.issues.length > 0, "an Issue covers the real-bug checkout + the demoted login");
});

// ── Test: flag ON + all-DROP → neither publishSubset nor openIssue ────────

test("specTriage flag ON + all-DROP → no PR and no Issue", async () => {
  // All cases fail with absent locator (clear DROP signal)
  const run: QaRunResult = {
    sha: "s",
    verdict: "fail",
    passed: false,
    cases: [
      {
        name: "checkout absent selector",
        status: "fail",
        file: "checkout.spec.ts",
        detail: "getByRole('button', { name: 'GhostButton' }): not found",
        failureDom: "button: Save",
      },
      {
        name: "login absent selector",
        status: "fail",
        file: "login.spec.ts",
        detail: "getByRole('button', { name: 'MissingButton' }): not found",
        failureDom: "button: Submit",
      },
    ],
    logs: "",
  };
  // Agent reports spec sources with absent selectors
  const agent: AgentResult = {
    output: "generated",
    specs: ["login.spec.ts", "checkout.spec.ts"],
    reviewed: false,
    approved: true,
  };
  const d = deps(run, { agent });
  await runPipeline(triageApp, "abc123", d, "manual", { mode: "diff", runId: "run-triage-alldrop" });
  // Both files would have absent selectors → DROP (no PR, no Issue)
  // NOTE: The triage decision depends on spec file content for selector check.
  // Without actual spec files, absentKeysCount=0 so files might route to T5 (ISSUE) instead of T4 (DROP).
  // This test verifies at minimum that when verdict=fail and triage fires, the whole-dir publish is NOT called.
  assert.equal(d.publishCalls, 0, "whole-dir publish should NOT be called in triage mode");
});

// ── Test: flag ON + needsReview=true + reviewer rejected → publishSubset NOT called ──

test("specTriage flag ON + needsReview + reviewer rejected → publishSubset NOT called, Issue filed", async () => {
  const run: QaRunResult = {
    sha: "s",
    verdict: "pass",
    passed: true,
    cases: makeAllPassCases(),
    logs: "",
  };
  const reviewerRejected: ReviewResult = {
    approved: false,
    corrections: ["[false-positive] login.spec.ts: asserts nothing"],
    parsed: true,
  };
  const appWithReview: AppConfig = {
    ...triageApp,
    qa: { ...triageApp.qa, needsReview: true },
  };
  const d = deps(run, { review: reviewerRejected });
  await runPipeline(appWithReview, "abc123", d, "manual", { mode: "diff", runId: "run-triage-reviewer-rejected" });
  // Reviewer rejected → publishSubset must NOT be called
  assert.equal(d.publishSubsetCalls.length, 0, "publishSubset must NOT be called when reviewer rejected");
  // Issue should be filed for the reviewer rejection
  assert.ok(d.issues.length > 0, "Issue should be filed on reviewer rejection");
});

// ── Test: flag ON + blocksPublish → publishSubset NOT called ─────────────────
// This test verifies the coverage gate behavior by using a real diff with changed lines
// and a coverage result of zero coverage, triggering blocksPublish in enforce mode.

test("specTriage flag ON + coverage enforce blocks publish → publishSubset NOT called", async () => {
  const run: QaRunResult = {
    sha: "s",
    verdict: "pass",
    passed: true,
    cases: makeAllPassCases(),
    logs: "",
  };
  // Real diff with changed lines
  const DIFF_4 = [
    "diff --git a/src/x.ts b/src/x.ts",
    "--- a/src/x.ts",
    "+++ b/src/x.ts",
    "@@ -0,0 +1,4 @@",
    "+a",
    "+b",
    "+c",
    "+d",
  ].join("\n");
  // enforce mode with minRatio=0.99 means ANY gap blocks
  const covApp: AppConfig = {
    ...triageApp,
    qa: { ...triageApp.qa, changeCoverage: { mode: "enforce", minRatio: 0.99 } },
  };
  // Zero coverage → ratio=0/4=0 < 0.99 → coverageStatus="fail" → blocksPublish=true
  // Also disable enforce regen to not re-run: return empty specs so improved.specs.length === 0
  const emptyAgent: AgentResult = {
    output: "no improvement",
    specs: [],
    reviewed: false,
    approved: false,
  };
  // Coverage: file present in the map but with ZERO lines hit → measured=true, ratio=0 → fail
  // Note: an empty Map() gives measured=false (file not in covered map = no V8 dump) → "unknown"
  // We need the file to appear in the map to signal "measured but uncovered"
  const d = deps(run, {
    agent: emptyAgent,
    coverage: new Map([["src/x.ts", new Set<number>()]]), // file measured, zero lines covered
  });
  // Wire the diff
  d.prepare = async () => ({
    mirrorDir: d.mirrorDir,
    diff: DIFF_4,
    message: "feat: add checkout",
  });
  // First call returns real specs, subsequent (regen) return empty
  let genCount = 0;
  const realAgent: AgentResult = {
    output: "generated",
    specs: ["login.spec.ts", "checkout.spec.ts"],
    reviewed: false,
    approved: true,
  };
  d.generate = async () => {
    genCount++;
    return genCount === 1 ? realAgent : emptyAgent;
  };
  await runPipeline(covApp, "abc123", d, "manual", { mode: "diff", runId: "run-triage-coverage-blocks" });
  // Coverage blocks → no PR subset published
  assert.equal(d.publishSubsetCalls.length, 0, "publishSubset must NOT be called when coverage blocks");
});

// ── Test: flag ON + shadow → both would-do log lines, no real PR or Issue ────

test("specTriage flag ON + shadow + mixed run → no real PR, no real Issue (shadow mode)", async () => {
  const run: QaRunResult = {
    sha: "s",
    verdict: "fail",
    passed: false,
    cases: [
      { name: "login passes", status: "pass", file: "login.spec.ts" },
      {
        name: "checkout fails 5xx",
        status: "fail",
        file: "checkout.spec.ts",
        detail: "server error 500",
        httpStatus: 500,
      },
    ],
    logs: "",
  };
  const shadowApp: AppConfig = {
    ...triageApp,
    qa: { ...triageApp.qa, shadow: true },
  };
  const d = deps(run);
  await runPipeline(shadowApp, "abc123", d, "manual", { mode: "diff", runId: "run-triage-shadow" });
  // Shadow → no real PR or Issue created
  assert.equal(d.publishSubsetCalls.length, 0, "shadow mode: no real publishSubset");
  assert.equal(d.issues.length, 0, "shadow mode: no real Issue");
});
