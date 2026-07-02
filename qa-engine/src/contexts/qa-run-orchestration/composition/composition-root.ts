// src/contexts/qa-run-orchestration/composition/composition-root.ts
// The composition root (Task E.2). The ONLY module in qa-engine allowed to import concrete
// adapters from sibling contexts — it sits outside generation/* and agent-runtime/*, so the
// arch-lint VCS-write gate (no-vcs-write-in-agent-contexts) stays green. Wires ALL 11
// qa-run-orchestration ports to the REAL bridge adapters built in Task E.0 so the rewritten engine
// is COMPLETE (not stubbed) and can drive a full QA run. Replaces defaultPipelineDeps().
//
// buildProduction(env, cfg): reads the PIPELINE_ENGINE flag via selectEngine (Task E.1) — "legacy"
// (the fail-safe default) wraps the given LegacyRunner in a LegacyPipelineAdapter; "rewritten"
// wires a COMPLETE RewrittenOrchestratorAdapter over all 11 real bridges. Plan 6 never ships
// rewritten as the default (that flip is Plan 7, justified by the Slice F shadow evidence) — this
// factory is the shadow SEAM, not the cutover.
//
// buildShadow(cfg): ALWAYS the rewritten engine (bypasses the flag entirely — shadow runs exist to
// observe the rewritten engine, never the legacy one), with the publication bridge's shadow-log
// collaborators (ShadowLogAdapter-shaped, no PR/Issue side effect ever fires) and an
// InMemoryRunHistoryAdapter (a read-only-in-spirit, process-lifetime snapshot — never a durable
// write to the real history store) so a shadow run has zero observable side effects on the
// watched repo or the production history.
//
// Scope note (mirrors the bridges' own documented boundary): this file wires PORTS to bridges and
// bridges to ALREADY-CONSTRUCTED sibling collaborators (a constructed GenerateTestsUseCase, a
// constructed StaticGateAdapter, etc.) — assembling each sibling context's OWN leaf IO primitives
// (the SandboxedBinaryRunner, the Stryker/c8/lcov file readers, the real HTTP GitHub client, …) is
// that sibling context's own concern, supplied here via CompositionConfig. This keeps the
// composition root's job exactly what the plan names it: "wires ALL 11 ports to the REAL bridge
// adapters" — not "constructs every leaf IO integration from scratch".
import type { Sha } from "@kernel/sha.ts";
import type { RunMode, TestTarget } from "@kernel/run-mode.ts";
import type { RunPipelinePort, ObserverPort } from "../application/ports/index.ts";
import { RewrittenOrchestratorAdapter, type RewrittenOrchestratorAdapterDeps } from "../infrastructure/rewritten-orchestrator.adapter.ts";
import { LegacyPipelineAdapter, type LegacyRunner } from "../infrastructure/legacy-pipeline.adapter.ts";
import { selectEngine } from "./pipeline-engine-flag.ts";

import { ChangeAnalysisPortAdapter } from "../infrastructure/bridges/change-analysis-port.adapter.ts";
import { GenerationPortAdapter, type GenerationPortCollaborators } from "../infrastructure/bridges/generation-port.adapter.ts";
import { ReviewPortAdapter, type ReviewPortRuntime } from "../infrastructure/bridges/review-port.adapter.ts";
import { ValidationPortAdapter } from "../infrastructure/bridges/validation-port.adapter.ts";
import { ExecutionPortAdapter } from "../infrastructure/bridges/execution-port.adapter.ts";
import { ObjectiveSignalPortAdapter } from "../infrastructure/bridges/objective-signal-port.adapter.ts";
import { PublicationPortAdapter, type GitHubPrCollaborator, type GitHubIssueCollaborator } from "../infrastructure/bridges/publication-port.adapter.ts";
import { LearningPortAdapter } from "../infrastructure/bridges/learning-port.adapter.ts";
import { WorkspacePortAdapter, type CheckoutFn } from "../infrastructure/bridges/workspace-port.adapter.ts";
import { DeployGatePortAdapter, NullDeployGateAdapter, type VersionPollFn } from "../infrastructure/bridges/deploy-gate-port.adapter.ts";
import { InMemoryRunHistoryAdapter, FileRunHistoryAdapter } from "../infrastructure/bridges/run-history-port.adapter.ts";
import { SetupPortAdapter, type SetupPortCollaborators } from "../infrastructure/bridges/setup-port.adapter.ts";

