import { test } from "node:test";
import assert from "node:assert/strict";
import { runPipeline, PipelineDeps } from "./pipeline";
import { AppConfig } from "./orchestrator/config-loader";
import { AgentResult, QaRunResult } from "./types";

const app: AppConfig = {
  name: "demo",
  repo: "org/demo",
  dev: {
    baseUrl: "https://dev",
    versionUrl: "https://dev/version",
    pollIntervalMs: 1,
    deployTimeoutMs: 100,
  },
  qa: { needsReview: true, testDataPrefix: "qa-bot", criticalFlows: [] },
  report: { onFailure: "github-issue" },
};

const generated: AgentResult = {
  output: "spec",
  artifacts: [{ path: "a.spec.ts", content: "x", kind: "e2e" }],
  reviewed: true,
  approved: true,
};

interface Harness extends PipelineDeps {
  issues: string[];
}

function deps(
  run: QaRunResult,
  calls: string[],
  opts: { validation?: { ok: boolean; errors: string[] } } = {},
): Harness {
  const issues: string[] = [];
  return {
    issues,
    waitForDeploy: async () => {
      calls.push("gate");
    },
    prepare: async () => {
      calls.push("prepare");
      return { mirrorDir: "/mirrors/org__demo", diff: "DIFF" };
    },
    generate: async (input) => {
      calls.push("generate");
      assert.equal(input.diff, "DIFF"); // el diff fluye a la generación
      assert.equal(input.mirrorDir, "/mirrors/org__demo"); // cwd del agente
      assert.equal(input.namespace, "qa-bot-abc123"); // namespace ya resuelto
      return generated;
    },
    persist: async (_artifacts, ns) => {
      calls.push("persist");
      return `/qa-store/${ns}`;
    },
    validate: async (specDir) => {
      calls.push("validate");
      assert.equal(specDir, "/qa-store/qa-bot-abc123");
      return opts.validation ?? { ok: true, errors: [] };
    },
    execute: async () => {
      calls.push("execute");
      return run;
    },
    openIssue: async (_repo, title) => {
      issues.push(title);
      return { url: "https://github.com/org/demo/issues/1" };
    },
  };
}

function passing(): QaRunResult {
  return { sha: "s", verdict: "pass", passed: true, cases: [], logs: "" };
}

test("orquesta gate → prepare → generate → persist → validate → execute en orden", async () => {
  const calls: string[] = [];
  await runPipeline(app, "abc123", deps(passing(), calls), "manual");
  assert.deepEqual(calls, ["gate", "prepare", "generate", "persist", "validate", "execute"]);
});

test("en verde NO abre Issue", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls);
  await runPipeline(app, "abc123", d);
  assert.equal(d.issues.length, 0);
});

test("al fallar abre Issue con el SHA en el título", async () => {
  const calls: string[] = [];
  const d = deps(
    { sha: "s", verdict: "fail", passed: false, cases: [{ name: "login", status: "fail" }], logs: "x" },
    calls,
  );
  await runPipeline(app, "abc123", d);
  assert.equal(d.issues.length, 1);
  assert.match(d.issues[0]!, /abc123/);
});

test("flaky NO abre Issue (cuarentena)", async () => {
  const calls: string[] = [];
  const d = deps(
    { sha: "s", verdict: "flaky", passed: false, cases: [{ name: "checkout", status: "flaky" }], logs: "" },
    calls,
  );
  await runPipeline(app, "abc123", d);
  assert.equal(d.issues.length, 0);
});

test("specs inválidos: NO ejecuta y abre Issue de validación", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, {
    validation: { ok: false, errors: ["[lint] no-wait-for-timeout"] },
  });
  const run = await runPipeline(app, "abc123", d);
  assert.equal(run.verdict, "invalid");
  assert.ok(!calls.includes("execute")); // no se ejecutó
  assert.equal(d.issues.length, 1);
  assert.match(d.issues[0]!, /no pudo validar/);
});
