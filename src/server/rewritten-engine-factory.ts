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
//   5. mode/guidance are caller-supplied PER RUN (audit-remediation fix, judgment-day): the operator
//      template hardcodes a single mode for its one-shot comparison run; this factory's runner caller
//      knows the REAL req.mode/req.guidance for every run (diff/complete/exhaustive/manual/context),
//      so buildRewrittenCompositionConfig(app, deps, namespace, run) takes them as an explicit `run`
//      argument instead of a static "diff" literal — a hardcode here silently mis-prompted every
//      non-diff run's Generation/Review phase (composition-root.ts:187,199 feed cfg.mode/cfg.guidance
//      straight into prompt assembly).
import { join } from "node:path";
import type { AppConfig } from "../orchestrator/config-loader";
import type { AgentDeps } from "../integrations/opencode-client";
import type { RunPipelinePort, ObserverPort } from "@contexts/qa-run-orchestration/application/ports/index.ts";
import { buildProduction, type CompositionConfig } from "@contexts/qa-run-orchestration/composition/composition-root";
import { Sha } from "@kernel/sha";
import type { AgentRole } from "@kernel/agent-role";
import type { RunMode } from "@kernel/run-mode";

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
import { assembleChangeCoverage } from "@contexts/objective-signal/domain/assemble-change-coverage";

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
import { runCodeTests, defaultCodeExecuteDeps, runCodeCoverage } from "../qa/code-runner";
import { setupE2eProject, defaultSetupDeps } from "../qa/setup";
import { setupCodeProject, defaultCodeSetupDeps } from "../qa/code-runner";
import { github } from "../integrations/github";
import { sanitizeText } from "../orchestrator/sanitizer";
import { runMutationOracle, realMutationDeps } from "../qa/learning/mutation-code";
import { runFaultInjectionOracle, defaultFaultInjectionDeps } from "../qa/learning/fault-injection-e2e";
import { shaMatches } from "../env/deploy-gate";
import { ensureMirror, defaultMirrorDeps, workdirRoot } from "../integrations/repo-mirror";
import { SqliteRunHistoryAdapter } from "./run-history-sqlite-adapter";
import { SqliteLearningRepository, type LearningStore } from "@contexts/cross-run-learning/infrastructure/sqlite-learning-repository.adapter";
import { listLearningRules, upsertLearningRule, incrementRuleUsage } from "./history";

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

