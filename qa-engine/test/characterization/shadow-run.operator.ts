// qa-engine/test/characterization/shadow-run.operator.ts
//
// ── SHADOW RUN — operator procedure (NOT CI; needs docker DEV + OPENCODE_API_KEY) ───────────────
// This is Task F.2 of Plan 6 (docs/superpowers/plans/2026-06-24-qa-engine-plan-6-orchestrator.md,
// "Task F.2 — The operator-invoked shadow run command + the documented procedure"). The fire-test:
// run the COMPLETE rewritten engine end-to-end (agent + Playwright + live DEV) in shadow mode and
// compare its RunOutcome to the legacy engine on the SAME sha. shadow:true ⇒ neither engine opens
// a PR/Issue — both log instead (side-effects.ts's SHADOW_LOG_MARKER). This file is operator infra:
// it imports real infrastructure and needs the OPENCODE_API_KEY, so it is NEVER run by `npm test`
// (the filename ends in `.operator.ts`, not `.test.ts` — outside the "**/*.test.ts" glob in the
// root package.json `test` script) and is EXCLUDED from qa-engine/tsconfig.json (it imports root
// src/ — see the TS6307 note below) while still being typechecked via tsconfig.parity.json.
//
// 1. Boot the microservice DEV (petclinic or jhipster-store — pick whichever's DEV you can bring up):
//      doppler run -- docker compose up --build
//      # or: cp .env.example .env (fill OPENCODE_API_KEY) && docker compose up --build
// 2. Pick a SHA on the target app and run this script (both engines, sequentially, same sha):
//      SHA=$(git ls-remote https://github.com/<org>/<spring-app> main | cut -f1)
//      node --import ./test-setup.mjs --import tsx \
//        qa-engine/test/characterization/shadow-run.operator.ts --app petclinic --sha "$SHA"
//      # or --app jhipster-store
// 3. Read the printed compareShadowRun report. EQUIVALENT ⇒ the rewritten engine ran a full real
//    QA run (agent + Playwright + live DEV) and matched legacy. shadow:true ⇒ zero PR/Issue side
//    effects on either engine's run. The script exits non-zero on any divergence — a live shadow
//    run has no fixed "scenario name" to key an automatic allowlist match on (see the allowlist
//    note near the bottom of this file), so any divergence here is an operator judgment call.
//
// ── Task F.3 note (recording the evidence) ───────────────────────────────────────────────────────
// After a real operator run against live DEV, record the printed report as the Plan 7 cutover
// precondition: either save it to engram (topic_key "sdd/qa-engine-plan-6/shadow-evidence", type
// "architecture") or commit it as a docs/ note — whichever matches this project's SDD artifact-
// store convention (engram, per sdd-init/panchito). Capture: equivalence result, any divergences,
// the SHA, and the app. This script does not perform that recording itself (F.3 is a MANUAL step
// gated on live-DEV availability) — it is the mechanism F.3 needs.
//
// ── Sequencing (preserves the one-run-vs-DEV invariant + §7.3 Step 3 isolation) ──────────────────
// legacy run (clean prepare) → rewritten run (clean prepare + a fresh InMemoryRunHistoryAdapter,
// which buildShadow() already forces regardless of historyFilePath) → compareShadowRun(legacy,
// rewritten). Both runs are sequential (never concurrent QA against the same DEV, CLAUDE.md
// "Sequential queue" invariant) and each engine gets its OWN clean workspace prepare() (a fresh
// checkout per engine, not a shared one) so neither run's working-copy state can leak into the
// other's measurement.
//
// ── TS6307 note (obs #911 — CI-gated qa-engine files must not drag root src/ into project scope) ─
// This file imports root src/ (config-loader, pipeline, opencode-client, prompts, verdict parsers,
// model-window-catalog, sanitizer, validate, execute, code-runner, github, mutation-code,
// fault-injection-e2e, deploy-gate, repo-mirror) to assemble the REAL production
// collaborators. Per the TS6307 cascade discovery, it is therefore added to
// qa-engine/tsconfig.json's `exclude` list and typecheck-covered instead via
// qa-engine/tsconfig.parity.json (the same pattern generation-ports-parity.test.ts uses) — see
// both files' diffs in this same commit. `npm run typecheck` must stay exit 0 after this change.
//
// ── Genuine adapter/port gaps found while assembling this config (reported, not fabricated) ──────
// See the "GAP:" comments below — each was either a thin, faithful wiring wrapper over an
// ALREADY-REAL function (documented inline, not fabricated business logic) or a currently-unshipped
// qa-engine primitive. None of these blocked assembling a complete CompositionConfig. VcsReadPort's
// runner GAP is now CLOSED (Sub-Plan 7.2 item 1): SandboxedBinaryRunner ships a real concrete
// SandboxedBinaryRunnerAdapter, wired below with ProcessKillAdapter. The coverage-collector GAP is
// now CLOSED (Sub-Plan 7.2 item 2): see the note near the coverage import below. The
// ManifestRepositoryPort GAP is now CLOSED (Sub-Plan 7.2 item 3): readManifest/reconcileManifest are
// real, src/-free qa-engine fns (manifest-fs.ts) — the old readManifestFile/reconcileManifestFile
// local stopgaps (a raw JSON read + a delegate into src/'s upsertManifest) are removed. The
// PromptBudgetPort.capDiff GAP is now CLOSED (Sub-Plan 7.2 item 4): capDiff/capText are real,
// src/-free qa-engine fns (prompt-cap.ts, a verbatim port of sanitizer.ts's ALREADY-DISTINCT capDiff/
// capText) — the old "capText wired into both slots" substitution is removed.
import { join } from "node:path";
import { parseShadowRunArgs } from "./shadow-run-args.ts";
import { compareShadowRun } from "./shadow-comparison.ts";
import type { SideEffect } from "./side-effect-type.ts";

