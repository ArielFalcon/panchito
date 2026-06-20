import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPipeline, PipelineDeps, GenerateInput, buildFailureDom, buildFailureDomLines, deriveCycleBackstop, shouldDistillLearning } from "./pipeline";
import { parseAriaSnapshot } from "./qa/dom-snapshot";
import { ReviewResult } from "./integrations/opencode-client";
import { CoveredLines } from "./qa/change-coverage";
import { AppConfig } from "./orchestrator/config-loader";
import { AgentResult, QaCase, QaRunResult, RunMode, RunOutcome } from "./types";
import type { OracleInput, ValueOracleResult } from "./qa/learning/oracle-types";
import type { RetrievalResult } from "./qa/learning/retrieval";

// ── Phase-timings type-level compile checks ────────────────────────────────────
// These tests are compile-time assertions: if the types are wrong the file fails tsc.

// 1.1 — phaseTimings is accepted as Record<string, number> | undefined on gateSignals
test("phase-timings: phaseTimings compiles as optional Record<string,number> on gateSignals", () => {
  const outcome: RunOutcome = {
    runId: "r",
    app: "demo",
    sha: "abc",
    mode: "diff",
    target: "e2e",
    verdict: "pass",
    errorClass: null,
    gateSignals: {
      static: true,
      coverageRatio: null,
      valueScore: null,
      reviewerCorrections: [],
      flaky: false,
      retries: 0,
      phaseTimings: { generator: 1000, reviewer: 500 },
    },
    rulesRetrieved: [],
    at: new Date().toISOString(),
  };
  assert.equal(typeof outcome.gateSignals.phaseTimings, "object");

  // Also verify undefined is accepted (optional)
  const outcomeNoTimings: RunOutcome = {
    ...outcome,
    gateSignals: { ...outcome.gateSignals, phaseTimings: undefined },
  };
  assert.equal(outcomeNoTimings.gateSignals.phaseTimings, undefined);
});

// 1.3 — wallClockBudgetMs is accepted as a positive integer or undefined on qa config
test("phase-timings: wallClockBudgetMs compiles as optional positive integer on qa config", () => {
  const withBudget: AppConfig = {
    ...app,
    qa: { ...app.qa, wallClockBudgetMs: 60_000 },
  };
  assert.equal(withBudget.qa.wallClockBudgetMs, 60_000);

  const noBudget: AppConfig = {
    ...app,
    qa: { ...app.qa, wallClockBudgetMs: undefined },
  };
  assert.equal(noBudget.qa.wallClockBudgetMs, undefined);
});

// 2.1 — phaseTimings is populated on a normal green run (at least generator + reviewer keys present)
test("phase-timings: phaseTimings is a non-null object with generator and reviewer keys on a green run", async () => {
  const calls: string[] = [];
  const d = deps({ sha: "s", verdict: "pass", passed: true, cases: [], logs: "" }, calls, {
    review: [{ approved: true, corrections: [], parsed: true }],
  });
  await runPipeline(app, "abc123", d, "manual", { mode: "diff", runId: "run-phase-timings-1" });
  assert.ok(d.savedOutcomes.length > 0, "outcome must be saved");
  const outcome = d.savedOutcomes[0]!;
  assert.ok(outcome.gateSignals.phaseTimings !== null && outcome.gateSignals.phaseTimings !== undefined, "phaseTimings must be present");
  assert.ok(typeof outcome.gateSignals.phaseTimings!["generator"] === "number", "generator timing must be a number");
  assert.ok(typeof outcome.gateSignals.phaseTimings!["reviewer"] === "number", "reviewer timing must be a number");
});

// ── Wall-clock ceiling tests (LOAD-BEARING SAFETY) ────────────────────────────

// 3.1 Test A — ceiling stops new generation (DETERMINISTIC via injected clock).
// Strategy: inject a `nowMs` sequence so the FIRST generateOnce call sees elapsed UNDER budget
// (clock returns runStart + 0 on the guard check), then every subsequent call sees elapsed OVER
// budget. The first generate SUCCEEDS (returns specs); execute fails so the fix-loop tries up to
// 3 more generates — the guard fires on every retry because the clock is now PAST the budget.
// Changing failing names (t, u, v, w) keep the progress gate allowing spend (signal B) so the
// wall-clock guard is the ONLY thing that can stop the loop. Without the guard generateCallCount
// would be 4 (1 initial + 3 retries); with the guard it must be exactly 1.
// This test is MACHINE-SPEED INDEPENDENT: the clock is fully controlled, no real Date.now() used.
test("wall-clock ceiling: stops starting new generation after budget is exhausted (Test A)", async () => {
  const calls: string[] = [];
  let generateCallCount = 0;
  // Budget of 1000ms — injected clock will report 0ms elapsed on first call and 2000ms on subsequent.
  const budgetMs = 1_000;
  const twoRetryApp: AppConfig = {
    ...app,
    qa: { ...app.qa, needsReview: false, fixLoop: { maxRetries: 3 }, wallClockBudgetMs: budgetMs },
  };
  const failRun: QaRunResult = { sha: "s", verdict: "fail", passed: false, cases: [{ name: "t", status: "fail" }], logs: "" };
  const d = deps(failRun, calls, {});

  // Injected clock: first invocation is runStart; second is runStart+0 (under budget at first guard
  // check); third+ return runStart+2000 (over budget, guard fires and blocks further generation).
  // The injected sequence: [t0, t0, t0+2000, t0+2000, ...] — more values than needed so the clock
  // never runs dry regardless of how many times now() is called.
  const t0 = 1_000_000; // arbitrary epoch anchor; only deltas matter
  const clockSeq = [t0, t0, t0 + 2_000, t0 + 2_000, t0 + 2_000, t0 + 2_000, t0 + 2_000, t0 + 2_000];
  let clockIdx = 0;
  d.nowMs = () => clockSeq[clockIdx++ % clockSeq.length]!;

  // Changing failing names keep the progress gate allowing spend on every retry.
  let execCall = 0;
  const changingNames = [["t"], ["u"], ["v"], ["w"]];
  d.execute = async () => {
    calls.push("execute");
    const ns = changingNames[execCall++ % changingNames.length]!;
    return { sha: "s", verdict: "fail", passed: false, cases: ns.map((n) => ({ name: n, status: "fail" as const })), logs: "" };
  };
  const originalGenerate = d.generate;
  d.generate = async (input) => {
    generateCallCount++;
    return originalGenerate(input);
  };

  const result = await runPipeline(twoRetryApp, "abc123", d, "manual", { mode: "diff", runId: "run-ceiling-a" });

  // Must complete without crashing.
  assert.ok(result, "pipeline must return a result (not crash)");
  // Guard fires on every retry generate (clock is over budget after the first guard check).
  // generateCallCount must be exactly 1 (initial generate succeeded; all retries blocked).
  assert.equal(generateCallCount, 1, `ceiling must block all retry generates; got generateCallCount=${generateCallCount} (expected 1)`);
  // No publish: run stayed fail, no approved green specs.
  assert.equal(d.published, false, "must NOT publish when ceiling stops all retry generates");
});

// "A green-in-progress run is NEVER discarded by the ceiling" is a STRUCTURAL guarantee, not a
// behavior we can cleanly stub. The ceiling guard fires only at a generation ENTRY and returns an
// empty/unapproved result (specs:[], approved:false); every caller rejects that — e.g. the
// coverage-enforce block guards `if (improved.specs.length > 0 && improved.approved)` before
// replacing the run — so an already-green run object is left untouched, and the guard never sits
// where it could abort an in-flight execute/review. A behavioral "ceiling fires AFTER green" test
// would need enforce-mode + a deadline crossing mid-enforce; with the timing accumulator and the
// guard sharing one injected clock that is fragile to wrap-point count, so we rely on the structural
// guard above + Test A (which proves the guard's STOP behavior non-vacuously — it fails if the guard
// is removed). This test is the backward-compat smoke: the phase-timing accumulator + ceiling
// machinery must not break a normal green publish.
test("phase-timings: a normal green run still publishes with the timing + ceiling machinery active", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, { diff: DIFF_4, coverage: [cov([1, 2, 3, 4])] });
  await runPipeline(covApp("signal"), "abc123", d, "manual", { mode: "diff", runId: "run-ceiling-b" });
  assert.equal(d.published, true, "phase-timing instrumentation must not break a normal green publish");
});

// 3.4 — wallClockBudgetMs=1 config override terminates cleanly (no generation started beyond initial)
test("wall-clock ceiling: qa.wallClockBudgetMs=1 override terminates cleanly with no crash", async () => {
  const calls: string[] = [];
  const zeroApp: AppConfig = {
    ...app,
    qa: { ...app.qa, needsReview: false, fixLoop: { maxRetries: 3 }, wallClockBudgetMs: 1 },
  };
  const failRun: QaRunResult = { sha: "s", verdict: "fail", passed: false, cases: [{ name: "t", status: "fail" }], logs: "" };
  const d = deps(failRun, calls, {});
  const result = await runPipeline(zeroApp, "abc123", d, "manual", { mode: "diff", runId: "run-ceiling-34" });
  // Must complete without throwing
  assert.ok(result, "pipeline must return a result with budget=1ms");
  // No publish (ceiling fires on retries at latest, no approved green)
  assert.equal(d.published, false, "must NOT publish on ceiling with budget=1ms");
});

// ── Phase-timings backward-compat tests (task 4.2) ────────────────────────────
// Assert that early-return paths (infra-error, invalid, skipped) still produce valid RunOutcome
// and do NOT crash after phaseTimings threading. These are the 8 persistOutcome call sites.

test("phase-timings backward-compat: infra-error (DEV unhealthy) produces valid RunOutcome", async () => {
  const calls: string[] = [];
  const d = deps({ sha: "s", verdict: "pass", passed: true, cases: [], logs: "" }, calls, {
    healthy: false, // DEV always unhealthy → infra-error at health pre-flight
  });
  const result = await runPipeline(app, "abc123", d, "manual", { mode: "diff", runId: "run-compat-infra" });
  assert.ok(result, "must return a result");
  assert.equal(result.verdict, "infra-error", "must be infra-error");
  // Outcome must be saved and not crash
  assert.ok(d.savedOutcomes.length > 0, "outcome must be persisted");
  const outcome = d.savedOutcomes[0]!;
  // phaseTimings is optional — may be {} if no wraps fired before this exit, but must not throw
  assert.ok(outcome.gateSignals, "gateSignals must exist");
  assert.equal(typeof (outcome.gateSignals.phaseTimings ?? {}), "object", "phaseTimings must be object or undefined");
});

test("phase-timings backward-compat: invalid (static gate fails) produces valid RunOutcome", async () => {
  const calls: string[] = [];
  const d = deps({ sha: "s", verdict: "pass", passed: true, cases: [], logs: "" }, calls, {
    validation: { ok: false, errors: ["TS error"], infra: false },
  });
  const result = await runPipeline(app, "abc123", d, "manual", { mode: "diff", runId: "run-compat-invalid" });
  assert.equal(result.verdict, "invalid", "must be invalid");
  assert.ok(d.savedOutcomes.length > 0, "outcome must be persisted");
  const outcome = d.savedOutcomes[0]!;
  assert.ok(outcome.gateSignals, "gateSignals must exist");
  assert.equal(typeof (outcome.gateSignals.phaseTimings ?? {}), "object", "phaseTimings must be object or undefined");
});

test("phase-timings backward-compat: agent no-op skip produces valid RunOutcome", async () => {
  const calls: string[] = [];
  // Agent approves but writes no specs → no-op skip
  const d = deps({ sha: "s", verdict: "pass", passed: true, cases: [], logs: "" }, calls, {
    agent: { output: "no tests needed", specs: [], reviewed: true, approved: true },
  });
  const result = await runPipeline(app, "abc123", d, "manual", { mode: "diff", runId: "run-compat-noop" });
  assert.equal(result.verdict, "skipped", "must be skipped");
  assert.ok(d.savedOutcomes.length > 0, "outcome must be persisted");
  const outcome = d.savedOutcomes[0]!;
  assert.ok(outcome.gateSignals, "gateSignals must exist");
  assert.equal(typeof (outcome.gateSignals.phaseTimings ?? {}), "object", "phaseTimings must be object or undefined");
});

// A unified diff with one file and 4 added lines (1-4), so parseDiffHunks yields changed lines.
const DIFF_4 = ["diff --git a/src/x.ts b/src/x.ts", "+++ b/src/x.ts", "@@ -0,0 +1,4 @@", "+a", "+b", "+c", "+d"].join("\n");
const cov = (lines: number[]): CoveredLines => new Map([["src/x.ts", new Set(lines)]]);

const app: AppConfig = {
  name: "demo",
  repo: "org/demo",
  dev: {
    baseUrl: "https://dev",
    versionUrl: "https://dev/version",
    pollIntervalMs: 1,
    deployTimeoutMs: 100,
  },
  qa: { needsReview: true, testDataPrefix: "qa-bot" },
  report: { onFailure: "github-issue" },
};

const generated: AgentResult = {
  output: "spec",
  specs: ["a.spec.ts"],
  reviewed: true,
  approved: true,
};

interface Harness extends PipelineDeps {
  issues: string[];
  published: boolean;
  genMode?: RunMode;
  genGuidance?: string;
  genInputs: GenerateInput[];
  savedOutcomes: RunOutcome[];
  oracleCalls: OracleInput[];
  mirrorDir: string; // the working-copy dir prepare() returns (e2e/ lives under it)
}

function deps(
  run: QaRunResult,
  calls: string[],
  opts: {
    validation?: { ok: boolean; errors: string[]; infra: boolean };
    prUrl?: string | null;
    agent?: AgentResult;
    agents?: AgentResult[]; // a sequence of agent results, one per generate() call
    review?: ReviewResult[]; // a sequence of independent-review verdicts, one per review() call
    healthy?: boolean | boolean[]; // a single value, or a sequence per call
    message?: string; // commit message (classification)
    diff?: string;
    coverage?: Array<CoveredLines | null>; // a sequence of collectCoverage results, one per call
    codeValidation?: { ok: boolean; errors: string[]; infra: boolean } | Array<{ ok: boolean; errors: string[]; infra: boolean }>;
    context?: "valid" | "missing";
  } = {},
): Harness {
  const issues: string[] = [];
  const savedOutcomes: RunOutcome[] = [];
  const oracleCalls: OracleInput[] = [];
  const mirrorDir = mkdtempSync(join(tmpdir(), "qa-pipeline-"));
  if (opts.context !== "missing") {
    mkdirSync(join(mirrorDir, "e2e", ".qa"), { recursive: true });
    writeFileSync(join(mirrorDir, "e2e", ".qa", "context.json"), JSON.stringify({ builtAtSha: "abc123", routes: [], api: [], feBe: [] }));
  }
  const h = { issues, published: false, genInputs: [], savedOutcomes, oracleCalls, mirrorDir } as unknown as Harness;
  const healthSeq = Array.isArray(opts.healthy) ? [...opts.healthy] : null;
  const agentSeq = opts.agents ? [...opts.agents] : null;
  const reviewSeq = opts.review ? [...opts.review] : null;
  const covSeq = opts.coverage ? [...opts.coverage] : null;
  const codeValSeq = Array.isArray(opts.codeValidation) ? [...opts.codeValidation] : null;
  Object.assign(h, {
    waitForDeploy: async () => {
      calls.push("gate");
    },
    prepare: async () => {
      calls.push("prepare");
      return { mirrorDir, diff: opts.diff ?? "DIFF", message: opts.message ?? "feat: change" };
    },
    prepareAtBranch: async (_repo: string, _branch: string) => {
      calls.push("prepareAtBranch");
      return { mirrorDir: "/mirrors/org__demo" };
    },
    generate: async (input: GenerateInput) => {
      calls.push("generate");
      h.genMode = input.mode;
      h.genGuidance = input.guidance;
      h.genInputs.push(input);
      if (agentSeq) return agentSeq.shift() ?? opts.agent ?? generated;
      return opts.agent ?? generated;
    },
    ...(opts.review
      ? {
          review: async () => {
            calls.push("review");
            return reviewSeq!.shift() ?? { approved: true, corrections: [] };
          },
        }
      : {}),
    ...(opts.coverage
      ? {
          collectCoverage: async () => {
            calls.push("coverage");
            return covSeq!.length ? covSeq!.shift()! : null;
          },
        }
      : {}),
    setupE2e: async () => {
      calls.push("setup");
    },
    validate: async () => {
      calls.push("validate");
      return opts.validation ?? { ok: true, errors: [], infra: false };
    },
    isHealthy: async () => {
      calls.push("health");
      if (healthSeq) return healthSeq.shift() ?? true;
      return opts.healthy ?? true;
    },
    execute: async () => {
      calls.push("execute");
      return run;
    },
    setupCode: async () => {
      calls.push("setupCode");
    },
    executeCode: async () => {
      calls.push("executeCode");
      return run;
    },
    ...(opts.codeValidation
      ? {
          validateCode: async () => {
            calls.push("validateCode");
            if (codeValSeq) return codeValSeq.shift() ?? { ok: true, errors: [], infra: false };
            return opts.codeValidation as { ok: boolean; errors: string[]; infra: boolean };
          },
        }
      : {}),
    publishCode: async (input: { baseBranch: string }) => {
      calls.push("publishCode");
      assert.equal(input.baseBranch, "main");
      h.published = true;
      return opts.prUrl === undefined ? { prUrl: "https://github.com/org/demo/pull/9", merged: true } : opts.prUrl === null ? null : { prUrl: opts.prUrl, merged: true };
    },
    publishContext: async (input: { baseBranch: string }) => {
      calls.push("publishContext");
      assert.equal(input.baseBranch, "main");
      h.published = true;
      return opts.prUrl === undefined ? { prUrl: "https://github.com/org/demo/pull/2", merged: true } : opts.prUrl === null ? null : { prUrl: opts.prUrl, merged: true };
    },
    publish: async (input: { baseBranch: string }) => {
      calls.push("publish");
      assert.equal(input.baseBranch, "main");
      h.published = true;
      return opts.prUrl === undefined ? { prUrl: "https://github.com/org/demo/pull/1", merged: true } : opts.prUrl === null ? null : { prUrl: opts.prUrl, merged: true };
    },
    openIssue: async (_repo: string, title: string) => {
      issues.push(title);
      return { url: "https://github.com/org/demo/issues/1" };
    },
    saveOutcome: async (outcome: RunOutcome) => {
      savedOutcomes.push(outcome);
    },
    runOracle: async (input: OracleInput) => {
      oracleCalls.push(input);
      return { valueScore: 0.85, mutantCount: 100, killedCount: 85, details: "85/100 mutants killed (85.0%)" };
    },
  });
  return h;
}

function passing(): QaRunResult {
  return { sha: "s", verdict: "pass", passed: true, cases: [], logs: "" };
}

// Coverage determinism: the run-scoped V8 dump dir must be cleared BEFORE the execute
// whose dumps will be measured, so a measurement never unions stale dumps (a prior
// same-sha run, or an earlier round of the enforce loop) into this run's coverage.
test("clears the coverage dir before each measured execute (deterministic coverage)", async () => {
  const calls: string[] = [];
  const h = deps(passing(), calls, { coverage: [cov([1, 2, 3, 4])], diff: DIFF_4, message: "feat: x" });
  const clearArgs: Array<{ dir: string; ns: string }> = [];
  h.clearCoverage = (dir: string, ns: string) => {
    calls.push("clearCoverage");
    clearArgs.push({ dir, ns });
  };
  await runPipeline(app, "abc1234def", h, "manual", { mode: "diff" });
  const firstClear = calls.indexOf("clearCoverage");
  const firstExecute = calls.indexOf("execute");
  assert.ok(firstClear >= 0, `clearCoverage was never called: ${calls.join(",")}`);
  assert.ok(firstClear < firstExecute, `clearCoverage must precede execute: ${calls.join(",")}`);
  assert.match(clearArgs[0]!.ns, /qa-bot-abc1234/);
});

// Keystone observability: "unknown" coverage because dumps existed but matched ZERO
// changed files (the bundled-deploy structural no-op) must be a LOUD warning, not the
// same benign "unknown" logged when there is simply no coverage data.
test("warns loudly when coverage is UNKNOWN but the suite produced dumps (keystone no-op)", async () => {
  const logs: string[] = [];
  const h = deps(passing(), [], { coverage: [null], diff: DIFF_4, message: "feat: x" });
  h.log = (m: string) => logs.push(m);
  h.hasCoverageDumps = () => true;
  await runPipeline(app, "abc1234def", h, "manual", { mode: "diff" });
  assert.ok(
    logs.some((l) => /CHANGE-COVERAGE INACTIVE|V8 script URLs/i.test(l)),
    `expected a keystone no-op warning, got:\n${logs.join("\n")}`,
  );
});

test("does NOT warn about a keystone no-op when there are simply no dumps", async () => {
  const logs: string[] = [];
  const h = deps(passing(), [], { coverage: [null], diff: DIFF_4, message: "feat: x" });
  h.log = (m: string) => logs.push(m);
  h.hasCoverageDumps = () => false;
  await runPipeline(app, "abc1234def", h, "manual", { mode: "diff" });
  assert.ok(!logs.some((l) => /CHANGE-COVERAGE INACTIVE/i.test(l)));
});

