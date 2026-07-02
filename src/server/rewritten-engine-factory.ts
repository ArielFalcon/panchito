// src/server/rewritten-engine-factory.ts
//
// Plan 7.6 (Part 2) — "arm the cutover": the REAL production engineFactory. Maps an AppConfig to a
// qa-engine CompositionConfig and returns `buildProduction(process.env, cfg)`, wiring the SAME
// production collaborators the host process already builds (the real agent runtime at :4097, the
// real GitHub PR/Issue client, the real deploy gate, the real Playwright/code runners) — not a
// second, parallel set of integrations.
//
// This is ADDITIVE + OPT-IN. RunnerDeps.engineFactory (src/server/runner.ts) is only ever consulted
// when selectEngine(process.env) resolves to "rewritten" — which requires PIPELINE_ENGINE=rewritten
// to be set explicitly (src/contexts/qa-run-orchestration/composition/pipeline-engine-flag.ts's
// fail-safe default is "legacy"). With PIPELINE_ENGINE absent, this module is loaded and its
// factory function is constructed, but `createRewrittenEngineFactory(...)` is NEVER INVOKED — the
// runner's dispatch takes the legacy `runPipeline` branch exactly as before this file existed.
//
// This is the REAL production path (buildProduction → real GitHub publish, real durable run
// history), NOT buildShadow (test/characterization/shadow-run.operator.ts's Task F.2 harness,
// which always forces the shadow-log route + in-memory history for its own operator-invoked
// comparison runs). An app's own `qa.shadow: true` config still routes PublishDecisionService to
// the ShadowLogAdapter here too — see composition-root.ts's wireBridges() "Production publication"
// comment — so onboarding a new app in shadow mode behaves identically whichever engine ran it.
//
// Faithful port of qa-engine/test/characterization/shadow-run.operator.ts's buildCompositionConfig
// (the FIRST and, until this file, ONLY place the AppConfig→CompositionConfig mapping was written —
// confirmed by searching the qa-engine tree before writing this module). The only structural
// differences from that operator template:
//   1. The agent runtime is INJECTED (getAgentDeps: () => AgentDeps), not rebuilt — this factory
//      reuses the host's existing AgentRuntimeManager (src/index.ts's `agentRuntime`, resolved via
//      currentAgentDeps()) instead of constructing a second one. Two independent AgentRuntimeManager
//      instances would each try to own the same :4097 supervisor's session bookkeeping.
//   2. The diff is sourced DYNAMICALLY per run (engram #939's dynamic-diff fix): this factory's
//      CompositionConfig always sets `diff: ""` at composition-build time (the mirrorDir/checkout
//      SHA are not known yet either — see the checkout note below) — GenerationPortAdapter and
//      ReviewPortAdapter both resolve the REAL per-run diff from ChangeAnalysisPort.classify()'s
//      widened return value instead. No static pre-compute is needed or possible here (unlike the
//      operator script, which already has legacyMirror + legacyDiff in hand before composing).
//   3. checkout resolves mirrorDir per-run via WorkspacePort.prepare(sha) → ensureMirror(...) — this
//      factory's own `mirrorDir` field is a PLACEHOLDER (the app's own working directory under
//      MIRROR_DIR) satisfying CompositionConfig's static shape; the REAL per-run mirrorDir the
//      adapters actually operate on comes back from the `checkout` fn's return value, exactly as
//      composition-root.ts's WorkspacePortAdapter contract requires.
//   4. branch/namespace is caller-supplied PER RUN: buildRewrittenCompositionConfig(app, deps,
//      namespace) sets `branch: namespace` from an explicit argument, unlike the operator template
//      (which builds one CompositionConfig for a single one-shot comparison run and can afford a
//      constant). The runner (src/server/runner.ts) computes this namespace once per run via
//      testDataNamespace(app.qa.testDataPrefix, sha, runId) — the SAME formula legacy runPipeline
//      uses at src/pipeline.ts:1222 — and passes it through RunnerDeps.engineFactory. A static
//      branch here would collide every run of every app on the same live-DEV test-data namespace
//      the moment PIPELINE_ENGINE=rewritten is set (fixed after judgment-day caught it).
import { join } from "node:path";
import type { AppConfig } from "../orchestrator/config-loader";
import type { AgentDeps } from "../integrations/opencode-client";
import type { RunPipelinePort } from "@contexts/qa-run-orchestration/application/ports/index.ts";
import { buildProduction, type CompositionConfig } from "@contexts/qa-run-orchestration/composition/composition-root";
import { Sha } from "@kernel/sha";
import type { AgentRole } from "@kernel/agent-role";

