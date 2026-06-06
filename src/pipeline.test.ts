import { test } from "node:test";
import assert from "node:assert/strict";
import { runPipeline, PipelineDeps, GenerateInput } from "./pipeline";
import { AppConfig } from "./orchestrator/config-loader";
import { AgentResult, QaRunResult, RunMode } from "./types";

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
}

function deps(
  run: QaRunResult,
  calls: string[],
  opts: {
    validation?: { ok: boolean; errors: string[] };
    prUrl?: string | null;
    agent?: AgentResult;
    healthy?: boolean | boolean[]; // a single value, or a sequence per call
    message?: string; // commit message (classification)
    diff?: string;
  } = {},
): Harness {
  const issues: string[] = [];
  const h = { issues, published: false } as Harness;
  const healthSeq = Array.isArray(opts.healthy) ? [...opts.healthy] : null;
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
      return opts.agent ?? generated;
    },
    setupE2e: async () => {
      calls.push("setup");
    },
    validate: async () => {
      calls.push("validate");
      return opts.validation ?? { ok: true, errors: [] };
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
      return opts.prUrl === undefined ? { prUrl: "https://github.com/org/demo/pull/9" } : opts.prUrl === null ? null : { prUrl: opts.prUrl };
    },
    publish: async (input: { baseBranch: string }) => {
      calls.push("publish");
      assert.equal(input.baseBranch, "main");
      h.published = true;
      return opts.prUrl === undefined ? { prUrl: "https://github.com/org/demo/pull/1" } : opts.prUrl === null ? null : { prUrl: opts.prUrl };
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
  const d = deps(passing(), calls, { validation: { ok: false, errors: ["[lint] no-wait-for-timeout"] } });
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
