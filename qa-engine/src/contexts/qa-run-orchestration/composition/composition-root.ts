// src/contexts/qa-run-orchestration/composition/composition-root.ts
// The composition root (Task E.2). The ONLY module in qa-engine allowed to import concrete
// adapters from sibling contexts — it sits outside generation/* and agent-runtime/*, so the
// arch-lint VCS-write gate (no-vcs-write-in-agent-contexts) stays green. Wires ALL 11
// qa-run-orchestration ports to the REAL bridge adapters built in Task E.0 so the rewritten engine
// is COMPLETE (not stubbed) and can drive a full QA run.
//
// Plan 7.6 (cutover finale): the legacy engine is DELETED. buildProduction(env, cfg) now
// UNCONDITIONALLY wires a COMPLETE RewrittenOrchestratorAdapter over all 11 real bridges — the
// PIPELINE_ENGINE flag (selectEngine) is still consulted only so an operator's stale
// PIPELINE_ENGINE=legacy gets a deprecation warning (see pipeline-engine-flag.ts), never a
// different code path.
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
import { join } from "node:path";
import type { Sha } from "@kernel/sha.ts";
import type { RunMode, TestTarget } from "@kernel/run-mode.ts";
import type { RunPipelinePort, ObserverPort, RunHistoryPort } from "../application/ports/index.ts";
import { RewrittenOrchestratorAdapter, type RewrittenOrchestratorAdapterDeps } from "../infrastructure/rewritten-orchestrator.adapter.ts";
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
import { CleanupPortAdapter, type CleanupPortCollaborators } from "../infrastructure/bridges/cleanup-port.adapter.ts";
import { PreGenerationGroundingPortAdapter, type PreGenerationGroundingCollaborators } from "../infrastructure/bridges/pre-generation-grounding-port.adapter.ts";
import { ReviewDomGroundingPortAdapter, type ReviewDomGroundingCollaborators } from "../infrastructure/bridges/review-dom-grounding-port.adapter.ts";
import { PreExecGroundingPortAdapter, type PreExecGroundingCollaborators } from "../infrastructure/bridges/pre-exec-grounding-port.adapter.ts";
import { StructuralSignalPortAdapter } from "../infrastructure/bridges/structural-signal-port.adapter.ts";
import { LazyProjectCodeGraphAdapter } from "../../../shared-infrastructure/code-graph/lazy-project-code-graph.adapter.ts";
import { ProjectNameResolver, type ProjectNameCliClient } from "../../../shared-infrastructure/code-graph/resolve-project-name.ts";
import type { CodebaseMemoryCliClient } from "../../../shared-infrastructure/code-graph/codebase-memory-code-graph.adapter.ts";
import { ServiceLinksPortAdapter } from "../infrastructure/bridges/service-links-port.adapter.ts";
import { MirrorRegistryAdapter } from "@contexts/service-topology/infrastructure/mirror-registry.adapter.ts";
import type { BoundaryProfileProviderPort } from "@contexts/service-topology/application/ports/index.ts";
import { CrossRepoImpactPortAdapter } from "../infrastructure/bridges/cross-repo-impact-port.adapter.ts";
import { GitMirrorReadAdapter } from "@contexts/change-analysis/infrastructure/git-mirror-read.adapter.ts";
import type { SandboxedBinaryRunner } from "../../../shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";