// Disk-over-LLM-word (root theme T1): the authoritative spec set is what is on disk
// (git status over e2e/), never what the agent printed in its verdict JSON.
test("a no-op is decided by what is on disk, not the agent's reported specs", async () => {
  const calls: string[] = [];
  const h = deps(passing(), calls, { agent: { output: "x", specs: ["a.spec.ts"], reviewed: true, approved: true } });
  h.listChangedSpecs = async () => []; // agent PRINTED a spec but wrote NONE to disk
  const run = await runPipeline(app, "abc1234def", h, "manual", { mode: "diff" });
  assert.equal(run.verdict, "skipped"); // approved + zero specs ON DISK = legit no-op
  assert.ok(!calls.includes("execute")); // never ran
});

test("on-disk specs the agent failed to report still drive the run (not a false no-op)", async () => {
  const calls: string[] = [];
  const h = deps(passing(), calls, { agent: { output: "x", specs: [], reviewed: true, approved: true } });
  h.listChangedSpecs = async () => ["flows/real.spec.ts"]; // agent under-reported; disk has a spec
  const run = await runPipeline(app, "abc1234def", h, "manual", { mode: "diff" });
  assert.ok(calls.includes("execute")); // disk has a spec → not a no-op → it runs
  assert.equal(run.verdict, "pass");
});

test("the independent reviewer is given the ON-DISK spec list, not the agent's", async () => {
  const reviewInputs: string[][] = [];
  const h = deps(passing(), [], {
    agent: { output: "x", specs: ["ghost.spec.ts"], reviewed: true, approved: true },
    review: [{ approved: true, corrections: [] }],
  });
  h.listChangedSpecs = async () => ["flows/real.spec.ts"];
  const origReview = h.review!;
  h.review = async (input, signal) => {
    reviewInputs.push(input.specs);
    return origReview(input, signal);
  };
  await runPipeline(app, "abc1234def", h, "manual", { mode: "diff" });
  assert.deepEqual(reviewInputs[0], ["flows/real.spec.ts"]); // disk truth, not "ghost.spec.ts"
});

test("reviewer rationale is persisted on RunOutcome — an approval is auditable after the fact", async () => {
  const calls: string[] = [];
  const rationale = "These specs assert the discount path this commit added; the change cannot break green.";
  const d = deps(passing(), calls, { review: [{ approved: true, corrections: [], rationale }] });
  await runPipeline(app, "abc1234def", d, "manual", { mode: "diff", runId: "run-rationale" });
  const outcome = d.savedOutcomes.at(-1)!;
  assert.ok(outcome, "outcome must be persisted when a runId is provided");
  assert.equal(outcome.gateSignals.reviewerRationale, rationale);
});

// Measured persistence (H3/M1): suite-level learning is recorded for e2e with the run's
// cases + the actually-covered files, and is SKIPPED in code mode (it would pollute the
// watched repo and there is no per-test coverage there).
test("records measured data for e2e but NOT in code mode", async () => {
  const agentWithMeta: AgentResult = {
    output: "x", specs: ["a.spec.ts"], reviewed: true, approved: true,
    specMetas: [{ file: "a.spec.ts", flow: "checkout", objective: "o", targets: ["src/x.ts"] }],
  };
  const recorded: Array<{ cases: number; covered: string[] }> = [];
  const h = deps(passing(), [], { coverage: [cov([1, 2, 3, 4])], diff: DIFF_4, message: "feat: x", agent: agentWithMeta });
  h.recordMeasured = (_e2eDir, input) => recorded.push({ cases: input.cases.length, covered: input.coveredFiles });
  await runPipeline(app, "abc1234def", h, "manual", { mode: "diff" });
  assert.equal(recorded.length, 1, "e2e run must persist measured data");

  let codeCalls = 0;
  const h2 = deps(passing(), [], { agent: agentWithMeta });
  h2.recordMeasured = () => { codeCalls++; };
  await runPipeline(app, "abc1234def", h2, "manual", { mode: "diff", target: "code" });
  assert.equal(codeCalls, 0, "code mode must NOT persist measured (would pollute the repo)");
});

// Reviewer fail-closed must be bounded and observable: an UNPARSEABLE verdict is not an
// actionable rejection — feeding a fake correction just burns a round and re-hits the
// same miss. Treat it like a reviewer error: fail closed, loudly, and do not publish.
test("an unparseable reviewer verdict fails closed and does NOT burn a regeneration round", async () => {
  const logs: string[] = [];
  const h = deps(passing(), [], {
    agent: { output: "x", specs: ["a.spec.ts"], reviewed: true, approved: true },
    review: [{ approved: false, corrections: ["the independent reviewer produced no parseable verdict"], parsed: false }],
  });
  h.log = (m: string) => logs.push(m);
  await runPipeline(app, "abc1234def", h, "manual", { mode: "diff" });
  assert.equal(h.genInputs.length, 1, "must not regenerate on a parse miss");
  assert.equal(h.published, false);
  assert.equal(h.issues.length, 1);
  assert.ok(logs.some((l) => /failing closed/i.test(l)));
});

// A post-rejection regeneration that writes NO specs must not be treated as an approved
// no-op (the reviewer never judged it) — that would let unreviewed work skip green.
test("a post-rejection regeneration with no specs is not treated as an approved no-op", async () => {
  const h = deps(passing(), [], {
    agents: [
      { output: "x", specs: ["a.spec.ts"], reviewed: true, approved: true }, // round 0
      { output: "y", specs: [], reviewed: true, approved: true }, // round 1: regenerated nothing
    ],
    review: [{ approved: false, corrections: ["fix it"], parsed: true }], // rejects round 0
  });
  const run = await runPipeline(app, "abc1234def", h, "manual", { mode: "diff" });
  assert.notEqual(run.verdict, "skipped"); // not a green no-op
  assert.ok(h.issues.length > 0); // surfaced: the reviewer did not approve
});

// Determinism: the DEV-data / coverage namespace is scoped to the runId, so two runs of
// the SAME sha never share a namespace (no entity-name collisions, no stale-dump merge).
test("the run namespace is scoped to the runId when one is provided", async () => {
  const nsSeen: string[] = [];
  const h = deps(passing(), [], { coverage: [cov([1, 2, 3, 4])], diff: DIFF_4, message: "feat: x" });
  h.clearCoverage = (_dir: string, ns: string) => nsSeen.push(ns);
  await runPipeline(app, "abc1234def", h, "manual", { mode: "diff", runId: "run-abc1234-zzz111" });
  assert.match(nsSeen[0]!, /^qa-bot-abc1234-/); // per-run token appended to prefix+sha
  assert.notEqual(nsSeen[0], "qa-bot-abc1234"); // not the bare sha-only form
});

test("green: orchestrates gate → prepare → setup → generate → validate → health → execute → publish", async () => {
  const calls: string[] = [];
  await runPipeline(app, "abc123", deps(passing(), calls), "manual");
  // setup runs before generate (so the agent has the seed); on green the
  // post-failure health re-check short-circuits (only 1 health).
  assert.deepEqual(calls, ["gate", "prepare", "setup", "generate", "validate", "health", "execute", "publish"]);
});

test("agent writes no specs (no-op change): skipped, does not validate/execute/publish", async () => {
  const calls: string[] = [];
  const noop: AgentResult = { output: "the change needs no tests", specs: [], reviewed: true, approved: true };
  const d = deps(passing(), calls, { agent: noop });
  const run = await runPipeline(app, "abc123", d);
  assert.equal(run.verdict, "skipped");
  assert.ok(calls.includes("generate"));
  assert.ok(!calls.includes("validate"));
  assert.ok(!calls.includes("execute"));
  assert.equal(d.published, false);
});

test("green opens a PR, NOT an Issue", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls);
  await runPipeline(app, "abc123", d);
  assert.equal(d.published, true);
  assert.equal(d.issues.length, 0);
});

test("green with no changes in e2e: does not break (publish returns null)", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, { prUrl: null });
  const run = await runPipeline(app, "abc123", d);
  assert.equal(run.verdict, "pass");
  assert.equal(d.issues.length, 0);
});

test("on failure opens an Issue with the SHA and does NOT publish", async () => {
  const calls: string[] = [];
  const d = deps(
    { sha: "s", verdict: "fail", passed: false, cases: [{ name: "login", status: "fail" }], logs: "x" },
    calls,
  );
  await runPipeline(app, "abc123", d);
  assert.equal(d.published, false);
  assert.equal(d.issues.length, 1);
  assert.match(d.issues[0]!, /abc123/);
});

test("flaky: neither PR nor Issue (quarantine)", async () => {
  const calls: string[] = [];
  const d = deps(
    { sha: "s", verdict: "flaky", passed: false, cases: [{ name: "checkout", status: "flaky" }], logs: "" },
    calls,
  );
  await runPipeline(app, "abc123", d);
  assert.equal(d.published, false);
  assert.equal(d.issues.length, 0);
});

test("invalid specs: does NOT execute or publish, opens a validation Issue", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, { validation: { ok: false, errors: ["[lint] no-wait-for-timeout"], infra: false } });
  const run = await runPipeline(app, "abc123", d);
  assert.equal(run.verdict, "invalid");
  assert.ok(!calls.includes("execute"));
  assert.ok(!calls.includes("publish"));
  assert.equal(d.issues.length, 1);
  assert.match(d.issues[0]!, /could not validate/);
});

// Static-repair loop: a single trivial gate error (e.g. an unused var) must NOT discard the whole
// suite on the first miss — it gets a bounded regeneration with the exact errors as feedback, exactly
// like an execution failure does. Observed on PetClinic: one `no-unused-vars` failed 7 good specs.
test("static-repair loop: a failing static gate regenerates and re-validates instead of dying invalid on the first miss", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, { diff: DIFF_4, coverage: [cov([1, 2, 3, 4])], message: "feat: x" });
  let n = 0;
  d.validate = async () => {
    calls.push("validate");
    return n++ === 0
      ? { ok: false, errors: ["39:11  error  'specialtyCell' is assigned a value but never used"], infra: false }
      : { ok: true, errors: [], infra: false }; // the agent fixed it on the repair round
  };
  const run = await runPipeline(app, "abc1234def", d, "manual", { mode: "diff", runId: "run-static-fix" });
  assert.notEqual(run.verdict, "invalid"); // the trivial error was repaired, not fatal
  assert.ok(calls.filter((c) => c === "validate").length >= 2, "must re-validate after the repair");
  assert.ok(calls.filter((c) => c === "generate").length >= 2, "the static failure must trigger regeneration");
});

test("green but the reviewer did NOT approve: does not publish, opens a review Issue", async () => {
  const calls: string[] = [];
  const rejected: AgentResult = { output: "x", specs: [], reviewed: true, approved: false, note: "false positives" };
  const d = deps(passing(), calls, { agent: rejected });
  await runPipeline(app, "abc123", d);
  assert.equal(d.published, false);
  assert.equal(d.issues.length, 1);
  assert.match(d.issues[0]!, /did not approve/);
});

test("reviewer rejects then approves: reinjects corrections, regenerates, and publishes", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, {
    agents: [generated, generated], // round 0 + the regenerated round
    review: [
      { approved: false, corrections: ["a.spec.ts: assert the outcome, not just the click"] },
      { approved: true, corrections: [] },
    ],
  });
  await runPipeline(app, "abc123", d);
  // generate ran twice (initial + after corrections); review ran twice
  assert.equal(calls.filter((c) => c === "generate").length, 2);
  assert.equal(calls.filter((c) => c === "review").length, 2);
  // the second generate received the reviewer's corrections
  assert.deepEqual(d.genInputs[1]!.reviewCorrections, ["a.spec.ts: assert the outcome, not just the click"]);
  assert.equal(d.published, true);
  assert.equal(d.issues.length, 0);
});

test("reviewer never converges: bounded at MAX_REVIEW_ROUNDS, no publish, opens a review Issue", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, {
    agents: [generated, generated, generated],
    review: [
      { approved: false, corrections: ["x"] },
      { approved: false, corrections: ["y"] },
      { approved: false, corrections: ["z"] },
    ],
  });
  await runPipeline(app, "abc123", d);
  // 2 rounds: generate(initial) → review(reject) → generate(fix) → review(reject) → stop
  assert.equal(calls.filter((c) => c === "generate").length, 2);
  assert.equal(calls.filter((c) => c === "review").length, 2);
  assert.equal(d.published, false);
  assert.equal(d.issues.length, 1);
  assert.match(d.issues[0]!, /did not approve/);
});

test("reviewer error fails closed: does not trust the generator or publish", async () => {
  const calls: string[] = [];
  const h = deps(passing(), calls, {});
  // a review() that throws → fail closed
  (h as PipelineDeps).review = async () => {
    calls.push("review");
    throw new Error("reviewer crashed");
  };
  await runPipeline(app, "abc123", h);
  assert.equal(calls.filter((c) => c === "generate").length, 1);
  assert.equal(h.published, false);
  assert.equal(h.issues.length, 1);
});

// ── Phase 4: severity-gated reviewer ─────────────────────────────────────────

test("Phase 4 (a) + FIX 4: approved:TRUE with advisory-only corrections APPROVES the gate (no regeneration)", async () => {
  // The legitimate severity-gate behavior we must PRESERVE: when the reviewer genuinely approved
  // (approved:true) and only advisory corrections remain, the run publishes without regenerating.
  const calls: string[] = [];
  const d = deps(passing(), calls, {
    agents: [generated],
    review: [
      {
        approved: true, // genuine approval
        corrections: ["[fragile-selector] a.spec.ts: prefer getByRole — advisory"],
        blockingCount: 0, // explicitly zero blocking
        parsed: true,
      },
    ],
  });
  await runPipeline(app, "abc123", d);
  assert.equal(calls.filter((c) => c === "generate").length, 1, "no regeneration for advisory-only verdict");
  assert.equal(calls.filter((c) => c === "review").length, 1, "reviewed once");
  assert.equal(d.published, true, "gate passes with advisory-only corrections on a genuine approval");
  assert.equal(d.issues.length, 0, "no Issue opened");
});

test("FIX 4: approved:FALSE with ALL-advisory corrections FAILS the gate (the gameable hole is closed)", async () => {
  // The bug FIX 4 fixes: previously `blockingCount === 0` alone passed the gate even when the
  // reviewer explicitly set approved:false — so downgrading every correction to advisory let a
  // rejected suite publish. Now the gate requires review.approved AND zero blocking. The reviewer
  // keeps rejecting on both rounds → never converges → an Issue is opened, nothing publishes.
  const calls: string[] = [];
  const d = deps(passing(), calls, {
    agents: [generated, generated],
    review: [
      { approved: false, corrections: ["[fragile-selector] a.spec.ts: advisory nit"], blockingCount: 0, parsed: true },
      { approved: false, corrections: ["[fragile-selector] a.spec.ts: advisory nit"], blockingCount: 0, parsed: true },
    ],
  });
  await runPipeline(app, "abc123", d);
  assert.equal(d.published, false, "an explicit approved:false must NOT publish even when all corrections are advisory");
  assert.ok(d.issues.length > 0, "the reviewer rejection surfaces as an Issue");
});

test("Phase 4 (b): blocking correction fails the gate and triggers regeneration", async () => {
  // A result with blockingCount>0 must fail the gate and trigger a regeneration round.
  const calls: string[] = [];
  const d = deps(passing(), calls, {
    agents: [generated, generated],
    review: [
      {
        approved: false,
        corrections: ["[false-positive] a.spec.ts: no assertion on the discount"],
        blockingCount: 1, // one blocking correction → fail
        parsed: true,
      },
      { approved: true, corrections: [], blockingCount: 0, parsed: true }, // round 2: clean
    ],
  });
  await runPipeline(app, "abc123", d);
  assert.equal(calls.filter((c) => c === "generate").length, 2, "regenerated after blocking correction");
  assert.equal(d.published, true, "second round approved → published");
});

test("Phase 4 (c): missing blockingCount defaults to fail-closed (all corrections treated as blocking)", async () => {
  // When blockingCount is absent on the ReviewResult, the gate must treat the corrections as
  // blocking (fail-closed backward compat). This prevents pre-Phase-4 reviewer verdicts from
  // accidentally passing the gate.
  const calls: string[] = [];
  const d = deps(passing(), calls, {
    agents: [generated, generated],
    review: [
      {
        approved: false,
        corrections: ["[other] a.spec.ts: some correction with no blockingCount"],
        // blockingCount absent → treated as corrections.length (=1, blocking)
        parsed: true,
      },
      { approved: true, corrections: [], parsed: true },
    ],
  });
  await runPipeline(app, "abc123", d);
  assert.equal(calls.filter((c) => c === "generate").length, 2, "regenerated because missing blockingCount is fail-closed");
  assert.equal(d.published, true);
});

test("Phase 4 (d): priorCorrections from round 1 are threaded into the round-2 review call", async () => {
  // Stateful rounds: the reviewer's corrections from round 1 must appear as priorCorrections
  // on the round-2 deps.review() call so the reviewer can judge convergence.
  const calls: string[] = [];
  const capturedReviewInputs: Array<import("./integrations/opencode-client").ReviewInput> = [];
  const h = deps(passing(), calls, {
    agents: [generated, generated],
    review: [
      { approved: false, corrections: ["[false-positive] a.spec.ts: BLOCKING_CORRECTION_ROUND1"], blockingCount: 1, parsed: true },
      { approved: true, corrections: [], blockingCount: 0, parsed: true },
    ],
  });
  // Intercept review calls to capture the ReviewInput for each round.
  const origReview = h.review!;
  h.review = async (input, ...rest) => {
    capturedReviewInputs.push(input);
    return origReview(input, ...rest);
  };
  await runPipeline(app, "abc123", h);
  assert.equal(capturedReviewInputs.length, 2, "review called twice");
  // Round 1: no prior corrections.
  assert.equal(capturedReviewInputs[0]!.priorCorrections, undefined, "round 1 has no prior corrections");
  // Round 2: the round-1 corrections must be present as priorCorrections.
  assert.ok(
    Array.isArray(capturedReviewInputs[1]!.priorCorrections) &&
    capturedReviewInputs[1]!.priorCorrections!.some((c) => c.includes("BLOCKING_CORRECTION_ROUND1")),
    `round-2 priorCorrections must carry round-1 corrections; got: ${JSON.stringify(capturedReviewInputs[1]!.priorCorrections)}`,
  );
});

test("Phase 4 (e): approve-when-resolved — round 2 with zero blocking after round 1 blocking approves and publishes", async () => {
  // Simulates the happy-path convergence: round 1 has a blocking correction, the generator
  // fixes it, and round 2 finds zero blocking corrections → the gate approves and the run
  // publishes without opening an Issue.
  const calls: string[] = [];
  const d = deps(passing(), calls, {
    agents: [generated, generated],
    review: [
      { approved: false, corrections: ["[false-positive] a.spec.ts: missing assertion"], blockingCount: 1, parsed: true },
      // Round 2: blocking resolved; one advisory nit remains. The reviewer now APPROVES (approved:true)
      // and only an advisory remains → the severity gate approves and publishes. (FIX 4: an explicit
      // approved:false would NOT pass even with zero blocking, so the approving round must approve.)
      {
        approved: true,
        corrections: ["[fragile-selector] a.spec.ts: prefer getByRole — advisory"],
        blockingCount: 0, // zero blocking → gate approves
        parsed: true,
      },
    ],
  });
  await runPipeline(app, "abc123", d);
  assert.equal(calls.filter((c) => c === "generate").length, 2, "regenerated once after blocking");
  assert.equal(calls.filter((c) => c === "review").length, 2, "reviewed twice");
  assert.equal(d.published, true, "blocking resolved → published");
  assert.equal(d.issues.length, 0, "no Issue opened");
});

// ── Phase 4 regression gate: complete/exhaustive review flow ──────────────────

test("Phase 4 regression: complete/exhaustive runs also use the severity gate (advisory does not block)", async () => {
  // complete/exhaustive runs also go through the reviewer. Ensure the severity gate
  // does NOT break their review flow: a genuine approval with advisory-only → still approves.
  const calls: string[] = [];
  const d = deps(passing(), calls, {
    agents: [{ ...generated, specs: ["flows/complete.spec.ts"] }],
    review: [
      // Approved with an advisory nit for a complete-mode review → must publish without regenerating.
      { approved: true, corrections: ["[other] flows/complete.spec.ts: minor advisory"], blockingCount: 0, parsed: true },
    ],
  });
  await runPipeline(app, "abc123", d, "webhook", { target: "e2e", mode: "complete" });
  assert.equal(calls.filter((c) => c === "generate").length, 1, "no regeneration for advisory-only in complete mode");
  assert.equal(d.published, true, "complete mode: advisory does not block");
});

// ── change-coverage (Filter D) ───────────────────────────────────────────────

const covApp = (mode: "off" | "signal" | "enforce", minRatio = 0.7): AppConfig => ({
  ...app,
  qa: { ...app.qa, changeCoverage: { mode, minRatio } },
});

test("change-coverage signal: low coverage is recorded but NEVER blocks publishing", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, { diff: DIFF_4, coverage: [cov([1])] }); // 1/4 changed lines
  await runPipeline(covApp("signal"), "abc123", d);
  assert.ok(calls.includes("coverage"));
  assert.equal(d.published, true);
  assert.equal(d.issues.length, 0);
});

