// Full QA pipeline, shared by every trigger (manual CLI and webhook). The
// deterministic infrastructure lives here (gate, working copy, harness,
// publishing, reporting); the agentic generation is delegated to OpenCode
// (see integrations/opencode-client.ts + opencode/opencode.json). The source of
// truth for the tests is the repo's `e2e/` folder in git, not a volume. Steps
// that touch the network or have side effects are injected via PipelineDeps, so
// ordering and branches are verifiable with stubs.

import { join } from "node:path";
import { AppConfig } from "./orchestrator/config-loader";
import { DeployTarget, waitForDeploy } from "./env/deploy-gate";
import { ensureMirror, getCommitDiff, getCommitMessage, defaultMirrorDeps } from "./integrations/repo-mirror";
import { runOpencode, defaultOpencodeDeps, reviewIndependently } from "./integrations/opencode-client";
import { classifyCommit, CommitIntent } from "./qa/commit-classify";
import { setupE2eProject, defaultSetupDeps } from "./qa/setup";
import { validateSpecs, defaultValidateDeps } from "./qa/validate";
import { runE2E, defaultExecuteDeps, defaultCleanupDeps } from "./qa/execute";
import { setupCodeProject, defaultCodeSetupDeps, runCodeTests, defaultCodeExecuteDeps } from "./qa/code-runner";
import { publishE2e, publishCode, defaultPublishDeps } from "./integrations/publish";
import { testDataNamespace } from "./qa/test-data";
import { github } from "./integrations/github";
import { renderIssue } from "./report/reporter";
import { AgentResult, QaCase, QaRunResult, TriggerSource, RunMode, RunOptions, TestTarget } from "./types";
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
}

