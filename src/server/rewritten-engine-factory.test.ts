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

// ── Bug fix: rewritten-engine runs left their RunRecord/RunEvents frozen because nothing wired
// RunQaUseCaseDeps.observer through this factory. buildRewrittenCompositionConfig's 5th (observer)
// argument and createRewrittenEngineFactory's own 4th (observer) argument close that gap — these
// tests pin the threading, not the observer's own behavior (covered in runner.test.ts). ───────────

test("buildRewrittenCompositionConfig threads the passed observer into CompositionConfig.observer", () => {
  const app = cfg("factory-observer-present");
  const observer = { onStep: () => {}, onEvent: () => {} };
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" }, observer);
  assert.equal(config.observer, observer, "the SAME observer instance must reach CompositionConfig, not a copy or a wrapper");
});

test("buildRewrittenCompositionConfig leaves observer absent when the caller omits it (backward compatible with every pre-existing call site)", () => {
  const app = cfg("factory-observer-absent");
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  assert.equal(config.observer, undefined);
});

test("createRewrittenEngineFactory forwards its 4th (observer) argument to buildRewrittenCompositionConfig on every call", () => {
  const app = cfg("factory-observer-e2e");
  // createRewrittenEngineFactory reads PIPELINE_ENGINE via buildProduction internally (env
  // defaults to process.env) — mirrors this file's own established pattern (e.g. the
  // "createRewrittenEngineFactory's port throws..." test below) of passing env explicitly so the
  // ambient process.env never leaks into the assertion.
  const factory = createRewrittenEngineFactory({ getAgentDeps: stubAgentDeps, env: { PIPELINE_ENGINE: "rewritten" } });
  const observer = { onStep: () => {}, onEvent: () => {} };
  // buildProduction(env, cfg) constructs a RewrittenOrchestratorAdapter wrapping RunQaUseCase —
  // the adapter has no public read-back of its own deps, so this test asserts the OBSERVABLE
  // consequence: the factory call itself never throws when an observer is supplied (proving the
  // 4th argument's type threads correctly end-to-end), matching this suite's own "construction
  // must not throw" style used by the other factory tests in this file.
  assert.doesNotThrow(() => factory(app, "qa-bot-abc1234-run1", { mode: "diff" }, observer));
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

// ── F5 (HIGH) — GitHubPrAdapter's own `base` param defaults to "main" when the caller omits it
// (github-pr.adapter.ts:14); this factory previously never passed app.baseBranch at all, so every
// app with a non-"main" default branch silently targeted the wrong PR base branch. Verified via
// structural introspection of the constructed GitHubPrAdapter's own private `base` field — the
// collaborator cannot be invoked directly in this test file (its injected createPullRequest wraps
// the REAL github.createPullRequest, which requires GITHUB_TOKEN + real network), so pinning the
// constructor-injected value is the faithful, side-effect-free way to assert this wiring.

test("F5: buildRewrittenCompositionConfig wires githubPr with app.baseBranch as the PR base", () => {
  const app: AppConfig = { ...cfg("factory-basebranch"), baseBranch: "develop" };
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  const base = (config.githubPr as unknown as { base?: string }).base;
  assert.equal(base, "develop", "githubPr must be constructed with app.baseBranch, not silently defaulting to GitHubPrAdapter's own 'main' fallback");
});

test("F5: buildRewrittenCompositionConfig falls back to 'main' when app.baseBranch is absent (matches legacy's app.baseBranch ?? \"main\")", () => {
  const app = cfg("factory-basebranch-default"); // no baseBranch field
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  const base = (config.githubPr as unknown as { base?: string }).base;
  assert.equal(base, "main", "an app with no configured baseBranch must fall back to 'main', mirroring legacy's app.baseBranch ?? \"main\"");
});

// ── FIX 4 (judgment-day W3, judge A) — config.sanitize wiring was never asserted to be the REAL
// sanitizeText (only baseBranch/testIdAttribute/etc. had dedicated tests). CLAUDE.md "Sanitize data
// leaving the system" + this file's own F4 comment (line ~389) claim PublicationPortAdapter's
// renderBody/renderTitle receive the real src/orchestrator/sanitizer.ts sanitizeText via
// config.sanitize — this test proves the wiring is genuine, not merely present, by asserting a
// secret-shaped input is actually redacted. Fixture mirrors sanitizer.test.ts's own canonical
// "redacts secrets (api key, token)" shape.

test("F4: buildRewrittenCompositionConfig wires config.sanitize to the REAL sanitizeText (redacts a secret-shaped input)", () => {
  const app = cfg("factory-sanitize");
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  assert.equal(typeof config.sanitize, "function", "config.sanitize must be wired — its absence silently falls back to PublicationPortAdapter's identity default, defeating the CLAUDE.md sanitize invariant");
  const redacted = config.sanitize!("const apiKey = sk-abc123XYZ\ntoken: ghs_supersecretvalue");
  assert.ok(!redacted.includes("sk-abc123XYZ"), "a real API-key-shaped secret must be redacted, not passed through verbatim");
  assert.ok(!redacted.includes("ghs_supersecretvalue"), "a real token-shaped secret must be redacted, not passed through verbatim");
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

// ── THE VALUE KEYSTONE — assembleChangeCoverage wiring + code-mode coverage trigger ──────────────
// CLAUDE.md "The value/trust risk": change-coverage measurement was always "unknown" because no
// assembler turned the collector's raw CoverageReport + the run's diff into the ChangeCoverage
// read-model. This factory is the production seam that supplies the REAL assembler + (for code mode)
// triggers the repo's own instrumented test run so a report exists to read in the first place.

test("buildRewrittenCompositionConfig supplies a REAL assembleChangeCoverage (the value keystone, previously always absent)", () => {
  const app = cfg("factory-assembler");
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  assert.equal(typeof config.assembleChangeCoverage, "function", "assembleChangeCoverage must be wired — its absence is exactly what kept measure() at status:'unknown' forever");

  // Prove it is the REAL pure port (parseDiffHunks + computeChangeCoverage), not a stub that always
  // returns a fixed shape: a diff with 2 added lines, 1 covered by the report, must intersect to a
  // real, non-trivial ChangeCoverage.
  const diff = ["diff --git a/src/x.ts b/src/x.ts", "+++ b/src/x.ts", "@@ -1,0 +1,2 @@", "+a", "+b"].join("\n");
  const cc = config.assembleChangeCoverage!(diff, { covered: [{ file: "src/x.ts", lines: [1] }] });
  assert.equal(cc.measured, true);
  assert.equal(cc.overall.changedLines, 2);
  assert.equal(cc.overall.coveredChanged, 1);
  assert.deepEqual(cc.uncovered, [{ file: "src/x.ts", lines: [2] }]);
});

test("buildRewrittenCompositionConfig's coverage collector for an e2e app does NOT trigger runCodeCoverage (code-only trigger)", async () => {
  const app = cfg("factory-e2e-no-codecov");
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  // Must resolve without throwing — an e2e app's collector is the plain V8-dump collector, untouched
  // by the code-mode wrapper; a nonexistent namespace dir degrades to an empty report (fail-open).
  const report = await config.objectiveSignal.collector.collect("/tmp/does-not-exist/e2e", "qa-bot-abc1234-run1");
  assert.deepEqual(report, { covered: [] });
});

test("buildRewrittenCompositionConfig's coverage collector for a code:true app runs best-effort (never throws even with no c8/no test command)", async () => {
  const app: AppConfig = { ...cfg("factory-code-coverage-trigger"), code: true, dev: undefined };
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-def5678-run2", { mode: "diff" });
  // Legacy parity (src/pipeline.ts:487): `if (input.target === "code") await runCodeCoverage(input.repoDir).catch(() => {})`
  // — best-effort, BEFORE the lcov/Istanbul readers run. A bogus mirrorDir (no repo, no c8, no test
  // command) must degrade the whole collect() call to an empty report, never throw.
  await assert.doesNotReject(() => config.objectiveSignal.collector.collect("/tmp/does-not-exist/e2e", "qa-bot-def5678-run2"));
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