import { GitMirrorReadAdapter } from "@contexts/change-analysis/infrastructure/git-mirror-read.adapter";
import { GenerateTestsUseCase } from "@contexts/generation/application/generate-tests.use-case";
import { AgentRuntimeAdapter } from "@contexts/generation/infrastructure/agent-runtime.adapter";
import { PromptRenderingAdapter } from "@contexts/generation/infrastructure/prompt-rendering.adapter";
import { VerdictParserAdapter } from "@contexts/generation/infrastructure/verdict-parser.adapter";
import { ManifestRepositoryAdapter } from "@contexts/generation/infrastructure/manifest-repository.adapter";
import { readManifest, reconcileManifest } from "@contexts/generation/infrastructure/manifest-fs";
import { PromptBudgetAdapter } from "@contexts/generation/infrastructure/prompt-budget.adapter";
import { capDiff, capText } from "@contexts/generation/infrastructure/prompt-cap";
import { StaticGateAdapter } from "@contexts/test-execution/infrastructure/static-gate.adapter";
import { E2eExecutionStrategy } from "@contexts/test-execution/infrastructure/e2e-execution.strategy";
import { CodeExecutionStrategy } from "@contexts/test-execution/infrastructure/code-execution.strategy";
import { StrykerMutationOracleAdapter } from "@contexts/objective-signal/infrastructure/stryker-mutation-oracle.adapter";
import { FaultInjectionOracleAdapter } from "@contexts/objective-signal/infrastructure/fault-injection-oracle.adapter";
import { GitHubPrAdapter } from "@contexts/workspace-and-publication/infrastructure/github-pr.adapter";
import { GitHubIssueAdapter } from "@contexts/workspace-and-publication/infrastructure/github-issue.adapter";
import { makeTargetCoverageCollector } from "@contexts/objective-signal/infrastructure/target-coverage-collector";

// SandboxedBinaryRunner + ProcessKillAdapter: real, src/-free process-sandbox primitives
// (Sub-Plan 7.2 item 1) — no root src/ import needed for these, unlike the collaborators below.
import { SandboxedBinaryRunnerAdapter } from "../../qa-engine/src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.adapter";
import { ProcessKillAdapter } from "../../qa-engine/src/shared-infrastructure/process-sandbox/process-kill.adapter";

// ── Root src/ collaborators (the REAL production pieces) ─────────────────────────────────────────
// This module intentionally imports both qa-engine's @contexts/@kernel aliases AND root src/
// integrations — it is the E.3 seam whose entire job is bridging the two, exactly like the F.2
// operator template it ports (see that file's own TS6307 note on why a composition-mapping module
// unavoidably imports both sides). Unlike shadow-run.operator.ts, this file lives in src/ itself
// (not qa-engine/test/), so it is NOT subject to qa-engine/tsconfig.json's exclude list or the
// tsconfig.parity.json split — it is covered by the root tsconfig.json project (which already
// references qa-engine via TS project references) like any other src/ module.
import {
  buildPromptAssembled,
  buildWorkerPromptAssembled,
  buildReviewerPromptAssembled,
  buildExplorerPrompt,
  specFileForFlow,
} from "../integrations/prompts";
import { parseVerdict } from "../integrations/verdict-parse";
import { parseReviewerVerdict } from "../integrations/verdict-validate";
import { roleWindowBytes } from "../integrations/model-window-catalog";
import { validateSpecs, defaultValidateDeps } from "../qa/validate";
import { runE2E, defaultExecuteDeps } from "../qa/execute";
import { runCodeTests, defaultCodeExecuteDeps } from "../qa/code-runner";
import { github } from "../integrations/github";
import { runMutationOracle, realMutationDeps } from "../qa/learning/mutation-code";
import { runFaultInjectionOracle, defaultFaultInjectionDeps } from "../qa/learning/fault-injection-e2e";
import { shaMatches } from "../env/deploy-gate";
import { ensureMirror, defaultMirrorDeps, workdirRoot } from "../integrations/repo-mirror";

