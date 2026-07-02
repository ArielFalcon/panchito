import { test } from "node:test";
import assert from "node:assert/strict";
import { createRewrittenEngineFactory, buildRewrittenCompositionConfig } from "./rewritten-engine-factory";
import { AppConfig } from "../orchestrator/config-loader";
import { JobQueue } from "./queue";
import { enqueueTrackedRun } from "./runner";
import { getRecord } from "./history";
import { PipelineDeps } from "../pipeline";
import { QaCase } from "../types";
import type { AgentDeps } from "../integrations/opencode-client";

const cfg = (name: string): AppConfig => ({
  name,
  repo: "org/demo",
  dev: { baseUrl: "https://dev" },
  qa: { needsReview: true, testDataPrefix: "qa-bot", shadow: true },
  report: { onFailure: "github-issue" },
});

// A minimal AgentDeps stub — construction of the factory (and the CompositionConfig it builds)
// must never itself call .open(); it is only invoked lazily when a real run actually reaches
// generation/review. Throwing here proves no eager agent call happens during composition.
function stubAgentDeps(): AgentDeps {
  return {
    open: async () => {
      throw new Error("stubAgentDeps.open must never be called during factory construction");
    },
  };
}

function stubPipelineDeps(): PipelineDeps {
  return {
    waitForDeploy: async () => {},
    prepare: async () => ({ mirrorDir: "/tmp/x", diff: "", message: "feat: x" }),
    prepareAtBranch: async () => ({ mirrorDir: "/tmp/x" }),
    generate: async () => ({ output: "", specs: ["a.spec.ts"], reviewed: false, approved: true }),
    setupE2e: async () => {},
    validate: async () => ({ ok: true, errors: [], infra: false }),
    execute: async (_dir, opts) => {
      const cases: QaCase[] = [{ name: "legacy-t1", status: "pass" }];
      cases.forEach((c) => opts.onCase?.(c));
      return { sha: opts.namespace ?? "ns", verdict: "pass", passed: true, cases, logs: "" };
    },
    isHealthy: async () => true,
    isReachable: async () => true,
    publish: async () => null,
    publishContext: async () => null,
    setupCode: async () => {},
    executeCode: async (_dir, opts) => ({ sha: opts.namespace ?? "ns", verdict: "pass", passed: true, cases: [], logs: "" }),
    publishCode: async () => null,
    cleanup: async () => {},
    openIssue: async () => ({ url: "" }),
    log: () => {},
  };
}

// ── buildRewrittenCompositionConfig — the AppConfig -> CompositionConfig mapping ──────────────────

test("buildRewrittenCompositionConfig maps an e2e AppConfig into a complete CompositionConfig", () => {
  const app = cfg("factory-e2e");
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  assert.equal(config.repo, "org/demo");
  assert.equal(config.appName, "factory-e2e");
  assert.equal(config.target, "e2e");
  assert.equal(config.isCode, false);
  assert.equal(config.mode, "diff");
  assert.equal(config.needsReview, true);
  assert.equal(config.shadow, true); // app.qa.shadow=true is honored, not forced
  assert.equal(config.onFailure, "github-issue");
  assert.equal(config.diff, "", "static diff is always empty — the rewritten adapters resolve the REAL per-run diff dynamically");
  assert.ok(config.vcs, "vcs collaborator must be wired");
  assert.ok(config.generationUseCase, "generationUseCase collaborator must be wired");
  assert.ok(config.staticGate, "staticGate collaborator must be wired");
  assert.ok(config.executionStrategies.e2e, "e2e execution strategy must be wired");
  assert.ok(config.executionStrategies.code, "code execution strategy must be wired");
  assert.ok(config.setupCollaborators?.e2e, "SetupPort e2e collaborator must be wired (CLAUDE.md run-flow step 3 — missing before this fix)");
  assert.ok(config.setupCollaborators?.code, "SetupPort code collaborator must be wired");
  assert.ok(config.objectiveSignal.collector, "coverage collector must be wired");
  assert.ok(config.objectiveSignal.oracle, "value oracle must be wired");
  assert.ok(config.githubPr, "githubPr collaborator must be wired (production path, not buildShadow)");
  assert.ok(config.githubIssue, "githubIssue collaborator must be wired");
  assert.equal(typeof config.checkout, "function");
});

// ── Gap fixes (engram #961) — baseUrl, testIdAttribute, mode/guidance, publish flags ──────────────

test("buildRewrittenCompositionConfig sets baseUrl from app.dev.baseUrl (the live E2eExecutionStrategy crash fix)", () => {
  const app = cfg("factory-baseurl");
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  assert.equal(config.baseUrl, "https://dev", "baseUrl must be threaded from app.dev.baseUrl into CompositionConfig, not just the FaultInjectionOracle");
});

