// Full QA pipeline, shared by every trigger (manual CLI and webhook). The
// deterministic infrastructure lives here (gate, working copy, harness,
// publishing, reporting); the agentic generation is delegated to OpenCode
// (see integrations/opencode-client.ts + opencode/opencode.json). The source of
// truth for the tests is the repo's `e2e/` folder in git, not a volume. Steps
// that touch the network or have side effects are injected via PipelineDeps, so
// ordering and branches are verifiable with stubs.

import { join, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { AppConfig } from "./orchestrator/config-loader";
import { DeployTarget, waitForDeploy } from "./env/deploy-gate";
import { ensureMirror, ensureMirrorAtBranch, getCommitDiff, getCommitMessage, listChangedSpecs as gitListChangedSpecs, getCommitsBehind, defaultMirrorDeps } from "./integrations/repo-mirror";
import { runOpencode, runOpencodeParallel, shouldFanOut, defaultAgentDeps, reviewIndependently, getOpenSessionCount } from "./integrations/opencode-client";
import { classifyCommit, CommitIntent } from "./qa/commit-classify";
import { setupE2eProject, defaultSetupDeps } from "./qa/setup";
import { validateSpecs, defaultValidateDeps } from "./qa/validate";
import { runE2E, defaultExecuteDeps, defaultCleanupDeps } from "./qa/execute";
import { setupCodeProject, defaultCodeSetupDeps, runCodeTests, defaultCodeExecuteDeps, runCodeCoverage } from "./qa/code-runner";
import { publishE2e, publishCode, publishContext, defaultPublishDeps } from "./integrations/publish";
import { testDataNamespace } from "./qa/test-data";
import { labelRunOutcome } from "./qa/learning/labeler";
import { runMutationOracle } from "./qa/learning/mutation-code";
import { runFaultInjectionOracle } from "./qa/learning/fault-injection-e2e";
import type { OracleInput, ValueOracleResult } from "./qa/learning/oracle-types";
import { retrieveRules, type RetrievalResult } from "./qa/learning/retrieval";
import { preventionOutcome, renderRulesForReviewer, type LearningRule } from "./qa/learning/learning-rule";
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
  clearBrowserCoverage,
  hasBrowserCoverageDumps,
  DEFAULT_COVERAGE_POLICY,
  type CoveredLines,
  type CoverageCollectInput,
  type ChangeCoveragePolicy,
} from "./qa/change-coverage";
import { github } from "./integrations/github";
import { capDiff } from "./orchestrator/sanitizer";
import { renderIssue, type IssueContext, type TestedItem } from "./report/reporter";
import { renderValueTag } from "./qa/value-report";
import { captureDom, captureDomForRoutes, defaultCaptureDomDeps } from "./qa/dom-snapshot";
import { loadContextCache as loadContextCacheDefault, saveContextCache as saveContextCacheDefault } from "./qa/context-cache";
import { AgentResult, QaCase, QaRunResult, TriggerSource, RunMode, RunOptions, TestTarget, RunOutcome, SpecMeta } from "./types";
import type { AgentDeps, ReviewInput, ReviewResult } from "./integrations/opencode-client";
import { decideProgress, bestRound, isLikelyRealBug, classifyFailure, type RoundResult } from "./qa/progress-gate";
import { extractProposedSelectors, selectorPresent, selectorUnique, hasNonExtractableLocator, type ProposedSelector } from "./qa/selector-check";
import { capDomLines } from "./qa/dom-snapshot";

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
  service?: { repo: string; mirrorDir: string; openapi?: string | string[] }; // cross-repo: the triggering microservice (read-only working copy)
  services?: Array<{ repo: string; mirrorDir: string; openapi?: string | string[] }>; // context mode: every declared service, mirrored read-only
}