// Same role→agent-name mapping the F.2 operator template uses (roleToAgentName) — the
// AgentRuntimeAdapter needs it to resolve which of the agents container's role configs
// (qa-generator/qa-reviewer/qa-worker/…) an AgentRole maps to.
function roleToAgentName(role: AgentRole): string {
  const map: Record<AgentRole, string> = {
    primary: "qa-generator",
    reviewer: "qa-reviewer",
    chat: "qa-assistant",
    worker: "qa-worker",
    workerCode: "qa-worker-code",
    maintainer: "qa-maintainer",
    reflector: "qa-generator",
    explorer: "qa-generator",
  };
  return map[role];
}

// One-shot /version fetch + sha/health match — VersionPollFn's contract is a SINGLE probe per
// call (DeployGatePortAdapter.waitUntilServing owns the outer poll-until-deadline loop itself,
// calling this repeatedly at cfg.intervalMs). This intentionally does NOT delegate to
// src/env/deploy-gate.ts's waitForDeploy, which runs its OWN internal poll-until-deadline loop —
// composing two nested poll loops would multiply the effective timeout instead of bounding it once
// at the adapter's own cfg.timeoutMs. shaMatches is reused verbatim from that same module (the
// short-sha / full-sha / 7-char-prefix equivalence legacy already relies on).
async function fetchVersion(url: string): Promise<{ sha?: string; healthy?: boolean } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return (await res.json()) as { sha?: string; healthy?: boolean };
  } catch {
    return null;
  }
}

// The host's already-built real collaborators this factory reuses instead of re-assembling.
export interface RewrittenEngineFactoryDeps {
  // Reads the SAME AgentDeps facade the host's currentAgentDeps() resolves (src/index.ts) — the
  // real :4097 supervisor, not a second AgentRuntimeManager instance.
  getAgentDeps: () => AgentDeps;
  // Optional durable RunHistoryPort path — when absent, buildProduction's wireBridges() falls back
  // to an in-memory history for the rewritten engine's own record (composition-root.ts's own
  // documented default). The host's real durable history lives in src/server/history.ts's SQLite
  // store, reached through the SAME RunnerDeps.runEvents/updateRecord plumbing every engine's
  // outcome flows through in src/server/runner.ts — this field is for the REWRITTEN adapter's own
  // internal RunHistoryPort.save() bookkeeping, not a replacement for that plumbing.
  historyFilePath?: string;
  env?: Record<string, string | undefined>;
  mirrorRoot?: string;
}