test("change-coverage enforce: low coverage that can't be improved blocks publish, opens an Issue", async () => {
  const calls: string[] = [];
  // first agent generates; the improvement attempt produces no new specs → cannot close the gap
  const noFix: AgentResult = { output: "x", specs: [], reviewed: true, approved: true };
  const d = deps(passing(), calls, { diff: DIFF_4, agents: [generated, noFix], coverage: [cov([1]), cov([1])] });
  await runPipeline(covApp("enforce"), "abc123", d);
  assert.equal(d.published, false);
  assert.equal(d.issues.length, 1);
  assert.match(d.issues[0]!, /change-coverage threshold/);
});

test("change-coverage enforce: the improvement closes the gap → publishes", async () => {
  const calls: string[] = [];
  // second collectCoverage (after the improvement re-run) reports full coverage
  const d = deps(passing(), calls, { diff: DIFF_4, agents: [generated, generated], coverage: [cov([1]), cov([1, 2, 3, 4])] });
  await runPipeline(covApp("enforce"), "abc123", d);
  assert.equal(d.published, true);
  assert.equal(d.issues.length, 0);
  // the improvement regeneration received the coverage gap
  assert.ok(d.genInputs.some((g) => typeof g.coverageGap === "string" && /not exercised/i.test(g.coverageGap!)));
});

test("change-coverage enforce: unmeasured coverage (null) is 'unknown' and never blocks", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, { diff: DIFF_4, coverage: [null] });
  await runPipeline(covApp("enforce"), "abc123", d);
  assert.equal(d.published, true);
  assert.equal(d.issues.length, 0);
});

test("change-coverage: an UNMEASURED green run persists coverageRatio null, never 0 (no false E-COVERAGE-GAP)", async () => {
  const calls: string[] = [];
  // collectCoverage returns null → measured:false; computeChangeCoverage yields ratio 0 with
  // measured false. Persisting that 0 would mislabel a genuinely-unmeasured green run as a
  // coverage gap; the persisted ratio MUST be null instead.
  const d = deps(passing(), calls, { diff: DIFF_4, coverage: [null] });
  await runPipeline(covApp("signal"), "abc123", d, "manual", { mode: "diff", runId: "run-cov-null" });
  const outcome = d.savedOutcomes.at(-1)!;
  assert.ok(outcome, "a runId was provided, so the outcome must be persisted");
  assert.equal(outcome.gateSignals.coverageRatio, null);
});

test("change-coverage off: the step is skipped entirely", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, { diff: DIFF_4, coverage: [cov([1])] });
  await runPipeline(covApp("off"), "abc123", d);
  assert.ok(!calls.includes("coverage"));
  assert.equal(d.published, true);
});

// Keystone integrity: a diff run that goes green only on a RETRY produces its V8 dumps under the
// per-retry namespace (…-r1). The per-retry whole-tree coverage wipe deletes the base namespace's
// dumps, so collecting change-coverage from the base `ns` reads an empty dir → the keystone is
// silently lost ("unknown", which never blocks) for exactly the runs that needed fixing. Coverage
// MUST be collected from the namespace of the run that actually produced the green result.
test("change-coverage: a run green only on a retry is measured from the retry namespace (keystone not lost)", async () => {
  const calls: string[] = [];
  const failingRun: QaRunResult = { sha: "s", verdict: "fail", passed: false, cases: [{ name: "x", status: "fail" }], logs: "" };
  const passingRun: QaRunResult = { sha: "s", verdict: "pass", passed: true, cases: [], logs: "" };
  const oneRetryApp: AppConfig = { ...covApp("signal"), qa: { ...covApp("signal").qa, fixLoop: { maxRetries: 1 } } };
  const d = deps(failingRun, calls, { diff: DIFF_4 });
  let executeCall = 0;
  d.execute = async () => {
    calls.push("execute");
    return executeCall++ === 0 ? failingRun : passingRun;
  };
  const coverageNsSeen: string[] = [];
  // Models the real fixture: V8 dumps exist ONLY under the namespace the passing suite executed in.
  d.collectCoverage = async (input) => {
    coverageNsSeen.push(input.namespace);
    return /-r\d+$/.test(input.namespace) ? cov([1, 2, 3, 4]) : null;
  };
  await runPipeline(oneRetryApp, "abc1234def", d, "manual", { mode: "diff", runId: "run-retry-cov" });
  const outcome = d.savedOutcomes.at(-1)!;
  assert.ok(outcome, "a runId was provided, so the outcome must be persisted");
  assert.match(
    coverageNsSeen[0] ?? "",
    /-r\d+$/,
    `coverage must be collected from the retry namespace, got "${coverageNsSeen[0]}" (calls: ${calls.join(",")})`,
  );
  assert.equal(
    outcome.gateSignals.coverageRatio,
    1,
    "change-coverage must be MEASURED (1.0) on a retry-green run, not silently lost to unknown",
  );
});

test("DEV unhealthy before execution: infra-error, neither executes nor reports as a bug", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, { healthy: false });
  const run = await runPipeline(app, "abc123", d);
  assert.equal(run.verdict, "infra-error");
  assert.ok(!calls.includes("execute"));
  assert.equal(d.issues.length, 0); // infra does NOT open an Issue
});

test("failures with DEV down mid-run: reclassified to infra-error (no Issue)", async () => {
  const calls: string[] = [];
  // healthy in the pre-flight, down in the post-failure re-check
  const failing: QaRunResult = { sha: "s", verdict: "fail", passed: false, cases: [{ name: "x", status: "fail" }], logs: "" };
  const d = deps(failing, calls, { healthy: [true, false] });
  const run = await runPipeline(app, "abc123", d);
  assert.equal(run.verdict, "infra-error");
  assert.equal(d.issues.length, 0);
});

test("style commit (no logic): skipped, neither generates nor executes", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, { message: "style: reorder comments", diff: "" });
  const run = await runPipeline(app, "abc123", d);
  assert.equal(run.verdict, "skipped");
  assert.equal(run.passed, true);
  assert.deepEqual(calls, ["gate", "prepare"]); // neither generate nor execute
});

test("refactor commit without logic: regression (runs existing, does NOT generate or publish)", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, { message: "refactor: unify auth", diff: "DIFF" });
  await runPipeline(app, "abc123", d);
  assert.ok(!calls.includes("generate")); // does not generate
  assert.ok(calls.includes("execute")); // but does validate/run the suite
  assert.equal(d.published, false); // nothing new to publish
});

test("refactor that DOES add logic (contradiction): escalates to generate", async () => {
  const calls: string[] = [];
  const logicDiff = ["diff --git a/src/x.ts b/src/x.ts", "+++ b/src/x.ts", "+if (a) { return f(); }"].join("\n");
  const d = deps(passing(), calls, { message: "refactor: cleanup", diff: logicDiff });
  await runPipeline(app, "abc123", d);
  assert.ok(calls.includes("generate")); // contradiction → generate
  assert.equal(d.published, true);
});

test("complete mode: skips commit classification and generates regardless of the message", async () => {
  const calls: string[] = [];
  // a 'style' message would skip in diff mode; in complete mode it must still generate
  const d = deps(passing(), calls, { message: "style: nits", diff: "" });
  await runPipeline(app, "abc123", d, "manual", { mode: "complete" });
  assert.ok(calls.includes("generate"));
  assert.ok(calls.includes("execute"));
  assert.equal(d.genMode, "complete");
});

test("manual mode: passes the guidance through to generate", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls);
  await runPipeline(app, "abc123", d, "manual", { mode: "manual", guidance: "test the CV download button" });
  assert.equal(d.genMode, "manual");
  assert.equal(d.genGuidance, "test the CV download button");
});

test("shadow mode: on green does NOT publish, only logs", async () => {
  const calls: string[] = [];
  const shadowApp = { ...app, qa: { ...app.qa, shadow: true } };
  const d = deps(passing(), calls);
  await runPipeline(shadowApp, "abc123", d);
  assert.equal(d.published, false);
  assert.equal(d.issues.length, 0);
});

test("no version endpoint: skips the gate and health checks (already-deployed site)", async () => {
  const calls: string[] = [];
  const gateless = { ...app, dev: { baseUrl: "https://cv" } };
  const d = deps(passing(), calls);
  await runPipeline(gateless, "abc123", d);
  assert.ok(!calls.includes("gate")); // deploy gate skipped
  assert.ok(!calls.includes("health")); // health checks skipped (no source)
  assert.ok(calls.includes("execute")); // still runs the suite
  assert.equal(d.published, true);
});

test("shadow mode: on failure does NOT open an Issue", async () => {
  const calls: string[] = [];
  const shadowApp = { ...app, qa: { ...app.qa, shadow: true } };
  const d = deps(
    { sha: "s", verdict: "fail", passed: false, cases: [{ name: "x", status: "fail" }], logs: "" },
    calls,
  );
  await runPipeline(shadowApp, "abc123", d);
  assert.equal(d.issues.length, 0);
});

// ── Code mode (target "code") ────────────────────────────────────────────────
const codeApp: AppConfig = {
  name: "panchito",
  repo: "org/panchito",
  code: true,
  qa: { needsReview: true, testDataPrefix: "qa-bot" },
  report: { onFailure: "github-issue" },
};

test("code mode green: no gate/validate/health; setupCode → generate → executeCode → publishCode", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls);
  await runPipeline(codeApp, "abc123", d, "manual", { mode: "diff", target: "code" });
  assert.ok(!calls.includes("gate"), "no deploy gate in code mode");
  assert.ok(!calls.includes("validate"), "no static gate in code mode");
  assert.ok(!calls.includes("health"), "no health checks in code mode");
  assert.ok(!calls.includes("execute"), "uses executeCode, not the Playwright runner");
  assert.deepEqual(calls, ["prepare", "setupCode", "generate", "executeCode", "publishCode"]);
  assert.equal(d.published, true);
});

test("code mode emits onStep('execute') so the TUI stepper advances from generate", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls);
  const onStepCalls: string[] = [];
  await runPipeline(codeApp, "abc123", d, "manual", { mode: "diff", target: "code" }, (step) => { onStepCalls.push(step); });
  assert.ok(onStepCalls.includes("execute"), "code mode must call onStep('execute') for the TUI stepper");
});

test("code mode failure: opens a 'code tests failed' Issue, does not publish", async () => {
  const calls: string[] = [];
  const d = deps(
    { sha: "s", verdict: "fail", passed: false, cases: [{ name: "node tests", status: "fail" }], logs: "1 failing" },
    calls,
  );
  await runPipeline(codeApp, "abc123", d, "manual", { mode: "diff", target: "code" });
  assert.equal(d.published, false);
  assert.equal(d.issues.length, 1);
  assert.match(d.issues[0]!, /code tests failed/);
});

test("code mode skip (no logic commit): does not generate or execute", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, { message: "docs: readme", diff: "" });
  const run = await runPipeline(codeApp, "abc123", d, "manual", { mode: "diff", target: "code" });
  assert.equal(run.verdict, "skipped");
  assert.ok(!calls.includes("generate"));
  assert.ok(!calls.includes("executeCode"));
});

test("code mode compile gate: a persistent compile error → invalid, never reaches executeCode", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, { codeValidation: { ok: false, errors: ["[compile] cannot find symbol method map()"], infra: false } });
  const run = await runPipeline(codeApp, "abc123", d, "manual", { mode: "diff", target: "code" });
  assert.equal(run.verdict, "invalid");
  assert.ok(calls.includes("validateCode"), "the compile gate ran");
  assert.ok(!calls.includes("executeCode"), "a non-compiling suite is never executed");
  assert.equal(d.published, false);
  assert.equal(d.issues.length, 1);
});

test("code mode compile gate: passes after one repair round → proceeds to executeCode", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, {
    codeValidation: [
      { ok: false, errors: ["[compile] boom"], infra: false },
      { ok: true, errors: [], infra: false },
    ],
  });
  await runPipeline(codeApp, "abc123", d, "manual", { mode: "diff", target: "code" });
  assert.ok(calls.filter((c) => c === "validateCode").length >= 2, "gate failed, regenerated, re-validated");
  assert.ok(calls.includes("executeCode"), "after a clean compile the suite runs");
  assert.equal(d.published, true);
});

test("code mode compile gate: a broken toolchain (infra) → infra-error, no Issue, no execute", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, { codeValidation: { ok: false, errors: ["[compile] Error: JAVA_HOME is not set and could not be found."], infra: true } });
  const run = await runPipeline(codeApp, "abc123", d, "manual", { mode: "diff", target: "code" });
  assert.equal(run.verdict, "infra-error");
  assert.ok(!calls.includes("executeCode"));
  assert.equal(d.issues.length, 0, "infra is inconclusive — no Issue on the watched repo");
});

test("context mode: generates context.json, validates it, publishes, skips validate/execute/review", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, {
    agent: { output: "context map built", specs: [".qa/context.json"], reviewed: false, approved: true, note: "built map with 3 routes, 2 api ops, 2 links" },
  });
  let validateCalled = false;
  d.validateContextFn = () => {
    validateCalled = true;
    return { ok: true, errors: [] };
  };
  const run = await runPipeline(app, "abc123", d, "manual", { mode: "context" });
  assert.equal(run.verdict, "pass");
  assert.ok(calls.includes("generate"));
  assert.ok(validateCalled);
  assert.ok(!calls.includes("validate"));
  assert.ok(!calls.includes("execute"));
  assert.ok(!calls.includes("review"));
  assert.ok(calls.includes("publishContext"));
  assert.equal(d.published, true);
  assert.equal(d.genMode, "context");
});

test("context mode: invalid context.json returns 'invalid' verdict and opens an Issue", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, {
    agent: { output: "tried", specs: [".qa/context.json"], reviewed: false, approved: true },
  });
  d.validateContextFn = () => ({ ok: false, errors: ["feBe[0]: route '/ghost' is not declared in 'routes'"] });
  const run = await runPipeline(app, "abc123", d, "manual", { mode: "context" });
  assert.equal(run.verdict, "invalid");
  assert.equal(d.issues.length, 1);
  assert.match(d.issues[0]!, /context map.*invalid/);
});

test("context mode (shadow): builds map but does not publish or open Issues", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, {
    agent: { output: "map built", specs: [".qa/context.json"], reviewed: false, approved: true },
  });
  d.validateContextFn = () => ({ ok: true, errors: [] });
  const shadowApp = { ...app, qa: { ...app.qa, shadow: true } };
  const run = await runPipeline(shadowApp, "abc123", d, "manual", { mode: "context" });
  assert.equal(run.verdict, "pass");
  // Shadow mode: no publish, no issue.
  assert.equal(d.published, false);
  assert.equal(d.issues.length, 0);
});

test("diff mode bootstraps missing context map before generating tests", async () => {
  const calls: string[] = [];
  const builtContext = { builtAtSha: "abc123", routes: [], api: [], feBe: [] };
  const h = deps(passing(), calls, {
    context: "missing",
    agents: [
      { output: "context map built", specs: [".qa/context.json"], reviewed: false, approved: true },
      generated,
    ],
  });
  h.validateContextFn = () => ({ ok: true, errors: [] });
  h.readBuiltContext = () => builtContext;

  const run = await runPipeline(app, "abc123", h, "manual", { mode: "diff" });

  assert.equal(run.verdict, "pass");
  assert.deepEqual(calls.filter((c) => c === "generate"), ["generate", "generate"]);
  assert.equal(h.genInputs[0]!.mode, "context");
  assert.equal(h.genInputs[1]!.mode, "diff");
  assert.equal(h.genInputs[1]!.contextMap, builtContext);
  assert.ok(!calls.includes("publishContext"), "automatic bootstrap must not publish a separate context PR");
});

test("diff mode DEGRADES (does not fail invalid) when the bootstrap context map is invalid — the map is an optimization, not a gate", async () => {
  const calls: string[] = [];
  const h = deps(passing(), calls, {
    context: "missing",
    agents: [
      { output: "context map built", specs: [".qa/context.json"], reviewed: false, approved: true },
      generated,
    ],
  });
  // The agent produced a map, but it fails validation (e.g. one flow with no routes — like the
  // disabled GenAI chat in PetClinic). The QA run must NOT die `invalid` over an imperfect MAP.
  h.validateContextFn = () => ({ ok: false, errors: ["flows 'genai-chat': empty 'routes'"] });

  const run = await runPipeline(app, "abc123", h, "manual", { mode: "diff" });

  assert.notEqual(run.verdict, "invalid"); // the map is an optimization, not a correctness gate
  assert.equal(run.verdict, "pass"); // generation proceeded and the specs passed
  assert.deepEqual(calls.filter((c) => c === "generate"), ["generate", "generate"]); // context agent + the real diff generation
  assert.equal(h.genInputs[1]!.mode, "diff"); // the actual QA generation still ran...
  assert.equal(h.genInputs[1]!.contextMap, undefined); // ...just without the (invalid) map
  assert.ok(!h.issues.some((i) => /context map.*invalid/i.test(i)), "a bootstrap map failure must NOT open an Issue");
});

test("diff mode refreshes a stale context map before generating tests", async () => {
  const calls: string[] = [];
  const mirror = mkdtempSync(join(tmpdir(), "qa-context-stale-"));
  mkdirSync(join(mirror, "e2e", ".qa"), { recursive: true });
  writeFileSync(join(mirror, "e2e", ".qa", "context.json"), JSON.stringify({ builtAtSha: "oldsha1", routes: [], api: [], feBe: [] }));
  const refreshedContext = { builtAtSha: "abc123", routes: [{ path: "/checkout" }], api: [], feBe: [] };
  const h = deps(passing(), calls, {
    agents: [
      { output: "context refreshed", specs: [".qa/context.json"], reviewed: false, approved: true },
      generated,
    ],
  });
  h.prepare = async () => ({ mirrorDir: mirror, diff: DIFF_4, message: "feat: checkout" });
  h.checkContextStaleness = async () => "map built at oldsha1 is 40 commits behind HEAD (abc123), threshold is 20";
  h.validateContextFn = () => ({ ok: true, errors: [] });
  h.readBuiltContext = () => refreshedContext;

  await runPipeline(app, "abc123", h, "manual", { mode: "diff" });

  assert.equal(h.genInputs[0]!.mode, "context");
  assert.equal(h.genInputs[1]!.mode, "diff");
  assert.equal(h.genInputs[1]!.contextMap, refreshedContext);
});

test("shouldDistillLearning: only a code-mode real-bug fail is suppressed (it caught a real defect)", () => {
  // A code-mode `fail` means the agent's test CORRECTLY caught a real bug — distilling a "fix this
  // test" rule would poison the flywheel. Everything else still feeds learning.
  assert.equal(shouldDistillLearning(true, "fail"), false);
  assert.equal(shouldDistillLearning(true, "invalid"), true); // broken generated tests → learning IS useful
  assert.equal(shouldDistillLearning(true, "pass"), true);
  assert.equal(shouldDistillLearning(false, "fail"), true); // an e2e fail distills normally
});

test("learning layer: a code-mode green run records staticOk=true (the compile gate is the static gate)", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, { message: "feat: add x" });
  await runPipeline(codeApp, "codeStatic1", d, "manual", { mode: "diff", target: "code", runId: "code-static-1" });
  const o = d.savedOutcomes.at(-1)!;
  assert.equal(o.verdict, "pass");
  assert.equal(o.gateSignals.static, true, "code-mode green must record staticOk=true, not the old hardcoded false");
});

test("learning layer: saveOutcome is called on green runs with the labeled outcome", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, { diff: DIFF_4, coverage: [cov([1, 2, 3, 4])], message: "feat: add x" });
  await runPipeline(app, "abc1234def", d, "manual", { mode: "diff", runId: "test-run-1" });

  assert.equal(d.savedOutcomes.length, 1, "saveOutcome should be called once");
  const o = d.savedOutcomes[0]!;
  assert.equal(o.runId, "test-run-1");
  assert.equal(o.app, "demo");
  assert.equal(o.sha, "abc1234def");
  assert.equal(o.mode, "diff");
  assert.equal(o.verdict, "pass");
  assert.equal(o.errorClass, null); // green with coverage → no error
  assert.equal(o.gateSignals.static, true);
  assert.ok(o.at);
});

test("learning layer: saveOutcome is called on failed runs with E-EXEC-FAIL", async () => {
  const calls: string[] = [];
  const failed = { sha: "s", verdict: "fail" as const, passed: false, cases: [{ name: "t", status: "fail" as const }], logs: "" };
  const d = deps(failed, calls);
  await runPipeline(app, "fail0001", d, "manual", { mode: "diff", runId: "run-fail-1" });

  assert.equal(d.savedOutcomes.length, 1);
  const o = d.savedOutcomes[0]!;
  assert.equal(o.verdict, "fail");
  assert.equal(o.errorClass, "E-EXEC-FAIL");
});

test("learning layer: saveOutcome is called on invalid runs with E-STATIC", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, {
    validation: { ok: false, errors: ["lint failed"], infra: false },
  });
  await runPipeline(app, "inv00001", d, "manual", { mode: "diff", runId: "run-inv-1" });

  const o = d.savedOutcomes[0]!;
  assert.equal(o.verdict, "invalid");
  assert.equal(o.errorClass, "E-STATIC");
});

