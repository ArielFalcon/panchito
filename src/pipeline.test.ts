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

function deps(run: QaRunResult, calls: string[]): PipelineDeps & { issues: string[] } {
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

test("orquesta gate → prepare → generate → execute en orden", async () => {
  const calls: string[] = [];
  const d = deps({ sha: "s", passed: true, cases: [], logs: "" }, calls);
  await runPipeline(app, "abc123", d, "manual");
  assert.deepEqual(calls, ["gate", "prepare", "generate", "execute"]);
});

test("en verde NO abre Issue", async () => {
  const calls: string[] = [];
  const d = deps({ sha: "s", passed: true, cases: [], logs: "" }, calls);
  await runPipeline(app, "abc123", d);
  assert.equal(d.issues.length, 0);
});

test("al fallar abre Issue con el SHA en el título", async () => {
  const calls: string[] = [];
  const d = deps(
    { sha: "s", passed: false, cases: [{ name: "login", status: "fail" }], logs: "x" },
    calls,
  );
  await runPipeline(app, "abc123", d);
  assert.equal(d.issues.length, 1);
  assert.match(d.issues[0]!, /abc123/);
});