// Assembles a REAL CompositionConfig for the given AppConfig, mirroring
// shadow-run.operator.ts's buildCompositionConfig (see this module's header for the 3 documented
// differences). Exported for direct unit testing of the mapping without going through the factory
// closure.
//
// `namespace` is the caller's (the runner's) PER-RUN test-data namespace — the exact same value
// legacy computes via testDataNamespace(app.qa.testDataPrefix, sha, runId) at src/pipeline.ts:1222.
// It becomes `branch` below, which composition-root.ts's wireBridges() threads into BOTH
// GenerationPortAdapter's and ExecutionPortAdapter's `namespace` field — i.e. it is the live-DEV
// test-data scoping AND the publish branch. A caller MUST pass a fresh namespace per run; passing
// the same value twice reproduces the exact DEV-data collision this fix closes.
export function buildRewrittenCompositionConfig(app: AppConfig, deps: RewrittenEngineFactoryDeps, namespace: string): CompositionConfig {
  const isCode = app.code === true;
  const target: "e2e" | "code" = isCode ? "code" : "e2e";
  const e2eRelDir = "e2e";
  // Single shared source for the mirror root (Warning fix, judgment-day): reuse repo-mirror.ts's own
  // workdirRoot() instead of re-deriving the formula here, so this factory's `vcs`/mirrorDir can
  // never silently diverge from where ensureMirror/checkout actually write. deps.mirrorRoot remains
  // an explicit test/override seam (unit tests construct configs without touching process.env).
  const mirrorRoot = deps.mirrorRoot ?? workdirRoot();
  // Placeholder static mirrorDir — the REAL per-run mirrorDir is whatever `checkout(sha)` returns
  // (WorkspacePortAdapter's own contract in composition-root.ts). This field only needs to exist to
  // satisfy CompositionConfig's static shape and to seed the coverage collector's repoDir/e2eDir
  // (which — like the diff — is a known limitation shared with the ObjectiveSignalPort's own
  // documented "assembleChangeCoverage optional" degrade path: an unmeasured/mismatched repoDir
  // reads as "unknown", which NEVER blocks publish, exactly the safe default the port already
  // guarantees for exactly this class of gap).
  const mirrorDir = join(mirrorRoot, app.repo.replaceAll("/", "__"));
  const e2eDir = join(mirrorDir, e2eRelDir);
  // CRITICAL fix (judgment-day): branch/namespace must be PER-RUN, not a static literal. A static
  // "qa-bot/rewritten" collided every run of every app on the same live-DEV test-data namespace the
  // moment PIPELINE_ENGINE=rewritten is flipped (shadow:true only suppresses PR/Issue — it still
  // runs real Playwright + writes real DEV test data). `namespace` is byte-comparable to legacy's
  // testDataNamespace(...) output — see this function's header.
  const branch = namespace;

  const runner = new SandboxedBinaryRunnerAdapter({ processKill: new ProcessKillAdapter() });
  const vcs = new GitMirrorReadAdapter(mirrorDir, runner);

  // Reuses the host's already-built AgentDeps (see this module's header, difference #1) — never a
  // second AgentRuntimeManager. onUsage/onTurn are deliberately not forwarded, matching the operator
  // template exactly (AgentRuntimeAdapter's LegacyAgentDeps types them against the kernel
  // UsageSnapshot/AgentTurnEvent shapes, a genuinely different shape from src/qa/usage.ts's).
  const runtimeAdapter = new AgentRuntimeAdapter(
    {
      open: async (agent, cwd, opts) => {
        const real = deps.getAgentDeps();
        return real.open(agent, cwd, {
          ...(opts?.signal ? { signal: opts.signal } : {}),
          ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          ...(opts?.model ? { model: opts.model } : {}),
        });
      },
    },
    roleToAgentName,
  );
  const rendering = new PromptRenderingAdapter({ buildPromptAssembled, buildWorkerPromptAssembled, buildReviewerPromptAssembled, buildExplorerPrompt, specFileForFlow });
  const verdicts = new VerdictParserAdapter({ parseVerdict, parseReviewerVerdict });

  const generationUseCase = new GenerateTestsUseCase({
    runtime: runtimeAdapter,
    rendering,
    verdicts,
    manifest: new ManifestRepositoryAdapter({ readManifest, reconcileManifest }),
    budget: new PromptBudgetAdapter(roleWindowBytes, capDiff, capText),
  });

  const staticGate = new StaticGateAdapter({
    typecheck: defaultValidateDeps.typecheck,
    lint: defaultValidateDeps.lint,
    listTests: defaultValidateDeps.listTests,
    checkManifest: defaultValidateDeps.checkManifest,
    validateAll: (specDir) => validateSpecs(specDir, defaultValidateDeps),
  });

  const e2e = new E2eExecutionStrategy((specDir, opts) => runE2E(specDir, opts, defaultExecuteDeps));
  const code = new CodeExecutionStrategy((repoDir, opts) => runCodeTests(repoDir, opts, defaultCodeExecuteDeps));

  const collector = makeTargetCoverageCollector({ target, repoDir: mirrorDir, e2eDir, changedFiles: [] });
  const oracle = isCode
    ? new StrykerMutationOracleAdapter((input) => runMutationOracle(input, realMutationDeps))
    : new FaultInjectionOracleAdapter(
        (input) => runFaultInjectionOracle({ ...input, repoDir: input.e2eDir }, defaultFaultInjectionDeps),
        app.dev?.baseUrl ?? "",
      );

  // WorkspacePort's checkout(sha) resolves the REAL per-run mirrorDir — the same ensureMirror the
  // legacy runPipeline's `prepare` step calls, so both engines checkout identically.
  const checkout = async (checkoutSha: Sha): Promise<string> => ensureMirror(app.repo, checkoutSha.value, defaultMirrorDeps);

  return {
    repo: app.repo,
    appName: app.name,
    mirrorDir,
    e2eRelDir,
    branch,
    target,
    mode: "diff",
    needsReview: app.qa.needsReview,
    shadow: app.qa.shadow ?? false,
    onFailure: app.report.onFailure,
    maxRetries: app.qa.fixLoop?.maxRetries ?? 2,
    isCode,
    coveragePolicyMode: app.qa.changeCoverage?.mode ?? "signal",
    // The dynamic-diff fix (engram #939): GenerationPortAdapter/ReviewPortAdapter both prefer the
    // REAL per-run diff sourced from ChangeAnalysisPort.classify() over this static field, which is
    // deliberately left empty here — there is no per-run commit diff known at composition-build
    // time (unlike the F.2 operator script, which already ran classify()/getCommitDiff() before
    // calling buildCompositionConfig). Only callers that omit the dynamic diff argument fall back
    // to this static "" (documented backward-compatible default in the port's own header).
    diff: "",

    vcs,
    generationUseCase,
    reviewRuntime: {
      runtime: runtimeAdapter,
      rendering,
      verdicts,
    },
    staticGate,
    executionStrategies: { e2e, code },
    objectiveSignal: { collector, oracle },
    coveragePolicy: { mode: app.qa.changeCoverage?.mode ?? "signal", minRatio: app.qa.changeCoverage?.minRatio ?? 0.7 },
    baselineCases: [],

    // Real GitHub PR/Issue collaborators — the actual production publish path (buildProduction, not
    // buildShadow). PublishDecisionService's own decide() still routes to the ShadowLogAdapter when
    // cfg.shadow is true (composition-root.ts wireBridges() wires that unconditionally), so a
    // shadow-mode app never fires these even on this REAL path.
    githubPr: new GitHubPrAdapter({
      createPullRequest: (repo, args) => github.createPullRequest(repo, args),
      enableAutoMerge: (nodeId) => github.enableAutoMerge(nodeId),
      mergePullRequest: (repo, number) => github.mergePullRequest(repo, number),
    }),
    githubIssue: new GitHubIssueAdapter((repo, title, body) => github.openIssue(repo, title, body)),
    reviewerApprovedForPublish: true,
    coverageBlocksForPublish: false,
    e2eChangedForPublish: true,

    checkout,
    versionUrl: app.dev?.versionUrl,
    // Single-shot probe (see fetchVersion's own header) — DeployGatePortAdapter.waitUntilServing
    // is the ONLY poll loop; this fn is called once per its interval, never loops itself.
    versionPoll: app.dev?.versionUrl
      ? async (versionUrl: string, sha) => {
          const v = await fetchVersion(versionUrl);
          return { serving: shaMatches(v?.sha, sha.value) && v?.healthy === true };
        }
      : undefined,
    deployGateIntervalMs: app.dev?.pollIntervalMs ?? 2000,
    deployGateTimeoutMs: app.dev?.deployTimeoutMs ?? 60000,

    ...(deps.historyFilePath ? { historyFilePath: deps.historyFilePath } : {}),
  };
}