import { buildShadow, type CompositionConfig } from "@contexts/qa-run-orchestration/composition/composition-root.ts";
import { LegacyPipelineAdapter, type LegacyRunner } from "@contexts/qa-run-orchestration/infrastructure/legacy-pipeline.adapter.ts";
import { Sha } from "@kernel/sha.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
// No @-alias exists for shared-infrastructure/ (only @kernel/@contexts/@interface are registered
// path aliases) and this file already imports enough root src/ that adding a 4th alias for one
// import is not worth it. Relative path stays inside qa-engine/ — this is qa-engine's OWN adapter,
// not a root src/ import.
import { SandboxedBinaryRunnerAdapter } from "../../src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.adapter.ts";
import { ProcessKillAdapter } from "../../src/shared-infrastructure/process-sandbox/process-kill.adapter.ts";
import type { AgentRole } from "@kernel/agent-role.ts";

import { GitMirrorReadAdapter } from "@contexts/change-analysis/infrastructure/git-mirror-read.adapter.ts";
import { GenerateTestsUseCase } from "@contexts/generation/application/generate-tests.use-case.ts";
import { AgentRuntimeAdapter } from "@contexts/generation/infrastructure/agent-runtime.adapter.ts";
import { PromptRenderingAdapter } from "@contexts/generation/infrastructure/prompt-rendering.adapter.ts";
import { VerdictParserAdapter } from "@contexts/generation/infrastructure/verdict-parser.adapter.ts";
import { ManifestRepositoryAdapter } from "@contexts/generation/infrastructure/manifest-repository.adapter.ts";
import { readManifest, reconcileManifest } from "@contexts/generation/infrastructure/manifest-fs.ts";
import { PromptBudgetAdapter } from "@contexts/generation/infrastructure/prompt-budget.adapter.ts";
import { capDiff, capText } from "@contexts/generation/infrastructure/prompt-cap.ts";
import { StaticGateAdapter } from "@contexts/test-execution/infrastructure/static-gate.adapter.ts";
import { E2eExecutionStrategy } from "@contexts/test-execution/infrastructure/e2e-execution.strategy.ts";
import { CodeExecutionStrategy } from "@contexts/test-execution/infrastructure/code-execution.strategy.ts";
import { StrykerMutationOracleAdapter } from "@contexts/objective-signal/infrastructure/stryker-mutation-oracle.adapter.ts";
import { FaultInjectionOracleAdapter } from "@contexts/objective-signal/infrastructure/fault-injection-oracle.adapter.ts";
import { GitHubPrAdapter } from "@contexts/workspace-and-publication/infrastructure/github-pr.adapter.ts";
import { GitHubIssueAdapter } from "@contexts/workspace-and-publication/infrastructure/github-issue.adapter.ts";
import { makeTargetCoverageCollector } from "@contexts/objective-signal/infrastructure/target-coverage-collector.ts";

