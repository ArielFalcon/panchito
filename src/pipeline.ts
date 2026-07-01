// Full QA pipeline, shared by every trigger (manual CLI and webhook). The
// deterministic infrastructure lives here (gate, working copy, harness,
// publishing, reporting); the agentic generation is delegated to OpenCode
// (see integrations/opencode-client.ts + opencode/opencode.json). The source of
// truth for the tests is the repo's `e2e/` folder in git, not a volume. Steps
// that touch the network or have side effects are injected via PipelineDeps, so
// ordering and branches are verifiable with stubs.

import { join, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, lstatSync } from "node:fs";
import { AppConfig } from "./orchestrator/config-loader";
import { DeployTarget, waitForDeploy } from "./env/deploy-gate";
import { ensureMirror, ensureMirrorAtBranch, getCommitDiff, getCommitMessage, getRangeDiff, listChangedSpecs as gitListChangedSpecs, getCommitsBehind, defaultMirrorDeps, realGit } from "./integrations/repo-mirror";
import { runConfinement, type ConfinementResult } from "./qa/confinement";
import { createUsageAccumulator, type UsageSnapshot, type RunUsage } from "./qa/usage";
import { runOpencode, runOpencodeParallel, shouldFanOut, defaultAgentDeps, reviewIndependently, getOpenSessionCount, withUsageSink, withStallWatchdog, maybeExplore, agentTimeout } from "./integrations/opencode-client";
import { classifyCommit, CommitIntent } from "./qa/commit-classify";
import { setupE2eProject, defaultSetupDeps } from "./qa/setup";
import { validateSpecs, defaultValidateDeps } from "./qa/validate";
import { runE2E, defaultExecuteDeps, defaultCleanupDeps, e2eTimeoutMs, allFailuresAreRunnerInfra } from "./qa/execute";
import { setupCodeProject, defaultCodeSetupDeps, runCodeTests, defaultCodeExecuteDeps, runCodeCoverage } from "./qa/code-runner";
import { validateCodeProject, defaultCodeValidateDeps } from "./qa/code-validate";
import { publishE2e, publishCode, publishContext, publishE2eSubset, defaultPublishDeps } from "./integrations/publish";
import { perFileSelectorPresence, attributeCorrections, triagePublish, findDanglingPrSpecs } from "./qa/spec-triage";
import { testDataNamespace } from "./qa/test-data";
import { labelRunOutcome } from "./qa/learning/labeler";
import { runMutationOracle } from "./qa/learning/mutation-code";
import { runFaultInjectionOracle } from "./qa/learning/fault-injection-e2e";
import type { OracleInput, ValueOracleResult } from "./qa/learning/oracle-types";
import { retrieveRules, type RetrievalResult } from "./qa/learning/retrieval";
import { preventionOutcome, renderRulesForReviewer, attributableRules, type LearningRule } from "./qa/learning/learning-rule";
import { bestEffort, bestEffortAsync } from "./qa/learning/best-effort";
import { distillReflection, distillReviewerCorrections } from "./qa/learning/distiller";
import { detectStructuralPatterns } from "./qa/learning/structural-pattern";
import { matchExemplars, renderExemplarsForPrompt } from "./qa/learning/skill-exemplar";
import { initCurriculum, selectActiveArchetypesCached, renderArchetypesForPrompt, recordArchetypeHit, clearActiveArchetypesCache } from "./qa/learning/curriculum";
import type { StructuredReflection } from "./types";
import { validateContext, isContextStale } from "./qa/context";
import type { ArchitectureContext } from "./qa/context";
import { readMeasured, writeMeasured, recordStability, recordCoverage, MeasuredFs } from "./qa/measured";
import {
  parseDiffHunks,
  computeChangeCoverage,
  type ChangeCoverage,
  decideCoverage,
  blocksPublish,
  renderUncovered,
  defaultCollectCoverage,
  clearRunArtifacts,
  hasBrowserCoverageDumps,
  DEFAULT_COVERAGE_POLICY,
  collectNativeBranchCoverage,
  type CoveredLines,
  type CoveredBranches,
  type CoverageCollectInput,
  type ChangeCoveragePolicy,
} from "./qa/change-coverage";
import { github } from "./integrations/github";
import { capDiff } from "./orchestrator/sanitizer";
import { renderIssue, type IssueContext, type TestedItem, type AdjudicationLabel } from "./report/reporter";
import { renderValueTag } from "./qa/value-report";
import { captureDom, captureDomByRoute, captureRouteTrees, defaultCaptureDomDeps, capDomLines, extractTargetRoutes, type CaptureDomInput, type RouteSnapshot } from "./qa/dom-snapshot";
import { buildContextPack, defaultContextPackDeps } from "./qa/context-pack";
import { aggregateStaticSignal, type StaticSignalInput } from "./qa/static-signal/aggregate";
import { defaultStaticSignalDeps } from "./qa/static-signal/aggregate.defaults";
import { EMPTY_STATIC_SIGNAL, type StaticSignal } from "./qa/static-signal/types";
import { renderStaticSignal } from "./qa/static-signal/render";
import { loadContextCache as loadContextCacheDefault, saveContextCache as saveContextCacheDefault } from "./qa/context-cache";
import { AgentResult, QaCase, QaRunResult, TriggerSource, RunMode, RunOptions, TestTarget, RunOutcome, SpecMeta, RunVerdict } from "./types";
import type { AgentDeps, ReviewInput, ReviewResult } from "./integrations/opencode-client";
import { renderExecutionResult } from "./integrations/opencode-client";
import type { AgentRuntimeConfig } from "./agent-runtime/types";
import { decideProgress, bestRound, classifyFailure, type RoundResult } from "./qa/progress-gate";
import { adjudicate, ADJ_CLASS, type AdjudicatorEvidence, type AdjudicatorVerdict } from "./qa/failure-adjudicator";
import { checkSpecSelectors, unscopedMultipleContradictions } from "./qa/selector-check";
import { buildRouteCatalog } from "./qa/route-catalog";
import { catalogGate } from "./qa/catalog-gate";
import { extractChangedElements, changedElementsFromGuidance, type ChangedElement } from "./qa/changed-elements";

// Tests live in this folder inside the repo (git is the source of truth).
const E2E_DIR = "e2e";

// Track consecutive reviewer failures to detect persistent outages.
let consecutiveReviewerFailures = 0;

export interface GenerateInput {
  repo: string;
  sha: string;
  diff: string;
  mirrorDir: string;
  namespace: string;
  needsReview: boolean;
  mode: RunMode;
  appName: string; // engram project namespace — scopes memory per app
  baseUrl?: string; // e2e: the live DEV URL the agent navigates with the Playwright MCP
  target?: TestTarget; // "e2e" (default) or "code"
  intent?: CommitIntent; // diff mode: type + message + files; the agent derives the objective
  guidance?: string; // manual mode: user instructions on what to test
  openapi?: string | string[]; // optional hint: where the repo's OpenAPI contract(s) live
  fixCases?: QaCase[]; // re-generation: failed cases from a previous execution to fix
  reviewCorrections?: string[]; // re-generation: corrections from a reviewer rejection
  coverageGap?: string; // re-generation: changed lines not yet exercised (change-coverage)
  selectorContradictions?: string[]; // Lever-2 deterministic absent/ambiguous selector findings (W1) — rendered un-truncated
  learnedRules?: string; // retrieval: rules from past runs injected into the agent prompt
  domSnapshot?: string; // live DEV a11y snapshot — grounds the generator's selectors in regeneration
  failureSourced?: boolean; // true when domSnapshot is the failure-point capture (not a live pre-write snapshot) — switches the prompt framing to "GROUND TRUTH AT FAILURE"
  parallelDiff?: boolean; // qa.parallelDiff: diff-mode fan-out opt-in
  explorer?: boolean; // qa.explorer: read-only explorer pass before the generator (single-agent diff)
  runId?: string; // for SSE live activity: maps the OpenCode session to this run record
  contextMap?: ArchitectureContext; // cross-cutting: the FE↔BE map loaded from e2e/.qa/context.json
  // Slice G: pre-built Context Pack text (blast-radius + DOM + contracts), assembled by the
  // orchestrator before the first write and pushed into the generator prompt (VOLATILE band).
  contextPack?: string;
  // Static signal: deterministic pre-computed analysis (symbols, relations, complexity, patterns)
  // rendered as a prompt section by renderStaticSignal. Empty string or absent = no section added.
  staticSignal?: string;
  // C1: diff archetypes computed by detectStructuralPatterns for the current diff.
  // Threaded here so the generator receives a one-line structural hint ("Change shape: auth-flow, …").
  diffArchetypes?: string[];
  // Seam b: deterministic list of existing spec file paths under e2eRelDir/**/*.spec.ts, enumerated
  // from the filesystem before the session starts. When non-empty and mode is diff or manual,
  // rendered as an "existing-suite-manifest" semi-stable section. Absent or empty = no section.
  existingSpecFiles?: string[];
  // Slice H: the ExplorationBrief produced by the orchestrator-level explorer pass, carried into
  // defaultPipelineDeps.generate so it can be forwarded as contextBrief to runOpencode WITHOUT
  // triggering a second maybeExplore call (explorer flag cleared when this is set). The brief also
  // fed buildContextPack before this GenerateInput is created — same brief, one pass, no double-run.
  explorerBrief?: import("./qa/exploration-brief").ExplorationBrief;
  // Slice 1 (agent-grounding-change-anchor): the change-anchor signals extracted from the diff (or
  // guidance in MANUAL mode). Carried to defaultPipelineDeps.generate so the captureRoutesDom closure
  // can pass them into captureDomByRoute's input object for [CHANGED: …] annotation. Absent → no
  // annotation (byte-identical to today). opencode-client.ts is NOT modified — the closure arity
  // stays (routes: string[]) => Promise<Map<string, string>>.
  changedElements?: import("./qa/changed-elements").ChangedElement[];
  // Pillar 1 (selector grounding): config-declared test-id convention, forwarded by the captureRoutesDom
  // closure to captureDomByRoute so worker DOM capture queries the right attribute. Absent → "data-testid".
  testIdAttribute?: string;
  service?: { repo: string; mirrorDir: string; openapi?: string | string[] }; // cross-repo: the triggering microservice (read-only working copy)
  services?: Array<{ repo: string; mirrorDir: string; openapi?: string | string[] }>; // context mode: every declared service, mirrored read-only
}

// RE-3: a generator session kept alive across a run's regeneration cycles (opt-in via
// qa.sessionContinuity). The FIRST generate() sends the full prompt; each later generate() sends a
// short follow-up on the SAME session (the agent already holds the working rules / brief / pack /
// diff), so the fix-loop stops re-orienting. dispose() frees it; the real impl ALSO self-disposes
// after a wall-clock deadline, so an early-return/throw can never leak a session past that bound.
export interface GeneratorSession {
  generate(input: GenerateInput): Promise<AgentResult>;
  dispose(): Promise<void>;
}