import { GenerateTestsUseCase, type GenerationResult, type GenerateOpts } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { OpencodeRunInput } from "@contexts/generation/application/ports/generation-ports.ts";
import type { AgentRuntimePort } from "@kernel/ports/agent-runtime.port.ts";
import type { PromptRenderingPort, VerdictParserPort } from "@contexts/generation/application/ports/index.ts";
import type { StaticGateAdapter } from "@contexts/test-execution/infrastructure/static-gate.adapter.ts";
import type { E2eExecutionStrategy } from "@contexts/test-execution/infrastructure/e2e-execution.strategy.ts";
import type { CodeExecutionStrategy } from "@contexts/test-execution/infrastructure/code-execution.strategy.ts";
import { DecideCoverageService, type CoveragePolicy, type ChangeCoverage } from "@contexts/objective-signal/domain/decide-coverage.service.ts";
import type { CoverageCollectorPort, ValueOraclePort } from "@contexts/objective-signal/application/ports/index.ts";
import { PublishDecisionService } from "@contexts/workspace-and-publication/domain/publish-decision.service.ts";
import { ShadowLogAdapter } from "@contexts/workspace-and-publication/infrastructure/shadow-log.adapter.ts";
import type { VcsReadPort } from "@contexts/change-analysis/application/ports/index.ts";
import type { LearningRepositoryPort } from "@contexts/cross-run-learning/application/ports/index.ts";
import { StubLearningRepository } from "@contexts/cross-run-learning/infrastructure/stub-learning-repository.adapter.ts";

// The static per-run + collaborator surface every bridge needs. Real construction of each
// IO-bound sibling collaborator (GenerateTestsUseCase, StaticGateAdapter, the execution
// strategies, the coverage collector/value oracle, VcsReadPort, LearningRepositoryPort) is the
// CALLER's concern (Task E.3's AppConfig-mapping layer, or a test's fakes) — this config only
// says WHICH already-constructed instances to wire into which port.
export interface CompositionConfig {
  // Static per-run context (shared across GenerationPort/ReviewPort/ExecutionPort/PublicationPort).
  repo: string;
  appName: string;
  mirrorDir: string;
  e2eRelDir: string;
  branch: string;
  target: TestTarget;
  mode: RunMode;
  needsReview: boolean;
  shadow: boolean;
  onFailure: string;
  maxRetries: number;
  isCode: boolean;
  coveragePolicyMode: "off" | "signal" | "enforce";
  guidance?: string;
  diff?: string;
  baseUrl?: string;
  // injected as PW_TEST_ID_ATTRIBUTE so playwright.config.ts resolves getByTestId against the app's
  // convention — NO defaulting logic here; undefined flows through and the seed playwright.config.ts
  // already defaults to data-testid (mirrors legacy resolveTestIdAttribute semantics at the config edge).
  testIdAttribute?: string;

  // ChangeAnalysisPort collaborator.
  vcs: VcsReadPort;

  // GenerationPort collaborator — an ALREADY-CONSTRUCTED use-case (its own leaf IO ports are the
  // generation context's own concern) plus the optional specSources file-read collaborator.
  generationUseCase: {
    generate(input: OpencodeRunInput, opts?: GenerateOpts): Promise<GenerationResult>;
  };
  readSpecSource?: GenerationPortCollaborators["readSpecSource"];

  // ReviewPort collaborator — the SAME 3 generation-owned primitives the bridge composes standalone.
  reviewRuntime: {
    runtime: Pick<AgentRuntimePort, "openSession">;
    rendering: Pick<PromptRenderingPort, "renderReviewer">;
    verdicts: Pick<VerdictParserPort, "parseReview">;
  };

  // ValidationPort collaborator.
  staticGate: Pick<StaticGateAdapter, "validateAll">;

  // ExecutionPort collaborator — target-selected strategy dispatch.
  executionStrategies: {
    e2e: Pick<E2eExecutionStrategy, "run">;
    code: Pick<CodeExecutionStrategy, "run">;
  };