// The RunnerDeps.engineFactory seam (src/server/runner.ts) — returns a factory mapping
// (AppConfig, namespace) → RunPipelinePort. Only ever invoked by the runner when
// selectEngine(process.env) already resolved to "rewritten"; buildProduction internally reads the
// SAME flag and returns the RewrittenOrchestratorAdapter on that branch (never
// LegacyPipelineAdapter — that branch requires options.legacyRunner, which this factory never
// supplies, matching this seam's own contract: the runner's `engine === "rewritten" &&
// deps.engineFactory` guard already ensures this function is never reached on the legacy path).
//
// The `namespace` parameter (CRITICAL fix, judgment-day) is the caller's PER-RUN test-data
// namespace — the runner computes it once per run via testDataNamespace(...) (mirroring legacy's
// own src/pipeline.ts:1222 formula) and passes it here on every invocation. This closure itself
// stays stateless: no namespace is cached or defaulted internally, so two calls with two different
// namespaces always compose two independent CompositionConfigs with two different `branch` values.
export function createRewrittenEngineFactory(deps: RewrittenEngineFactoryDeps): (appConfig: AppConfig, namespace: string) => RunPipelinePort {
  const env = deps.env ?? process.env;
  return (appConfig: AppConfig, namespace: string): RunPipelinePort => {
    const cfg = buildRewrittenCompositionConfig(appConfig, deps, namespace);
    return buildProduction(env, cfg);
  };
}
