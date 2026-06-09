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
import { ensureMirror, getCommitDiff, getCommitMessage, listChangedSpecs as gitListChangedSpecs, getCommitsBehind, defaultMirrorDeps } from "./integrations/repo-mirror";
import { runOpencode, runOpencodeParallel, defaultOpencodeDeps, reviewIndependently, getOpenSessionCount } from "./integrations/opencode-client";
import { classifyCommit, CommitIntent } from "./qa/commit-classify";
import { setupE2eProject, defaultSetupDeps } from "./qa/setup";
import { validateSpecs, defaultValidateDeps } from "./qa/validate";
import { runE2E, defaultExecuteDeps, defaultCleanupDeps } from "./qa/execute";
import { setupCodeProject, defaultCodeSetupDeps, runCodeTests, defaultCodeExecuteDeps } from "./qa/code-runner";
import { publishE2e, publishCode, publishContext, defaultPublishDeps } from "./integrations/publish";
import { testDataNamespace } from "./qa/test-data";
import { labelRunOutcome } from "./qa/learning/labeler";
import { runMutationOracle } from "./qa/learning/mutation-code";
import { runFaultInjectionOracle } from "./qa/learning/fault-injection-e2e";
import type { OracleInput, ValueOracleResult } from "./qa/learning/oracle-types";
import { retrieveRules, type RetrievalResult } from "./qa/learning/retrieval";
import { distillReflection } from "./qa/learning/distiller";
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
import { renderIssue } from "./report/reporter";
import { AgentResult, QaCase, QaRunResult, TriggerSource, RunMode, RunOptions, TestTarget, RunOutcome } from "./types";
import type { ReviewInput, ReviewResult } from "./integrations/opencode-client";

// Tests live in this folder inside the repo (git is the source of truth).
const E2E_DIR = "e2e";

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
  learnedRules?: string; // retrieval: rules from past runs injected into the agent prompt
  runId?: string; // for SSE live activity: maps the OpenCode session to this run record
  contextMap?: ArchitectureContext; // cross-cutting: the FE↔BE map loaded from e2e/.qa/context.json
}