test("learning layer: saveOutcome captures reviewer corrections", async () => {
  const calls: string[] = [];
  const review = { approved: false, corrections: ["test clicks without asserting anything — false positive"], parsed: true as const };
  const d = deps(passing(), calls, { message: "feat: new form", review: [review] });
  await runPipeline(app, "rev0001", d, "manual", { mode: "diff", runId: "run-rev-1" });

  assert.ok(d.savedOutcomes.length >= 1);
  const o = d.savedOutcomes[0]!;
  assert.deepEqual(o.gateSignals.reviewerCorrections, review.corrections);
});

test("learning layer: saveOutcome tracks retries", async () => {
  const calls: string[] = [];
  const reviewSeq = [
    { approved: false, corrections: ["fragile selector"], parsed: true as const },
    { approved: true, corrections: [], parsed: true as const },
  ];
  const agents: AgentResult[] = [
    { output: "v1", specs: ["a.spec.ts"], reviewed: true, approved: false },
    { output: "v2", specs: ["a.spec.ts"], reviewed: true, approved: true },
  ];
  const d = deps(passing(), calls, { message: "feat: x", agents, review: reviewSeq, diff: DIFF_4, coverage: [cov([1, 2, 3, 4])] });
  await runPipeline(app, "ret0001", d, "manual", { mode: "diff", runId: "run-ret-1" });

  const o = d.savedOutcomes[0]!;
  assert.equal(o.gateSignals.retries, 1);
});

test("learning layer: saveOutcome failure is non-blocking (outcome still returned)", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, { diff: DIFF_4, coverage: [cov([1, 2, 3, 4])], message: "feat: x" });
  let saveCalled = false;
  d.saveOutcome = async () => {
    saveCalled = true;
    throw new Error("DB down");
  };
  await runPipeline(app, "flk0001", d, "manual", { mode: "diff", runId: "run-flk-1" });

  assert.ok(saveCalled, "saveOutcome was invoked");
  assert.equal(d.savedOutcomes.length, 0, "but persistence failed, nothing was saved");
});

test("learning layer: skipped runs are NOT persisted", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, { message: "docs: update readme", diff: "diff --git a/readme.md b/readme.md\n+++ b/readme.md\n@@ -1 +1,2 @@\n+text" });
  await runPipeline(app, "skip0001", d, "manual", { mode: "diff" });

  assert.equal(d.savedOutcomes.length, 0, "skipped runs produce no outcomes");
});

test("learning layer: infra-error → E-INFRA", async () => {
  const calls: string[] = [];
  const infra = { sha: "s", verdict: "infra-error" as const, passed: false, cases: [], logs: "DEV down" };
  const d = deps(infra, calls);
  await runPipeline(app, "infra001", d, "manual", { mode: "diff", runId: "run-infra-1" });

  const o = d.savedOutcomes[0]!;
  assert.equal(o.verdict, "infra-error");
  assert.equal(o.errorClass, "E-INFRA");
});

test("oracle: runOracle is called for code mode green runs", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls);
  const codeApp = { ...app, dev: undefined as unknown as AppConfig["dev"] };
  await runPipeline(codeApp, "code001", d, "manual", { target: "code", mode: "diff", runId: "run-orc-1" });

  assert.equal(d.oracleCalls.length, 1, "oracle should be called once");
  assert.equal(d.oracleCalls[0]!.target, "code");

  const o = d.savedOutcomes[0]!;
  assert.equal(o.gateSignals.valueScore, 0.85);
});

test("oracle: e2e runs the oracle by default once shadow is off (production)", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, { diff: DIFF_4, coverage: [cov([1, 2, 3, 4])], message: "feat: x" });
  await runPipeline(app, "e2e0001", d, "manual", { mode: "diff", runId: "run-orc-2" });

  assert.equal(d.oracleCalls.length, 1, "e2e oracle turns on by default in non-shadow runs");
  assert.equal(d.oracleCalls[0]!.target, "e2e");
});

test("oracle: e2e oracle is OFF in shadow mode (no DEV double-run during onboarding)", async () => {
  const calls: string[] = [];
  const shadowApp = { ...app, qa: { ...app.qa, shadow: true } };
  const d = deps(passing(), calls, { diff: DIFF_4, coverage: [cov([1, 2, 3, 4])], message: "feat: x" });
  await runPipeline(shadowApp, "e2eShad", d, "manual", { mode: "diff", runId: "run-orc-2b" });

  assert.equal(d.oracleCalls.length, 0, "shadow defaults the e2e oracle off");
});

test("oracle: explicit valueOracle 'off' disables the e2e oracle even in production", async () => {
  const calls: string[] = [];
  const offApp = { ...app, qa: { ...app.qa, valueOracle: "off" as const } };
  const d = deps(passing(), calls, { diff: DIFF_4, coverage: [cov([1, 2, 3, 4])], message: "feat: x" });
  await runPipeline(offApp, "e2eOff", d, "manual", { mode: "diff", runId: "run-orc-2c" });

  assert.equal(d.oracleCalls.length, 0, "explicit off always wins");
});

test("oracle: runOracle is NOT called for failing runs", async () => {
  const calls: string[] = [];
  const failed = { sha: "s", verdict: "fail" as const, passed: false, cases: [{ name: "t", status: "fail" as const }], logs: "" };
  const d = deps(failed, calls);
  const codeApp = { ...app, dev: undefined as unknown as AppConfig["dev"] };
  await runPipeline(codeApp, "fail001", d, "manual", { target: "code", mode: "diff", runId: "run-orc-3" });

  assert.equal(d.oracleCalls.length, 0, "oracle should NOT be called on failures");
});

test("oracle: runOracle failure is non-blocking", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls);
  d.runOracle = async () => { throw new Error("Stryker timeout"); };
  const codeApp = { ...app, dev: undefined as unknown as AppConfig["dev"] };
  await runPipeline(codeApp, "orcFail", d, "manual", { target: "code", mode: "diff", runId: "run-orc-4" });

  const o = d.savedOutcomes[0]!;
  assert.equal(o.gateSignals.valueScore, null, "valueScore remains null when oracle fails");
  assert.equal(o.verdict, "pass", "oracle failure does not change verdict");
});

test("oracle: valueScore=null when oracle returns null", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls);
  d.runOracle = async () => ({ valueScore: null, mutantCount: 0, killedCount: 0, details: "not available" });
  const codeApp = { ...app, dev: undefined as unknown as AppConfig["dev"] };
  await runPipeline(codeApp, "null001", d, "manual", { target: "code", mode: "diff", runId: "run-orc-5" });

  const o = d.savedOutcomes[0]!;
  assert.equal(o.gateSignals.valueScore, null);
});

// THE ORACLE-GAP FIX. The e2e fault-injection oracle scores the assertion strength of the
// baseline-PASSING specs, so in the heavy whole-suite modes (complete/exhaustive/manual) it must
// run on the passing SUBSET even when sibling specs failed — otherwise an exhaustive run that
// generated dozens of specs but ended partially-red would never reach the oracle, and its retrieved
// candidate rules would never accumulate an outcome and never promote (the production blocker).
test("oracle: e2e oracle runs in EXHAUSTIVE mode on the passing subset of a partially-red run (gap fix)", async () => {
  const calls: string[] = [];
  const partialRed = {
    sha: "s", verdict: "fail" as const, passed: false,
    cases: [{ name: "a", status: "pass" as const }, { name: "b", status: "fail" as const }], logs: "",
  };
  const d = deps(partialRed, calls, { diff: DIFF_4, coverage: [cov([1, 2, 3, 4])], message: "feat: x" });
  await runPipeline(app, "exh0001", d, "manual", { mode: "exhaustive", runId: "run-orc-exh" });

  assert.equal(d.oracleCalls.length, 1, "the oracle must run on the passing subset even though the run is fail");
  assert.equal(d.oracleCalls[0]!.target, "e2e");
  assert.deepEqual(d.oracleCalls[0]!.baselineCases, ["a"], "only the baseline-passing spec is scoreable");
});

// The frequent diff path stays conservative: a diff run that already ended fail (it caught a
// regression) must NOT also pay the 2× re-run cost — only a fully-green diff reaches the oracle.
test("oracle: e2e oracle does NOT run in DIFF mode on a partially-red run (hot-path stays full-pass)", async () => {
  const calls: string[] = [];
  const partialRed = {
    sha: "s", verdict: "fail" as const, passed: false,
    cases: [{ name: "a", status: "pass" as const }, { name: "b", status: "fail" as const }], logs: "",
  };
  const d = deps(partialRed, calls, { diff: DIFF_4, coverage: [cov([1, 2, 3, 4])], message: "feat: x" });
  await runPipeline(app, "diff001", d, "manual", { mode: "diff", runId: "run-orc-diff-red" });

  assert.equal(d.oracleCalls.length, 0, "a partially-red diff run does not trigger the oracle");
});

// A fully-green whole-suite (complete) run reaches the oracle too — the mode no longer gates it.
test("oracle: e2e oracle runs in COMPLETE mode on a fully-green run", async () => {
  const calls: string[] = [];
  const green = {
    sha: "s", verdict: "pass" as const, passed: true,
    cases: [{ name: "a", status: "pass" as const }], logs: "",
  };
  const d = deps(green, calls, { diff: DIFF_4, coverage: [cov([1, 2, 3, 4])], message: "feat: x" });
  await runPipeline(app, "cmp0001", d, "manual", { mode: "complete", runId: "run-orc-cmp" });

  assert.equal(d.oracleCalls.length, 1, "complete mode now reaches the e2e oracle");
  assert.equal(d.oracleCalls[0]!.target, "e2e");
});

test("learning layer: retrieveRules is called before generation in diff mode", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, { diff: DIFF_4, coverage: [cov([1, 2, 3, 4])], message: "feat: add x" });
  let retrieveCalled = false;
  d.retrieveRules = () => {
    retrieveCalled = true;
    return { rules: [], promptSection: "" };
  };
  await runPipeline(app, "ret0001", d, "manual", { mode: "diff", runId: "run-lrn-1" });
  assert.ok(retrieveCalled, "retrieveRules should be called");
});

test("learning layer: learned rules are injected into generation input", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, { diff: DIFF_4, coverage: [cov([1, 2, 3, 4])], message: "feat: add x" });
  d.retrieveRules = () => ({
    rules: [{ id: "rule-1", trigger: "test", action: "assert", errorClass: "E-STATIC" as const, confidence: "low" as const, usageCount: 0, outcomeCount: 0, successRate: null, lastVerified: null, source: "run-1", status: "candidate" as const, at: "" }],
    promptSection: "## Learned rules\n- Do X when Y",
  });
  await runPipeline(app, "ret0001", d, "manual", { mode: "diff", runId: "run-lrn-2" });

  const genInput = d.genInputs[0];
  assert.ok(genInput, "generate should be called");
  assert.ok(genInput.learnedRules, "learnedRules should be set");
  assert.match(genInput.learnedRules!, /Learned rules/);
});

// ── FIX 1b: the value-oracle attribution path threads change-coverage credit ──────────────
// foldValueLearning previously called recordRuleOutcome(ruleId, valueScore) with NO third arg, so
// coverageCreditConfirmed was always null and the Phase-7 coverage-anchored promotion gate never
// fired on the oracle path. These EFFECT tests seed a real candidate (2 prior good outcomes) and
// run the pipeline as the 3rd outcome: with measured coverage + credit it PROMOTES to active;
// with measured coverage + ZERO credit it HOLDS at candidate. The gate firing is the proof the
// credit is threaded (a null credit would have promoted in BOTH cases).
test("FIX 1b: value-oracle attribution PROMOTES a candidate when coverage confirms credit", async () => {
  const { upsertLearningRule, recordRuleOutcome, listAllLearningRules } = await import("./server/history");
  // Unique rule ID per run: the DB persists on disk and upsert is keyed on the PRIMARY KEY `id`
  // (app/status are set-once), so a reused id would keep a stale row's app/status. Make it unique.
  const ruleApp = `fix1b-credit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ruleId = `fix1b-r1-${Math.random().toString(36).slice(2, 10)}`;
  upsertLearningRule({ id: ruleId, app: ruleApp, trigger: "Applies when t", action: "a", errorClass: "E-FALSE-POSITIVE", source: "seed" });
  // Two prior good outcomes WITH credit (so this run's outcome is the 3rd → reaches MIN_OUTCOMES).
  recordRuleOutcome(ruleId, 0.85, true);
  recordRuleOutcome(ruleId, 0.85, true);
  assert.equal(listAllLearningRules(ruleApp, 10).find((r) => r.id === ruleId)?.status, "candidate", "precondition: still candidate before the 3rd outcome");

  const creditApp = { ...app, name: ruleApp };
  const d = deps(passing(), [], { diff: DIFF_4, coverage: [cov([1, 2, 3, 4])], message: "feat: x" });
  // retrieveRules returns the seeded rule's id so the pipeline attributes its oracle outcome to it.
  // The rule has NO archetype — context-directed attribution (Task 7) is fail-open PER RULE, so an
  // untagged legacy rule still receives its oracle outcome (only a rule tagged with a NON-matching
  // archetype is skipped). This guards the common case: most rules predate the archetype field.
  d.retrieveRules = () => ({
    rules: [{ id: ruleId, trigger: "Applies when t", action: "a", errorClass: "E-FALSE-POSITIVE" as const, confidence: "low" as const, usageCount: 0, outcomeCount: 2, successRate: 0.85, lastVerified: null, source: "seed", status: "candidate" as const, at: "" }],
    promptSection: "## Learned rules\n- x",
  });
  await runPipeline(creditApp, "abc1234fix1b1", d, "manual", { mode: "diff", runId: "run-fix1b-1" });

  const after = listAllLearningRules(ruleApp, 10).find((r) => r.id === ruleId);
  assert.equal(after?.outcomeCount, 3, "the pipeline's value-oracle attribution must fold one outcome in");
  assert.equal(after?.status, "active", "measured coverage WITH credit must let the candidate promote (credit threaded)");
});

test("FIX 1b: value-oracle attribution HOLDS a candidate when coverage measured ZERO credit", async () => {
  const { upsertLearningRule, recordRuleOutcome, listAllLearningRules } = await import("./server/history");
  const ruleApp = `fix1b-nocredit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ruleId = `fix1b-r2-${Math.random().toString(36).slice(2, 10)}`;
  upsertLearningRule({ id: ruleId, app: ruleApp, trigger: "Applies when t", action: "a", errorClass: "E-FALSE-POSITIVE", source: "seed" });
  recordRuleOutcome(ruleId, 0.85, true);
  recordRuleOutcome(ruleId, 0.85, true);

  const noCreditApp = { ...app, name: ruleApp };
  // cov([]) → the changed file is measured but ZERO changed lines covered → ratio 0 → credit=false.
  const d = deps(passing(), [], { diff: DIFF_4, coverage: [cov([])], message: "feat: x" });
  // The rule has NO archetype — context-directed attribution (Task 7) is fail-open PER RULE, so the
  // untagged rule still receives its oracle outcome and this test can verify the zero-credit hold gate.
  d.retrieveRules = () => ({
    rules: [{ id: ruleId, trigger: "Applies when t", action: "a", errorClass: "E-FALSE-POSITIVE" as const, confidence: "low" as const, usageCount: 0, outcomeCount: 2, successRate: 0.85, lastVerified: null, source: "seed", status: "candidate" as const, at: "" }],
    promptSection: "## Learned rules\n- x",
  });
  await runPipeline(noCreditApp, "abc1234fix1b2", d, "manual", { mode: "diff", runId: "run-fix1b-2" });

  const after = listAllLearningRules(ruleApp, 10).find((r) => r.id === ruleId);
  assert.equal(after?.outcomeCount, 3, "the outcome is still folded in (only the promotion is gated)");
  assert.equal(after?.status, "candidate", "measured coverage with ZERO credit must HOLD the candidate (gate fired → credit threaded)");
});

// ── Change 2: prevention relevance filter — attributableRules gates the no-oracle path ──────────
// The prevention loop in foldRunLearning now calls attributableRules(retrievedRules, {diffArchetypes})
// instead of iterating ALL retrievedRules. DIFF_4's detectStructuralPatterns yields only ["generic"],
// which does NOT match a rule tagged archetype:"form" but DOES match (fail-open) an untagged rule.
// Proof of the gate: the tagged-non-matching rule's outcomeCount must not increase; the untagged
// rule's outcomeCount must increase by exactly 1.
test("Change 2: prevention path skips non-matching tagged rules, keeps untagged (relevance filter)", async () => {
  const { upsertLearningRule, recordRuleOutcome, listAllLearningRules } = await import("./server/history");

  // Unique app name ensures a clean slate in the real DB.
  const ruleApp = `c2-rel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Rule A: tagged archetype "form" — DIFF_4 yields only "generic", so "form" does NOT match.
  // Expected: outcomeCount stays at 2 after the pipeline run.
  const ruleIdA = `c2-form-${Math.random().toString(36).slice(2, 10)}`;
  upsertLearningRule({ id: ruleIdA, app: ruleApp, trigger: "Applies when form changes", action: "check form", errorClass: "E-FALSE-POSITIVE" as const, source: "seed" });
  recordRuleOutcome(ruleIdA, 0.6, null);
  recordRuleOutcome(ruleIdA, 0.6, null);
  assert.equal(listAllLearningRules(ruleApp, 10).find((r) => r.id === ruleIdA)?.outcomeCount, 2, "precondition: ruleA at 2 outcomes");

  // Rule B: untagged (no archetype) — fail-open: kept by attributableRules.
  // Expected: outcomeCount becomes 3 after the pipeline run.
  const ruleIdB = `c2-untagged-${Math.random().toString(36).slice(2, 10)}`;
  upsertLearningRule({ id: ruleIdB, app: ruleApp, trigger: "Applies when generic changes", action: "check all", errorClass: "E-FALSE-POSITIVE" as const, source: "seed" });
  recordRuleOutcome(ruleIdB, 0.6, null);
  recordRuleOutcome(ruleIdB, 0.6, null);
  assert.equal(listAllLearningRules(ruleApp, 10).find((r) => r.id === ruleIdB)?.outcomeCount, 2, "precondition: ruleB at 2 outcomes");

  const testApp = { ...app, name: ruleApp };
  // DIFF_4 + no coverage → triggers the no-oracle prevention path (valueScore = null).
  // The oracle must return no valueScore so the governance condition (o.valueScore === null) fires.
  const d = deps(passing(), [], { diff: DIFF_4, message: "feat: x" });
  // Override the oracle to produce no valueScore — this is the no-oracle governance path.
  d.runOracle = async () => ({ valueScore: null, mutantCount: 0, killedCount: 0, details: "oracle disabled" });
  // Two retrieved rules: one tagged "form" (non-matching) and one untagged (fail-open).
  d.retrieveRules = () => ({
    rules: [
      { id: ruleIdA, trigger: "Applies when form changes", action: "check form", errorClass: "E-FALSE-POSITIVE" as const, archetype: "form", confidence: "low" as const, usageCount: 0, outcomeCount: 2, successRate: 0.6, lastVerified: null, source: "seed", status: "candidate" as const, at: "" },
      { id: ruleIdB, trigger: "Applies when generic changes", action: "check all", errorClass: "E-FALSE-POSITIVE" as const, archetype: undefined, confidence: "low" as const, usageCount: 0, outcomeCount: 2, successRate: 0.6, lastVerified: null, source: "seed", status: "candidate" as const, at: "" },
    ],
    promptSection: "## Learned rules\n- form\n- untagged",
  });

  await runPipeline(testApp, "c2sha001", d, "manual", { mode: "diff", runId: "run-c2-rel-1" });

  const afterA = listAllLearningRules(ruleApp, 10).find((r) => r.id === ruleIdA);
  const afterB = listAllLearningRules(ruleApp, 10).find((r) => r.id === ruleIdB);

  assert.equal(afterA?.outcomeCount, 2, "tagged 'form' rule must NOT receive outcome (diff is generic, not form)");
  assert.equal(afterB?.outcomeCount, 3, "untagged rule must receive outcome (fail-open: no archetype → always kept)");
});

test("learning layer: reflectAndDistill is NOT called on green passes", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, { diff: DIFF_4, coverage: [cov([1, 2, 3, 4])], message: "feat: add x" });
  let reflectCalled = false;
  d.reflectAndDistill = async () => { reflectCalled = true; return null; };
  await runPipeline(app, "pass001", d, "manual", { mode: "diff", runId: "run-ref-1" });
  assert.equal(reflectCalled, false, "reflectAndDistill should NOT be called on green passes");
});

test("learning layer: reflectAndDistill IS called on failing runs with errorClass", async () => {
  const calls: string[] = [];
  const failed = { sha: "s", verdict: "fail" as const, passed: false, cases: [{ name: "t", status: "fail" as const }], logs: "error" };
  const d = deps(failed, calls);
  let reflectInput: { app: string; runId: string; outcome: RunOutcome } | null = null;
  d.reflectAndDistill = async (input: { app: string; runId: string; outcome: RunOutcome }) => {
    reflectInput = input;
    return null;
  };
  await runPipeline(app, "refFail", d, "manual", { mode: "diff", runId: "run-ref-2" });

  assert.ok(reflectInput, "reflectAndDistill should be called on failures");
  const ri = reflectInput as { app: string; runId: string; outcome: RunOutcome };
  assert.equal(ri.app, "demo");
  assert.equal(ri.runId, "run-ref-2");
  assert.equal(ri.outcome.verdict, "fail");
  assert.equal(ri.outcome.errorClass, "E-EXEC-FAIL");
});

test("learning layer: reflectAndDistill failure is non-blocking", async () => {
  const calls: string[] = [];
  const failed = { sha: "s", verdict: "fail" as const, passed: false, cases: [{ name: "t", status: "fail" as const }], logs: "error" };
  const d = deps(failed, calls);
  d.reflectAndDistill = async () => { throw new Error("LLM timeout"); };
  await runPipeline(app, "refCrash", d, "manual", { mode: "diff", runId: "run-ref-3" });

  assert.equal(d.savedOutcomes[0]!.verdict, "fail", "run should still be recorded as fail despite reflector crash");
});

test("learning layer: reflectAndDistill skipped when errorClass is E-INFRA", async () => {
  const calls: string[] = [];
  const infra = { sha: "s", verdict: "infra-error" as const, passed: false, cases: [], logs: "DEV down" };
  const d = deps(infra, calls);
  let reflectCalled = false;
  d.reflectAndDistill = async () => { reflectCalled = true; return null; };
  await runPipeline(app, "refInfra", d, "manual", { mode: "diff", runId: "run-ref-4" });

  assert.equal(reflectCalled, false, "E-INFRA should not trigger reflection");
});

test("learning layer: reflectAndDistill skipped when errorClass is E-FLAKY", async () => {
  const calls: string[] = [];
  const flaky = { sha: "s", verdict: "flaky" as const, passed: false, cases: [{ name: "t", status: "flaky" as const }], logs: "unstable" };
  const d = deps(flaky, calls);
  let reflectCalled = false;
  d.reflectAndDistill = async () => { reflectCalled = true; return null; };
  await runPipeline(app, "refFlaky", d, "manual", { mode: "diff", runId: "run-ref-5" });

  assert.equal(reflectCalled, false, "E-FLAKY should not trigger reflection");
});

// ── F1: cross-repo runs ─────────────────────────────────────────────────────
// triggerRepo + services[]: the diff/classify/gate come from the SERVICE mirror at the
// event SHA; the suite/publish use the PRIMARY mirror at baseBranch HEAD; the Issue (on
// failure) targets the triggering service repo, not the primary.

const crossApp: AppConfig = {
  name: "shop",
  repo: "org/shop-front",
  baseBranch: "main",
  dev: { baseUrl: "https://dev.shop.io" },
  services: [{ repo: "org/orders-svc", versionUrl: "https://svc/version" }],
  qa: { needsReview: false, testDataPrefix: "qa-shop", shadow: false },
  report: { onFailure: "github-issue" },
};

test("cross-repo: service trigger prepares BOTH mirrors and gates on the service versionUrl", async () => {
  const calls: string[] = [];
  const prepared: string[] = [];
  const gated: string[] = [];
  const h = deps(passing(), calls, { diff: DIFF_4, message: "feat: svc" });
  h.prepare = async (repo: string, sha: string) => { prepared.push(`${repo}@${sha}`); calls.push("prepare"); return { mirrorDir: "/m/svc", diff: DIFF_4, message: "feat: svc" }; };
  h.prepareAtBranch = async (repo: string, branch: string) => { prepared.push(`${repo}#${branch}`); calls.push("prepareAtBranch"); return { mirrorDir: "/m/front" }; };
  h.waitForDeploy = async (target: { versionUrl: string }) => { gated.push(target.versionUrl); calls.push("gate"); };
  await runPipeline(crossApp, "a1b2c3d", h, "webhook", { mode: "diff", triggerRepo: "org/orders-svc", runId: "r1" });
  assert.deepEqual(gated, ["https://svc/version"]);
  assert.ok(prepared.includes("org/orders-svc@a1b2c3d"));
  assert.ok(prepared.includes("org/shop-front#main"));
});

