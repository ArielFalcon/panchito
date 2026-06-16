import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPipeline, PipelineDeps, GenerateInput, buildFailureDom, buildFailureDomLines } from "./pipeline";
import { parseAriaSnapshot } from "./qa/dom-snapshot";
import { ReviewResult } from "./integrations/opencode-client";
import { CoveredLines } from "./qa/change-coverage";
import { AppConfig } from "./orchestrator/config-loader";
import { AgentResult, QaCase, QaRunResult, RunMode, RunOutcome } from "./types";
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
  assert.ok(logs.some((l) => /real-bug branch/i.test(l)), `real-bug branch SHOULD fire when all locators are extractable + unique:\n${logs.join("\n")}`);
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

// Test 6a-1: Default behaviour unchanged — no iterationBudget → counter exists but never
// triggers; a normal single-generation run still publishes.
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