export interface PipelineDeps {
  waitForDeploy(target: DeployTarget, sha: string): Promise<void>;
  prepare(repo: string, sha: string): Promise<{ mirrorDir: string; diff: string; message: string }>;
  generate(input: GenerateInput, signal?: AbortSignal, onProgress?: (msg: string) => void): Promise<AgentResult>;
  // The *.spec.ts the agent actually wrote on disk (git status over e2e/), e2e-relative.
  // The authoritative spec set for the no-op decision and the reviewer's file list — the
  // orchestrator trusts the working copy, not the agent's self-report. Absent ⇒ no
  // reconciliation (the agent's reported specs are used, as before).
  listChangedSpecs?(mirrorDir: string, e2eRelDir: string): Promise<string[]>;
  setupE2e(e2eDir: string): Promise<void>; // installs the e2e project's dependencies
  validate(e2eDir: string): Promise<{ ok: boolean; errors: string[]; infra: boolean }>;
  execute(e2eDir: string, opts: { baseUrl: string; namespace: string; onCase?: (c: QaCase) => void; onRunning?: (title: string) => void }): Promise<QaRunResult>;
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
  publish(input: { repo: string; sha: string; mirrorDir: string; baseBranch: string; parentRunId?: string }): Promise<{ prUrl: string; merged: boolean } | null>;
  // Code mode (target "code"): no web env, no Playwright. Install the repo's deps,
  // run its own test suite, classify by exit code, and publish the new tests.
  setupCode(repoDir: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  executeCode(repoDir: string, opts: { namespace: string; onCase?: (c: QaCase) => void; signal?: AbortSignal; timeoutMs?: number }): Promise<QaRunResult>;
  publishCode(input: { repo: string; sha: string; mirrorDir: string; baseBranch: string; parentRunId?: string }): Promise<{ prUrl: string; merged: boolean } | null>;
  publishContext(input: { repo: string; sha: string; mirrorDir: string; baseBranch: string }): Promise<{ prUrl: string; merged: boolean } | null>;
  openIssue(repo: string, title: string, body: string): Promise<{ url: string }>;
  saveOutcome?(outcome: RunOutcome): Promise<void>; // learning layer: persist RunOutcome (off-path, never blocks)
  runOracle?(input: OracleInput): Promise<ValueOracleResult>; // Phase 1: mutation testing / benchmark replay (off-path, never blocks)
  retrieveRules?(app: string, errorClass?: string | null): RetrievalResult; // Phase 2: retrieval for agent prompt
  reflectAndDistill?(input: { app: string; runId: string; outcome: RunOutcome }): Promise<StructuredReflection | null>; // Phase 2: reflect + distill (off-path, never blocks)
  log?(msg: string): void;
  // Context mode: validates the produced context.json. Injected so tests can bypass file I/O.
  validateContextFn?(content: unknown): { ok: boolean; errors: string[] };
  // Diff mode: checks whether the deployed context.json is stale vs the current HEAD.
  // Returns a warning string if stale, empty string if fresh or no map exists.
  checkContextStaleness?(mirrorDir: string, sha: string): Promise<string>;
}

export function defaultPipelineDeps(): PipelineDeps {
  return {
    waitForDeploy: (target, sha) => waitForDeploy(target, sha),
    prepare: async (repo, sha) => {
      const mirrorDir = await ensureMirror(repo, sha, defaultMirrorDeps);
      const diff = await getCommitDiff(mirrorDir, sha, defaultMirrorDeps);
      const message = await getCommitMessage(mirrorDir, sha, defaultMirrorDeps);
      return { mirrorDir, diff, message };
    },
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
        learnedRules: input.learnedRules,
        runId: input.runId,
        contextMap: input.contextMap,
      };
      const oc = await defaultOpencodeDeps();
      // complete/exhaustive fan out to parallel workers (plan → workers → consolidate); the other
      // modes (diff/manual) and any fix/review re-generation use the single-agent path. Code mode
      // always uses the single agent (no web fan-out).
      const useParallel =
        (input.target ?? "e2e") === "e2e" &&
        (input.mode === "complete" || input.mode === "exhaustive") &&
        !input.fixCases?.length &&
        !input.reviewCorrections?.length;
      return useParallel
        ? runOpencodeParallel(ocInput, oc, { signal, onProgress })
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
      reviewIndependently(input, await defaultOpencodeDeps(), { signal }),
    collectCoverage: async (input) => defaultCollectCoverage(input),
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
    runOracle: async (input) =>
      input.target === "e2e" ? runFaultInjectionOracle(input) : runMutationOracle(input),
    retrieveRules: (app, errorClass) => retrieveRules({ app, errorClass: errorClass as import("./qa/learning/taxonomy").ErrorClass | null }),
    reflectAndDistill: async (input) => {
      // Defer: skip the reflection when the system is already busy with another
      // run. Opening a qa-assistant session would contend for the OpenCode server
      // and the LLM API — the reflection is best-effort, never worth delaying the
      // next queued run.
      if (getOpenSessionCount() > 0) return null;
      const { buildReflectionPrompt } = await import("./qa/learning/reflector");
      const prompt = buildReflectionPrompt({
        errorClass: input.outcome.errorClass!,
        gateSignals: input.outcome.gateSignals,
        verdict: input.outcome.verdict,
        sha: input.outcome.sha,
        mode: input.outcome.mode,
      });
      const { askAssistant } = await import("./integrations/opencode-client");
      const { defaultOpencodeDeps } = await import("./integrations/opencode-client");
      const deps = await defaultOpencodeDeps();
      try {
        const raw = await askAssistant(
          { context: prompt, question: "Produce the StructuredReflection JSON.", instruction: "Output ONLY the JSON object. No markdown, no explanation." },
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
          distillReflection({ app: input.app, runId: input.runId, reflection: json as StructuredReflection });
          return json as StructuredReflection;
        }
        return null;
      } catch {
        return null;
      }
    },
    log: (m) => console.log(m),
  };
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
): Promise<QaRunResult> {
  const checkSignal = () => {
    if (signal?.aborted) throw new Error("run cancelled by operator");
  };
  const log = deps.log ?? (() => {});
  const shadow = app.qa.shadow ?? false;
  const mode = opts.mode;
  const isCode = (opts.target ?? "e2e") === "code";
  const reviewerCorrections: string[] = []; // accumulated across review rounds (for RunOutcome)
  let retries = 0; // total regeneration attempts (review loop + failure retries)
  let retrievedRuleIds: string[] = []; // rule IDs retrieved for this run (for RunOutcome)
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
  const versionUrl = (isCode || mode === "context") ? undefined : app.dev?.versionUrl;
  const devHealthy = () => (versionUrl ? deps.isHealthy(versionUrl) : Promise.resolve(true));
  if (isCode) {
    log("[qa] code mode: no web environment; skipping the deploy gate and health checks.");
  } else if (versionUrl && app.dev) {
    const target: DeployTarget = {
      name: app.name,
      versionUrl,
      pollIntervalMs: app.dev.pollIntervalMs ?? 10_000,
      deployTimeoutMs: app.dev.deployTimeoutMs ?? 600_000,
    };
    log("[qa] waiting for a stable deploy on DEV...");
    await deps.waitForDeploy(target, sha);
  } else {
    log("[qa] no version endpoint configured; skipping the deploy gate.");
  }

  // 2. Working copy of the repo at the SHA (the agent's cwd, holds `e2e/`) + diff + message.
  log("[qa] preparing working copy and diff...");
  const { mirrorDir, diff, message } = await deps.prepare(app.repo, sha);
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
      return { sha: ns, verdict: "skipped", passed: true, cases: [], logs: cls.reason };
    }
    generating = isContinuation || cls.action === "generate";
    intent = cls;
  } else {
    log(`[qa] mode=${mode}: whole-repo/guided run (commit classification skipped).`);
  }

  // 4. Set up the project so the agent has what it needs to build on. e2e: bootstrap
  //    the seed if missing + install the e2e deps. code: install the repo's own deps
  //    so its test suite can run. context: same as e2e (the agent writes into e2e/.qa/).
  if (isCode) {
    log("[qa] code mode: installing the repo's dependencies...");
    await deps.setupCode(mirrorDir, { signal });
  } else {
    await deps.setupE2e(e2eDir);
  }

  // ── context mode: build the FE↔BE architecture map ──────────────────────────
  // Diverges early: the agent builds context.json from structured sources (routing,
  // OpenAPI, generated clients), we validate it deterministically, and publish via PR.
  // No tests are generated or executed — this is a maintenance task.
  if (mode === "context") {
    log("[qa] context mode: building the FE↔BE architecture map...");
    onStep?.("generate");

    const genInput: GenerateInput = {
      repo: app.repo,
      sha,
      diff,
      mirrorDir,
      namespace: ns,
      needsReview: false,
      mode,
      appName: app.name,
      baseUrl: app.dev?.baseUrl,
      openapi: app.openapi,
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
      log(`[qa] context validation failed:\n${validated.errors.join("\n")}`);
      await issueOrShadow(
        shadow, deps, log, app.repo,
        `QA context map for ${sha} is invalid`,
        renderIssue(resultOf(ns, "invalid", validated.errors.join("\n\n")), validated.errors.join("\n")),
      );
      return resultOf(ns, "invalid", validated.errors.join("\n\n"));
    }

    log(`[qa] context map validated: OK`);

    if (shadow) {
      log("[qa] (shadow) context map built; a PR would have been opened.");
    } else {
      const pr = await deps.publishContext({ repo: app.repo, sha, mirrorDir, baseBranch: app.baseBranch ?? "main" });
      log(pr
        ? pr.merged
          ? `[qa] OK — context map merged: ${pr.prUrl}`
          : `[qa] OK — context map PR opened (merge it manually): ${pr.prUrl}`
        : "[qa] OK — context map built (no changes to publish).");
    }

    return resultOf(ns, "pass", "context map built and validated");
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
  let contextMap: ArchitectureContext | undefined;
  const ctxJsonPath = join(e2eDir, ".qa", "context.json");
  if (existsSync(ctxJsonPath)) {
    try {
      const raw = JSON.parse(readFileSync(ctxJsonPath, "utf8"));
      const v = validateContext(raw);
      if (v.ok) {
        contextMap = raw as ArchitectureContext;
        log(`[qa] loaded architecture map: ${contextMap.routes.length} routes, ${contextMap.api.length} api ops, ${contextMap.feBe?.length ?? 0} links`);
      } else {
        log(`[qa] WARNING: context.json exists but is invalid (${v.errors.join("; ")}); the agent will not receive architecture context.`);
      }
    } catch {
      log("[qa] WARNING: could not parse context.json; the agent will not receive architecture context.");
    }
  }

  // Generate, then run the INDEPENDENT reviewer as a bounded feedback loop. The reviewer is a
  // SEPARATE qa-reviewer session (not the generator's subagent), so its verdict is genuinely
  // independent and AUTHORITATIVE — it breaks the circular quality loop documented in AGENTS.md.
  // On rejection, the reviewer's actionable corrections are reinjected and the agent regenerates
  // (up to MAX_REVIEW_ROUNDS) BEFORE giving up; only then is the result marked not-approved
  // (→ Issue). A reviewer error fails open (trust the generator) and stops the loop.
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
  const generateAndReview = async (genInput: GenerateInput): Promise<AgentResult> => {
    let r = await reconcileSpecs(await deps.generate(genInput, signal, log));
    if (!(app.qa.needsReview && deps.review)) return r;
    for (let round = 0; round < MAX_REVIEW_ROUNDS; round++) {
      if (r.specs.length === 0) {
        // A FIRST-round empty result is a legitimate no-op. A LATER (post-rejection)
        // regeneration with no specs was never judged by the reviewer — it must NOT inherit
        // the generator's self-approval, or unreviewed work could skip green.
        return round === 0 ? r : { ...r, approved: false, note: "regeneration produced no reviewable specs" };
      }
      let review: ReviewResult;
      try {
        review = await deps.review(
          { diff, specs: r.specs, mirrorDir, e2eRelDir: E2E_DIR, baseUrl: app.dev?.baseUrl, intent, appName: app.name, mode },
          signal,
        );
      } catch (err) {
        // Fail open for a transient error, but make it OBSERVABLE: the reviewer is the only
        // independent gate against the circular self-approval loop, so a persistent outage
        // silently degrading every run to generator-self-approval must be visible.
        log(`[qa] WARNING: independent reviewer FAILED — publishing on the generator's verdict WITHOUT independent review (${err instanceof Error ? err.message : String(err)}).`);
        return { ...r, note: "published without independent review (reviewer error)" };
      }
      // A parse miss is NOT an actionable rejection: feeding the synthetic correction back
      // just burns a round and re-hits the same miss. Treat it like a reviewer error.
      if (review.parsed === false) {
        log(`[qa] WARNING: independent reviewer produced NO parseable verdict — publishing WITHOUT independent review (not burning a regeneration round).`);
        return { ...r, note: "published without independent review (unparseable reviewer verdict)" };
      }
      log(`[qa] independent reviewer round ${round + 1}/${MAX_REVIEW_ROUNDS}: approved=${review.approved} corrections=${review.corrections.length}`);
      if (!review.approved) reviewerCorrections.push(...review.corrections);
      if (review.approved) return { ...r, approved: true, note: undefined };
      if (round === MAX_REVIEW_ROUNDS - 1) return { ...r, approved: false, note: review.corrections.join("; ") };
      log(`[qa] applying ${review.corrections.length} reviewer correction(s) and regenerating...`);
      onStep?.("retry");
      retries++;
      r = await reconcileSpecs(await deps.generate({ ...genInput, reviewCorrections: review.corrections }, signal, log));
    }
    return r;
  };

  const baseGenInput = (extra: Partial<GenerateInput>): GenerateInput => ({
    repo: app.repo,
    sha,
    diff,
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
    contextMap,
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

    // Staleness check: if context.json exists but is too far behind HEAD, warn
    // so the agent knows the map may be outdated and should verify before trusting.
    if (mode === "diff" && deps.checkContextStaleness) {
      const staleWarn = await deps.checkContextStaleness(mirrorDir, sha);
      if (staleWarn) log(`[qa] ${staleWarn}`);
    }

    let learnedRules: string | undefined;
    if (deps.retrieveRules && generating) {
      const retrieval = deps.retrieveRules(app.name, null);
      if (retrieval.promptSection) {
        learnedRules = retrieval.promptSection;
        retrievedRuleIds = retrieval.rules.map((r) => r.id);
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

    // Inject curriculum archetypes into agent prompt
    const activeArchetypes = selectActiveArchetypesCached(curriculum!);
    if (activeArchetypes.length > 0) {
      const archetypeText = renderArchetypesForPrompt(activeArchetypes);
      allPromptSections = (allPromptSections ? allPromptSections + "\n" : "") + archetypeText;
    }

    log("[qa] generating E2E tests with OpenCode...");
    result = await generateAndReview(baseGenInput({ fixCases: opts.fixCases, learnedRules: allPromptSections || undefined }));

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

  checkSignal();
  // 6. Filter B — static gate. e2e: typecheck/lint/list/manifest over `e2e/`. Code
  //    mode has no separate static gate: running the repo's own suite IS the gate
  //    (the tests won't pass if the generated code doesn't compile), so we skip it.
  if (!isCode) {
    onStep?.("validate");
    log("[qa] validating specs (typecheck + lint + list + manifest)...");
    const validation = await deps.validate(e2eDir);
    if (!validation.ok) {
      log(`[qa] static gate failed:\n${validation.errors.join("\n")}`);
      // When every failure is infrastructure (ENOENT, signal-kill), the gate itself
      // couldn't run — it's inconclusive, not a code-quality verdict. Log it, but
      // don't open an Issue on the watched repo for a missing binary or OOM.
      if (validation.infra) {
        const infra = resultOf(ns, "infra-error", validation.errors.join("\n\n"));
        persistOutcome(infra);
        await report(app, sha, infra, deps, log, shadow, isCode);
        return infra;
      }
      const invalid = resultOf(ns, "invalid", validation.errors.join("\n\n"));
      persistOutcome(invalid, { staticOk: false });
      await report(app, sha, invalid, deps, log, shadow, isCode, "the E2E tests did not pass the static gate");
      return invalid;
    }

    // Health pre-flight: DEV may have gone down during generation. If it is not
    // healthy the run is inconclusive → infra error, not reported as a bug.
    if (!(await devHealthy())) {
      const infra = resultOf(ns, "infra-error", "DEV is not healthy before execution");
      persistOutcome(infra);
      await report(app, sha, infra, deps, log, shadow, isCode);
      return infra;
    }
  }

  checkSignal();
  // 7. Filter C — run the tests and classify. e2e: Playwright against DEV
  //    (pass/fail/flaky). code: the repo's own suite by exit code (pass/fail).
  let run: QaRunResult;
  if (isCode) {
    log("[qa] running the repo's own test suite (code mode)...");
    run = await deps.executeCode(mirrorDir, { namespace: ns, onCase, signal });
  } else if (!app.dev) {
    // Defensive: an e2e run on an app with no dev environment is inconclusive.
    run = resultOf(ns, "infra-error", "e2e run requested but no dev environment is configured");
    persistOutcome(run);
    await report(app, sha, run, deps, log, shadow, isCode);
    return run;
  } else {
    onStep?.("execute");
    log(`[qa] running E2E (namespace ${ns}) against ${app.dev.baseUrl}...`);
    deps.clearCoverage?.(e2eDir, ns); // fresh dumps only: never union a prior run's coverage
    run = await deps.execute(e2eDir, { baseUrl: app.dev.baseUrl, namespace: ns, onCase, onRunning: onRunningTest });
    // Infra vs quality: failures with an unhealthy DEV are infrastructure, not code.
    if (run.verdict === "fail" && !(await devHealthy())) {
      run = resultOf(ns, "infra-error", "failures with an unhealthy DEV: treated as infrastructure");
    }
  }

  // Re-generation on failure (max 1 retry): feed failed cases back to the agent
  // so it can fix selector issues, scoping, and regex ambiguity before reporting.
  const MAX_RETRIES = 1;
  for (let retry = 0; retry < MAX_RETRIES && run.verdict === "fail" && generating; retry++) {
    const failed = run.cases.filter((c) => c.status === "fail");
    log(
      `[qa] ${failed.length} test(s) failed:\n` +
        failed.map((c) => `  ❌ ${c.name}${c.detail ? ` — ${c.detail.slice(0, 200)}` : ""}`).join("\n"),
    );

    log("[qa] re-generating with failure feedback...");
    onStep?.("retry");
    retries++;
    result = await generateAndReview(baseGenInput({ fixCases: failed }));
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
      const retryRun = await deps.execute(e2eDir, { baseUrl: app.dev?.baseUrl ?? "", namespace: ns, onCase, onRunning: onRunningTest });
      if (retryRun.verdict === "fail" && !(await devHealthy())) {
        run = resultOf(ns, "infra-error", "failures with an unhealthy DEV: treated as infrastructure");
        break;
      }
      run = retryRun;
    }
    log(`[qa] retry verdict: ${run.verdict}`);
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
  if (deps.collectCoverage && generating && mode === "diff" && run.verdict === "pass" && covPolicy.mode !== "off") {
    const changed = parseDiffHunks(diff);
    if (changed.size > 0) {
      onStep?.("coverage");
      const changedFiles = [...changed.keys()];
      const collect = (): Promise<CoveredLines | null> =>
        deps.collectCoverage!({ target: isCode ? "code" : "e2e", repoDir: mirrorDir, e2eDir, changedFiles, namespace: ns });
      let cc = computeChangeCoverage(changed, (await collect()) ?? new Map());
      ccForPersistence = cc;
      coverageStatus = decideCoverage(cc, covPolicy);
      log(`[qa] change-coverage: ${coverageStatus} — ${cc.overall.coveredChanged}/${cc.overall.changedLines} changed lines (${(cc.overall.ratio * 100).toFixed(0)}%, policy=${covPolicy.mode}, min=${Math.round(covPolicy.minRatio * 100)}%)`);

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
              : await deps.execute(e2eDir, { baseUrl: app.dev?.baseUrl ?? "", namespace: ns, onCase, onRunning: onRunningTest });
            if (reRun.verdict === "pass") {
              run = reRun;
              result = improved;
              cc = computeChangeCoverage(changed, (await collect()) ?? new Map());
              coverageStatus = decideCoverage(cc, covPolicy);
              log(`[qa] change-coverage after improvement: ${coverageStatus} (${(cc.overall.ratio * 100).toFixed(0)}%)`);
            }
          }
        }
      }
      if (coverageStatus === "fail") coverageSummary = renderUncovered(cc);

      // Observability: "unknown" because the suite produced V8 dumps that mapped to NONE
      // of the changed files is a STRUCTURAL NO-OP (a bundled/minified deploy whose asset
      // URLs don't resolve to repo source, or specs not importing ./fixtures) — the keystone
      // is silently protecting nothing. Surface it loudly instead of the benign "unknown".
      if (coverageStatus === "unknown" && !isCode && deps.hasCoverageDumps?.(e2eDir, ns)) {
        log(
          `[qa] ⚠️  CHANGE-COVERAGE INACTIVE — Playwright ran and produced coverage data, ` +
            `but the V8 script URLs (hashed bundles like /assets/index-abc123.js) did not ` +
            `match any of the ${changedFiles.length} changed source file(s).`,
        );
        log(
          `[qa]    CAUSE: DEV is serving bundled/minified assets. The keystone cannot map ` +
            `"bundle URL" → "repo source file", so coverage measurement is non-functional.`,
        );
        log(
          `[qa]    FIX: Configure your DEV server to serve unbundled source files (e.g. ` +
            `disable minification, use a dev server that emits original paths). This does ` +
            `NOT block the run — tests are still generated and published.`,
        );
      }
    }
  }

  // ── Measured persistence (suite-level learning) ─────────────────────────────
  // Record suite stability + the actually-covered files to e2e/.qa/measured.json
  // (gitignored — no PR-spam). e2e-ONLY: code mode has no e2e/ dir and CODE_PATHSPEC would
  // commit the file into the watched repo (M1), and has no per-test coverage anyway.
  // Suite-level (not per-flow) because per-flow attribution is not measurable today (H3).
  // Best-effort: the file lives in the regenerable mirror, so this learning is not yet
  // durable across host loss (a separate decision).
  if (!isCode && result?.specMetas && result.specMetas.length > 0 && deps.recordMeasured) {
    const coveredFiles = ccForPersistence
      ? ccForPersistence.perFile.filter((f) => f.covered > 0).map((f) => f.file)
      : [];
    deps.recordMeasured(e2eDir, { cases: run.cases, coveredFiles });
  }

  let valueScore: number | null = null;

  // The value oracle — the ground-truth that makes attribution mean something. code: mutation
  // testing scoped to the diff. e2e: response fault-injection against the SAME live DEV (opt-in,
  // signal-only) — never a redeploy. Off-path and fail-open: any error is a non-blocking warning,
  // and the score NEVER gates publish.
  const valueOraclePolicy = app.qa.valueOracle ?? "off";
  // e2e is restricted to `diff` ON PURPOSE: fault-injection re-runs the WHOLE suite corrupted, so
  // running it on a `complete`/`exhaustive` whole-repo suite would double a very large run for a
  // diffuse signal. code mutation runs in any mode (it is diff-scoped and cheap). Both are opt-in
  // / signal-only and never block.
  const runValueOracle =
    !!deps.runOracle && generating && run.verdict === "pass" &&
    (isCode || (mode === "diff" && valueOraclePolicy === "signal" && !!app.dev?.baseUrl));
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
      });
      valueScore = oracleResult.valueScore;
      if (valueScore !== null) {
        log(`[qa] oracle: valueScore=${(valueScore * 100).toFixed(0)}% (${oracleResult.details})`);
      } else {
        log(`[qa] oracle: no value score — ${oracleResult.details}`);
      }
      // Record the outcome in the app's versioned scorecard (proof-of-improvement over runs).
      try {
        const { saveScorecardEntry } = await import("./server/history");
        saveScorecardEntry({
          runId: opts.runId ?? sha,
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

  // Attribution: fold this run's valueScore into each retrieved rule's running statistics
  // (running mean, promotion/demotion with hysteresis). NEVER an overwrite — one outcome
  // barely moves an established rule, so a fluke cannot poison the ledger.
  if (retrievedRuleIds.length > 0 && valueScore !== null) {
    const { recordRuleOutcome } = await import("./server/history");
    try {
      for (const ruleId of retrievedRuleIds) {
        recordRuleOutcome(ruleId, valueScore);
      }
      log(`[qa] attribution: recorded outcome (valueScore=${(valueScore * 100).toFixed(0)}%) for ${retrievedRuleIds.length} rule(s)`);
    } catch (err) {
      log(`[qa] WARNING: attribution update failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Record archetype hits when valueScore proves the run's scenarios
  if (curriculum && valueScore !== null && valueScore > 0) {
    const patterns = detectStructuralPatterns(diff, intent?.changedFiles ?? []);
    const exemplars = patterns.flatMap((p) => matchExemplars(p));
    for (const ex of exemplars) {
      curriculum = recordArchetypeHit(curriculum, ex.archetype);
    }
    clearActiveArchetypesCache(app.name);
  }

  // 9. Final decision.
  const kind = isCode ? "code" : "E2E";
  if (run.verdict !== "pass") {
    await report(app, sha, run, deps, log, shadow, isCode, result?.note);
  } else if (!generating) {
    // Regression passed: there are no new tests to publish.
    log(`[qa] OK — regression green for ${sha}.`);
  } else if (app.qa.needsReview && !result!.approved) {
    // Green in the harness BUT the independent reviewer rejected it (it catches
    // false positives the harness cannot) → do not publish; report for iteration.
    await issueOrShadow(
      shadow,
      deps,
      log,
      app.repo,
      `QA: the reviewer did not approve the ${kind} tests for ${sha}`,
      renderIssue(run, result!.note),
    );
  } else if (blocksPublish(coverageStatus, covPolicy)) {
    // Green AND reviewer-approved, but the tests do not exercise enough of the change (enforce):
    // do NOT publish a suite that would not catch a regression in the changed code.
    await issueOrShadow(
      shadow,
      deps,
      log,
      app.repo,
      `QA: ${kind} tests for ${sha} are below the change-coverage threshold`,
      renderIssue(run, coverageSummary || result?.note),
    );
  } else if (shadow) {
    log(`[qa] (shadow) ${kind} green; a suite PR would have been opened.`);
  } else {
    const prInput = { repo: app.repo, sha, mirrorDir, baseBranch: app.baseBranch ?? "main", parentRunId: opts.parentRunId };
    const pr = isCode ? await deps.publishCode(prInput) : await deps.publish(prInput);
    log(
      pr
        ? pr.merged
          ? `[qa] OK — ${kind} green; suite PR merged: ${pr.prUrl}`
          : `[qa] OK — ${kind} green; suite PR opened but NOT merged (merge it manually): ${pr.prUrl}`
        : `[qa] OK — ${kind} green (no new tests to publish).`,
    );
  }
  // Surface the agent's note (reviewer rejection, generation summary) in the
  // result so the TUI/chat can show why a retry or skip happened.
  if (result?.note && !run.note) run.note = result.note;

  const ratio = ccForPersistence?.overall.ratio ?? null;
  persistOutcome(run, { staticOk: !isCode && generating, coverageRatio: ratio, valueScore, rulesRetrieved: retrievedRuleIds });

  if (deps.reflectAndDistill && opts.runId) {
    const labeled = labelRunOutcome({
      runId: opts.runId, app: app.name, sha, mode, target: opts.target ?? "e2e",
      verdict: run.verdict, staticOk: !isCode && generating,
      coverageRatio: ratio,
      minCoverageRatio: app.qa.changeCoverage?.minRatio ?? DEFAULT_COVERAGE_POLICY.minRatio,
      reviewerCorrections, flaky: run.verdict === "flaky", retries,
      valueScore,
    });
    if (labeled.errorClass && labeled.errorClass !== "E-INFRA" && labeled.errorClass !== "E-FLAKY") {
      const outcome: RunOutcome = { ...labeled, gateSignals: { ...labeled.gateSignals, valueScore: valueScore ?? null }, rulesRetrieved: retrievedRuleIds, at: labeled.at };
      deps
        .reflectAndDistill({ app: app.name, runId: opts.runId, outcome })
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

  return run;
}

function resultOf(ns: string, verdict: QaRunResult["verdict"], logs: string, note?: string): QaRunResult {
  return { sha: ns, verdict, passed: false, cases: [], logs, note };
}

// Open an Issue only for a real failure or invalid specs. Flaky → quarantine.
// Infra errors → log only. In shadow mode no Issue is ever opened.
async function report(
  app: AppConfig,
  sha: string,
  run: QaRunResult,
  deps: PipelineDeps,
  log: (m: string) => void,
  shadow: boolean,
  isCode: boolean,
  note?: string,
): Promise<void> {
  if (app.report.onFailure !== "github-issue") return;
  const kind = isCode ? "code" : "E2E";
  switch (run.verdict) {
    case "fail":
      await issueOrShadow(shadow, deps, log, app.repo, `QA ${kind} tests failed at ${sha}`, renderIssue(run, note));
      break;
    case "invalid":
      await issueOrShadow(shadow, deps, log, app.repo, `QA could not validate the generated ${kind} tests at ${sha}`, renderIssue(run, note));
      break;
    case "infra-error":
      log(`[qa] INFRA — ${run.logs} — not reported as a bug.`);
      break;
    case "flaky":
      log(`[qa] FLAKY — ${flakyNames(run)} quarantined (no PR, no failure Issue).`);
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
): Promise<void> {
  if (shadow) {
    log(`[qa] (shadow) would have opened an Issue: "${title}"`);
    return;
  }
  const issue = await deps.openIssue(repo, title, body);
  log(`[qa] Issue opened: ${issue.url}`);
}

function flakyNames(run: QaRunResult): string {
  return run.cases.filter((c) => c.status === "flaky").map((c) => c.name).join(", ");
}
