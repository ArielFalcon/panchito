// Publishes the generated E2E tests as a PR (with auto-merge when possible). This
// is the real PERSISTENCE: the source of truth for the tests is the app repo's
// `e2e/` folder in git, not a volume. Every green run opens a PR with whatever
// the agent wrote/improved in `e2e/`; if nothing changed, no PR is opened.
//
// git and the GitHub calls are injected, so the logic (skip-when-no-changes,
// branching, best-effort auto-merge) is verifiable with stubs; the real push/PR
// is the integration boundary.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Git, realGit, authHeaderArgs } from "./repo-mirror";
import { github, PullRequest } from "./github";
import { shortSha } from "../qa/test-data";
import { renderPrBody, type TestedItem } from "../report/reporter";

export interface PublishInput {
  repo: string;
  sha: string;
  mirrorDir: string; // working copy of the repo (where `e2e/` lives)
  baseBranch: string;
  parentRunId?: string; // continuation provenance: stamps the PR body so a coerced-green chain is traceable
  tested?: TestedItem[]; // what the agent reported testing (flow + objective) — documents the PR
}

export interface PublishDeps {
  git: Git;
  createPullRequest(repo: string, args: { title: string; head: string; base: string; body: string }): Promise<PullRequest>;
  enableAutoMerge(nodeId: string): Promise<void>;
  mergePullRequest(repo: string, number: number): Promise<void>; // direct-merge fallback
  writeExcludes?(mirrorDir: string, patterns: string[]): void | Promise<void>; // local ignore patterns
  log?(msg: string): void;
}

// `merged` reports whether the tests will actually land: auto-merge enabled OR a direct
// merge succeeded. false means the PR is open but unmerged — the "commit tests back"
// promise is unmet for this run (surfaced loudly).
// `error` is set when the push/PR step itself FAILED (e.g. a same-head 422, a rejected
// push). In that case prUrl is null: the run still PASSED, the side-effect just did not
// land, and the caller must NOT let it masquerade as an infra-error that erases the verdict.
export type PublishResult = { prUrl: string | null; merged: boolean; error?: string };

// We stage with a PLAIN directory pathspec and keep unwanted paths out via local ignore
// patterns (.git/info/exclude), NOT a `:(exclude)` pathspec. A `:(exclude)` that names an
// already-gitignored path makes `git add` fail with "ignored … use -f" — that is the
// node_modules/.gitignore infra-error. gitignore semantics also catch NESTED node_modules
// (monorepos) that a root-anchored `:(exclude)node_modules/` missed.

// e2e/: stage the suite; exclude installed deps + the volatile change-coverage / measured
// fields (committing them would bloat PRs and make "did anything change?" always true).
const E2E_ADD = ["e2e"];
const E2E_EXCLUDES = ["node_modules/", ".qa/coverage/", ".qa/measured.json"];

// Code mode: tests can live anywhere (the agent matches the repo's conventions) — commit
// the whole tree, minus installed deps, build output and run artifacts.
const CODE_ADD = ["."];
const CODE_EXCLUDES = [
  "node_modules/",
  ".env",
  ".env.*",
  "*.env",
  "dist/",
  "build/",
  "__pycache__/",
  "*.pyc",
  ".venv/",
  "venv/",
  "target/",
  ".next/",
  "coverage/",
  "e2e/.qa/coverage/",
  // Mutation-oracle artifacts (qa/learning/mutation-code.ts) — cleaned up best-effort after
  // the pass, but a crash between Stryker and publish must never commit them into the PR.
  ".stryker-tmp/",
  "stryker.conf.json",
  "reports/mutation/",
];

// Context map: stage ONLY the context file — never seed fixtures or specs.
const CONTEXT_ADD = ["e2e/.qa/context.json"];

interface PublishShape {
  addDir: string[]; // dir/file pathspec to stage (plain — exclusions live in .git/info/exclude)
  excludes: string[]; // gitignore-style patterns written to .git/info/exclude before staging
  branch: string;
  commitMsg: string;
  title: string;
  body: string;
  noChangeLog: string;
}