  // SetupPort collaborator (CLAUDE.md run-flow step 3) — target-selected dispatch, mirroring
  // executionStrategies' own shape. OPTIONAL: absent -> the use-case's setup phase is a no-op
  // (RunQaUseCaseDeps.setup itself stays optional), matching every composition built before this
  // field existed.
  setupCollaborators?: SetupPortCollaborators;

  // ObjectiveSignalPort collaborators — the keystone. assembleChangeCoverage is OPTIONAL (absent, or
  // no per-run diff at measure() call time -> decide() receives null -> "unknown" -> NEVER blocks,
  // the keystone's own architecturally-safe default).
  objectiveSignal: {
    collector: Pick<CoverageCollectorPort, "collect">;
    oracle: Pick<ValueOraclePort, "measure">;
  };
  coveragePolicy: CoveragePolicy;
  // (diff, report) -> ChangeCoverage — matches assemble-change-coverage.ts's exported
  // `assembleChangeCoverage` shape (a pure port of legacy parseDiffHunks + computeChangeCoverage).
  // Widened from the earlier `(report, br)` shape: br carries no diff (BlastRadius.changedFiles is
  // frequently empty at the RunQaUseCase call site), while the run's REAL diff — sourced from
  // ChangeAnalysisPort.classify() in diff mode, the ONLY mode that measures change-coverage — is
  // exactly what parseDiffHunks needs.
  assembleChangeCoverage?: (diff: string, report: Awaited<ReturnType<CoverageCollectorPort["collect"]>>) => ChangeCoverage;
  baselineCases?: string[];

  // PublicationPort collaborators (production path only — buildShadow always overrides these with
  // the shadow-log path, per the security-boundary note in publication-port.adapter.ts).
  githubPr: GitHubPrCollaborator;
  githubIssue: GitHubIssueCollaborator;
  reviewerApprovedForPublish?: boolean;
  coverageBlocksForPublish?: boolean;
  e2eChangedForPublish?: boolean;

  // LearningPort collaborator. v1 default: StubLearningRepository (a provable no-op) when absent.
  learningRepo?: LearningRepositoryPort;

  // WorkspacePort collaborator — resolves a Sha to its working-copy mirrorDir. Cross-repo routing
  // stays OPAQUE inside this fn (the bridge's own documented scope for Plan 6).
  checkout: CheckoutFn;

  // DeployGatePort collaborators — versionUrl absent selects NullDeployGateAdapter (static sites /
  // code target); present selects the real poll-loop gate.
  versionUrl?: string;
  versionPoll?: VersionPollFn;
  deployGateIntervalMs?: number;
  deployGateTimeoutMs?: number;

  // RunHistoryPort collaborator — buildProduction prefers a durable FileRunHistoryAdapter when a
  // path is given (falls back to in-memory otherwise); buildShadow ALWAYS forces in-memory
  // regardless of this field (no side effect on the real history store during a shadow run).
  historyFilePath?: string;

  // ObserverPort collaborator (bug fix: rewritten-engine runs left their RunRecord/RunEvents
  // frozen — record.step never advanced and /api/runs/:id/events stayed empty, because nothing
  // ever wired RunQaUseCaseDeps.observer). OPTIONAL: absent -> RunQaUseCase's onStep() calls are
  // all no-ops (backward compatible with every composition built before this field existed,
  // including every existing test that constructs a CompositionConfig without an observer). The
  // PER-RUN observer (which needs the live RunRecord id + RunEventStore) is built by the caller
  // (src/server/runner.ts's runViaRewrittenEngine) and threaded in here — this composition root
  // has no RunRecord/RunEventStore concept of its own (that is root src/'s concern, per CLAUDE.md
  // "App-specificity lives only in config/; nothing app-specific in src/... [qa-engine]").
  observer?: ObserverPort;
}

const DEFAULT_DEPLOY_GATE_INTERVAL_MS = 2000;
const DEFAULT_DEPLOY_GATE_TIMEOUT_MS = 60000;

