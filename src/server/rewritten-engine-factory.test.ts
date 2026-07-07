import { test } from "node:test";
import assert from "node:assert/strict";
import { createRewrittenEngineFactory, buildRewrittenCompositionConfig, buildVcsPublish } from "./rewritten-engine-factory";
import { AppConfig } from "../orchestrator/config-loader";
import { JobQueue } from "./queue";
import { enqueueTrackedRun } from "./runner";
import { getRecord } from "./history";
import type { AgentDeps } from "../integrations/opencode-client";
import { defaultMirrorDeps, type MirrorDeps } from "../integrations/repo-mirror";
import { SqliteRunHistoryAdapter } from "./run-history-sqlite-adapter";
import { SqliteLearningRepository } from "@contexts/cross-run-learning/infrastructure/sqlite-learning-repository.adapter";
import { Sha } from "@kernel/sha";
import { REVIEWER_TIMEOUT_MS, withUsageSink, withStallWatchdog, withSessionRegistration, activityRouter } from "../integrations/opencode-client";

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
  assert.ok(config.validationStrategies.e2e, "e2e validation (static gate) collaborator must be wired");
  assert.ok(config.validationStrategies.code, "code validation (compile gate, WS2.2 full-flow remediation) collaborator must be wired");
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
  assert.ok(config.vcsWrite, "PROD-BLOCKER fix: vcsWrite collaborator must be wired — without it the 'pr' route throws at publish() time instead of silently opening a PR against an unpushed branch");
  assert.equal(typeof config.checkout, "function");
});

// ── follow-up #27: bounded contract-repair (RepairPort) wired into the rewritten production path ──
// Before this fix, GenerateTestsUseCase.GenerationPorts.repair was constructed nowhere in this
// factory — the generator/reviewer contract-repair branches (generate-tests.use-case.ts's own
// `if (repair)` guards) were dormant in production: a malformed verdict got NO bounded re-prompt and
// the fail-closed gate fired immediately. This test asserts the composed use-case's `repair` port is
// non-undefined (structural — proves the factory wires it), and a companion integration test below
// drives a malformed generator verdict through the REAL wrapped checkGeneratorVerdict/repairInstruction
// to prove the branch actually activates.
test("buildRewrittenCompositionConfig wires a non-undefined RepairPort into GenerateTestsUseCase (the bounded contract-repair was dormant on the production path before this fix)", () => {
  const app = cfg("factory-repair");
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  // GenerationPorts.repair is a private constructor field on GenerateTestsUseCase — reach into it
  // structurally (same class, no public accessor exists) to confirm the factory actually supplied it.
  const ports = (config.generationUseCase as unknown as { ports: { repair?: unknown } }).ports;
  assert.ok(ports.repair, "GenerationPorts.repair must be wired (was dormant/undefined before this fix)");
});