// Shared publish core: branch, commit the staged pathspec, push, open a PR with
// best-effort auto-merge. Skips entirely when the relevant pathspec has no changes.
async function publishChanges(input: PublishInput, deps: PublishDeps, shape: PublishShape): Promise<PublishResult | null> {
  const { mirrorDir, repo, baseBranch } = input;

  // Apply local ignore patterns first, so both the change check and the `git add` below
  // silently skip installed deps / artifacts instead of failing on an ignored path.
  await deps.writeExcludes?.(mirrorDir, shape.excludes);

  const status = await deps.git(["status", "--porcelain", "--", ...shape.addDir], mirrorDir);
  if (!status.trim()) {
    deps.log?.(shape.noChangeLog);
    return null;
  }

  const name = process.env.GIT_AUTHOR_NAME ?? "panchito";
  const email = process.env.GIT_AUTHOR_EMAIL ?? "panchito@users.noreply.github.com";

  // The branch/commit/push/open-PR side-effect can fail for reasons unrelated to the run's
  // verdict: a rejected push (force-with-lease conflict, transient network/auth) or a
  // same-head 422 from createPullRequest when a prior PR for this SHA is still open. The run
  // already PASSED; a failure here must surface loudly but must NOT throw out of the pipeline,
  // where the runner catch-all would overwrite the real verdict with "infra-error" and skip
  // persisting the green outcome. Return a published:false result instead.
  let pr: PullRequest;
  try {
    await deps.git(["checkout", "-B", shape.branch], mirrorDir);
    await deps.git(["add", "--", ...shape.addDir], mirrorDir);
    await deps.git(
      ["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-m", shape.commitMsg],
      mirrorDir,
    );
    await deps.git([...authHeaderArgs(), "push", "--force-with-lease", "-u", "origin", shape.branch], mirrorDir);
    pr = await deps.createPullRequest(repo, { title: shape.title, head: shape.branch, base: baseBranch, body: shape.body });
  } catch (e) {
    const error = String(e);
    deps.log?.(`[qa] WARNING: the run PASSED but publishing the suite (${shape.branch}) FAILED: ${error}. The tests are committed in the working copy but were NOT pushed/PR'd — verdict preserved; re-run or publish manually.`);
    return { prUrl: null, merged: false, error };
  }

  // Land the tests. Prefer native auto-merge; if the repo does not allow it (no branch
  // protection / not enabled), fall back to a DIRECT merge — the harness already proved
  // this green and the PR is test-only, so the central "commit tests back" promise must
  // not silently fail. Only if BOTH fail do we leave the PR open, loudly.
  let merged = false;
  try {
    await deps.enableAutoMerge(pr.nodeId);
    merged = true;
    deps.log?.(`[qa] PR opened with auto-merge: ${pr.url}`);
  } catch (e) {
    deps.log?.(`[qa] auto-merge unavailable (${String(e)}); attempting a direct merge of ${pr.url}...`);
    try {
      await deps.mergePullRequest(repo, pr.number);
      merged = true;
      deps.log?.(`[qa] PR merged directly: ${pr.url}`);
    } catch (e2) {
      deps.log?.(`[qa] WARNING: ${pr.url} could NOT be merged (auto-merge and direct merge both failed: ${String(e2)}). The tests are NOT committed back — merge it manually.`);
    }
  }
  return { prUrl: pr.url, merged };
}

export async function publishE2e(input: PublishInput, deps: PublishDeps): Promise<PublishResult | null> {
  const short = shortSha(input.sha);
  return publishChanges(input, deps, {
    addDir: E2E_ADD,
    excludes: E2E_EXCLUDES,
    branch: `qa/e2e-${short}`,
    commitMsg: `test(e2e): automated QA for ${short}`,
    title: `QA E2E for ${short}`,
    body: renderPrBody({ sha: input.sha, isCode: false, tested: input.tested, parentRunId: input.parentRunId }),
    noChangeLog: "[qa] no changes in e2e/ — the suite already covers the change, no PR opened.",
  });
}