export interface PipelineDeps {
  // The signal aborts the gate's poll loop early (run cancelled, or the commit was
  // classified as a skip while the gate was still polling in the background).
  waitForDeploy(target: DeployTarget, sha: string, signal?: AbortSignal): Promise<void>;
  prepare(repo: string, sha: string, commits?: number): Promise<{ mirrorDir: string; diff: string; message: string }>;
  // Cross-repo runs: the PRIMARY repo at the HEAD of its base branch (the triggering
  // SHA belongs to the service repo and does not exist in the primary).
  prepareAtBranch(repo: string, branch: string): Promise<{ mirrorDir: string }>;
  generate(input: GenerateInput, signal?: AbortSignal, onProgress?: (msg: string) => void): Promise<AgentResult>;
  // The *.spec.ts the agent actually wrote on disk (git status over e2e/), e2e-relative.
  // The authoritative spec set for the no-op decision and the reviewer's file list — the
  // orchestrator trusts the working copy, not the agent's self-report. Absent ⇒ no
  // reconciliation (the agent's reported specs are used, as before).
  listChangedSpecs?(mirrorDir: string, e2eRelDir: string): Promise<string[]>;
  setupE2e(e2eDir: string): Promise<void>; // installs the e2e project's dependencies
  validate(e2eDir: string): Promise<{ ok: boolean; errors: string[]; infra: boolean }>;
  execute(e2eDir: string, opts: { baseUrl: string; namespace: string; onCase?: (c: QaCase) => void; onRunning?: (title: string) => void; onDiscovered?: (title: string, file?: string) => void; signal?: AbortSignal }): Promise<QaRunResult>;
  cleanup(e2eDir: string, opts: { baseUrl: string; namespace: string }): Promise<void>; // orphan-data cleanup (best-effort)
  isHealthy(versionUrl: string): Promise<boolean>; // is DEV healthy right now? (infra vs quality)
  review?(input: ReviewInput, signal?: AbortSignal): Promise<ReviewResult>; // independent reviewer (null = disabled)
  // Change-coverage provider (the value keystone). Returns the lines actually exercised by the
  // run, repo-relative, or null when no usable coverage was produced (→ "unknown", never blocks).
  // Absent (undefined) ⇒ the change-coverage step is skipped entirely.
  collectCoverage?(input: CoverageCollectInput): Promise<CoveredLines | null>;
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
  // Code mode (target "code"): no web env, no Playwright. Install the repo's deps,
  // run its own test suite, classify by exit code, and publish the new tests.
  setupCode(repoDir: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  executeCode(repoDir: string, opts: { namespace: string; onCase?: (c: QaCase) => void; signal?: AbortSignal; timeoutMs?: number }): Promise<QaRunResult>;
  publishCode(input: { repo: string; sha: string; mirrorDir: string; baseBranch: string; parentRunId?: string }): Promise<{ prUrl: string | null; merged: boolean; error?: string } | null>;
  publishContext(input: { repo: string; sha: string; mirrorDir: string; baseBranch: string }): Promise<{ prUrl: string | null; merged: boolean; error?: string } | null>;
  openIssue(repo: string, title: string, body: string): Promise<{ url: string }>;
  // Grounds the independent reviewer in the LIVE DEV DOM: renders the routes the spec targets and
  // returns "role: name" lines so the reviewer judges UI facts against reality, not its training
  // memory. Best-effort (undefined on any failure) — the review degrades to defer-on-unverifiable.
  captureDom?(input: { e2eDir: string; baseUrl: string; specContents: string[] }): Promise<string | undefined>;
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
  log?(msg: string): void;
  // Context mode: validates the produced context.json. Injected so tests can bypass file I/O.
  validateContextFn?(content: unknown): { ok: boolean; errors: string[] };
  // Context mode: reads the built map back for the per-service coverage warning.
  // Absent ⇒ the warning step is skipped (unit tests that don't care).
  readBuiltContext?(e2eDir: string): ArchitectureContext | null;
  // Diff mode: checks whether the deployed context.json is stale vs the current HEAD.
  // Returns a warning string if stale, empty string if fresh or no map exists.
  checkContextStaleness?(mirrorDir: string, sha: string): Promise<string>;
}

export interface DefaultPipelineDepsOptions {
  agentDepsFactory?: () => Promise<AgentDeps>;
  hasOpenSessions?: () => boolean;
}

export function defaultPipelineDeps(options: DefaultPipelineDepsOptions = {}): PipelineDeps {
  const agentDepsFactory = options.agentDepsFactory ?? defaultAgentDeps;
  const hasOpenSessions = options.hasOpenSessions ?? (() => getOpenSessionCount() > 0);

  return {
    waitForDeploy: (target, sha, signal) => waitForDeploy(target, sha, undefined, signal),
    prepare: async (repo, sha, commits) => {
      const mirrorDir = await ensureMirror(repo, sha, defaultMirrorDeps);
      const diff = await getCommitDiff(mirrorDir, sha, defaultMirrorDeps, commits);
      const message = await getCommitMessage(mirrorDir, sha, defaultMirrorDeps);
      return { mirrorDir, diff, message };
    },
    prepareAtBranch: async (repo, branch) => ({ mirrorDir: await ensureMirrorAtBranch(repo, branch, defaultMirrorDeps) }),
    listChangedSpecs: (mirrorDir, e2eRelDir) => gitListChangedSpecs(mirrorDir, e2eRelDir, defaultMirrorDeps),
    generate: async (input, signal, onProgress) => {
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
        explorer: input.explorer,
        service: input.service,
        services: input.services,
      };
      const oc = await agentDepsFactory();
      // complete/exhaustive fan out to parallel workers (plan → workers → consolidate); the other
      // modes (diff/manual) and any fix/review re-generation use the single-agent path. Code mode
      // always uses the single agent (no web fan-out). Diff mode fans out only when
      // qa.parallelDiff is explicitly enabled in the app config.
      const useParallel = shouldFanOut(input);
      return useParallel
        ? runOpencodeParallel(ocInput, oc, {
            signal,
            onProgress,
            // Deterministic DOM grounding for the fan-out workers: capture the planned routes' live
            // a11y tree on the orchestrator (Playwright stays out of the agent boundary). Best-effort.
            ...(input.baseUrl
              ? { captureRoutesDom: (routes: string[]) => captureDomForRoutes(routes, { e2eDir: join(input.mirrorDir, E2E_DIR), baseUrl: input.baseUrl }, defaultCaptureDomDeps) }
              : {}),
          })
        : runOpencode(ocInput, oc, { signal, onProgress });
    },
    setupE2e: (e2eDir) => setupE2eProject(e2eDir, defaultSetupDeps),
    validate: (e2eDir) => validateSpecs(e2eDir, defaultValidateDeps),
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
    review: async (input, signal) =>
      reviewIndependently(input, await agentDepsFactory(), { signal }),
    captureDom: (input) => captureDom(input, defaultCaptureDomDeps),
    loadContextCache: (app) => loadContextCacheDefault(app),
    saveContextCache: (app, map) => saveContextCacheDefault(app, map),
    collectCoverage: async (input) => {
      // Code runs emit no coverage report on their own, so produce one (best-effort, fully
      // decoupled from the pass/fail run) before reading it. e2e reads the V8 dumps the
      // suite already produced. A null result → "unmeasured", never a misleading 0%.
      if (input.target === "code") await runCodeCoverage(input.repoDir).catch(() => {});
      return defaultCollectCoverage(input);
    },
    clearCoverage: (e2eDir, ns) => clearBrowserCoverage(e2eDir, ns),
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
    publish: (input) => publishE2e(input, defaultPublishDeps),
    openIssue: (repo, title, body) => github.openIssue(repo, title, body),
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
            f.diagnosis = (await askAssistant({ context: prompt, question: "Diagnose the engine defect.", instruction: "Output 2-3 plain sentences. No markdown.", agent: "qa-reflector" }, agentDeps, "/tmp")).trim() || undefined;
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
        flagMemoryHeal: (f) =>
          recordIncident({ source: "process-audit", severity: "warn", summary: `engram memory may be corrupt: ${f.summary}`, detail: `${f.evidence} — engram is agent-owned; an agent-layer cleanup is required (the orchestrator does not write engram).` }),
      });
    },
    runOracle: async (input) =>
      input.target === "e2e" ? runFaultInjectionOracle(input) : runMutationOracle(input),
    retrieveRules: (app, errorClass, archetypes) => retrieveRules({ app, errorClass: errorClass as import("./qa/learning/taxonomy").ErrorClass | null, archetypes }),
    recentErrorClass: async (app) => {
      const { listRunOutcomes } = await import("./server/history");
      return listRunOutcomes(app, 1)[0]?.errorClass ?? null;
    },
    distillCorrections: (input) => distillReviewerCorrections(input),
    reflectAndDistill: async (input) => {
      // Defer: skip the reflection when the system is already busy with another
      // run. Opening a qa-assistant session would contend for the OpenCode server
      // and the LLM API — the reflection is best-effort, never worth delaying the
      // next queued run. Loud: a skipped reflection is lost learning, never silent.
      if (hasOpenSessions()) {
        console.warn("[qa] reflection skipped (non-blocking): another agent session is open; this failure will not produce a rule");
        return null;
      }
      const { buildReflectionPrompt } = await import("./qa/learning/reflector");
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
          { context: prompt, question: "Produce the StructuredReflection JSON.", instruction: "Output ONLY the JSON object. No markdown, no explanation.", agent: "qa-reflector" },
          deps,
          "/tmp",
        );
        const json = JSON.parse(raw);
        const valid =
          json &&
          typeof json.goal === "string" &&
          typeof json.decision === "string" &&
          typeof json.assumption === "string" &&
          typeof json.errorClass === "string" &&
          typeof json.gateSignal === "string" &&
          typeof json.evidence === "string" &&
          typeof json.rootCause === "string" &&
          json.preventiveRule &&
          typeof json.preventiveRule === "object" &&
          typeof (json.preventiveRule as Record<string, unknown>).trigger === "string" &&
          typeof (json.preventiveRule as Record<string, unknown>).action === "string";
        if (valid) {
          distillReflection({ app: input.app, runId: input.runId, reflection: json as StructuredReflection, archetype: input.archetype });
          // Back-fill the reflection onto its run_outcomes row so it is durable and queryable,
          // not just consumed once to distill a rule and then thrown away (best-effort).
          try {
            const { updateRunOutcomeReflection } = await import("./server/history");
            updateRunOutcomeReflection(input.runId, json as StructuredReflection);
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
  curriculum: CurriculumState | null;
  changedFiles: string[];
  ccForPersistence?: ChangeCoverage;
  specMetas?: SpecMeta[];
  log: (m: string) => void;
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
  const { deps, app, run, isCode, generating, mode, mirrorDir, e2eDir, ns, diff, sha, runId, signal, retrievedRuleIds, changedFiles, ccForPersistence, specMetas, log } = input;
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
  if (retrievedRuleIds.length > 0 && valueScore !== null) {
    const { recordRuleOutcome } = await import("./server/history");
    try {
      for (const ruleId of retrievedRuleIds) recordRuleOutcome(ruleId, valueScore);
      log(`[qa] attribution: recorded outcome (valueScore=${(valueScore * 100).toFixed(0)}%) for ${retrievedRuleIds.length} rule(s)`);
    } catch (err) {
      log(`[qa] WARNING: attribution update failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    }
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
  const reviewerCorrections: string[] = []; // accumulated across review rounds (for RunOutcome)
  let reviewerRationale: string | undefined; // the LAST round's reviewer reasoning (approve or reject)
  let retries = 0; // total regeneration attempts (review loop + failure retries)
  let retrievedRuleIds: string[] = []; // rule IDs retrieved for this run (for RunOutcome)
  let retrievedRules: LearningRule[] = []; // full retrieved rules (errorClass needed for governance)
  let curriculum: ReturnType<typeof initCurriculum> | null = null; // persisted across runs

  const persistOutcome = (verdict: QaRunResult, overrides?: { staticOk?: boolean; coverageRatio?: number | null; valueScore?: number | null; rulesRetrieved?: string[] }) => {
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
    ({ mirrorDir, diff, message } = await deps.prepare(app.repo, sha, commits));
  }
  const e2eDir = join(mirrorDir, E2E_DIR);
  const ns = testDataNamespace(app.qa.testDataPrefix, sha, opts.runId);

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
  // above, parseDiffHunks for coverage/oracle scoping) keep the raw diff — they are free.
  const promptDiff = capDiff(diff);
  if (promptDiff.length < diff.length) {
    log(`[qa] diff capped for prompts: ${diff.length} → ${promptDiff.length} chars (full diff stays available in the working copy).`);
  }

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
    const ctxResult = await deps.generate(genInput, signal, log);

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
    await deps.cleanup(e2eDir, { baseUrl: app.dev.baseUrl, namespace: opts.previousNamespace }).catch((err) => {
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

  const MAX_REVIEW_ROUNDS = 2;
  // Static-gate repair budget (Filter B). Mirrors the execution fix-loop: a trivial tsc/eslint/list
  // error should get a bounded second chance, not fail the whole run on the first miss.
  const MAX_STATIC_FIX_ROUNDS = 2;
  const generateAndReview = async (genInput: GenerateInput): Promise<AgentResult> => {
    const genStart = Date.now();
    let r = await reconcileSpecs(await deps.generate(genInput, signal, log));
    log(`[qa] [timing] generation produced ${r.specs.length} spec(s) in ${Math.round((Date.now() - genStart) / 1000)}s`);
    if (!(app.qa.needsReview && deps.review)) return r;
    // The live-DOM grounding only depends on the ROUTES the specs target, so capture it once and
    // reuse it across review rounds — re-launching a browser every round (up to MAX_REVIEW_ROUNDS)
    // is wasted cost when the spec set (hence the routes) is unchanged. Recompute only when the
    // regenerated spec set differs.
    let domSnapshot: string | undefined;
    let lastSpecsKey = "";
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
          domSnapshot = await deps.captureDom({ e2eDir, baseUrl: app.dev.baseUrl, specContents }).catch(() => undefined);
          lastSpecsKey = specsKey;
        }
      }
      try {
        review = await deps.review(
          // Arm the independent judge with the PROVEN learned rules (active only — never unproven
          // candidates) so it enforces app-specific anti-patterns earned from past failures.
          { diff: promptDiff, specs: r.specs, mirrorDir, e2eRelDir: isCode ? "" : E2E_DIR, baseUrl: app.dev?.baseUrl, intent, guidance: opts.guidance, appName: app.name, mode, target: opts.target, learnedRules: renderRulesForReviewer(retrievedRules), domSnapshot },
          signal,
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
        return { ...r, approved: false, note: "independent review unavailable (unparseable reviewer verdict) — not publishing unreviewed tests" };
      }
      // Reset counter on successful reviewer response
      consecutiveReviewerFailures = 0;
      log(`[qa] independent reviewer round ${round + 1}/${MAX_REVIEW_ROUNDS}: approved=${review.approved} corrections=${review.corrections.length} (${Math.round((Date.now() - reviewStart) / 1000)}s)`);
      if (review.rationale) reviewerRationale = review.rationale; // the verdict that ultimately decides this run
      onReviewer?.(review.approved, review.approved ? [] : review.corrections);
      if (!review.approved) reviewerCorrections.push(...review.corrections);
      if (review.approved) return { ...r, approved: true, note: undefined };
      if (round === MAX_REVIEW_ROUNDS - 1) return { ...r, approved: false, note: review.corrections.join("; ") };
      log(`[qa] applying ${review.corrections.length} reviewer correction(s) and regenerating...`);
      onStep?.("retry");
      retries++;
      const regenStart = Date.now();
      // Ground the regeneration in the SAME live a11y snapshot the reviewer just judged against, so the
      // generator fixes selectors against the real tree (e.g. no `columnheader` role on this table)
      // instead of re-deriving them from HTML intuition — the captured tree already shows what roles
      // actually exist and which names are duplicated (strict-mode risk).
      r = await reconcileSpecs(await deps.generate({ ...genInput, reviewCorrections: review.corrections, domSnapshot }, signal, log));
      log(`[qa] [timing] regeneration produced ${r.specs.length} spec(s) in ${Math.round((Date.now() - regenStart) / 1000)}s`);
    }
    return r;
  };

  // Learned rules + exemplars + curriculum, assembled once in the generation block below and
  // included in EVERY generation prompt by default — including the failure-retry and the
  // coverage-enforce regeneration, which previously dropped them.
  let promptSections: string | undefined;

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
    explorer: app.qa.explorer,
    contextMap,
    learnedRules: promptSections,
    service: triggerService
      ? { repo: triggerService.repo, mirrorDir: serviceMirrorDir!, openapi: triggerService.openapi }
      : undefined,
    ...extra,
  });

  // 5. Generate (only when applicable): the agent writes/improves `e2e/`.
  let result: AgentResult | null = null;

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
      try {
        // Bias retrieval toward the app's most recent failure class: rules that prevent
        // the error the engine just made are the most likely to matter on this run.
        let lastErrorClass: string | null = null;
        if (deps.recentErrorClass) {
          try {
            lastErrorClass = await deps.recentErrorClass(app.name);
          } catch {
            lastErrorClass = null; // relevance bias only — never blocks retrieval
          }
        }
        // Bias retrieval ALSO toward the current diff's structural shape (form, api-call, …) so
        // rules learned on the same kind of change surface even before any failure class exists.
        // NOTE: `intent` (hence changedFiles) is only set in diff mode; in complete/exhaustive/manual
        // changedFiles is [] so file-extension-gated patterns (e.g. form) don't fire — content-only
        // patterns (api-call, …) still do. The same input is used at distill-time for symmetry.
        const diffArchetypes = detectStructuralPatterns(diff, intent?.changedFiles ?? []).map((p) => p.kind);
        const retrieval = deps.retrieveRules(app.name, lastErrorClass, diffArchetypes);
        if (retrieval.promptSection) {
          learnedRules = retrieval.promptSection;
          retrievedRuleIds = retrieval.rules.map((r) => r.id);
          retrievedRules = retrieval.rules;
          log(`[qa] retrieval: injected ${retrievedRuleIds.length} learning rule(s) into the agent prompt`);
        }
      } catch (err) {
        log(`[qa] WARNING: rule retrieval failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Cap learned rules to prevent context window exhaustion
    const MAX_LEARNED_RULES_CHARS = 5000;
    if (learnedRules && learnedRules.length > MAX_LEARNED_RULES_CHARS) {
      log(`[qa] WARNING: learnedRules truncated from ${learnedRules.length} to ${MAX_LEARNED_RULES_CHARS} chars (cap exceeded)`);
      learnedRules = learnedRules.substring(0, MAX_LEARNED_RULES_CHARS) + "\n...[truncated]";
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

    // Inject curriculum archetypes into agent prompt
    const activeArchetypes = selectActiveArchetypesCached(curriculum!);
    if (activeArchetypes.length > 0) {
      const archetypeText = renderArchetypesForPrompt(activeArchetypes);
      allPromptSections = (allPromptSections ? allPromptSections + "\n" : "") + archetypeText;
    }

    promptSections = allPromptSections || undefined; // every later regeneration inherits this via baseGenInput

    log("[qa] generating E2E tests with OpenCode...");
    result = await generateAndReview(baseGenInput({ fixCases: opts.fixCases }));

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
      return { sha: ns, verdict: "skipped", passed: true, cases: [], logs: result.note ?? result.output.slice(0, 300) };
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
    // Tag rules distilled from this run with the diff's dominant structural shape, so they recall
    // on the same kind of change later. Only a SPECIFIC shape is useful as a tag — a purely
    // "generic" diff yields null (untagged), since "generic" matches everything and biases nothing.
    const runArchetype = detectStructuralPatterns(diff, intent?.changedFiles ?? [])
      .map((p) => p.kind)
      .find((k) => k !== "generic") ?? null;
    if (reviewerCorrections.length > 0 && opts.runId && deps.distillCorrections) {
      try {
        const distilled = deps.distillCorrections({ app: app.name, runId: opts.runId, corrections: reviewerCorrections, archetype: runArchetype });
        if (distilled.inserted.length > 0) {
          log(`[qa] learning: distilled ${distilled.inserted.length} candidate rule(s) from reviewer corrections`);
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
    // errorClass — into the retrieved rules. This lets candidate rules earn or lose trust for
    // EVERY app, not just oracle-enabled ones, so the flywheel turns universally. Capped at
    // "medium" confidence (only the oracle lifts a rule to "high"). See preventionOutcome.
    if ((o.valueScore ?? null) === null && retrievedRules.length > 0 && opts.runId) {
      try {
        const { recordRuleOutcome } = await import("./server/history");
        let folded = 0;
        for (const rule of retrievedRules) {
          const score = preventionOutcome(rule.errorClass, labeled.errorClass);
          if (score === null) continue; // no evidence about this rule from this run
          recordRuleOutcome(rule.id, score);
          folded++;
        }
        if (folded > 0) {
          log(`[qa] governance: folded prevention signal into ${folded} rule(s) (no oracle; runErrorClass=${labeled.errorClass ?? "none"})`);
        }
      } catch (err) {
        log(`[qa] WARNING: governance signal update failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (deps.reflectAndDistill && opts.runId && !signal?.aborted) {
      if (labeled.errorClass && labeled.errorClass !== "E-INFRA" && labeled.errorClass !== "E-FLAKY") {
        const outcome: RunOutcome = { ...labeled, gateSignals: { ...labeled.gateSignals, valueScore: o.valueScore ?? null }, rulesRetrieved: retrievedRuleIds, at: labeled.at };
        deps
          .reflectAndDistill({ app: app.name, runId: opts.runId, outcome, archetype: runArchetype })
          .catch((err) => log(`[qa] WARNING: reflect/distill failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`));
      }
    }
    // Persist curriculum (archetypes that caught real bugs survive across runs)
    if (curriculum) {
      const { saveCurriculum } = await import("./server/history");
      try {
        saveCurriculum(curriculum);
      } catch {
        // fail-open
      }
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
      await deps
        .auditProcess({ app: app.name, runId: opts.runId })
        .catch((err) => log(`[qa] WARNING: process audit failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`));
    }
  };

  checkSignal();
  // 6. Filter B — static gate. e2e: typecheck/lint/list/manifest over `e2e/`. Code
  //    mode has no separate static gate: running the repo's own suite IS the gate
  //    (the tests won't pass if the generated code doesn't compile), so we skip it.
  if (!isCode) {
    onStep?.("validate");
    log("[qa] validating specs (typecheck + lint + list + manifest)...");
    let validation = await deps.validate(e2eDir);
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
      result = await generateAndReview(
        baseGenInput({
          reviewCorrections: [
            `The generated specs FAILED the static gate (tsc + eslint + \`playwright --list\`). Fix EXACTLY these errors and change nothing else:\n${validation.errors.join("\n")}`,
          ],
        }),
      );
      checkSignal();
      validation = await deps.validate(e2eDir);
    }
    if (staticFixRounds > 0 && validation.ok) {
      log(`[qa] static gate PASSED after ${staticFixRounds} repair round(s).`);
    }
    if (!validation.ok) {
      log(`[qa] static gate failed:\n${validation.errors.join("\n")}`);
      // When every failure is infrastructure (ENOENT, signal-kill), the gate itself
      // couldn't run — it's inconclusive, not a code-quality verdict. Log it, but
      // don't open an Issue on the watched repo for a missing binary or OOM.
      if (validation.infra) {
        const infra = resultOf(ns, "infra-error", validation.errors.join("\n\n"));
        persistOutcome(infra);
        await report(app, issueRepo, sha, infra, deps, log, shadow, isCode);
        return infra;
      }
      const invalid = resultOf(ns, "invalid", validation.errors.join("\n\n"));
      persistOutcome(invalid, { staticOk: false });
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
      persistOutcome(infra);
      await report(app, issueRepo, sha, infra, deps, log, shadow, isCode);
      return infra;
    }
  }

  checkSignal();
  // 7. Filter C — run the tests and classify. e2e: Playwright against DEV
  //    (pass/fail/flaky). code: the repo's own suite by exit code (pass/fail).
  let run: QaRunResult;
  if (isCode) {
    onStep?.("execute");
    log("[qa] running the repo's own test suite (code mode)...");
    run = await deps.executeCode(mirrorDir, { namespace: ns, onCase, signal });
  } else if (!app.dev) {
    // Defensive: an e2e run on an app with no dev environment is inconclusive.
    run = resultOf(ns, "infra-error", "e2e run requested but no dev environment is configured");
    persistOutcome(run);
    await report(app, issueRepo, sha, run, deps, log, shadow, isCode);
    return run;
  } else {
    onStep?.("execute");
    log(`[qa] running E2E (namespace ${ns}) against ${app.dev.baseUrl}...`);
    deps.clearCoverage?.(e2eDir, ns); // fresh dumps only: never union a prior run's coverage
    run = await deps.execute(e2eDir, { baseUrl: app.dev.baseUrl, namespace: ns, onCase, onRunning: onRunningTest, onDiscovered: onTestDiscovered, signal });
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
    const selectorContradictions: string[] = [];
    const absentKeys = new Set<string>(); // structured identity of verifiable-absent selectors (W2)
    let anyVerifiedPresent = false;
    // W5: when ANY generated spec uses a locator family Lever-2 cannot extract (getByTestId, raw
    // CSS .locator(), getByPlaceholder/AltText/Title), the "all selectors present+unique" judgment
    // is INCOMPLETE — a decorative getByRole could look unique while the ACTUAL failing locator is
    // unseen. uniqueness then becomes indeterminate and the real-bug branch must NOT fire.
    let anyNonExtractableLocator = false;
    // W3: an extracted selector that is UNVERIFIABLE (its role is in NO tree, or appears only as a
    // `(present)` marker whose name was dropped) is present in no `anyPresent` AND in no `absentKeys`
    // — it falls through both branches. With one decorative present-unique getByRole setting
    // anyVerifiedPresent, allUnique would wrongly become true and the real-bug branch could file a
    // bogus "app defect" Issue for a selector we never actually confirmed. Track it so it forces
    // allUnique=false: uniqueness is load-bearing only when EVERY extracted selector was verifiable.
    let anyUnverifiableSelector = false;
    if (haveTrees && result != null && result.specs.length > 0) {
      for (const specFile of result.specs) {
        const specPath = join(e2eDir, specFile);
        if (!existsSync(specPath)) continue;
        const specSrc = readFileSync(specPath, "utf8");
        if (hasNonExtractableLocator(specSrc)) anyNonExtractableLocator = true;
        for (const sel of extractProposedSelectors(specSrc)) {
          const presences = failedTrees.map((t) => selectorPresent(sel, t.lines));
          const anyPresent = presences.some((p) => p.present);
          const anyVerifiable = presences.some((p) => p.verifiable);
          if (anyPresent) {
            anyVerifiedPresent = true;
            // Non-unique within ANY single failed case's tree → strict-mode risk (per-tree, never fused).
            if (failedTrees.some((t) => selectorPresent(sel, t.lines).present && !selectorUnique(sel, t.lines))) {
              const roleLabel = sel.role ?? sel.kind;
              const nameLabel = sel.name ? ` "${sel.name}"` : "";
              selectorContradictions.push(`${roleLabel}:${nameLabel} matches MULTIPLE nodes (strict-mode ambiguity — scope to a unique parent)`);
            }
          } else if (anyVerifiable) {
            // Verifiable-absent in EVERY tree (role is known to at least one tree, no name match
            // anywhere, present nowhere) → a real contradiction. Unverifiable-everywhere is skipped (D4).
            absentKeys.add(selectorKey(sel));
            const roleLabel = sel.role ?? sel.kind;
            const nameLabel = sel.name ? ` "${sel.name}"` : "";
            const presentRoles = [...new Set(failedTrees.flatMap((t) => t.lines.map((l) => l.split(":")[0]?.trim())).filter(Boolean))].join(", ");
            selectorContradictions.push(
              `${roleLabel}:${nameLabel} is NOT in the captured failure-point tree. Present roles: ${presentRoles || "(none)"}`,
            );
          } else {
            // Neither present nor verifiable-absent in any tree → UNVERIFIABLE (its role never appeared
            // with a real name). Not a contradiction (D4: the snapshot may prune it), but it means the
            // selector set is NOT fully confirmed — so uniqueness can't be trusted to attribute a value
            // mismatch to an app defect. Force the real-bug branch closed (W3).
            anyUnverifiableSelector = true;
          }
        }
      }
    }

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
    if (
      !isCode &&
      isLikelyRealBug(allUnique, failed.map((c) => c.detail ?? ""))
    ) {
      log("[qa] real-bug branch: selectors resolve uniquely + value mismatch → likely app defect, not a selector problem. Filing an Issue.");
      realBugDetected = true;
      break;
    }

    if (!gate.spend) {
      log("[qa] progress gate stopped the fix-loop (no improvement signal).");
      break;
    }

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
      log("[qa] re-running the repo's test suite with the fixed tests...");
      run = await deps.executeCode(mirrorDir, { namespace: ns, onCase, signal });
    } else {
      // Re-validate the fixed specs and, if they pass, re-execute against DEV.
      const reValidation = await deps.validate(e2eDir);
      if (!reValidation.ok) {
        log(`[qa] retry validation failed:\n${reValidation.errors.join("\n")}`);
        break;
      }
      if (!(await devHealthy())) {
        log("[qa] DEV unhealthy before retry execution; keeping original verdict.");
        break;
      }
      log("[qa] re-running E2E with fixed tests...");
      deps.clearCoverage?.(e2eDir, ns);
      const retryRun = await deps.execute(e2eDir, { baseUrl: app.dev?.baseUrl ?? "", namespace: ns, onCase, onRunning: onRunningTest, signal });
      if (retryRun.verdict === "fail" && !(await devHealthy())) {
        run = resultOf(ns, "infra-error", "failures with an unhealthy DEV: treated as infrastructure");
        break;
      }
      run = retryRun;
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

  // 8. Filter D — change-coverage (the value keystone). Only for a per-commit DIFF run whose
  //    suite is GREEN: does executing the tests actually exercise the lines the commit changed?
  //    Skipped when no provider is wired (unit tests) or the policy is off. Unmeasured coverage is
  //    "unknown" and NEVER blocks (determinism over zeal). signal = record only; enforce = try once
  //    to close the gap, then block publishing if it stays below the threshold.
  const covPolicy: ChangeCoveragePolicy = {
    mode: app.qa.changeCoverage?.mode ?? DEFAULT_COVERAGE_POLICY.mode,
    minRatio: app.qa.changeCoverage?.minRatio ?? DEFAULT_COVERAGE_POLICY.minRatio,
  };
  let coverageStatus: "pass" | "fail" | "unknown" = "unknown";
  let coverageSummary = "";
  let ccForPersistence: ChangeCoverage | undefined;
  // The change-coverage skip log fires only when coverage WAS configured — otherwise apps
  // without a coverage provider would log a misleading "skipped" on every cross-repo pass run.
  if (triggerService && mode === "diff" && run.verdict === "pass" && deps.collectCoverage && covPolicy.mode !== "off") {
    log(`[qa] change-coverage: skipped — the changed lines live in ${triggerService.repo}; browser coverage maps only the frontend (status=unknown).`);
  }
  if (deps.collectCoverage && generating && mode === "diff" && run.verdict === "pass" && covPolicy.mode !== "off" && !triggerService) {
    const changed = parseDiffHunks(diff);
    if (changed.size > 0) {
      onStep?.("coverage");
      const changedFiles = [...changed.keys()];
      const collect = (): Promise<CoveredLines | null> =>
        deps.collectCoverage!({ target: isCode ? "code" : "e2e", repoDir: mirrorDir, e2eDir, changedFiles, namespace: ns });
      const collected = await collect();
      let cc = computeChangeCoverage(changed, collected ?? new Map());
      ccForPersistence = cc;
      coverageStatus = decideCoverage(cc, covPolicy);
      log(`[qa] change-coverage: ${coverageStatus} — ${cc.overall.coveredChanged}/${cc.overall.changedLines} changed lines (${(cc.overall.ratio * 100).toFixed(0)}%, policy=${covPolicy.mode}, min=${Math.round(covPolicy.minRatio * 100)}%)`);
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
          const okStatic = isCode ? { ok: true, errors: [] } : await deps.validate(e2eDir);
          if (okStatic.ok && (isCode || (await devHealthy()))) {
            if (!isCode) deps.clearCoverage?.(e2eDir, ns); // re-measure only the improved suite's dumps
            const reRun = isCode
              ? await deps.executeCode(mirrorDir, { namespace: ns, onCase, signal })
              : await deps.execute(e2eDir, { baseUrl: app.dev?.baseUrl ?? "", namespace: ns, onCase, onRunning: onRunningTest, signal });
            if (reRun.verdict === "pass") {
              run = reRun;
              result = improved;
              const reCollected = await collect();
              cc = computeChangeCoverage(changed, reCollected ?? new Map());
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
      if (coverageStatus === "unknown" && !isCode && deps.hasCoverageDumps?.(e2eDir, ns)) {
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
    runId: opts.runId, signal, retrievedRuleIds, curriculum,
    changedFiles: intent?.changedFiles ?? [],
    ccForPersistence, specMetas: result?.specMetas, log,
  });
  const valueScore = valueLearned.valueScore;
  curriculum = valueLearned.curriculum;

  // 9. Final decision.
  const kind = isCode ? "code" : "E2E";
  if (run.verdict !== "pass") {
    await report(app, issueRepo, sha, run, deps, log, shadow, isCode, { note: result?.note, tested: testedFrom(result), intent });
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
  persistOutcome(run, { staticOk: !isCode && generating, coverageRatio: ratio, valueScore, rulesRetrieved: retrievedRuleIds });

  // Reviewer-corrections distillation, labeling, prevention governance, reflection and
  // curriculum persistence — shared with the static-gate (`invalid`) early return above.
  await foldRunLearning(run, { staticOk: !isCode && generating, coverageRatio: ratio, valueScore });

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

// Stable STRUCTURED identity for a proposed selector (W2): role+name+exact+isRegex+kind. Used to
// compare the prev round's absent selectors to the current round's by identity — NOT by startsWith
// over the human-readable contradiction strings, which mis-counts an absent→ambiguous transition
// (the same selector, now MULTIPLE instead of absent) as "still absent" and starves Lever-2 signal C.
export function selectorKey(sel: ProposedSelector): string {
  return `${sel.kind}|${sel.role ?? ""}|${sel.name ?? ""}|${sel.exact ? "1" : "0"}|${sel.isRegex ? "1" : "0"}`;
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
