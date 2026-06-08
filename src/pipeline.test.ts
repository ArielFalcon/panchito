import { test } from "node:test";
import assert from "node:assert/strict";
import { runPipeline, PipelineDeps, GenerateInput } from "./pipeline";
import { ReviewResult } from "./integrations/opencode-client";
import { CoveredLines } from "./qa/change-coverage";
import { AppConfig } from "./orchestrator/config-loader";
import { AgentResult, QaRunResult, RunMode } from "./types";

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
  genInputs: GenerateInput[]; // every generate() call's input, to inspect reinjected corrections
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
  const h = { issues, published: false, genInputs: [] } as unknown as Harness;
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
    logs.some((l) => /structural no-op|matched NONE/i.test(l)),
    `expected a keystone no-op warning, got:\n${logs.join("\n")}`,
  );
});

test("does NOT warn about a keystone no-op when there are simply no dumps", async () => {
  const logs: string[] = [];
  const h = deps(passing(), [], { coverage: [null], diff: DIFF_4, message: "feat: x" });
  h.log = (m: string) => logs.push(m);
  h.hasCoverageDumps = () => false;
  await runPipeline(app, "abc1234def", h, "manual", { mode: "diff" });
  assert.ok(!logs.some((l) => /structural no-op/i.test(l)));
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
