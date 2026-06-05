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
import { runOpencode, defaultOpencodeDeps } from "./integrations/opencode-client";
import { classifyCommit, CommitIntent } from "./qa/commit-classify";
import { setupE2eProject, defaultSetupDeps } from "./qa/setup";
import { validateSpecs, defaultValidateDeps } from "./qa/validate";
import { runE2E, defaultExecuteDeps } from "./qa/execute";
import { publishE2e, defaultPublishDeps } from "./integrations/publish";
import { testDataNamespace } from "./qa/test-data";
import { github } from "./integrations/github";
import { renderIssue } from "./report/reporter";
import { AgentResult, QaRunResult, TriggerSource } from "./types";

// Tests live in this folder inside the repo (git is the source of truth).
const E2E_DIR = "e2e";

export interface GenerateInput {
  repo: string;
  sha: string;
  diff: string;
  mirrorDir: string;
  namespace: string;
  needsReview: boolean;
  intent: CommitIntent; // type + message + files; the agent derives the objective from it
}

export interface PipelineDeps {
  waitForDeploy(target: DeployTarget, sha: string): Promise<void>;
  prepare(repo: string, sha: string): Promise<{ mirrorDir: string; diff: string; message: string }>;
  generate(input: GenerateInput): Promise<AgentResult>;
  setupE2e(e2eDir: string): Promise<void>; // installs the e2e project's dependencies
  validate(e2eDir: string): Promise<{ ok: boolean; errors: string[] }>;
  execute(e2eDir: string, opts: { baseUrl: string; namespace: string }): Promise<QaRunResult>;
  isHealthy(versionUrl: string): Promise<boolean>; // is DEV healthy right now? (infra vs quality)
  publish(input: { repo: string; sha: string; mirrorDir: string; baseBranch: string }): Promise<{ prUrl: string } | null>;
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
    generate: async (input) =>
      runOpencode(
        {
          repo: input.repo,
          sha: input.sha,
          diff: input.diff,
          mirrorDir: input.mirrorDir,
          e2eRelDir: E2E_DIR,
          namespace: input.namespace,
          needsReview: input.needsReview,
          intent: input.intent,
        },
        await defaultOpencodeDeps(),
      ),
    setupE2e: (e2eDir) => setupE2eProject(e2eDir, defaultSetupDeps),
    validate: (e2eDir) => validateSpecs(e2eDir, defaultValidateDeps),
    execute: (e2eDir, opts) => runE2E(e2eDir, opts, defaultExecuteDeps),
    isHealthy: async (versionUrl) => {
      try {
        const res = await fetch(versionUrl);
        if (!res.ok) return false;
        return ((await res.json()) as { healthy?: boolean }).healthy === true;
      } catch {
        return false;
      }
    },
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
): Promise<QaRunResult> {
  const log = deps.log ?? (() => {});
  const shadow = app.qa.shadow ?? false;
  log(`[qa] app=${app.name}  sha=${sha}  (${source})${shadow ? "  [SHADOW MODE]" : ""}`);

  // 1. Gate: wait until DEV runs this SHA and is healthy. Skipped when no
  //    version endpoint is configured (the site is assumed already deployed).
  const versionUrl = app.dev.versionUrl;
  const devHealthy = () => (versionUrl ? deps.isHealthy(versionUrl) : Promise.resolve(true));
  if (versionUrl) {
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

  // 3. Classify the commit (Conventional Commits, cross-checked against the diff):
  //    skip → nothing to test; regression → run the existing suite without
  //    generating; generate → full flow.
  const cls = classifyCommit(message, diff);
  log(`[qa] commit '${cls.type}' → ${cls.action}${cls.contradiction ? " (message/diff contradiction)" : ""}: ${cls.reason}`);
  if (cls.action === "skip") {
    log(`[qa] no testable objective (${cls.type}); nothing to run.`);
    return { sha: ns, verdict: "skipped", passed: true, cases: [], logs: cls.reason };
  }
  const generating = cls.action === "generate";

  // 4. Generate (only when applicable): the agent writes/improves `e2e/`.
  let result: AgentResult | null = null;
  if (generating) {
    log("[qa] generating E2E tests with OpenCode...");
    result = await deps.generate({
      repo: app.repo,
      sha,
      diff,
      mirrorDir,
      namespace: ns,
      needsReview: app.qa.needsReview,
      intent: cls,
    });
  } else {
    log("[qa] regression: not generating tests; validating and running the existing suite.");
  }

  // 5. Filter B — static gate over `e2e/` (install deps + typecheck/lint/list/manifest).
  await deps.setupE2e(e2eDir);
  log("[qa] validating specs (typecheck + lint + list + manifest)...");
  const validation = await deps.validate(e2eDir);
  if (!validation.ok) {
    const invalid = resultOf(ns, "invalid", validation.errors.join("\n\n"));
    await report(app, sha, invalid, deps, log, shadow, "the E2E tests did not pass the static gate");
    return invalid;
  }

  // 6. Health pre-flight: DEV may have gone down during generation. If it is not
  //    healthy the run is inconclusive → infra error, not reported as a bug.
  if (!(await devHealthy())) {
    const infra = resultOf(ns, "infra-error", "DEV is not healthy before execution");
    await report(app, sha, infra, deps, log, shadow);
    return infra;
  }

  // 7. Filter C — run against DEV (classifies pass/fail/flaky).
  log(`[qa] running E2E (namespace ${ns}) against ${app.dev.baseUrl}...`);
  let run = await deps.execute(e2eDir, { baseUrl: app.dev.baseUrl, namespace: ns });

  // 8. Infra vs quality: if there were failures BUT DEV is no longer healthy, the
  //    failures are infrastructure, not code → reclassify so no false Issue is opened.
  if (run.verdict === "fail" && !(await devHealthy())) {
    run = resultOf(ns, "infra-error", "failures with an unhealthy DEV: treated as infrastructure");
  }

  // 9. Final decision.
  if (run.verdict !== "pass") {
    await report(app, sha, run, deps, log, shadow, result?.note);
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
      `QA: the reviewer did not approve the E2E tests for ${sha}`,
      renderIssue(run, result!.note),
    );
  } else if (shadow) {
    log(`[qa] (shadow) E2E green; a suite PR would have been opened.`);
  } else {
    const pr = await deps.publish({ repo: app.repo, sha, mirrorDir, baseBranch: app.baseBranch ?? "main" });
    log(pr ? `[qa] OK — E2E green; suite PR: ${pr.prUrl}` : `[qa] OK — E2E green (no changes in e2e/).`);
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
  note?: string,
): Promise<void> {
  if (app.report.onFailure !== "github-issue") return;
  switch (run.verdict) {
    case "fail":
      await issueOrShadow(shadow, deps, log, app.repo, `QA E2E failed at ${sha}`, renderIssue(run, note));
      break;
    case "invalid":
      await issueOrShadow(shadow, deps, log, app.repo, `QA could not validate the generated E2E tests at ${sha}`, renderIssue(run, note));
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