// ── Root src/ collaborators (the REAL production pieces — see the TS6307 note above) ─────────────
import { loadAppConfig, type AppConfig } from "../../../src/orchestrator/config-loader.ts";
import { runPipeline, defaultPipelineDeps } from "../../../src/pipeline.ts";
import { withStallWatchdog, withUsageSink, getOpenSessionCount, type AgentDeps } from "../../../src/integrations/opencode-client.ts";
import { createAgentRuntimeManager } from "../../../src/server/agent-runtime.ts";
import { defaultEnvStoreFs } from "../../../src/server/env-store.ts";
import { OpenCodeRuntimeStrategy, CodexRuntimeStrategy } from "../../../src/agent-runtime/index.ts";
import {
  buildPromptAssembled,
  buildWorkerPromptAssembled,
  buildReviewerPromptAssembled,
  buildExplorerPrompt,
  specFileForFlow,
} from "../../../src/integrations/prompts.ts";
import { parseVerdict } from "../../../src/integrations/verdict-parse.ts";
import { parseReviewerVerdict } from "../../../src/integrations/verdict-validate.ts";
import { roleWindowBytes } from "../../../src/integrations/model-window-catalog.ts";
import { validateSpecs, defaultValidateDeps } from "../../../src/qa/validate.ts";
import { runE2E, defaultExecuteDeps } from "../../../src/qa/execute.ts";
import { runCodeTests, defaultCodeExecuteDeps } from "../../../src/qa/code-runner.ts";
import { setupE2eProject, defaultSetupDeps } from "../../../src/qa/setup.ts";
import { setupCodeProject, defaultCodeSetupDeps } from "../../../src/qa/code-runner.ts";
import { github } from "../../../src/integrations/github.ts";
import { runMutationOracle, realMutationDeps } from "../../../src/qa/learning/mutation-code.ts";
import { runFaultInjectionOracle, defaultFaultInjectionDeps } from "../../../src/qa/learning/fault-injection-e2e.ts";
import { waitForDeploy } from "../../../src/env/deploy-gate.ts";
import { ensureMirror, getCommitDiff, defaultMirrorDeps, type MirrorDeps } from "../../../src/integrations/repo-mirror.ts";

// SandboxedBinaryRunner is now a REAL, concrete qa-engine adapter (SandboxedBinaryRunnerAdapter,
// Sub-Plan 7.2 item 1 — see qa-engine/src/shared-infrastructure/process-sandbox/
// sandboxed-binary-runner.adapter.ts) wired here with ProcessKillAdapter for the process-tree kill
// on timeout/abort (the Seam-3 killTree decoupling). This closes the F.2 GAP that used to require
// this script to inline its own spawn primitive — GitMirrorReadAdapter now consumes the same real
// class the rest of qa-engine will use once assembled outside this operator script.

// The browser-coverage / native-coverage GAP is now CLOSED (Sub-Plan 7.2 item 2): a real, src/-free
// CoverageCollectorPort is built via makeTargetCoverageCollector (qa-engine/src/contexts/
// objective-signal/infrastructure/target-coverage-collector.ts), which composes the ALREADY-REAL
// V8BrowserCoverageAdapter / LcovCoverageAdapter / C8CoverageAdapter / JacocoCoverageAdapter with
// real FS dump readers (coverage-dump-reader.ts) — no more re-shaping defaultCollectCoverage()'s
// output at this script's own boundary.

// ── Real agent runtime (production wiring, NOT the dead opencode-serve:4096 target) ───────────────
// Matches src/index.ts exactly: the "agents" container runs ONLY the supervisor on :4097
// (entrypoint agent-supervisor.mjs) — there is no standalone `opencode serve` on :4096. The old
// `defaultAgentDeps()` (src/integrations/opencode-client.ts) targets `OPENCODE_SERVE_URL ??
// http://agents:4096`, a dead endpoint that fails every agent call with `TypeError: fetch failed`.
// Production never uses defaultAgentDeps() directly — it builds one AgentRuntimeManager and reads
// AgentDeps from its facade (src/index.ts lines ~115-141). This operator script must match that
// wiring exactly so both engines it drives (rewritten + legacy) talk to the real :4097 agent.
const agentRuntime = createAgentRuntimeManager({
  env: process.env,
  fs: defaultEnvStoreFs(),
  strategies: {
    opencode: new OpenCodeRuntimeStrategy({ env: process.env }),
    codex: new CodexRuntimeStrategy({ env: process.env }),
  },
  // Same signal as src/index.ts: whether the real AgentDeps facade (opencode-client.ts) currently
  // has any in-flight session. This script drives one run at a time to completion, so this is
  // almost always false in practice, but matching the real signal (instead of a hardcoded false)
  // is the correct/minimal choice — it still reports truthfully if a session leaks or is draining.
  hasOpenSessions: () => getOpenSessionCount() > 0,
});

