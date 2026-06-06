// Publishes the generated E2E tests as a PR (with auto-merge when possible). This
// is the real PERSISTENCE: the source of truth for the tests is the app repo's
// `e2e/` folder in git, not a volume. Every green run opens a PR with whatever
// the agent wrote/improved in `e2e/`; if nothing changed, no PR is opened.
//
// git and the GitHub calls are injected, so the logic (skip-when-no-changes,
// branching, best-effort auto-merge) is verifiable with stubs; the real push/PR
// is the integration boundary.

import { Git, realGit, authHeaderArgs } from "./repo-mirror";
import { github, PullRequest } from "./github";
import { shortSha } from "../qa/test-data";

export interface PublishInput {
  repo: string;
  sha: string;
  mirrorDir: string; // working copy of the repo (where `e2e/` lives)
  baseBranch: string;
}

export interface PublishDeps {
  git: Git;
  createPullRequest(repo: string, args: { title: string; head: string; base: string; body: string }): Promise<PullRequest>;
  enableAutoMerge(nodeId: string): Promise<void>;
  log?(msg: string): void;
}

// Commit e2e/ EXCEPT the volatile change-coverage dumps (e2e/.qa/coverage/*): committing them
// would bloat PRs and, worse, make the "did anything change?" check think every run has changes.
const E2E_PATHSPEC = ["e2e", ":(exclude)e2e/.qa/coverage", ":(exclude)e2e/.qa/coverage/**"];
// Code-mode tests can live anywhere in the repo (the agent matches the repo's
// conventions) — commit the whole tree, but never the installed dependencies.
const CODE_PATHSPEC = [".", ":(exclude)node_modules", ":(exclude)**/node_modules", ":(exclude)e2e/.qa/coverage/**"];

interface PublishShape {
  statusPathspec: string[]; // pathspec for the "did anything change?" check
  addPathspec: string[]; // pathspec to stage
  branch: string;
  commitMsg: string;
  title: string;
  body: string;
  noChangeLog: string;
}

// Shared publish core: branch, commit the staged pathspec, push, open a PR with
// best-effort auto-merge. Skips entirely when the relevant pathspec has no changes.
async function publishChanges(input: PublishInput, deps: PublishDeps, shape: PublishShape): Promise<{ prUrl: string } | null> {
  const { mirrorDir, repo, baseBranch } = input;

  const status = await deps.git(["status", "--porcelain", "--", ...shape.statusPathspec], mirrorDir);
  if (!status.trim()) {
    deps.log?.(shape.noChangeLog);
    return null;
  }

  const name = process.env.GIT_AUTHOR_NAME ?? "ai-pipeline-qa";
  const email = process.env.GIT_AUTHOR_EMAIL ?? "ai-pipeline-qa@users.noreply.github.com";

  await deps.git(["checkout", "-B", shape.branch], mirrorDir);
  await deps.git(["add", "--", ...shape.addPathspec], mirrorDir);
  await deps.git(
    ["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-m", shape.commitMsg],
    mirrorDir,
  );
  await deps.git([...authHeaderArgs(), "push", "--force-with-lease", "-u", "origin", shape.branch], mirrorDir);

  const pr = await deps.createPullRequest(repo, { title: shape.title, head: shape.branch, base: baseBranch, body: shape.body });

  // Best-effort auto-merge: if the repo does not allow it, leave the PR open.
  try {
    await deps.enableAutoMerge(pr.nodeId);
    deps.log?.(`[qa] PR opened with auto-merge: ${pr.url}`);
  } catch (e) {
    deps.log?.(`[qa] PR opened (auto-merge unavailable, merge it manually): ${pr.url} — ${String(e)}`);
  }
  return { prUrl: pr.url };
}

export async function publishE2e(input: PublishInput, deps: PublishDeps): Promise<{ prUrl: string } | null> {
  const short = shortSha(input.sha);
  return publishChanges(input, deps, {
    statusPathspec: E2E_PATHSPEC,
    addPathspec: E2E_PATHSPEC,
    branch: `qa/e2e-${short}`,
    commitMsg: `test(e2e): automated QA for ${short}`,
    title: `QA E2E for ${short}`,
    body: `E2E tests generated/updated by ai-pipeline for \`${input.sha}\`. Harness green (typecheck + lint + stable run against DEV).`,
    noChangeLog: "[qa] no changes in e2e/ — the suite already covers the change, no PR opened.",
  });
}

// Code mode: publish whatever tests the agent wrote anywhere in the repo (plus the
// e2e/.qa manifest). The whole tree minus node_modules is committed.
export async function publishCode(input: PublishInput, deps: PublishDeps): Promise<{ prUrl: string } | null> {
  const short = shortSha(input.sha);
  return publishChanges(input, deps, {
    statusPathspec: CODE_PATHSPEC,
    addPathspec: CODE_PATHSPEC,
    branch: `qa/code-${short}`,
    commitMsg: `test(code): automated QA for ${short}`,
    title: `QA code tests for ${short}`,
    body: `Source-code tests generated/updated by ai-pipeline for \`${input.sha}\`. Harness green (the repo's own test suite passed, exit code 0).`,
    noChangeLog: "[qa] no test changes in the repo — nothing new to cover, no PR opened.",
  });
}

export const defaultPublishDeps: PublishDeps = {
  git: realGit,
  createPullRequest: (repo, args) => github.createPullRequest(repo, args),
  enableAutoMerge: (nodeId) => github.enableAutoMerge(nodeId),
  log: (m) => console.log(m),
};