export interface PipelineDeps {
  waitForDeploy(target: DeployTarget, sha: string): Promise<void>;
  prepare(repo: string, sha: string): Promise<{ mirrorDir: string; diff: string; message: string }>;
  generate(input: GenerateInput, signal?: AbortSignal, onProgress?: (msg: string) => void): Promise<AgentResult>;
  setupE2e(e2eDir: string): Promise<void>; // installs the e2e project's dependencies
  validate(e2eDir: string): Promise<{ ok: boolean; errors: string[] }>;
  execute(e2eDir: string, opts: { baseUrl: string; namespace: string; onCase?: (c: QaCase) => void }): Promise<QaRunResult>;
  cleanup(e2eDir: string, opts: { baseUrl: string; namespace: string }): Promise<void>; // orphan-data cleanup (best-effort)
  isHealthy(versionUrl: string): Promise<boolean>; // is DEV healthy right now? (infra vs quality)
  review?(input: ReviewInput, signal?: AbortSignal): Promise<ReviewResult>; // independent reviewer (null = disabled)
  publish(input: { repo: string; sha: string; mirrorDir: string; baseBranch: string }): Promise<{ prUrl: string } | null>;
  // Code mode (target "code"): no web env, no Playwright. Install the repo's deps,
  // run its own test suite, classify by exit code, and publish the new tests.
  setupCode(repoDir: string): Promise<void>;
  executeCode(repoDir: string, opts: { namespace: string; onCase?: (c: QaCase) => void }): Promise<QaRunResult>;
  publishCode(input: { repo: string; sha: string; mirrorDir: string; baseBranch: string }): Promise<{ prUrl: string } | null>;
  openIssue(repo: string, title: string, body: string): Promise<{ url: string }>;
  log?(msg: string): void;
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
    generate: async (input, signal, onProgress) =>
      runOpencode(
        {
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
        },
        await defaultOpencodeDeps(),
        { signal, onProgress },
      ),
    setupE2e: (e2eDir) => setupE2eProject(e2eDir, defaultSetupDeps),
    validate: (e2eDir) => validateSpecs(e2eDir, defaultValidateDeps),
    execute: (e2eDir, opts) => runE2E(e2eDir, opts, defaultExecuteDeps),
    cleanup: (e2eDir, opts) => defaultCleanupDeps.runCleanup({ dir: e2eDir, ...opts }),
    setupCode: (repoDir) => setupCodeProject(repoDir, defaultCodeSetupDeps),
    executeCode: (repoDir, opts) => runCodeTests(repoDir, opts, defaultCodeExecuteDeps),
    publishCode: (input) => publishCode(input, defaultPublishDeps),
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
    publish: (input) => publishE2e(input, defaultPublishDeps),
    openIssue: (repo, title, body) => github.openIssue(repo, title, body),
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
): Promise<QaRunResult> {
  const checkSignal = () => {
    if (signal?.aborted) throw new Error("run cancelled by operator");
  };
  const log = deps.log ?? (() => {});
  const shadow = app.qa.shadow ?? false;
  const mode = opts.mode;
  const isCode = (opts.target ?? "e2e") === "code";
  log(
    `[qa] app=${app.name}  sha=${sha}  mode=${mode}  target=${isCode ? "code" : "e2e"}  (${source})` +
      (shadow ? "  [SHADOW MODE]" : ""),
  );

  // 1. Gate: wait until DEV runs this SHA and is healthy. Skipped for code mode (no
  //    web environment) and when no version endpoint is configured (already deployed).
  const versionUrl = isCode ? undefined : app.dev?.versionUrl;
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
  const ns = testDataNamespace(app.qa.testDataPrefix, sha);

  checkSignal();

  // 3. Classify the commit (Conventional Commits, cross-checked against the diff)
  //    — ONLY in "diff" mode. Other modes (complete/exhaustive/manual) are
  //    whole-repo or guided tasks, so they always generate.
  let generating = true;
  let intent: CommitIntent | undefined;

  // A human-in-the-loop continuation always generates (the human marked failing
  // tests to fix); it never takes the "skip" path.
  const isContinuation = (opts.fixCases?.length ?? 0) > 0;
  if (isContinuation) {
    log(`[qa] continuation of ${opts.parentRunId ?? "?"}: fixing ${opts.fixCases!.length} case(s) with human guidance.`);
  }

  onStep?.("classify");
  if (mode === "diff") {
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
  //    so its test suite can run.
  if (isCode) {
    log("[qa] code mode: installing the repo's dependencies...");
    await deps.setupCode(mirrorDir);
  } else {
    await deps.setupE2e(e2eDir);
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

  // 5. Generate (only when applicable): the agent writes/improves `e2e/`.
  let result: AgentResult | null = null;
  if (generating) {
    checkSignal();
    onStep?.("generate");
    log("[qa] generating E2E tests with OpenCode...");
    result = await deps.generate({
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
      fixCases: opts.fixCases,
      openapi: app.openapi,
    }, signal, log);

    // Independent review: when review is enabled, the orchestrator opens a SEPARATE
    // qa-reviewer session (not the generator's subagent) so the verdict is genuinely
    // independent. The independent verdict OVERRIDES the generator's self-reported
    // approval — this breaks the circular quality loop documented in AGENTS.md.
    if (result.specs.length > 0 && app.qa.needsReview && deps.review) {
      log("[qa] invoking independent reviewer (separate session)...");
      try {
        const review = await deps.review({
          diff,
          specs: result.specs,
          mirrorDir,
          e2eRelDir: E2E_DIR,
          baseUrl: app.dev?.baseUrl,
          intent,
          appName: app.name,
          mode,
        }, signal);
        log(`[qa] independent reviewer: approved=${review.approved} corrections=${review.corrections.length}`);
        if (!review.approved) {
          result = { ...result, approved: false, note: review.corrections.join("; ") };
        }
      } catch (err) {
        log(`[qa] independent reviewer failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
        // Fail open: if the reviewer crashes, trust the generator's verdict.
      }
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
      const invalid = resultOf(ns, "invalid", validation.errors.join("\n\n"));
      await report(app, sha, invalid, deps, log, shadow, isCode, "the E2E tests did not pass the static gate");
      return invalid;
    }

    // Health pre-flight: DEV may have gone down during generation. If it is not
    // healthy the run is inconclusive → infra error, not reported as a bug.
    if (!(await devHealthy())) {
      const infra = resultOf(ns, "infra-error", "DEV is not healthy before execution");
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
    run = await deps.executeCode(mirrorDir, { namespace: ns, onCase });
  } else if (!app.dev) {
    // Defensive: an e2e run on an app with no dev environment is inconclusive.
    run = resultOf(ns, "infra-error", "e2e run requested but no dev environment is configured");
    await report(app, sha, run, deps, log, shadow, isCode);
    return run;
  } else {
    onStep?.("execute");
    log(`[qa] running E2E (namespace ${ns}) against ${app.dev.baseUrl}...`);
    run = await deps.execute(e2eDir, { baseUrl: app.dev.baseUrl, namespace: ns, onCase });
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
    result = await deps.generate({
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
      fixCases: failed,
    }, signal, log);
    log(
      `[qa] agent (retry): approved=${result.approved} specs=[${result.specs.join(", ")}]` +
        (result.note ? ` note=${result.note}` : ""),
    );

    if (result.specs.length > 0 && app.qa.needsReview && deps.review) {
      log("[qa] independent review of retry specs...");
      try {
        const retryReview = await deps.review({
          diff, specs: result.specs, mirrorDir,
          e2eRelDir: E2E_DIR, baseUrl: app.dev?.baseUrl,
          intent, appName: app.name, mode,
        }, signal);
        if (!retryReview.approved) {
          result = { ...result, approved: false, note: retryReview.corrections.join("; ") };
        }
      } catch (err) {
        log(`[qa] independent reviewer failed on retry (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (result.specs.length === 0) {
      log("[qa] retry agent produced no fixes; keeping original verdict.");
      break;
    }

    if (isCode) {
      log("[qa] re-running the repo's test suite with the fixed tests...");
      run = await deps.executeCode(mirrorDir, { namespace: ns, onCase });
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
      const retryRun = await deps.execute(e2eDir, { baseUrl: app.dev?.baseUrl ?? "", namespace: ns, onCase });
      if (retryRun.verdict === "fail" && !(await devHealthy())) {
        run = resultOf(ns, "infra-error", "failures with an unhealthy DEV: treated as infrastructure");
        break;
      }
      run = retryRun;
    }
    log(`[qa] retry verdict: ${run.verdict}`);
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
  } else if (shadow) {
    log(`[qa] (shadow) ${kind} green; a suite PR would have been opened.`);
  } else {
    const prInput = { repo: app.repo, sha, mirrorDir, baseBranch: app.baseBranch ?? "main" };
    const pr = isCode ? await deps.publishCode(prInput) : await deps.publish(prInput);
    log(pr ? `[qa] OK — ${kind} green; suite PR: ${pr.prUrl}` : `[qa] OK — ${kind} green (no new tests to publish).`);
  }
  return run;
}

function resultOf(ns: string, verdict: QaRunResult["verdict"], logs: string): QaRunResult {
  return { sha: ns, verdict, passed: false, cases: [], logs };
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