test("buildRewrittenCompositionConfig leaves baseUrl absent for a code-mode app (no dev block)", () => {
  const app: AppConfig = { ...cfg("factory-baseurl-code"), code: true, dev: undefined };
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  assert.equal(config.baseUrl, undefined);
});

test("buildRewrittenCompositionConfig sets testIdAttribute from app.e2e.testIdAttribute (closes the worst audit-2026-07 flaky-selector leak on the rewritten path)", () => {
  const app: AppConfig = { ...cfg("factory-testid"), e2e: { testIdAttribute: "data-qa" } };
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  assert.equal(config.testIdAttribute, "data-qa");
});

test("buildRewrittenCompositionConfig leaves testIdAttribute undefined when the app declares none (NO 'data-testid' default here — the seed playwright.config.ts owns that default)", () => {
  const app = cfg("factory-testid-absent");
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  assert.equal(config.testIdAttribute, undefined);
});

test("buildRewrittenCompositionConfig sets mode from the passed run param, not a hardcoded 'diff'", () => {
  const app = cfg("factory-mode-manual");
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "manual" });
  assert.equal(config.mode, "manual");
});

test("buildRewrittenCompositionConfig sets guidance from the passed run param when present", () => {
  const app = cfg("factory-guidance");
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", {
    mode: "manual",
    guidance: "test the contact form",
  });
  assert.equal(config.guidance, "test the contact form");
});

test("buildRewrittenCompositionConfig leaves guidance absent when the run param omits it", () => {
  const app = cfg("factory-guidance-absent");
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  assert.equal(config.guidance, undefined);
});

test("buildRewrittenCompositionConfig selects the code target + Stryker oracle for a code:true app", () => {
  const app: AppConfig = { ...cfg("factory-code"), code: true, dev: undefined };
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-def5678-run2", { mode: "diff" });
  assert.equal(config.target, "code");
  assert.equal(config.isCode, true);
  assert.equal(config.versionUrl, undefined, "a code-mode app has no dev.versionUrl — no deploy gate");
  assert.equal(config.versionPoll, undefined);
});

test("buildRewrittenCompositionConfig honors coveragePolicy from app.qa.changeCoverage", () => {
  const app: AppConfig = { ...cfg("factory-coverage"), qa: { ...cfg("factory-coverage").qa, changeCoverage: { mode: "enforce", minRatio: 0.85 } } };
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-cov1234-run3", { mode: "diff" });
  assert.equal(config.coveragePolicyMode, "enforce");
  assert.equal(config.coveragePolicy.mode, "enforce");
  assert.equal(config.coveragePolicy.minRatio, 0.85);
});

// ── CRITICAL fix (judgment-day) — branch/namespace MUST be per-run, not a static literal ─────────
// Legacy computes a per-run namespace via testDataNamespace(prefix, sha, runId) (src/qa/test-data.ts,
// called at src/pipeline.ts:1222) and that namespace flows into BOTH GenerationPort and
// ExecutionPort's `namespace` field via cfg.branch (composition-root.ts wireBridges()). A STATIC
// branch literal means every run of every app collides on the SAME DEV test-data namespace —
// these tests pin that buildRewrittenCompositionConfig's `branch` field now MIRRORS the exact
// namespace it is given, per call, with no hardcoded fallback.

test("buildRewrittenCompositionConfig sets branch to the PASSED namespace, not a static literal", () => {
  const app = cfg("factory-namespace");
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-runA", { mode: "diff" });
  assert.equal(config.branch, "qa-bot-abc1234-runA", "branch must equal the per-run namespace passed in, not a hardcoded literal");
});

test("two calls to buildRewrittenCompositionConfig with DIFFERENT namespaces produce DIFFERENT branch values", () => {
  const app = cfg("factory-namespace-diff");
  const configRun1 = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-runA", { mode: "diff" });
  const configRun2 = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-runB", { mode: "diff" });
  assert.notEqual(configRun1.branch, configRun2.branch, "two runs must never collide on the same DEV test-data namespace/branch");
  assert.equal(configRun1.branch, "qa-bot-abc1234-runA");
  assert.equal(configRun2.branch, "qa-bot-abc1234-runB");
});

// ── createRewrittenEngineFactory — the RunnerDeps.engineFactory seam ──────────────────────────────
// buildProduction(env, cfg) internally re-checks selectEngine(env) itself (composition-root.ts) —
// on its "legacy" branch it THROWS unless a legacyRunner is supplied (which this factory never
// supplies, matching runner.ts's own dispatch guard: `engine === "rewritten" && deps.engineFactory`
// already ensures the factory is only ever invoked once the flag already resolved to "rewritten").
// These tests set PIPELINE_ENGINE=rewritten around the factory(...) call to exercise its REAL,
// documented calling contract instead of the (also-real, also-tested below) fail-safe throw.