// Bridges cross-run-learning's LearningStore port onto src/server/history.ts's existing
// learning_rules exports (listLearningRules/upsertLearningRule/incrementRuleUsage — the SAME SQLite
// table the legacy engine's own retrieval/distillation already reads/writes). selectRules re-shapes
// history.ts's already-camelCased LearningRule[] back into the port's raw-row LearningRow[] shape
// (trigger_text/action_text) because history.ts exposes no raw-row query publicly and
// SqliteLearningRepository's own rowToRule immediately re-maps it right back — a lossless
// round-trip, not a second source of truth. upsert() narrows the port's full LearningRule down to
// legacy's RuleUpsert (trigger/action/errorClass/archetype/source) — upsertLearningRule's own
// contract always resets confidence/usageCount/status to their insert-time defaults on ANY upsert
// (see that function's own header comment in history.ts), so a caller-supplied confidence/status
// would be silently discarded by the legacy fn regardless; narrowing here just makes that existing
// contract explicit at the bridge, rather than passing fields the sink ignores.
//
// W3 fix (F3b, dual-judge round): `appName` is now an explicit parameter, threaded from the
// factory's own AppConfig.name (buildRewrittenCompositionConfig's `app` argument, already in scope
// at every call site below) — upsert() previously wrote `app: rule.archetype ?? ""`, a genuine
// cross-app data-corruption landmine (archetype is a diff-shape tag like "form"/"api-call", not an
// app identifier, and a bare upsert() caller would have silently mixed every app's rules under one
// wrong/empty `app` column, corrupting listLearningRules(app, ...)'s per-app filtering the moment
// upsert() gets a real caller). save() still has zero call sites on the orchestrated retrieval path
// (this module's scope is RETRIEVAL — see W3 F2's own header), so this fix has no behavioral effect
// until the distiller (Plan 6) starts calling save(); it closes the landmine before that day arrives.
// Exported for direct unit testing (same precedent as buildRewrittenCompositionConfig above).
export function historyLearningStore(appName: string): LearningStore {
  return {
    selectRules: (app) =>
      listLearningRules(app, 200).map((r) => ({
        id: r.id,
        trigger_text: r.trigger,
        action_text: r.action,
        error_class: r.errorClass,
        archetype: r.archetype ?? null,
        status: r.status,
        confidence: r.confidence,
        usage_count: r.usageCount,
        outcome_count: r.outcomeCount,
        success_rate: r.successRate,
        last_verified: r.lastVerified,
        source: r.source,
        at: r.at,
      })),
    upsert: (rule) =>
      upsertLearningRule({
        id: rule.id,
        app: appName, // W3 fix (F3b): the REAL app name, not the archetype placeholder — see this
        // function's own header for the corruption this closes.
        trigger: rule.trigger,
        action: rule.action,
        // The port's LearningRule.errorClass is WIDE (`string` — cross-run-learning/application/
        // ports/index.ts's own doc: "the real owner; the kernel RunOutcome.errorClass widens to
        // this"), matching the kernel's own widening pattern (run-outcome.ts's ErrorClass alias).
        // upsertLearningRule expects legacy's narrow ErrorClass union — safe to cast here because
        // the ONLY genuine producer of a port LearningRule.errorClass value is the SAME re-ported
        // labeler taxonomy (domain/helpers/error-class.ts, a verbatim port of
        // src/qa/learning/taxonomy.ts) every RunOutcome.errorClass already derives from.
        errorClass: rule.errorClass as import("../qa/learning/taxonomy").ErrorClass,
        archetype: rule.archetype ?? null,
        source: rule.source,
      }),
    recordOutcome: (outcome) => {
      // Off-path fold (LearningPort.fold -> LearningRepositoryPort.applyOutcome -> here): the
      // legacy's own recordRuleOutcome operates per-RULE (ruleId, score), not per-run — folding a
      // RunOutcome into individual rules' running statistics requires the retrievedRuleIds ↔
      // valueScore mapping the distiller/reflection layer computes (not yet ported to qa-engine;
      // this package's scope is RETRIEVAL — see W3 F2's own header). No-op until that lands; never
      // gates publish either way (LearningPort.fold's own off-path contract).
      void outcome;
    },
    // W3 fix (F3a, dual-judge round): bridges LearningRepositoryPort.incrementUsage (called by
    // LearningPortAdapter.retrieve() on every real retrieval) onto legacy's OWN incrementRuleUsage
    // (src/server/history.ts) — the SAME learning_rules.usage_count column the legacy engine's own
    // retrieveRules() increments. Prior to this fix, no caller anywhere in the store contract
    // incremented usage_count, so it stayed 0 for every rule retrieved through the rewritten engine
    // regardless of real injection count.
    incrementUsage: (ids) => incrementRuleUsage([...ids]),
  };
}