test("cross-repo: a fail opens the Issue in the TRIGGERING service repo", async () => {
  const calls: string[] = [];
  const failed: QaRunResult = { sha: "s", verdict: "fail", passed: false, cases: [{ name: "t", status: "fail" }], logs: "" };
  const h = deps(failed, calls, { diff: DIFF_4, message: "feat: svc" });
  h.prepare = async () => { calls.push("prepare"); return { mirrorDir: "/m/svc", diff: DIFF_4, message: "feat: svc" }; };
  h.prepareAtBranch = async () => { calls.push("prepareAtBranch"); return { mirrorDir: "/m/front" }; };
  const opened: Array<{ repo: string; title: string }> = [];
  h.openIssue = async (repo: string, title: string) => { opened.push({ repo, title }); return { url: "http://issue" }; };
  await runPipeline(crossApp, "a1b2c3d", h, "webhook", { mode: "diff", triggerRepo: "org/orders-svc", runId: "r1" });
  assert.equal(opened.length, 1);
  assert.equal(opened[0]?.repo, "org/orders-svc");
});

test("cross-repo: triggerRepo not declared as a service throws (mis-routed event must be loud)", async () => {
  const h = deps(passing(), []);
  await assert.rejects(
    () => runPipeline(crossApp, "a1b2c3d", h, "webhook", { mode: "diff", triggerRepo: "org/other-svc" }),
    /not a declared service/,
  );
});

test("cross-repo: context mode triggered by a service throws (whole-repo maintenance is not a service event)", async () => {
  const h = deps(passing(), []);
  await assert.rejects(
    () => runPipeline(crossApp, "a1b2c3d", h, "webhook", { mode: "context", triggerRepo: "org/orders-svc" }),
    /context mode cannot be triggered by a service repo/,
  );
});

test("cross-repo: generate receives service {repo, mirrorDir}; change-coverage is skipped", async () => {
  const calls: string[] = [];
  let coverageCalled = false;
  const h = deps(passing(), calls, { diff: DIFF_4, message: "feat: svc" });
  h.prepare = async () => { calls.push("prepare"); return { mirrorDir: "/m/svc", diff: DIFF_4, message: "feat: svc" }; };
  h.prepareAtBranch = async () => { calls.push("prepareAtBranch"); return { mirrorDir: "/m/front" }; };
  h.collectCoverage = async () => { coverageCalled = true; return new Map(); };
  await runPipeline(crossApp, "a1b2c3d", h, "webhook", { mode: "diff", triggerRepo: "org/orders-svc", runId: "r1" });
  const captured = h.genInputs.find((g) => g.service !== undefined);
  assert.equal(captured?.service?.repo, "org/orders-svc");
  assert.equal(captured?.service?.mirrorDir, "/m/svc");
  assert.equal(captured?.mirrorDir, "/m/front");
  assert.equal(coverageCalled, false);
});

// ── F2: multi-service context map ───────────────────────────────────────────
// Context mode mirrors every declared service repo (read-only) and passes them to the
// agent so the resulting context.json joins the front's routes to ALL services' OpenAPI
// operations (ApiOperation.service identifies the owning microservice).

const ctxApp: AppConfig = {
  name: "shop",
  repo: "org/shop-front",
  baseBranch: "main",
  dev: { baseUrl: "https://dev.shop.io" },
  services: [
    { repo: "org/orders-svc", openapi: "api/*.yaml" },
    { repo: "org/payments-svc", baseBranch: "develop" },
  ],
  qa: { needsReview: false, testDataPrefix: "qa-shop", shadow: true },
  report: { onFailure: "github-issue" },
};

test("context mode with services mirrors each service and passes them to generate", async () => {
  const calls: string[] = [];
  const branched: string[] = [];
  const h = deps(passing(), calls);
  h.prepare = async () => ({ mirrorDir: "/m/front", diff: "", message: "chore: ctx" });
  h.prepareAtBranch = async (repo: string, branch: string) => { branched.push(`${repo}#${branch}`); calls.push("prepareAtBranch"); return { mirrorDir: `/m/${repo.split("/")[1]}` }; };
  h.validateContextFn = () => ({ ok: true, errors: [] });
  await runPipeline(ctxApp, "a1b2c3d", h, "manual", { mode: "context", runId: "r1" });
  // No assumption about ordering — only that both services were mirrored at the right branches.
  assert.ok(branched.includes("org/orders-svc#main"));
  assert.ok(branched.includes("org/payments-svc#develop"));
  const captured = h.genInputs.find((g) => g.mode === "context");
  assert.equal(captured?.services?.length, 2);
  const ordersFromInput = captured!.services!.find((s) => s.repo === "org/orders-svc")!;
  assert.equal(ordersFromInput.mirrorDir, "/m/orders-svc");
  assert.equal(ordersFromInput.openapi, "api/*.yaml");
});

test("context mode without services passes no services (unchanged behavior)", async () => {
  const calls: string[] = [];
  const h = deps(passing(), calls);
  h.prepare = async () => ({ mirrorDir: "/m/front", diff: "", message: "chore: ctx" });
  h.validateContextFn = () => ({ ok: true, errors: [] });
  const singleApp: AppConfig = { ...ctxApp, services: undefined };
  await runPipeline(singleApp, "a1b2c3d", h, "manual", { mode: "context", runId: "r1" });
  const captured = h.genInputs.find((g) => g.mode === "context");
  assert.equal(captured?.services, undefined);
});

test("context mode warns (does not fail) when a configured service has no mapped operations", async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  const h = deps(passing(), calls);
  h.prepare = async () => ({ mirrorDir: "/m/front", diff: "", message: "chore: ctx" });
  h.prepareAtBranch = async () => ({ mirrorDir: "/m/svc" });
  h.validateContextFn = () => ({ ok: true, errors: [] });
  h.readBuiltContext = () => ({ builtAtSha: "a1b2c3d", routes: [], api: [], feBe: [] });
  h.log = (m: string) => logs.push(m);
  const singleSvcApp: AppConfig = { ...ctxApp, services: [{ repo: "org/orders-svc" }] };
  const r = await runPipeline(singleSvcApp, "a1b2c3d", h, "manual", { mode: "context", runId: "r1" });
  assert.equal(r.verdict, "pass");
  assert.ok(logs.some((l) => l.includes("no operations for service org/orders-svc")), logs.join("\n"));
});

// ── F4: reviewer corrections → learning rules ───────────────────────────────
// When the reviewer rejects, the run accumulates `reviewerCorrections`. After the final
// decide step, the pipeline distills them into candidate learning rules via the injected
// `distillCorrections` dep. Off-path: a failure logs a warning and never blocks the run.

test("reviewer rejection distills corrections into rules (off-path)", async () => {
  const calls: string[] = [];
  let distilled: { app: string; runId: string; corrections: string[] } | undefined;
  const h = deps(passing(), calls, {
    review: [{ approved: false, corrections: ["no real assertion on the outcome"] }, { approved: false, corrections: ["no real assertion on the outcome"] }],
    diff: DIFF_4, message: "feat: x",
  });
  h.distillCorrections = (input: { app: string; runId: string; corrections: string[] }) => {
    distilled = input;
    return { inserted: ["rule-1"] };
  };
  const appWithReview: AppConfig = {
    ...app,
    qa: { ...app.qa, needsReview: true, shadow: true },
  };
  await runPipeline(appWithReview, "abc1234def", h, "webhook", { mode: "diff", runId: "r1" });
  assert.equal(distilled?.app, appWithReview.name);
  assert.equal(distilled?.runId, "r1");
  assert.ok(distilled?.corrections.includes("no real assertion on the outcome"));
});

test("reviewer-corrections distillation: a thrown error never fails the run", async () => {
  const calls: string[] = [];
  const h = deps(passing(), calls, {
    review: [{ approved: false, corrections: ["x"] }, { approved: false, corrections: ["x"] }],
    diff: DIFF_4, message: "feat: x",
  });
  h.distillCorrections = () => { throw new Error("db locked"); };
  const appWithReview: AppConfig = {
    ...app,
    qa: { ...app.qa, needsReview: true, shadow: true },
  };
  const r = await runPipeline(appWithReview, "abc1234def", h, "webhook", { mode: "diff", runId: "r1" });
  assert.notEqual(r.verdict, "infra-error");
});

// ── Unit 3: fix-loop + progress gate + buildFailureDom ──────────────────────