test("the composed RepairPort drives GenerateTestsUseCase's generator-contract-check branch end-to-end: a malformed verdict text triggers exactly one repair via the real wrapped checkGeneratorVerdict", async () => {
  const app = cfg("factory-repair-e2e");

  let promptCount = 0;
  const capturedRepairPrompts: string[] = [];
  // Stub AgentDeps.open so the composed real runtime adapter drives the use-case without a live
  // OpenCode/Codex process — mirrors this factory's own construction contract (AgentRuntimeAdapter's
  // `open` closure calls deps.getAgentDeps().open(...) lazily, only when generate() actually runs).
  const fakeAgentDeps: AgentDeps = {
    open: async () => ({
      id: "fake-session",
      prompt: async (text: string) => {
        promptCount++;
        if (promptCount === 1) {
          // Malformed generator output: no closing verdict JSON with a `specs` array at all —
          // checkGeneratorVerdict (src/integrations/verdict-validate.ts) must reject this.
          return "I wrote the tests but forgot to emit the closing JSON verdict.";
        }
        // The bounded repair turn: capture what the repair instruction actually said, then emit a
        // valid verdict so the use-case can complete.
        capturedRepairPrompts.push(text);
        return '{"specs":["flows/repaired.spec.ts"]}';
      },
      dispose: async () => {},
    }),
  };
  const repairApp = buildRewrittenCompositionConfig(
    app,
    { getAgentDeps: () => fakeAgentDeps },
    "qa-bot-abc1234-run1",
    { mode: "diff" },
  );

  const result = await repairApp.generationUseCase.generate({
    repo: app.repo,
    sha: "shaRepair1",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    needsReview: false,
    target: "e2e",
    mode: "diff",
    appName: app.name,
  });

  assert.equal(promptCount, 2, "exactly one initial prompt + one bounded repair re-prompt");
  assert.equal(capturedRepairPrompts.length, 1, "the repair instruction fired exactly once");
  assert.match(
    capturedRepairPrompts[0] ?? "",
    /no closing verdict JSON found/,
    "the repair instruction names the real checkGeneratorVerdict issue text",
  );
  assert.match(
    capturedRepairPrompts[0] ?? "",
    /I wrote the tests but forgot to emit the closing JSON verdict\./,
    "the repair instruction embeds the agent's own prior-turn output (priorResponseTail)",
  );
  assert.deepEqual(result.specs, ["flows/repaired.spec.ts"], "repaired specs reached the final result");
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

// ── WS6.1 (full-flow remediation, timeouts & operational observability) ──────────────────────────
// The factory must supply the purpose-built REVIEWER_TIMEOUT_MS (6min) as CompositionConfig.
// reviewTimeoutMs, so ReviewPortAdapter.review() stops silently inheriting the dispatcher's
// ~25.5min worst-case ceiling for a hung reviewer session.

test("buildRewrittenCompositionConfig sets reviewTimeoutMs to the exported REVIEWER_TIMEOUT_MS constant", () => {
  const app = cfg("factory-review-timeout");
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  assert.equal(config.reviewTimeoutMs, REVIEWER_TIMEOUT_MS, "the reviewer must get its OWN purpose-built budget, not the dispatcher's coarse ceiling");
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

// ── qa.structuralSignals calibration gate (Slice B, design §2/ADR-B2) — mode "off" must omit
// BOTH advisory collaborators (codebaseMemory + serviceTopology), never just one (the named
// half-gate hazard). Default (absent/"signal") stays byte-identical to today's behavior. ─────────

test("qa.structuralSignals mode 'off' omits BOTH codebaseMemory and serviceTopology (the half-gate hazard — asserting both, not just one)", () => {
  const app: AppConfig = {
    ...cfg("factory-structural-signals-off"),
    qa: { ...cfg("factory-structural-signals-off").qa, structuralSignals: { mode: "off" } },
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
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  assert.equal(config.codebaseMemory, undefined, "mode:off must omit codebaseMemory");
  assert.equal(config.serviceTopology, undefined, "mode:off must omit serviceTopology even though services[]+boundaries[] are both declared");
  assert.equal(config.crossRepoImpact, undefined, "mode:off must omit crossRepoImpact too — all three structural collaborators share the one gate");
});

test("buildRewrittenCompositionConfig supplies crossRepoImpact under the SAME gate as serviceTopology (signal + services[] + boundaries[])", () => {
  const app: AppConfig = {
    ...cfg("factory-cross-repo-impact-active"),
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
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  assert.ok(config.crossRepoImpact, "crossRepoImpact must be supplied when structuralSignals is not off and BOTH services[] and boundaries[] are declared");
  assert.equal(typeof config.crossRepoImpact?.mirrorRoot, "string", "crossRepoImpact must carry the mirrorRoot the factory already computes");
  assert.ok(config.crossRepoImpact?.runner, "crossRepoImpact must reuse a real runner instance for the fetch step");

  const noServices = buildRewrittenCompositionConfig(
    cfg("factory-cross-repo-impact-inactive"),
    { getAgentDeps: stubAgentDeps },
    "qa-bot-abc1234-run1",
    { mode: "diff" },
  );
  assert.equal(noServices.crossRepoImpact, undefined, "no services[]/boundaries[] declared must leave crossRepoImpact undefined");
});

test("qa.structuralSignals absent supplies codebaseMemory unconditionally (byte-identical to pre-change behavior)", () => {
  const app = cfg("factory-structural-signals-absent");
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  assert.ok(config.codebaseMemory, "absent config must keep supplying codebaseMemory — no behavior change");
});

test("qa.structuralSignals mode 'signal' supplies codebaseMemory unconditionally (explicit default, same as absent)", () => {
  const app: AppConfig = {
    ...cfg("factory-structural-signals-signal"),
    qa: { ...cfg("factory-structural-signals-signal").qa, structuralSignals: { mode: "signal" } },
  };
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  assert.ok(config.codebaseMemory, "mode:signal must keep supplying codebaseMemory — same as absent");
});

test("qa.structuralSignals mode 'signal' still supplies serviceTopology when services[]+boundaries[] are both declared (AND-gate unaffected)", () => {
  const app: AppConfig = {
    ...cfg("factory-structural-signals-signal-topology"),
    qa: { ...cfg("factory-structural-signals-signal-topology").qa, structuralSignals: { mode: "signal" } },
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
  assert.ok(config.serviceTopology, "mode:signal must not disturb the pre-existing services[]+boundaries[] AND-gate");
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

// ── P2b (post-cutover-remediation) Constraint 3: single-source derivation ─────────────────────
// Before this fix, coveragePolicyMode and coveragePolicy.mode were TWO INDEPENDENT reads of
// `app.qa.changeCoverage?.mode ?? "signal"` at different points in the same object literal — a
// duplicate-source bug that (if either read site drifted) could silently desynchronize the two
// fields. This test pins config.coveragePolicyMode === config.coveragePolicy.mode ACROSS EVERY
// mode value (not just "enforce", which the test above already covers) — coveragePolicyMode must
// be DERIVED from coveragePolicy.mode, not independently computed.
for (const mode of ["off", "signal", "enforce"] as const) {
  test(`buildRewrittenCompositionConfig derives coveragePolicyMode FROM coveragePolicy.mode (single source) — mode:${mode}`, () => {
    const app: AppConfig = { ...cfg(`factory-single-source-${mode}`), qa: { ...cfg(`factory-single-source-${mode}`).qa, changeCoverage: { mode, minRatio: 0.7 } } };
    const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, `qa-bot-src${mode}-run`, { mode: "diff" });
    assert.equal(config.coveragePolicyMode, config.coveragePolicy.mode, "coveragePolicyMode must equal coveragePolicy.mode — single source, never independently derived");
    assert.equal(config.coveragePolicyMode, mode);
  });
}

test("buildRewrittenCompositionConfig: coveragePolicyMode defaults to \"signal\" when app.qa.changeCoverage is absent, matching coveragePolicy.mode", () => {
  const app: AppConfig = cfg("factory-no-coverage-config");
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-nocov-run", { mode: "diff" });
  assert.equal(config.coveragePolicyMode, "signal");
  assert.equal(config.coveragePolicy.mode, "signal");
  assert.equal(config.coveragePolicyMode, config.coveragePolicy.mode);
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

// ── PROD-BLOCKER fix (buildVcsPublish) — the rewritten publish path never staged/committed/pushed
// the agent's generated tests before calling GitHub's PR API (VcsWriteAdapter, the only VcsWritePort
// implementation, was never instantiated anywhere in composition-root.ts — grep-confirmed zero
// references outside its own test). buildVcsPublish is the REAL git-write collaborator wired into
// CompositionConfig.vcsWrite (see the test above). Verified with an injected fake `git` fn (same
// convention as src/integrations/publish.test.ts's own deps() helper for this exact class of git-
// mechanics test) — no real subprocess/filesystem needed to pin the sequence/dispatch.

function fakeGit(status: string): { git: (args: string[], cwd?: string) => Promise<string>; calls: string[][] } {
  const calls: string[][] = [];
  const git = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (subcommandOf(args) === "status") return status;
    return "";
  };
  return { git, calls };
}

// The bare git subcommand of an argv, skipping any leading `-c <key=value>` config pairs — the
// auth-on-push / commit-identity decorations (adversarial-review CRITICALs, below) prepend -c pairs
// to some calls, so ordering assertions key on the subcommand, not args[0].
function subcommandOf(args: string[]): string | undefined {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args[i];
}

// Save/restore an env var around a test body — the auth/identity decorations read process.env at
// CALL time (legacy parity: publishChanges read GIT_AUTHOR_* per call, authHeaderArgs() reads
// GITHUB_TOKEN per call), so these tests control the env explicitly instead of inheriting whatever
// the developer's shell happens to export.
async function withEnv(vars: Record<string, string | undefined>, body: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await body();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("buildVcsPublish (e2e target): no changes under e2e/ -> reports changed:false and only queries status (skip-if-no-changes, no checkout/commit/push)", async () => {
  const { git, calls } = fakeGit("   \n  ");
  const vcsWrite = buildVcsPublish(false, git, () => {});

  const result = await vcsWrite.publish({ mirrorDir: "/mirrors/org/app", branch: "qa-bot/abc1234", sha: "abc1234" });

  assert.deepEqual(result, { changed: false });
  assert.deepEqual(calls.map(subcommandOf), ["status"], "no changes -> only the status check runs, never checkout/add/commit/push");
});

test("buildVcsPublish (e2e target): changes under e2e/ -> checkout -B, add, commit, push, in that order, scoped to the e2e/ pathspec", async () => {
  const { git, calls } = fakeGit(" M e2e/login.spec.ts");
  const vcsWrite = buildVcsPublish(false, git, () => {});

  const result = await vcsWrite.publish({ mirrorDir: "/mirrors/org/app", branch: "qa-bot/abc1234", sha: "abc1234" });

  assert.deepEqual(result, { changed: true });
  assert.deepEqual(calls.map(subcommandOf), ["status", "checkout", "add", "commit", "push"], "git write must follow the legacy contract's exact ordering: status-check -> checkout -B -> add -> commit -> push");
  assert.deepEqual(calls[1], ["checkout", "-B", "qa-bot/abc1234"], "checkout must target the SAME branch the PR will be opened against (ctx.branch, threaded through the vcsWrite.publish() call)");
  assert.deepEqual(calls[2], ["add", "--", "e2e"], "e2e target stages ONLY the e2e/ pathspec, never the whole repo");
  assert.ok(calls[4]?.includes("--force-with-lease"), "push must force-with-lease (safe concurrent-push guard)");
});

// ── Adversarial-review CRITICALs (auth-on-push + commit identity) — the reason these slipped is
// that the first round's fakes only recorded argv without pinning the auth/identity prefixes.
// realGit (src/integrations/repo-mirror.ts:203-208) is a BARE execFile wrapper: it applies
// hardenGitArgs (hooks/safe.directory) + GIT_TERMINAL_PROMPT=0 but NEVER prepends authHeaderArgs()
// — auth in this codebase is per CALL SITE (syncMirror :73/:78, resolveRef :221, legacy publish
// :124 `[...authHeaderArgs(), "push", ...]`). Likewise fresh mirrors have NO git identity (nothing
// in Dockerfile/compose/repo-mirror configures one), which is why legacy committed with
// `-c user.name=<GIT_AUTHOR_NAME ?? "panchito"> -c user.email=<GIT_AUTHOR_EMAIL ?? "panchito@users.
// noreply.github.com">` (publish.ts:107-108,120-123). buildVcsPublish now decorates the injected
// git fn (factory-side — the qa-engine adapter stays token-agnostic per its own header contract)
// so push carries auth and commit carries identity, byte-parity with legacy. These tests pin the
// EXACT argv the fake receives.

test("CRITICAL auth-on-push: buildVcsPublish's push carries authHeaderArgs() (-c url.insteadOf token rewrite) when GITHUB_TOKEN is set — legacy parity with publish.ts:124", async () => {
  await withEnv({ GITHUB_TOKEN: "testtoken123" }, async () => {
    const { git, calls } = fakeGit(" M e2e/login.spec.ts");
    const vcsWrite = buildVcsPublish(false, git, () => {});

    await vcsWrite.publish({ mirrorDir: "/mirrors/org/app", branch: "qa-bot/abc1234", sha: "abc1234" });

    const push = calls.find((c) => subcommandOf(c) === "push");
    assert.deepEqual(
      push,
      [
        "-c",
        "url.https://x-access-token:testtoken123@github.com/.insteadOf=https://github.com/",
        "push",
        "--force-with-lease",
        "-u",
        "origin",
        "qa-bot/abc1234",
      ],
      "the push must carry the SAME transient -c url.insteadOf auth args legacy prepended (publish.ts:124) — realGit itself never adds auth, so an unprefixed push fails non-interactively (GIT_TERMINAL_PROMPT=0)",
    );
  });
});

test("CRITICAL auth-on-push: without GITHUB_TOKEN the push argv has NO auth prefix (authHeaderArgs() returns [] — tokenless environments, legacy parity)", async () => {
  await withEnv({ GITHUB_TOKEN: undefined }, async () => {
    const { git, calls } = fakeGit(" M e2e/login.spec.ts");
    const vcsWrite = buildVcsPublish(false, git, () => {});

    await vcsWrite.publish({ mirrorDir: "/mirrors/org/app", branch: "qa-bot/abc1234", sha: "abc1234" });

    const push = calls.find((c) => subcommandOf(c) === "push");
    assert.deepEqual(push, ["push", "--force-with-lease", "-u", "origin", "qa-bot/abc1234"], "no token -> bare push, exactly what authHeaderArgs()'s own empty-array branch produces for legacy");
  });
});

test("CRITICAL commit-identity: buildVcsPublish's commit carries -c user.name/-c user.email with legacy's exact env fallbacks (fresh mirrors have NO git identity — a bare commit hard-fails 'Author identity unknown')", async () => {
  await withEnv({ GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined }, async () => {
    const { git, calls } = fakeGit(" M e2e/login.spec.ts");
    const vcsWrite = buildVcsPublish(false, git, () => {});

    await vcsWrite.publish({ mirrorDir: "/mirrors/org/app", branch: "qa-bot/abc1234", sha: "abc1234" });

    const commit = calls.find((c) => subcommandOf(c) === "commit");
    assert.deepEqual(
      commit,
      ["-c", "user.name=panchito", "-c", "user.email=panchito@users.noreply.github.com", "commit", "-m", "test(e2e): automated QA"],
      "byte-parity with legacy publishChanges (publish.ts:107-108,120-123): identity flags precede the commit subcommand, with the SAME fallback values",
    );
  });
});

test("CRITICAL commit-identity: GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL override the fallbacks (same env vars legacy read, resolved at CALL time)", async () => {
  await withEnv({ GIT_AUTHOR_NAME: "qa-ops", GIT_AUTHOR_EMAIL: "qa-ops@example.com" }, async () => {
    const { git, calls } = fakeGit(" M src/orders.ts");
    const vcsWrite = buildVcsPublish(true, git, () => {});

    await vcsWrite.publish({ mirrorDir: "/mirrors/org/panchito", branch: "qa-bot/def5678", sha: "def5678" });

    const commit = calls.find((c) => subcommandOf(c) === "commit");
    assert.deepEqual(
      commit,
      ["-c", "user.name=qa-ops", "-c", "user.email=qa-ops@example.com", "commit", "-m", "test(code): automated QA"],
      "explicit GIT_AUTHOR_* env values must win over the panchito fallbacks, matching legacy's `process.env.GIT_AUTHOR_NAME ?? \"panchito\"`",
    );
  });
});

test("CRITICAL decorations are scoped: status/checkout/add stay UNDECORATED (no auth, no identity — only push needs auth, only commit needs identity, matching legacy's per-call-site discipline)", async () => {
  await withEnv({ GITHUB_TOKEN: "testtoken123", GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined }, async () => {
    const { git, calls } = fakeGit(" M e2e/login.spec.ts");
    const vcsWrite = buildVcsPublish(false, git, () => {});

    await vcsWrite.publish({ mirrorDir: "/mirrors/org/app", branch: "qa-bot/abc1234", sha: "abc1234" });

    assert.deepEqual(calls[0], ["status", "--porcelain", "--", "e2e"], "status must stay bare — legacy never decorated the change check");
    assert.deepEqual(calls[1], ["checkout", "-B", "qa-bot/abc1234"], "checkout must stay bare — a local branch op needs neither auth nor identity");
    assert.deepEqual(calls[2], ["add", "--", "e2e"], "add must stay bare — legacy's add carried no -c flags (publish.ts:119)");
  });
});

test("buildVcsPublish (code target): changes anywhere -> stages the whole tree pathspec '.', not 'e2e'", async () => {
  const { git, calls } = fakeGit(" M src/orders.ts");
  const vcsWrite = buildVcsPublish(true, git, () => {});

  const result = await vcsWrite.publish({ mirrorDir: "/mirrors/org/panchito", branch: "qa-bot/def5678", sha: "def5678" });

  assert.deepEqual(result, { changed: true });
  assert.deepEqual(calls[0], ["status", "--porcelain", "--", "."], "code target's status check scopes to '.', not 'e2e' (the whole tree, per publishCode's own CODE_ADD)");
  assert.deepEqual(calls[2], ["add", "--", "."], "code target stages the whole tree, matching legacy's publishCode(mirrorDir, ...) — never just e2e/");
});

test("buildVcsPublish writes gitignore-style excludes BEFORE checking for changes (so an ignored path like node_modules/ never fails `git add`)", async () => {
  const { git, calls } = fakeGit(" M e2e/login.spec.ts");
  const excludesWritten: { dir: string; patterns: readonly string[] }[] = [];
  const vcsWrite = buildVcsPublish(false, git, (dir, patterns) => { excludesWritten.push({ dir, patterns }); });

  await vcsWrite.publish({ mirrorDir: "/mirrors/org/app", branch: "qa-bot/abc1234", sha: "abc1234" });

  assert.equal(excludesWritten.length, 1);
  assert.equal(excludesWritten[0]?.dir, "/mirrors/org/app");
  assert.ok(excludesWritten[0]?.patterns.includes("node_modules/"), "e2e excludes must include node_modules/ (the documented `git add` failure this ordering fixes)");
  assert.deepEqual(calls[0], ["status", "--porcelain", "--", "e2e"], "writeExcludes must run BEFORE the status check (same ordering as publish.ts's publishChanges)");
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

// ── WS6.2 (full-flow remediation, timeouts & operational observability) ──────────────────────────
// withUsageSink/withStallWatchdog/withSessionRegistration existed and were fully unit-tested, but
// nothing on the production path ever composed them onto the AgentDeps this factory hands to
// wireBridges() — a session opened through the rewritten engine never registered for SSE, never
// tripped the stall watchdog, and never fed a usage sink. These tests prove the composition itself
// (the wrapper unit tests already pin each wrapper's own behavior in isolation).

test("createRewrittenEngineFactory wraps deps.getAgentDeps() so a session opened with descriptor.runId registers for SSE (activityRouter.sessionMap())", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    let openedSessionId: string | undefined;
    const rawGetAgentDeps = (): AgentDeps => ({
      open: async (_agent, _cwd, _opts) => {
        openedSessionId = "factory-sse-session-1";
        return { id: openedSessionId, prompt: async () => "output", dispose: async () => {} };
      },
    });
    const app = cfg("factory-sse-registration");
    const config = buildRewrittenCompositionConfig(
      app,
      { getAgentDeps: () => withUsageSink(withStallWatchdog(withSessionRegistration(rawGetAgentDeps()))) },
      "qa-bot-abc1234-runSSE",
      { mode: "diff" },
    );

    // Exercise the SAME seam a real review call uses: runtimeAdapter.openSession -> deps.open with a
    // descriptor carrying runId (mirrors ReviewPortAdapter's own openSession call shape).
    const session = await config.reviewRuntime.runtime.openSession("reviewer", "/mirrors/org/app", {
      descriptor: { runId: "run-sse-1", role: "qa-reviewer" },
    });

    assert.ok(openedSessionId, "the raw AgentDeps.open must have been reached through the wrap chain");
    assert.equal(activityRouter.sessionMap().get(openedSessionId!), "run-sse-1", "the session must be registered in the SAME activityRouter the SSE stream reads from");

    await session.dispose();
    assert.equal(activityRouter.sessionMap().has(openedSessionId!), false, "dispose must unregister the session (no leaked SSE mapping)");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

test("createRewrittenEngineFactory's engineFactory (not just buildRewrittenCompositionConfig directly) composes the SAME wrap chain end-to-end", () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    let getAgentDepsCalls = 0;
    const factory = createRewrittenEngineFactory({
      getAgentDeps: () => {
        getAgentDepsCalls++;
        return stubAgentDeps();
      },
    });
    const port = factory(cfg("factory-wrap-chain"), "qa-bot-abc1234-runWrap", { mode: "diff" });
    assert.equal(typeof port.run, "function");
    // Construction must stay lazy (mirrors the pre-existing "never calls getAgentDeps during
    // construction" test above) — the wrap itself must not defeat that laziness.
    assert.equal(getAgentDepsCalls, 0, "wrapping getAgentDeps must not eagerly invoke the underlying factory");
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
    oracleOutcomeCount: 0,
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
    oracleOutcomeCount: 0, successRate: null, lastVerified: null, source: "test", at: new Date().toISOString(),
  });

  store.incrementUsage?.([ruleId]);

  const rows = listLearningRules(app, 10);
  assert.equal(rows[0]?.usageCount, 1, "usageCount must advance from 0 to 1 after incrementUsage");
});

// P4a (post-cutover-remediation, unit 6): historyLearningStore(appName).recordOutcome() was a
// `void outcome;` no-op — folding a RunOutcome into individual rules' running statistics via the
// SAME learning_rules SQLite table upsert()/incrementUsage() already bridge onto. Real-DB
// integration tests, same convention as the upsert()/incrementUsage() tests above: a unique app
// name per run avoids collisions with other tests' rows.
test("historyLearningStore(appName).recordOutcome() — oracle path folds valueScore into every retrieved rule", async () => {
  const { historyLearningStore } = await import("./rewritten-engine-factory");
  const { listLearningRules } = await import("./history");
  const app = `factory-learning-oracle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ruleId1 = `rule-oracle-1-${app}`;
  const ruleId2 = `rule-oracle-2-${app}`;

  const store = historyLearningStore(app);
  for (const id of [ruleId1, ruleId2]) {
    store.upsert({
      id, trigger: "t", action: "a", errorClass: "E-EXEC-FAIL", archetype: null,
      status: "candidate", confidence: "low", usageCount: 0, outcomeCount: 0,
      oracleOutcomeCount: 0, successRate: null, lastVerified: null, source: "test", at: new Date().toISOString(),
    });
  }

  store.recordOutcome({
    runId: "run-1", app, sha: "abc1234567", mode: "diff", target: "e2e", verdict: "pass",
    errorClass: null,
    gateSignals: { static: true, coverageRatio: 0.9, valueScore: 0.8, reviewerCorrections: [], flaky: false, retries: 0 },
    rulesRetrieved: [ruleId1, ruleId2],
    at: new Date().toISOString(),
  } as never);

  const rows = listLearningRules(app, 10);
  const r1 = rows.find((r) => r.id === ruleId1);
  const r2 = rows.find((r) => r.id === ruleId2);
  assert.equal(r1?.outcomeCount, 1, "rule 1 must fold exactly once");
  assert.equal(r1?.successRate, 0.8, "rule 1's successRate must equal the folded valueScore (first outcome)");
  assert.equal(r1?.oracleOutcomeCount, 1, "WS1.4(b): the oracle path (valueScore !== null) must advance oracleOutcomeCount");
  assert.equal(r2?.outcomeCount, 1, "rule 2 must fold independently of rule 1");
  assert.equal(r2?.successRate, 0.8);
  assert.equal(r2?.oracleOutcomeCount, 1);
});

// WS1.1 (full-flow remediation, most critical finding): THE INTEGRATION-HONEST TEST. Every test
// above this one hand-builds `rulesRetrieved: [ruleId1, ruleId2]` directly with the real ids already
// known — none of them walk the REAL production seam that broke: LearningPortAdapter.retrieve()
// (qa-engine's port bridge) projecting RetrievedRule[] from the SAME SqliteLearningRepository /
// historyLearningStore this file already wires, then the caller deriving the persisted
// rulesRetrieved from THAT result exactly the way run-qa.use-case.ts does (`r.id`, post-fix — was
// `r.trigger`, the bug). Before the WS1.1 fix, this exact chain (upsert -> retrieve -> derive
// rulesRetrieved -> fold) silently produced trigger TEXT instead of ids, so recordOutcome's by-id
// lookup (`byId.get(id)` / recordRuleOutcome(id, ...)) missed every row and outcome_count stayed
// frozen at 0 forever — no promotion/demotion ever engaged, with zero errors anywhere. This test
// pins the full chain green.
test("WS1.1 integration: upsert -> retrieve (real LearningPortAdapter) -> derive rulesRetrieved by id -> fold (real recordOutcome) advances outcome_count (was frozen at 0 pre-fix)", async () => {
  const { historyLearningStore } = await import("./rewritten-engine-factory");
  const { listLearningRules } = await import("./history");
  const { SqliteLearningRepository } = await import(
    "@contexts/cross-run-learning/infrastructure/sqlite-learning-repository.adapter"
  );
  const { LearningPortAdapter } = await import(
    "@contexts/qa-run-orchestration/infrastructure/bridges/learning-port.adapter"
  );
  const app = `factory-learning-ws1-1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Deliberately DIFFERENT from the rule's trigger text — if the chain regresses to persisting
  // trigger text instead of ids, the fold's byId lookup would miss this row exactly as it did
  // before the fix, and outcome_count would stay 0 (the assertion below would fail loudly).
  const ruleId = `rule-ws1-1-${app}`;
  const ruleTrigger = "selector absent — WS1.1 trigger text, NEVER the fold key";

  const store = historyLearningStore(app);
  store.upsert({
    id: ruleId, trigger: ruleTrigger, action: "use role+name", errorClass: "E-EXEC-FAIL",
    archetype: null, status: "active", confidence: "high", usageCount: 0, outcomeCount: 0,
    oracleOutcomeCount: 0, successRate: null, lastVerified: null, source: "test", at: new Date().toISOString(),
  });

  // Real retrieval path: the SAME SqliteLearningRepository + LearningPortAdapter production wires
  // (buildRewrittenCompositionConfig composes `new SqliteLearningRepository(historyLearningStore(app.name))`
  // at line ~524 of this module, and composition-root.ts wraps it in LearningPortAdapter).
  const repo = new SqliteLearningRepository(store);
  const adapter = new LearningPortAdapter(repo, app);
  const retrievedRules = await adapter.retrieve(Sha.of("abc1234567"));

  assert.equal(retrievedRules.length, 1, "the upserted rule must be retrievable");
  assert.equal(retrievedRules[0]?.id, ruleId, "retrieve() must surface the real row id (the WS1.1 fix)");
  assert.equal(retrievedRules[0]?.trigger, ruleTrigger, "retrieve() must ALSO still surface the prompt-facing trigger text (untouched by this fix)");

  // Derive rulesRetrieved the SAME way run-qa.use-case.ts does post-fix: `retrievedRules.map(r => r.id)`
  // — NOT `r.trigger` (that mapping was the bug this work-unit fixes).
  const rulesRetrieved = retrievedRules.map((r) => r.id);
  assert.deepEqual(rulesRetrieved, [ruleId], "the derived rulesRetrieved must carry ids, not trigger text");

  const outcome = {
    runId: "run-ws1-1", app, sha: "abc1234567", mode: "diff", target: "e2e", verdict: "pass",
    errorClass: null,
    gateSignals: { static: true, coverageRatio: 0.9, valueScore: 0.75, reviewerCorrections: [], flaky: false, retries: 0 },
    rulesRetrieved,
    at: new Date().toISOString(),
  } as never;

  // Fold via the REAL LearningPort.fold() -> LearningRepositoryPort.applyOutcome() ->
  // historyLearningStore(app).recordOutcome() -> history.ts's recordRuleOutcome(id, ...) chain —
  // the exact production path, not a hand-rolled call to recordOutcome/recordRuleOutcome directly.
  await adapter.fold(outcome);

  const rows = listLearningRules(app, 10);
  const folded = rows.find((r) => r.id === ruleId);
  assert.equal(folded?.outcomeCount, 1, "outcome_count must ADVANCE from 0 to 1 — this is the exact governance-fold edge WS1.1 fixes; before the fix this stayed frozen at 0 with no error");
  assert.equal(folded?.successRate, 0.75, "successRate must equal the folded valueScore (first outcome)");
  assert.equal(folded?.oracleOutcomeCount, 1, "WS1.4(b): the oracle path (gateSignals.valueScore !== null) must advance oracle_outcome_count");
});

test("historyLearningStore(appName).recordOutcome() — empty rulesRetrieved is a safe no-op", async () => {
  const { historyLearningStore } = await import("./rewritten-engine-factory");
  const { listLearningRules } = await import("./history");
  const app = `factory-learning-empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ruleId = `rule-empty-${app}`;

  const store = historyLearningStore(app);
  store.upsert({
    id: ruleId, trigger: "t", action: "a", errorClass: "E-EXEC-FAIL", archetype: null,
    status: "candidate", confidence: "low", usageCount: 0, outcomeCount: 0,
    oracleOutcomeCount: 0, successRate: null, lastVerified: null, source: "test", at: new Date().toISOString(),
  });

  store.recordOutcome({
    runId: "run-2", app, sha: "abc1234567", mode: "diff", target: "e2e", verdict: "pass",
    errorClass: null,
    gateSignals: { static: true, coverageRatio: null, valueScore: 0.5, reviewerCorrections: [], flaky: false, retries: 0 },
    rulesRetrieved: [],
    at: new Date().toISOString(),
  } as never);

  const rows = listLearningRules(app, 10);
  const r = rows.find((row) => row.id === ruleId);
  assert.equal(r?.outcomeCount, 0, "no rulesRetrieved means no recordRuleOutcome call at all — ledger untouched");
});

test("historyLearningStore(appName).recordOutcome() — prevention path scores via preventionOutcome(rule.errorClass, outcome.errorClass) when valueScore is null", async () => {
  const { historyLearningStore } = await import("./rewritten-engine-factory");
  const { listLearningRules } = await import("./history");
  const app = `factory-learning-prevention-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const heldRuleId = `rule-prevention-held-${app}`;
  const failedRuleId = `rule-prevention-failed-${app}`;
  const noisyRuleId = `rule-prevention-noisy-${app}`;

  const store = historyLearningStore(app);
  store.upsert({
    id: heldRuleId, trigger: "t", action: "a", errorClass: "E-FRAGILE-SELECTOR", archetype: null,
    status: "candidate", confidence: "low", usageCount: 0, outcomeCount: 0,
    oracleOutcomeCount: 0, successRate: null, lastVerified: null, source: "test", at: new Date().toISOString(),
  });
  store.upsert({
    id: failedRuleId, trigger: "t2", action: "a2", errorClass: "E-EXEC-FAIL", archetype: null,
    status: "candidate", confidence: "low", usageCount: 0, outcomeCount: 0,
    oracleOutcomeCount: 0, successRate: null, lastVerified: null, source: "test", at: new Date().toISOString(),
  });
  store.upsert({
    id: noisyRuleId, trigger: "t3", action: "a3", errorClass: "E-FRAGILE-SELECTOR", archetype: null,
    status: "candidate", confidence: "low", usageCount: 0, outcomeCount: 0,
    oracleOutcomeCount: 0, successRate: null, lastVerified: null, source: "test", at: new Date().toISOString(),
  });

  // A clean run (errorClass: null): heldRuleId's own class ("E-FRAGILE-SELECTOR") did NOT recur ->
  // preventionOutcome(rule.errorClass, null) = PREVENTION_HELD_SCORE (weak positive, held).
  // failedRuleId's own class ("E-EXEC-FAIL") also did not recur on this clean run -> also held.
  store.recordOutcome({
    runId: "run-3", app, sha: "abc1234567", mode: "diff", target: "e2e", verdict: "pass",
    errorClass: null,
    gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
    rulesRetrieved: [heldRuleId, failedRuleId],
    at: new Date().toISOString(),
  } as never);

  const rows = listLearningRules(app, 10);
  const held = rows.find((r) => r.id === heldRuleId);
  const failed = rows.find((r) => r.id === failedRuleId);
  const noisy = rows.find((r) => r.id === noisyRuleId);
  assert.equal(held?.outcomeCount, 1, "held rule must fold via the prevention path (weak positive)");
  assert.equal(held?.successRate, 0.6, "PREVENTION_HELD_SCORE for a clean run");
  assert.equal(held?.oracleOutcomeCount, 0, "WS1.4(b): the prevention path must NEVER advance oracle_outcome_count");
  assert.equal(failed?.outcomeCount, 1, "unrelated rule on a clean run also holds (weak positive)");
  assert.equal(failed?.oracleOutcomeCount, 0, "WS1.4(b): prevention path — no oracle evidence");
  assert.equal(noisy?.outcomeCount, 0, "a rule NOT in rulesRetrieved must never fold");
});

// Task 2 (full-flow remediation, WS1.3 closure): THE INTEGRATION-HONEST TEST for selectAllRules.
// Before this fix, historyLearningStore(appName) never implemented LearningStore.selectAllRules,
// so SqliteLearningRepository.listAll() always fell back to its own documented fail-open empty
// set — ReflectorPortAdapter's anti-respawn dedup (decideDistill against the FULL existing-rule
// set, incl. deprecated/superseded) was fully implemented but structurally inert in production: it
// could never actually see a prior rule to dedup against. This test walks the REAL production
// wiring end to end: upsert a DEPRECATED rule directly into the SAME learning_rules table
// historyLearningStore(app) reads/writes, then run the distill DECISION the reflector's save path
// uses (decideDistill against SqliteLearningRepository.listAll(app, ...)'s real output) and assert
// the duplicate is skipped — proving listAll surfaces real rows, not [].
test("Task 2: historyLearningStore(appName).selectAllRules wiring — SqliteLearningRepository.listAll surfaces a DEPRECATED rule so decideDistill skips a normalized duplicate (WS1.3 dedup goes live)", async () => {
  const { historyLearningStore } = await import("./rewritten-engine-factory");
  const { SqliteLearningRepository } = await import(
    "@contexts/cross-run-learning/infrastructure/sqlite-learning-repository.adapter"
  );
  const { decideDistill, capRuleFields } = await import("@contexts/cross-run-learning/domain/distill-rule");
  const app = `factory-learning-selectall-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const deprecatedRuleId = `rule-deprecated-${app}`;

  const store = historyLearningStore(app);
  // A rule that was tried and demoted — the anti-respawn guard's whole reason to exist: a
  // recurring failure pattern must not spawn a FRESH candidate for a pattern already tried and
  // found wanting.
  store.upsert({
    id: deprecatedRuleId,
    trigger: "Applies when a form submit button lacks a stable selector",
    action: "use getbyrole('button', { name: ... })",
    errorClass: "E-FRAGILE-SELECTOR",
    archetype: null,
    status: "candidate", // upsertLearningRule always inserts as candidate (see history.ts's own doc)
    confidence: "low",
    usageCount: 0,
    outcomeCount: 0,
    oracleOutcomeCount: 0,
    successRate: null,
    lastVerified: null,
    source: "test",
    at: new Date().toISOString(),
  });
  // Force it to deprecated the SAME way a real demotion would (via the human-override path in
  // history.ts) — proving the dedup guard sees it EVEN THOUGH it is excluded from normal retrieval.
  const { setRuleStatusByHuman } = await import("./history");
  setRuleStatusByHuman(deprecatedRuleId, "deprecated");

  // Real production wiring: the SAME SqliteLearningRepository this factory composes
  // (`new SqliteLearningRepository(historyLearningStore(app.name))`, ~line 524).
  const repo = new SqliteLearningRepository(store);

  // Before Task 2's fix, this always returned [] regardless of what upsert() had just written.
  const existing = await repo.listAll(app, 200);
  assert.ok(existing.some((r) => r.id === deprecatedRuleId), "listAll() must surface the deprecated row — this is the exact seam Task 2 wires live");
  assert.equal(existing.find((r) => r.id === deprecatedRuleId)?.status, "deprecated", "the row's real status must survive the round-trip");

  // Run the SAME distill decision the reflector's save path runs (reflector-port.adapter.ts's
  // `decideDistill(capped, existing)`), with a candidate whose trigger/action normalize onto the
  // SAME ruleKey as the deprecated row above (differs only in casing/whitespace/punctuation).
  const capped = capRuleFields({
    trigger: "applies when a Form Submit button lacks a stable selector",
    action: "Use getByRole('button', { name: ... }).",
  });
  const decision = decideDistill(capped, existing);

  assert.equal(decision.decision, "skip-duplicate", "WS1.3 anti-respawn dedup: a normalized duplicate of a DEPRECATED rule must be skipped, not saved as a fresh candidate");
  assert.equal((decision as { match: { id: string } }).match.id, deprecatedRuleId, "the match must be the SAME deprecated row, proving listAll (not an empty fallback) drove the decision");
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

// ── Cross-repo composition threading (bug fix) ────────────────────────────────────────────────────
// CLAUDE.md: "diff/classify/gate come from the service mirror at the event SHA; the suite runs from
// the primary mirror at baseBranch HEAD." Prior to this fix, run.triggerRepo never reached the
// factory at all — vcs/checkout/gate were hardwired to the PRIMARY repo unconditionally, so a real
// cross-repo run tried `git checkout -f <serviceSha>` inside the PRIMARY mirror and crashed.
//
// Testability seam: RewrittenEngineFactoryDeps.mirror lets tests inject spies for
// ensureMirror/ensureMirrorAtBranch instead of touching real git/disk — mirrors the existing
// deps.mirrorRoot precedent (an explicit test/override seam, defaulting to the real functions).
function spyMirrorDeps() {
  // WARNING fix (judgment-day): capture the 3rd `deps: MirrorDeps` argument too — previously
  // discarded, so no test here could catch production dropping/corrupting `defaultMirrorDeps` on
  // either call. Callers assert `deps` is the module's own `defaultMirrorDeps` export (identity).
  const ensureMirrorCalls: Array<{ repo: string; sha: string; deps: MirrorDeps }> = [];
  const ensureMirrorAtBranchCalls: Array<{ repo: string; branch: string; deps: MirrorDeps }> = [];
  const mirror = {
    ensureMirror: async (repo: string, sha: string, deps: MirrorDeps) => {
      ensureMirrorCalls.push({ repo, sha, deps });
      return `/mirrors/${repo.replaceAll("/", "__")}`;
    },
    ensureMirrorAtBranch: async (repo: string, branch: string, deps: MirrorDeps) => {
      ensureMirrorAtBranchCalls.push({ repo, branch, deps });
      return `/mirrors/${repo.replaceAll("/", "__")}`;
    },
  };
  return { mirror, ensureMirrorCalls, ensureMirrorAtBranchCalls };
}

// 1. GUARD — pin same-repo behavior BEFORE touching anything: no triggerRepo must never take the
// cross-repo branch, checkout(sha) must ensure only the PRIMARY repo at the event sha (never call
// ensureMirrorAtBranch), and the deploy gate must read app.dev?.versionUrl exactly as before.

test("GUARD: no triggerRepo — checkout(sha) ensures the PRIMARY repo at sha only, never ensureMirrorAtBranch", async () => {
  const app = cfg("factory-guard-same-repo");
  const { mirror, ensureMirrorCalls, ensureMirrorAtBranchCalls } = spyMirrorDeps();
  const config = buildRewrittenCompositionConfig(
    app,
    { getAgentDeps: stubAgentDeps, mirror },
    "qa-bot-abc1234-run1",
    { mode: "diff" },
  );
  await config.checkout(Sha.of("abc1234567"));
  assert.deepEqual(ensureMirrorCalls, [{ repo: "org/demo", sha: "abc1234567", deps: defaultMirrorDeps }], "same-repo checkout must ensure the PRIMARY repo at the event sha");
  assert.deepEqual(ensureMirrorAtBranchCalls, [], "same-repo checkout must NEVER call ensureMirrorAtBranch");
  assert.strictEqual(ensureMirrorCalls[0]?.deps, defaultMirrorDeps, "checkout must pass the module's own defaultMirrorDeps, not a substitute or corrupted copy");
});

test("GUARD: triggerRepo: '' (empty string) behaves identically to absent — same-repo path, no ensureMirrorAtBranch", async () => {
  const app: AppConfig = { ...cfg("factory-guard-empty-triggerrepo"), dev: { baseUrl: "https://dev", versionUrl: "https://dev/version" } };
  const { mirror, ensureMirrorCalls, ensureMirrorAtBranchCalls } = spyMirrorDeps();
  const config = buildRewrittenCompositionConfig(
    app,
    { getAgentDeps: stubAgentDeps, mirror },
    "qa-bot-abc1234-run1",
    { mode: "diff", triggerRepo: "" },
  );
  await config.checkout(Sha.of("abc1234567"));
  assert.deepEqual(ensureMirrorCalls, [{ repo: "org/demo", sha: "abc1234567", deps: defaultMirrorDeps }], "empty-string triggerRepo must ensure the PRIMARY repo at the event sha, same as no triggerRepo at all");
  assert.deepEqual(ensureMirrorAtBranchCalls, [], "empty-string triggerRepo must NEVER call ensureMirrorAtBranch");
  assert.equal(config.versionUrl, "https://dev/version", "gate must read app.dev.versionUrl, not a service's");
  assert.equal(config.deployGateIntervalMs, 2000, "empty-string triggerRepo must keep the primary gate defaults (2000/60000), never the service-level 10_000/600_000");
  assert.equal(config.deployGateTimeoutMs, 60000);
});

test("GUARD: no triggerRepo — versionUrl is app.dev?.versionUrl exactly as before", () => {
  const app: AppConfig = { ...cfg("factory-guard-versionurl"), dev: { baseUrl: "https://dev", versionUrl: "https://dev/version" } };
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  assert.equal(config.versionUrl, "https://dev/version");
  assert.equal(config.deployGateIntervalMs, 2000, "primary defaults are unchanged (2000/60000)");
  assert.equal(config.deployGateTimeoutMs, 60000);
});

test("GUARD: no triggerRepo — vcs reads the PRIMARY mirror dir", () => {
  const app = cfg("factory-guard-vcs");
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps, mirrorRoot: "/tmp/mirrors" }, "qa-bot-abc1234-run1", { mode: "diff" });
  assert.equal((config.vcs as unknown as { repoDir: string }).repoDir, "/tmp/mirrors/org__demo");
});

// 2. RED — triggerRepo = declared service: checkout(sha) must ensure the SERVICE repo at the event
// sha FIRST (diff/classify source), then return the PRIMARY repo's dir at baseBranch HEAD (suite
// workspace) — order matters because classify() runs after workspace.prepare() in RunQaUseCase.

test("cross-repo: checkout(sha) ensures the SERVICE repo at the event sha, then returns the PRIMARY dir at baseBranch HEAD", async () => {
  const app: AppConfig = { ...cfg("factory-crossrepo-checkout"), services: [{ repo: "org/orders-svc" }] };
  const { mirror, ensureMirrorCalls, ensureMirrorAtBranchCalls } = spyMirrorDeps();
  const config = buildRewrittenCompositionConfig(
    app,
    { getAgentDeps: stubAgentDeps, mirror },
    "qa-bot-abc1234-run1",
    { mode: "diff", triggerRepo: "org/orders-svc" },
  );
  const dir = await config.checkout(Sha.of("def5678901"));
  assert.deepEqual(ensureMirrorCalls, [{ repo: "org/orders-svc", sha: "def5678901", deps: defaultMirrorDeps }], "the SERVICE repo must be ensured at the event sha — the diff/classify source");
  assert.deepEqual(ensureMirrorAtBranchCalls, [{ repo: "org/demo", branch: "main", deps: defaultMirrorDeps }], "the PRIMARY repo must be ensured at baseBranch HEAD (default 'main') — the suite workspace");
  assert.equal(dir, "/mirrors/org__demo", "checkout must return the PRIMARY dir, not the service dir");
  assert.strictEqual(ensureMirrorCalls[0]?.deps, defaultMirrorDeps, "the SERVICE ensureMirror call must pass the module's own defaultMirrorDeps");
  assert.strictEqual(ensureMirrorAtBranchCalls[0]?.deps, defaultMirrorDeps, "the PRIMARY ensureMirrorAtBranch call must pass the module's own defaultMirrorDeps");
});

test("cross-repo: checkout(sha) honors the app's configured baseBranch (not always 'main')", async () => {
  const app: AppConfig = { ...cfg("factory-crossrepo-basebranch"), baseBranch: "develop", services: [{ repo: "org/orders-svc" }] };
  const { mirror, ensureMirrorAtBranchCalls } = spyMirrorDeps();
  const config = buildRewrittenCompositionConfig(
    app,
    { getAgentDeps: stubAgentDeps, mirror },
    "qa-bot-abc1234-run1",
    { mode: "diff", triggerRepo: "org/orders-svc" },
  );
  await config.checkout(Sha.of("def5678901"));
  assert.deepEqual(ensureMirrorAtBranchCalls, [{ repo: "org/demo", branch: "develop", deps: defaultMirrorDeps }]);
  assert.strictEqual(ensureMirrorAtBranchCalls[0]?.deps, defaultMirrorDeps);
});

// 3. RED — cfg.vcs must be bound to the SERVICE mirror dir (the classify/diff source), not the
// primary. Asserted via GitMirrorReadAdapter's public repoDir (rename-safe, honest read-back).

test("cross-repo: cfg.vcs is bound to the SERVICE mirror dir (classify source), not the primary", () => {
  const app: AppConfig = { ...cfg("factory-crossrepo-vcs"), services: [{ repo: "org/orders-svc" }] };
  const config = buildRewrittenCompositionConfig(
    app,
    { getAgentDeps: stubAgentDeps, mirrorRoot: "/tmp/mirrors" },
    "qa-bot-abc1234-run1",
    { mode: "diff", triggerRepo: "org/orders-svc" },
  );
  assert.equal((config.vcs as unknown as { repoDir: string }).repoDir, "/tmp/mirrors/org__orders-svc", "vcs must read the SERVICE mirror dir, not the primary's");
});

// 3b. RED — generation-prompt parity (legacy pipeline.ts:1909): triggerService must reach
// CompositionConfig.triggerService as {repo, mirrorDir, openapi?} — the SERVICE's own mirror dir
// (the SAME vcsDir formula the vcs test above already pins), never the primary's mirrorDir. This is
// the ONE new field this gap closes: composition-root.ts's wireBridges() threads it into
// GenerationPortAdapter's ctx.service -> OpencodeRunInput.service, advisory prompt-context ONLY.

test("cross-repo: composes CompositionConfig.triggerService = {repo, mirrorDir} for the SERVICE mirror (not the primary), when the service declares no openapi hint", () => {
  const app: AppConfig = { ...cfg("factory-crossrepo-triggerservice"), services: [{ repo: "org/orders-svc" }] };
  const config = buildRewrittenCompositionConfig(
    app,
    { getAgentDeps: stubAgentDeps, mirrorRoot: "/tmp/mirrors" },
    "qa-bot-abc1234-run1",
    { mode: "diff", triggerRepo: "org/orders-svc" },
  );
  assert.deepEqual(config.triggerService, { repo: "org/orders-svc", mirrorDir: "/tmp/mirrors/org__orders-svc" }, "triggerService must carry the SERVICE's own repo + mirror dir, matching vcsDir's own formula — no openapi key when the service declares none");
});

test("cross-repo: composes CompositionConfig.triggerService with openapi when the declared service carries an openapi hint", () => {
  const app: AppConfig = {
    ...cfg("factory-crossrepo-triggerservice-openapi"),
    services: [{ repo: "org/orders-svc", openapi: "openapi/orders.yaml" }],
  };
  const config = buildRewrittenCompositionConfig(
    app,
    { getAgentDeps: stubAgentDeps, mirrorRoot: "/tmp/mirrors" },
    "qa-bot-abc1234-run1",
    { mode: "diff", triggerRepo: "org/orders-svc" },
  );
  assert.deepEqual(config.triggerService, { repo: "org/orders-svc", mirrorDir: "/tmp/mirrors/org__orders-svc", openapi: "openapi/orders.yaml" });
});

test("cross-repo: composes CompositionConfig.triggerService with an array openapi hint, preserved as-is (openapi is string | string[])", () => {
  const app: AppConfig = {
    ...cfg("factory-crossrepo-triggerservice-openapi-array"),
    services: [{ repo: "org/orders-svc", openapi: ["openapi/orders.yaml", "openapi/payments.yaml"] }],
  };
  const config = buildRewrittenCompositionConfig(
    app,
    { getAgentDeps: stubAgentDeps, mirrorRoot: "/tmp/mirrors" },
    "qa-bot-abc1234-run1",
    { mode: "diff", triggerRepo: "org/orders-svc" },
  );
  assert.deepEqual(config.triggerService, {
    repo: "org/orders-svc",
    mirrorDir: "/tmp/mirrors/org__orders-svc",
    openapi: ["openapi/orders.yaml", "openapi/payments.yaml"],
  });
});

test("GUARD: no triggerRepo (same-repo run) leaves CompositionConfig.triggerService entirely absent — no key, not undefined-valued", () => {
  const app = cfg("factory-guard-triggerservice-absent");
  const config = buildRewrittenCompositionConfig(app, { getAgentDeps: stubAgentDeps }, "qa-bot-abc1234-run1", { mode: "diff" });
  assert.equal("triggerService" in config, false, "same-repo runs (the common case) must OMIT triggerService entirely, matching versionUrl's own absent-by-default precedent for this class of field");
});

// 4. RED — gate: a service WITH versionUrl gates on the SERVICE's own versionUrl/intervals (service
// defaults 10_000/600_000, distinct from the primary's 2000/60000); a service WITHOUT versionUrl
// must leave cfg.versionUrl undefined even when app.dev.versionUrl IS set (never gate the primary's
// /version endpoint for a service sha that never appears there).

test("cross-repo: gate uses the SERVICE's own versionUrl + service-level interval/timeout defaults (10_000/600_000)", () => {
  const app: AppConfig = {
    ...cfg("factory-crossrepo-gate"),
    services: [{ repo: "org/orders-svc", versionUrl: "https://orders-svc/version" }],
  };
  const config = buildRewrittenCompositionConfig(
    app,
    { getAgentDeps: stubAgentDeps },
    "qa-bot-abc1234-run1",
    { mode: "diff", triggerRepo: "org/orders-svc" },
  );
  assert.equal(config.versionUrl, "https://orders-svc/version", "must gate on the SERVICE's own versionUrl, never the primary's");
  assert.equal(config.deployGateIntervalMs, 10_000, "service-level default interval (distinct from the primary's 2000)");
  assert.equal(config.deployGateTimeoutMs, 600_000, "service-level default timeout (distinct from the primary's 60000)");
  assert.equal(typeof config.versionPoll, "function");
});

test("cross-repo: gate honors explicit service pollIntervalMs/deployTimeoutMs overrides", () => {
  const app: AppConfig = {
    ...cfg("factory-crossrepo-gate-overrides"),
    services: [{ repo: "org/orders-svc", versionUrl: "https://orders-svc/version", pollIntervalMs: 3000, deployTimeoutMs: 90_000 }],
  };
  const config = buildRewrittenCompositionConfig(
    app,
    { getAgentDeps: stubAgentDeps },
    "qa-bot-abc1234-run1",
    { mode: "diff", triggerRepo: "org/orders-svc" },
  );
  assert.equal(config.deployGateIntervalMs, 3000);
  assert.equal(config.deployGateTimeoutMs, 90_000);
});

test("cross-repo: a service WITHOUT versionUrl leaves cfg.versionUrl undefined even when app.dev.versionUrl IS set", () => {
  const app: AppConfig = {
    ...cfg("factory-crossrepo-gate-skip"),
    dev: { baseUrl: "https://dev", versionUrl: "https://dev/version" },
    services: [{ repo: "org/orders-svc" }], // no versionUrl declared
  };
  const config = buildRewrittenCompositionConfig(
    app,
    { getAgentDeps: stubAgentDeps },
    "qa-bot-abc1234-run1",
    { mode: "diff", triggerRepo: "org/orders-svc" },
  );
  assert.equal(config.versionUrl, undefined, "must NEVER fall back to the primary's dev.versionUrl for a cross-repo run — trust the deploy event and skip the gate");
  assert.equal(config.versionPoll, undefined);
});

// 5. RED — declared-service defense in depth + triggerRepo === app.repo takes the same-repo path.

test("cross-repo: an UNDECLARED triggerRepo throws (defense in depth, matches runner.ts's own assertTriggerRepoDeclared)", () => {
  const app = cfg("factory-crossrepo-undeclared"); // no services[] declared at all
  assert.throws(
    () =>
      buildRewrittenCompositionConfig(
        app,
        { getAgentDeps: stubAgentDeps },
        "qa-bot-abc1234-run1",
        { mode: "diff", triggerRepo: "org/evil-repo" },
      ),
    /trigger repo org\/evil-repo is not a declared service of app factory-crossrepo-undeclared/,
  );
});

test("cross-repo: mode 'context' triggered by a declared service throws (legacy pipeline.ts:1017-1020 sibling guard)", () => {
  const app: AppConfig = { ...cfg("factory-crossrepo-context-service"), services: [{ repo: "org/orders-svc" }] };
  assert.throws(
    () =>
      buildRewrittenCompositionConfig(
        app,
        { getAgentDeps: stubAgentDeps },
        "qa-bot-abc1234-run1",
        { mode: "context", triggerRepo: "org/orders-svc" },
      ),
    /context mode cannot be triggered by a service repo \(org\/orders-svc\); run it from the primary repo org\/demo/,
  );
});

test("cross-repo: mode 'context' WITHOUT a triggerRepo does not throw (same-repo context runs stay legal)", () => {
  const app: AppConfig = { ...cfg("factory-crossrepo-context-same-repo"), services: [{ repo: "org/orders-svc" }] };
  assert.doesNotThrow(() =>
    buildRewrittenCompositionConfig(
      app,
      { getAgentDeps: stubAgentDeps },
      "qa-bot-abc1234-run1",
      { mode: "context" },
    ),
  );
});

test("cross-repo: triggerRepo === app.repo takes the same-repo path (no service branch, no throw)", async () => {
  const app: AppConfig = { ...cfg("factory-crossrepo-selfrepo"), services: [{ repo: "org/orders-svc" }] };
  const { mirror, ensureMirrorCalls, ensureMirrorAtBranchCalls } = spyMirrorDeps();
  const config = buildRewrittenCompositionConfig(
    app,
    { getAgentDeps: stubAgentDeps, mirror },
    "qa-bot-abc1234-run1",
    { mode: "diff", triggerRepo: "org/demo" },
  );
  await config.checkout(Sha.of("abc1234567"));
  assert.deepEqual(ensureMirrorCalls, [{ repo: "org/demo", sha: "abc1234567", deps: defaultMirrorDeps }]);
  assert.deepEqual(ensureMirrorAtBranchCalls, [], "triggerRepo === app.repo must behave exactly like the same-repo (no triggerRepo) path");
  assert.strictEqual(ensureMirrorCalls[0]?.deps, defaultMirrorDeps);
});

// 6. createRewrittenEngineFactory forwards triggerRepo through to buildRewrittenCompositionConfig.

test("createRewrittenEngineFactory's returned closure accepts and threads a run.triggerRepo argument without throwing", () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const factory = createRewrittenEngineFactory({ getAgentDeps: stubAgentDeps });
    const app: AppConfig = { ...cfg("factory-crossrepo-closure"), services: [{ repo: "org/orders-svc" }] };
    assert.doesNotThrow(() => factory(app, "qa-bot-abc1234-run1", { mode: "diff", triggerRepo: "org/orders-svc" }));
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

test("createRewrittenEngineFactory's returned closure propagates the undeclared-triggerRepo throw (guard reachable at the closure seam, not just via buildRewrittenCompositionConfig directly)", () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const factory = createRewrittenEngineFactory({ getAgentDeps: stubAgentDeps });
    const app: AppConfig = { ...cfg("factory-crossrepo-closure-throw"), services: [{ repo: "org/orders-svc" }] };
    assert.throws(
      () => factory(app, "qa-bot-abc1234-run1", { mode: "diff", triggerRepo: "org/evil-repo" }),
      /trigger repo org\/evil-repo is not a declared service of app factory-crossrepo-closure-throw/,
    );
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

// ── Context-mode multi-service parity (legacy pipeline.ts:1330-1355 buildContextMap, restored by
// this fix): a context-mode run mirrors EVERY declared app.services[] entry (read-only, each at its
// OWN svc.baseBranch ?? "main") and threads them onto CompositionConfig.services so
// GenerationPortAdapter's ctx.services -> OpencodeRunInput.services carries the full set for the FE<->BE
// architecture-map builder (buildContextTask's "## Microservice repos" section, prompts.ts:1181).
// Mirrors triggerService's OWN conditional-spread precedent above hop-for-hop — the ONE difference is
// cardinality (every declared service, not just the triggering one) and applicability (context mode
// ONLY; triggerService and services are mutually exclusive by the sibling guard at line 342/954).

test("context mode: composes CompositionConfig.services = every declared service at its OWN join-formula mirrorDir, string openapi preserved", () => {
  const app: AppConfig = {
    ...cfg("factory-context-services"),
    services: [
      { repo: "org/orders-svc", openapi: "openapi/orders.yaml" },
      { repo: "org/payments-svc", baseBranch: "develop" },
    ],
  };
  const config = buildRewrittenCompositionConfig(
    app,
    { getAgentDeps: stubAgentDeps, mirrorRoot: "/tmp/mirrors" },
    "qa-bot-abc1234-run1",
    { mode: "context" },
  );
  assert.deepEqual(config.services, [
    { repo: "org/orders-svc", mirrorDir: "/tmp/mirrors/org__orders-svc", openapi: "openapi/orders.yaml" },
    { repo: "org/payments-svc", mirrorDir: "/tmp/mirrors/org__payments-svc" },
  ], "each service ref must carry the SAME join(mirrorRoot, repo.replaceAll('/','__')) formula vcsDir/triggerService already use — no openapi key when a service declares none");
});

test("context mode: composes CompositionConfig.services with an array openapi hint, preserved as-is (openapi is string | string[])", () => {
  const app: AppConfig = {
    ...cfg("factory-context-services-array-openapi"),
    services: [{ repo: "org/orders-svc", openapi: ["openapi/orders.yaml", "openapi/payments.yaml"] }],
  };
  const config = buildRewrittenCompositionConfig(
    app,
    { getAgentDeps: stubAgentDeps, mirrorRoot: "/tmp/mirrors" },
    "qa-bot-abc1234-run1",
    { mode: "context" },
  );
  assert.deepEqual(config.services, [
    { repo: "org/orders-svc", mirrorDir: "/tmp/mirrors/org__orders-svc", openapi: ["openapi/orders.yaml", "openapi/payments.yaml"] },
  ]);
});

test("diff mode with declared services: CompositionConfig.services key is entirely absent (only context mode populates it)", () => {
  const app: AppConfig = { ...cfg("factory-diff-mode-services-absent"), services: [{ repo: "org/orders-svc" }] };
  const config = buildRewrittenCompositionConfig(
    app,
    { getAgentDeps: stubAgentDeps, mirrorRoot: "/tmp/mirrors" },
    "qa-bot-abc1234-run1",
    { mode: "diff" },
  );
  assert.equal("services" in config, false, "non-context modes must OMIT services entirely, matching triggerService's own absence-vs-present discipline");
});

test("context mode with NO declared services: CompositionConfig.services key is entirely absent", () => {
  const app = cfg("factory-context-no-services");
  const config = buildRewrittenCompositionConfig(
    app,
    { getAgentDeps: stubAgentDeps, mirrorRoot: "/tmp/mirrors" },
    "qa-bot-abc1234-run1",
    { mode: "context" },
  );
  assert.equal("services" in config, false, "no app.services[] declared must OMIT the key, not an empty array");
});

test("context mode: checkout(sha) materializes every declared service via ensureMirrorAtBranch at svc.baseBranch ?? 'main', alongside the primary checkout", async () => {
  const app: AppConfig = {
    ...cfg("factory-context-checkout-materialize"),
    services: [
      { repo: "org/orders-svc" },
      { repo: "org/payments-svc", baseBranch: "develop" },
    ],
  };
  const { mirror, ensureMirrorCalls, ensureMirrorAtBranchCalls } = spyMirrorDeps();
  const config = buildRewrittenCompositionConfig(
    app,
    { getAgentDeps: stubAgentDeps, mirror },
    "qa-bot-abc1234-run1",
    { mode: "context" },
  );
  await config.checkout(Sha.of("abc1234567"));
  assert.deepEqual(ensureMirrorCalls, [{ repo: "org/demo", sha: "abc1234567", deps: defaultMirrorDeps }], "the primary repo must still be ensured at the event sha, exactly as the same-repo path already does");
  assert.deepEqual(ensureMirrorAtBranchCalls, [
    { repo: "org/orders-svc", branch: "main", deps: defaultMirrorDeps },
    { repo: "org/payments-svc", branch: "develop", deps: defaultMirrorDeps },
  ], "every declared service must be mirrored read-only at its OWN svc.baseBranch ?? 'main', sequentially like legacy's buildContextMap loop");
});

test("non-context mode: checkout(sha) never materializes declared services, even when app.services[] is set", async () => {
  const app: AppConfig = { ...cfg("factory-diff-mode-no-service-checkout"), services: [{ repo: "org/orders-svc" }] };
  const { mirror, ensureMirrorAtBranchCalls } = spyMirrorDeps();
  const config = buildRewrittenCompositionConfig(
    app,
    { getAgentDeps: stubAgentDeps, mirror },
    "qa-bot-abc1234-run1",
    { mode: "diff" },
  );
  await config.checkout(Sha.of("abc1234567"));
  assert.deepEqual(ensureMirrorAtBranchCalls, [], "a diff-mode run must never mirror declared services — that materialization is context-mode only");
});