// Builds the 11 REAL bridge adapters from a CompositionConfig, shared by both buildProduction's
// "rewritten" branch and buildShadow (which only swaps the publication + runHistory ports below).
function wireBridges(cfg: CompositionConfig): Omit<RewrittenOrchestratorAdapterDeps, "publication" | "runHistory"> & {
  publication: RewrittenOrchestratorAdapterDeps["publication"];
  runHistory: RewrittenOrchestratorAdapterDeps["runHistory"];
} {
  const changeAnalysis = new ChangeAnalysisPortAdapter(cfg.vcs);

  const generation = new GenerationPortAdapter(
    cfg.generationUseCase as GenerateTestsUseCase,
    {
      repo: cfg.repo,
      appName: cfg.appName,
      mirrorDir: cfg.mirrorDir,
      e2eRelDir: cfg.e2eRelDir,
      namespace: cfg.branch,
      needsReview: cfg.needsReview,
      target: cfg.target,
      mode: cfg.mode,
      diff: cfg.diff ?? "",
      ...(cfg.guidance ? { guidance: cfg.guidance } : {}),
      // Live-run root cause fix: without this, GenerationPortAdapter never received the app's live
      // DEV URL, so the agent correctly refused to write selectors without DOM grounding (see
      // generation-port.adapter.ts's own header for the full incident trace) — zero specs, every
      // run. ExecutionPortAdapter/ReviewPortAdapter already consumed cfg.baseUrl below; generation
      // was the missing link.
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
    },
    { ...(cfg.readSpecSource ? { readSpecSource: cfg.readSpecSource } : {}) },
  );

  const review = new ReviewPortAdapter(cfg.reviewRuntime as ReviewPortRuntime, {
    diff: cfg.diff ?? "",
    mirrorDir: cfg.mirrorDir,
    e2eRelDir: cfg.e2eRelDir,
    appName: cfg.appName,
    mode: cfg.mode,
    ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
    ...(cfg.guidance ? { guidance: cfg.guidance } : {}),
  });

  const validation = new ValidationPortAdapter(cfg.staticGate as StaticGateAdapter);

  const execution = new ExecutionPortAdapter(
    { e2e: cfg.executionStrategies.e2e as E2eExecutionStrategy, code: cfg.executionStrategies.code as CodeExecutionStrategy },
    {
      target: cfg.target,
      namespace: cfg.branch,
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      ...(cfg.testIdAttribute !== undefined ? { testIdAttribute: cfg.testIdAttribute } : {}),
    },
  );

  // OPTIONAL: absent -> `setup` stays undefined, and RunQaUseCaseDeps.setup (also optional) makes
  // the use-case's setup phase a no-op — every composition built before this field existed keeps
  // running exactly as before.
  const setup = cfg.setupCollaborators ? new SetupPortAdapter(cfg.setupCollaborators, { target: cfg.target }) : undefined;

  const objectiveSignal = new ObjectiveSignalPortAdapter(
    {
      collector: cfg.objectiveSignal.collector as CoverageCollectorPort,
      decide: new DecideCoverageService(),
      oracle: cfg.objectiveSignal.oracle as ValueOraclePort,
    },
    {
      policy: cfg.coveragePolicy,
      repoDir: cfg.mirrorDir,
      // NAMESPACE FIX: the SAME per-run namespace ExecutionPortAdapter uses below (`cfg.branch`) —
      // see objective-signal-port.adapter.ts's own measure() comment for why `br.sha.toString()`
      // (the pre-existing fallback) mismatches the directory execution actually wrote dumps to.
      namespace: cfg.branch,
      ...(cfg.assembleChangeCoverage ? { assembleChangeCoverage: cfg.assembleChangeCoverage } : {}),
      ...(cfg.baselineCases ? { baselineCases: cfg.baselineCases } : {}),
    },
  );

  const learning = new LearningPortAdapter(cfg.learningRepo ?? new StubLearningRepository(), cfg.appName);

  const workspace = new WorkspacePortAdapter(cfg.checkout, { e2eRelDir: cfg.e2eRelDir });

  const deployGate = cfg.versionUrl
    ? new DeployGatePortAdapter(
        cfg.versionPoll ?? (async () => ({ serving: true })),
        {
          versionUrl: cfg.versionUrl,
          intervalMs: cfg.deployGateIntervalMs ?? DEFAULT_DEPLOY_GATE_INTERVAL_MS,
          timeoutMs: cfg.deployGateTimeoutMs ?? DEFAULT_DEPLOY_GATE_TIMEOUT_MS,
        },
      )
    : new NullDeployGateAdapter();

  // Production publication: real PublishDecisionService + real GitHub PR/Issue collaborators. A
  // ShadowLogAdapter is ALSO wired here (not just in buildShadow) because PublishDecisionService's
  // own decide() can independently route to "shadow" when cfg.shadow is true — the production path
  // must honor a shadow-mode APP's config too, not only buildShadow()'s own forced override.
  const publication = new PublicationPortAdapter(
    { decide: new PublishDecisionService(), pr: cfg.githubPr, issue: cfg.githubIssue, shadowLog: new ShadowLogAdapter() },
    {
      repo: cfg.repo,
      branch: cfg.branch,
      reviewerApproved: cfg.reviewerApprovedForPublish ?? true,
      coverageBlocks: cfg.coverageBlocksForPublish ?? false,
      shadow: cfg.shadow,
      e2eChanged: cfg.e2eChangedForPublish ?? true,
    },
  );

  const runHistory = cfg.historyFilePath ? new FileRunHistoryAdapter(cfg.historyFilePath) : new InMemoryRunHistoryAdapter();

  return {
    changeAnalysis,
    generation,
    review,
    validation,
    execution,
    objectiveSignal,
    publication,
    learning,
    workspace,
    deployGate,
    runHistory,
    ...(setup ? { setup } : {}),
    ...(cfg.observer ? { observer: cfg.observer } : {}),
    config: {
      needsReview: cfg.needsReview,
      shadow: cfg.shadow,
      onFailure: cfg.onFailure,
      maxRetries: cfg.maxRetries,
      isCode: cfg.isCode,
      coveragePolicyMode: cfg.coveragePolicyMode,
    },
  };
}