// The host's already-built real collaborators this factory reuses instead of re-assembling.
export interface RewrittenEngineFactoryDeps {
  // Reads the SAME AgentDeps facade the host's currentAgentDeps() resolves (src/index.ts) — the
  // real :4097 supervisor, not a second AgentRuntimeManager instance.
  getAgentDeps: () => AgentDeps;
  // Optional RunHistoryPort override — when absent (the production default), this factory wires the
  // REAL durable SqliteRunHistoryAdapter (src/server/run-history-sqlite-adapter.ts), which bridges
  // into the SAME src/server/history.ts SQLite run_outcomes table the TUI trends view, /ask learning
  // context, and the audit process all read (W3 F1, CRITICAL cutover blocker — prior to this fix,
  // production never set this field, so composition-root.ts's wireBridges() silently fell back to a
  // process-lifetime InMemoryRunHistoryAdapter). historyFilePath remains as an ESCAPE HATCH (a
  // caller that explicitly wants the file-backed JSONL adapter instead of SQLite — e.g. a test, or
  // a future non-SQLite deployment) — set it to opt OUT of the SQLite default.
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
//
// `run` (audit fix, judgment-day): mode/guidance are PER-RUN values, not app-static — the runner
// knows req.mode/req.guidance at call time (mirrors the namespace precedent above). Mode feeds
// GenerationPortAdapter's/ReviewPortAdapter's own prompt assembly (composition-root.ts:187,199), so
// a hardcoded "diff" here silently mis-prompted every non-diff run (complete/exhaustive/manual/
// context) as if it were a diff run.
export function buildRewrittenCompositionConfig(
  app: AppConfig,
  deps: RewrittenEngineFactoryDeps,
  namespace: string,
  run: { mode: RunMode; guidance?: string },
  // Bug fix: the PER-RUN ObserverPort (src/server/runner.ts's buildRewrittenObserver) — threaded
  // straight into CompositionConfig.observer so wireBridges() wires it into RunQaUseCaseDeps.
  // Optional: a caller that omits it (e.g. a unit test building a config directly) keeps every
  // onStep() call in RunQaUseCase a no-op, exactly the pre-fix behavior.
  observer?: ObserverPort,
): CompositionConfig {
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

  // changedFiles: static `[]` placeholder — the SAME documented limitation as `diff: ""` above (no
  // per-run diff exists yet at composition time). ObjectiveSignalPortAdapter.measure() derives the
  // REAL per-run changedFiles from the dynamic diff and threads them into collect()'s optional
  // trailing arg (the "dynamic diff" precedent), so this placeholder only matters for a caller that
  // never supplies a diff (i.e. never a real production diff-mode run).
  const rawCollector = makeTargetCoverageCollector({ target, repoDir: mirrorDir, e2eDir, changedFiles: [] });
  // Code-mode coverage trigger (legacy parity: src/pipeline.ts:487 `if (input.target === "code")
  // await runCodeCoverage(input.repoDir).catch(() => {})`, BEFORE the lcov/Istanbul readers run —
  // src/qa/code-runner.ts:786's own doc: "best-effort... never throws... caller falls back to
  // unmeasured"). The rewritten collector composite (LcovCoverageAdapter/C8CoverageAdapter) reads
  // conventional report paths passively; nothing in the rewritten path ever RUNS the repo's own
  // instrumented test command to PRODUCE those reports — this wrapper closes that gap the same
  // best-effort way legacy does (catch -> ignore, degrading to the collector's own fail-open "no
  // report found" -> "unknown", never a crash).
  const collector: typeof rawCollector = isCode
    ? {
        collect: async (specDir, namespace, changedFiles) => {
          await runCodeCoverage(mirrorDir).catch(() => {});
          return rawCollector.collect(specDir, namespace, changedFiles);
        },
      }
    : rawCollector;
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
    // Audit fix (judgment-day): PER-RUN, not a static "diff" literal — see this fn's own header.
    // A hardcoded "diff" fed GenerationPortAdapter/ReviewPortAdapter the wrong mode prompt for
    // every complete/exhaustive/manual/context run.
    mode: run.mode,
    ...(run.guidance ? { guidance: run.guidance } : {}),
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
    // SetupPort (CLAUDE.md run-flow step 3): bootstraps the config/e2e seed into e2e/ (first run) +
    // npm ci, or installs the repo's own deps for code mode — the SAME real src/qa/setup.ts /
    // src/qa/code-runner.ts functions defaultPipelineDeps() wires for the legacy engine, so both
    // engines set up a fresh mirror identically. specDir here is whatever WorkspacePortAdapter's
    // checkout(sha) resolved (composition-root.ts's own contract) — e2eDir under the REAL per-run
    // mirrorDir, not this factory's static placeholder mirrorDir/e2eDir above.
    setupCollaborators: {
      e2e: (specDir, opts) => setupE2eProject(specDir, defaultSetupDeps, opts),
      code: (specDir, opts) => setupCodeProject(specDir, defaultCodeSetupDeps, opts),
    },
    // W4 follow-up (Task #37 audit CRITICAL, a9e7dfb's own "KNOWN FOLLOW-UP" note): wire the
    // PreGenerationGroundingPort / ReviewDomGroundingPort collaborators explicitly, mirroring
    // setupCollaborators' own visible-wiring precedent immediately above, rather than relying on
    // composition-root.ts's wireBridges() implicit `cfg.groundingCollaborators ?? {}` fallback.
    // `{}` here is not a stub: PreGenerationGroundingPortAdapter/ReviewDomGroundingPortAdapter each
    // resolve an omitted collaborator to the REAL production fn (`this.collaborators.buildContextPack
    // ?? buildContextPack`, `this.collaborators.captureDom ?? captureDom`, both backed by
    // defaultContextPackDeps/defaultCaptureDomDeps — the same real-Playwright-spawn capture legacy's
    // own defaultCaptureDomDeps uses) — so this was already functionally wired before this fix; this
    // makes that fact explicit at the ONE seam permitted to say so, instead of leaving it implicit
    // three files away. wireBridges() itself skips both ports entirely on the code target
    // (isCode guard, mirroring legacy's own `!isCode` guards, pipeline.ts:1466/1643/2078), so no
    // target check is needed here.
    groundingCollaborators: {},
    reviewDomGroundingCollaborators: {},
    // contextMap / prChangedFiles: LEFT ABSENT, deliberately. Legacy sources contextMap by reading
    // e2e/.qa/context.json off the REAL per-run mirrorDir (src/pipeline.ts's loadContextMap(),
    // :1308-1320) and prChangedFiles from intent.changedFiles (classifyCommit(message, diff),
    // src/pipeline.ts:2121) — both are per-run values that only exist AFTER checkout(sha) resolves
    // the real mirrorDir and classifyCommit runs, neither of which has happened yet at this
    // composition-build call (the SAME documented limitation as `diff: ""` and the static
    // `mirrorDir` placeholder above: this factory has no per-run mirrorDir/diff in hand here).
    // Wiring a value that doesn't exist yet would be fabrication, not grounding — per the
    // CompositionConfig's own documented degrade path, buildContextPack falls back to
    // blast-radius + DOM only, exactly the same graceful degradation legacy itself documents when
    // context.json/the brief is absent. A future fix can thread these dynamically once
    // GenerationPortAdapter/ReviewPortAdapter grow the SAME "dynamic diff" seam pattern the diff
    // field already uses (composition-root.ts's own precedent for this class of gap).
    // CRITICAL fix (live crash, judgment-day audit): baseUrl is app-static (the live DEV URL from
    // config), so it is correct to set it once here at composition time — unlike diff/mode/guidance,
    // there is no per-run value to thread. Without this, E2eExecutionStrategy.run() (wired via
    // executionStrategies.e2e above) never receives a baseUrl and throws "E2eExecutionStrategy
    // requires a baseUrl (live DEV URL)" the moment a real e2e run reaches execution.
    ...(app.dev?.baseUrl ? { baseUrl: app.dev.baseUrl } : {}),
    // Audit fix (worst leak in audit-2026-07-flaky-selector-leaks): mirrors legacy's
    // resolveTestIdAttribute(app) (src/pipeline.ts:835: `config.e2e?.testIdAttribute ?? "data-testid"`)
    // — but deliberately WITHOUT the "data-testid" default. CompositionConfig's own doc
    // (composition-root.ts:87-89) already documents "NO defaulting logic here; undefined flows
    // through and the seed playwright.config.ts already defaults to data-testid" — applying the
    // default a second time here would just be redundant, not wrong, but omitting it keeps this
    // factory's mapping a pure pass-through of the app's declared config, matching every other
    // optional field in this object.
    ...(app.e2e?.testIdAttribute !== undefined ? { testIdAttribute: app.e2e.testIdAttribute } : {}),
    objectiveSignal: { collector, oracle },
    coveragePolicy: { mode: app.qa.changeCoverage?.mode ?? "signal", minRatio: app.qa.changeCoverage?.minRatio ?? 0.7 },
    // THE VALUE KEYSTONE (CLAUDE.md "The value/trust risk"): turns the collector's raw CoverageReport
    // + the run's real per-run diff (threaded dynamically by ObjectiveSignalPortAdapter.measure(), the
    // SAME "dynamic diff" precedent as generationUseCase/reviewRuntime above) into the ChangeCoverage
    // read-model DecideCoverageService.decide() consumes. A pure port of legacy parseDiffHunks +
    // computeChangeCoverage (qa-engine/src/contexts/objective-signal/domain/assemble-change-coverage.ts)
    // — supplying it here is what turns the previously-always-"unknown" measurement into a REAL one.
    assembleChangeCoverage,
    baselineCases: [],

    // Real GitHub PR/Issue collaborators — the actual production publish path (buildProduction, not
    // buildShadow). PublishDecisionService's own decide() still routes to the ShadowLogAdapter when
    // cfg.shadow is true (composition-root.ts wireBridges() wires that unconditionally), so a
    // shadow-mode app never fires these even on this REAL path.
    // F5 fix (HIGH): GitHubPrAdapter defaults its own `base` param to "main" when omitted
    // (github-pr.adapter.ts:14) — this call previously never passed app.baseBranch at all, so every
    // app with a non-"main" default branch (mirrors legacy's own `app.baseBranch ?? "main"` used
    // throughout src/pipeline.ts, e.g. :1214/:1430/:3138/:3222) would silently target the wrong base
    // branch for its suite PR.
    githubPr: new GitHubPrAdapter(
      {
        createPullRequest: (repo, args) => github.createPullRequest(repo, args),
        enableAutoMerge: (nodeId) => github.enableAutoMerge(nodeId),
        mergePullRequest: (repo, number) => github.mergePullRequest(repo, number),
      },
      app.baseBranch ?? "main",
    ),
    githubIssue: new GitHubIssueAdapter((repo, title, body) => github.openIssue(repo, title, body)),
    reviewerApprovedForPublish: true,
    coverageBlocksForPublish: false,
    e2eChangedForPublish: true,
    // F4 fix (CRITICAL security invariant): the REAL sanitizeText (this module is the E.3 seam
    // permitted to import src/ — see this file's own header) — PublicationPortAdapter's renderBody/
    // renderTitle apply it to every log/case-detail/note reaching an Issue/PR body, matching
    // src/report/reporter.ts's own `s = (v) => sanitizeText(v).text` precedent for the legacy engine.
    sanitize: (text: string) => sanitizeText(text).text,

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

    // W3 F1 (CRITICAL cutover blocker): the REAL durable RunHistoryPort by default — takes
    // precedence over historyFilePath in composition-root.ts's wireBridges(). historyFilePath stays
    // available as an explicit opt-OUT (see RewrittenEngineFactoryDeps's own doc above).
    ...(deps.historyFilePath ? { historyFilePath: deps.historyFilePath } : { runHistory: new SqliteRunHistoryAdapter() }),
    // W3 F2 (CRITICAL cutover blocker): the REAL SqliteLearningRepository — wraps the SAME
    // learning_rules SQLite table src/server/history.ts already owns (historyLearningStore(), this
    // module's own bridge, above) via the SAME LearningRepositoryPort -> LearningPort seam
    // composition-root.ts's wireBridges() already wires (LearningPortAdapter). Prior to this fix,
    // composition-root.ts's `cfg.learningRepo ?? new StubLearningRepository()` default meant
    // production had ZERO real constructors of SqliteLearningRepository anywhere — retrieval and
    // the outcome fold were both provable no-ops end-to-end, regardless of what history.ts's own
    // SQLite table held.
    learningRepo: new SqliteLearningRepository(historyLearningStore(app.name)),
    ...(observer ? { observer } : {}),
  };
}

