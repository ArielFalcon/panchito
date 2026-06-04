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
  specs: ["a.spec.ts"],
  reviewed: true,
  approved: true,
};

interface Harness extends PipelineDeps {
  issues: string[];
  published: boolean;
}

function deps(
  run: QaRunResult,
  calls: string[],
  opts: {
    validation?: { ok: boolean; errors: string[] };
    prUrl?: string | null;
    agent?: AgentResult;
    healthy?: boolean | boolean[]; // un valor, o una secuencia por llamada
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
      return { mirrorDir: "/mirrors/org__demo", diff: "DIFF" };
    },
    generate: async () => {
      calls.push("generate");
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

test("verde: orquesta gate → prepare → generate → setup → validate → health → execute → publish", async () => {
  const calls: string[] = [];
  await runPipeline(app, "abc123", deps(passing(), calls), "manual");
  // en verde, el re-check de salud post-fallo se cortocircuita (solo 1 health)
  assert.deepEqual(calls, ["gate", "prepare", "generate", "setup", "validate", "health", "execute", "publish"]);
});

test("verde abre PR, NO Issue", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls);
  await runPipeline(app, "abc123", d);
  assert.equal(d.published, true);
  assert.equal(d.issues.length, 0);
});

test("verde sin cambios en e2e: no rompe (publish devuelve null)", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, { prUrl: null });
  const run = await runPipeline(app, "abc123", d);
  assert.equal(run.verdict, "pass");
  assert.equal(d.issues.length, 0);
});

test("al fallar abre Issue con el SHA y NO publica", async () => {
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

test("flaky: ni PR ni Issue (cuarentena)", async () => {
  const calls: string[] = [];
  const d = deps(
    { sha: "s", verdict: "flaky", passed: false, cases: [{ name: "checkout", status: "flaky" }], logs: "" },
    calls,
  );
  await runPipeline(app, "abc123", d);
  assert.equal(d.published, false);
  assert.equal(d.issues.length, 0);
});

test("specs inválidos: NO ejecuta ni publica, abre Issue de validación", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, { validation: { ok: false, errors: ["[lint] no-wait-for-timeout"] } });
  const run = await runPipeline(app, "abc123", d);
  assert.equal(run.verdict, "invalid");
  assert.ok(!calls.includes("execute"));
  assert.ok(!calls.includes("publish"));
  assert.equal(d.issues.length, 1);
  assert.match(d.issues[0]!, /no pudo validar/);
});

test("verde pero el revisor NO aprobó: no publica, abre Issue de revisión", async () => {
  const calls: string[] = [];
  const rejected: AgentResult = { output: "x", specs: [], reviewed: true, approved: false, note: "falsos positivos" };
  const d = deps(passing(), calls, { agent: rejected });
  await runPipeline(app, "abc123", d);
  assert.equal(d.published, false);
  assert.equal(d.issues.length, 1);
  assert.match(d.issues[0]!, /el revisor no aprobó/);
});

test("DEV no sano antes de ejecutar: infra-error, ni ejecuta ni reporta como bug", async () => {
  const calls: string[] = [];
  const d = deps(passing(), calls, { healthy: false });
  const run = await runPipeline(app, "abc123", d);
  assert.equal(run.verdict, "infra-error");
  assert.ok(!calls.includes("execute"));
  assert.equal(d.issues.length, 0); // infra NO abre Issue
});

test("fallos con DEV caído a mitad: se reclasifica a infra-error (sin Issue)", async () => {
  const calls: string[] = [];
  // sano en el pre-flight, caído en el re-check post-fallo
  const failing: QaRunResult = { sha: "s", verdict: "fail", passed: false, cases: [{ name: "x", status: "fail" }], logs: "" };
  const d = deps(failing, calls, { healthy: [true, false] });
  const run = await runPipeline(app, "abc123", d);
  assert.equal(run.verdict, "infra-error");
  assert.equal(d.issues.length, 0);
});

test("modo sombra: en verde NO publica, solo loguea", async () => {
  const calls: string[] = [];
  const shadowApp = { ...app, qa: { ...app.qa, shadow: true } };
  const d = deps(passing(), calls);
  await runPipeline(shadowApp, "abc123", d);
  assert.equal(d.published, false);
  assert.equal(d.issues.length, 0);
});

test("modo sombra: ante fallo NO abre Issue", async () => {
  const calls: string[] = [];
  const shadowApp = { ...app, qa: { ...app.qa, shadow: true } };
  const d = deps(
    { sha: "s", verdict: "fail", passed: false, cases: [{ name: "x", status: "fail" }], logs: "" },
    calls,
  );
  await runPipeline(shadowApp, "abc123", d);
  assert.equal(d.issues.length, 0);
});