test("3.3 buildFailureDom: concatenates failureDom from failed cases into labelled fenced blocks", () => {
  const cases: QaCase[] = [
    { name: "owners list", status: "fail", failureDom: "button: Add Owner\ntextbox: Last Name" },
    { name: "owner create", status: "fail", failureDom: "heading: New Owner\ntextbox: First Name" },
  ];
  const result = buildFailureDom(cases);
  assert.ok(result);
  assert.match(result, /### owners list/);
  assert.match(result, /button: Add Owner/);
  assert.match(result, /### owner create/);
  assert.match(result, /heading: New Owner/);
});

test("3.3 buildFailureDom: returns undefined when no cases have failureDom", () => {
  const cases: QaCase[] = [
    { name: "test A", status: "fail" },
    { name: "test B", status: "fail", detail: "timed out" },
  ];
  assert.equal(buildFailureDom(cases), undefined);
});

// CROSS-BOUNDARY (C1): execute.ts now stores failureDom as RAW parseAriaSnapshot output ("role:
// name" lines, NO "- " markers). buildFailureDomLines must split that back into lines WITHOUT
// re-parsing — re-parsing the already-parsed form yields [] (the dead-Lever-2 bug). Feed the exact
// shape parseAriaSnapshot produces and assert the role:name lines survive.
test("3.3 buildFailureDomLines: splits stored parseAriaSnapshot output into its role:name lines", () => {
  // This is exactly what parseAriaSnapshot(...).join("\n") yields (what execute.ts stores).
  const stored = parseAriaSnapshot('- button "Submit"\n- textbox "Email"\n- heading "Login"').join("\n");
  assert.ok(stored.includes("button: Submit"), "precondition: stored value is parsed role:name form");
  const lines = buildFailureDomLines(stored);
  assert.ok(lines.length >= 3, `expected non-empty role:name lines, got ${JSON.stringify(lines)}`);
  assert.ok(lines.some((l) => l === "button: Submit"));
  assert.ok(lines.some((l) => l === "textbox: Email"));
  // Crucially NOT empty — the double-parse bug returned [] here.
  assert.notDeepEqual(lines, []);
});

test("3.3 buildFailureDomLines: drops blank lines", () => {
  assert.deepEqual(buildFailureDomLines("button: Save\n\n  \ntextbox: Name"), ["button: Save", "textbox: Name"]);
});

test("3.3 buildFailureDomLines: returns [] when failureDom is absent", () => {
  assert.deepEqual(buildFailureDomLines(undefined), []);
});

test("3.2 fix-loop: maxRetries=0 disables the loop entirely (no second generate/execute)", async () => {
  const calls: string[] = [];
  const failingRun: QaRunResult = { sha: "s", verdict: "fail", passed: false, cases: [{ name: "x", status: "fail" }], logs: "" };
  const zeroRetryApp: AppConfig = { ...app, qa: { ...app.qa, fixLoop: { maxRetries: 0 } } };
  const d = deps(failingRun, calls);
  // Override execute to always return failing so we can count calls
  let executeCount = 0;
  d.execute = async () => { calls.push("execute"); executeCount++; return failingRun; };
  const run = await runPipeline(zeroRetryApp, "abc123", d);
  // With maxRetries=0, only the initial execute (no retry execute)
  assert.equal(executeCount, 1, `with maxRetries=0, execute should be called once (initial only); got ${executeCount}`);
  // The run should still be fail (no fix attempted)
  assert.equal(run.verdict, "fail");
  // generate called once (initial only), not for a retry
  const generateCount = calls.filter((c) => c === "generate").length;
  assert.equal(generateCount, 1, `generate should be called once (initial only); got ${generateCount}`);
});

test("3.2 fix-loop: maxRetries=2 allows up to 2 retries on persistent failure", async () => {
  const calls: string[] = [];
  const failingRun: QaRunResult = { sha: "s", verdict: "fail", passed: false, cases: [{ name: "x", status: "fail" }], logs: "" };
  // App with 2 retries configured (the new default)
  const twoRetryApp: AppConfig = { ...app, qa: { ...app.qa, fixLoop: { maxRetries: 2 } } };
  const d = deps(failingRun, calls);
  // Progress gate fires on changing failing names to allow spending
  const failingNames = [["x"], ["y"], ["z"]]; // names change each round → gate passes
  let callIdx = 0;
  d.execute = async () => {
    calls.push("execute");
    const names = failingNames[callIdx++ % failingNames.length]!;
    return { sha: "s", verdict: "fail", passed: false, cases: names.map((n) => ({ name: n, status: "fail" as const })), logs: "" };
  };
  await runPipeline(twoRetryApp, "abc123", d);
  const executeCount = calls.filter((c) => c === "execute").length;
  // initial execute + up to 2 retries = up to 3 total executes
  assert.ok(executeCount >= 1 && executeCount <= 3, `execute count should be 1-3; got ${executeCount}`);
});

test("3.6 fix-loop: failureDom is threaded to domSnapshot in the retry generate call", async () => {
  const calls: string[] = [];
  const caseWithDom: QaCase = { name: "owners list", status: "fail", failureDom: "button: Add Owner\ntextbox: Last Name" };
  const failingRun: QaRunResult = { sha: "s", verdict: "fail", passed: false, cases: [caseWithDom], logs: "" };
  const fixedRun: QaRunResult = { sha: "s", verdict: "pass", passed: true, cases: [], logs: "" };
  const oneRetryApp: AppConfig = { ...app, qa: { ...app.qa, fixLoop: { maxRetries: 1 } } };
  const d = deps(failingRun, calls);
  let executeCall = 0;
  d.execute = async () => {
    calls.push("execute");
    return executeCall++ === 0 ? failingRun : fixedRun;
  };
  await runPipeline(oneRetryApp, "abc123", d);
  // Find the retry generate input (second generate call)
  const retryGenInput = d.genInputs.find((gi) => gi.fixCases && gi.fixCases.length > 0);
  assert.ok(retryGenInput, "there should be a retry generate call with fixCases");
  // failureDom from the case should be threaded into domSnapshot
  assert.ok(retryGenInput.domSnapshot, "retry generate input should have domSnapshot from failureDom");
  assert.match(retryGenInput.domSnapshot!, /Add Owner/, "domSnapshot should contain the failure-point DOM");
  // failureSourced should be true since domSnapshot came from failure captures
  assert.equal(retryGenInput.failureSourced, true, "failureSourced should be true when domSnapshot is from failureDom");
});

test("3.x fix-loop: execution retries validate and execute before spending reviewer correction rounds", async () => {
  const calls: string[] = [];
  const failingRun: QaRunResult = {
    sha: "s",
    verdict: "fail",
    passed: false,
    cases: [{ name: "owners list", status: "fail", failureDom: "button: Add Owner" }],
    logs: "",
  };
  const fixedRun: QaRunResult = { sha: "s", verdict: "pass", passed: true, cases: [], logs: "" };
  const oneRetryApp: AppConfig = { ...app, qa: { ...app.qa, needsReview: true, fixLoop: { maxRetries: 1 } } };
  const d = deps(failingRun, calls, {
    agents: [generated, generated],
    review: [
      { approved: true, corrections: [] },
      { approved: true, corrections: [] },
    ],
  });
  let executeCall = 0;
  d.execute = async () => {
    calls.push("execute");
    return executeCall++ === 0 ? failingRun : fixedRun;
  };

  const run = await runPipeline(oneRetryApp, "abc123", d, "manual", { mode: "manual", guidance: "test owner creation" });

  assert.equal(run.verdict, "pass");
  assert.equal(calls.filter((c) => c === "review").length, 2, `expected initial + final review only:\n${calls.join(",")}`);
  const secondGenerate = calls.indexOf("generate", calls.indexOf("execute") + 1);
  const retryValidate = calls.indexOf("validate", secondGenerate + 1);
  const retryExecute = calls.indexOf("execute", secondGenerate + 1);
  const finalReview = calls.indexOf("review", retryExecute + 1);
  assert.ok(secondGenerate >= 0, `expected retry generation:\n${calls.join(",")}`);
  assert.ok(retryValidate > secondGenerate, `retry should validate after generating the fix:\n${calls.join(",")}`);
  assert.ok(retryExecute > retryValidate, `retry should execute after validation:\n${calls.join(",")}`);
  assert.ok(finalReview > retryExecute, `final reviewer should run after the fixed suite passes, not before retry execution:\n${calls.join(",")}`);
});

// RE-3: when qa.sessionContinuity is on AND deps.openGenerator is provided, the run opens ONE
// generator session and the fix-loop CONTINUES it (a follow-up prompt) instead of fresh-generating.
test("RE-3 session continuity: the fix-loop continues one generator session (no fresh re-generate)", async () => {
  const calls: string[] = [];
  const failingRun: QaRunResult = {
    sha: "s", verdict: "fail", passed: false,
    cases: [{ name: "owners list", status: "fail", failureDom: "button: Add Owner" }], logs: "",
  };
  const fixedRun: QaRunResult = { sha: "s", verdict: "pass", passed: true, cases: [], logs: "" };
  const contApp: AppConfig = { ...app, qa: { ...app.qa, needsReview: true, sessionContinuity: true, fixLoop: { maxRetries: 1 } } };
  const d = deps(failingRun, calls, {
    agents: [generated, generated],
    review: [{ approved: true, corrections: [] }, { approved: true, corrections: [] }],
  });
  let sessionGenerates = 0, sessionDisposes = 0, openCount = 0;
  d.openGenerator = async () => {
    openCount++;
    return {
      generate: async () => { sessionGenerates++; calls.push("session.generate"); return generated; },
      dispose: async () => { sessionDisposes++; calls.push("session.dispose"); },
    };
  };
  let executeCall = 0;
  d.execute = async () => { calls.push("execute"); return executeCall++ === 0 ? failingRun : fixedRun; };
  const freshGen = d.generate;
  d.generate = async (...a: Parameters<typeof freshGen>) => { calls.push("FRESH.generate"); return freshGen(...a); };

  const run = await runPipeline(contApp, "abc123", d, "manual", { mode: "manual", guidance: "test owner creation" });

  assert.equal(run.verdict, "pass");
  assert.equal(openCount, 1, `exactly one generator session opened; got ${openCount}`);
  assert.ok(sessionGenerates >= 2, `the session must generate for the initial pass AND the retry; got ${sessionGenerates}`);
  assert.equal(sessionDisposes, 1, `the session is disposed exactly once; got ${sessionDisposes}`);
  assert.ok(!calls.includes("FRESH.generate"), `the fresh-session path must NOT run under continuity:\n${calls.join(",")}`);
});

test("RE-3 session continuity OFF (default): the fresh-session generate path is used, openGenerator untouched", async () => {
  const calls: string[] = [];
  const greenRun: QaRunResult = { sha: "s", verdict: "pass", passed: true, cases: [], logs: "" };
  const d = deps(greenRun, calls, { agents: [generated], review: [{ approved: true, corrections: [] }] });
  let opened = 0;
  d.openGenerator = async () => { opened++; return { generate: async () => generated, dispose: async () => {} }; };

  await runPipeline(app, "abc123", d, "manual", { mode: "manual", guidance: "x" });

  assert.equal(opened, 0, "openGenerator must NOT be called when sessionContinuity is off (default)");
  assert.ok(calls.includes("generate"), "the fresh-session generate path is used");
});

test("3.6 fix-loop: absent failureDom degrades gracefully (no domSnapshot, blind fix fallback)", async () => {
  const calls: string[] = [];
  const caseWithoutDom: QaCase = { name: "owners list", status: "fail", detail: "element not found" };
  const failingRun: QaRunResult = { sha: "s", verdict: "fail", passed: false, cases: [caseWithoutDom], logs: "" };
  const oneRetryApp: AppConfig = { ...app, qa: { ...app.qa, fixLoop: { maxRetries: 1 } } };
  const d = deps(failingRun, calls);
  let executeCall = 0;
  d.execute = async () => {
    calls.push("execute");
    executeCall++;
    return failingRun; // always fail so the loop runs
  };
  await runPipeline(oneRetryApp, "abc123", d);
  const retryGenInput = d.genInputs.find((gi) => gi.fixCases && gi.fixCases.length > 0);
  assert.ok(retryGenInput, "there should be a retry generate call with fixCases");
  // Without failureDom, domSnapshot should be absent (blind fix)
  assert.ok(!retryGenInput.domSnapshot, "without failureDom, domSnapshot should be absent (blind fix)");
  assert.ok(!retryGenInput.failureSourced, "failureSourced should be absent/falsy when no failureDom available");
});

test("3.x fix-loop: the retry RE-EXECUTES under a fresh per-attempt namespace (no self-pollution)", async () => {
  // Apps whose backend cannot delete created data (e.g. Spring PetClinic) self-collide if a retry
  // re-executes under the SAME namespace: the second run re-creates "qa-bot-<ns>-owner" and a verify
  // assertion hits TWO matches → strict-mode → a CORRECT spec is masked as fail. The retry must use a
  // per-attempt namespace so each attempt's data is uniquely scoped.
  const calls: string[] = [];
  const failingRun: QaRunResult = { sha: "s", verdict: "fail", passed: false, cases: [{ name: "owners", status: "fail", failureDom: "button: Submit" }], logs: "" };
  const fixedRun: QaRunResult = { sha: "s", verdict: "pass", passed: true, cases: [], logs: "" };
  const oneRetryApp: AppConfig = { ...app, qa: { ...app.qa, fixLoop: { maxRetries: 1 } } };
  const d = deps(failingRun, calls);
  const execNamespaces: string[] = [];
  let executeCall = 0;
  d.execute = async (_dir: string, opts: { namespace: string }) => {
    execNamespaces.push(opts.namespace);
    return executeCall++ === 0 ? failingRun : fixedRun;
  };
  await runPipeline(oneRetryApp, "abc123", d);
  assert.equal(execNamespaces.length, 2, "expected an initial execute + one retry execute");
  assert.notEqual(execNamespaces[1], execNamespaces[0], "the retry must use a DIFFERENT namespace than the initial run");
  assert.equal(execNamespaces[1], `${execNamespaces[0]}-r1`, "the retry namespace is the run namespace suffixed with the attempt index");
});

// CROSS-BOUNDARY (W1): the regression guard must keep the BEST executed run, not the terminal one.
// Sequence: initial 2 failures → retry1 1 failure (better) → retry2 3 failures (worse). The earlier
// 1-failure run must be restored as the verdict — the worse final retry is discarded. Before the
// fix, the guard ran at the loop TOP comparing the already-assigned `run`, so the terminal regression
// shipped.
test("3.x fix-loop W1: a worse final retry is discarded for an earlier better run", async () => {
  const calls: string[] = [];
  const noReviewApp: AppConfig = { ...app, qa: { ...app.qa, needsReview: false, fixLoop: { maxRetries: 2 } } };
  const runs: QaRunResult[] = [
    { sha: "s", verdict: "fail", passed: false, cases: [{ name: "x", status: "fail" }, { name: "y", status: "fail" }], logs: "" }, // initial: 2
    { sha: "s", verdict: "fail", passed: false, cases: [{ name: "x", status: "fail" }], logs: "" }, // retry1: 1 (BEST)
    { sha: "s", verdict: "fail", passed: false, cases: [{ name: "x", status: "fail" }, { name: "y", status: "fail" }, { name: "z", status: "fail" }], logs: "" }, // retry2: 3 (worse)
  ];
  const d = deps(runs[0]!, calls, { agents: [generated, generated, generated] });
  let i = 0;
  d.execute = async () => { calls.push("execute"); return runs[Math.min(i++, runs.length - 1)]!; };
  const final = await runPipeline(noReviewApp, "abc123", d);
  // The restored run is the 1-failure round, NOT the 3-failure terminal retry.
  assert.equal(final.cases.filter((c) => c.status === "fail").length, 1, `expected the best (1-failure) run restored, got ${final.cases.length} failing`);
  assert.ok(final.cases.some((c) => c.name === "x"));
  assert.ok(!final.cases.some((c) => c.name === "z"), "the worse terminal retry (with z) must not ship");
});

// CROSS-BOUNDARY (C4): the real-bug branch must NOT fire when a checked selector is ABSENT from the
// failure tree. An absent selector means the test may simply be looking at the wrong element — not a
// proven app defect. We give a failed case a real failureDom (button role present, but no "Submit")
// and a value-mismatch detail, write a spec that uses the absent getByRole, and assert the loop
// REGENERATES (threading the absent contradiction into the prompt via the dedicated, un-truncated
// selectorContradictions field — W1, NOT folded into the 500-char-sliced fixCases detail) instead of
// short-circuiting to an Issue via the real-bug branch.
test("3.x fix-loop C4: real-bug branch does NOT fire when a selector is verifiably absent", async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  // failureDom is the stored parseAriaSnapshot form: button role IS present (Cancel), but no "Submit".
  const failureDom = parseAriaSnapshot('- button "Cancel"\n- heading "Owner"').join("\n");
  const failing: QaRunResult = {
    sha: "s", verdict: "fail", passed: false,
    cases: [{ name: "owners.spec.ts › create", status: "fail", detail: "expect(received).toBe(expected)\nExpected: 'Saved'\nReceived: 'Error'", failureDom }],
    logs: "",
  };
  const noReviewApp: AppConfig = { ...app, qa: { ...app.qa, needsReview: false, fixLoop: { maxRetries: 1 } } };
  const d = deps(failing, calls, { agents: [generated, generated] });
  d.log = (m: string) => logs.push(m);
  // Write the spec the Lever-2 check reads (result.specs = ["a.spec.ts"]): it uses an ABSENT selector
  // — getByRole("button", { name: "Submit" }) — whose role IS in the tree (button) but whose name is
  // not, so the check classifies it verifiable-absent (not unverifiable, not present-and-unique).
  writeFileSync(join(d.mirrorDir, "e2e", "a.spec.ts"), `import { test } from "./fixtures";\ntest("create", async ({ page }) => {\n  await page.getByRole("button", { name: "Submit" }).click();\n});\n`);
  d.execute = async () => { calls.push("execute"); return failing; };
  await runPipeline(noReviewApp, "abc123", d);
  // The loop reached regeneration with the absent contradiction threaded in (so it did NOT break early
  // via the real-bug branch). W1: the contradiction now travels in its OWN selectorContradictions field
  // (un-truncated), NOT folded into the fixCases detail (which the prompt slices to 500 chars).
  const retryGen = d.genInputs.find((gi) => gi.selectorContradictions?.some((c) => c.includes("is NOT in the captured")));
  assert.ok(retryGen, `expected a regeneration carrying the absent-selector contradiction in selectorContradictions; gen inputs: ${d.genInputs.length}`);
  // The contradiction must NOT be folded into the truncated fixCases detail anymore (W1).
  assert.ok(
    !d.genInputs.some((gi) => gi.fixCases?.some((c) => (c.detail ?? "").includes("LEVER-2 SELECTOR CONTRADICTIONS"))),
    "the contradiction must no longer be folded into the fixCases detail (it would be truncated there)",
  );
  // And the real-bug log line must NOT have fired.
  assert.ok(!logs.some((l) => /real-bug branch/i.test(l)), `real-bug branch must not fire on an absent selector:\n${logs.filter((l) => /real-bug/i.test(l)).join("\n")}`);
});

// CROSS-BOUNDARY (W5): the real-bug branch must NOT fire when the spec uses a NON-EXTRACTABLE locator
// (getByTestId/.locator()/getByPlaceholder/…). Lever-2 only extracts getByRole/Text/Label, so a
// decorative present-unique getByRole would make allUnique true while the ACTUAL failing locator is
// the unseen getByTestId — a value mismatch then fires a BOGUS "app defect" Issue. The spec below has
// a present-unique getByRole("button", { name: "Add Owner" }) (in the tree) AND a getByTestId; with a
// value-mismatch failure, the branch must stay closed and the loop must regenerate instead.
test("3.x fix-loop W5: real-bug branch does NOT fire when the spec has a non-extractable locator", async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  // The tree contains the getByRole target (present + unique). getByTestId is invisible to the a11y tree.
  const failureDom = parseAriaSnapshot('- button "Add Owner"\n- heading "Owners"').join("\n");
  const failing: QaRunResult = {
    sha: "s", verdict: "fail", passed: false,
    cases: [{ name: "owners.spec.ts › create", status: "fail", detail: "expect(received).toHaveText(expected)\nExpected: 'Saved'\nReceived: 'Error'", failureDom }],
    logs: "",
  };
  const noReviewApp: AppConfig = { ...app, qa: { ...app.qa, needsReview: false, fixLoop: { maxRetries: 1 } } };
  const d = deps(failing, calls, { agents: [generated, generated] });
  d.log = (m: string) => logs.push(m);
  // The spec uses a PRESENT-UNIQUE getByRole (decorative — present in the tree) AND a getByTestId
  // (the actual failing locator, invisible to Lever-2). allUnique must be held indeterminate.
  writeFileSync(
    join(d.mirrorDir, "e2e", "a.spec.ts"),
    `import { test, expect } from "./fixtures";\n` +
      `test("create", async ({ page }) => {\n` +
      `  await page.getByRole("button", { name: "Add Owner" }).click();\n` +
      `  await expect(page.getByTestId("flash")).toHaveText("Saved");\n` +
      `});\n`,
  );
  d.execute = async () => { calls.push("execute"); return failing; };
  await runPipeline(noReviewApp, "abc123", d);
  // The branch must NOT have fired (the non-extractable getByTestId makes uniqueness indeterminate).
  assert.ok(!logs.some((l) => /real-bug branch/i.test(l)), `real-bug branch must not fire with a non-extractable locator:\n${logs.filter((l) => /real-bug/i.test(l)).join("\n")}`);
  // It should have proceeded to regenerate (a second generate call beyond the initial one).
  assert.ok(d.genInputs.length >= 2, `expected the loop to regenerate, got ${d.genInputs.length} generate call(s)`);
});

// CONTROL for W5: the SAME value-mismatch + present-unique getByRole, but with NO non-extractable
// locator, MUST fire the real-bug branch — proving the W5 guard is the only thing suppressing it
// above (not some unrelated condition). This is the design's intended Lever-3 motivating path.
test("3.x fix-loop W5 control: real-bug branch DOES fire when every locator is extractable + unique", async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  const failureDom = parseAriaSnapshot('- button "Add Owner"\n- heading "Owners"').join("\n");
  const failing: QaRunResult = {
    sha: "s", verdict: "fail", passed: false,
    cases: [{ name: "owners.spec.ts › create", status: "fail", detail: "expect(received).toHaveText(expected)\nExpected: 'Saved'\nReceived: 'Error'", failureDom }],
    logs: "",
  };
  const issueApp: AppConfig = { ...app, qa: { ...app.qa, needsReview: false, fixLoop: { maxRetries: 1 } } };
  const d = deps(failing, calls, { agents: [generated, generated] });
  d.log = (m: string) => logs.push(m);
  // Only extractable, present-unique locators → allUnique true → value mismatch → real-bug fires.
  writeFileSync(
    join(d.mirrorDir, "e2e", "a.spec.ts"),
    `import { test, expect } from "./fixtures";\n` +
      `test("create", async ({ page }) => {\n` +
      `  await page.getByRole("button", { name: "Add Owner" }).click();\n` +
      `  await expect(page.getByRole("heading", { name: "Owners" })).toHaveText("Saved");\n` +
      `});\n`,
  );
  d.execute = async () => { calls.push("execute"); return failing; };
  await runPipeline(issueApp, "abc123", d);
  assert.ok(logs.some((l) => /adjudicator.*app_defect/i.test(l)), `adjudicator must classify as app_defect when all locators are extractable + unique:\n${logs.join("\n")}`);
});

// CROSS-BOUNDARY (W3): the real-bug branch must NOT fire when a failing case's spec contains an
// UNVERIFIABLE selector — one whose role is in NO captured tree (so it is neither present nor
// verifiable-absent, falling through both Lever-2 branches). A single decorative present-unique
// getByRole would otherwise set anyVerifiedPresent and make allUnique true → a bogus "app defect"
// Issue (newly reachable once C2 classifies the toHaveText failure as value-mismatch). The tree below
// has button+heading but NO textbox; the spec uses a present-unique getByRole("button") AND an
// unverifiable getByRole("textbox", { name: "Email" }). allUnique must be held false → loop regenerates.
test("3.x fix-loop W3: real-bug branch does NOT fire when a failing selector is unverifiable", async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  // textbox is NOT in this tree → getByRole("textbox", …) is unverifiable (role absent entirely).
  const failureDom = parseAriaSnapshot('- button "Add Owner"\n- heading "Owners"').join("\n");
  const failing: QaRunResult = {
    sha: "s", verdict: "fail", passed: false,
    cases: [{ name: "owners.spec.ts › create", status: "fail", detail: "expect(received).toHaveText(expected)\nExpected: 'Saved'\nReceived: 'Error'", failureDom }],
    logs: "",
  };
  const noReviewApp: AppConfig = { ...app, qa: { ...app.qa, needsReview: false, fixLoop: { maxRetries: 1 } } };
  const d = deps(failing, calls, { agents: [generated, generated] });
  d.log = (m: string) => logs.push(m);
  // Decorative present-unique getByRole("button", …) (in the tree) + an UNVERIFIABLE getByRole(
  // "textbox", …) whose role never appears in the tree. The latter must force allUnique false (W3).
  writeFileSync(
    join(d.mirrorDir, "e2e", "a.spec.ts"),
    `import { test, expect } from "./fixtures";\n` +
      `test("create", async ({ page }) => {\n` +
      `  await page.getByRole("button", { name: "Add Owner" }).click();\n` +
      `  await page.getByRole("textbox", { name: "Email" }).fill("x@y.z");\n` +
      `  await expect(page.getByRole("heading", { name: "Owners" })).toHaveText("Saved");\n` +
      `});\n`,
  );
  d.execute = async () => { calls.push("execute"); return failing; };
  await runPipeline(noReviewApp, "abc123", d);
  // The branch must NOT have fired (the unverifiable textbox selector makes uniqueness indeterminate).
  assert.ok(!logs.some((l) => /real-bug branch/i.test(l)), `real-bug branch must not fire with an unverifiable selector:\n${logs.filter((l) => /real-bug/i.test(l)).join("\n")}`);
  // It should have proceeded to regenerate instead (a second generate call beyond the initial one).
  assert.ok(d.genInputs.length >= 2, `expected the loop to regenerate, got ${d.genInputs.length} generate call(s)`);
});

// ── Write-confinement guard wiring ────────────────────────────────────────────

// Task 4.3: verify the confine dep is called exactly once per run, the result lands
// in gateSignals.confinement, and the run is non-blocking (published === true, verdict unchanged).

test("confinement: stub returning { strays:1, dangerous:0, reverted:[\"foo.md\"] } is called once and persisted", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls);
  let confineCalls = 0;
  const confinementResult = { strays: 1, dangerous: 0, reverted: ["foo.md"] };
  (d as PipelineDeps).confine = async (_mirrorDir, _isCode) => {
    confineCalls++;
    return confinementResult;
  };
  await runPipeline(app, "abc1234def", d, "manual", { mode: "diff", runId: "run-confine-1" });
  assert.equal(confineCalls, 1, "confine should be called exactly once");
  assert.ok(d.savedOutcomes.length > 0, "outcome must be persisted");
  const outcome = d.savedOutcomes[0]!;
  assert.deepEqual(outcome.gateSignals.confinement, confinementResult);
  assert.ok(d.published, "run should still publish — confinement is non-blocking");
  assert.equal(outcome.verdict, "pass");
});

test("confinement: clean result { strays:0, dangerous:0, reverted:[] } is ALWAYS set on gateSignals when dep is wired (LOCKED DECISION)", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls);
  const cleanResult = { strays: 0, dangerous: 0, reverted: [] as string[] };
  (d as PipelineDeps).confine = async () => cleanResult;
  await runPipeline(app, "abc1234def", d, "manual", { mode: "diff", runId: "run-confine-clean" });
  assert.ok(d.savedOutcomes.length > 0, "outcome must be persisted");
  const outcome = d.savedOutcomes[0]!;
  // LOCKED DECISION: even a zero-stray result is written to the signal when the dep was wired.
  assert.deepEqual(
    outcome.gateSignals.confinement,
    cleanResult,
    "a clean confinement result must be present on gateSignals, not undefined",
  );
  assert.ok(d.published, "clean run must still publish");
});

test("confinement: absent dep leaves gateSignals.confinement undefined", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls);
  // No confine dep wired (the default test harness does not include one).
  assert.equal((d as PipelineDeps).confine, undefined, "test harness must not have confine by default");
  await runPipeline(app, "abc1234def", d, "manual", { mode: "diff", runId: "run-confine-absent" });
  assert.ok(d.savedOutcomes.length > 0);
  const outcome = d.savedOutcomes[0]!;
  assert.equal(outcome.gateSignals.confinement, undefined, "gateSignals.confinement must be absent when dep is not wired");
});

test("confinement: verdict is unchanged by a stray — dangerous stray does not become 'invalid'", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls);
  (d as PipelineDeps).confine = async () => ({ strays: 1, dangerous: 1, reverted: [".env.local"] });
  const run = await runPipeline(app, "abc1234def", d, "manual", { mode: "diff", runId: "run-confine-danger" });
  assert.equal(run.verdict, "pass", "a dangerous stray must not change the verdict to invalid");
  assert.ok(d.published, "run must still publish despite a dangerous stray");
});

test("confinement: runs + persists on the static-gate INVALID early return (post-generation exit)", async () => {
  const calls: string[] = [];
  // Failing validation kills the run at the static gate (a post-generation exit). The agent ran,
  // so confinement must still execute there and the result must reach the persisted outcome.
  const d = deps(passing(), calls, { validation: { ok: false, errors: ["tsc failed"], infra: false } });
  let confineCalls = 0;
  const confinementResult = { strays: 1, dangerous: 0, reverted: ["stray.md"] };
  (d as PipelineDeps).confine = async () => {
    confineCalls++;
    return confinementResult;
  };
  const run = await runPipeline(app, "abc1234def", d, "manual", { mode: "diff", runId: "run-confine-invalid" });
  assert.equal(run.verdict, "invalid");
  assert.ok(confineCalls >= 1, "confine must run on the static-invalid exit");
  const outcome = d.savedOutcomes[0]!;
  assert.deepEqual(outcome.gateSignals.confinement, confinementResult, "confinement must be persisted on the invalid exit");
});

