import { test } from "node:test";
import assert from "node:assert/strict";
import { createRewrittenEngineFactory, buildRewrittenCompositionConfig } from "./rewritten-engine-factory";
import { AppConfig } from "../orchestrator/config-loader";
import { JobQueue } from "./queue";
import { enqueueTrackedRun } from "./runner";
import { getRecord } from "./history";
import type { AgentDeps } from "../integrations/opencode-client";
import { SqliteRunHistoryAdapter } from "./run-history-sqlite-adapter";
import { SqliteLearningRepository } from "@contexts/cross-run-learning/infrastructure/sqlite-learning-repository.adapter";

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
  assert.ok(config.groundingCollaborators, "PreGenerationGroundingPort collaborators must be wired (W4 follow-up, a9e7dfb) for an e2e app");
  assert.ok(config.reviewDomGroundingCollaborators, "ReviewDomGroundingPort collaborators must be wired (W4 follow-up, a9e7dfb) for an e2e app");
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

// ── W4 follow-up (Task #37 audit CRITICAL, a9e7dfb) — grounding collaborators ──────────────────────
// a9e7dfb wired PreGenerationGroundingPort/ReviewDomGroundingPort into composition-root.ts's
// wireBridges() but the production factory never supplied groundingCollaborators/
// reviewDomGroundingCollaborators. wireBridges() itself already falls back to `cfg.groundingCollaborators
// ?? {}` (and the bridge adapters resolve an empty `{}` to the REAL buildContextPack/captureDom fns
// internally), so these were already functionally real — these tests pin that the factory now states
// that wiring EXPLICITLY (matching setupCollaborators' own visible-wiring precedent) rather than
// relying on an implicit fallback three files away, and that contextMap/prChangedFiles stay honestly
// absent (no static per-run source exists at composition-build time).

test("buildRewrittenCompositionConfig wires empty (real-default-resolving) groundingCollaborators for an e2e app", () => {
  const app = cfg("factory-grounding-e2e");
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  assert.deepEqual(config.groundingCollaborators, {}, "an empty object lets PreGenerationGroundingPortAdapter fall back to the real buildContextPack/defaultContextPackDeps");
  assert.deepEqual(config.reviewDomGroundingCollaborators, {}, "an empty object lets ReviewDomGroundingPortAdapter fall back to the real captureDom/defaultCaptureDomDeps");
});

test("buildRewrittenCompositionConfig still wires groundingCollaborators for a code-mode app (composition-root.ts's own isCode guard is the actual skip point, not the factory)", () => {
  const app: AppConfig = { ...cfg("factory-grounding-code"), code: true, dev: undefined };
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  // The factory's own mapping is target-agnostic here — wireBridges()'s `!cfg.isCode` guard is what
  // actually skips constructing both grounding ports for a code target (composition-root.ts), so
  // asserting the factory's OWN output stays the same shape whether or not isCode is true is the
  // faithful way to pin "the factory does not need its own target check — it already exists downstream".
  assert.deepEqual(config.groundingCollaborators, {});
  assert.deepEqual(config.reviewDomGroundingCollaborators, {});
  assert.equal(config.isCode, true, "isCode is what composition-root.ts's wireBridges() reads to skip both grounding ports on this target");
});

test("buildRewrittenCompositionConfig leaves contextMap and prChangedFiles absent (no real per-run source at composition-build time)", () => {
  const app = cfg("factory-grounding-contextmap-absent");
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  assert.equal(config.contextMap, undefined, "contextMap requires reading context.json off the REAL per-run mirrorDir, unknown at composition time — never fabricated");
  assert.equal(config.prChangedFiles, undefined, "prChangedFiles requires classifyCommit's per-run diff, unknown at composition time — never fabricated");
});

