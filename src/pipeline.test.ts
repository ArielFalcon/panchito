import { test } from "node:test";
import assert from "node:assert/strict";
import { runPipeline, PipelineDeps, GenerateInput } from "./pipeline";
import { ReviewResult } from "./integrations/opencode-client";
import { CoveredLines } from "./qa/change-coverage";
import { AppConfig } from "./orchestrator/config-loader";
import { AgentResult, QaRunResult, RunMode, RunOutcome } from "./types";
import type { OracleInput, ValueOracleResult } from "./qa/learning/oracle-types";
import type { RetrievalResult } from "./qa/learning/retrieval";

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
  } = {},
): Harness {
  const issues: string[] = [];
  const savedOutcomes: RunOutcome[] = [];
  const oracleCalls: OracleInput[] = [];
  const h = { issues, published: false, genInputs: [], savedOutcomes, oracleCalls } as unknown as Harness;
  const healthSeq = Array.isArray(opts.healthy) ? [...opts.healthy] : null;
  const agentSeq = opts.agents ? [...opts.agents] : null;
  const reviewSeq = opts.review ? [...opts.review] : null;
  const covSeq = opts.coverage ? [...opts.coverage] : null;
  Object.assign(h, {
    waitForDeploy: async () => {
      calls.push("gate");
    },
    prepare: async () => {
      calls.push("prepare");
      return { mirrorDir: "/mirrors/org__demo", diff: opts.diff ?? "DIFF", message: opts.message ?? "feat: change" };
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

// Reviewer fail-open must be bounded and observable: an UNPARSEABLE verdict is not an
// actionable rejection — feeding a fake correction just burns a round and re-hits the
// same miss. Treat it like a reviewer error: publish on the generator's verdict, loudly.
test("an unparseable reviewer verdict publishes without review and does NOT burn a regeneration round", async () => {
  const logs: string[] = [];
  const h = deps(passing(), [], {
    agent: { output: "x", specs: ["a.spec.ts"], reviewed: true, approved: true },
    review: [{ approved: false, corrections: ["the independent reviewer produced no parseable verdict"], parsed: false }],
  });
  h.log = (m: string) => logs.push(m);
  await runPipeline(app, "abc1234def", h, "manual", { mode: "diff" });
  assert.equal(h.genInputs.length, 1, "must not regenerate on a parse miss");
  assert.ok(logs.some((l) => /without independent review/i.test(l)));
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

test("reviewer error fails open: trusts the generator and publishes", async () => {
  const calls: string[] = [];
  const h = deps(passing(), calls, {});
  // a review() that throws → fail open
  (h as PipelineDeps).review = async () => {
    calls.push("review");
    throw new Error("reviewer crashed");
  };
  await runPipeline(app, "abc123", h);
  assert.equal(calls.filter((c) => c === "generate").length, 1);
  assert.equal(h.published, true);
  assert.equal(h.issues.length, 0);
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

test("change-coverage off: the step is skipped entirely", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, { diff: DIFF_4, coverage: [cov([1])] });
  await runPipeline(covApp("off"), "abc123", d);
  assert.ok(!calls.includes("coverage"));
  assert.equal(d.published, true);
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

test("oracle: runOracle is NOT called for e2e mode", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, { diff: DIFF_4, coverage: [cov([1, 2, 3, 4])], message: "feat: x" });
  await runPipeline(app, "e2e0001", d, "manual", { mode: "diff", runId: "run-orc-2" });

  assert.equal(d.oracleCalls.length, 0, "oracle should NOT be called for e2e");
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