import { GenerateTestsUseCase, type GenerationResult, type GenerateOpts } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { OpencodeRunInput, ArchitectureContext } from "@contexts/generation/application/ports/generation-ports.ts";
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
  // W5 fix (seam-parity FIXME): the app's declared OpenAPI glob hint (AppConfig.openapi), threaded
  // through to GenerationPortAdapter's static ctx below — mirrors baseUrl's own app-static,
  // composition-time shape (see GenerationPortStaticContext.openapi's own doc).
  openapi?: string | string[];
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

  // CleanupPort collaborator (audit CRITICAL, task #33) — orphan test-data cleanup, e2e-only
  // (mirrors legacy's `!isCode` conjunct; wireBridges() below skips wiring this port entirely on
  // the code target, mirroring groundingCollaborators' own `!cfg.isCode` gating precedent).
  // OPTIONAL: absent -> the use-case's cleanup phase is a no-op (RunQaUseCaseDeps.cleanup itself
  // stays optional), the SAME posture as setupCollaborators above.
  //
  // NOTE: the PRIOR run's namespace itself (RunQaInput.previousNamespace's own doc,
  // run-qa.use-case.ts) is deliberately NOT a CompositionConfig field — unlike branch/mode/
  // guidance (which the port adapters need as STATIC per-run context), previousNamespace is
  // consumed directly off RunInput/RunQaInput by RunQaUseCase itself (the use-case reads
  // `input.previousNamespace`, not a composition-time value) — unnecessary to duplicate onto this
  // config too. The caller (src/server/runner.ts's runViaRewrittenEngine) sets it on RunInput at
  // the port.run(input) call site, the SAME seam triggerRepo/guidance already use.
  cleanupCollaborators?: CleanupPortCollaborators;

  // PreGenerationGroundingPort / ReviewDomGroundingPort collaborators (Plan 7-R W4, audit CRITICAL):
  // OPTIONAL, mirroring setupCollaborators' own "[SWAP] absent -> the phase is a no-op" precedent.
  // isCode target has no DOM/routes to ground (mirrors legacy's `!isCode` guards at both call
  // sites, pipeline.ts:1466/1643/2078) — wireBridges() below skips wiring both ports when
  // cfg.isCode is true, regardless of whether these collaborators are supplied.
  groundingCollaborators?: PreGenerationGroundingCollaborators;
  reviewDomGroundingCollaborators?: ReviewDomGroundingCollaborators;
  // PreExecGroundingPort collaborator (Plan 7-R B5.3): the W1/W2 pre-execution corrective/
  // deterministic-block gate. OPTIONAL, mirroring groundingCollaborators' own "[SWAP] absent -> the
  // phase is a no-op" precedent EXACTLY. isCode has no DOM/routes to ground (the SAME `!isCode`
  // gating groundingCollaborators/reviewDomGroundingCollaborators already use below) — wireBridges()
  // skips wiring this port entirely on the code target, regardless of whether this collaborator is
  // supplied.
  preExecGroundingCollaborators?: PreExecGroundingCollaborators;
  // StructuralSignalPort collaborator (CodeGraph Phase 4, design §5.3/§6, ADR-2/ADR-4/ADR-7).
  // OPTIONAL: absent -> RunQaUseCaseDeps.structuralSignal stays undefined, the SAME [SWAP]
  // posture setup/groundingCollaborators/cleanupCollaborators already established — never a stub
  // ok([])-shaped fake. When present, wireBridges constructs a StructuralSignalPortAdapter over a
  // LazyProjectCodeGraphAdapter (which resolves the codebase-memory-mcp project name from repoDir
  // via ProjectNameResolver, since the name is only knowable per-repoDir at call time — this
  // composition root itself stays synchronous). An unindexed repoDir degrades every query to
  // ok([]) inside that adapter, never surfacing here — this collaborator is deliberately just the
  // raw CLI client, not a pre-resolved project name (a caller does not know the name up front).
  codebaseMemory?: ProjectNameCliClient & CodebaseMemoryCliClient;
  // Stitcher→Generation seam (design §3.6): the OPTIONAL serviceTopology collaborator. Mirrors
  // codebaseMemory's own [SWAP] posture — absent -> RunQaUseCaseDeps.serviceLinks stays undefined,
  // NEVER a stub ok([])-shaped fake. When present, wireBridges constructs a ServiceLinksPortAdapter
  // over a REAL MirrorRegistryAdapter(mirrorRoot) (DI, not a static call) and the supplied
  // BoundaryProfileProviderPort (production: a YamlBoundaryProfileAdapter, constructed by the
  // caller — src/server/rewritten-engine-factory.ts is the ONE module with the fs access to build
  // one). Unlike codebaseMemory (ACTIVE unconditionally — an unindexed graph self-degrades cheaply),
  // this collaborator is gated by the CALLER on `services[] && boundaries[]` both being non-empty
  // (ADR-6) — this composition root does not re-derive that gate itself, it just wires whatever the
  // caller decided to supply.
  serviceTopology?: {
    appName: string;
    primaryRepo: string;
    mirrorRoot: string;
    services: readonly { repo: string }[];
    boundaryProfiles: BoundaryProfileProviderPort;
  };
  // Slice C (structural-signals-expansion, design §3.8): the OPTIONAL crossRepoImpact
  // collaborator. Mirrors serviceTopology's own [SWAP] posture — absent -> RunQaUseCaseDeps.
  // crossRepoImpact stays undefined, NEVER a stub null-shaped fake. When present, wireBridges
  // constructs a CrossRepoImpactPortAdapter over a REAL MirrorRegistryAdapter(mirrorRoot), a
  // per-service GitMirrorReadAdapter factory, a LazyProjectCodeGraphAdapter (reusing the SAME
  // codebaseMemory client the structural-signal collaborator uses), and the SAME shared
  // SandboxedBinaryRunner instance (reused for the C.4 step-1.5 mirror-freshness fetch — no new
  // process-spawning surface is introduced). Gated by the CALLER on the SAME
  // structuralSignalsOn && services[] && boundaries[] condition serviceTopology uses (design C.8).
  crossRepoImpact?: {
    mirrorRoot: string;
    codebaseMemory: ProjectNameCliClient & CodebaseMemoryCliClient;
    runner: SandboxedBinaryRunner;
  };
  // The FE<->BE architecture map (context.json), if loaded — feeds the context pack's contract
  // filtering. Absent -> the pack degrades to blast-radius + DOM only (mirrors buildContextPack's
  // own graceful degradation when contextMap is absent).
  contextMap?: ArchitectureContext;
  // Union of changed files across the PR's full commit range — further filters contracts to
  // operations the PR actually touched. Absent -> contracts are filtered by contextMap/brief alone.
  prChangedFiles?: string[];

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
  // F4 (CRITICAL security invariant): CLAUDE.md "Sanitize data leaving the system — execution logs
  // -> Issue... pass through src/orchestrator/sanitizer.ts". OPTIONAL — absent defaults to identity
  // inside PublicationPortAdapter (backward-compat for every pre-existing composition/test). The
  // composition root that owns a src/ import (src/server/rewritten-engine-factory.ts) wires the REAL
  // sanitizeText here; qa-engine/src stays src/-free — the sanitizer is injected, never imported.
  sanitize?: (text: string) => string;

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

  // W3 F1 (CRITICAL, audit-verified cutover blocker): an explicit RunHistoryPort override — takes
  // PRECEDENCE over historyFilePath when supplied. This is the seam the production factory
  // (src/server/rewritten-engine-factory.ts, the ONLY module permitted to import both qa-engine's
  // @contexts/@kernel aliases AND root src/) uses to wire the REAL durable store
  // (src/server/run-history-sqlite-adapter.ts's SqliteRunHistoryAdapter, bridging into
  // src/server/history.ts's saveRunOutcome — the SAME SQLite run_outcomes table the TUI trends
  // view, /ask learning context, and the audit process all read). Mirrors learningRepo's own
  // "[SWAP] optional override, absent -> a provable no-op default" precedent below. buildShadow
  // ALWAYS forces InMemoryRunHistoryAdapter regardless of THIS field too (not just
  // historyFilePath) — a shadow run must have zero observable side effects on the real history
  // store, and an explicit runHistory override is exactly the kind of real-store wiring shadow
  // mode exists to bypass.
  runHistory?: RunHistoryPort;

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
      // W2 fix (F4, audit-verified cutover blocker — "kill the double reviewer"): DELIBERATELY
      // false here, NOT cfg.needsReview. GenerateTestsUseCase.generate() (generation/application/
      // generate-tests.use-case.ts:124-191) fires its OWN internal reviewer session whenever
      // input.needsReview is true — a SEPARATE, independently-blind reviewer session from
      // RunQaUseCase's own ReviewPort.review() call (review-port.adapter.ts), which is threaded on
      // the SAME cfg.needsReview a few lines below via RunQaConfig.needsReview. On the orchestrated
      // path (this composition root), RunQaUseCase.run()'s "Phase: review (ReviewPort)" is the
      // AUTHORITATIVE publish gate (matches the legacy: EXACTLY ONE reviewer call per generation
      // round, src/pipeline.ts's reviewGenerated(), never two independent reviewer sessions per
      // round) — so the generation-internal reviewer must never fire on this path, or every run
      // pays for two blind LLM reviewer sessions and the SECOND, undocumented one (this one) — not
      // RunQaUseCase's own ReviewPort — silently drives the agent's own self-reported `approved`
      // flag that the no-op-skip check reads (`generated.approved && generated.specs.length === 0`,
      // run-qa.use-case.ts).
      //
      // Semantics preserved: with needsReview:false, GenerateTestsUseCase.generate() returns
      // EARLY (generate-tests.use-case.ts:124-131) with `approved: true` UNCONDITIONALLY — the
      // generator's own self-reported completion signal, not a review verdict. This is EXACTLY the
      // legacy's own no-op contract for this shape (src/pipeline.ts's reviewGenerated():
      // `if (!(app.qa.needsReview && deps.review)) return r;` — a passthrough of the generator's OWN
      // `r.approved`, never a rubber-stamped true) — RunQaUseCase's own FIX 1 comment (D.7 batch 2)
      // independently documents this SAME legacy behavior. So `generated.approved` here still
      // means "the generator's own contract check passed", and the CLAUDE.md no-op-skip invariant
      // (approved + zero specs -> skipped, never invalid) holds unchanged: a zero-spec approved
      // generation is still a valid skip, exactly as before this fix. GenerateTestsUseCase's own
      // needsReview:true branch stays intact and untouched for any standalone caller that invokes
      // it directly (outside this composition root).
      needsReview: false,
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
      // W5 fix (seam-parity FIXME): threads the app's declared OpenAPI glob hint through — mirrors
      // baseUrl's own conditional-spread precedent immediately above.
      ...(cfg.openapi ? { openapi: cfg.openapi } : {}),
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

  // CleanupPort (audit CRITICAL, task #33) — e2e-only (mirrors legacy's `!isCode` conjunct and
  // groundingCollaborators' own `!cfg.isCode` gating precedent immediately below): wire NEITHER on
  // the code target regardless of what collaborators cfg supplies (isCode has no web test data to
  // clean). OPTIONAL otherwise: absent -> `cleanup` stays undefined, and RunQaUseCaseDeps.cleanup
  // (also optional) makes the use-case's cleanup phase a no-op.
  const cleanup = !cfg.isCode && cfg.cleanupCollaborators
    ? new CleanupPortAdapter(cfg.cleanupCollaborators, { baseUrl: cfg.baseUrl, testIdAttribute: cfg.testIdAttribute })
    : undefined;

  // Plan 7-R W4 (audit CRITICAL): the pre-generation grounding phase — isCode has no DOM/routes to
  // ground (mirrors legacy's own `!isCode` guards, pipeline.ts:1466/1643/2078), so wire NEITHER port
  // on the code target regardless of what collaborators cfg supplies. OPTIONAL otherwise: absent ->
  // both stay undefined and RunQaUseCaseDeps.preGenerationGrounding/reviewDomGrounding (also
  // optional) make both phases a no-op — every composition built before these fields existed keeps
  // running exactly as before.
  const preGenerationGrounding = !cfg.isCode
    ? new PreGenerationGroundingPortAdapter(
        {
          e2eDir: join(cfg.mirrorDir, cfg.e2eRelDir),
          baseUrl: cfg.baseUrl,
          testIdAttribute: cfg.testIdAttribute,
          contextMap: cfg.contextMap,
          prChangedFiles: cfg.prChangedFiles,
        },
        cfg.groundingCollaborators ?? {},
      )
    : undefined;
  const reviewDomGrounding = !cfg.isCode
    ? new ReviewDomGroundingPortAdapter(
        {
          e2eDir: join(cfg.mirrorDir, cfg.e2eRelDir),
          baseUrl: cfg.baseUrl,
          testIdAttribute: cfg.testIdAttribute,
        },
        cfg.reviewDomGroundingCollaborators ?? {},
      )
    : undefined;

  // Plan 7-R B5.3 (audit CRITICAL): the pre-execution grounding gate (W1 corrective regen + W2
  // deterministic block) — isCode has no DOM/routes to ground (the SAME `!isCode` guard
  // preGenerationGrounding/reviewDomGrounding above already apply), so wire NEITHER this port on the
  // code target regardless of what collaborators cfg supplies. OPTIONAL otherwise: absent ->
  // preExecGrounding stays undefined and RunQaUseCaseDeps.preExecGrounding (also optional) makes the
  // whole W1/W2 phase a no-op — every composition built before this field existed keeps running
  // exactly as before.
  const preExecGrounding = !cfg.isCode
    ? new PreExecGroundingPortAdapter(
        {
          e2eDir: join(cfg.mirrorDir, cfg.e2eRelDir),
          baseUrl: cfg.baseUrl,
          testIdAttribute: cfg.testIdAttribute,
        },
        cfg.preExecGroundingCollaborators ?? {},
      )
    : undefined;

  // StructuralSignalPort (CodeGraph Phase 4, design §5.3/§6): OPTIONAL, absent -> undefined (never
  // a stub), the SAME [SWAP] posture setup/preGenerationGrounding/cleanup already established.
  // LazyProjectCodeGraphAdapter resolves the indexed project name from repoDir lazily, per call —
  // this composition root stays synchronous, and an unindexed repo degrades to no section entirely
  // inside that adapter chain (never surfacing an error here).
  const structuralSignal = cfg.codebaseMemory
    ? new StructuralSignalPortAdapter(
        new LazyProjectCodeGraphAdapter(cfg.codebaseMemory, new ProjectNameResolver(cfg.codebaseMemory)),
        // The graph is indexed at the repo ROOT — cfg.mirrorDir, not workspace.specDir's e2e
        // subfolder (see StructuralSignalPortAdapter's own header for the full rationale).
        cfg.mirrorDir,
      )
    : undefined;

  // Stitcher→Generation seam (design §3.6): OPTIONAL, absent -> undefined (never a stub), the SAME
  // [SWAP] posture structuralSignal above already established.
  const serviceLinks = cfg.serviceTopology
    ? new ServiceLinksPortAdapter(
        cfg.serviceTopology.boundaryProfiles,
        new MirrorRegistryAdapter(cfg.serviceTopology.mirrorRoot), // DI: real port impl, not a static call
        {
          appName: cfg.serviceTopology.appName,
          primaryRepo: cfg.serviceTopology.primaryRepo,
          services: cfg.serviceTopology.services,
        },
      )
    : undefined;

  // Slice C (structural-signals-expansion, design §3.8): OPTIONAL, absent -> undefined (never a
  // stub), the SAME [SWAP] posture serviceLinks above already established. Each per-triggerRepo
  // resolve() call builds a FRESH GitMirrorReadAdapter over whatever repoDir the adapter resolves
  // internally (the triggering service, a DIFFERENT repo per run) — unlike serviceLinks'
  // static-per-run posture, there is no single repoDir to pin at construction time here.
  const crossRepoImpact = cfg.crossRepoImpact
    ? new CrossRepoImpactPortAdapter({
        mirrors: new MirrorRegistryAdapter(cfg.crossRepoImpact.mirrorRoot),
        makeVcs: (repoDir) => new GitMirrorReadAdapter(repoDir, cfg.crossRepoImpact!.runner),
        codeGraph: new LazyProjectCodeGraphAdapter(cfg.crossRepoImpact.codebaseMemory, new ProjectNameResolver(cfg.crossRepoImpact.codebaseMemory)),
        runner: cfg.crossRepoImpact.runner, // reused for the C.4 step-1.5 fetch — no new spawn surface
      })
    : undefined;

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
    {
      decide: new PublishDecisionService(),
      pr: cfg.githubPr,
      issue: cfg.githubIssue,
      shadowLog: new ShadowLogAdapter(),
      ...(cfg.sanitize ? { sanitize: cfg.sanitize } : {}),
    },
    {
      repo: cfg.repo,
      branch: cfg.branch,
      reviewerApproved: cfg.reviewerApprovedForPublish ?? true,
      coverageBlocks: cfg.coverageBlocksForPublish ?? false,
      shadow: cfg.shadow,
      e2eChanged: cfg.e2eChangedForPublish ?? true,
    },
  );

  // W3 F1: an explicit runHistory override wins over historyFilePath (real durable SQLite store,
  // wired by the production factory) — historyFilePath's FileRunHistoryAdapter/InMemoryRunHistoryAdapter
  // stay the fallback for callers (tests, the F.2 operator template) that never supply one.
  const runHistory = cfg.runHistory ?? (cfg.historyFilePath ? new FileRunHistoryAdapter(cfg.historyFilePath) : new InMemoryRunHistoryAdapter());

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
    ...(cleanup ? { cleanup } : {}),
    ...(preGenerationGrounding ? { preGenerationGrounding } : {}),
    ...(reviewDomGrounding ? { reviewDomGrounding } : {}),
    ...(preExecGrounding ? { preExecGrounding } : {}),
    ...(structuralSignal ? { structuralSignal } : {}),
    ...(serviceLinks ? { serviceLinks } : {}),
    ...(crossRepoImpact ? { crossRepoImpact } : {}),
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

// Retained as an empty options bag for call-site source compatibility (callers that still pass
// `{}` or omit the argument keep working). No legacy-only options remain post-cutover.
export interface BuildProductionOptions {}

// buildProduction(env, cfg): UNCONDITIONALLY wires the COMPLETE RewrittenOrchestratorAdapter over
// all 11 real bridges from cfg. selectEngine(env) is still called so a stale PIPELINE_ENGINE=legacy
// setting surfaces its deprecation warning (see pipeline-engine-flag.ts) — its return value no
// longer branches this factory (there is only one engine left to build).
export function buildProduction(
  env: Record<string, string | undefined>,
  cfg: CompositionConfig,
  _options: BuildProductionOptions = {},
): RunPipelinePort {
  selectEngine(env);
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
  // W3 F1: strip BOTH historyFilePath and an explicit runHistory override — a shadow run must never
  // reach the real durable store either way.
  const shadowCfg: CompositionConfig = { ...cfg, shadow: true, historyFilePath: undefined, runHistory: undefined };
  return new RewrittenOrchestratorAdapter(wireBridges(shadowCfg));
}