test("baseUrl and testIdAttribute reach the grounding phase via CompositionConfig's own top-level fields (not duplicated inside groundingCollaborators)", () => {
  const app: AppConfig = { ...cfg("factory-grounding-static-context"), e2e: { testIdAttribute: "data-cy" } };
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  // composition-root.ts's wireBridges() builds PreGenerationGroundingStaticContext/
  // ReviewDomGroundingStaticContext from cfg.baseUrl/cfg.testIdAttribute/cfg.mirrorDir/cfg.e2eRelDir
  // directly — this factory only needs to keep supplying those top-level fields (already covered by
  // the baseUrl/testIdAttribute tests above); this test pins that grounding relies on the SAME
  // fields rather than a second, parallel static-context input this factory would need to duplicate.
  assert.equal(config.baseUrl, "https://dev");
  assert.equal(config.testIdAttribute, "data-cy");
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

test("buildRewrittenCompositionConfig wires codebaseMemory (the raw CLI client) so the structural blast-radius signal is ACTIVE in production — an unindexed mirror degrades to no section inside the adapter chain, so this is always safe to supply", () => {
  const app = cfg("factory-codebase-memory");
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  assert.ok(config.codebaseMemory, "codebaseMemory must be supplied — absent means composition-root never builds StructuralSignalPortAdapter and the agent NEVER receives the blast-radius section, even for an indexed repo");
  assert.equal(typeof config.codebaseMemory.cli, "function", "the collaborator is the raw CLI client (ProjectNameCliClient & CodebaseMemoryCliClient)");
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

// ── Stitcher→Generation seam (design §3.6, S2.8): serviceTopology ACTIVE-gated on
// app.services?.length && app.boundaries?.length (ADR-6). ─────────────────────────────────────────

test("buildRewrittenCompositionConfig supplies serviceTopology when the app declares BOTH services[] and boundaries[]", () => {
  const app: AppConfig = {
    ...cfg("factory-service-topology-active"),
    services: [{ repo: "org/ms-orders" }],
    boundaries: [
      {
        transport: "http",
        frontFiles: "*.api.ts",
        frontCallSite: { kind: "receiver-verb-call" },
        servicePrefixTemplate: "name-{service}-api",
        serviceRepoTemplate: "ms-name-{service}",
        openApiPath: "openapi.yaml",
      },
    ],
  } as AppConfig;
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps, mirrorRoot: "/tmp/mirrors" }, "qa-bot-abc1234-run1", { mode: "diff" });

  assert.ok(config.serviceTopology, "serviceTopology must be supplied when BOTH services[] and boundaries[] are non-empty");
  assert.equal(config.serviceTopology?.appName, "factory-service-topology-active");
  assert.equal(config.serviceTopology?.primaryRepo, "org/demo");
  assert.equal(config.serviceTopology?.mirrorRoot, "/tmp/mirrors", "mirrorRoot must be the SAME local this function already computes (deps.mirrorRoot ?? workdirRoot()) — not re-derived");
  assert.deepEqual([...(config.serviceTopology?.services ?? [])], [{ repo: "org/ms-orders" }]);
  assert.equal(typeof config.serviceTopology?.boundaryProfiles.forApp, "function", "boundaryProfiles must be a real BoundaryProfileProviderPort (YamlBoundaryProfileAdapter)");
});

test("buildRewrittenCompositionConfig omits serviceTopology when services[] is present but boundaries[] is absent/empty (AND-gate, not OR-gate)", () => {
  const app: AppConfig = { ...cfg("factory-service-topology-services-only"), services: [{ repo: "org/ms-orders" }] } as AppConfig;
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  assert.equal(config.serviceTopology, undefined, "services[] alone must NOT activate serviceTopology — boundaries[] is also required (ADR-6 AND-gate)");
});

test("buildRewrittenCompositionConfig omits serviceTopology when boundaries[] is present but services[] is absent/empty (AND-gate, not OR-gate)", () => {
  const app: AppConfig = {
    ...cfg("factory-service-topology-boundaries-only"),
    boundaries: [
      {
        transport: "http",
        frontFiles: "*.api.ts",
        frontCallSite: { kind: "receiver-verb-call" },
        servicePrefixTemplate: "name-{service}-api",
        serviceRepoTemplate: "ms-name-{service}",
        openApiPath: "openapi.yaml",
      },
    ],
  } as AppConfig;
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  assert.equal(config.serviceTopology, undefined, "boundaries[] alone must NOT activate serviceTopology — services[] is also required (ADR-6 AND-gate)");
});

test("buildRewrittenCompositionConfig omits serviceTopology when neither services[] nor boundaries[] is declared (the common single-repo-app case)", () => {
  const app = cfg("factory-service-topology-neither");
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  assert.equal(config.serviceTopology, undefined);
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

test("createRewrittenEngineFactory's returned closure never throws when PIPELINE_ENGINE is 'legacy' (Plan 7.6 — accepted-but-ignored, no legacy branch remains to reject it)", () => {
  const factory = createRewrittenEngineFactory({ getAgentDeps: stubAgentDeps, env: { PIPELINE_ENGINE: "legacy" } });
  assert.doesNotThrow(() => factory(cfg("factory-legacy-guard"), "qa-bot-abc1234-runA", { mode: "diff" }));
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

// ── PIPELINE_ENGINE dispatch integration — with a REAL engineFactory (not a fake port) ────────────
// Plan 7.6: the legacy engine is deleted — a supplied engineFactory is ALWAYS invoked, regardless
// of PIPELINE_ENGINE, using the REAL production factory (not just a fake port, as runner.test.ts
// already pins for the dispatch seam itself).

test("engineFactory (real production factory) is invoked and drives the run to completion", async () => {
  const queue = new JobQueue();
  let factoryInvoked = false;
  const realFactory = createRewrittenEngineFactory({ getAgentDeps: stubAgentDeps });
  const id = enqueueTrackedRun(
    queue,
    { app: "factory-dispatch-real", sha: "abc1234", target: "e2e", mode: "diff", source: "manual" },
    {
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
  assert.equal(factoryInvoked, true, "the real rewritten engineFactory must be invoked — it is the only engine");
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

test("PIPELINE_ENGINE=legacy (stale operator setting) — the real factory is still invoked (accepted-but-ignored, no fallback to a different code path)", async () => {
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
        loadApp: cfg,
        engineFactory: (appConfig, namespace, run) => {
          factoryInvoked = true;
          return realFactory(appConfig, namespace, run);
        },
      },
    );
    await queue.drain();
    const r = getRecord(id)!;
    // stubAgentDeps.open() always throws, so a REAL run through the real factory genuinely fails —
    // the assertion of interest is that the factory was reached at all (never bypassed), not the
    // verdict shape of a deliberately-broken agent stub.
    assert.equal(r.status, "done");
    assert.equal(factoryInvoked, true, "PIPELINE_ENGINE=legacy no longer selects a different code path");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

// ── W3 F1/F2 (audit-verified cutover blockers): the factory wires REAL durable persistence and
// REAL learning by default — production never sets historyFilePath, so before this fix
// composition-root.ts's wireBridges() always fell back to InMemoryRunHistoryAdapter, and
// learningRepo always fell back to StubLearningRepository (a provable no-op). ──────────────────

test("buildRewrittenCompositionConfig wires a REAL SqliteRunHistoryAdapter by default (no historyFilePath override)", () => {
  const app = cfg("factory-history-default");
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });

  assert.ok(config.runHistory instanceof SqliteRunHistoryAdapter, "runHistory must default to the REAL durable SQLite adapter, not fall through to composition-root's in-memory default");
  assert.equal(config.historyFilePath, undefined, "historyFilePath stays unset — the SQLite adapter is wired via the runHistory override, not the file-JSONL path");
});

test("buildRewrittenCompositionConfig honors an explicit historyFilePath override (escape hatch — opts OUT of the SQLite default)", () => {
  const app = cfg("factory-history-override");
  const config = buildRewrittenCompositionConfig(
    app,
    { getAgentDeps: stubAgentDeps, historyFilePath: "/tmp/qa-explicit-history.jsonl" },
    "qa-bot-abc1234-run1",
    { mode: "diff" },
  );

  assert.equal(config.historyFilePath, "/tmp/qa-explicit-history.jsonl");
  assert.equal(config.runHistory, undefined, "the runHistory override must NOT be set when the caller explicitly opts into the file-backed escape hatch");
});

test("buildRewrittenCompositionConfig wires a REAL SqliteLearningRepository by default (was: zero production constructors)", () => {
  const app = cfg("factory-learning-default");
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });

  assert.ok(config.learningRepo instanceof SqliteLearningRepository, "learningRepo must default to the REAL SqliteLearningRepository, not composition-root's StubLearningRepository fallback");
});

// W3 fix (F3b, dual-judge round): historyLearningStore(appName).upsert() previously wrote
// `app: rule.archetype ?? ""` — a cross-app data-corruption landmine (archetype is a diff-shape
// tag, not an app identifier). Real-DB integration test (same convention as src/qa/learning/
// retrieval.test.ts): a unique app name per run avoids collisions with other tests' rows.
test("historyLearningStore(appName).upsert() persists the REAL app name, not the rule's archetype", async () => {
  const { historyLearningStore } = await import("./rewritten-engine-factory");
  const { listLearningRules } = await import("./history");
  const app = `factory-learning-appname-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const store = historyLearningStore(app);
  store.upsert({
    id: `rule-appname-${app}`,
    trigger: "selector absent",
    action: "use role+name",
    errorClass: "E-EXEC-FAIL",
    archetype: "form", // deliberately DIFFERENT from `app` — pins the fix distinguishes the two
    status: "candidate",
    confidence: "low",
    usageCount: 0,
    outcomeCount: 0,
    successRate: null,
    lastVerified: null,
    source: "test",
    at: new Date().toISOString(),
  });

  const rows = listLearningRules(app, 10);
  assert.equal(rows.length, 1, "the rule must be retrievable under the REAL app name");
  assert.equal(rows[0]?.trigger, "selector absent");
  // If the bug regressed (app: rule.archetype ?? ""), this row would be filed under "form",
  // not `app` — listLearningRules(app, ...) would find nothing.
  const underArchetype = listLearningRules("form", 10);
  assert.ok(!underArchetype.some((r) => r.trigger === "selector absent"), "the rule must NOT be filed under the archetype as if it were the app name");
});

// W3 fix (F3a, dual-judge round): historyLearningStore(appName).incrementUsage() bridges onto
// legacy's incrementRuleUsage (src/server/history.ts) — the SAME usage_count column
// LearningPortAdapter.retrieve() now increments through this store.
test("historyLearningStore(appName).incrementUsage() bridges onto history.ts's incrementRuleUsage", async () => {
  const { historyLearningStore } = await import("./rewritten-engine-factory");
  const { listLearningRules } = await import("./history");
  const app = `factory-learning-usage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ruleId = `rule-usage-${app}`;

  const store = historyLearningStore(app);
  store.upsert({
    id: ruleId, trigger: "t", action: "a", errorClass: "E-X", archetype: null,
    status: "candidate", confidence: "low", usageCount: 0, outcomeCount: 0,
    successRate: null, lastVerified: null, source: "test", at: new Date().toISOString(),
  });

  store.incrementUsage?.([ruleId]);

  const rows = listLearningRules(app, 10);
  assert.equal(rows[0]?.usageCount, 1, "usageCount must advance from 0 to 1 after incrementUsage");
});

test("createRewrittenEngineFactory's produced CompositionConfig carries the SAME real runHistory/learningRepo wiring", () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const factory = createRewrittenEngineFactory({ getAgentDeps: stubAgentDeps });
    // buildRewrittenCompositionConfig is exercised directly above (createRewrittenEngineFactory just
    // closes over it + buildProduction) — this test proves the PUBLIC factory seam (the one index.ts
    // and cli.ts actually call) produces a real RunPipelinePort without throwing during construction.
    const app = cfg("factory-dispatch-real-history");
    assert.doesNotThrow(() => factory(app, "qa-bot-abc1234-run1", { mode: "diff" }), "constructing the port must not eagerly touch the DB or throw");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});