function currentAgentDeps(): AgentDeps {
  return agentRuntime.facade().deps();
}

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

async function waitHealthy(appName: string, versionUrl: string, sha: string, pollIntervalMs: number, deployTimeoutMs: number): Promise<boolean> {
  try {
    await waitForDeploy({ name: appName, versionUrl, pollIntervalMs, deployTimeoutMs }, sha);
    return true;
  } catch {
    return false;
  }
}

// ── Assemble a REAL CompositionConfig from an AppConfig + process.env ─────────────────────────────
// The FIRST place this AppConfig→CompositionConfig mapping is written (no prior helper existed —
// confirmed by searching the qa-engine tree before writing this file).
function buildCompositionConfig(app: AppConfig, sha: string, mirrorDir: string, diff: string): CompositionConfig {
  const isCode = app.code === true;
  const target: "e2e" | "code" = isCode ? "code" : "e2e";
  const e2eRelDir = "e2e";
  const e2eDir = join(mirrorDir, e2eRelDir);
  const changedFiles = diff
    .split("\n")
    .filter((l) => l.startsWith("+++ b/") || l.startsWith("--- a/"))
    .map((l) => l.replace(/^\+\+\+ b\/|^--- a\//, ""))
    .filter((f) => f && f !== "/dev/null");
  const branch = `qa-bot/${sha.slice(0, 7)}`;

  const runner = new SandboxedBinaryRunnerAdapter({ processKill: new ProcessKillAdapter() });
  const vcs = new GitMirrorReadAdapter(mirrorDir, runner);

  // onUsage/onTurn are DELIBERATELY not forwarded: AgentRuntimeAdapter's LegacyAgentDeps types them
  // against the KERNEL UsageSnapshot/AgentTurnEvent shapes, while the REAL AgentDeps.open (src/
  // integrations/opencode-client.ts) types them against src/qa/usage.ts's UsageSnapshot — a
  // genuinely different, incompatible shape (this script does not need usage telemetry for a
  // pass/fail equivalence comparison, so dropping both callbacks is correct here, not a workaround
  // for a bug this script owns).
  //
  // The `real` source is currentAgentDeps() — the module-scope agentRuntime (AgentRuntimeManager,
  // built at the top of this file with the SAME strategies/env wiring as src/index.ts) resolved
  // through its facade, i.e. the real :4097 supervisor. This used to be defaultAgentDeps()
  // (src/integrations/opencode-client.ts), which targets the dead OPENCODE_SERVE_URL ??
  // http://agents:4096 endpoint — production never calls that function directly.
  const runtimeAdapter = new AgentRuntimeAdapter(
    {
      open: async (agent, cwd, opts) => {
        const real = currentAgentDeps();
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
    // Real, src/-free ManifestRepositoryPort fns (Sub-Plan 7.2 item 3 — manifest-fs.ts).
    manifest: new ManifestRepositoryAdapter({ readManifest, reconcileManifest }),
    // Real, src/-free capDiff/capText (Sub-Plan 7.2 item 4 — prompt-cap.ts, a verbatim port of
    // sanitizer.ts's ALREADY-DISTINCT diff-aware capDiff and flat-text capText — no substitution).
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

  const collector = makeTargetCoverageCollector({ target, repoDir: mirrorDir, e2eDir, changedFiles });
  const oracle = isCode
    ? new StrykerMutationOracleAdapter((input) => runMutationOracle(input, realMutationDeps))
    : new FaultInjectionOracleAdapter(
        // FaultInjectionInputLike has e2eDir (no repoDir) — runFaultInjectionOracle's own guard only
        // reads e2eDir/baseUrl/namespace/baselineCases, never .repoDir, so repoDir: input.e2eDir is a
        // safe, unused fill that satisfies OracleInput's required field without inventing new
        // behavior (the real fn ignores it at runtime; this is a type-level bridge only).
        (input) => runFaultInjectionOracle({ ...input, repoDir: input.e2eDir }, defaultFaultInjectionDeps),
        app.dev?.baseUrl ?? "",
      );

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
    shadow: true, // F.2 always shadows both engines — no PR/Issue side effect from this script.
    onFailure: app.report.onFailure,
    maxRetries: app.qa.fixLoop?.maxRetries ?? 2,
    isCode,
    coveragePolicyMode: app.qa.changeCoverage?.mode ?? "signal",
    diff, // thread the REAL commit diff into generation/review — without it composition-root defaults to "" → agent gets no change context → zero specs → agent-no-op skip (the divergence the shadow proof caught)

    vcs,
    generationUseCase,
    reviewRuntime: {
      runtime: runtimeAdapter,
      rendering,
      verdicts,
    },
    staticGate,
    executionStrategies: { e2e, code },
    // SetupPort (CLAUDE.md run-flow step 3): matches production's own factory wiring
    // (src/server/rewritten-engine-factory.ts) — a real shadow run must set up e2e/deps exactly
    // like production, or this proof stops being a genuine end-to-end comparison.
    setupCollaborators: {
      e2e: (specDir, opts) => setupE2eProject(specDir, defaultSetupDeps, opts),
      code: (specDir, opts) => setupCodeProject(specDir, defaultCodeSetupDeps, opts),
    },
    objectiveSignal: { collector, oracle },
    coveragePolicy: { mode: app.qa.changeCoverage?.mode ?? "signal", minRatio: app.qa.changeCoverage?.minRatio ?? 0.7 },
    baselineCases: [],

    // Real adapters are wired (not stubs) even though shadow:true means neither is ever invoked on
    // this path (buildShadow() forces the ShadowLogAdapter publication route regardless) — this
    // proves the production wiring is complete, matching the composition root's own "buildProduction
    // vs buildShadow" contract rather than special-casing this script's config.
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
    versionPoll: app.dev?.versionUrl
      ? async () => ({
          serving: await waitHealthy(
            app.name,
            app.dev!.versionUrl!,
            sha,
            app.dev!.pollIntervalMs ?? 2000,
            app.dev!.deployTimeoutMs ?? 60000,
          ),
        })
      : undefined,
  };
}

// Records which publish-side effect the legacy run fired, so compareShadowRun can flag a
// PR-vs-shadow-log divergence between the two engines. A LOCAL re-implementation of
// side-effects.ts's probeSideEffects, typed directly against defaultPipelineDeps()'s return shape
// instead of importing side-effects.ts — side-effects.ts imports scenarios.ts, which is EXCLUDED
// from qa-engine/tsconfig.json (obs #911's TS6307 cascade fix) because it bridges to the legacy
// src/ characterization harness. Importing it here would drag scenarios.ts into
// tsconfig.parity.json's project graph and reproduce the exact cascade. side-effect-type.ts (the
// non-excluded type extracted for this exact purpose — see its own header comment) supplies the
// SideEffect union so this stays wired to the single source of truth without the excluded module.
const SHADOW_LOG_MARKER = "(shadow)";

function probeLegacySideEffect(deps: ReturnType<typeof defaultPipelineDeps>): {
  deps: ReturnType<typeof defaultPipelineDeps>;
  seen(): SideEffect;
} {
  let effect: SideEffect = "none";
  const wrap = <A extends unknown[], R>(orig: ((...a: A) => R) | undefined, tag: SideEffect) =>
    orig
      ? (...a: A): R => {
          effect = tag;
          return orig(...a);
        }
      : orig;
  const wrapped = { ...deps };
  wrapped.publish = wrap(wrapped.publish, "pr")!;
  wrapped.publishCode = wrap(wrapped.publishCode, "pr")!;
  wrapped.publishContext = wrap(wrapped.publishContext, "pr")!;
  wrapped.openIssue = wrap(wrapped.openIssue, "issue")!;
  const origLog = wrapped.log;
  wrapped.log = (msg: string) => {
    if (effect === "none" && msg.includes(SHADOW_LOG_MARKER)) effect = "shadow-log";
    origLog?.(msg);
  };
  return { deps: wrapped, seen: () => effect };
}

// ── Legacy runner adapter: drives the UNCHANGED runPipeline (defaultPipelineDeps) so the legacy
// side of the comparison is the exact production path, not a re-derivation. Called with the SAME
// agentDepsFactory/hasOpenSessions/agentRuntimeConfig options as src/index.ts's currentPipelineDeps()
// — bare defaultPipelineDeps() (no options) falls back to defaultAgentDeps(), the dead :4096 target;
// this keeps the legacy engine on the real :4097 supervisor exactly like production. ───────────────
function makeLegacyRunner(app: AppConfig): LegacyRunner & { probe: { seen(): SideEffect } } {
  const savedOutcomes: RunOutcome[] = [];
  const base = {
    ...defaultPipelineDeps({
      agentDepsFactory: async (onUsage) => withStallWatchdog(withUsageSink(currentAgentDeps(), onUsage)),
      hasOpenSessions: () => agentRuntime.hasOpenSessions(),
      agentRuntimeConfig: agentRuntime.facade().config,
    }),
    saveOutcome: async (outcome: RunOutcome) => {
      savedOutcomes.push(outcome);
    },
  };
  const probe = probeLegacySideEffect(base);
  return {
    app,
    deps: { ...probe.deps, savedOutcomes },
    probe,
    runPipeline: (a, sha, d, source, opts) =>
      runPipeline(
        a as AppConfig,
        sha as string,
        d as never,
        source as "webhook" | "manual",
        opts as never,
        () => {},
        () => {},
        () => {},
      ) as Promise<{ verdict: string }>,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const { app: appName, sha } = parseShadowRunArgs(process.argv.slice(2));
  const app = loadAppConfig(appName) as AppConfig;
  if (!app.qa.shadow) {
    throw new Error(`shadow-run.operator.ts: config/apps/${appName}.yaml has qa.shadow !== true — refusing to run (this script must never risk a real PR/Issue).`);
  }

  console.log(`[shadow-run] ${appName}@${sha} — legacy run (clean prepare)...`);
  const legacyMirror = await ensureMirror(app.repo, sha, defaultMirrorDeps);
  const legacyDiff = await getCommitDiff(legacyMirror, sha, defaultMirrorDeps);

  const legacyRunner = makeLegacyRunner(app);
  const legacyPort = new LegacyPipelineAdapter(legacyRunner);
  const legacyOutcome = await legacyPort.run({
    app: appName,
    sha: Sha.of(sha),
    source: "manual",
    mode: "diff",
    target: app.code ? "code" : "e2e",
    runId: `shadow-legacy-${sha}`,
  });
  const legacySideEffect = legacyRunner.probe.seen();

  console.log(`[shadow-run] ${appName}@${sha} — rewritten run (clean prepare, fresh in-memory history)...`);
  const rewrittenCfg = buildCompositionConfig(app, sha, legacyMirror, legacyDiff);
  const rewrittenPort = buildShadow(rewrittenCfg);
  // buildShadow already forces shadow:true + InMemoryRunHistoryAdapter (§7.3 Step 3 isolation) —
  // no PR/Issue collaborator is ever reachable on this path (PublishDecisionService routes to the
  // ShadowLogAdapter unconditionally), so there is nothing to probe/wrap here the way
  // probeSideEffects wraps the legacy deps; the shadow-log path is the only route.
  const rewrittenOutcome = await rewrittenPort.run({
    app: appName,
    sha: Sha.of(sha),
    source: "manual",
    mode: "diff",
    target: app.code ? "code" : "e2e",
    runId: `shadow-rewritten-${sha}`,
  });
  const rewrittenSideEffect = "shadow-log" as const;

  const comparison = compareShadowRun(legacyOutcome, rewrittenOutcome, { legacy: legacySideEffect, rewritten: rewrittenSideEffect });
  console.log(comparison.report);

  if (!comparison.equal) {
    // A live shadow run has no fixed "scenario name" the way the CI characterization harness does
    // (parity-allowlist.json keys on scenarioFingerprint(scenarioName)), so an allowlist match here
    // can only be a manual, informed operator judgment call — never automatic. Any divergence in a
    // live run is therefore surfaced loudly with a non-zero exit; it is NEVER silently suppressed.
    console.error(`[shadow-run] DIVERGENT — ${comparison.diff ?? "(see report above)"}`);
    process.exitCode = 1;
    return;
  }

  console.log(`[shadow-run] EQUIVALENT — record this report per Task F.3 (engram topic "sdd/qa-engine-plan-6/shadow-evidence" or a docs/ note).`);
}

// Only run when invoked directly (not when imported, e.g. by a future test of a pure helper here).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[shadow-run] FAILED:", err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  });
}