export interface PipelineDeps {
  // The signal aborts the gate's poll loop early (run cancelled, or the commit was
  // classified as a skip while the gate was still polling in the background).
  waitForDeploy(target: DeployTarget, sha: string, signal?: AbortSignal): Promise<void>;
  prepare(repo: string, sha: string, commits?: number, baseSha?: string): Promise<{ mirrorDir: string; diff: string; message: string }>;
  // Cross-repo runs: the PRIMARY repo at the HEAD of its base branch (the triggering
  // SHA belongs to the service repo and does not exist in the primary).
  prepareAtBranch(repo: string, branch: string): Promise<{ mirrorDir: string }>;
  // Phase 6a: `onRepair` fires once when the generator emits an in-session contract-repair
  // re-prompt, so the shared cycle counter can account for repairs without polling the turn store.
  generate(input: GenerateInput, signal?: AbortSignal, onProgress?: (msg: string) => void, onUsage?: (u: UsageSnapshot) => void, onRepair?: () => void): Promise<AgentResult>;
  // RE-3 (opt-in via qa.sessionContinuity): open ONE generator session for the whole run. Absent ⇒
  // the fresh-session-per-call `generate` path is used (current behavior, no regression). The
  // pipeline owns the handle and disposes it; the real impl self-disposes after a deadline too.
  openGenerator?(
    input: GenerateInput,
    ctx: { signal?: AbortSignal; onProgress?: (msg: string) => void; onUsage?: (u: UsageSnapshot) => void; onRepair?: () => void },
  ): Promise<GeneratorSession>;
  // The *.spec.ts the agent actually wrote on disk (git status over e2e/), e2e-relative.
  // The authoritative spec set for the no-op decision and the reviewer's file list — the
  // orchestrator trusts the working copy, not the agent's self-report. Absent ⇒ no
  // reconciliation (the agent's reported specs are used, as before).
  listChangedSpecs?(mirrorDir: string, e2eRelDir: string): Promise<string[]>;
  setupE2e(e2eDir: string): Promise<void>; // installs the e2e project's dependencies
  validate(e2eDir: string): Promise<{ ok: boolean; errors: string[]; infra: boolean }>;
  execute(e2eDir: string, opts: { baseUrl: string; namespace: string; testIdAttribute?: string; onCase?: (c: QaCase) => void; onRunning?: (title: string) => void; onDiscovered?: (title: string, file?: string) => void; signal?: AbortSignal }): Promise<QaRunResult>;
  cleanup(e2eDir: string, opts: { baseUrl: string; namespace: string; testIdAttribute?: string }): Promise<void>; // orphan-data cleanup (best-effort)
  isHealthy(versionUrl: string): Promise<boolean>; // is DEV healthy right now? (infra vs quality)
  isReachable(url: string): Promise<boolean>; // generic DEV reachability — does the host respond at all (no /version contract)
  // Phase 6a: `onRepair` fires once when the reviewer emits an in-session contract-repair
  // re-prompt, so the shared cycle counter can account for repairs without polling the turn store.
  review?(input: ReviewInput, signal?: AbortSignal, onUsage?: (u: UsageSnapshot) => void, onRepair?: () => void): Promise<ReviewResult>; // independent reviewer (null = disabled)
  // Change-coverage provider (the value keystone). Returns the lines actually exercised by the
  // run, repo-relative, or null when no usable coverage was produced (→ "unknown", never blocks).
  // Absent (undefined) ⇒ the change-coverage step is skipped entirely.
  collectCoverage?(input: CoverageCollectInput): Promise<CoveredLines | null>;
  // SEPARATE optional dep — adds branch-coverage signal without changing collectCoverage's
  // CoveredLines | null return type. Absent → branches stay null (fail-open, never blocks).
  collectBranchCoverage?(input: CoverageCollectInput): Promise<CoveredBranches | null>;
  // Clears the run's V8 coverage dumps before a measured execute, so a measurement
  // reflects ONLY the execute that just ran (never a prior same-sha run's stale dumps,
  // nor an earlier enforce round). Absent ⇒ no clear (the unit tests stub execute).
  clearCoverage?(e2eDir: string, namespace: string): void;
  // Did this run produce any V8 coverage dumps? Used only to make a "structural no-op"
  // (dumps existed but matched zero changed files) observable, distinct from "no data".
  hasCoverageDumps?(e2eDir: string, namespace: string): boolean;
  // Persists suite-level learning (stability + covered files) to the run's measured.json.
  // e2e-only; absent ⇒ no persistence (unit tests stub it). Injected so it is stubbable.
  recordMeasured?(e2eDir: string, input: { cases: QaCase[]; coveredFiles: string[] }): void;
  publish(input: { repo: string; sha: string; mirrorDir: string; baseBranch: string; parentRunId?: string }): Promise<{ prUrl: string | null; merged: boolean; error?: string } | null>;
  /** Selective publish: stages only the given spec files + DEP_CLOSURE (e2e/.qa/), not whole e2e/.
   *  Used by the specTriage dual decide-step. Absent ⇒ subset publish unavailable (falls back to flag-OFF path). */
  publishSubset?(input: { repo: string; sha: string; mirrorDir: string; baseBranch: string; parentRunId?: string; tested?: import("./report/reporter").TestedItem[] }, files: string[]): Promise<{ prUrl: string | null; merged: boolean; error?: string } | null>;
  // Code mode (target "code"): no web env, no Playwright. Install the repo's deps,
  // run its own test suite, classify by exit code, and publish the new tests.
  setupCode(repoDir: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  executeCode(repoDir: string, opts: { namespace: string; onCase?: (c: QaCase) => void; signal?: AbortSignal; timeoutMs?: number; changedFiles?: string[]; log?: (line: string) => void }): Promise<QaRunResult>;
  // Code-mode compile-feedback gate (Filter B for code): compile the generated tests WITHOUT running
  // them, per ecosystem. Optional — when unwired, code mode skips the gate (the suite is the gate).
  validateCode?(repoDir: string, opts?: { changedFiles?: string[]; timeoutMs?: number }): Promise<{ ok: boolean; errors: string[]; infra: boolean }>;
  publishCode(input: { repo: string; sha: string; mirrorDir: string; baseBranch: string; parentRunId?: string }): Promise<{ prUrl: string | null; merged: boolean; error?: string } | null>;
  publishContext(input: { repo: string; sha: string; mirrorDir: string; baseBranch: string }): Promise<{ prUrl: string | null; merged: boolean; error?: string } | null>;
  openIssue(repo: string, title: string, body: string): Promise<{ url: string }>;
  // Grounds the independent reviewer in the LIVE DEV DOM: renders the routes the spec targets and
  // returns "role: name" lines so the reviewer judges UI facts against reality, not its training
  // memory. Best-effort (undefined on any failure) — the review degrades to defer-on-unverifiable.
  captureDom?(input: { e2eDir: string; baseUrl: string; specContents: string[]; testIdAttribute?: string }): Promise<string | undefined>;
  // Pre-execution per-route RAW a11y trees for the deterministic selector check (W1). Distinct from
  // captureDom (which formats a fused string for the reviewer) — this returns raw `.nodes` per route for
  // checkSpecSelectors. Best-effort and tech-agnostic; absent ⇒ the pre-execution check is skipped (no
  // regression). The unit tests stub this to bypass the browser.
  captureRouteTrees?(input: CaptureDomInput): Promise<RouteSnapshot[]>;
  // Persistent context-map cache (qa-data). Skips the ~195s agent rebuild when a same-sha map exists.
  loadContextCache?(app: string): ArchitectureContext | undefined;
  saveContextCache?(app: string, map: ArchitectureContext): void;
  saveOutcome?(outcome: RunOutcome): Promise<void>; // learning layer: persist RunOutcome (off-path, never blocks)
  // Post-run PROCESS audit (off-path, server-side): inspect this run's quality vs. recent history,
  // self-heal the ledger (deprecate noise rules), and record an incident for the maintainer on a
  // repeating engine defect. Absent ⇒ no audit.
  auditProcess?(input: { app: string; runId: string }): Promise<void>;
  runOracle?(input: OracleInput): Promise<ValueOracleResult>; // Phase 1: mutation testing / benchmark replay (off-path, never blocks)
  retrieveRules?(app: string, errorClass?: string | null, archetypes?: string[]): RetrievalResult; // Phase 2: retrieval (archetypes bias relevance to the diff's structural shape)
  reflectAndDistill?(input: { app: string; runId: string; outcome: RunOutcome; archetype?: string | null }): Promise<StructuredReflection | null>; // Phase 2: reflect + distill (off-path, never blocks)
  // Reviewer→learning: distill this run's reviewer corrections into candidate rules.
  // Off-path: a failure is a warning, never a verdict change. Absent ⇒ skipped.
  distillCorrections?(input: { app: string; runId: string; corrections: string[]; archetype?: string | null }): { inserted: string[] };
  // The app's most recent persisted outcome's errorClass — biases rule retrieval toward
  // rules that prevent the failure the engine made last. Absent ⇒ no bias.
  recentErrorClass?(app: string): Promise<string | null>;
  // Slice H: run the read-only explorer pass BEFORE buildContextPack so the brief is available to
  // feed both the pack (blast-radius + verified routes → DOM capture) and the generator (passed as
  // explorerBrief on GenerateInput so runOpencode reuses it without re-running maybeExplore).
  // Optional — absent ⇒ pack is built without a brief (DOM and contracts from contextMap only).
  // Cost: one extra read-only explorer agent session for diff/manual first-pass only.
  // Never called on regen passes (fix/review/coverage) or code-mode runs.
  exploreForPack?(input: GenerateInput, signal?: AbortSignal, onProgress?: (msg: string) => void): Promise<import("./qa/exploration-brief").ExplorationBrief | null>;
  log?(msg: string): void;
  // Injectable clock seam — returns the current time in milliseconds. Defaults to Date.now().
  // Exposed so tests can control the clock for deterministic wall-clock guard assertions
  // without relying on real elapsed time or monkey-patching globals.
  nowMs?(): number;
  // Context mode: validates the produced context.json. Injected so tests can bypass file I/O.
  validateContextFn?(content: unknown): { ok: boolean; errors: string[] };
  // Context mode: reads the built map back for the per-service coverage warning.
  // Absent ⇒ the warning step is skipped (unit tests that don't care).
  readBuiltContext?(e2eDir: string): ArchitectureContext | null;
  // Diff mode: checks whether the deployed context.json is stale vs the current HEAD.
  // Returns a warning string if stale, empty string if fresh or no map exists.
  checkContextStaleness?(mirrorDir: string, sha: string): Promise<string>;
  // Write-confinement guard: detects and reverts agent writes outside the allowed area
  // (e2e/ for e2e-target; denylist for code-target). Non-blocking — the run continues.
  // Absent ⇒ guard disabled (no-op). Result is always set when dep is wired, including
  // the clean case ({ strays: 0, dangerous: 0, reverted: [] }).
  confine?(mirrorDir: string, isCode: boolean): Promise<ConfinementResult>;
  // The agent runtime config for this run — used to derive usage.complete.
  // Absent ⇒ complete defaults to false.
  agentRuntimeConfig?: AgentRuntimeConfig;
  // Static signal aggregator: deterministic pre-computed analysis (symbols, relations, complexity,
  // patterns). Optional — absent ⇒ step skipped, no signal injected. Signal-only, fail-open.
  aggregateStaticSignal?: (input: StaticSignalInput) => Promise<StaticSignal>;
}

export interface DefaultPipelineDepsOptions {
  agentDepsFactory?: (onUsage?: (u: UsageSnapshot) => void) => Promise<AgentDeps>;
  hasOpenSessions?: () => boolean;
  // The agent runtime config — forwarded to PipelineDeps.agentRuntimeConfig so runPipeline can
  // derive usage.complete (true iff primary and reviewer are both opencode).
  agentRuntimeConfig?: AgentRuntimeConfig;
}

export function defaultPipelineDeps(options: DefaultPipelineDepsOptions = {}): PipelineDeps {
  // The default factory wraps defaultAgentDeps so the per-run usage sink is injected via the SINGLE
  // typed mechanism — opts.onUsage on every open() — exactly as the production override in index.ts
  // does. defaultAgentDeps itself takes no usage argument; capture is driven only through open opts.
  // withUsageSink is the shared wrapper (also used in index.ts) so the precedence cannot drift.
  const agentDepsFactory: (onUsage?: (u: UsageSnapshot) => void) => Promise<AgentDeps> =
    options.agentDepsFactory ??
    (async (onUsage) => withStallWatchdog(withUsageSink(await defaultAgentDeps(), onUsage)));
  const hasOpenSessions = options.hasOpenSessions ?? (() => getOpenSessionCount() > 0);

  return {
    agentRuntimeConfig: options.agentRuntimeConfig,
    waitForDeploy: (target, sha, signal) => waitForDeploy(target, sha, undefined, signal),
    prepare: async (repo, sha, commits, baseSha) => {
      const mirrorDir = await ensureMirror(repo, sha, defaultMirrorDeps);
      const diff = baseSha && baseSha !== sha
        ? await getRangeDiff(mirrorDir, baseSha, sha, defaultMirrorDeps)
        : await getCommitDiff(mirrorDir, sha, defaultMirrorDeps, commits);
      const message = await getCommitMessage(mirrorDir, sha, defaultMirrorDeps);
      return { mirrorDir, diff, message };
    },
    prepareAtBranch: async (repo, branch) => ({ mirrorDir: await ensureMirrorAtBranch(repo, branch, defaultMirrorDeps) }),
    listChangedSpecs: (mirrorDir, e2eRelDir) => gitListChangedSpecs(mirrorDir, e2eRelDir, defaultMirrorDeps),
    generate: async (input, signal, onProgress, onUsage, onRepair) => {
      const ocInput = {
        repo: input.repo,
        sha: input.sha,
        diff: input.diff,
        mirrorDir: input.mirrorDir,
        e2eRelDir: E2E_DIR,
        namespace: input.namespace,
        needsReview: input.needsReview,
        target: input.target ?? "e2e",
        mode: input.mode,
        appName: input.appName,
        baseUrl: input.baseUrl,
        intent: input.intent,
        guidance: input.guidance,
        openapi: input.openapi,
        fixCases: input.fixCases,
        reviewCorrections: input.reviewCorrections,
        coverageGap: input.coverageGap,
        selectorContradictions: input.selectorContradictions,
        learnedRules: input.learnedRules,
        domSnapshot: input.domSnapshot,
        failureSourced: input.failureSourced,
        runId: input.runId,
        contextMap: input.contextMap,
        // Slice H: no-double-run guarantee. When the orchestrator already ran the explorer
        // pass (input.explorerBrief is set), forward the brief as contextBrief and clear
        // the explorer flag so maybeExplore inside runOpencode returns null immediately.
        // When explorerBrief is absent, preserve the explorer flag so runOpencode can still
        // run maybeExplore if the app config requests it (opt-in backward-compat path).
        contextBrief: input.explorerBrief ?? undefined,
        explorer: input.explorerBrief ? false : input.explorer,
        contextPack: input.contextPack,
        staticSignal: input.staticSignal,
        // C1: thread diff archetypes into the prompt builder for the structural hint.
        diffArchetypes: input.diffArchetypes,
        // Seam b: thread the filesystem-enumerated spec file manifest into the prompt builder.
        existingSpecFiles: input.existingSpecFiles,
        service: input.service,
        services: input.services,
      };
      // Build the AgentDeps with the per-run usage sink wired in (the factory injects onUsage into
      // every open() via opts), so each session.prompt response emits a UsageSnapshot into the run's
      // accumulator.
      const oc = await agentDepsFactory(onUsage);
      // Phase 5 — unified diff/manual engine + cardinality-keyed fan-out.
      //
      // Routing decision (three cases):
      //   1. complete/exhaustive (e2e): always plan → fan-out via shouldFanOut (unchanged).
      //   2. diff/manual (e2e, first-pass): always plan first, then branch on objective count
      //      inside runOpencodeParallel (<2 → strong-agent fallback; ≥2 → fan-out workers).
      //      Replaces the old shouldFanOut gate that required parallelDiff=true for diff fan-out.
      //   3. regen passes (fix/review/coverage), code mode, or context mode: strong agent only
      //      (same as before — feedback context cannot be split across workers).
      //
      // Phase 6a NOTE: generateParallel workers are intentionally NOT covered by the shared cycle
      // counter. Workers are fire-and-join sessions bounded by OPENCODE_TIMEOUT_MS per session,
      // not by an iterated loop — so the counter would double-count them against the per-loop
      // ceiling and break fan-out. The counter covers only the main-agent iterated path.
      const isReGen = Boolean(input.fixCases?.length || input.reviewCorrections?.length || input.coverageGap);
      const isCodeMode = (input.target ?? "e2e") !== "e2e";
      // complete/exhaustive: use shouldFanOut (unchanged — regression gate proves this).
      const isCompleteExhaustive = shouldFanOut(input);
      // diff/manual first-pass e2e: unified engine — always plan-first, cardinality decides fan-out.
      const isDiffManualFirstPass = !isReGen && !isCodeMode && (input.mode === "diff" || input.mode === "manual");
      const useParallel = isCompleteExhaustive || isDiffManualFirstPass;
      return useParallel
        ? runOpencodeParallel(ocInput, oc, {
            signal,
            onProgress,
            // Deterministic DOM grounding for the fan-out workers: capture the planned routes' live
            // a11y tree on the orchestrator (Playwright stays out of the agent boundary). Best-effort.
            ...(input.baseUrl
              ? {
                  // Slice 1: capture changedElements from input (set by runPipeline before this GenerateInput is built).
                  // Passed inside captureDomByRoute's input object (not as a closure arg — the arity (routes: string[]) is pinned by opencode-client.ts).
                  captureRoutesDom: (routes: string[]) => captureDomByRoute(routes, { e2eDir: join(input.mirrorDir, E2E_DIR), baseUrl: input.baseUrl, changedElements: input.changedElements, testIdAttribute: input.testIdAttribute }, defaultCaptureDomDeps),
                }
              : {}),
          })
        : runOpencode(ocInput, oc, { signal, onProgress, onRepair });
    },
    // Slice H (fixed): run the read-only explorer pass at the orchestrator level UNIVERSALLY for
    // every diff/manual e2e first-pass generation — no qa.explorer flag required. The explorer was
    // previously opt-in; the fix makes it unconditional so apps without qa.explorer (e.g. portfolio)
    // also get the blast-radius grounding. qa.explorer is now ONLY used as the maybeExplore fallback
    // inside runOpencode when exploreForPack dep is absent (legacy path, no-op in production).
    // Best-effort: error → null → pack degrades to DOM+contracts only.
    exploreForPack: async (input, signal, onProgress) => {
      if (input.target === "code") return null;
      // Regen passes (fix/review/coverage) must not re-run the explorer — the pack is already present.
      const isReGen = Boolean(input.fixCases?.length || input.reviewCorrections?.length || input.coverageGap);
      if (isReGen) return null;
      // Explorer runs on diff mode and manual mode (manual shares the same engine and benefits from
      // the blast-radius/route grounding equally). complete/exhaustive do not build a per-commit pack.
      if (input.mode !== "diff" && input.mode !== "manual") return null;
      try {
        // Build a minimal OpencodeRunInput just for the explorer pass (no contextPack, no contextBrief).
        const explorerOcInput = {
          repo: input.repo,
          sha: input.sha,
          diff: input.diff,
          mirrorDir: input.mirrorDir,
          e2eRelDir: E2E_DIR,
          namespace: input.namespace,
          needsReview: false,
          target: (input.target ?? "e2e") as import("./types").TestTarget,
          mode: input.mode as import("./types").RunMode,
          appName: input.appName,
          baseUrl: input.baseUrl,
          intent: input.intent,
          guidance: input.guidance,
          runId: input.runId,
          explorer: true, // force-enable so maybeExplore doesn't skip it
          service: input.service,
        };
        const oc = await agentDepsFactory(undefined);
        return maybeExplore(explorerOcInput, oc, { signal, onProgress });
      } catch (err) {
        console.warn(`[qa] exploreForPack failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    },
    setupE2e: (e2eDir) => setupE2eProject(e2eDir, defaultSetupDeps),
    validate: (e2eDir) => validateSpecs(e2eDir, defaultValidateDeps),
    validateCode: (repoDir, opts) => validateCodeProject(repoDir, defaultCodeValidateDeps, opts),
    execute: (e2eDir, opts) => runE2E(e2eDir, opts, defaultExecuteDeps),
    cleanup: (e2eDir, opts) => defaultCleanupDeps.runCleanup({ dir: e2eDir, ...opts }),
    setupCode: (repoDir, opts) => setupCodeProject(repoDir, defaultCodeSetupDeps, opts),
    executeCode: (repoDir, opts) => runCodeTests(repoDir, opts, defaultCodeExecuteDeps),
    publishCode: (input) => publishCode(input, defaultPublishDeps),
    publishContext: (input) => publishContext(input, defaultPublishDeps),
    readBuiltContext: (e2eDir) => {
      try {
        return JSON.parse(readFileSync(join(e2eDir, ".qa", "context.json"), "utf8")) as ArchitectureContext;
      } catch {
        return null;
      }
    },
    checkContextStaleness: async (mirrorDir, sha) => {
      const ctxPath = join(mirrorDir, E2E_DIR, ".qa", "context.json");
      if (!existsSync(ctxPath)) return "";
      let ctx: { builtAtSha?: string };
      try {
        ctx = JSON.parse(readFileSync(ctxPath, "utf8"));
      } catch {
        return "[qa] WARNING: e2e/.qa/context.json is present but unparseable — the FE↔BE map may be wrong; regenerate it (context mode).";
      }
      if (!ctx.builtAtSha || ctx.builtAtSha === sha) return "";
      try {
        const commitsBehind = await getCommitsBehind(mirrorDir, ctx.builtAtSha, sha, defaultMirrorDeps);
        const r = isContextStale({ builtAtSha: ctx.builtAtSha, headSha: sha, commitsBehind });
        return r.stale ? r.reason : "";
      } catch (err) {
        // Fail-loud: an orphaned/invalid builtAtSha (force-push/rebase) means we CANNOT verify
        // freshness — say so, instead of silently treating the map as up to date.
        return `[qa] WARNING: could not verify context map freshness (builtAtSha=${String(ctx.builtAtSha).slice(0, 12)}): ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    isHealthy: async (versionUrl) => {
      try {
        const res = await fetch(versionUrl);
        if (!res.ok) return false;
        return ((await res.json()) as { healthy?: boolean }).healthy === true;
      } catch {
        return false;
      }
    },
    isReachable: async (url) => {
      try { await fetch(url, { signal: AbortSignal.timeout(10_000) }); return true; }
      catch { return false; }
    },
    review: async (input, signal, onUsage, onRepair) =>
      reviewIndependently(input, await agentDepsFactory(onUsage), { signal, onRepair }),
    captureDom: (input) => captureDom(input, defaultCaptureDomDeps),
    captureRouteTrees: (input) => captureRouteTrees(input, defaultCaptureDomDeps),
    loadContextCache: (app) => loadContextCacheDefault(app),
    saveContextCache: (app, map) => saveContextCacheDefault(app, map),
    collectCoverage: async (input) => {
      // Code runs emit no coverage report on their own, so produce one (best-effort, fully
      // decoupled from the pass/fail run) before reading it. e2e reads the V8 dumps the
      // suite already produced. A null result → "unmeasured", never a misleading 0%.
      if (input.target === "code") await runCodeCoverage(input.repoDir).catch(() => {});
      return defaultCollectCoverage(input);
    },
    collectBranchCoverage: async (input) => {
      if (input.target !== "code") return null; // V8 branch parsing out of scope (code-mode-scoped)
      try { return collectNativeBranchCoverage(input.repoDir); } catch { return null; }
    },
    clearCoverage: (e2eDir, ns) => clearRunArtifacts(e2eDir, ns),
    hasCoverageDumps: (e2eDir, ns) => hasBrowserCoverageDumps(e2eDir, ns),
    recordMeasured: (e2eDir, input) => {
      const measuredPath = join(e2eDir, ".qa", "measured.json");
      const mfs: MeasuredFs = {
        read: (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
        write: (p, c) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); },
      };
      let store = readMeasured(mfs, measuredPath);
      store = recordStability(store, input.cases);
      if (input.coveredFiles.length) store = recordCoverage(store, input.coveredFiles);
      writeMeasured(mfs, measuredPath, store);
    },
    confine: (mirrorDir, isCode) =>
      runConfinement(mirrorDir, isCode, {
        git: realGit,
        realpath: (p) => realpathSync(p),
        // Cheap symlink pre-filter so the escape check only resolves realpath for actual symlinks.
        isSymlink: (p) => lstatSync(p).isSymbolicLink(),
      }),
    publish: (input) => publishE2e(input, defaultPublishDeps),
    publishSubset: (input, files) => publishE2eSubset(input, files, defaultPublishDeps),
    openIssue: (repo, title, body) => github.openIssue(repo, title, body),
    aggregateStaticSignal: (input) => aggregateStaticSignal(input, defaultStaticSignalDeps),
    saveOutcome: async (outcome) => {
      const { saveRunOutcome } = await import("./server/history");
      saveRunOutcome(outcome);
    },
    auditProcess: async ({ app, runId }) => {
      // The full post-run quality loop (server-side, off-path). (1) deterministic detection, (2) an
      // LLM root-cause diagnosis enriches each engine-fix finding (the qa-reflector — Layer 2),
      // (3) the router applies each by disposition: deprecate ledger noise + invalidate a stale map
      // AUTONOMOUSLY (reversible DATA), surface engram for the agent layer, and record an incident
      // for the qa-maintainer ONLY on an engine-code defect (which the maintainer turns into a
      // human-gated fix PR — Layers 4-5). Best-effort throughout; never blocks.
      const { getRunOutcome, listRunOutcomes, listLearningRules, setRuleStatusByHuman, markContextStale } = await import("./server/history");
      const { auditProcess, applyAudit } = await import("./qa/learning/process-audit");
      const { recordIncident } = await import("./server/maintainer");
      const outcome = getRunOutcome(runId);
      if (!outcome) return; // not persisted yet / nothing to audit
      const recent = listRunOutcomes(app, 10);
      const rules = listLearningRules(app, 50).map((r) => ({ id: r.id, errorClass: r.errorClass, status: r.status, usageCount: r.usageCount, successRate: r.successRate }));
      const findings = auditProcess({ outcome, recent, rules });
      if (findings.length === 0) return;

      // Layer 2 — LLM root-cause diagnosis, ONLY for engine-fix findings (rare: a repeating defect),
      // so the maintainer starts from a hypothesis, not a bare signal. qa-reflector is tool-less and
      // read-only; a failure just leaves the finding undiagnosed (the deterministic evidence stands).
      const engineFindings = findings.filter((f) => f.disposition === "engine-fix");
      // Defer the LLM diagnosis when the system is busy: opening a qa-reflector session would
      // contend for the OpenCode server + the LLM API with the active run (same guard as
      // reflectAndDistill). The findings still record their deterministic evidence — only the
      // optional root-cause hypothesis is skipped. Best-effort, never blocks the audit.
      if (engineFindings.length > 0 && hasOpenSessions()) {
        console.warn("[qa] engine-fix diagnosis skipped (non-blocking): another agent session is open; the incident records without a root-cause hypothesis");
      } else if (engineFindings.length > 0) {
        try {
          const { askAssistant } = await import("./integrations/opencode-client");
          const agentDeps = await agentDepsFactory();
          const recentLine = recent.slice(0, 5).map((o) => `${o.at.slice(0, 19)} ${o.verdict}/${o.errorClass ?? "-"} ${o.sha.slice(0, 7)}`).join("\n");
          for (const f of engineFindings) {
            const prompt = [
              `The ai-pipeline ENGINE (the deterministic orchestrator, NOT the watched app's tests) shows a repeating quality problem.`,
              `Finding: ${f.summary}`,
              `Evidence: ${f.evidence}`,
              `Recent run outcomes (newest first):\n${recentLine}`,
              `In 2-3 sentences: the most likely ROOT CAUSE in the ENGINE's own logic, and which area/file to inspect. Be concrete; do not blame the watched app.`,
            ].join("\n\n");
            // Phase 0b: pass runId so the qa-reflector session can be correlated to the run that triggered the audit.
            f.diagnosis = (await askAssistant({ context: prompt, question: "Diagnose the engine defect.", instruction: "Output 2-3 plain sentences. No markdown.", agent: "qa-reflector", runId }, agentDeps, "/tmp")).trim() || undefined;
          }
        } catch {
          // best-effort: an undiagnosed engine-fix still records its deterministic evidence
        }
      }

      applyAudit(findings, {
        log: (line) => console.log(line),
        deprecateRule: (ruleId) => setRuleStatusByHuman(ruleId, "deprecated"),
        recordEngineIncident: (f) =>
          recordIncident({
            source: "process-audit",
            severity: f.severity === "error" ? "error" : "warn",
            summary: f.summary,
            detail: [f.evidence, f.diagnosis ? `\nLIKELY ROOT CAUSE (qa-reflector): ${f.diagnosis}` : ""].join(""),
          }),
        invalidateContext: (reason) => {
          // Force the next generating run to rebuild the app's architecture map — a reversible DATA
          // heal (the map regenerates), never a code change. Set a DB-backed staleness flag rather
          // than writing the mirror's context.json: the mirror is reset by `git checkout -f`/`git
          // clean -fd` on every run, so a file-level write would be undone before the next run reads
          // it. The flag survives and is consumed by the context-bootstrap step.
          try {
            markContextStale(app);
            console.log(`[audit] marked context stale for ${app} — rebuilds next run (${reason})`);
            return true;
          } catch { /* best-effort */ }
          return false;
        },
      });
    },
    runOracle: async (input) =>
      input.target === "e2e" ? runFaultInjectionOracle(input) : runMutationOracle(input),
    retrieveRules: (app, errorClass, archetypes) => retrieveRules({ app, errorClass: errorClass as import("./qa/learning/taxonomy").ErrorClass | null, archetypes }),
    recentErrorClass: async (app) => {
      const { listRunOutcomes } = await import("./server/history");
      return listRunOutcomes(app, 1)[0]?.errorClass ?? null;
    },
    distillCorrections: (input) => distillReviewerCorrections({ ...input, log: console.log }),
    reflectAndDistill: async (input) => {
      // Defer: skip the reflection when the system is already busy with another
      // run. Opening a qa-assistant session would contend for the OpenCode server
      // and the LLM API — the reflection is best-effort, never worth delaying the
      // next queued run. Loud: a skipped reflection is lost learning, never silent.
      if (hasOpenSessions()) {
        console.warn("[qa] reflection skipped (non-blocking): another agent session is open; this failure will not produce a rule");
        return null;
      }
      const { buildReflectionPrompt, parseStructuredReflection } = await import("./qa/learning/reflector");
      const prompt = buildReflectionPrompt({
        errorClass: input.outcome.errorClass!,
        gateSignals: input.outcome.gateSignals,
        verdict: input.outcome.verdict,
        sha: input.outcome.sha,
        mode: input.outcome.mode,
      });
      const { askAssistant } = await import("./integrations/opencode-client");
      const deps = await agentDepsFactory();
      try {
        const raw = await askAssistant(
          // qa-reflector is a tool-less role: the reflection is a pure transform of the failure
          // context into a rule, with no engram/filesystem access (unlike the chat assistant).
          // Phase 0b: pass runId so the qa-reflector session is correlated to the run in telemetry.
          { context: prompt, question: "Produce the StructuredReflection JSON.", instruction: "Output ONLY the JSON object. No markdown, no explanation.", agent: "qa-reflector", runId: input.runId },
          deps,
          "/tmp",
        );
        // Robust parse (handles ```json fences / surrounding prose) instead of a raw JSON.parse,
        // which threw "Unexpected token '`'" when the qa-reflector wrapped its output in a fence.
        const json = parseStructuredReflection(raw);
        if (json) {
          distillReflection({ app: input.app, runId: input.runId, reflection: json, archetype: input.archetype });
          // Back-fill the reflection onto its run_outcomes row so it is durable and queryable,
          // not just consumed once to distill a rule and then thrown away (best-effort).
          try {
            const { updateRunOutcomeReflection } = await import("./server/history");
            updateRunOutcomeReflection(input.runId, json);
          } catch (err) {
            console.warn(`[qa] WARNING: persisting reflection failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
          }
          return json as StructuredReflection;
        }
        return null;
      } catch (err) {
        console.warn(`[qa] WARNING: reflectAndDistill internal failure (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    },
    log: (m) => console.log(m),
  };
}

type CurriculumState = ReturnType<typeof initCurriculum>;

interface ValueLearningInput {
  deps: PipelineDeps;
  app: AppConfig;
  run: QaRunResult;
  isCode: boolean;
  generating: boolean;
  mode: RunMode;
  mirrorDir: string;
  e2eDir: string;
  ns: string;
  diff: string;
  sha: string;
  runId?: string;
  signal?: AbortSignal;
  retrievedRuleIds: string[];
  retrievedRules: LearningRule[];
  curriculum: CurriculumState | null;
  changedFiles: string[];
  ccForPersistence?: ChangeCoverage;
  specMetas?: SpecMeta[];
  log: (m: string) => void;
  // Optional timing sink — accumulates oracle wall-clock time into the run's phaseTimings.
  addTiming?: (label: string, ms: number) => void;
}

// PIPE-02: the off-path VALUE-learning side-effects — suite-level measured persistence, the value
// oracle's ground-truth + its attribution into the retrieved rules, and curriculum archetype credit
// — lifted out of runPipeline into one collaborator over an explicit context. Keeps the
// deterministic state machine free of the non-deterministic learning tail it must stay separate
// from. Fail-open: every step is best-effort, a failure is a non-blocking warning, the score never
// gates publish. Returns the computed valueScore and the (possibly updated) curriculum.
async function foldValueLearning(
  input: ValueLearningInput,
): Promise<{ valueScore: number | null; curriculum: CurriculumState | null }> {
  const { deps, app, run, isCode, generating, mode, mirrorDir, e2eDir, ns, diff, sha, runId, signal, retrievedRuleIds, retrievedRules, changedFiles, ccForPersistence, specMetas, log } = input;
  let curriculum = input.curriculum;

  // Measured persistence (suite-level): suite stability + actually-covered files to measured.json
  // (gitignored). e2e-ONLY (code mode has no e2e/ dir). Best-effort, not yet durable across host loss.
  if (!isCode && specMetas && specMetas.length > 0 && deps.recordMeasured) {
    const coveredFiles = ccForPersistence ? ccForPersistence.perFile.filter((f) => f.covered > 0).map((f) => f.file) : [];
    deps.recordMeasured(e2eDir, { cases: run.cases, coveredFiles });
  }

  let valueScore: number | null = null;
  // Shadow-aware default for both targets; an explicit qa.valueOracle always wins. Both targets are
  // signal-only and never block publish.
  const valueOraclePolicy = app.qa.valueOracle ?? (app.qa.shadow ? "off" : "signal");
  // The e2e fault-injection oracle scores the ASSERTION STRENGTH of baseline-PASSING specs, so its
  // real precondition is "≥1 spec passed" — not a fully-green run, and not a specific mode. In the
  // heavy, infrequent whole-suite modes (complete/exhaustive/manual) it runs on the passing SUBSET
  // even when sibling specs failed, so a partially-red run still earns the learning signal. THIS WAS
  // THE ORACLE GAP: exhaustive/complete runs (which generate the most tests) never reached the
  // oracle, so their retrieved candidate rules never accumulated outcomes and never promoted. The
  // frequent diff path keeps the conservative full-pass gate, so a run that already caught a
  // regression doesn't also pay the 2× re-run cost. The code (mutation) oracle is unchanged: full
  // pass, any mode.
  const e2eOracle =
    !isCode && !!app.dev?.baseUrl &&
    (mode === "diff" ? run.verdict === "pass" : run.cases.some((c) => c.status === "pass"));
  const codeOracle = isCode && run.verdict === "pass";
  const runValueOracle = !!deps.runOracle && generating && valueOraclePolicy === "signal" && (codeOracle || e2eOracle);
  if (runValueOracle) {
    try {
      log(isCode ? "[qa] oracle: running mutation testing (diff-scoped)..." : "[qa] oracle: running response fault-injection (signal)...");
      const _oracleT0 = Date.now();
      const oracleResult = await deps.runOracle!({
        target: isCode ? "code" : "e2e",
        repoDir: mirrorDir,
        e2eDir,
        namespace: ns,
        changedFiles: mode === "diff" ? [...parseDiffHunks(diff).keys()] : undefined,
        baseUrl: app.dev?.baseUrl,
        baselineCases: run.cases.filter((c) => c.status === "pass").map((c) => c.name),
        signal,
        onProgress: (msg) => log(`[qa] ${msg}`),
      });
      input.addTiming?.("oracle", Date.now() - _oracleT0);
      valueScore = oracleResult.valueScore;
      if (valueScore !== null) {
        log(`[qa] oracle: valueScore=${(valueScore * 100).toFixed(0)}% (${oracleResult.details})`);
      } else {
        log(`[qa] oracle: no value score — ${oracleResult.details}`);
      }
      try {
        const { saveScorecardEntry } = await import("./server/history");
        saveScorecardEntry({
          runId: runId ?? sha,
          app: app.name,
          sha,
          target: isCode ? "code" : "e2e",
          valueScore: oracleResult.valueScore,
          mutantCount: oracleResult.mutantCount,
          killedCount: oracleResult.killedCount,
          at: new Date().toISOString(),
        });
      } catch (err) {
        log(`[qa] WARNING: scorecard persist failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (err) {
      log(`[qa] WARNING: oracle failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Attribution: fold this run's valueScore into each retrieved rule's running statistics (running
  // mean + hysteresis). NEVER an overwrite, so a fluke cannot poison the ledger.
  //
  // FIX 1b: thread the run's change-coverage into recordRuleOutcome as coverageCreditConfirmed so
  // the Phase-7 coverage-anchored promotion gate actually fires on this (the value-oracle) path —
  // previously it passed no third arg, leaving it permanently null, so a candidate could promote on
  // verdict signal alone even where coverage WAS measured and found zero credit. Mirrors the
  // no-oracle prevention path (which already threads it):
  //   true  → coverage measured AND ratio > 0 (the tests exercised changed lines) → promotion eligible
  //   false → coverage measured AND ratio == 0 (no changed lines covered) → hold at candidate
  //   null  → coverage not measured / cross-repo / unknown → no gate (promotion on verdict signal)
  if (retrievedRules.length > 0 && valueScore !== null) {
    const coverageMeasured = ccForPersistence?.measured ?? false;
    const coverageCreditConfirmed = coverageMeasured ? ccForPersistence!.overall.ratio > 0 : null;
    const diffArchetypes = detectStructuralPatterns(diff, changedFiles).map((p) => p.kind);
    const targets = attributableRules(retrievedRules, { diffArchetypes });
    const { recordRuleOutcome } = await import("./server/history");
    bestEffort("attribution", log, () => {
      for (const r of targets) recordRuleOutcome(r.id, valueScore, coverageCreditConfirmed);
      log(`[qa] attribution: recorded outcome (valueScore=${(valueScore * 100).toFixed(0)}%, coverageCredit=${coverageCreditConfirmed ?? "unmeasured"}) for ${targets.length}/${retrievedRules.length} attributable rule(s)`);
    }, undefined);
  }

  // Curriculum archetype credit ONLY when ground truth proves value (valueScore > 0). No-oracle apps
  // get NO credit: a bare `fail` cannot tell "caught a real regression" from "test is wrong against
  // DEV", so crediting it would bias the curriculum toward fragile archetypes (the Goodhart hole).
  if (curriculum && valueScore !== null && valueScore > 0) {
    const patterns = detectStructuralPatterns(diff, changedFiles);
    const exemplars = patterns.flatMap((p) => matchExemplars(p));
    for (const ex of exemplars) curriculum = recordArchetypeHit(curriculum, ex.archetype);
    clearActiveArchetypesCache(app.name);
  }

  return { valueScore, curriculum };
}

// Regeneration-loop caps. Module-level so the runaway backstop (MAX_CYCLES, derived below)
// and the loops that actually consume them share ONE source of truth — the derivation cannot
// silently drift from the real loop bounds.
//   MAX_REVIEW_ROUNDS    — reviewer reject→regenerate rounds inside one generateAndReview().
//   MAX_STATIC_FIX_ROUNDS — static-gate (Filter B) repair rounds (tsc/eslint/list).
const MAX_REVIEW_ROUNDS = 2;
const MAX_STATIC_FIX_ROUNDS = 2;

// Each generateAndReview() costs at most CYCLES_PER_GENERATE counter ticks: 1 for the entry
// invocation + up to (MAX_REVIEW_ROUNDS - 1) in-loop review-round regenerations.
const CYCLES_PER_GENERATE = 1 + (MAX_REVIEW_ROUNDS - 1);
// In-session contract-repair headroom: each generateAndReview() may also fire up to ~2 repair
// re-prompts (one generator, one reviewer) that each tick the shared counter via onRepair.
const REPAIR_HEADROOM_PER_GENERATE = 2;

// Derive the runaway BACKSTOP from the configured loop caps: the absolute ceiling above which the
// shared cycle counter assumes a true runaway (a compounding generate→review→fix→coverage spiral),
// NOT the symptom lever for tuning loop aggressiveness (that is Phases 3–4 — per-loop budgets).
// The legitimate worst-case sequence of generateAndReview() entries is:
//   initial(1) + static-fix loop(MAX_STATIC_FIX_ROUNDS) + exec-fix loop(maxRetries) + coverage-enforce(1)
// and each of those entries costs up to CYCLES_PER_GENERATE counter ticks plus
// REPAIR_HEADROOM_PER_GENERATE in-session repairs. So a default below this would TRUNCATE a
// legitimate run; the backstop sits exactly at the worst case so only a true runaway above it stops.
// Calibratable downward from Phase-0 agent-turn telemetry once real cycle distributions land.
//
// Whether a run's outcome should feed the learning flywheel's rule-distillation. A code-mode `fail`
// means the agent's generated test CORRECTLY caught a real bug — distilling a "fix this test" rule
// would teach the engine to weaken a test that did its job (Goodhart). Suppress distillation for that
// case ONLY; every other verdict (incl. `invalid` — broken generated tests, where the lesson is real)
// still feeds learning. e2e is unaffected.
export function shouldDistillLearning(isCode: boolean, verdict: RunVerdict): boolean {
  return !(isCode && verdict === "fail");
}

// Resolves the testIdAttribute from the app config, defaulting to "data-testid" when absent.
// The resolved value flows into PW_TEST_ID_ATTRIBUTE in capture and execute spawn envs.
// No app-specific name is hardcoded in src/ — it comes from config only.
export function resolveTestIdAttribute(config: { e2e?: { testIdAttribute?: string } }): string {
  return config.e2e?.testIdAttribute ?? "data-testid";
}

// Phase 6b: scope-dimensioned budget. When the planner yields multiple objectives, each objective
// is a legitimate unit of work (one agent session, one review). The base backstop covers a SINGLE
// objective's full loop sequence; multi-objective runs get an additive per-objective increment so the
// ceiling stays a TRUE backstop (never truncates legitimate work) while remaining meaningfully tighter
// than an unconstrained product. Each extra objective adds CYCLES_PER_GENERATE + REPAIR_HEADROOM_PER_GENERATE
// cycles (one session's max cost) — conservative and proportional without being multiplicative.
// numObjectives defaults to 1 (single-agent path): the backstop reduces to the original derivation.
export function deriveCycleBackstop(maxRetries: number, numObjectives = 1): number {
  const generateEntries = 1 + MAX_STATIC_FIX_ROUNDS + maxRetries + 1;
  const singleObjectiveBase = generateEntries * (CYCLES_PER_GENERATE + REPAIR_HEADROOM_PER_GENERATE);
  // Additional objectives each add one session's worth of budget (not the full loop sequence, since
  // worker sessions are bounded and do not go through the 4-loop generate→review→fix→coverage path).
  const extraObjectives = Math.max(0, numObjectives - 1);
  return singleObjectiveBase + extraObjectives * (CYCLES_PER_GENERATE + REPAIR_HEADROOM_PER_GENERATE);
}

export async function runPipeline(
  app: AppConfig,
  sha: string,
  deps: PipelineDeps,
  source: TriggerSource = "webhook",
  opts: RunOptions = { target: "e2e", mode: "diff" },
  onStep?: (step: string, detail?: string) => void,
  onCase?: (c: QaCase) => void,
  onSpecs?: (specs: Array<{ name: string; objective?: string; flow?: string }>) => void,
  signal?: AbortSignal,
  onRunningTest?: (title: string) => void,
  // Advisory: the independent reviewer's verdict for the live ReviewerCard. Fired
  // per review round; reasons are the actionable corrections on a rejection.
  onReviewer?: (approved: boolean, reasons: string[]) => void,
  // Advisory: change-coverage result for the live coverage component (the value keystone).
  onCoverage?: (changedLines: number, coveredLines: number) => void,
  // Advisory: each test the runner discovered up front → the live "next" preview.
  onTestDiscovered?: (name: string, file?: string) => void,
): Promise<QaRunResult> {
  const checkSignal = () => {
    if (signal?.aborted) throw new Error("run cancelled by operator");
  };
  const log = deps.log ?? (() => {});
  // Clock seam: use the injected clock when present (deterministic tests), otherwise Date.now().
  // Only the timing/guard code below uses `now()`. Unrelated Date.now() calls (e.g. genStart log
  // lines) are intentionally left as-is to minimise the change footprint.
  const now = deps.nowMs ?? (() => Date.now());
  const shadow = app.qa.shadow ?? false;
  const mode = opts.mode;
  const isCode = (opts.target ?? "e2e") === "code";
  // Cross-repo: a run whose triggering commit belongs to a declared service repo, not
  // to the primary. The service mirror provides diff/classify/gate; the primary mirror
  // (at baseBranch HEAD) hosts the suite, the execution, and the publish.
  const triggerService =
    opts.triggerRepo && opts.triggerRepo !== app.repo
      ? app.services?.find((s) => s.repo === opts.triggerRepo)
      : undefined;
  if (opts.triggerRepo && opts.triggerRepo !== app.repo && !triggerService) {
    throw new Error(`trigger repo ${opts.triggerRepo} is not a declared service of app ${app.name}`);
  }
  // Context mode is a whole-repo maintenance task driven from the primary repo; running it
  // against a service trigger would pass the service diff to the architecture-map builder
  // and contaminate the prompt with irrelevant signal.
  if (triggerService && opts.mode === "context") {
    throw new Error(`context mode cannot be triggered by a service repo (${triggerService.repo}); run it from the primary repo ${app.repo}`);
  }
  const issueRepo = triggerService ? triggerService.repo : app.repo;
  // Resolved once from config (mirrors PW_BASE_URL pattern): threaded into every execute + cleanup
  // spawn so PW_TEST_ID_ATTRIBUTE reaches the Playwright runner and getByTestId resolves correctly.
  const testIdAttribute = resolveTestIdAttribute(app);
  const reviewerCorrections: string[] = []; // accumulated across review rounds (for RunOutcome)
  let reviewerRationale: string | undefined; // the LAST round's reviewer reasoning (approve or reject)
  let retries = 0; // total regeneration attempts (review loop + failure retries)

  // Phase-timings: accumulate per-subphase wall-clock time (ms). Observation-only.
  const runStart = now();
  const phaseTimings: Record<string, number> = {};
  const softWarned = new Set<string>();
  // Advisory soft budgets per label (ms). Derived from agentTimeout-scale; log-only, zero control flow.
  const SOFT_BUDGET_MS: Record<string, number> = {
    generator: 5 * 60_000,
    reviewer: 3 * 60_000,
    validate: 2 * 60_000,
    execute: 5 * 60_000,
    explorer: 2 * 60_000,
    pack: 60_000,
    coverage: 2 * 60_000,
    oracle: 5 * 60_000,
  };
  // Accumulates timing per label; logs a one-time advisory when the cumulative time exceeds the
  // soft budget. No return, no throw, no control-flow change — a warning string only.
  const addTiming = (label: string, ms: number): void => {
    phaseTimings[label] = (phaseTimings[label] ?? 0) + ms;
    if (SOFT_BUDGET_MS[label] && phaseTimings[label]! > SOFT_BUDGET_MS[label]! && !softWarned.has(label)) {
      softWarned.add(label);
      log(`[qa] [timing] WARNING: phase '${label}' exceeded soft budget (${Math.round(phaseTimings[label]! / 1000)}s > ${Math.round(SOFT_BUDGET_MS[label]! / 1000)}s) — advisory only, not aborting`);
    }
  };

  // Phase 6a: shared iteration ceiling. One counter shared across all four regeneration loops
  // (review for-loop, static-fix while, exec-fix for-loop, coverage-enforce if) plus the two
  // in-session contract-repair re-prompts (generator and reviewer). A single ceiling is simpler
  // and fairer than per-loop caps: a run that spends budget in the static-fix loop gets fewer
  // remaining cycles in the exec-fix loop, which is the correct behaviour.
  //
  // NOTE: generateParallel workers are intentionally NOT counted here. Workers run in
  // fire-and-join parallel sessions bounded by OPENCODE_TIMEOUT_MS, not by iterated loops.
  // Counting them would require coordinating across goroutines and would double-penalise
  // large-PR fan-out runs. The ceiling covers only the main-agent sequential path.
  //
  // Default ceiling: a runaway BACKSTOP derived from the configured loop caps (NOT a flat 12,
  // which truncated a legitimate worst-case run with maxRetries=5). The default sits exactly at
  // the legitimate worst case — initial + static-fix + exec-fix + coverage-enforce generateAndReview
  // entries, each costing review-round + repair headroom — so only a TRUE runaway above it is cut.
  // This is the safety backstop, not the symptom lever (per-loop budgets are Phases 3–4); it is
  // calibratable downward from Phase-0 telemetry. Apps can still override via qa.iterationBudget.
  // Phase 6b: let so it can be retroactively dimensioned by objectiveCount from the first generate.
  let MAX_CYCLES = app.qa.iterationBudget ?? deriveCycleBackstop(app.qa.fixLoop?.maxRetries ?? 2);
  // Wall-clock ceiling: derived from MAX_CYCLES * per-session timeout (errs large — conservative outer
  // bound). Override via qa.wallClockBudgetMs (wins unconditionally — never recomputed). Declared as
  // `let` so the Phase-6b fan-out bump below can recompute it when MAX_CYCLES is raised (a
  // 5-objective run gets a proportionally higher ceiling than a 1-objective run).
  let wallClockBudget = app.qa.wallClockBudgetMs ?? (MAX_CYCLES * agentTimeout(mode));
  let cycleCount = 0; // incremented BEFORE every generateAndReview() + before each repair re-prompt
  let retrievedRuleIds: string[] = []; // rule IDs retrieved for this run (for RunOutcome)
  let retrievedRules: LearningRule[] = []; // full retrieved rules (errorClass needed for governance)
  let curriculum: ReturnType<typeof initCurriculum> | null = null; // persisted across runs
  // Per-run usage accumulator — sums token/cost snapshots from every agent call.
  // Observation-only: never influences verdict, blocksPublish, or control flow.
  const usage = createUsageAccumulator();
  // complete = true iff both primary and reviewer are opencode (full picture).
  // false when dual (only OpenCode roles fire) or config is absent.
  const pipelineAgentConfig = deps.agentRuntimeConfig;
  const usageComplete =
    pipelineAgentConfig?.assignments.primary.provider === "opencode" &&
    pipelineAgentConfig?.assignments.reviewer.provider === "opencode";
  // Provider attribution persisted on RunUsage so a Codex run is attributable without
  // relying on a caller to re-derive it from config. Absent when no runtime config is known.
  const usageAttribution = pipelineAgentConfig
    ? {
        primaryProvider: pipelineAgentConfig.assignments.primary.provider,
        reviewerProvider: pipelineAgentConfig.assignments.reviewer.provider,
      }
    : undefined;

  const persistOutcome = (verdict: QaRunResult, overrides?: { staticOk?: boolean; coverageRatio?: number | null; valueScore?: number | null; rulesRetrieved?: string[]; confinement?: ConfinementResult; usage?: RunUsage; phaseTimings?: Record<string, number> }) => {
    if (!deps.saveOutcome || !opts.runId) return;
    const outcome = labelRunOutcome({
      runId: opts.runId,
      app: app.name,
      sha,
      mode,
      target: opts.target ?? "e2e",
      verdict: verdict.verdict,
      staticOk: overrides?.staticOk ?? false,
      coverageRatio: overrides?.coverageRatio ?? null,
      minCoverageRatio: app.qa.changeCoverage?.minRatio ?? DEFAULT_COVERAGE_POLICY.minRatio,
      reviewerCorrections,
      reviewerRationale,
      reviewerApproved: app.qa.needsReview && result ? result.approved : null,
      flaky: verdict.verdict === "flaky",
      retries,
      valueScore: overrides?.valueScore ?? null,
    });
    if (overrides?.valueScore !== undefined) {
      outcome.gateSignals.valueScore = overrides.valueScore;
    }
    if (overrides?.rulesRetrieved) {
      outcome.rulesRetrieved = overrides.rulesRetrieved;
    }
    if (overrides?.confinement !== undefined) {
      outcome.gateSignals.confinement = overrides.confinement;
    }
    if (overrides?.usage !== undefined) {
      outcome.gateSignals.usage = overrides.usage;
    }
    if (overrides?.phaseTimings !== undefined) {
      outcome.gateSignals.phaseTimings = overrides.phaseTimings;
    }
    // W1/W2 observation-only counts (read from the run-level accumulators, like `result` above; never
    // affect the verdict). Recorded on every outcome so the §9 catch/block rate is queryable.
    outcome.gateSignals.preExecAmbiguityCatches = preExecAmbiguityCatches;
    outcome.gateSignals.deterministicSelectorBlocks = deterministicSelectorBlocks;
    deps.saveOutcome(outcome).catch((err) => {
      log(`[qa] WARNING: failed to persist RunOutcome (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  log(
    `[qa] app=${app.name}  sha=${sha}  mode=${mode}  target=${isCode ? "code" : "e2e"}  (${source})` +
      (shadow ? "  [SHADOW MODE]" : ""),
  );

  // 1. Gate: wait until DEV runs this SHA and is healthy. Skipped for code mode (no
  //    web environment), context mode (builds from source only), and when no version
  //    endpoint is configured (already deployed).
  //    STARTED here but AWAITED only after classification (step 4): the gate is pure
  //    network waiting, while prepare/classify/setup are local — overlapping them saves
  //    up to the whole deploy wait, and a skip-classified commit never waits for DEV.
  const versionUrl = (isCode || mode === "context") ? undefined : app.dev?.versionUrl;
  const devHealthy = () => (versionUrl ? deps.isHealthy(versionUrl) : Promise.resolve(true));
  // Generic reachability probe for the feedback gate. versionUrl apps use the /version health
  // contract (same as the health pre-flight). Apps without versionUrl use a bare fetch against
  // baseUrl — any HTTP response (even 4xx/5xx) means DEV is UP; only a network failure/timeout
  // means unreachable. Falls back to true only when there is no URL at all (no-dev apps are
  // excluded from the feedback block by the !!app.dev?.baseUrl guard already).
  const devReachable = () => (versionUrl ? deps.isHealthy(versionUrl) : (app.dev?.baseUrl ? deps.isReachable(app.dev.baseUrl) : Promise.resolve(true)));
  const gateAbort = new AbortController();
  if (signal) signal.addEventListener("abort", () => gateAbort.abort(), { once: true });
  const gatePromise: Promise<void> = (async () => {
    if (isCode) {
      log("[qa] code mode: no web environment; skipping the deploy gate and health checks.");
    } else if (triggerService) {
      if (triggerService.versionUrl) {
        log(`[qa] waiting for ${triggerService.repo} to serve ${sha} on DEV...`);
        await deps.waitForDeploy(
          {
            name: `${app.name}/${triggerService.repo}`,
            versionUrl: triggerService.versionUrl,
            pollIntervalMs: triggerService.pollIntervalMs ?? 10_000,
            deployTimeoutMs: triggerService.deployTimeoutMs ?? 600_000,
          },
          sha,
          gateAbort.signal,
        );
      } else {
        log(`[qa] deploy-event trigger from ${triggerService.repo} without versionUrl; trusting the event (gate skipped).`);
      }
    } else if (versionUrl && app.dev) {
      const target: DeployTarget = {
        name: app.name,
        versionUrl,
        pollIntervalMs: app.dev.pollIntervalMs ?? 10_000,
        deployTimeoutMs: app.dev.deployTimeoutMs ?? 600_000,
      };
      log("[qa] waiting for a stable deploy on DEV...");
      await deps.waitForDeploy(target, sha, gateAbort.signal);
    } else {
      log("[qa] no version endpoint configured; skipping the deploy gate.");
    }
  })();
  // The gate is observed at the Promise.all below; this extra handler only prevents an
  // unhandled rejection when a local step throws (or a skip returns) before that await.
  gatePromise.catch(() => {});

  // 2. Working copy of the repo at the SHA (the agent's cwd, holds `e2e/`) + diff + message.
  log("[qa] preparing working copy and diff...");
  let mirrorDir: string;
  let diff: string;
  let message: string;
  let serviceMirrorDir: string | undefined;
  if (triggerService) {
    const svc = await deps.prepare(triggerService.repo, sha);
    serviceMirrorDir = svc.mirrorDir;
    diff = svc.diff;
    message = svc.message;
    mirrorDir = (await deps.prepareAtBranch(app.repo, app.baseBranch ?? "main")).mirrorDir;
  } else {
    // commits>1 widens the diff window — only meaningful in diff mode (the others scan the
    // whole repo, not a commit's blast radius).
    const commits = mode === "diff" ? opts.commits : undefined;
    ({ mirrorDir, diff, message } = await deps.prepare(app.repo, sha, commits, opts.baseSha));
  }
  const e2eDir = join(mirrorDir, E2E_DIR);
  const ns = testDataNamespace(app.qa.testDataPrefix, sha, opts.runId);

  // Write-confinement guard, run on EVERY post-generation exit: green (after the LAST generation,
  // i.e. past any coverage-enforce regen), the agent no-op skip, static-gate invalid/infra-error,
  // health pre-flight, the no-dev infra exit, and both context exits (publish success + invalid).
  // The pre-generation classify-skip exit does NOT run it (nothing ran, nothing to revert). Detects
  // out-of-area writes that git status surfaces and reverts them (a symlink escape is detected + its
  // link entry reverted — any external file written THROUGH it is NOT un-written). NON-BLOCKING: it
  // never changes the verdict; git errors THROW (not swallowed). Each caller invokes it exactly ONCE
  // on its own exit (no caching → no double-run). Absent dep ⇒ undefined (guard disabled).
  const runConfine = async (): Promise<ConfinementResult | undefined> => {
    if (!deps.confine) return undefined;
    const result = await deps.confine(mirrorDir, isCode);
    if (result.strays > 0) {
      if (result.dangerous > 0)
        log(`[qa] SECURITY: confinement reverted ${result.strays} out-of-area change(s), ${result.dangerous} DANGEROUS (secret/path-escape): ${result.reverted.join(", ")}`);
      else
        log(`[qa] confinement: reverted ${result.strays} out-of-area change(s): ${result.reverted.join(", ")}`);
    }
    return result;
  };

  checkSignal();

  // 3. Classify the commit (Conventional Commits, cross-checked against the diff)
  //    — ONLY in "diff" mode. Other modes (complete/exhaustive/manual/context) are
  //    whole-repo or guided tasks, so they always generate.
  let generating = true;
  let intent: CommitIntent | undefined;

  // A human-in-the-loop continuation always generates (the human marked failing
  // tests to fix); it never takes the "skip" path.
  const isContinuation = (opts.fixCases?.length ?? 0) > 0;
  if (isContinuation) {
    log(`[qa] continuation of ${opts.parentRunId ?? "?"}: fixing ${opts.fixCases!.length} case(s) with human guidance.`);
  }

  if (mode === "diff") {
    onStep?.("classify");
    const cls = classifyCommit(message, diff);
    log(`[qa] commit '${cls.type}' → ${cls.action}${cls.contradiction ? " (message/diff contradiction)" : ""}: ${cls.reason}`);
    if (cls.action === "skip" && !isContinuation) {
      log(`[qa] no testable objective (${cls.type}); nothing to run.`);
      gateAbort.abort(); // stop the background deploy-gate poll: this run never needed DEV
      return { sha: ns, verdict: "skipped", passed: true, cases: [], logs: cls.reason };
    }
    generating = isContinuation || cls.action === "generate";
    intent = cls;
  } else {
    log(`[qa] mode=${mode}: whole-repo/guided run (commit classification skipped).`);
  }

  // The PROMPT-facing diff is size-capped once here; every LLM consumer (generator, planner,
  // reviewer, regeneration rounds) receives this bounded form. Local consumers (the classifier
  // above, parseDiffHunks for oracle scoping) keep the raw diff — they are free. Change-coverage
  // is NOT one of them: it parses promptDiff (FIX 8a) so its denominator matches the lines the
  // agent actually saw.
  const promptDiff = capDiff(diff);
  if (promptDiff.length < diff.length) {
    log(`[qa] diff capped for prompts: ${diff.length} → ${promptDiff.length} chars (full diff stays available in the working copy).`);
  }

  // Slice 1 (agent-grounding-change-anchor): extract stable HTML selector signals from the diff
  // (or guidance noun-phrases in MANUAL mode) ONCE, then thread to BOTH grounding chains as an
  // optional parameter. Computed from promptDiff so file/line numbering is consistent with
  // parseDiffHunks usage below. Cap 200 entries (mirrors change-coverage MAX_ITEMS spirit).
  // Absent/empty → both chains produce byte-identical output to today (no annotation).
  const changedElements: ChangedElement[] =
    mode === "manual"
      ? changedElementsFromGuidance(opts.guidance ?? "")
      : (mode === "diff" ? extractChangedElements(promptDiff) : []);

  // 4. Set up the project so the agent has what it needs to build on — IN PARALLEL with
  //    the deploy gate started in step 1 (dependency install needs no DEV). e2e: bootstrap
  //    the seed if missing + install the e2e deps. code: install the repo's own deps
  //    so its test suite can run. context: same as e2e (the agent writes into e2e/.qa/).
  if (isCode) log("[qa] code mode: installing the repo's dependencies...");
  const setupPromise = isCode ? deps.setupCode(mirrorDir, { signal }) : deps.setupE2e(e2eDir);
  setupPromise.catch(() => {}); // observed at the Promise.all; avoids an unhandled rejection if the gate throws first
  try {
    await Promise.all([gatePromise, setupPromise]);
  } catch (err) {
    gateAbort.abort(); // setup failed first → don't leave the gate polling in the background
    throw err;
  }

  const loadContextMap = (): ArchitectureContext | undefined => {
    const ctxJsonPath = join(e2eDir, ".qa", "context.json");
    if (!existsSync(ctxJsonPath)) return undefined;
    try {
      const raw = JSON.parse(readFileSync(ctxJsonPath, "utf8"));
      const v = validateContext(raw);
      if (v.ok) {
        const map = raw as ArchitectureContext;
        log(`[qa] loaded architecture map: ${map.routes.length} routes, ${map.api.length} api ops, ${map.feBe?.length ?? 0} links`);
        return map;
      }
      log(`[qa] WARNING: context.json exists but is invalid (${v.errors.join("; ")}); regenerating the architecture context before test generation.`);
      return undefined;
    } catch {
      log("[qa] WARNING: could not parse context.json; regenerating the architecture context before test generation.");
      return undefined;
    }
  };

  const buildContextMap = async (publish: boolean): Promise<{ run?: QaRunResult; contextMap?: ArchitectureContext }> => {
    log(publish ? "[qa] context mode: building the FE↔BE architecture map..." : "[qa] context bootstrap: building missing/stale FE↔BE architecture map...");
    onStep?.("generate");

    // Mirror every declared service (read-only). The agent uses these working copies to
    // extract each service's OpenAPI operations into the unified context map.
    let serviceRefs: GenerateInput["services"];
    if (app.services?.length) {
      serviceRefs = [];
      for (const svc of app.services) {
        log(`[qa] context: mirroring service ${svc.repo}...`);
        const m = await deps.prepareAtBranch(svc.repo, svc.baseBranch ?? "main");
        serviceRefs.push({ repo: svc.repo, mirrorDir: m.mirrorDir, openapi: svc.openapi });
      }
    }

    const genInput: GenerateInput = {
      repo: app.repo,
      sha,
      diff,
      mirrorDir,
      namespace: ns,
      needsReview: false,
      mode: "context",
      appName: app.name,
      baseUrl: app.dev?.baseUrl,
      openapi: app.openapi,
      services: serviceRefs,
    };
    const ctxResult = await deps.generate(genInput, signal, log, usage.add.bind(usage));

    log(`[qa] context agent: approved=${ctxResult.approved} specs=[${ctxResult.specs.join(", ")}]`);

    const ctxPath = join(e2eDir, ".qa", "context.json");
    let raw: unknown = null;
    let parseError: string | null = null;
    if (existsSync(ctxPath)) {
      // A malformed context.json from the agent must yield a clean `invalid` verdict + Issue,
      // not an unhandled exception that crashes the run.
      try { raw = JSON.parse(readFileSync(ctxPath, "utf8")); }
      catch (err) { parseError = `context.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`; }
    }
    const validated = parseError
      ? { ok: false, errors: [parseError] }
      : deps.validateContextFn
        ? deps.validateContextFn(raw ?? {})
        : raw
          ? validateContext(raw)
          : { ok: false, errors: ["context.json was not produced by the agent"] };

    if (!validated.ok) {
      // ROOT-CAUSE (#6): in BOOTSTRAP (publish=false) the architecture map is an OPTIMIZATION that
      // informs generation — NOT the test artifact and NOT a correctness gate. A map the agent
      // could not build perfectly (e.g. one flow with no routes, like a disabled GenAI chat) must
      // NEVER fail the actual QA run: that conflates "couldn't draw a perfect map" with "the tests
      // are invalid". Degrade gracefully — log and proceed WITHOUT the map (the caller already
      // continues when no map is returned). Only explicit `context` mode (publish=true), where the
      // map IS the deliverable, fails with an Issue.
      if (!publish) {
        log(
          `[qa] WARNING: context bootstrap produced an INVALID map (${validated.errors.join("; ")}) — ` +
            `continuing WITHOUT architecture context. The map is an optimization, not a gate; generation proceeds.`,
        );
        return { run: undefined };
      }
      log(`[qa] context validation failed:\n${validated.errors.join("\n")}`);
      // Post-generation exit (publish=true): the context agent ran, so revert any out-of-area
      // strays before returning, consistent with the success path's confine-before-publish — the
      // guarantee is that EVERY post-generation context exit reverts strays. Non-blocking.
      await runConfine();
      await issueOrShadow(
        shadow, deps, log, app.repo,
        `QA context map for ${sha} is invalid`,
        renderIssue(resultOf(ns, "invalid", validated.errors.join("\n\n")), {
          note: `The FE↔BE context map could not be validated.\n${validated.errors.join("\n")}`,
        }),
      );
      return { run: resultOf(ns, "invalid", validated.errors.join("\n\n")) };
    }

    log(`[qa] context map validated: OK`);

    // Advisory: warn for any configured service whose operations were not mapped
    // (its OpenAPI was not found or not extracted). Cross-repo runs for it will
    // lack the context map. Never fails the run — the map is structurally valid.
    if (app.services?.length && deps.readBuiltContext) {
      const built = deps.readBuiltContext(e2eDir);
      const mapped = new Set((built?.api ?? []).map((o) => o.service).filter(Boolean));
      for (const svc of app.services) {
        if (!mapped.has(svc.repo)) {
          log(`[qa] WARNING: the context map has no operations for service ${svc.repo} — its OpenAPI was not found or not extracted. Cross-repo runs for it will lack the map.`);
        }
      }
    }

    if (!publish) {
      log("[qa] context bootstrap complete; continuing with the requested QA mode.");
    } else if (shadow) {
      log("[qa] (shadow) context map built; a PR would have been opened.");
    } else {
      // Confinement BEFORE the context PR: the context agent just ran, so revert any out-of-area
      // strays it wrote so they are not swept into the published context.json PR. Non-blocking.
      await runConfine();
      const pr = await deps.publishContext({ repo: app.repo, sha, mirrorDir, baseBranch: app.baseBranch ?? "main" });
      log(pr
        ? pr.merged
          ? `[qa] OK — context map merged: ${pr.prUrl}`
          : `[qa] OK — context map PR opened (merge it manually): ${pr.prUrl}`
        : "[qa] OK — context map built (no changes to publish).");
    }

    return { run: publish ? resultOf(ns, "pass", "context map built and validated") : undefined, contextMap: deps.readBuiltContext?.(e2eDir) ?? loadContextMap() };
  };

  // ── context mode: build the FE↔BE architecture map ──────────────────────────
  // Diverges early: the agent builds context.json from structured sources (routing,
  // OpenAPI, generated clients), we validate it deterministically, and publish via PR.
  // No tests are generated or executed — this is a maintenance task.
  if (mode === "context") {
    const built = await buildContextMap(true);
    return built.run ?? resultOf(ns, "pass", "context map built and validated");
  }

  // 4a. Clean up orphaned test data from a previous INTERRUPTED run (crash, SIGKILL,
  //     docker restart) before this run creates new data. Best-effort: it never throws
  //     and never blocks the new run. Only applies to e2e (code mode has no web data).
  if (opts.previousNamespace && !isCode && app.dev?.baseUrl) {
    log(`[qa] cleaning up orphaned data from interrupted run (namespace ${opts.previousNamespace})...`);
    await deps.cleanup(e2eDir, { baseUrl: app.dev.baseUrl, namespace: opts.previousNamespace, testIdAttribute }).catch((err) => {
      log(`[qa] cleanup warning (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // Load the FE↔BE architecture map if it exists. This cross-cutting context is
  // injected into the agent prompt for ALL generation modes (diff, complete,
  // exhaustive, manual) so the agent crosses the frontend→backend boundary without
  // re-deriving the architecture from raw code on every run. Context mode is the
  // producer of this map; all other modes are consumers.
  let contextMap: ArchitectureContext | undefined = loadContextMap();
  if (!isCode && generating && !triggerService) {
    let refreshReason = contextMap ? "" : "missing or invalid context map";
    if (contextMap && deps.checkContextStaleness) {
      const staleWarn = await deps.checkContextStaleness(mirrorDir, sha);
      if (staleWarn) refreshReason = staleWarn;
    }
    // The process-audit context-heal sets a DB-backed staleness flag (the mirror file write would
    // be wiped by the run's git checkout/clean, so it can't). Consume it here — one-shot — and force
    // a rebuild even if the map looks current on disk. Best-effort: a flag-store error never blocks.
    try {
      const { consumeContextStale } = await import("./server/history");
      if (consumeContextStale(app.name)) refreshReason = "operator/process-audit invalidated the map";
    } catch { /* best-effort */ }
    if (refreshReason) {
      // Before paying the ~195s agent rebuild, try the persistent cache. The mirror is git-cleaned
      // each run, so a map built on a PRIOR run of THIS exact sha is gone from disk but still cached.
      // Restore it deterministically (no agent). ONLY for the "missing map" case AND when it was built
      // from this exact sha — a staleness/invalidation reason must genuinely rebuild, and a same-sha
      // map cannot be stale.
      // Restored from cache? Gate the rebuild on THIS, not on whether a map is in memory — a STALE
      // refresh has a (stale) map loaded but must still rebuild.
      let restored = false;
      const cached = refreshReason.startsWith("missing") && deps.loadContextCache ? deps.loadContextCache(app.name) : undefined;
      if (cached && cached.builtAtSha === sha && validateContext(cached).ok) {
        try {
          mkdirSync(join(e2eDir, ".qa"), { recursive: true });
          writeFileSync(join(e2eDir, ".qa", "context.json"), JSON.stringify(cached));
          contextMap = cached;
          restored = true;
          log(`[qa] context bootstrap: restored the cached architecture map (built at ${sha.slice(0, 7)}) — skipped the ~195s rebuild.`);
        } catch (err) {
          log(`[qa] WARNING: could not restore cached context map (${err instanceof Error ? err.message : String(err)}); rebuilding.`);
        }
      }
      if (!restored) {
        log(`[qa] context bootstrap needed: ${refreshReason}`);
        const built = await buildContextMap(false);
        if (built.run) return built.run;
        contextMap = built.contextMap;
        if (contextMap) deps.saveContextCache?.(app.name, contextMap); // persist for the next same-sha run
        if (!contextMap) log("[qa] WARNING: context bootstrap finished but the map could not be reloaded; continuing without architecture context.");
      }
    }
  }

  // Generate, then run the INDEPENDENT reviewer as a bounded feedback loop. The reviewer is a
  // SEPARATE qa-reviewer session (not the generator's subagent), so its verdict is genuinely
  // independent and AUTHORITATIVE — it breaks the circular quality loop documented in AGENTS.md.
  // On rejection, the reviewer's actionable corrections are reinjected and the agent regenerates
  // (up to MAX_REVIEW_ROUNDS) BEFORE giving up; only then is the result marked not-approved
  // (→ Issue). A reviewer error or unparseable verdict FAILS CLOSED (not-approved → Issue):
  // nothing publishes without an actual independent review.
  // Disk over the agent's word (CLAUDE.md: never trust the LLM's self-report over the
  // working copy). The no-op decision and the reviewer's file list both key off `specs`,
  // so they must reflect the *.spec.ts actually on disk, not what the agent printed in its
  // verdict JSON. e2e-only; a non-blocking failure falls back to the agent's report.
  const reconcileSpecs = async (r: AgentResult): Promise<AgentResult> => {
    if (isCode || !deps.listChangedSpecs) return r;
    let onDisk: string[];
    try {
      onDisk = await deps.listChangedSpecs(mirrorDir, E2E_DIR);
    } catch (err) {
      log(`[qa] spec reconciliation failed (non-blocking, trusting the agent): ${err instanceof Error ? err.message : String(err)}`);
      return r;
    }
    const onDiskSet = new Set(onDisk);
    const reportedSet = new Set(r.specs);
    const phantom = r.specs.filter((s) => !onDiskSet.has(s));
    const unreported = onDisk.filter((s) => !reportedSet.has(s));
    if (phantom.length) log(`[qa] WARNING: the agent reported ${phantom.length} spec(s) not on disk (${phantom.join(", ")}); using the on-disk set.`);
    if (unreported.length) log(`[qa] note: ${unreported.length} on-disk spec(s) the agent did not report (${unreported.join(", ")}); including them.`);
    return { ...r, specs: onDisk };
  };

  // MAX_REVIEW_ROUNDS and MAX_STATIC_FIX_ROUNDS are module-level constants (the same source of
  // truth the runaway-backstop derivation reads). The static-gate repair budget (Filter B) mirrors
  // the execution fix-loop: a trivial tsc/eslint/list error should get a bounded second chance, not
  // fail the whole run on the first miss.

  // Phase 6a: the shared cycle counter callback — wired as onRepair into every deps.generate()
  // and deps.review() call so that in-session contract-repair re-prompts increment cycleCount.
  // The counter itself is declared above alongside `retries`.
  const onRepair = () => {
    cycleCount++;
    log(`[qa] cycle-counter: in-session repair re-prompt (cycleCount=${cycleCount}/${MAX_CYCLES})`);
  };

  // RE-3: the run-scoped generator session (opt-in via qa.sessionContinuity). Opened lazily by the
  // first generateOnce, REUSED across cycles (the fix-loop continues it), and disposed before the
  // decide step. The real impl also self-disposes after a deadline, covering early-return/throw paths.
  let genSession: GeneratorSession | null = null;

  const generateOnce = async (genInput: GenerateInput): Promise<AgentResult> => {
    // Wall-clock ceiling guard (mirrors the cycle-ceiling below at the same choke point).
    // Checked FIRST so a timed-out run does not even tick the cycle counter. Returns a neutral
    // AgentResult identical in semantics to the cycle-ceiling return — "return current state".
    // This guard is STRUCTURALLY INCAPABLE of aborting an in-flight deps.execute or deps.review:
    // those awaits live OUTSIDE generateOnce, and the guard only fires at ENTRY.
    if (now() - runStart > wallClockBudget) {
      log(`[qa] [timing] wall-clock budget reached (${Math.round((now() - runStart) / 1000)}s > ${Math.round(wallClockBudget / 1000)}s): not starting another generation; returning current state.`);
      return { output: "", specs: [], reviewed: false, approved: false, note: `wall-clock budget exhausted (${Math.round(wallClockBudget / 1000)}s)` };
    }
    // Phase 6a: count this invocation toward the shared iteration budget BEFORE spending any
    // tokens. The ceiling check happens at every generateAndReview() call-site AND here for the
    // review-round internal re-generation. A ceiling hit returns the current state immediately
    // with a log — no silent stop.
    cycleCount++;
    if (cycleCount > MAX_CYCLES) {
      log(`[qa] cycle-ceiling reached (cycleCount=${cycleCount - 1}/${MAX_CYCLES}): skipping this generateAndReview call and returning current state.`);
      // Return a neutral result: no specs, not approved, with an explanatory note.
      return { output: "", specs: [], reviewed: false, approved: false, note: `iteration budget exhausted (maxCycles=${MAX_CYCLES})` };
    }
    log(`[qa] cycle-counter: generateAndReview invocation (cycleCount=${cycleCount}/${MAX_CYCLES})`);

    const genStart = Date.now();
    // RE-3: route through a CONTINUED session when enabled — open lazily, then each cycle continues
    // the SAME session (a short follow-up) instead of re-orienting a fresh agent. Any open error
    // falls back to the fresh-session path so continuity can never break a run.
    let raw: AgentResult;
    if (app.qa.sessionContinuity && deps.openGenerator && generating) {
      if (!genSession) {
        genSession = await deps
          .openGenerator(genInput, { signal, onProgress: log, onUsage: usage.add.bind(usage), onRepair })
          .catch((e) => {
            log(`[qa] session-continuity unavailable (${e instanceof Error ? e.message : String(e)}); using fresh-session generation.`);
            return null;
          });
      }
      raw = genSession
        ? await genSession.generate(genInput)
        : await deps.generate(genInput, signal, log, usage.add.bind(usage), onRepair);
    } else {
      raw = await deps.generate(genInput, signal, log, usage.add.bind(usage), onRepair);
    }
    let r = await reconcileSpecs(raw);
    log(`[qa] [timing] generation produced ${r.specs.length} spec(s) in ${Math.round((Date.now() - genStart) / 1000)}s`);
    addTiming("generator", Date.now() - genStart);
    return r;
  };

  const reviewGenerated = async (
    initial: AgentResult,
    genInput: GenerateInput,
    reviewOpts: { allowRegeneration: boolean },
    // D4/D5: the feedback execute result (pre-reviewer run). When present and verdict is "fail",
    // the orchestrator applies an !executedRed override on round 0 to prevent the circular-approval
    // hole (#669): a reviewer LLM that receives evidence of a red spec must not be allowed to
    // approve it, even if the model returns approved:true. This is a deterministic orchestrator
    // gate — mirrors the fail-closed `return {...r, approved:false}` precedents at :1512/:1524.
    // Round-0-only: after the internal mid-loop regen at :1589, `r` is a fresh unexecuted spec
    // and the evidence is stale, so the override MUST NOT fire on round >= 1.
    executionEvidence?: { verdict: string; cases: QaCase[] },
  ): Promise<AgentResult> => {
    let r = initial;
    if (!(app.qa.needsReview && deps.review)) return r;
    // The live-DOM grounding only depends on the ROUTES the specs target, so capture it once and
    // reuse it across review rounds — re-launching a browser every round (up to MAX_REVIEW_ROUNDS)
    // is wasted cost when the spec set (hence the routes) is unchanged. Recompute only when the
    // regenerated spec set differs.
    let domSnapshot: string | undefined;
    let lastSpecsKey = "";
    // Phase 4: track the prior-round corrections to thread into the NEXT review call so the
    // reviewer can converge (approve once BLOCKING issues are resolved; skip new nits on
    // unchanged specs). Initialized to undefined (no prior corrections on round 0).
    let previousRoundCorrections: string[] | undefined;
    for (let round = 0; round < MAX_REVIEW_ROUNDS; round++) {
      if (r.specs.length === 0) {
        // A FIRST-round empty result is a legitimate no-op. A LATER (post-rejection)
        // regeneration with no specs was never judged by the reviewer — it must NOT inherit
        // the generator's self-approval, or unreviewed work could skip green.
        return round === 0 ? r : { ...r, approved: false, note: "regeneration produced no reviewable specs" };
      }
      let review: ReviewResult;
      const reviewStart = Date.now();
      // Ground the reviewer in the LIVE DEV DOM (the routes these specs target) so it judges UI
      // facts against reality, not training memory. Best-effort, e2e only, never blocks the review.
      // Memoized by the spec set across rounds: re-capture only when the regenerated specs changed.
      if (!isCode && deps.captureDom && app.dev?.baseUrl) {
        const specsKey = r.specs.slice().sort().join(",");
        if (specsKey !== lastSpecsKey) {
          const specContents = r.specs.map((s) => {
            try { return readFileSync(join(mirrorDir, E2E_DIR, s), "utf8"); } catch { return ""; }
          });
          domSnapshot = await deps.captureDom({ e2eDir, baseUrl: app.dev.baseUrl, specContents, testIdAttribute }).catch(() => undefined);
          lastSpecsKey = specsKey;
        }
      }
      // D4/D5: render execution evidence for the reviewer prompt (round 0 only).
      // After the internal mid-loop regen at :1589, the spec is fresh and has not been
      // executed — the evidence is stale and MUST NOT be injected on round >= 1.
      // Best-effort: absent or empty evidence means no section is injected (no-op).
      const fbExecResult: string | undefined =
        round === 0 && executionEvidence && executionEvidence.cases.length > 0
          ? renderExecutionResult({
              verdict: executionEvidence.verdict,
              cases: executionEvidence.cases.map((c) => ({
                name: c.name,
                httpStatus: c.httpStatus,
                finalUrl: c.finalUrl,
              })),
            })
          : undefined;
      try {
        review = await deps.review(
          // Arm the independent judge with the PROVEN learned rules (active only — never unproven
          // candidates) so it enforces app-specific anti-patterns earned from past failures.
          // Phase 0b: thread runId + objective so the reviewer's agent_turns row carries a
          // non-null run_id, enabling per-role telemetry on the reviewer's turns.
          // Phase 4: thread priorCorrections so the reviewer can converge across rounds.
          // D4/D5: thread executionResult (sanitized HTTP evidence) on round 0 only.
          {
            diff: promptDiff, specs: r.specs, mirrorDir, e2eRelDir: isCode ? "" : E2E_DIR,
            baseUrl: app.dev?.baseUrl, intent, guidance: opts.guidance, appName: app.name,
            mode, target: opts.target, learnedRules: renderRulesForReviewer(retrievedRules),
            domSnapshot,
            runId: opts.runId,
            objective: opts.guidance ?? intent?.message,
            ...(previousRoundCorrections ? { priorCorrections: previousRoundCorrections } : {}),
            ...(fbExecResult ? { executionResult: fbExecResult } : {}),
          },
          signal,
          usage.add.bind(usage),
          onRepair,
        );
      } catch (err) {
        // FAIL CLOSED: the reviewer is the only independent gate against the circular
        // self-approval loop. A reviewer outage must never silently degrade every run to
        // generator-self-approval — green-but-unreviewed work reports as not-approved
        // (→ Issue, nothing lands in the app repo) until the reviewer is back.
        consecutiveReviewerFailures++;
        if (consecutiveReviewerFailures >= 3) {
          log(`[qa] CRITICAL: independent reviewer has FAILED ${consecutiveReviewerFailures} consecutive times — REVIEWER OUTAGE DETECTED. Runs are failing closed (no publish without review).`);
        } else {
          log(`[qa] WARNING: independent reviewer FAILED — failing closed: this run will not publish without independent review (${err instanceof Error ? err.message : String(err)}).`);
        }
        addTiming("reviewer", Date.now() - reviewStart);
        return { ...r, approved: false, note: "independent review unavailable (reviewer error) — not publishing unreviewed tests" };
      }
      // A parse miss is NOT an actionable rejection: feeding the synthetic correction back
      // just burns a round and re-hits the same miss. Treat it like a reviewer error (fail closed).
      if (review.parsed === false) {
        consecutiveReviewerFailures++;
        if (consecutiveReviewerFailures >= 3) {
          log(`[qa] CRITICAL: independent reviewer has produced NO parseable verdict ${consecutiveReviewerFailures} consecutive times — REVIEWER OUTAGE DETECTED.`);
        } else {
          log(`[qa] WARNING: independent reviewer produced NO parseable verdict — failing closed (not burning a regeneration round).`);
        }
        addTiming("reviewer", Date.now() - reviewStart);
        return { ...r, approved: false, note: "independent review unavailable (unparseable reviewer verdict) — not publishing unreviewed tests" };
      }
      // Reset counter on successful reviewer response
      consecutiveReviewerFailures = 0;
      // Phase 4: the gate passes when zero BLOCKING corrections remain, regardless of advisory count.
      // A correction without an explicit severity (plain string) is treated as blocking — fail-closed.
      // `blockingCount` is absent on pre-Phase-4 verdicts and parse misses; treat absent as "all blocking".
      const blockingCount = review.blockingCount ?? review.corrections.length;
      const advisoryCount = review.corrections.length - blockingCount;
      log(
        `[qa] independent reviewer round ${round + 1}/${MAX_REVIEW_ROUNDS}: approved=${review.approved}` +
        ` corrections=${review.corrections.length} (blocking=${blockingCount}, advisory=${advisoryCount})` +
        ` (${Math.round((Date.now() - reviewStart) / 1000)}s)`,
      );
      addTiming("reviewer", Date.now() - reviewStart);
      if (review.rationale) reviewerRationale = review.rationale; // the verdict that ultimately decides this run
      // Phase 4 + FIX 4: the gate requires BOTH the reviewer's own approval AND zero blocking
      // corrections. The earlier `blockingCount === 0` alone let an all-ADVISORY verdict publish even
      // when the reviewer explicitly set approved:false (a gameable hole: a model could downgrade
      // every correction to advisory and still flip the gate to publish). The severity gate still
      // prevents advisory-only corrections from blocking a genuine approval — but it can no longer
      // OVERRIDE an explicit rejection. (Grave class-tag corrections — [false-positive],
      // [wrong-objective], [no-cleanup] — are forced to blocking in parseReviewerVerdict, so a
      // mislabeled grave finding also keeps blockingCount > 0.)
      //
      // D4 (#669 close): the `executedRed` guard is a deterministic orchestrator override.
      // On round 0, when the feedback execute returned "fail", the spec being reviewed is a
      // KNOWN-RED spec: it failed against the live DEV environment. The reviewer LLM cannot
      // approve it — even a model-returned approved:true is overridden fail-closed.
      // Round-0-only: after the internal mid-loop regen at :1589 the spec is fresh and
      // unexecuted, so the override MUST NOT fire on round >= 1 (stale-evidence guard).
      // Mirrors the fail-closed `return {...r, approved:false}` precedents at :1512/:1524
      // (reviewer error / unparseable verdict). Logic: any fail verdict means the spec is red.
      // D4 (#669 close, cont.): fail-closed immediately when executedRed is true. Do NOT
      // enter the regeneration loop — the problem is a known-red executed spec, not a test defect
      // that regen can fix. Mirrors the early-return precedents at :1521/:1533.
      const executedRed = round === 0 && executionEvidence?.verdict === "fail";
      if (executedRed) {
        log("[qa] executedRed override (D4/#669): feedback execute was red — reviewer approval overridden fail-closed (round 0, known-red spec, no regeneration).");
        addTiming("reviewer", Date.now() - reviewStart);
        return { ...r, reviewed: true, approved: false, note: "feedback execute was red on round 0 — reviewer approval not accepted for a known-red spec (D4/#669)" };
      }
      const gateApproves = review.approved && blockingCount === 0;
      // Surface the corrections to the live ReviewerCard on a non-approval. Severity is not
      // re-derivable from the flat string list, so all corrections are surfaced when the gate fails —
      // callers already tolerate this. (FIX 8b: dropped a dead no-op .filter(() => true).)
      onReviewer?.(gateApproves, gateApproves ? [] : review.corrections);
      if (!gateApproves) reviewerCorrections.push(...review.corrections);
      // Phase 4: the gate requires BOTH review.approved AND zero blocking corrections. When it
      // approves, any advisory corrections are stored as informational notes but do not regenerate.
      if (gateApproves) {
        if (advisoryCount > 0) {
          log(`[qa] severity gate: ${advisoryCount} advisory correction(s) recorded but not blocking (zero blocking corrections).`);
        }
        return { ...r, reviewed: true, approved: true, note: undefined };
      }
      // Phase 4: save this round's corrections to thread into the NEXT review call.
      previousRoundCorrections = review.corrections;
      if (!reviewOpts.allowRegeneration) return { ...r, reviewed: true, approved: false, note: review.corrections.join("; ") };
      if (round === MAX_REVIEW_ROUNDS - 1) return { ...r, reviewed: true, approved: false, note: review.corrections.join("; ") };
      log(`[qa] applying ${blockingCount} blocking correction(s) (${advisoryCount} advisory) and regenerating...`);
      onStep?.("retry");
      retries++;
      const regenStart = Date.now();
      // Wall-clock ceiling guard (mirror of the one at generateOnce entry, for the mid-review regen).
      // Mirrors the cycle-ceiling that immediately follows. Returns the current reviewer-rejected state
      // without starting another generation — identical semantics to the cycle-ceiling at 1515.
      if (now() - runStart > wallClockBudget) {
        log(`[qa] [timing] wall-clock budget reached mid-review (${Math.round((now() - runStart) / 1000)}s > ${Math.round(wallClockBudget / 1000)}s): stopping regeneration, returning current reviewer-rejected state.`);
        return { ...r, approved: false, note: `wall-clock budget exhausted mid-review (${Math.round(wallClockBudget / 1000)}s); last reviewer correction: ${review.corrections.join("; ")}` };
      }
      // Phase 6a: count the review-round internal re-generation against the shared budget.
      // The ceiling check prevents unbounded rounds when a run has already spent budget elsewhere.
      cycleCount++;
      if (cycleCount > MAX_CYCLES) {
        log(`[qa] cycle-ceiling reached mid-review-loop (cycleCount=${cycleCount - 1}/${MAX_CYCLES}): stopping regeneration, returning current reviewer-rejected state.`);
        return { ...r, approved: false, note: `iteration budget exhausted mid-review (maxCycles=${MAX_CYCLES}); last reviewer correction: ${review.corrections.join("; ")}` };
      }
      log(`[qa] cycle-counter: review-round regeneration (cycleCount=${cycleCount}/${MAX_CYCLES})`);
      // Ground the regeneration in the SAME live a11y snapshot the reviewer just judged against, so the
      // generator fixes selectors against the real tree (e.g. no `columnheader` role on this table)
      // instead of re-deriving them from HTML intuition — the captured tree already shows what roles
      // actually exist and which names are duplicated (strict-mode risk).
      r = await reconcileSpecs(await deps.generate({ ...genInput, reviewCorrections: review.corrections, domSnapshot }, signal, log, usage.add.bind(usage), onRepair));
      log(`[qa] [timing] regeneration produced ${r.specs.length} spec(s) in ${Math.round((Date.now() - regenStart) / 1000)}s`);
    }
    return r;
  };

  const generateAndReview = async (
    genInput: GenerateInput,
    opts: { review?: "full" | "skip" } = {},
  ): Promise<AgentResult> => {
    const r = await generateOnce(genInput);
    if (opts.review === "skip") {
      return app.qa.needsReview && deps.review ? { ...r, reviewed: false, approved: false } : r;
    }
    return reviewGenerated(r, genInput, { allowRegeneration: true });
  };

  // Learned rules + exemplars + curriculum, assembled once in the generation block below and
  // included in EVERY generation prompt by default — including the failure-retry and the
  // coverage-enforce regeneration, which previously dropped them.
  let promptSections: string | undefined;

  // Slice G: the Context Pack is built once from the brief/DOM/contracts and stored here.
  // Every generation call via baseGenInput receives the same pack — it is NOT rebuilt on
  // regen passes (the pack is first-write ground truth; fix/review/coverage passes use
  // domSnapshot instead which is sourced from the failure-point capture).
  let builtContextPack: string | undefined;

  // Slice H: the ExplorationBrief from the orchestrator-level explorer pass (run BEFORE the pack
  // build so the brief drives route/blast-radius selection inside buildContextPack). The same brief
  // is forwarded to every generation call via baseGenInput.explorerBrief, so defaultPipelineDeps.generate
  // can set contextBrief on the OpencodeRunInput and clear explorer — guaranteeing at most ONE
  // explorer pass per run (no double-run). Undefined when the explorer is disabled or fails.
  let builtExplorerBrief: import("./qa/exploration-brief").ExplorationBrief | undefined;

  // Declared here (before baseGenInput) so the closure captures it; assigned after the
  // context-pack block. All real baseGenInput() call sites are after the assignment, so
  // every generation and re-generation pass receives the computed value (or undefined).
  let staticSignalText: string | undefined;

  // C1: diff archetypes computed once from the commit diff+files (deterministic). Threaded into
  // every generation call via baseGenInput so the generator receives a one-line structural hint.
  // Gated to diff mode with intent present — without a commit diff, structural shape has no scope.
  const diffArchetypeKinds: string[] | undefined =
    generating && intent && mode === "diff"
      ? detectStructuralPatterns(diff, intent.changedFiles).map((p) => p.kind).filter((k) => k !== "generic")
      : undefined;

  // Seam b: enumerate existing spec files from the filesystem before the first generate call.
  // Populated once (not rebuilt on regen passes — the suite does not change mid-run).
  // Graceful: if the e2e dir does not exist or the glob fails, stays undefined (no section emitted).
  let existingSpecFiles: string[] | undefined;
  if (!isCode) {
    try {
      const { readdirSync, statSync } = await import("node:fs");
      const globSpecs = (dir: string): string[] => {
        let results: string[] = [];
        try {
          for (const entry of readdirSync(dir)) {
            const full = `${dir}/${entry}`;
            if (statSync(full).isDirectory()) {
              results = results.concat(globSpecs(full));
            } else if (entry.endsWith(".spec.ts")) {
              // Return path relative to e2eDir
              results.push(full.slice(e2eDir.length + 1));
            }
          }
        } catch { /* dir may not exist yet — graceful */ }
        return results;
      };
      const found = globSpecs(e2eDir);
      if (found.length > 0) existingSpecFiles = found;
    } catch {
      // Graceful degradation: filesystem read failed — no manifest section emitted.
    }
  }

  const baseGenInput = (extra: Partial<GenerateInput>): GenerateInput => ({
    repo: app.repo,
    sha,
    diff: promptDiff,
    mirrorDir,
    namespace: ns,
    needsReview: app.qa.needsReview,
    target: opts.target,
    mode,
    appName: app.name,
    baseUrl: app.dev?.baseUrl,
    intent,
    guidance: opts.guidance,
    openapi: app.openapi,
    parallelDiff: app.qa.parallelDiff,
    // Slice H (fixed): when exploreForPack dep is wired (production), the orchestrator-level
    // explorer already ran (or was attempted); the in-runOpencode maybeExplore must NEVER run
    // again (no-double-run guarantee). Set explorer=false unconditionally in that case.
    // When exploreForPack dep is absent (test stubs that don't inject it), fall back to the
    // legacy flag: brief set → false (brief already forwarded as contextBrief); brief absent → app.qa.explorer.
    // qa.explorer is now only a fallback for the stub/legacy path; it is ignored in production.
    explorer: deps.exploreForPack ? false : (builtExplorerBrief ? false : app.qa.explorer),
    explorerBrief: builtExplorerBrief,
    contextMap,
    contextPack: builtContextPack,
    learnedRules: promptSections,
    staticSignal: staticSignalText,
    // C1: thread diff archetypes so the generator receives a one-line structural hint.
    diffArchetypes: diffArchetypeKinds?.length ? diffArchetypeKinds : undefined,
    // Slice 1: thread change-anchor signals to defaultPipelineDeps.generate so the captureRoutesDom
    // closure can pass them to captureDomByRoute for [CHANGED: …] annotation of worker DOM trees.
    changedElements: changedElements.length > 0 ? changedElements : undefined,
    testIdAttribute,
    // Seam b: thread enumerated spec files into every generation call for the manifest section.
    existingSpecFiles,
    service: triggerService
      ? { repo: triggerService.repo, mirrorDir: serviceMirrorDir!, openapi: triggerService.openapi }
      : undefined,
    ...extra,
  });

  // 5. Generate (only when applicable): the agent writes/improves `e2e/`.
  let result: AgentResult | null = null;
  // Observation-only counts for §9 (gateSignals): ambiguities caught pre-execution, and how many
  // persisted after the corrective regen to trigger the deterministic block.
  let preExecAmbiguityCatches = 0;
  let deterministicSelectorBlocks = 0;
  // W1/W2 — deterministic pre-execution selector ambiguity check, reusable at the detect point (W1) AND
  // the block point (W2). Re-checked FRESH at the static gate so a static-fix rewrite cannot leave a stale
  // block and a no-op corrective regen is still caught (the on-disk specs are authoritative). Reads the
  // CURRENT specs, renders their target routes' live DOM, and returns the strict-mode AMBIGUITY
  // contradictions (present + non-unique). Agnostic to the app's stack; best-effort (variable grounding
  // coverage degrades to []). A scoped `.locator(...)` locator (non-extractable → uniqueness INDETERMINATE)
  // and absent/unverifiable selectors NEVER count, so the block fires only on a confirmed, unscoped fact.
  const ambiguousSelectorsNow = async (): Promise<string[]> => {
    const baseUrl = app.dev?.baseUrl;
    if (isCode || !baseUrl || !deps.captureRouteTrees || result == null || result.specs.length === 0) return [];
    const specSources = result.specs
      .map((f) => join(e2eDir, f))
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p, "utf8"));
    // RouteSnapshot.settled and the full RouteCatalog (testIds/status) are produced by captureRouteTrees
    // but only nodes[] is consumed here today — the slice-4 selector gate must wire settled+catalog.
    const trees = (await deps.captureRouteTrees({ e2eDir, baseUrl, specContents: specSources, testIdAttribute }))
      .map((s) => s.nodes ?? [])
      .filter((n) => n.length > 0);
    // A1: per-selector chain-awareness. The old blanket `if (findings.anyNonExtractable) return []`
    // suppressed ALL ambiguity contradictions whenever any non-extractable locator appeared anywhere
    // in the spec, even a standalone terminal `getByTestId('x')` that scopes nothing. The new
    // unscopedMultipleContradictions function returns MULTIPLE contradictions only for extractable
    // selectors that are NOT lexically chained after a non-extractable scope prefix on the same
    // expression chain, preserving the false-positive guard for scoped `.locator().getByRole(…)`
    // calls while surfacing real ambiguities from unrelated standalone extractable selectors.
    //
    // NOTE: pre-write DOM cannot catch selectors that become ambiguous POST-write within a single
    // run (e.g. a form step that duplicates a heading after the agent's last navigation). That
    // residual case is caught at execution by the post-failure Lever-2 check (checkSpecSelectors
    // at line ~2452) + per-attempt namespace isolation.
    return unscopedMultipleContradictions(specSources, trees, "pre-write");
  };

  // Pillar 2 — the confidence-aware catalog gate, wired as a one-shot PRE-EXECUTION repair (design
  // slice 4/5). For each spec, gate its test-id selectors against the captured RouteCatalog of its FIRST
  // route: a test-id ABSENT from the DOM inside the confident window (captured && settled, before the
  // first navigation/click) is FABRICATED → emit a GROUND TRUTH correction so the single corrective regen
  // replaces it BEFORE a 30s runtime timeout. Everything else (post-navigation, unsettled, degraded,
  // un-groundable) is advisory — never a correction. Feeds the SAME selectorContradictions channel as the
  // ambiguity check and, like it, triggers only ONE regen; the run then proceeds regardless (a still-absent
  // selector is left to the runtime backstop). It never touches the W2 deterministic BLOCK, so a
  // dynamically-revealed element can never false-block. Best-effort: any capture gap → no corrections.
  const catalogSelectorCorrections = async (): Promise<string[]> => {
    const baseUrl = app.dev?.baseUrl;
    if (isCode || !baseUrl || !deps.captureRouteTrees || result == null || result.specs.length === 0) return [];
    const specSources = result.specs
      .map((f) => join(e2eDir, f))
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p, "utf8"));
    // Cost guard: only the test-id family is gated this slice — skip the render entirely when no spec
    // emits a getByTestId (the gate would have nothing to check).
    if (!specSources.some((s) => s.includes("getByTestId("))) return [];
    const snaps = await deps.captureRouteTrees({ e2eDir, baseUrl, specContents: specSources, testIdAttribute });
    const catalogByRoute = new Map(snaps.map((s) => [s.route, buildRouteCatalog(s)]));
    const corrections: string[] = [];
    let inWindow = 0;
    let advisory = 0;
    for (const specSrc of specSources) {
      const firstRoute = extractTargetRoutes([specSrc])[0]; // the confident-window route is the initial goto
      if (firstRoute === undefined) continue; // no navigable route → no window catalog → all advisory
      const windowRoute = catalogByRoute.get(firstRoute);
      if (windowRoute === undefined) continue; // route not captured → advisory
      const gate = catalogGate(specSrc, windowRoute);
      inWindow += gate.inWindow;
      advisory += gate.advisory;
      for (const value of gate.failClosed) {
        corrections.push(`getByTestId('${value}') is NOT in the captured DOM of route '${firstRoute}' — this test-id does not exist on the page. Use only a test-id present in the grounded DOM snapshot, or a role/label selector; never invent a test-id.`);
      }
    }
    if (inWindow + advisory > 0) {
      log(`[qa] catalog gate: ${corrections.length} fabricated test-id(s) caught pre-execution; ${inWindow}/${inWindow + advisory} test-id selector(s) in the confident window (rest advisory → runtime backstop)`);
    }
    return corrections;
  };

  // Load persisted curriculum (survives across runs — archetypes that caught real bugs)
  if (!curriculum) {
    const { loadCurriculum } = await import("./server/history");
    curriculum = loadCurriculum(app.name) ?? initCurriculum(app.name);
  }

  if (generating) {
    checkSignal();
    onStep?.("generate");

    let learnedRules: string | undefined;
    if (deps.retrieveRules && generating) {
      const retrieval = await bestEffortAsync("retrieval", log, async () => {
        // Bias retrieval toward the app's most recent failure class: rules that prevent
        // the error the engine just made are the most likely to matter on this run.
        let lastErrorClass: string | null = null;
        if (deps.recentErrorClass) {
          lastErrorClass = await bestEffortAsync("recent-error-class", log, () => deps.recentErrorClass!(app.name), null);
        }
        // Bias retrieval ALSO toward the current diff's structural shape (form, api-call, …) so
        // rules learned on the same kind of change surface even before any failure class exists.
        // NOTE: `intent` (hence changedFiles) is only set in diff mode; in complete/exhaustive/manual
        // changedFiles is [] so file-extension-gated patterns (e.g. form) don't fire — content-only
        // patterns (api-call, …) still do. The same input is used at distill-time for symmetry.
        const diffArchetypes = detectStructuralPatterns(diff, intent?.changedFiles ?? []).map((p) => p.kind);
        return deps.retrieveRules!(app.name, lastErrorClass, diffArchetypes);
      }, null);
      if (retrieval?.promptSection) {
        learnedRules = retrieval.promptSection;
        retrievedRuleIds = retrieval.rules.map((r) => r.id);
        retrievedRules = retrieval.rules;
        log(`[qa] retrieval: injected ${retrievedRuleIds.length} learning rule(s) into the agent prompt`);
      }
    }

    let allPromptSections = learnedRules ?? "";

    if (generating && intent) {
      const patterns = detectStructuralPatterns(diff, intent.changedFiles);
      const exemplars = patterns.flatMap((p) => matchExemplars(p));
      if (exemplars.length > 0) {
        const exemplarText = renderExemplarsForPrompt(exemplars);
        allPromptSections = (allPromptSections ? allPromptSections + "\n" : "") + exemplarText;
        log(`[qa] patterns: detected ${patterns.map((p) => p.kind).join(", ")} → ${exemplars.length} exemplar(s)`);
      }
    }

    // Inject curriculum archetypes into agent prompt — ONLY when intent (diff) is present.
    // Phase 5: archetypes and exemplars are relevance-gated IDENTICALLY for both diff and manual.
    // Archetypes are structural patterns derived from past diff runs (form-change, api-call, …);
    // without a commit diff they have no scope signal and become noise in the manual prompt,
    // competing with the user's guidance. Gate them the same way exemplars are gated (requires intent).
    const activeArchetypes = generating && intent ? selectActiveArchetypesCached(curriculum!) : [];
    if (activeArchetypes.length > 0) {
      const archetypeText = renderArchetypesForPrompt(activeArchetypes);
      allPromptSections = (allPromptSections ? allPromptSections + "\n" : "") + archetypeText;
    }

    promptSections = allPromptSections || undefined; // every later regeneration inherits this via baseGenInput

    // Slice G/H — Context Pack: build and push BEFORE the first generation call.
    // Slice H adds: (a) run the explorer pass FIRST to obtain the ExplorationBrief, which drives
    // route selection for DOM capture and blast-radius content; (b) forward the same brief to every
    // generation call via baseGenInput.explorerBrief so runOpencode does NOT re-run the explorer
    // (no-double-run). The explorer is best-effort: failure → no brief → pack degrades to DOM+contracts.
    // The pack itself is also best-effort: a failure logs a warning and the run continues with
    // explore-first behaviour. Only built for e2e mode; code mode has no DOM and no blast radius.
    // Re-generation passes inherit the same pack via baseGenInput so the generator always sees the
    // same ground truth it was given on the first write.
    if (!isCode && app.dev?.baseUrl) {
      // Slice H step 1: orchestrator-level explorer pass — runs BEFORE the pack so the brief is
      // available as input to buildContextPack. Gated to first-pass only (not regen) via exploreForPack.
      // Cost: one extra read-only qa-explorer agent session on diff/manual e2e runs when qa.explorer
      // is enabled. The agent pass distills blast-radius symbols + verified routes via Serena; this is
      // the intended trade against expensive downstream re-navigation iterations.
      if (deps.exploreForPack) {
        try {
          const _exploreT0 = Date.now();
          const explorerBrief = await deps.exploreForPack(
            baseGenInput({ fixCases: opts.fixCases }),
            signal,
            (msg) => log(msg),
          );
          addTiming("explorer", Date.now() - _exploreT0);
          if (explorerBrief) {
            builtExplorerBrief = explorerBrief;
            log(`[qa] context-pack: explorer brief available (${builtExplorerBrief.blastRadius.length} symbol(s), ${(builtExplorerBrief.routes ?? []).length} candidate route(s); verified=${(builtExplorerBrief.routes ?? []).filter((r) => r.verified).length})`);
          } else {
            log("[qa] context-pack: no explorer brief — pack will use DOM+contracts only");
          }
        } catch (err) {
          log(`[qa] context-pack: explorer pass FAILED (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      try {
        const _packT0 = Date.now();
        const packResult = await buildContextPack(
          {
            // Slice H: the brief (from the orchestrator-level explorer pass above) now drives both
            // route selection for DOM capture and blast-radius content in the pack. When absent the
            // pack degrades to DOM-via-context-routes + contracts; explore-first mandate stays active.
            brief: builtExplorerBrief,
            baseUrl: app.dev.baseUrl,
            e2eDir,
            contextMap,
            // prChangedFiles: will be wired from webhook PR-range in the follow-up TODO below.
            // TODO (Slice H / webhook): wire the PR-range changed-file union here. The webhook
            // currently delivers a single SHA; computing the PR base requires the GitHub API
            // (GET /repos/{owner}/{repo}/pulls/{number}/commits or the compare endpoint).
            // Until that wiring exists, prChangedFiles is undefined and contracts are filtered
            // by the brief's feBe only (or contextMap feBe when no brief is present).
            prChangedFiles: intent?.changedFiles,
            // Slice 1: thread change-anchor signals into the context-pack DOM section for [CHANGED: …] annotation.
            changedElements: changedElements.length > 0 ? changedElements : undefined,
            testIdAttribute,
          },
          defaultContextPackDeps,
        );
        addTiming("pack", Date.now() - _packT0);
        if (packResult.text) {
          builtContextPack = packResult.text;
          log(`[qa] context-pack: built (blastRadius=${packResult.blastRadiusBytes}B, dom=${packResult.domBytes}B, contracts=${packResult.contractBytes}B)`);
        } else {
          log("[qa] context-pack: all components absent or failed — generator will use explore-first");
        }
      } catch (err) {
        log(`[qa] context-pack: build FAILED (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // C2 Part A: static-signal runs in BOTH e2e and code mode (pure source analysis — no DEV/DOM
    // needed). The original !isCode guard was a structural bias against code mode, but static-signal
    // is exactly where symbol/relation/complexity targeting helps most for code-mode runs.
    // The cross-service trigger guard is kept: service diffs are foreign-repo changes whose
    // symbols/relations are not in the primary repo's tree.
    if (deps.aggregateStaticSignal && generating && !triggerService) {
      const sig = await deps.aggregateStaticSignal({ sha, baseSha: opts.baseSha, repoDir: mirrorDir, changedFiles: [...parseDiffHunks(promptDiff).keys()], diff: promptDiff });
      staticSignalText = renderStaticSignal(sig) || undefined;
      const hasContent = sig.symbols.length > 0 || sig.relations.length > 0 || sig.complexity.length > 0 || sig.patterns.length > 0;
      if (hasContent || sig.skipped.length > 0) {
        log(`[qa] static-signal: ${sig.symbols.length} symbols, ${sig.relations.length} relations, ${sig.complexity.length} hotspots, ${sig.patterns.length} patterns${sig.skipped.length > 0 ? ` (skipped: ${sig.skipped.length})` : ""}`);
        // C5: log skipped notes when non-empty so tool failures are visible.
        if (sig.skipped.length > 0) {
          log(`[qa] static-signal skipped: ${sig.skipped.join("; ")}`);
        }
      }
    }

    log("[qa] generating E2E tests with OpenCode...");
    // D1: generate without review here. The reviewer is moved to after the feedback execute
    // (see the feedback block below) so it judges a spec that has actually executed against DEV.
    // On runs where the feedback execute is skipped (code-mode, no-dev, complete, exhaustive),
    // the reviewer still runs — it just runs at the post-feedback position, which is identical
    // to the post-static-gate position in those cases.
    result = await generateOnce(baseGenInput({ fixCases: opts.fixCases }));

    // W1 — pre-execution corrective pass. Detect strict-mode ambiguity against the live DOM and, if found,
    // feed it through the EXISTING selectorContradictions regen channel + generateOnce (cycle-ceiling
    // bounded) so the agent scopes the locator BEFORE the first execution. The deterministic BLOCK is
    // re-checked FRESH at the static gate below (W2), so even a no-op corrective regen is still caught.
    const preExecAmbiguities = await ambiguousSelectorsNow();
    preExecAmbiguityCatches = preExecAmbiguities.length;
    // Merge the confidence-aware catalog gate's fabricated-test-id corrections into the SAME one-shot
    // repair. Like the ambiguity check it only ever triggers ONE regen, and it never participates in the
    // W2 deterministic BLOCK below — so a still-absent (e.g. dynamically-revealed) test-id can never
    // false-block; it is left to the runtime backstop.
    const preExecCatalogCorrections = await catalogSelectorCorrections();
    const preExecCorrections = [...preExecAmbiguities, ...preExecCatalogCorrections];
    if (preExecCorrections.length > 0) {
      log(`[qa] pre-exec selector check: ${preExecCorrections.length} correction(s) BEFORE execution — regenerating once: ${preExecCorrections.join("; ")}`);
      const corrected = await generateOnce(baseGenInput({ selectorContradictions: preExecCorrections }));
      // ONLY adopt the corrective regen if it produced specs. An EMPTY result (cycle-ceiling hit, or an
      // agent no-op) must NOT discard the original specs — they remain on disk and WILL execute, so
      // `result` must keep pointing at them for the W2 re-check (and the no-op-skip guard) to catch a
      // residual ambiguity. This closes the empty-corrective-regen bypass.
      if (corrected != null && corrected.specs.length > 0) result = corrected;
    }

    // Phase 6b: retroactively dimension the runaway backstop to the actual scope when the planner
    // produced multiple objectives. The app-level iterationBudget override is authoritative and is
    // never replaced. The default backstop (numObjectives=1) is refined to the planner's count only
    // on multi-objective runs: a 5-objective run gets a proportionally higher ceiling than a 1-objective
    // run so we don't truncate legitimate parallel work.
    if (!app.qa.iterationBudget && result.objectiveCount && result.objectiveCount > 1) {
      const refined = deriveCycleBackstop(app.qa.fixLoop?.maxRetries ?? 2, result.objectiveCount);
      if (refined > MAX_CYCLES) {
        log(`[qa] cycle-counter: scope-dimensioned backstop raised to ${refined} (${result.objectiveCount} objective(s)); was ${MAX_CYCLES}`);
        MAX_CYCLES = refined;
        // Also recompute the wall-clock ceiling to match the raised cycle ceiling. The
        // qa.wallClockBudgetMs config override is never recomputed (it already won above).
        if (!app.qa.wallClockBudgetMs) {
          wallClockBudget = MAX_CYCLES * agentTimeout(mode);
        }
      }
    }

    // Wire the specs into the RunRecord so the TUI shows what was generated.
    // specMetas carries structured data (flow, objective); specs[] is the flat fallback.
    if (result.specs.length > 0) {
      const entries = result.specMetas?.length
        ? result.specMetas.map((m) => ({ name: m.file, flow: m.flow, objective: m.objective }))
        : result.specs.map((s) => ({ name: s }));
      onSpecs?.(entries);
      onStep?.("generate", `${entries.length} spec(s) generated`);
    }

    log(
      `[qa] agent: approved=${result.approved} specs=[${result.specs.join(", ")}]` +
        (result.note ? ` note=${result.note}` : "") +
        `\n[qa] agent output (first 600 chars): ${result.output.slice(0, 600)}`,
    );
    // The agent is the authority on whether tests are needed. If it approved and
    // wrote none, this is a legitimate no-op (a diff with nothing to cover, or a
    // complete run where everything important is already covered) → skip.
    if (result.approved && result.specs.length === 0) {
      log("[qa] the agent produced no tests (nothing to cover); nothing to run.");
      // Post-generation exit: the agent ran (tokens spent) and may have written out-of-area strays
      // even when it produced no specs. Revert/record strays AND record the token spend — a no-op
      // is a common diff-mode outcome. Non-blocking; the verdict stays `skipped`.
      const skipped: QaRunResult = { sha: ns, verdict: "skipped", passed: true, cases: [], logs: result.note ?? result.output.slice(0, 300) };
      const confinement = await runConfine();
      persistOutcome(skipped, { confinement, usage: usage.result(usageComplete, usageAttribution), phaseTimings });
      return skipped;
    }
  } else {
    log("[qa] regression: not generating tests; validating and running the existing suite.");
  }

  // Learning fold shared by the static-gate early return and the end of the pipeline:
  // distill reviewer corrections, label the run, fold the prevention signal into the
  // retrieved rules (no-oracle governance), reflect on the failure, and persist the
  // curriculum. Without this on the `invalid` path the engine would never learn anything
  // from static-gate failures — the most common failure mode of generated tests.
  // Off-path: every step is non-blocking and a failure is only a warning.
  const foldRunLearning = async (v: QaRunResult, o: { staticOk: boolean; coverageRatio?: number | null; valueScore?: number | null }) => {
    // Compute diff pattern kinds ONCE and reuse for both archetype tagging and prevention filtering.
    const diffPatternKinds = detectStructuralPatterns(diff, intent?.changedFiles ?? []).map((p) => p.kind);
    // Tag rules distilled from this run with the diff's dominant structural shape, so they recall
    // on the same kind of change later. Only a SPECIFIC shape is useful as a tag — a purely
    // "generic" diff yields null (untagged), since "generic" matches everything and biases nothing.
    const runArchetype = diffPatternKinds.find((k) => k !== "generic") ?? null;
    if (reviewerCorrections.length > 0 && opts.runId && deps.distillCorrections && shouldDistillLearning(isCode, v.verdict)) {
      try {
        const distilled = deps.distillCorrections({ app: app.name, runId: opts.runId, corrections: reviewerCorrections, archetype: runArchetype });
        if (distilled.inserted.length > 0) {
          log(`[qa] learning: distilled ${distilled.inserted.length} candidate rule(s) from reviewer corrections (retrievable, rendered as experimental until measured outcomes promote them)`);
        }
      } catch (err) {
        log(`[qa] WARNING: reviewer-corrections distillation failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const labeled = labelRunOutcome({
      runId: opts.runId ?? sha, app: app.name, sha, mode, target: opts.target ?? "e2e",
      verdict: v.verdict, staticOk: o.staticOk,
      coverageRatio: o.coverageRatio ?? null,
      minCoverageRatio: app.qa.changeCoverage?.minRatio ?? DEFAULT_COVERAGE_POLICY.minRatio,
      reviewerCorrections, reviewerRationale, flaky: v.verdict === "flaky", retries,
      valueScore: o.valueScore ?? null,
    });
    // Governance WITHOUT an oracle: when the oracle produced no valueScore (off, or not
    // applicable), fold a CONSERVATIVE prevention signal — derived from this run's own
    // errorClass — into the RELEVANT retrieved rules. Prevention is conditioned on structural
    // relevance: a rule only earns or loses prevention trust on a change whose archetype matches
    // the rule's tagged archetype. Untagged rules (no archetype field) stay eligible — attributableRules
    // is fail-open per rule, so the large body of legacy untagged rules remains in the flywheel.
    // This lets candidate rules earn or lose trust for EVERY app, not just oracle-enabled ones.
    // Capped at "medium" confidence (only the oracle lifts a rule to "high"). See preventionOutcome.
    //
    // Phase 7 coverage anchor: derive a coverage-credit signal to gate candidate → active promotion.
    // coverageCreditConfirmed is true when coverage was measured AND the test covered changed lines
    // (coverageRatio > 0), false when measured but found no coverage, null when not measured at all
    // (cross-repo, policy=off, or unknown). This is the non-circular anchor: promotion requires that
    // the tests the rule influenced actually exercised the diff's changed lines, not just green-lit by
    // the reviewer. Coverage stays non-blocking where unmeasurable (null → promotion allowed).
    const coverageRatio = o.coverageRatio ?? null;
    const coverageMeasured = coverageRatio !== null; // true when the coverage step ran and produced a ratio
    const coverageCreditConfirmed = coverageMeasured ? coverageRatio > 0 : null;
    if ((o.valueScore ?? null) === null && retrievedRules.length > 0 && opts.runId) {
      const { recordRuleOutcome } = await import("./server/history");
      bestEffort("governance", log, () => {
        let folded = 0;
        for (const rule of attributableRules(retrievedRules, { diffArchetypes: diffPatternKinds })) {
          const score = preventionOutcome(rule.errorClass, labeled.errorClass);
          if (score === null) continue; // no evidence about this rule from this run
          // Pass the coverage-credit signal so the DB's promotion gate can apply it.
          recordRuleOutcome(rule.id, score, coverageCreditConfirmed);
          folded++;
        }
        if (folded > 0) {
          log(`[qa] governance: folded prevention signal into ${folded} rule(s) (no oracle; runErrorClass=${labeled.errorClass ?? "none"}; coverageCredit=${coverageCreditConfirmed ?? "unmeasured"})`);
        }
      }, undefined);
    }
    if (deps.reflectAndDistill && opts.runId && !signal?.aborted && shouldDistillLearning(isCode, v.verdict)) {
      if (labeled.errorClass && labeled.errorClass !== "E-INFRA" && labeled.errorClass !== "E-FLAKY") {
        const outcome: RunOutcome = { ...labeled, gateSignals: { ...labeled.gateSignals, valueScore: o.valueScore ?? null }, rulesRetrieved: retrievedRuleIds, at: labeled.at };
        void bestEffortAsync("reflect-distill", log, () => deps.reflectAndDistill!({ app: app.name, runId: opts.runId!, outcome, archetype: runArchetype }), null);
      }
    }
    // Persist curriculum (archetypes that caught real bugs survive across runs)
    if (curriculum) {
      const { saveCurriculum } = await import("./server/history");
      bestEffort("curriculum-save", log, () => saveCurriculum(curriculum!), undefined);
    }
    // Post-run PROCESS audit — the engine reflecting on its OWN run quality (recurring defects,
    // ledger noise, review churn) and routing each finding to the right remediation: deprecate
    // noise rules autonomously (DATA), record an incident for the maintainer on an engine defect
    // (CODE → human-gated PR). Server-side, off-path, independent of any client/TUI session.
    if (deps.auditProcess && opts.runId) {
      // AWAITED (not fire-and-forget): a manual/CLI run does `process.exit` right after the pipeline
      // returns, which would kill an un-awaited audit mid-flight (its incident/deprecation never
      // lands). The deterministic detection is cheap and the LLM diagnosis is already
      // hasOpenSessions-gated, so awaiting adds no meaningful latency. Best-effort — never throws.
      await bestEffortAsync("process-audit", log, () => deps.auditProcess!({ app: app.name, runId: opts.runId! }), undefined);
    }
  };

  // Tracks whether the code-mode compile gate passed (for the learning record's staticOk). Optimistic
  // default so an absent/not-applicable gate is not recorded as a misleading false; a FAILED gate
  // returns early, so reaching the green-path persist below means the gate passed.
  let codeValidated = true;
  checkSignal();
  // 6. Filter B — static gate. e2e: typecheck/lint/list/manifest over `e2e/`. Code
  //    mode has no separate static gate: running the repo's own suite IS the gate
  //    (the tests won't pass if the generated code doesn't compile), so we skip it.
  if (!isCode) {
    onStep?.("validate");
    log("[qa] validating specs (typecheck + lint + list + manifest)...");
    let validation = await (async () => { const t0 = Date.now(); const v = await deps.validate(e2eDir); addTiming("validate", Date.now() - t0); return v; })();
    // Static-repair loop. A single trivial gate error (an unused var, a stray import) used to fail the
    // WHOLE run `invalid` with no second chance — while EXECUTION failures already get a fix-loop. That
    // asymmetry let one `no-unused-vars` discard 7 otherwise-good specs (observed on PetClinic). Mirror
    // the execution loop: feed the EXACT tsc/eslint/list errors back to the agent (single-agent — a
    // reviewCorrections payload forces shouldFanOut false) and re-validate, bounded. Only a gate still
    // red after the budget is a real `invalid`. Skipped when nothing was generated to repair.
    let staticFixRounds = 0;
    while (
      !validation.ok && !validation.infra && generating &&
      (result?.specs.length ?? 0) > 0 &&
      staticFixRounds < MAX_STATIC_FIX_ROUNDS && !signal?.aborted
    ) {
      staticFixRounds++;
      retries++;
      log(`[qa] static gate failed (repair ${staticFixRounds}/${MAX_STATIC_FIX_ROUNDS}); regenerating to fix:\n${validation.errors.join("\n")}`);
      // D1 (FIX 3): generate only — review is centralized post-feedback (L2122), so the static-fix
      // loop must NOT call generateAndReview here, which would double-review when the loop fires.
      result = await generateOnce(
        baseGenInput({
          reviewCorrections: [
            `The generated specs FAILED the static gate (tsc + eslint + \`playwright --list\`). Fix EXACTLY these errors and change nothing else:\n${validation.errors.join("\n")}`,
          ],
        }),
      );
      checkSignal();
      validation = await (async () => { const t0 = Date.now(); const v = await deps.validate(e2eDir); addTiming("validate", Date.now() - t0); return v; })();
    }
    if (staticFixRounds > 0 && validation.ok) {
      log(`[qa] static gate PASSED after ${staticFixRounds} repair round(s).`);
    }
    // W2 — deterministic block: re-check the CURRENT (post static-fix) specs against the live DOM, and if a
    // strict-mode ambiguity persists, fold it into the static gate so the EXISTING `invalid` path holds the
    // run before execution. Re-checking FRESH here (not a value stored before the static-fix loop) means a
    // static-fix rewrite cannot leave a stale block AND a no-op corrective regen is still caught (the
    // on-disk specs are authoritative). Guarded by `preExecAmbiguityCatches > 0` (only re-render when W1
    // found something) and `validation.ok` (a real tsc/eslint failure already routes to invalid first).
    if (preExecAmbiguityCatches > 0 && validation.ok) {
      const persistent = await ambiguousSelectorsNow();
      deterministicSelectorBlocks = persistent.length;
      if (persistent.length > 0) {
        log(`[qa] pre-exec selector check: strict-mode ambiguity PERSISTS — holding the run (deterministic block): ${persistent.join("; ")}`);
        validation = {
          ok: false,
          infra: false,
          errors: persistent.map((a) => `strict-mode selector ambiguity (deterministic — would fail at runtime; scope to a unique parent): ${a}`),
        };
      }
    }
    if (!validation.ok) {
      log(`[qa] static gate failed:\n${validation.errors.join("\n")}`);
      // When every failure is infrastructure (ENOENT, signal-kill), the gate itself
      // couldn't run — it's inconclusive, not a code-quality verdict. Log it, but
      // don't open an Issue on the watched repo for a missing binary or OOM.
      if (validation.infra) {
        const infra = resultOf(ns, "infra-error", validation.errors.join("\n\n"));
        // Post-generation exit: revert any strays the agent wrote, and record the tokens already spent.
        const confinement = await runConfine();
        persistOutcome(infra, { confinement, usage: usage.result(usageComplete, usageAttribution), phaseTimings });
        await report(app, issueRepo, sha, infra, deps, log, shadow, isCode);
        return infra;
      }
      const invalid = resultOf(ns, "invalid", validation.errors.join("\n\n"));
      const confinement = await runConfine();
      persistOutcome(invalid, { staticOk: false, confinement, usage: usage.result(usageComplete, usageAttribution), phaseTimings });
      await report(app, issueRepo, sha, invalid, deps, log, shadow, isCode, {
        note: `The generated tests did not pass the static gate (typecheck + lint + Playwright list).\n${validation.errors.join("\n")}`,
        tested: testedFrom(result),
        intent,
      });
      await foldRunLearning(invalid, { staticOk: false }); // E-STATIC must feed the flywheel too
      return invalid;
    }

    // Health pre-flight: DEV may have gone down during generation. If it is not
    // healthy the run is inconclusive → infra error, not reported as a bug.
    if (!(await devHealthy())) {
      const infra = resultOf(ns, "infra-error", "DEV is not healthy before execution");
      // Post-generation exit: revert any strays the agent wrote, and record the tokens already spent.
      const confinement = await runConfine();
      persistOutcome(infra, { confinement, usage: usage.result(usageComplete, usageAttribution), phaseTimings });
      await report(app, issueRepo, sha, infra, deps, log, shadow, isCode);
      return infra;
    }

    // Pre-reviewer feedback execute (D2/D3/D4/D5): run the assembled spec ONCE against live DEV
    // BEFORE the reviewer, so the reviewer judges a spec that has actually executed. Gated to
    // diff|manual (the commit-blast-radius modes) where the ~+15 min cost is justified. Excluded on
    // complete/exhaustive (whole-suite scans, wall-clock cost unjustified). Skipped on code-mode
    // and no-dev (handled by the outer generating && !isCode guard above and the app.dev check).
    // Gated on devReachable() so a DEV-down condition produces a SKIP (not a phantom fail →
    // phantom regen), matching spec R4. versionUrl apps use the /version health contract (same as
    // the health pre-flight). Apps without versionUrl use a bare fetch against baseUrl — any HTTP
    // response means DEV is UP; only a network failure/timeout means unreachable. REUSES
    // deps.execute() — the same Filter C machinery. Filter C (verdictual, retries:2) stays
    // byte-for-byte unchanged.
    const feedbackEligible =
      result != null && result.specs.length > 0 &&
      !!app.dev?.baseUrl &&
      (mode === "diff" || mode === "manual") &&
      (await devReachable());
    // D4: the last feedback execute result (fb or fbReExec), used as executionEvidence for
    // the reviewer. Initialized to undefined (absent on non-eligible runs: complete/exhaustive/
    // code/no-dev). After the feedback block, this holds the LAST executed result so the reviewer
    // always receives evidence from the most recent execution of the spec being reviewed.
    let lastFbRun: QaRunResult | undefined;
    if (feedbackEligible) {
      // Bump wall-clock budget to cover up to TWO feedback executes (initial + possible re-execute
      // on the fixCases path), UNLESS the app has an explicit qa.wallClockBudgetMs override (which
      // is unconditionally authoritative).
      if (!app.qa.wallClockBudgetMs) {
        wallClockBudget += 2 * e2eTimeoutMs();
      }
      const fbNs = `${ns}-fb`;
      // D4: clear any stale V8 dumps from the feedback namespace before the feedback execute so
      // they never union into the verdictual coverage measurement (coverageNs = ns, not fbNs).
      deps.clearCoverage?.(e2eDir, fbNs);
      log(`[qa] feedback execute (namespace ${fbNs}): running the assembled spec once before the reviewer...`);
      const fbT0 = Date.now();
      // Streaming callbacks omitted — feedback execute is informational, not the verdict.
      // Passing onCase/onRunning/onDiscovered would double-count discovered tests in the TUI.
      const fb = await deps.execute!(e2eDir, { baseUrl: app.dev!.baseUrl, namespace: fbNs, testIdAttribute, signal });
      addTiming("feedback-execute", Date.now() - fbT0);
      log(`[qa] feedback execute: ${fb.verdict} (${Math.round((Date.now() - fbT0) / 1000)}s)`);
      lastFbRun = fb; // D4: record as initial evidence (may be superseded by fbReExec below)

      // D3/D5: on a feedback failure that is NOT all runner-infra, do ONE bounded fixCases regen
      // to give the agent first-hand runtime evidence. Budget = 1 regen + 1 re-execute (finite,
      // not configurable). After a successful regen that passes the static gate, RE-EXECUTE the
      // regenerated spec under the same feedback namespace so the reviewer always judges an EXECUTED
      // spec — even on the failure path. On budget exhaustion or all-runner-infra, proceed to the
      // reviewer with the last assembled spec without re-executing. (FIX 1: S2 compliance)
      const fbFailed = fb.verdict === "fail" && fb.cases.some((c) => c.status === "fail");
      if (fbFailed && !allFailuresAreRunnerInfra(fb.cases) && (await devReachable())) {
        const fbFailedCases = fb.cases.filter((c) => c.status === "fail");
        log(`[qa] feedback fail: ${fbFailedCases.length} case(s) failed — regenerating via fixCases (budget=1) to surface runtime evidence...`);
        const fbDomSnapshot = buildFailureDom(fbFailedCases);
        const fbRegen = await generateOnce(baseGenInput({ fixCases: fbFailedCases, domSnapshot: fbDomSnapshot, failureSourced: !!fbDomSnapshot }));
        if (fbRegen.specs.length > 0) {
          // Re-validate the regenerated spec to ensure it still passes the static gate.
          // On static fail, keep the prior assembled spec (do NOT fail the run — Filter C judges).
          const fbValidation = await (async () => { const t0 = Date.now(); const v = await deps.validate!(e2eDir); addTiming("validate", Date.now() - t0); return v; })();
          if (fbValidation.ok) {
            result = fbRegen;
            log(`[qa] feedback regen: static gate passed after fixCases; re-executing the regenerated spec before the reviewer...`);
            // Re-execute the regenerated spec before the reviewer so it always judges a spec that has
            // EXECUTED (not just a statically-validated one). Use a FRESH per-attempt namespace (mirrors
            // the verdictual fix-loop's `retryNs`): on an app with no delete affordance the first
            // feedback run's data persists, so reusing fbNs would re-create identically-named entities
            // and inflate selector cardinality. Streaming callbacks omitted — informational, not the verdict.
            const fbReExecNs = `${fbNs}-r1`;
            deps.clearCoverage?.(e2eDir, fbReExecNs);
            const fbReExecT0 = Date.now();
            const fbReExec = await deps.execute!(e2eDir, { baseUrl: app.dev!.baseUrl, namespace: fbReExecNs, testIdAttribute, signal });
            addTiming("feedback-execute", Date.now() - fbReExecT0);
            log(`[qa] feedback re-execute (namespace ${fbReExecNs}): ${fbReExec.verdict} (${Math.round((Date.now() - fbReExecT0) / 1000)}s)`);
            lastFbRun = fbReExec; // D4: supersede initial fb with the re-execute result
          } else {
            log(`[qa] feedback regen: static gate FAILED after fixCases (${fbValidation.errors.join("; ")}); keeping prior assembled spec.`);
          }
        }
      } else if (fb.verdict === "infra-error" || allFailuresAreRunnerInfra(fb.cases)) {
        log(`[qa] feedback execute: runner-infra failure or infra-error — skipping regen, proceeding to reviewer.`);
      } else if (fbFailed) {
        // fbFailed is true but devHealthy() flipped false between the gate check and the regen guard —
        // DEV went down mid-run. Skip regen (spec R4: DEV-unreachable → skip, never fail).
        log(`[qa] feedback fail: DEV became unreachable before regen could fire — skipping feedback regen, proceeding to reviewer.`);
      }
    }

    // D1/D3: post-feedback reviewer. The reviewer now judges a spec that (on eligible runs) has
    // actually executed against DEV. On non-eligible runs (complete/exhaustive/code/no-dev) the
    // reviewer runs here too — its position relative to Filter B is unchanged in those cases.
    // Guard mirrors the existing final-review guard: only when needsReview + deps.review present.
    // D4: pass the last feedback execute result as executionEvidence so reviewGenerated can apply
    // the !executedRed gate on round 0 (deterministic #669 close).
    if (result != null && result.specs.length > 0) {
      result = await reviewGenerated(result, baseGenInput({}), { allowRegeneration: true }, lastFbRun);
    }
  } else if (deps.validateCode) {
    // 6b. Filter B for CODE mode — a compile-feedback gate. Compile the generated tests WITHOUT
    //     running them (per ecosystem, scoped to the changed module). e2e gets tsc/eslint/list; code
    //     mode previously had NOTHING, so a compile error surfaced only as an opaque whole-build
    //     failure with no structured feedback. Mirror the e2e static-fix loop: feed the (sanitized)
    //     compile errors back to the agent and re-compile, bounded. A still-red gate is `invalid`
    //     (the generated tests are broken); a broken toolchain (ENOENT/JAVA_HOME) is `infra-error`.
    onStep?.("validate");
    log("[qa] code mode: compile-checking the generated tests (no run yet)...");
    let codeValidation = await (async () => { const t0 = Date.now(); const v = await deps.validateCode!(mirrorDir, { changedFiles: intent?.changedFiles ?? [] }); addTiming("validate", Date.now() - t0); return v; })();
    let codeFixRounds = 0;
    while (
      !codeValidation.ok && !codeValidation.infra && generating &&
      codeFixRounds < MAX_STATIC_FIX_ROUNDS && !signal?.aborted
    ) {
      codeFixRounds++;
      retries++;
      log(`[qa] compile gate failed (repair ${codeFixRounds}/${MAX_STATIC_FIX_ROUNDS}); regenerating to fix:\n${codeValidation.errors.join("\n")}`);
      result = await generateAndReview(
        baseGenInput({
          reviewCorrections: [
            `The generated tests FAILED TO COMPILE. Fix EXACTLY these errors and change nothing else, then re-compile with the project's build tool to confirm a clean compile before finishing:\n${codeValidation.errors.join("\n")}`,
          ],
        }),
      );
      checkSignal();
      codeValidation = await (async () => { const t0 = Date.now(); const v = await deps.validateCode!(mirrorDir, { changedFiles: intent?.changedFiles ?? [] }); addTiming("validate", Date.now() - t0); return v; })();
    }
    if (codeFixRounds > 0 && codeValidation.ok) {
      log(`[qa] compile gate PASSED after ${codeFixRounds} repair round(s).`);
    }
    codeValidated = codeValidation.ok;
    if (!codeValidation.ok) {
      log(`[qa] compile gate failed:\n${codeValidation.errors.join("\n")}`);
      // A missing/broken toolchain (the gate itself couldn't run) is inconclusive infrastructure —
      // never an Issue blaming the agent. A real compile error is `invalid` (the generated tests are
      // broken) and feeds the flywheel, exactly like the e2e static gate.
      if (codeValidation.infra) {
        const infra = resultOf(ns, "infra-error", codeValidation.errors.join("\n\n"));
        const confinement = await runConfine();
        persistOutcome(infra, { confinement, usage: usage.result(usageComplete, usageAttribution), phaseTimings });
        await report(app, issueRepo, sha, infra, deps, log, shadow, isCode);
        return infra;
      }
      const invalid = resultOf(ns, "invalid", codeValidation.errors.join("\n\n"));
      const confinement = await runConfine();
      persistOutcome(invalid, { staticOk: false, confinement, usage: usage.result(usageComplete, usageAttribution), phaseTimings });
      await report(app, issueRepo, sha, invalid, deps, log, shadow, isCode, {
        note: `The generated tests did not compile.\n${codeValidation.errors.join("\n")}`,
        tested: testedFrom(result),
        intent,
      });
      await foldRunLearning(invalid, { staticOk: false });
      return invalid;
    }
  }

  checkSignal();
  // 7. Filter C — run the tests and classify. e2e: Playwright against DEV
  //    (pass/fail/flaky). code: the repo's own suite by exit code (pass/fail).
  let run: QaRunResult;
  if (isCode) {
    onStep?.("execute");
    log("[qa] running the repo's own test suite (code mode)...");
    run = await (async () => { const t0 = Date.now(); const r = await deps.executeCode!(mirrorDir, { namespace: ns, onCase, signal, changedFiles: intent?.changedFiles ?? [], log }); addTiming("execute", Date.now() - t0); return r; })();
  } else if (!app.dev) {
    // Defensive: an e2e run on an app with no dev environment is inconclusive.
    run = resultOf(ns, "infra-error", "e2e run requested but no dev environment is configured");
    // Post-generation exit: revert any strays the agent wrote, and record the tokens already spent.
    const confinement = await runConfine();
    persistOutcome(run, { confinement, usage: usage.result(usageComplete, usageAttribution), phaseTimings });
    await report(app, issueRepo, sha, run, deps, log, shadow, isCode);
    return run;
  } else {
    onStep?.("execute");
    log(`[qa] running E2E (namespace ${ns}) against ${app.dev.baseUrl}...`);
    deps.clearCoverage?.(e2eDir, ns); // fresh dumps only: never union a prior run's coverage
    run = await (async () => { const t0 = Date.now(); const r = await deps.execute!(e2eDir, { baseUrl: app.dev!.baseUrl, namespace: ns, testIdAttribute, onCase, onRunning: onRunningTest, onDiscovered: onTestDiscovered, signal }); addTiming("execute", Date.now() - t0); return r; })();
    // Infra vs quality: failures with an unhealthy DEV are infrastructure, not code.
    if (run.verdict === "fail" && !(await devHealthy())) {
      run = resultOf(ns, "infra-error", "failures with an unhealthy DEV: treated as infrastructure");
    }
  }

  // Re-generation on failure: feed failed cases + their failure-point DOM back to the agent.
  // The fix-loop is bounded by qa.fixLoop.maxRetries (default 2, was hard 1). A progress gate
  // (decideProgress) stops early when no deterministic signal of improvement is observed:
  //   (A) failing count decreased   (B) failing name set changed   (C) Lever-2 selector flip
  // The regression guard keeps the best round (fewest failures). The real-bug branch short-
  // circuits when all selectors resolve uniquely and the failure is a value mismatch — that
  // is an app defect, not a selector problem; file an Issue immediately.
  const MAX_RETRIES = app.qa.fixLoop?.maxRetries ?? 2;
  let prevRound: RoundResult | null = null;
  // Regression guard (W1): track the best EXECUTED run (fewest failures). A later retry that makes
  // things worse must not ship — after the loop we restore this. bestRound (progress-gate) picks the
  // fewest-failures round (ties → later), so an equal-or-better rewrite is still preferred.
  let bestRunSoFar: QaRunResult = run;
  const failCount = (r: QaRunResult): number => r.cases.filter((c) => c.status === "fail").length;
  // Flag: the real-bug branch detected a genuine app defect → skip to Issue.
  let realBugDetected = false;
  // The last adjudicator verdict — threaded into IssueContext for labeling.
  // On break-needs-human the loop exits via `if (verdict.action !== "continue") break`
  // and the Issue is labeled using adjVerdict/adjudicationCtx (needsHuman flag not needed).
  let adjVerdict: AdjudicatorVerdict | undefined;

  // The namespace whose on-disk coverage dumps correspond to the CURRENT `run`. Starts as the initial
  // execute's namespace and follows the winning run through retries: a run that goes green only on a
  // retry produced its V8 dumps under `retryNs`, and the per-retry whole-tree wipe (clearRunArtifacts
  // deletes the ENTIRE coverage tree, ignoring its namespace arg) deleted the base-ns dumps. Collecting
  // change-coverage from the base `ns` would then read an empty dir → the keystone silently lost to
  // "unknown" (which never blocks) for exactly the runs that needed fixing. Track the winner; collect
  // from it. The loop exits the instant a retry goes green (`run.verdict === "fail"` in the condition),
  // so the green run is ALWAYS the last execute — no later wipe can clobber its namespace.
  let coverageNs = ns;

  // Hoisted before the fix-loop so the filtered-retry optimization can compute
  // coverageWillMeasure inside the loop. Semantics are identical to the original
  // post-loop definition — only the position has changed.
  const covPolicy: ChangeCoveragePolicy = {
    mode: app.qa.changeCoverage?.mode ?? DEFAULT_COVERAGE_POLICY.mode,
    minRatio: app.qa.changeCoverage?.minRatio ?? DEFAULT_COVERAGE_POLICY.minRatio,
  };

  // Keystone guard: when change-coverage will be measured on this run, we must NEVER
  // filter the retry to a subset of spec files — filtering would omit the passing specs
  // and cause their lines to appear uncovered, silently undercounting coverage.
  // This mirrors the exact condition used by the coverage-collect gate (step 8 below).
  const coverageWillMeasure =
    generating && mode === "diff" && covPolicy.mode !== "off" && !triggerService;

  for (let retry = 0; retry < MAX_RETRIES && run.verdict === "fail" && generating; retry++) {
    const failed = run.cases.filter((c) => c.status === "fail");
    log(
      `[qa] ${failed.length} test(s) failed:\n` +
        failed.map((c) => `  ❌ ${c.name}${c.detail ? ` — ${c.detail.slice(0, 200)}` : ""}`).join("\n"),
    );

    // ── Lever-2 selector check (before spending the retry) ──────────────────
    // Extract proposed selectors from the generated spec sources and verify them PER CASE (C2)
    // against THAT case's own failure-point a11y tree — never a fused union, which would count a
    // node present on page A as non-unique against page B. A selector is a real contradiction only
    // when it is verifiable-ABSENT in every failed case's tree (present in none); it is non-unique
    // only when it resolves to >1 nodes within a SINGLE case's tree. Absent → contradiction folded
    // into the next prompt; non-unique → strict-mode ambiguity flag.
    const failedTrees = failed
      .map((c) => ({ case: c, lines: buildFailureDomLines(c.failureDom) }))
      .filter((t) => t.lines.length > 0);
    const haveTrees = !isCode && failedTrees.length > 0;
    // Delegate to the reusable pure core (selector-check.ts checkSpecSelectors): read the generated
    // spec sources here (file I/O stays in the orchestrator), then check their extractable selectors
    // against THIS round's per-case failure-point trees. The pure function is agnostic to the tree
    // source (per-tree, never fused) — the SAME function is reusable for a pre-execution grounding
    // check. Absent → contradiction folded into the next prompt; non-unique → strict-mode flag;
    // non-extractable (W5) / unverifiable (W3) → uniqueness indeterminate, real-bug branch held closed.
    const specSources =
      haveTrees && result != null
        ? result.specs
            .map((specFile) => join(e2eDir, specFile))
            .filter((p) => existsSync(p))
            .map((p) => readFileSync(p, "utf8"))
        : [];
    const lever2 = checkSpecSelectors(
      specSources,
      failedTrees.map((t) => t.lines),
    );
    const selectorContradictions = lever2.contradictions;
    const absentKeys = lever2.absentKeys; // structured identity of verifiable-absent selectors (W2)
    const anyVerifiedPresent = lever2.anyVerifiedPresent;
    const anyNonExtractableLocator = lever2.anyNonExtractable; // W5
    const anyUnverifiableSelector = lever2.anyUnverifiable; // W3

    // Lever-2 signal C, computed ONCE after the per-spec loop (W2): prev-round absent selectors that
    // are NOT absent this round flipped (absent→present OR absent→ambiguous — both are progress). The
    // comparison is by STRUCTURED identity (selectorKey), not human-string startsWith.
    const lever2Flips =
      prevRound && prevRound.absentSelectors.size > 0
        ? [...prevRound.absentSelectors].filter((k) => !absentKeys.has(k)).length
        : 0;

    // ── Progress gate ────────────────────────────────────────────────────────
    const curRound: RoundResult = {
      failingNames: new Set(failed.map((c) => c.name)),
      failingCount: failed.length,
      absentSelectors: absentKeys,
      lever2Flips,
      // Option (c): route navigations of the latest generation (RE-2). The first-pass round carries
      // the (expected) count, but iteration 0's gate is the baseline (prev=null) and never reads it —
      // only regen-vs-regen comparisons are gated. On the Lever-2 short-circuit (regenerate WITHOUT
      // re-executing) `run` is unchanged, so failingNames cannot differ and signal B — the only
      // consumer of this count — never fires; the count is harmlessly unused on that path.
      reexploreNavigations: result?.reexploreNavigations ?? 0,
    };
    const gate = decideProgress(prevRound, curRound);
    log(`[qa] progress gate (retry ${retry + 1}/${MAX_RETRIES}): spend=${gate.spend} — ${gate.reason}`);

    // Observability: the per-failure class (locator / timeout / value-mismatch / other), so the log
    // shows WHY the real-bug branch did or did not fire (the branch needs every failure to be a value
    // mismatch). Uses the same classifier isLikelyRealBug applies internally.
    if (!isCode && failed.length > 0) {
      const classes = failed.map((c) => `${c.name}=${classifyFailure(c.detail ?? "")}`);
      log(`[qa] failure classes: ${classes.join(", ")}`);
    }

    // Real-bug branch (C4): fire ONLY when every checked selector was PRESENT and UNIQUE — i.e. at
    // least one selector verified present, ZERO absent contradictions, AND ZERO MULTIPLE
    // contradictions — and every failure is a value mismatch. An absent selector makes allUnique
    // false (the test may simply be looking at the wrong element, not a real defect).
    // W5: a non-extractable locator (getByTestId/.locator()/getByPlaceholder/…) anywhere in the spec
    // makes uniqueness INDETERMINATE — the verified getByRole set is not the full locator set, so a
    // value mismatch cannot be safely attributed to an app defect. Hold allUnique false → no misfire.
    // W3: likewise an UNVERIFIABLE extracted selector (role in no tree / only a `(present)` marker) is
    // never confirmed present, so a decorative present-unique getByRole must not make allUnique true
    // on its own — require EVERY extracted selector to have been verifiable.
    const allUnique =
      anyVerifiedPresent &&
      absentKeys.size === 0 &&
      !anyNonExtractableLocator &&
      !anyUnverifiableSelector &&
      !selectorContradictions.some((c) => c.includes("MULTIPLE"));
    // ── Failure adjudicator (single decision point) ──────────────────────────
    // Replaces the two ad-hoc `isLikelyRealBug` and `!gate.spend` branches with a
    // single pure adjudicate() call. The function is deterministic and never throws.
    //
    // Intentional fresh check: this devHealthy() call is the decision-point snapshot
    // (Rule 2 — dev_infra class). The separate call at ~2167 (pre-retry-execute) is
    // also fresh and intentional — DEV may drop between these two points (e.g. during
    // LLM regeneration). Do NOT share or memoize these two results.
    const devHealthyNow = isCode ? true : await devHealthy();
    const evidence: AdjudicatorEvidence = {
      isCode,
      allUnique,
      failureDetails: failed.map((c) => c.detail ?? ""),
      failureClasses: failed.map((c) => classifyFailure(c.detail ?? "")),
      absentKeysCount: absentKeys.size,
      gateSpend: gate.spend,
      gateReason: gate.reason,
      devHealthy: devHealthyNow,
      mode,
      objectiveSource:
        mode === "diff"
          ? (intent?.changedFiles ?? [])
          : (opts.guidance ? [opts.guidance] : []),
      failingFiles: failed.map((c) => c.file),
      httpStatuses: failed.map((c) => c.httpStatus),
    };
    const verdict = adjudicate(evidence);
    adjVerdict = verdict;
    log(
      `[qa] adjudicator: class=${verdict.class} confidence=${verdict.confidence} action=${verdict.action} — ${gate.reason}`,
    );
    switch (verdict.action) {
      case "break-issue":
        if (
          verdict.class === ADJ_CLASS.RUNNER_INFRA ||
          verdict.class === ADJ_CLASS.DEV_INFRA
        ) {
          // Infra failure: route to infra-error, never open a repo Issue.
          run = resultOf(ns, "infra-error", verdict.reason);
        } else {
          // App defect or other non-infra break: reuse the proven Issue-filing flag.
          realBugDetected = true;
        }
        break;
      case "break-needs-human":
        // The loop exits via the `if (verdict.action !== "continue") break` guard below.
        // adjVerdict is already set; the Issue will be labeled via adjudicationCtx.
        break;
      case "continue":
        break;
    }
    if (verdict.action !== "continue") break; // exit the fix-loop on any break-* action

    prevRound = curRound;

    // ── Regeneration ─────────────────────────────────────────────────────────
    // Build the failure-point DOM block (header + the case's tree, prompt-size-capped) as the
    // authoritative grounding for the regeneration prompt.
    const failureDomSnapshot = buildFailureDom(failed);

    // Thread Lever-2 contradictions as their OWN field (W1) — NOT folded into the fixCases detail.
    // The fix prompt renders `c.detail?.slice(0, 500)`; verbose PW 1.60 errors fill those 500 chars,
    // so a contradiction appended to detail was truncated away exactly when an absent selector was
    // found — silencing the deterministic compliance-wall closer. buildPrompt now renders these
    // un-truncated in a dedicated section next to the GROUND TRUTH block.
    log("[qa] re-generating with failure feedback...");
    onStep?.("retry");
    retries++;
    result = await generateAndReview(
      baseGenInput({
        fixCases: failed,
        ...(selectorContradictions.length > 0 ? { selectorContradictions } : {}),
        domSnapshot: failureDomSnapshot,
        ...(failureDomSnapshot ? { failureSourced: true } : {}),
      }),
      { review: "skip" },
    );
    if (result.specs.length > 0) {
      const entries = result.specMetas?.length
        ? result.specMetas.map((m) => ({ name: m.file, flow: m.flow, objective: m.objective }))
        : result.specs.map((s) => ({ name: s }));
      onSpecs?.(entries);
    }
    log(
      `[qa] agent (retry): approved=${result.approved} specs=[${result.specs.join(", ")}]` +
        (result.note ? ` note=${result.note}` : ""),
    );

    if (result.specs.length === 0) {
      log("[qa] retry agent produced no fixes; keeping original verdict.");
      break;
    }

    // T2 (design §1.5b): when Lever-2 proved a selector ABSENT (verifiable), the contradiction is
    // already folded into the prompt above — skip the wasted re-validate+re-execute for THIS round
    // and loop straight to the next regeneration. The next iteration re-checks the new spec against
    // the SAME (unchanged) failure trees: if the absent selector is now present, Lever-2 signal C
    // fires (gate spends) and we DO re-execute; if it is still absent and nothing else moved, the
    // gate stops the loop. Bounded by the same cap (the for-header) and gate; counts against budget.
    if (!isCode && absentKeys.size > 0) {
      log(`[qa] Lever-2 short-circuit: ${absentKeys.size} selector(s) verifiably absent — regenerated WITHOUT re-executing; re-checking against the known failure tree next round.`);
      continue;
    }

    if (isCode) {
      // Re-compile the regenerated tests before re-running (mirror e2e's re-validate). A regen that
      // broke compilation must not silently re-run the prior/partial suite — keep the prior verdict.
      if (deps.validateCode) {
        const reCompile = await (async () => { const t0 = Date.now(); const v = await deps.validateCode!(mirrorDir, { changedFiles: intent?.changedFiles ?? [] }); addTiming("validate", Date.now() - t0); return v; })();
        if (!reCompile.ok) {
          log(`[qa] retry compile gate failed; keeping the prior verdict:\n${reCompile.errors.join("\n")}`);
          break;
        }
      }
      log("[qa] re-running the repo's test suite with the fixed tests...");
      run = await (async () => { const t0 = Date.now(); const r = await deps.executeCode!(mirrorDir, { namespace: ns, onCase, signal, changedFiles: intent?.changedFiles ?? [], log }); addTiming("execute", Date.now() - t0); return r; })();
    } else {
      // Re-validate the fixed specs and, if they pass, re-execute against DEV.
      onStep?.("validate");
      const reValidation = await (async () => { const t0 = Date.now(); const v = await deps.validate(e2eDir); addTiming("validate", Date.now() - t0); return v; })();
      if (!reValidation.ok) {
        log(`[qa] retry validation failed:\n${reValidation.errors.join("\n")}`);
        break;
      }
      if (!(await devHealthy())) {
        log("[qa] DEV unhealthy before retry execution; keeping original verdict.");
        break;
      }
      log("[qa] re-running E2E with fixed tests...");
      // Fresh DATA namespace per retry. Apps whose backend has no delete (e.g. Spring PetClinic — the
      // cleanup fixture's DELETE 404s) cannot remove the data a spec created. Re-executing the SAME spec
      // under the SAME namespace then makes the retry collide with its OWN prior attempt's records (a
      // second "qa-bot-<ns>-owner" → strict-mode), failing a spec that is actually CORRECT — which is
      // exactly what masked an otherwise-green suite as `fail`. A per-attempt namespace keeps each
      // retry's created data uniquely scoped, so a correct spec passes on re-run regardless of cleanup.
      const retryNs = `${ns}-r${retry + 1}`;
      deps.clearCoverage?.(e2eDir, retryNs);
      onStep?.("execute");

      // Filtered-retry optimization: if ALL currently-failing cases carry a `.file`
      // basename, AND all newly-written spec files are within that failing set (i.e.
      // the regen didn't widen the scope), AND change-coverage will NOT be measured
      // (which requires a full-suite run to count every covered line), then scope the
      // Playwright spawn to only the spec files that had failures — skipping
      // already-passing specs and cutting E2E time on large suites.
      const failedSpecFiles = [
        ...new Set(
          run.cases
            .filter((c) => c.status === "fail" && c.file)
            .map((c) => c.file as string),
        ),
      ];
      const allFailedHaveFile = run.cases.filter((c) => c.status === "fail").every((c) => !!c.file);
      // result.specs are the basenames the agent reported writing/updating this cycle. The ONLY way a
      // filtered retry can ship a broken spec as green is the PARTIAL case: the regen rewrote a
      // previously-passing spec (an OUTSIDER) into a broken state AND fixed the failing specs (an
      // OVERLAP, so the failing files now pass and the suite goes green) — the outsider would never be
      // re-run and would ship stale-green. Block filtering there. A regen entirely DISJOINT from the
      // failed set (outsiders, no overlap) cannot produce a false green: the failing specs were not
      // fixed, so they re-fail and the run stays red — safe to filter.
      const regenSpecBasenames = (result?.specs ?? []).map((s) => s.replace(/.*\//, "").replace(/.*\\/, ""));
      const regenHasOverlap = regenSpecBasenames.some((b) =>
        failedSpecFiles.some((f) => f === b || f.endsWith(`/${b}`) || f.endsWith(`\\${b}`)),
      );
      const regenHasOutsiders = regenSpecBasenames.some(
        (b) => !failedSpecFiles.some((f) => f === b || f.endsWith(`/${b}`) || f.endsWith(`\\${b}`)),
      );
      // True when the regen did NOT introduce new specs outside the failing set.
      const regenStayedInFailedSet = !(regenHasOverlap && regenHasOutsiders);
      const canFilter =
        allFailedHaveFile &&
        failedSpecFiles.length > 0 &&
        regenStayedInFailedSet &&
        !coverageWillMeasure;

      if (canFilter) {
        log(`[qa] retry filtered: scoping re-run to ${failedSpecFiles.length} spec file(s): ${failedSpecFiles.join(", ")}`);
      }

      const retryRun = await (async () => { const t0 = Date.now(); const r = await deps.execute!(e2eDir, { baseUrl: app.dev?.baseUrl ?? "", namespace: retryNs, testIdAttribute, onCase, onRunning: onRunningTest, signal, ...(canFilter ? { specFiles: failedSpecFiles } : {}) }); addTiming("execute", Date.now() - t0); return r; })();
      if (retryRun.verdict === "fail" && !(await devHealthy())) {
        run = resultOf(ns, "infra-error", "failures with an unhealthy DEV: treated as infrastructure");
        break;
      }
      if (canFilter) {
        // Merge: the filtered retry only ran the failing spec FILES. Carry forward every prior case
        // from files that were NOT re-run (preserving their pass/flaky/skipped status); the retry
        // supplies fresh results for the re-run files. Keying by file (not by "pass") avoids both
        // double-counting a passing test that shares a re-run file with a failing one, and dropping a
        // flaky case in a non-re-run file (which would silently downgrade the run from flaky → pass).
        const rerunFileSet = new Set(failedSpecFiles);
        const carriedForward = run.cases.filter((c) => !(c.file && rerunFileSet.has(c.file)));
        const mergedCases = [...carriedForward, ...retryRun.cases];
        const mergedVerdict: typeof retryRun.verdict =
          mergedCases.some((c) => c.status === "fail")
            ? "fail"
            : mergedCases.some((c) => c.status === "flaky")
              ? "flaky"
              : "pass";
        run = { ...retryRun, cases: mergedCases, verdict: mergedVerdict, passed: mergedVerdict === "pass" };
      } else {
        run = retryRun;
      }
      coverageNs = retryNs; // the green dumps now live under retryNs; collect change-coverage from here
    }
    log(`[qa] retry verdict: ${run.verdict}`);

    // Regression guard (W1): keep the best EXECUTED run seen so far (fewest failures). bestRound's
    // tie-break prefers the later round, so an equal rewrite still wins — only a strictly-worse retry
    // is discarded. infra-error is never "better" (it has no test cases to count as a fix).
    if (run.verdict !== "infra-error") {
      bestRunSoFar = bestRound([
        { failingCount: failCount(bestRunSoFar), run: bestRunSoFar },
        { failingCount: failCount(run), run },
      ])!.run;
    }
  }

  // Regression guard (W1): restore the best executed run AFTER the loop, so a worse terminal retry
  // never ships. Skip when the real-bug branch fired (the current fail run must reach the Issue) or
  // when the loop ended on infra-error (that verdict must stand).
  if (!realBugDetected && run.verdict !== "infra-error" && failCount(bestRunSoFar) < failCount(run)) {
    log(`[qa] regression guard: discarding the final retry (${failCount(run)} failing) for an earlier better run (${failCount(bestRunSoFar)} failing).`);
    run = bestRunSoFar;
  }

  // The real-bug branch overrides the verdict so the decide step files an Issue.
  if (realBugDetected && run.verdict !== "infra-error") {
    // Keep run as "fail" so the decide step (below) opens an Issue.
    log("[qa] real-bug override: run kept as fail for Issue filing.");
  }

  if (run.verdict === "pass" && generating && result && app.qa.needsReview && deps.review && !result.reviewed) {
    log("[qa] final independent review of fixed suite (no corrective regeneration before publish)...");
    result = await reviewGenerated(result, baseGenInput({}), { allowRegeneration: false });
  }

  // NOTE: the green-path write-confinement guard runs LATER — after the change-coverage block, just
  // before the decide/publish step. In `enforce` mode a coverage gap triggers ANOTHER generation
  // (below), which can write fresh strays; reverting here would miss them and ship them in the PR.
  // Deferring to after the LAST generation keeps the revert (and the persisted result) fresh.

  // 8. Filter D — change-coverage (the value keystone). Only for a per-commit DIFF run whose
  //    suite is GREEN: does executing the tests actually exercise the lines the commit changed?
  //    Skipped when no provider is wired (unit tests) or the policy is off. Unmeasured coverage is
  //    "unknown" and NEVER blocks (determinism over zeal). signal = record only; enforce = try once
  //    to close the gap, then block publishing if it stays below the threshold.
  // covPolicy is hoisted above the fix-loop — see declaration above.
  let coverageStatus: "pass" | "fail" | "unknown" = "unknown";
  let coverageSummary = "";
  let ccForPersistence: ChangeCoverage | undefined;
  // The change-coverage skip log fires only when coverage WAS configured — otherwise apps
  // without a coverage provider would log a misleading "skipped" on every cross-repo pass run.
  if (triggerService && mode === "diff" && run.verdict === "pass" && deps.collectCoverage && covPolicy.mode !== "off") {
    log(`[qa] change-coverage: skipped — the changed lines live in ${triggerService.repo}; browser coverage maps only the frontend (status=unknown).`);
  }
  if (deps.collectCoverage && generating && mode === "diff" && run.verdict === "pass" && covPolicy.mode !== "off" && !triggerService) {
    // FIX 8a: parse the CAPPED promptDiff (what the agent actually saw), not the raw diff. When a huge
    // diff is capped for the prompt, the agent never saw the dropped hunks — demanding coverage of
    // lines it could not have known about would be an unfair, unwinnable gate (and would mislabel a
    // green run as a coverage gap). Coverage now scopes to exactly the changed lines the agent saw.
    const changed = parseDiffHunks(promptDiff);
    if (changed.size > 0) {
      onStep?.("coverage");
      const changedFiles = [...changed.keys()];
      const collect = (): Promise<CoveredLines | null> =>
        deps.collectCoverage!({ target: isCode ? "code" : "e2e", repoDir: mirrorDir, e2eDir, changedFiles, namespace: coverageNs });
      const _covT0 = Date.now();
      const collected = await collect();
      const collectedBranches = deps.collectBranchCoverage
        ? await deps.collectBranchCoverage({ target: isCode ? "code" : "e2e", repoDir: mirrorDir, e2eDir, changedFiles, namespace: coverageNs })
        : null;
      addTiming("coverage", Date.now() - _covT0);
      let cc = computeChangeCoverage(changed, collected ?? new Map(), collectedBranches ?? undefined);
      ccForPersistence = cc;
      coverageStatus = decideCoverage(cc, covPolicy);
      log(`[qa] change-coverage: ${coverageStatus} — ${cc.overall.coveredChanged}/${cc.overall.changedLines} changed lines (${(cc.overall.ratio * 100).toFixed(0)}%, policy=${covPolicy.mode}, min=${Math.round(covPolicy.minRatio * 100)}%)`);
      if (cc.branches) log(`[qa] branch-coverage: ${cc.branches.takenBranches}/${cc.branches.changedBranches} branches on changed lines (${(cc.branches.ratio * 100).toFixed(0)}%)`);
      // Surface a number to the TUI ONLY when coverage was actually measured. A null
      // collection (e.g. an ecosystem whose suite produced no report) must read as
      // "unmeasured" — never a misleading 0/N (0%).
      if (collected !== null) onCoverage?.(cc.overall.changedLines, cc.overall.coveredChanged);

      // enforce: ONE attempt to close the gap (regenerate targeting the uncovered lines → re-run).
      if (coverageStatus === "fail" && covPolicy.mode === "enforce") {
        log(`[qa] enforce: attempting to close the coverage gap.\n[qa] ${renderUncovered(cc)}`);
        checkSignal();
        const improved = await generateAndReview(baseGenInput({ coverageGap: renderUncovered(cc) }));
        if (improved.specs.length > 0 && improved.approved) {
          const okStatic = isCode
            ? deps.validateCode
              ? await (async () => { const t0 = Date.now(); const v = await deps.validateCode!(mirrorDir, { changedFiles: intent?.changedFiles ?? [] }); addTiming("validate", Date.now() - t0); return v; })()
              : { ok: true, errors: [] }
            : await (async () => { const t0 = Date.now(); const v = await deps.validate!(e2eDir); addTiming("validate", Date.now() - t0); return v; })();
          if (okStatic.ok && (isCode || (await devHealthy()))) {
            if (!isCode) deps.clearCoverage?.(e2eDir, ns); // re-measure only the improved suite's dumps
            coverageNs = ns; // the enforce re-execute below runs under `ns`; align the re-collection
            const reRun = isCode
              ? await (async () => { const t0 = Date.now(); const r = await deps.executeCode!(mirrorDir, { namespace: ns, onCase, signal, changedFiles: intent?.changedFiles ?? [], log }); addTiming("execute", Date.now() - t0); return r; })()
              : await (async () => { const t0 = Date.now(); const r = await deps.execute!(e2eDir, { baseUrl: app.dev?.baseUrl ?? "", namespace: ns, testIdAttribute, onCase, onRunning: onRunningTest, signal }); addTiming("execute", Date.now() - t0); return r; })();
            if (reRun.verdict === "pass") {
              run = reRun;
              result = improved;
              const reCollected = await collect();
              const reBranches = deps.collectBranchCoverage
                ? await deps.collectBranchCoverage({ target: isCode ? "code" : "e2e", repoDir: mirrorDir, e2eDir, changedFiles, namespace: coverageNs })
                : null;
              cc = computeChangeCoverage(changed, reCollected ?? new Map(), reBranches ?? undefined);
              coverageStatus = decideCoverage(cc, covPolicy);
              log(`[qa] change-coverage after improvement: ${coverageStatus} (${(cc.overall.ratio * 100).toFixed(0)}%)`);
              if (reCollected !== null) onCoverage?.(cc.overall.changedLines, cc.overall.coveredChanged);
            }
          }
        }
      }
      if (coverageStatus === "fail") coverageSummary = renderUncovered(cc);

      // Observability: "unknown" because the suite produced V8 dumps that mapped to NONE
      // of the changed files is a STRUCTURAL NO-OP (a bundled/minified deploy whose asset
      // URLs don't resolve to repo source AND whose source maps the keystone could not
      // recover, or specs not importing ./fixtures) — the keystone is silently protecting
      // nothing. Surface it loudly instead of the benign "unknown".
      if (coverageStatus === "unknown" && !isCode && deps.hasCoverageDumps?.(e2eDir, coverageNs)) {
        log(
          `[qa] ⚠️  CHANGE-COVERAGE INACTIVE — Playwright ran and produced coverage data, ` +
            `but the V8 script URLs (hashed bundles like /assets/index-abc123.js) did not ` +
            `match any of the ${changedFiles.length} changed source file(s), and no usable ` +
            `source map was available to recover the mapping.`,
        );
        log(
          `[qa]    CAUSE: DEV is serving bundled/minified assets without source maps. The ` +
            `keystone maps a bundle back to repo source via its source map; with neither a ` +
            `direct URL match nor a source map, coverage measurement is non-functional.`,
        );
        // Lead with the source-map fix: it is the keystone's designed activation path, so a
        // realistic bundled DEV deploy (Angular/Spring) can keep its bundle and still measure.
        log(
          `[qa]    FIX: Enable source maps on the DEV build so the keystone can map bundle → ` +
            `source. Angular: \`ng build --source-map\` (or "sourceMap": true in the DEV ` +
            `configuration). Vite/webpack: set build.sourcemap=true. Alternatively serve ` +
            `unbundled source. This does NOT block the run — tests are still generated and published.`,
        );
      }
    }
  }

  // ── Value learning (off-path, PIPE-02) ──────────────────────────────────────
  // Oracle ground-truth → attribution → curriculum credit, plus suite-level measured persistence.
  // Extracted to foldValueLearning so the deterministic state machine above is not interleaved with
  // the non-deterministic learning side-effects. Fail-open; the score never gates publish.
  const valueLearned = await foldValueLearning({
    deps, app, run, isCode, generating, mode, mirrorDir, e2eDir, ns, diff, sha,
    runId: opts.runId, signal, retrievedRuleIds, retrievedRules, curriculum,
    changedFiles: intent?.changedFiles ?? [],
    ccForPersistence, specMetas: result?.specMetas, log, addTiming,
  });
  const valueScore = valueLearned.valueScore;
  curriculum = valueLearned.curriculum;

  // Write-confinement guard on the green path — run here, AFTER the last generation (past any
  // coverage-enforce regeneration above), so it reverts strays from that regen too and the persisted
  // result is fresh, BEFORE the decide/publish step ships the suite. Detect + revert agent strays
  // (out-of-area writes git status surfaces; symlink escapes detected + the link entry reverted) so a
  // stray never reaches the suite PR. Non-blocking — the verdict is unchanged. runConfine() runs the
  // guard exactly once on the green path (the earlier exits already returned), so green is never
  // double-run.
  const confinement = await runConfine();

  // RE-3: dispose the continued generator session — all regeneration is done by this point (the
  // impl's self-dispose deadline covers the early-return/throw paths above). Safe if never opened.
  if (genSession) {
    await genSession.dispose().catch((e) => log(`[qa] generator session dispose failed: ${e instanceof Error ? e.message : String(e)}`));
    genSession = null;
  }

  // 9. Final decision.
  const kind = isCode ? "code" : "E2E";

  // ── specTriage dual decide-step (quality-filtered-dual-publish) ──────────────
  // Activated only when: generating + !isCode + qa.specTriage=true + deps.publishSubset wired.
  // Flag OFF or undefined → TODAY'S EXACT CODE (verbatim, zero behavioral diff on the flag-OFF path).
  if (generating && !isCode && (app.qa.specTriage ?? false) && deps.publishSubset) {
    // Recompute per-file selector-presence at decide time from run.cases[].failureDom via the pure
    // helper (Option B from the design: recompute from the winning run, not thread out of the loop).
    const specSourcesByFile: Record<string, string[]> = {};
    if (result?.specs) {
      for (const specFile of result.specs) {
        const specPath = join(e2eDir, specFile);
        if (existsSync(specPath)) {
          const src = readFileSync(specPath, "utf8");
          // QaCase.file is the basename; specFile may have subdirs (flows/x.spec.ts)
          const basename = specFile.includes("/") ? specFile.split("/").pop()! : specFile;
          specSourcesByFile[specFile] = [src];
          if (basename !== specFile) specSourcesByFile[basename] = [src]; // also by basename
        }
      }
    }
    const presenceByFile = perFileSelectorPresence(run.cases, specSourcesByFile);

    // Parse reviewer corrections for GRAVE attribution
    const allSpecFiles = [...new Set(run.cases.map((c) => c.file).filter((f): f is string => f !== undefined))];
    const correctionStrings = reviewerCorrections;
    const graveByFile = attributeCorrections(correctionStrings, allSpecFiles);

    // Detect if any GRAVE came from an unattributable correction (conservative: demote to ISSUE, not DROP)
    const hasUnattributableGrave =
      correctionStrings.length > 0 &&
      correctionStrings.some((c) => {
        const tagMatch = /^\s*\[([a-z][a-z-]*)\]/i.exec(c as string);
        if (!tagMatch) return false;
        const tag = tagMatch[1]!.toLowerCase();
        // GRAVE_TAGS doesn't include fragile-selector
        const isGraveTag = tag !== "fragile-selector" && /^(false-positive|wrong-objective|no-cleanup)$/.test(tag);
        if (!isGraveTag) return false;
        const afterTag = (c as string).slice(tagMatch[0].length).trim();
        return !/^[^\s:]+\.spec\.ts/i.test(afterTag); // no filename token → unattributable
      });

    const triageInput = {
      cases: run.cases,
      presenceByFile,
      graveByFile,
      mode,
      objectiveSource: mode === "diff" ? (intent?.changedFiles ?? []) : (opts.guidance ? [opts.guidance] : []),
      allFilesGraveUnattributable: hasUnattributableGrave,
    };
    const t = triagePublish(triageInput);

    log(
      `[qa] specTriage: pr=[${t.pr.join(", ")}] issue=[${t.issue.map((v) => v.file).join(", ")}] drop=[${t.drop.join(", ")}]`,
    );

    // ── PR side (green subset) ────────────────────────────────────────────────
    const outcomeparts: string[] = [];
    let prFiles = [...t.pr];

    // Spec-Req-4: a PR-bucket spec importing a sibling that will NOT be published (an issue/drop
    // file) would dangle once that sibling is excluded from the commit → the committed subset would
    // not compile. Demote such importers to ISSUE so a broken subset is never published. The
    // whole-suite static gate already passed pre-decide; this is the only new failure subsetting adds.
    const unpublishedSpecFiles = [...t.issue.map((v) => v.file), ...t.drop];
    const danglingPr = findDanglingPrSpecs(prFiles, unpublishedSpecFiles, (f) => {
      try {
        return readFileSync(join(e2eDir, f), "utf8");
      } catch {
        return null;
      }
    });
    if (danglingPr.length > 0) {
      prFiles = prFiles.filter((f) => !danglingPr.includes(f));
      log(`[qa] specTriage: ${danglingPr.length} PR spec(s) demoted to ISSUE (dangling import to a non-published spec) — ${danglingPr.join(", ")}`);
    }

    if (prFiles.length > 0) {
      if (app.qa.needsReview && !result!.approved) {
        // Reviewer rejected → demote all PR-bucket files to ISSUE (same gate as today)
        const issueFiles = prFiles;
        prFiles = [];
        const url = await issueOrShadow(
          shadow, deps, log, issueRepo,
          `QA: the reviewer did not approve the ${kind} tests for ${sha}`,
          renderIssue(run, { note: result!.note, tested: testedFrom(result), intent }),
        );
        outcomeparts.push(outcomeForIssue(url, "Issue filed (reviewer rejected the suite)"));
        log(`[qa] specTriage: PR subset demoted to ISSUE (reviewer rejection) — files: ${issueFiles.join(", ")}`);
      } else if (blocksPublish(coverageStatus, covPolicy)) {
        // Coverage gate holds the PR-bucket subset (enforce mode, same as today)
        prFiles = [];
        const url = await issueOrShadow(
          shadow, deps, log, issueRepo,
          `QA: ${kind} tests for ${sha} are below the change-coverage threshold`,
          renderIssue(run, { note: coverageSummary || result?.note, tested: testedFrom(result), intent }),
        );
        outcomeparts.push(outcomeForIssue(url, "Issue filed (below the change-coverage threshold)"));
        log(`[qa] specTriage: PR subset held (coverage gate)`);
      } else if (shadow) {
        log(`[qa] (shadow) specTriage: would open PR for subset [${prFiles.join(", ")}]`);
        outcomeparts.push(`shadow · would open subset PR for [${prFiles.join(", ")}]`);
        prFiles = []; // no real publish in shadow
      } else {
        const prInput = {
          repo: app.repo, sha, mirrorDir,
          baseBranch: app.baseBranch ?? "main",
          parentRunId: opts.parentRunId,
          tested: testedFrom(result),
        };
        const pr = await deps.publishSubset(prInput, prFiles);
        if (!pr) {
          outcomeparts.push("subset already in base — no PR");
          log("[qa] specTriage: subset has no diff — no PR opened.");
        } else if (pr.error) {
          outcomeparts.push(`subset tests ready but publish FAILED (${pr.error}); verdict preserved`);
          log(`[qa] specTriage: subset publish FAILED — tests committed locally but did NOT land.`);
          if (!run.note) run.note = `subset publish failed: ${pr.error}`;
        } else {
          outcomeparts.push(pr.merged ? `subset PR merged · ${pr.prUrl}` : `subset PR opened · ${pr.prUrl}`);
          log(pr.merged ? `[qa] OK — specTriage subset PR merged: ${pr.prUrl}` : `[qa] OK — specTriage subset PR opened: ${pr.prUrl}`);
        }
      }
    }

    // ── ISSUE side (real-bug + ambiguous subset + PR specs demoted for dangling imports) ──
    const allIssueFiles = [...t.issue.map((v) => v.file), ...danglingPr];
    if (allIssueFiles.length > 0) {
      const issueTitle = `QA: ${kind} tests for ${sha} found failures in ${allIssueFiles.length} spec file(s)`;
      const issueBody = renderIssue(run, {
        note: `Files with failures: ${allIssueFiles.join(", ")}\n\n` + (result?.note ?? ""),
        tested: testedFrom(result),
        intent,
        adjudication: adjVerdict ? { class: adjVerdict.class, reason: adjVerdict.reason } : undefined,
      });
      if (shadow) {
        log(`[qa] (shadow) specTriage: would file Issue for [${allIssueFiles.join(", ")}]`);
        outcomeparts.push(`shadow · would file Issue for [${allIssueFiles.join(", ")}]`);
      } else {
        const url = await issueOrShadow(false, deps, log, issueRepo, issueTitle, issueBody);
        outcomeparts.push(outcomeForIssue(url, `Issue filed (failures in: ${allIssueFiles.join(", ")})`));
      }
    }

    // ── DROP side (log + outcome note) ────────────────────────────────────────
    if (t.drop.length > 0) {
      const dropReasons = t.drop.map((f) => `${f}: ${t.reasons[f] ?? "dropped"}`).join("; ");
      log(`[qa] specTriage: dropped ${t.drop.length} file(s) — ${dropReasons}`);
      outcomeparts.push(`dropped: ${t.drop.join(", ")}`);
    }

    run.outcome = outcomeparts.join(" · ") || "specTriage: no action (all files dropped or no changes)";
  } else {
    // ── TODAY'S EXACT PATH (verbatim — flag OFF or code mode or no publishSubset dep) ──
    if (run.verdict !== "pass") {
      const adjudicationCtx: AdjudicationLabel | undefined = adjVerdict
        ? { class: adjVerdict.class, reason: adjVerdict.reason }
        : undefined;
      await report(app, issueRepo, sha, run, deps, log, shadow, isCode, { note: result?.note, tested: testedFrom(result), intent, adjudication: adjudicationCtx });
    } else if (!generating) {
      // Regression passed: there are no new tests to publish.
      log(`[qa] OK — regression green for ${sha}.`);
    } else if (app.qa.needsReview && !result!.approved) {
      // Green in the harness BUT the independent reviewer rejected it (it catches
      // false positives the harness cannot) → do not publish; report for iteration.
      const url = await issueOrShadow(
        shadow,
        deps,
        log,
        issueRepo,
        `QA: the reviewer did not approve the ${kind} tests for ${sha}`,
        renderIssue(run, { note: result!.note, tested: testedFrom(result), intent }),
      );
      run.outcome = outcomeForIssue(url, "Issue filed (reviewer rejected the suite)");
    } else if (blocksPublish(coverageStatus, covPolicy)) {
      // Green AND reviewer-approved, but the tests do not exercise enough of the change (enforce):
      // do NOT publish a suite that would not catch a regression in the changed code.
      const url = await issueOrShadow(
        shadow,
        deps,
        log,
        issueRepo,
        `QA: ${kind} tests for ${sha} are below the change-coverage threshold`,
        renderIssue(run, { note: coverageSummary || result?.note, tested: testedFrom(result), intent }),
      );
      run.outcome = outcomeForIssue(url, "Issue filed (below the change-coverage threshold)");
    } else if (shadow) {
      log(`[qa] (shadow) ${kind} green; a suite PR would have been opened.`);
      run.outcome = "shadow · would open an auto-merge suite PR";
    } else {
      const prInput = { repo: app.repo, sha, mirrorDir, baseBranch: app.baseBranch ?? "main", parentRunId: opts.parentRunId, tested: testedFrom(result) };
      const pr = isCode ? await deps.publishCode(prInput) : await deps.publish(prInput);
      run.outcome = !pr
        ? "green — the suite already covers the change, no PR"
        : pr.error
          ? `green — tests ready but publish FAILED (${pr.error}); verdict preserved, re-run or publish manually`
          : pr.merged
            ? `suite PR merged · ${pr.prUrl}`
            : `suite PR opened — NOT auto-merged, merge it manually · ${pr.prUrl}`;
      if (pr?.error && !run.note) run.note = `tests passed but publish failed: ${pr.error}`;
      log(
        !pr
          ? `[qa] OK — ${kind} green (no new tests to publish).`
          : pr.error
            ? `[qa] ${kind} green but publish FAILED — the tests are committed locally but did NOT land; verdict preserved.`
            : pr.merged
              ? `[qa] OK — ${kind} green; suite PR merged: ${pr.prUrl}`
              : `[qa] OK — ${kind} green; suite PR opened but NOT merged (merge it manually): ${pr.prUrl}`,
      );
    }
  }
  // Surface the agent's note (reviewer rejection, generation summary) in the
  // result so the TUI/chat can show why a retry or skip happened.
  if (result?.note && !run.note) run.note = result.note;

  // Persist the ratio ONLY when coverage was actually measured. An unmeasured run
  // (no source map → bundled/hashed assets, or no coverage artifact) yields ratio 0
  // with measured:false; persisting that 0 would mislabel a genuinely-unmeasured green
  // run as E-COVERAGE-GAP (taxonomy) and poison the learning ledger — precisely on the
  // apps where coverage is not yet measurable. null = "not measured", never a gap.
  const ratio = ccForPersistence?.measured ? ccForPersistence.overall.ratio : null;
  // Append the run's MEASURED value signals to the outcome so the operator sees what the run
  // was WORTH — not just that it finished. Same signals persisted to the RunOutcome (the value
  // keystone's coverage + the oracle score). Flows to the TUI summary via the run.verdict event
  // and to the CLI report. Empty for an unmeasured run, so a clean outcome stays clean.
  if (run.outcome) {
    run.outcome += renderValueTag({
      coverageRatio: ratio,
      coverageMeasured: ccForPersistence?.measured ?? false,
      coveragePolicy: covPolicy.mode,
      valueScore,
      reviewerApproved: app.qa.needsReview ? (result?.approved ?? null) : null,
      reviewerRationale,
    });
  }
  persistOutcome(run, { staticOk: generating && (isCode ? codeValidated : true), coverageRatio: ratio, valueScore, rulesRetrieved: retrievedRuleIds, confinement, usage: usage.result(usageComplete, usageAttribution), phaseTimings });

  // Reviewer-corrections distillation, labeling, prevention governance, reflection and
  // curriculum persistence — shared with the static-gate (`invalid`) early return above.
  await foldRunLearning(run, { staticOk: generating && (isCode ? codeValidated : true), coverageRatio: ratio, valueScore });

  return run;
}

function resultOf(ns: string, verdict: QaRunResult["verdict"], logs: string, note?: string): QaRunResult {
  return { sha: ns, verdict, passed: verdict === "pass", cases: [], logs, note };
}

// Max "role: name" lines per case in the regeneration PROMPT (not the stored tree). The cap is
// applied HERE, on the readable block, so a huge tree does not blow the prompt — while Lever-2 still
// checks selectors against the FULL stored line set (capDomLines keeps every table/list node, so a
// data table is never the thing that gets truncated away).
const FAILURE_DOM_PROMPT_MAX_LINES = 80;

// Builds the failure-point DOM block for the regeneration prompt from failed cases' failureDom.
// Each case becomes a header + its captured a11y tree (size-capped, table-preserving). Returns
// undefined when no failed case carries a failureDom (blind-fix fallback).
//
// failureDom is the RAW parseAriaSnapshot line set ("role: name", "\n"-joined) that execute.ts
// stores — already human-readable, so we present it directly; we only ADD the header and apply the
// prompt-size cap here (never on the stored tree, which Lever-2 needs complete).
export function buildFailureDom(cases: QaCase[]): string | undefined {
  const parts: string[] = [];
  for (const c of cases) {
    if (!c.failureDom) continue;
    const lines = c.failureDom.split("\n").filter((l) => l.trim());
    const { kept, dropped } = capDomLines(lines, FAILURE_DOM_PROMPT_MAX_LINES);
    const body = dropped > 0 ? [...kept, `… (${dropped} more non-table elements omitted)`] : kept;
    parts.push(`### ${c.name}\n${body.join("\n")}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

// Splits a single case's stored failureDom into its "role: name" lines (blanks dropped). The stored
// value is ALREADY parseAriaSnapshot output (execute.ts), so we MUST NOT re-parse it — re-parsing
// the "role: name" form (no "- " markers) yields []. Used by the Lever-2 selector check, PER CASE
// (C2): each spec's selectors are verified against that case's own tree, never a fused union (which
// would make a node present on page A look non-unique against page B). Returns [] when absent.
export function buildFailureDomLines(failureDom: string | undefined): string[] {
  if (!failureDom) return [];
  return failureDom.split("\n").filter((l) => l.trim());
}

// What the agent reported testing (flow + objective per spec) — the "what was tested"
// section of the reviewer-facing Issue/PR body. undefined when no specs were produced.
export function testedFrom(r: AgentResult | null | undefined): TestedItem[] | undefined {
  return r?.specMetas?.map((m) => ({ flow: m.flow, objective: m.objective }));
}

// Open an Issue only for a real failure or invalid specs. Flaky → quarantine.
// Infra errors → log only. In shadow mode no Issue is ever opened.
async function report(
  app: AppConfig,
  issueRepo: string,
  sha: string,
  run: QaRunResult,
  deps: PipelineDeps,
  log: (m: string) => void,
  shadow: boolean,
  isCode: boolean,
  ctx: IssueContext = {},
): Promise<void> {
  if (app.report.onFailure !== "github-issue") {
    if (run.verdict === "flaky") run.outcome = "flaky — quarantined (no PR, no Issue)";
    return;
  }
  const kind = isCode ? "code" : "E2E";
  switch (run.verdict) {
    case "fail": {
      const url = await issueOrShadow(shadow, deps, log, issueRepo, `QA ${kind} tests failed at ${sha}`, renderIssue(run, ctx));
      run.outcome = outcomeForIssue(url, "Issue filed (tests failed against DEV)");
      break;
    }
    case "invalid": {
      const url = await issueOrShadow(shadow, deps, log, issueRepo, `QA could not validate the generated ${kind} tests at ${sha}`, renderIssue(run, ctx));
      run.outcome = outcomeForIssue(url, "Issue filed (generated tests failed the static gate)");
      break;
    }
    case "infra-error":
      log(`[qa] INFRA — ${run.logs} — not reported as a bug.`);
      break;
    case "flaky":
      log(`[qa] FLAKY — ${flakyNames(run)} quarantined (no PR, no failure Issue).`);
      run.outcome = "flaky — quarantined (no PR, no Issue)";
      break;
  }
}

async function issueOrShadow(
  shadow: boolean,
  deps: PipelineDeps,
  log: (m: string) => void,
  repo: string,
  title: string,
  body: string,
): Promise<string | undefined> {
  if (shadow) {
    log(`[qa] (shadow) would have opened an Issue: "${title}"`);
    return undefined;
  }
  const issue = await deps.openIssue(repo, title, body);
  log(`[qa] Issue opened: ${issue.url}`);
  return issue.url;
}

// outcomeForIssue is the human "what the run produced" line for an Issue path — the URL
// when one was filed, or the shadow placeholder. In shadow the reason in parentheses (e.g.
// "reviewer rejected the suite") is preserved so the preview says WHY an Issue would open.
function outcomeForIssue(url: string | undefined, what: string): string {
  if (url) return `${what} · ${url}`;
  const reason = what.replace(/^Issue filed \(/, "").replace(/\)$/, "");
  return `shadow · would file an Issue (${reason})`;
}

function flakyNames(run: QaRunResult): string {
  return run.cases.filter((c) => c.status === "flaky").map((c) => c.name).join(", ");
}