// Context mode: publish the FE↔BE architecture map (e2e/.qa/context.json). Only the
// context file is staged — seed fixtures and test specs are NEVER included.
export async function publishContext(input: PublishInput, deps: PublishDeps): Promise<PublishResult | null> {
  const short = shortSha(input.sha);
  return publishChanges(input, deps, {
    addDir: CONTEXT_ADD,
    excludes: [],
    branch: `qa/context-${short}`,
    commitMsg: `docs(context): architecture map for ${short}`,
    title: `QA context map for ${short}`,
    body: `FE↔BE architecture map generated by panchito for \`${input.sha}\`. Maps routes → API operations extracted from routing, OpenAPI specs, and generated API clients.`,
    noChangeLog: "[qa] context map unchanged since last generation — no PR opened.",
  });
}

export async function publishCode(input: PublishInput, deps: PublishDeps): Promise<PublishResult | null> {
  const short = shortSha(input.sha);
  return publishChanges(input, deps, {
    addDir: CODE_ADD,
    excludes: CODE_EXCLUDES,
    branch: `qa/code-${short}`,
    commitMsg: `test(code): automated QA for ${short}`,
    title: `QA code tests for ${short}`,
    body: renderPrBody({ sha: input.sha, isCode: true, tested: input.tested, parentRunId: input.parentRunId }),
    noChangeLog: "[qa] no test changes in the repo — nothing new to cover, no PR opened.",
  });
}

// Dependency-closure for per-file subset publish: shared non-spec e2e infra that kept
// specs may import. Staged alongside the selected spec files; NEVER includes volatile
// coverage/measured fields (already in E2E_EXCLUDES) or unselected spec files.
const DEP_CLOSURE_PATHS = ["e2e/.qa/"];

/**
 * Publishes only a specified subset of spec files to a PR (quality-filtered-dual-publish).
 *
 * Stages `files` (triage `pr[]` basenames mapped to `e2e/<file>` pathspecs) + the DEP_CLOSURE
 * (`e2e/.qa/`) via EXPLICIT per-file git pathspecs — NOT the directory pathspec `["e2e"]`.
 * Reuses `publishChanges` with the same branch/commit/PR/auto-merge + `E2E_EXCLUDES`.
 * No-change-skip still applies: if the subset produces no diff, returns null.
 *
 * `files` are e2e-relative basenames from the triage `pr[]` (e.g. `["login.spec.ts"]` or
 * `["flows/checkout.spec.ts"]`). They are mapped to repo-relative pathspecs (`e2e/<file>`).
 *
 * `publishE2e` (whole-dir) is left intact and called on the flag-OFF path.
 */
export async function publishE2eSubset(
  input: PublishInput,
  files: string[],
  deps: PublishDeps,
): Promise<PublishResult | null> {
  const short = shortSha(input.sha);
  // Map triage basenames to repo-relative pathspecs
  const filePathspecs = files.map((f) => `e2e/${f}`);
  const addDir = [...filePathspecs, ...DEP_CLOSURE_PATHS];
  return publishChanges(input, deps, {
    addDir,
    excludes: E2E_EXCLUDES,
    branch: `qa/e2e-${short}`,
    commitMsg: `test(e2e): automated QA for ${short} (subset: ${files.join(", ")})`,
    title: `QA E2E for ${short} (subset)`,
    body: renderPrBody({ sha: input.sha, isCode: false, tested: input.tested, parentRunId: input.parentRunId }),
    noChangeLog: "[qa] no changes in e2e/ subset — the selected specs already match the base, no PR opened.",
  });
}

export const defaultPublishDeps: PublishDeps = {
  git: realGit,
  createPullRequest: (repo, args) => github.createPullRequest(repo, args),
  enableAutoMerge: (nodeId) => github.enableAutoMerge(nodeId),
  mergePullRequest: (repo, number) => github.mergePullRequest(repo, number),
  // Write our managed local-exclude file (the mirror's .git is system-owned/regenerable).
  // gitignore-style patterns here make `git add` skip installed deps + artifacts WITHOUT a
  // :(exclude) pathspec, which is the fix for the node_modules/.gitignore add failure.
  writeExcludes: (mirrorDir, patterns) => {
    const dir = join(mirrorDir, ".git", "info");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "exclude"), patterns.map((p) => p + "\n").join(""));
  },
  log: (m) => console.log(m),
};