test("confinement + usage: both persist on the health pre-flight INFRA-ERROR early return", async () => {
  const calls: string[] = [];
  // DEV unhealthy at the pre-flight (the first isHealthy call in this flow; the gate uses the
  // waitForDeploy stub) → infra-error, a post-generation exit. Tokens were spent during generation.
  const d = deps(passing(), calls, { healthy: false });
  let confineCalls = 0;
  const confinementResult = { strays: 0, dangerous: 0, reverted: [] as string[] };
  (d as PipelineDeps).confine = async () => {
    confineCalls++;
    return confinementResult;
  };
  (d as PipelineDeps).generate = async (_input, _signal, _onProgress, onUsage) => {
    calls.push("generate");
    onUsage?.({ input: 70, output: 30, reasoning: 10, cacheRead: 0, cacheWrite: 0, cost: 0.002 });
    return generated;
  };
  const run = await runPipeline(app, "abc1234def", d, "manual", { mode: "diff", runId: "run-confine-infra" });
  assert.equal(run.verdict, "infra-error");
  assert.ok(confineCalls >= 1, "confine must run on the health pre-flight infra-error exit");
  const outcome = d.savedOutcomes[0]!;
  assert.deepEqual(outcome.gateSignals.confinement, confinementResult, "confinement must be present on the infra-error exit");
  // usage: tokens were spent before the pre-flight, so they must be recorded on the infra-error exit.
  assert.ok(outcome.gateSignals.usage !== undefined, "usage must be persisted on the infra-error exit");
  assert.equal(outcome.gateSignals.usage.tokens.input, 70);
});

// F1: the agent no-op exit (approved + zero specs) is a post-generation exit — the agent ran
// (tokens spent) and may have written strays, so confine must run AND the outcome must persist
// confinement + usage. The verdict stays `skipped` (confinement is non-blocking).
test("confinement + usage: the no-op (approved, zero specs) exit confines once and persists both, verdict stays skipped", async () => {
  const calls: string[] = [];
  const noop: AgentResult = { output: "the change needs no tests", specs: [], reviewed: true, approved: true };
  const d = deps(passing(), calls, { agent: noop });
  let confineCalls = 0;
  const confinementResult = { strays: 1, dangerous: 0, reverted: ["stray.md"] };
  (d as PipelineDeps).confine = async () => {
    confineCalls++;
    return confinementResult;
  };
  // The agent spends tokens even on a no-op — fire a usage snapshot from generate.
  (d as PipelineDeps).generate = async (_input, _signal, _onProgress, onUsage) => {
    calls.push("generate");
    onUsage?.({ input: 42, output: 10, reasoning: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001 });
    return noop;
  };
  const run = await runPipeline(app, "abc1234def", d, "manual", { mode: "diff", runId: "run-confine-noop" });
  assert.equal(run.verdict, "skipped", "a no-op is still a clean skipped verdict");
  assert.equal(confineCalls, 1, "confine must run exactly once on the no-op exit");
  // It is a no-op: nothing should have been validated, executed or published.
  assert.ok(!calls.includes("validate"));
  assert.ok(!calls.includes("execute"));
  assert.equal(d.published, false);
  assert.ok(d.savedOutcomes.length > 0, "the no-op outcome must be persisted (runId given)");
  const outcome = d.savedOutcomes[0]!;
  assert.equal(outcome.verdict, "skipped");
  assert.deepEqual(outcome.gateSignals.confinement, confinementResult, "confinement must be persisted on the no-op exit");
  assert.ok(outcome.gateSignals.usage !== undefined, "usage must be persisted on the no-op exit");
  assert.equal(outcome.gateSignals.usage.tokens.input, 42, "the tokens spent on the no-op generation are recorded");
});

// F2: in `enforce` mode a coverage gap triggers a SECOND generation that can write fresh strays.
// Confine must run AFTER that regeneration (and before publish), so a stray from the regen is
// reverted and the persisted confinement is fresh — not the stale pre-regen snapshot.
test("confinement (enforce): runs AFTER the coverage-gap regeneration, reverts its stray before publish, persists fresh", async () => {
  const calls: string[] = [];
  // First generate; the improvement regen closes the gap (full coverage on the 2nd collect) → publishes.
  const d = deps(passing(), calls, { diff: DIFF_4, agents: [generated, generated], coverage: [cov([1]), cov([1, 2, 3, 4])] });
  let confineCalls = 0;
  const confinementResult = { strays: 1, dangerous: 0, reverted: ["enforce-regen-stray.md"] };
  (d as PipelineDeps).confine = async () => {
    confineCalls++;
    calls.push("confine");
    return confinementResult;
  };
  await runPipeline(covApp("enforce"), "abc1234def", d, "manual", { mode: "diff", runId: "run-confine-enforce" });
  assert.equal(confineCalls, 1, "confine must run exactly once on the green path");
  assert.equal(d.published, true, "the gap was closed → the suite publishes");
  // Ordering: the SECOND generate (the enforce regen) must precede confine, which must precede publish.
  const generateIdxs = calls.map((c, i) => (c === "generate" ? i : -1)).filter((i) => i >= 0);
  assert.ok(generateIdxs.length >= 2, `expected >=2 generate calls (initial + enforce regen), got ${generateIdxs.length}: ${calls.join(",")}`);
  const secondGenerate = generateIdxs[1]!;
  const confineIdx = calls.indexOf("confine");
  const publishIdx = calls.indexOf("publish");
  assert.ok(confineIdx > secondGenerate, `confine (${confineIdx}) must run AFTER the enforce regen generate (${secondGenerate}): ${calls.join(",")}`);
  assert.ok(publishIdx > confineIdx, `publish (${publishIdx}) must run AFTER confine (${confineIdx}): ${calls.join(",")}`);
  // The persisted confinement is the one captured on THIS (post-regen) pass — fresh, not stale.
  const outcome = d.savedOutcomes.at(-1)!;
  assert.deepEqual(outcome.gateSignals.confinement, confinementResult, "the fresh post-regen confinement must be persisted");
});

// ── Usage accumulator wiring ───────────────────────────────────────────────────

// Test A: stub generate fires N snapshots → gateSignals.usage equals summed RunUsage.
test("usage: stub generate fires 2 snapshots → gateSignals.usage equals summed RunUsage", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls);
  // Wire generate to call onUsage twice with known values.
  (d as PipelineDeps).generate = async (_input, _signal, _onProgress, onUsage) => {
    calls.push("generate");
    onUsage?.({ input: 100, output: 50, reasoning: 20, cacheRead: 5, cacheWrite: 3, cost: 0.001 });
    onUsage?.({ input: 200, output: 80, reasoning: 30, cacheRead: 10, cacheWrite: 2, cost: 0.002 });
    return generated;
  };
  await runPipeline(app, "abc1234def", d, "manual", { mode: "diff", runId: "run-usage-1" });
  assert.ok(d.savedOutcomes.length > 0, "outcome must be persisted");
  const usage = d.savedOutcomes[0]!.gateSignals.usage;
  assert.ok(usage !== undefined, "usage must be set when snapshots were fired");
  assert.equal(usage.tokens.input, 300);
  assert.equal(usage.tokens.output, 130);
  assert.equal(usage.tokens.reasoning, 50);
  assert.equal(usage.tokens.total, 300 + 130 + 50);
  assert.ok(Math.abs((usage.cost ?? 0) - 0.003) < 1e-9, `expected cost ~0.003, got ${usage.cost}`);
  // Verdict must be unchanged — usage is observation-only.
  assert.equal(d.savedOutcomes[0]!.verdict, "pass");
});

// Test B: onUsage never fired → gateSignals.usage undefined.
test("usage: onUsage never fired → gateSignals.usage undefined", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls);
  // Default test harness does not call onUsage in generate.
  await runPipeline(app, "abc1234def", d, "manual", { mode: "diff", runId: "run-usage-absent" });
  assert.ok(d.savedOutcomes.length > 0);
  assert.equal(d.savedOutcomes[0]!.gateSignals.usage, undefined, "usage must be absent when no snapshots fired");
});

// Test C: verdict and published are IDENTICAL with and without usage — observation-only lock.
test("usage: verdict and published are identical with and without usage (observation-only lock)", async () => {
  const calls1: string[] = [];
  const d1 = deps(passing(), calls1);
  await runPipeline(app, "abc1234def", d1, "manual", { mode: "diff", runId: "run-usage-obs-no" });

  const calls2: string[] = [];
  const d2 = deps(passing(), calls2);
  (d2 as PipelineDeps).generate = async (_input, _signal, _onProgress, onUsage) => {
    calls2.push("generate");
    onUsage?.({ input: 500, output: 200, reasoning: 100, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
    return generated;
  };
  await runPipeline(app, "abc1234def", d2, "manual", { mode: "diff", runId: "run-usage-obs-yes" });

  assert.equal(d1.savedOutcomes[0]!.verdict, d2.savedOutcomes[0]!.verdict, "verdict must be identical");
  assert.equal(d1.published, d2.published, "published must be identical");
});

// ── Phase 6a: shared iteration cycle counter ──────────────────────────────────
// The counter `cycleCount` is shared across all four regeneration loops (review for-loop,
// static-fix while, exec-fix for-loop, coverage-enforce if) plus the two in-session
// contract-repair re-prompts. A ceiling (qa.iterationBudget) stops any further
// generateAndReview() call once reached and logs the reason.
//
// generateParallel workers are intentionally NOT counted — they are bounded by their own
// per-session timeout (OPENCODE_TIMEOUT_MS), not by iterated loops. This is by design.

// Test 6a-1: Default behaviour unchanged — no iterationBudget → the derived runaway backstop
// (24 for the default maxRetries=2) applies, far above a normal single-generation run (1 cycle),
// so it never triggers and the run still publishes.
test("phase-6a: default behaviour unchanged when iterationBudget is not configured", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls);
  const result = await runPipeline(app, "abc1234def", d);
  assert.equal(result.verdict, "pass", "run should pass unchanged with no iterationBudget");
  assert.ok(d.published, "suite should be published as normal");
  const genCount = calls.filter((c) => c === "generate").length;
  assert.equal(genCount, 1, `only one generate call expected; got ${genCount}`);
});

// Test 6a-2: Ceiling halts regeneration — with iterationBudget=1, the FIRST generateAndReview
// call consumes the budget; the static-fix loop's second call is blocked.
test("phase-6a: ceiling halts the static-fix regeneration loop when iterationBudget=1", async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  // Validation always fails so the static-fix loop would normally iterate MAX_STATIC_FIX_ROUNDS.
  // With budget=1 the first generateAndReview exhausts the counter; the loop must stop.
  const budgetApp: AppConfig = { ...app, qa: { ...app.qa, needsReview: false, iterationBudget: 1 } };
  const d = deps(passing(), calls, { validation: { ok: false, errors: ["tsc: error"], infra: false } });
  d.log = (m: string) => logs.push(m);
  await runPipeline(budgetApp, "abc1234def", d);
  const genCount = calls.filter((c) => c === "generate").length;
  // Budget=1: the initial generateAndReview is allowed (cycle 1); the static-fix loop's
  // generateAndReview hits the ceiling (cycle 2 > 1) and returns without calling generate.
  assert.equal(genCount, 1, `only the initial generate should fire with budget=1; got ${genCount}`);
  assert.ok(
    logs.some((l) => /cycle-ceiling reached/i.test(l)),
    `expected a cycle-ceiling log; got:\n${logs.join("\n")}`,
  );
});

// Test 6a-3: Under-budget run — with iterationBudget=10, a run with review rejection + regen
// is not affected (cycles 1-2 are within budget=10).
test("phase-6a: under-budget run with review rejection is unaffected by the ceiling", async () => {
  const calls: string[] = [];
  const budgetApp: AppConfig = { ...app, qa: { ...app.qa, iterationBudget: 10 } };
  // Two review calls: first rejects (triggers regeneration), second approves.
  const d = deps(passing(), calls, {
    review: [
      { approved: false, corrections: ["fix selector"], parsed: true },
      { approved: true, corrections: [], parsed: true },
    ],
  });
  const result = await runPipeline(budgetApp, "abc1234def", d);
  assert.equal(result.verdict, "pass", "under-budget run should still pass");
  assert.ok(d.published, "suite should still be published");
  // Two generate calls: initial + review-rejection regen (all within budget=10)
  const genCount = calls.filter((c) => c === "generate").length;
  assert.equal(genCount, 2, `initial + review-regen = 2 generate calls; got ${genCount}`);
});

// Test 6a-4: Ceiling spans multiple loops — budget=2 is consumed by initial generation
// + review-rejection regen; the exec-fix loop's generateAndReview is then blocked.
test("phase-6a: ceiling spans review loop and exec-fix loop (shared counter)", async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  // Budget=2: generation (cycle 1) + review-rejection regen (cycle 2) fill the budget.
  // The run passes the reviewer on round 2 but then the exec fails.
  // The exec-fix loop's generateAndReview would be cycle 3 → blocked by ceiling.
  const budgetApp: AppConfig = { ...app, qa: { ...app.qa, iterationBudget: 2 } };
  const failingRun: QaRunResult = { sha: "s", verdict: "fail", passed: false, cases: [{ name: "x", status: "fail", detail: "timeout" }], logs: "" };
  const d = deps(failingRun, calls, {
    review: [
      { approved: false, corrections: ["fix it"], parsed: true },
      { approved: true, corrections: [], parsed: true },
    ],
  });
  d.log = (m: string) => logs.push(m);
  const result = await runPipeline(budgetApp, "abc1234def", d);
  // The ceiling should have blocked the exec-fix regeneration.
  const genCount = calls.filter((c) => c === "generate").length;
  // cycle 1: initial generate, cycle 2: review-regen (mid-review-loop path)
  // cycle 3: exec-fix generate → blocked → only 2 generate calls total.
  assert.equal(genCount, 2, `budget=2 should allow initial + review-regen only; got ${genCount}`);
  assert.ok(
    logs.some((l) => /cycle-ceiling reached/i.test(l)),
    `expected a cycle-ceiling log for exec-fix block; got:\n${logs.join("\n")}`,
  );
  // Run should conclude with the last available state (fail, since exec failed and no regen happened)
  assert.equal(result.verdict, "fail", "run should conclude with last available verdict when ceiling is hit");
});

// Test 6a-5: Repair callbacks increment the counter — onRepair fires and cycleCount advances.
// Verified via the log: a repair log line appears when onRepair is invoked.
test("phase-6a: onRepair callback increments cycleCount and logs the event", async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  // Budget=1: the initial generateAndReview consumes cycle 1; a repair (via onRepair) pushes
  // to 2, which is > 1. The NEXT generateAndReview (if any) would be blocked. The repair itself
  // still fires (it's an in-session event, not a loop invocation), but the log confirms it counted.
  const budgetApp: AppConfig = { ...app, qa: { ...app.qa, needsReview: false, iterationBudget: 10 } };
  const d = deps(passing(), calls);
  d.log = (m: string) => logs.push(m);
  // Override generate to fire onRepair once (simulating a generator contract-repair re-prompt).
  (d as PipelineDeps).generate = async (_input, _signal, _onProgress, _onUsage, onRepair) => {
    calls.push("generate");
    onRepair?.(); // simulate a generator repair
    return generated;
  };
  await runPipeline(budgetApp, "abc1234def", d);
  assert.ok(
    logs.some((l) => /in-session repair re-prompt/i.test(l)),
    `expected a repair-counter log; got:\n${logs.join("\n")}`,
  );
});

// Test 6a-6 (FIX 1): the default ceiling is a runaway BACKSTOP DERIVED from the configured caps,
// not the old flat 12. With maxRetries=5 the derived backstop is 36. A LEGITIMATE worst-case trace
// that consumes 14 cycles (entry + 12 in-session repairs + 1 mid-review regen) — which the old flat
// 12 WOULD have truncated — must NOT be cut short: the review-round regeneration still fires.
test("phase-6a (FIX 1): a legitimate worst-case trace with maxRetries=5 is NOT truncated by the derived default", async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  // No iterationBudget → default derives from maxRetries=5 → backstop 36.
  const budgetApp: AppConfig = { ...app, qa: { ...app.qa, needsReview: true, fixLoop: { maxRetries: 5 } } };
  // First generate fires onRepair 12× (cycleCount: 1 entry + 12 = 13). Round-0 review rejects →
  // mid-review regen ticks to 14. 14 ≤ 36 ⇒ not blocked ⇒ a SECOND generate fires (which approves).
  const d = deps(passing(), calls, {
    review: [
      { approved: false, corrections: ["fix selector"], parsed: true },
      { approved: true, corrections: [], parsed: true },
    ],
  });
  d.log = (m: string) => logs.push(m);
  let firstGenerate = true;
  (d as PipelineDeps).generate = async (_input, _signal, _onProgress, _onUsage, onRepair) => {
    calls.push("generate");
    if (firstGenerate) {
      firstGenerate = false;
      for (let i = 0; i < 12; i++) onRepair?.(); // 12 in-session contract repairs
    }
    return generated;
  };
  const result = await runPipeline(budgetApp, "abc1234def", d);
  const genCount = calls.filter((c) => c === "generate").length;
  assert.equal(genCount, 2, `derived backstop (36) must allow the 14-cycle trace; got ${genCount} generate call(s)`);
  assert.ok(
    !logs.some((l) => /cycle-ceiling reached/i.test(l)),
    `the derived backstop must NOT truncate a legitimate trace; got a ceiling log:\n${logs.join("\n")}`,
  );
  assert.equal(result.verdict, "pass", "the legitimate worst-case run should still pass");
});

// Test 6a-7 (FIX 1): a TRUE runaway above the derived ceiling IS stopped. With maxRetries=5 the
// backstop is 36; a generate that fires 40 in-session repairs (cycleCount 41) is a runaway — the
// next (mid-review) regeneration is blocked and the run concludes with the last state + a log.
test("phase-6a (FIX 1): a runaway exceeding the derived ceiling IS stopped", async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  const budgetApp: AppConfig = { ...app, qa: { ...app.qa, needsReview: true, fixLoop: { maxRetries: 5 } } };
  const d = deps(passing(), calls, {
    review: [{ approved: false, corrections: ["fix selector"], parsed: true }],
  });
  d.log = (m: string) => logs.push(m);
  (d as PipelineDeps).generate = async (_input, _signal, _onProgress, _onUsage, onRepair) => {
    calls.push("generate");
    for (let i = 0; i < 40; i++) onRepair?.(); // runaway: 40 in-session repairs past the 36 backstop
    return generated;
  };
  await runPipeline(budgetApp, "abc1234def", d);
  const genCount = calls.filter((c) => c === "generate").length;
  assert.equal(genCount, 1, `the runaway must be stopped before a second generate; got ${genCount}`);
  assert.ok(
    logs.some((l) => /cycle-ceiling reached/i.test(l)),
    `expected a cycle-ceiling log for the runaway; got:\n${logs.join("\n")}`,
  );
});

// Phase 0b: the deps.review() call-site forwards runId and objective from opts into ReviewInput.
// Spec scenario: "Reviewer session tracked with runId".
test("phase-0b: deps.review receives runId and objective forwarded from runPipeline opts", async () => {
  const calls: string[] = [];
  // Capture the ReviewInput passed to deps.review so we can assert the new fields.
  let capturedReviewInput: import("./integrations/opencode-client").ReviewInput | undefined;
  const d = deps(
    passing(),
    calls,
    { review: [{ approved: true, corrections: [] }] },
  );
  // Replace review with a capturing version (keep the return value compatible).
  (d as PipelineDeps).review = async (input) => {
    capturedReviewInput = input;
    return { approved: true, corrections: [] };
  };
  await runPipeline(
    app,
    "abc1234def",
    d,
    "webhook",
    // Phase 0b: pass a runId so pipeline threads it into deps.review.
    { mode: "diff", runId: "run-0b-pipeline-test" },
  );
  assert.ok(capturedReviewInput !== undefined, "deps.review must have been called");
  assert.equal(capturedReviewInput!.runId, "run-0b-pipeline-test", "ReviewInput.runId must match opts.runId");
  // objective is derived from guidance (undefined here) or intent.message (commit message is "feat: change")
  assert.equal(
    capturedReviewInput!.objective,
    "feat: change",
    "ReviewInput.objective must come from intent.message when guidance is absent",
  );
});