// Options accepted only by the "legacy" branch — never required for "rewritten" (kept optional so
// callers that KNOW they are forcing PIPELINE_ENGINE=rewritten need not supply a LegacyRunner).
export interface BuildProductionOptions {
  legacyRunner?: LegacyRunner;
}

// buildProduction(env, cfg): the flag-driven factory (design's "Step 2" shadow seam). Reads
// PIPELINE_ENGINE via selectEngine (Task E.1) — "legacy" (the fail-safe default) requires a
// LegacyRunner (options.legacyRunner); "rewritten" wires the COMPLETE RewrittenOrchestratorAdapter
// over all 11 real bridges from cfg.
export function buildProduction(
  env: Record<string, string | undefined>,
  cfg: CompositionConfig,
  options: BuildProductionOptions = {},
): RunPipelinePort {
  const engine = selectEngine(env);
  if (engine === "legacy") {
    if (!options.legacyRunner) {
      throw new Error(
        "buildProduction: PIPELINE_ENGINE is 'legacy' (the fail-safe default) but no legacyRunner was supplied — pass options.legacyRunner to wrap the existing runPipeline.",
      );
    }
    return new LegacyPipelineAdapter(options.legacyRunner);
  }
  return new RewrittenOrchestratorAdapter(wireBridges(cfg));
}

// buildShadow(cfg): ALWAYS the rewritten engine (bypasses PIPELINE_ENGINE entirely — a shadow run
// exists to observe the rewritten engine's behavior, never the legacy one). Forces the shadow
// publication path (shadow:true routes PublishDecisionService's own decide() to "shadow" — the
// SAME ShadowLogAdapter wireBridges() already wires for a shadow-mode app, reused here rather than
// duplicated) and an InMemoryRunHistoryAdapter (never the durable FileRunHistoryAdapter,
// REGARDLESS of cfg.historyFilePath) so a shadow run has zero observable side effects on the
// watched repo or the production history store.
export function buildShadow(cfg: CompositionConfig): RunPipelinePort {
  const shadowCfg: CompositionConfig = { ...cfg, shadow: true, historyFilePath: undefined };
  return new RewrittenOrchestratorAdapter(wireBridges(shadowCfg));
}