// The RunnerDeps.engineFactory seam (src/server/runner.ts) — returns a factory mapping
// (AppConfig, namespace, run) → RunPipelinePort. Only ever invoked by the runner when
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
//
// The `run` parameter (audit fix, judgment-day) carries the PER-RUN mode/guidance — see
// buildRewrittenCompositionConfig's own header. Same statelessness contract: nothing here is
// cached, so two calls with two different `run` values compose two independent configs.
//
// The `observer` parameter (bug fix): the runner's PER-RUN ObserverPort (src/server/runner.ts's
// buildRewrittenObserver) — forwarded straight into buildRewrittenCompositionConfig so the
// resulting RunPipelinePort's RunQaUseCase actually reports progress back to the RunRecord/
// RunEvents. Without this 4th argument (or a caller that omits it), record.step never advances
// past its initial value and /api/runs/:id/events stays empty for the ENTIRE run — this was the
// root cause: RunnerDeps.engineFactory's signature had no seam for an observer at all, so even
// though ObserverPort/RunQaUseCaseDeps.observer existed, nothing ever constructed one.
export function createRewrittenEngineFactory(
  deps: RewrittenEngineFactoryDeps,
): (appConfig: AppConfig, namespace: string, run: { mode: RunMode; guidance?: string }, observer?: ObserverPort) => RunPipelinePort {
  const env = deps.env ?? process.env;
  return (appConfig: AppConfig, namespace: string, run: { mode: RunMode; guidance?: string }, observer?: ObserverPort): RunPipelinePort => {
    const cfg = buildRewrittenCompositionConfig(appConfig, deps, namespace, run, observer);
    return buildProduction(env, cfg);
  };
}