test("createRewrittenEngineFactory returns a factory whose output satisfies RunPipelinePort (has a run() fn)", () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const factory = createRewrittenEngineFactory({ getAgentDeps: stubAgentDeps });
    const port = factory(cfg("factory-port-shape"), "qa-bot-abc1234-runA", { mode: "diff" });
    assert.equal(typeof port.run, "function", "the returned RunPipelinePort must expose run()");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

test("createRewrittenEngineFactory never calls getAgentDeps during construction (lazy — only real generation/review calls .open())", () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    let calls = 0;
    const factory = createRewrittenEngineFactory({
      getAgentDeps: () => {
        calls++;
        return stubAgentDeps();
      },
    });
    factory(cfg("factory-lazy-agent"), "qa-bot-abc1234-runA", { mode: "diff" });
    assert.equal(calls, 0, "constructing the factory + composing the port must not eagerly open an agent session");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

test("createRewrittenEngineFactory's port throws a clear error if ever invoked while PIPELINE_ENGINE is legacy (defense-in-depth — the runner's own dispatch guard is the real protection)", () => {
  const factory = createRewrittenEngineFactory({ getAgentDeps: stubAgentDeps });
  assert.throws(() => factory(cfg("factory-legacy-guard"), "qa-bot-abc1234-runA", { mode: "diff" }), /PIPELINE_ENGINE is 'legacy'/);
});

test("createRewrittenEngineFactory's returned closure threads the namespace argument into branch for two consecutive calls with different namespaces", () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const factory = createRewrittenEngineFactory({ getAgentDeps: stubAgentDeps });
    const app = cfg("factory-closure-namespace");
    // Both calls build a REAL RunPipelinePort via buildProduction — we cannot read `.branch` off
    // the port itself, but buildRewrittenCompositionConfig (already pinned above) proves the config
    // it builds carries branch=namespace; this test proves the FACTORY CLOSURE's own arity accepts
    // and threads a second, distinct namespace argument without throwing (the composition succeeds
    // for both), which is the observable contract at the createRewrittenEngineFactory seam.
    const portRun1 = factory(app, "qa-bot-abc1234-runA", { mode: "diff" });
    const portRun2 = factory(app, "qa-bot-abc1234-runB", { mode: "diff" });
    assert.equal(typeof portRun1.run, "function");
    assert.equal(typeof portRun2.run, "function");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

// ── PIPELINE_ENGINE dispatch integration — with a REAL engineFactory this time (not a fake port) ──
// Proves the same fail-safe contract runner.test.ts already pins for a fake port ALSO holds for the
// real production factory: absent PIPELINE_ENGINE never reaches engineFactory (the factory is
// constructed but never invoked), so the legacy runPipeline path stays byte-identical.

test("PIPELINE_ENGINE unset — the runner takes legacy, the REAL rewritten engineFactory is never invoked", async () => {
  const queue = new JobQueue();
  let factoryInvoked = false;
  const realFactory = createRewrittenEngineFactory({ getAgentDeps: stubAgentDeps });
  const id = enqueueTrackedRun(
    queue,
    { app: "factory-dispatch-absent", sha: "abc1234", target: "e2e", mode: "diff", source: "manual" },
    {
      pipeline: stubPipelineDeps(),
      loadApp: cfg,
      engineFactory: (appConfig, namespace, run) => {
        factoryInvoked = true;
        return realFactory(appConfig, namespace, run);
      },
    },
  );
  await queue.drain();
  const r = getRecord(id)!;
  assert.equal(r.status, "done");
  assert.equal(r.verdict, "pass", "the legacy stub pipeline ran — proves the legacy branch, not the rewritten port");
  assert.equal(factoryInvoked, false, "with PIPELINE_ENGINE absent, the REAL rewritten engineFactory must never be consulted");
});

test("PIPELINE_ENGINE=legacy (explicit) — same fail-safe holds for the real factory", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "legacy";
  try {
    const queue = new JobQueue();
    let factoryInvoked = false;
    const realFactory = createRewrittenEngineFactory({ getAgentDeps: stubAgentDeps });
    const id = enqueueTrackedRun(
      queue,
      { app: "factory-dispatch-legacy", sha: "abc1234", target: "e2e", mode: "diff", source: "manual" },
      {
        pipeline: stubPipelineDeps(),
        loadApp: cfg,
        engineFactory: (appConfig, namespace, run) => {
          factoryInvoked = true;
          return realFactory(appConfig, namespace, run);
        },
      },
    );
    await queue.drain();
    const r = getRecord(id)!;
    assert.equal(r.verdict, "pass");
    assert.equal(factoryInvoked, false);
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});