// Test D: persisted on static-invalid early return.
test("usage: persisted on static-invalid early return when onUsage was fired before validation", async () => {
  const calls: string[] = [];
  // Use failing validation so the static gate kills the run after one or more generate calls.
  // The static-repair loop retries generate up to MAX_STATIC_FIX_ROUNDS times, so we assert
  // that usage is defined and that input is a multiple of 50 (one 50 per generate call).
  const d = deps(passing(), calls, { validation: { ok: false, errors: ["tsc failed"], infra: false } });
  (d as PipelineDeps).generate = async (_input, _signal, _onProgress, onUsage) => {
    calls.push("generate");
    onUsage?.({ input: 50, output: 20, reasoning: 10, cacheRead: 0, cacheWrite: 0, cost: 0.0005 });
    return generated;
  };
  await runPipeline(app, "abc1234def", d, "manual", { mode: "diff", runId: "run-usage-invalid" });
  assert.ok(d.savedOutcomes.length > 0, "outcome must be persisted even for invalid runs");
  const usage = d.savedOutcomes[0]!.gateSignals.usage;
  assert.ok(usage !== undefined, "usage must be set on static-invalid return when tokens were spent");
  // At least one generate call fired: input must be a positive multiple of 50.
  assert.ok((usage.tokens.input ?? 0) > 0, "usage.tokens.input must be positive");
  assert.equal(usage.tokens.input % 50, 0, "input must be a multiple of 50 (one call = 50)");
});

// ── Phase 6b: scope-dimensioned iteration budget ───────────────────────────────
// deriveCycleBackstop now accepts numObjectives. With numObjectives=1 (single-agent path)
// it must produce the same value as before. With numObjectives>1, each extra objective adds
// one session's worth of budget (CYCLES_PER_GENERATE + REPAIR_HEADROOM_PER_GENERATE = 2+2=4
// for default MAX_REVIEW_ROUNDS=2 and REPAIR_HEADROOM=2), so a 5-objective run's ceiling
// is materially higher than a 1-objective run's ceiling.

test("Phase 6b (a): deriveCycleBackstop with numObjectives=1 matches the legacy 1-objective backstop", () => {
  const single = deriveCycleBackstop(2, 1);
  const legacy = deriveCycleBackstop(2);
  assert.equal(single, legacy, "numObjectives=1 must produce the same backstop as the legacy default");
});

test("Phase 6b (b): deriveCycleBackstop scales up with numObjectives — 5 objectives yields a higher ceiling than 1", () => {
  const single = deriveCycleBackstop(2, 1);
  const multi = deriveCycleBackstop(2, 5);
  assert.ok(multi > single, `5-objective backstop (${multi}) must be higher than 1-objective (${single})`);
});

test("Phase 6b (c): deriveCycleBackstop increments linearly per extra objective", () => {
  const one = deriveCycleBackstop(2, 1);
  const two = deriveCycleBackstop(2, 2);
  const three = deriveCycleBackstop(2, 3);
  // Each extra objective adds a fixed delta (CYCLES_PER_GENERATE + REPAIR_HEADROOM_PER_GENERATE).
  const delta = two - one;
  assert.ok(delta > 0, "each additional objective must add to the ceiling");
  assert.equal(three - two, delta, "increment must be constant per extra objective");
});

// ── Filtered retry (keystone-safe) ─────────────────────────────────────────────────────────────

// MANUAL mode, fail-then-pass retry where the failed case has a .file:
// the retry execute receives specFiles = [that file] (the optimization fires).
test("filtered-retry: MANUAL mode + failed case has .file → retry execute receives specFiles", async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  const failingRun: QaRunResult = {
    sha: "s", verdict: "fail", passed: false,
    cases: [{ name: "login › works", status: "fail", file: "login.spec.ts" }],
    logs: "",
  };
  const passingRun: QaRunResult = { sha: "s", verdict: "pass", passed: true, cases: [], logs: "" };
  const oneRetryApp: AppConfig = { ...app, qa: { ...app.qa, needsReview: false, fixLoop: { maxRetries: 1 } } };
  // No coverage → coverageWillMeasure is false (canFilter gate opens)
  const d = deps(failingRun, calls, { agents: [generated, generated] });
  d.log = (m: string) => logs.push(m);
  const capturedSpecFiles: Array<string[] | undefined> = [];
  let executeCall = 0;
  d.execute = async (_dir, opts) => {
    calls.push("execute");
    capturedSpecFiles.push((opts as { specFiles?: string[] }).specFiles);
    return executeCall++ === 0 ? failingRun : passingRun;
  };
  await runPipeline(oneRetryApp, "abc123", d, "manual", { mode: "manual" });
  // The retry execute (second call) must receive specFiles = ["login.spec.ts"]
  assert.equal(capturedSpecFiles.length, 2, "expected 2 execute calls");
  assert.deepEqual(capturedSpecFiles[1], ["login.spec.ts"], `retry execute should receive specFiles; got ${JSON.stringify(capturedSpecFiles[1])}`);
  assert.ok(logs.some((l) => /retry filtered/i.test(l)), `expected a "retry filtered" log; got:\n${logs.filter((l) => l.includes("retry")).join("\n")}`);
});

// DIFF mode + coverage signal/enforce: the retry execute receives NO specFiles (full re-run).
// The keystone is protected: filtering would undercount coverage.
test("filtered-retry: DIFF mode + coverage.signal → retry is NOT filtered (keystone protected)", async () => {
  const calls: string[] = [];
  const failingRun: QaRunResult = {
    sha: "s", verdict: "fail", passed: false,
    cases: [{ name: "login › works", status: "fail", file: "login.spec.ts" }],
    logs: "",
  };
  const passingRun: QaRunResult = { sha: "s", verdict: "pass", passed: true, cases: [], logs: "" };
  const oneRetryApp: AppConfig = { ...covApp("signal"), qa: { ...covApp("signal").qa, needsReview: false, fixLoop: { maxRetries: 1 } } };
  const d = deps(failingRun, calls, { agents: [generated, generated], diff: DIFF_4, coverage: [cov([1, 2, 3, 4])] });
  const capturedSpecFiles: Array<string[] | undefined> = [];
  let executeCall = 0;
  d.execute = async (_dir, opts) => {
    calls.push("execute");
    capturedSpecFiles.push((opts as { specFiles?: string[] }).specFiles);
    return executeCall++ === 0 ? failingRun : passingRun;
  };
  await runPipeline(oneRetryApp, "abc123", d, "manual", { mode: "diff" });
  assert.equal(capturedSpecFiles.length, 2, "expected 2 execute calls");
  assert.equal(capturedSpecFiles[1], undefined, `diff+coverage retry must NOT filter (got specFiles=${JSON.stringify(capturedSpecFiles[1])})`);
});

// Regeneration writes a spec OUTSIDE the failed set → full re-run (no specFiles), even in manual.
test("filtered-retry: regen writes a spec outside the failed set → full re-run", async () => {
  const calls: string[] = [];
  const failingRun: QaRunResult = {
    sha: "s", verdict: "fail", passed: false,
    cases: [{ name: "login › works", status: "fail", file: "login.spec.ts" }],
    logs: "",
  };
  const passingRun: QaRunResult = { sha: "s", verdict: "pass", passed: true, cases: [], logs: "" };
  const oneRetryApp: AppConfig = { ...app, qa: { ...app.qa, needsReview: false, fixLoop: { maxRetries: 1 } } };
  // The regen writes "checkout.spec.ts" — outside the failed set (login.spec.ts only)
  const regenOutsideSet: AgentResult = { output: "x", specs: ["login.spec.ts", "checkout.spec.ts"], reviewed: true, approved: true };
  const d = deps(failingRun, calls, { agents: [generated, regenOutsideSet] });
  const capturedSpecFiles: Array<string[] | undefined> = [];
  let executeCall = 0;
  d.execute = async (_dir, opts) => {
    calls.push("execute");
    capturedSpecFiles.push((opts as { specFiles?: string[] }).specFiles);
    return executeCall++ === 0 ? failingRun : passingRun;
  };
  await runPipeline(oneRetryApp, "abc123", d, "manual", { mode: "manual" });
  assert.equal(capturedSpecFiles.length, 2, "expected 2 execute calls");
  assert.equal(capturedSpecFiles[1], undefined, `regen outside failed set must force full re-run (got specFiles=${JSON.stringify(capturedSpecFiles[1])})`);
});

// Merge: after a filtered manual retry, the final run/outcome reflects the full suite
// (prior passing cases present), verdict pass.
test("filtered-retry: after filtered retry, final run includes prior passing cases and verdict is pass", async () => {
  const calls: string[] = [];
  const passingCase: QaCase = { name: "checkout › completes", status: "pass", file: "checkout.spec.ts" };
  const failingCase: QaCase = { name: "login › works", status: "fail", file: "login.spec.ts" };
  const initialRun: QaRunResult = {
    sha: "s", verdict: "fail", passed: false,
    cases: [passingCase, failingCase],
    logs: "",
  };
  // The retry run returns only the previously-failing spec's result (since we filtered to it)
  const retryPassRun: QaRunResult = {
    sha: "s", verdict: "pass", passed: true,
    cases: [{ name: "login › works", status: "pass" }],
    logs: "",
  };
  const oneRetryApp: AppConfig = { ...app, qa: { ...app.qa, needsReview: false, fixLoop: { maxRetries: 1 } } };
  const d = deps(initialRun, calls, { agents: [generated, generated] });
  let executeCall = 0;
  d.execute = async (_dir, _opts) => {
    calls.push("execute");
    return executeCall++ === 0 ? initialRun : retryPassRun;
  };
  const finalRun = await runPipeline(oneRetryApp, "abc123", d, "manual", { mode: "manual" });
  assert.equal(finalRun.verdict, "pass", "merged run should be pass");
  // Prior passing case (checkout.spec.ts) must be in the merged result
  assert.ok(finalRun.cases.some((c) => c.name === "checkout › completes"), `prior passing case must be in merged result; cases: ${JSON.stringify(finalRun.cases.map((c) => c.name))}`);
  // The previously-failing case (now passing) must also be present
  assert.ok(finalRun.cases.some((c) => c.name === "login › works" && c.status === "pass"), `fixed case must be in merged result; cases: ${JSON.stringify(finalRun.cases.map((c) => c.name))}`);
});

// Filtered retry with a failed case that has NO .file → full re-run (cannot safely filter).
test("filtered-retry: failed case with no .file → full re-run (cannot safely filter)", async () => {
  const calls: string[] = [];
  const failingRun: QaRunResult = {
    sha: "s", verdict: "fail", passed: false,
    cases: [{ name: "login › works", status: "fail" /* no file */ }],
    logs: "",
  };
  const passingRun: QaRunResult = { sha: "s", verdict: "pass", passed: true, cases: [], logs: "" };
  const oneRetryApp: AppConfig = { ...app, qa: { ...app.qa, needsReview: false, fixLoop: { maxRetries: 1 } } };
  const d = deps(failingRun, calls, { agents: [generated, generated] });
  const capturedSpecFiles: Array<string[] | undefined> = [];
  let executeCall = 0;
  d.execute = async (_dir, opts) => {
    calls.push("execute");
    capturedSpecFiles.push((opts as { specFiles?: string[] }).specFiles);
    return executeCall++ === 0 ? failingRun : passingRun;
  };
  await runPipeline(oneRetryApp, "abc123", d, "manual", { mode: "manual" });
  assert.equal(capturedSpecFiles.length, 2, "expected 2 execute calls");
  assert.equal(capturedSpecFiles[1], undefined, `case without .file must force full re-run (got specFiles=${JSON.stringify(capturedSpecFiles[1])})`);
});

test("Phase 6b (d): pipeline retroactively raises MAX_CYCLES when generate returns objectiveCount>1", async () => {
  // Arrange: iterationBudget=1 (very tight). A multi-objective result should raise the ceiling
  // above 1 so the run is NOT truncated just because the first cycle consumed the budget.
  const calls: string[] = [];
  const logs: string[] = [];
  // Return objectiveCount=5 to trigger the retroactive scale-up.
  const multiObjectiveResult: AgentResult = { ...generated, objectiveCount: 5 };
  const budgetApp: AppConfig = {
    ...app,
    qa: { ...app.qa, needsReview: false },
    // No iterationBudget — use the derived backstop.
  };
  const d = deps(passing(), calls, { agent: multiObjectiveResult });
  d.log = (m: string) => logs.push(m);
  const result = await runPipeline(budgetApp, "abc1234def", d);
  assert.equal(result.verdict, "pass", "multi-objective run should still complete");
  // The scope-dimensioned backstop log is emitted when objectiveCount>1 and no explicit budget.
  assert.ok(
    logs.some((l) => /scope-dimensioned backstop raised/i.test(l)),
    `expected a scope-dimensioned backstop log; got:\n${logs.filter((l) => l.includes("cycle")).join("\n")}`,
  );
});

// ── Adjudicator integration tests (task 3.1) ─────────────────────────────────

// Integration 1: app_defect evidence → Issue filed, runVerdict=fail
// This uses the same evidence that today's isLikelyRealBug would fire on:
// allUnique=true (extractable+present-unique locators + all value-mismatch details),
// gateSpend=true (first retry). The adjudicator must fire app_defect → break-issue →
// Issue is opened.
test("adjudicator: app_defect evidence → Issue filed, verdict=fail", async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  const failureDom = parseAriaSnapshot(
    '- button "Add Owner"\n- heading "Find Owners"',
  ).join("\n");
  const failing: QaRunResult = {
    sha: "s",
    verdict: "fail",
    passed: false,
    cases: [
      {
        name: "owners › create",
        status: "fail",
        detail:
          'Error: expect(locator).toHaveText(expected) failed\n\nLocator:  getByRole(\'heading\')\nExpected string: "Find Owners"\nReceived string: "Owners"\nTimeout:  5000ms',
        failureDom,
      },
    ],
    logs: "",
  };
  const oneRetryApp: AppConfig = {
    ...app,
    qa: { ...app.qa, needsReview: false, fixLoop: { maxRetries: 1 } },
  };
  const d = deps(failing, calls, { agents: [generated, generated] });
  d.log = (m: string) => logs.push(m);
  // Spec with extractable+unique locators so allUnique=true
  writeFileSync(
    join(d.mirrorDir, "e2e", "a.spec.ts"),
    `import { test, expect } from "./fixtures";\n` +
      `test("owners › create", async ({ page }) => {\n` +
      `  await page.getByRole("button", { name: "Add Owner" }).click();\n` +
      `  await expect(page.getByRole("heading", { name: "Find Owners" })).toHaveText("Find Owners");\n` +
      `});\n`,
  );
  d.execute = async () => { calls.push("execute"); return failing; };
  const result = await runPipeline(oneRetryApp, "abc123", d);
  assert.equal(result.verdict, "fail", "verdict must be fail on app_defect");
  assert.ok(
    d.issues.length > 0,
    `Issue must be filed on app_defect; calls: ${calls.join(",")}`,
  );
  assert.ok(
    logs.some((l) => /adjudicator.*app_defect|real-bug branch/i.test(l)),
    `expected adjudicator app_defect log; got:\n${logs.join("\n")}`,
  );
});

// Integration 2: runner_infra evidence → infra-error verdict, NO repo Issue
// All failure details match PLAYWRIGHT_INFRA_RE → adjudicator fires runner_infra →
// break-issue → run set to infra-error → report() logs INFRA, no Issue.
test("adjudicator: runner_infra evidence → infra-error verdict, NO repo Issue", async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  const failing: QaRunResult = {
    sha: "s",
    verdict: "fail",
    passed: false,
    cases: [
      {
        name: "owners › create",
        status: "fail",
        detail: "browserType.launch: Executable doesn't exist at /usr/bin/chromium",
      },
    ],
    logs: "",
  };
  const oneRetryApp: AppConfig = {
    ...app,
    qa: { ...app.qa, needsReview: false, fixLoop: { maxRetries: 1 } },
  };
  const d = deps(failing, calls, { agents: [generated, generated] });
  d.log = (m: string) => logs.push(m);
  d.execute = async () => { calls.push("execute"); return failing; };
  const result = await runPipeline(oneRetryApp, "abc123", d);
  assert.equal(
    result.verdict,
    "infra-error",
    `expected infra-error verdict on runner_infra; got ${result.verdict}`,
  );
  assert.equal(
    d.issues.length,
    0,
    `No repo Issue must be filed on runner_infra; issues: ${JSON.stringify(d.issues)}`,
  );
  assert.ok(
    logs.some((l) => /adjudicator.*runner_infra|runner.infra|INFRA/i.test(l)),
    `expected adjudicator runner_infra or infra log; got:\n${logs.join("\n")}`,
  );
});

// Integration 3: generated_test_defect + spend=true → loop does NOT break
// (another agent session is invoked, meaning execute is called twice)
test("adjudicator: generated_test_defect + spend=true → continue (loop does not break early)", async () => {
  const calls: string[] = [];
  const failingRun: QaRunResult = {
    sha: "s",
    verdict: "fail",
    passed: false,
    cases: [
      {
        name: "owners › create",
        status: "fail",
        // Locator failure detail — classifies as "locator", all locators → rule 4 fires if spend=true
        detail: "strict mode violation: getByRole('button', { name: 'Add Owner' }) resolved to 3 elements",
      },
    ],
    logs: "",
  };
  const passingRun: QaRunResult = { sha: "s", verdict: "pass", passed: true, cases: [], logs: "" };
  const oneRetryApp: AppConfig = {
    ...app,
    qa: { ...app.qa, needsReview: false, fixLoop: { maxRetries: 1 } },
  };
  // First execute returns failing, second returns passing
  let executeCall = 0;
  const d = deps(failingRun, calls, { agents: [generated, generated] });
  d.execute = async () => {
    calls.push("execute");
    return executeCall++ === 0 ? failingRun : passingRun;
  };
  const result = await runPipeline(oneRetryApp, "abc123", d);
  const executeCalls = calls.filter((c) => c === "execute");
  assert.ok(
    executeCalls.length >= 2,
    `loop must NOT break early on generated_test_defect+spend=true (expected ≥2 execute calls, got ${executeCalls.length}); calls: ${calls.join(",")}`,
  );
  assert.equal(result.verdict, "pass", "run should pass after the retry fixed the test");
});

// Integration 4: ambiguous + no-progress (spend=false, locator failures) →
// break-needs-human → labeled Issue, no extra agent session
test("adjudicator: ambiguous + spend=false → break-needs-human → labeled Issue, no extra generate", async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  // Failing run with locator failures (so rule 4 would fire IF spend=true, but spend=false
  // because prev and cur have identical failing counts/names → decideProgress returns false).
  // We need TWO retries: first retry establishes baseline (spend=true always on first retry);
  // second retry has same failing count → no progress → spend=false → rule 5 fires.
  const failingRun: QaRunResult = {
    sha: "s",
    verdict: "fail",
    passed: false,
    cases: [
      {
        name: "owners › create",
        status: "fail",
        detail: "strict mode violation: locator found 2 elements",
      },
    ],
    logs: "",
  };
  const twoRetryApp: AppConfig = {
    ...app,
    qa: { ...app.qa, needsReview: false, fixLoop: { maxRetries: 2 } },
  };
  // Agent is called for generation + two retries, execute always returns failing
  const d = deps(failingRun, calls, { agents: [generated, generated, generated] });
  d.log = (m: string) => logs.push(m);
  d.execute = async () => { calls.push("execute"); return failingRun; };
  const result = await runPipeline(twoRetryApp, "abc123", d);
  assert.equal(result.verdict, "fail", "verdict must be fail when needs-human");
  assert.ok(
    d.issues.length > 0,
    `Issue must be filed on break-needs-human; calls: ${calls.join(",")}`,
  );
  // Adjudicator log line must appear
  assert.ok(
    logs.some((l) => /adjudicator.*break-needs-human|adjudicator.*class=/i.test(l)),
    `expected adjudicator break-needs-human log; got:\n${logs.join("\n")}`,
  );
  // No extra generate should be attempted after break-needs-human
  const generateCalls = calls.filter((c) => c === "generate");
  const executeCalls = calls.filter((c) => c === "execute");
  assert.ok(
    generateCalls.length <= executeCalls.length,
    `no extra generate after break-needs-human (generates=${generateCalls.length}, executes=${executeCalls.length}); calls: ${calls.join(",")}`,
  );
});

// Integration 4b: break-needs-human → Issue body carries the adjudication class + reason
test("adjudicator: break-needs-human → Issue body contains adjudication class and reason", async () => {
  const calls: string[] = [];
  const issueBodies: string[] = [];
  const failingRun: QaRunResult = {
    sha: "s",
    verdict: "fail",
    passed: false,
    cases: [
      {
        name: "owners › create",
        status: "fail",
        detail: "strict mode violation: locator found 2 elements",
      },
    ],
    logs: "",
  };
  const twoRetryApp: AppConfig = {
    ...app,
    qa: { ...app.qa, needsReview: false, fixLoop: { maxRetries: 2 } },
  };
  const d = deps(failingRun, calls, { agents: [generated, generated, generated] });
  d.execute = async () => { calls.push("execute"); return failingRun; };
  // Override openIssue to also capture the body
  d.openIssue = async (_repo: string, _title: string, body: string) => {
    issueBodies.push(body);
    return { url: "https://github.com/org/demo/issues/1" };
  };
  await runPipeline(twoRetryApp, "abc123", d);
  assert.ok(issueBodies.length > 0, "Issue must be filed on break-needs-human");
  const body = issueBodies[0]!;
  // The adjudicator label line format: **Adjudicator:** `{class}` — {reason}
  assert.ok(
    /Adjudicator/i.test(body),
    `Issue body must contain adjudication label; got:\n${body.slice(0, 400)}`,
  );
  assert.ok(
    /generated_test_defect|break-needs-human|no progress/i.test(body),
    `Issue body must contain adjudication class or reason; got:\n${body.slice(0, 400)}`,
  );
});
