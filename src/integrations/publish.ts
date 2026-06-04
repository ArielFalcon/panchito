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

const E2E_DIR = "e2e";

export async function publishE2e(
  input: PublishInput,
  deps: PublishDeps,
): Promise<{ prUrl: string } | null> {
  const { mirrorDir, sha, repo, baseBranch } = input;

  // Did the agent modify `e2e/`? If not, the suite already covered the change → no PR.
  const status = await deps.git(["status", "--porcelain", "--", E2E_DIR], mirrorDir);
  if (!status.trim()) {
    deps.log?.("[qa] no changes in e2e/ — the suite already covers the change, no PR opened.");
    return null;
  }

  const short = shortSha(sha);
  const branch = `qa/e2e-${short}`;
  const name = process.env.GIT_AUTHOR_NAME ?? "ai-pipeline-qa";
  const email = process.env.GIT_AUTHOR_EMAIL ?? "ai-pipeline-qa@users.noreply.github.com";

  await deps.git(["checkout", "-B", branch], mirrorDir);
  await deps.git(["add", "--", E2E_DIR], mirrorDir);
  await deps.git(
    ["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-m", `test(e2e): automated QA for ${short}`],
    mirrorDir,
  );
  await deps.git([...authHeaderArgs(), "push", "--force-with-lease", "-u", "origin", branch], mirrorDir);

  const pr = await deps.createPullRequest(repo, {
    title: `QA E2E for ${short}`,
    head: branch,
    base: baseBranch,
    body: `E2E tests generated/updated by ai-pipeline for \`${sha}\`. Harness green (typecheck + lint + stable run against DEV).`,
  });

  // Best-effort auto-merge: if the repo does not allow it, leave the PR open.
  try {
    await deps.enableAutoMerge(pr.nodeId);
    deps.log?.(`[qa] PR opened with auto-merge: ${pr.url}`);
  } catch (e) {
    deps.log?.(`[qa] PR opened (auto-merge unavailable, merge it manually): ${pr.url} — ${String(e)}`);
  }
  return { prUrl: pr.url };
}

export const defaultPublishDeps: PublishDeps = {
  git: realGit,
  createPullRequest: (repo, args) => github.createPullRequest(repo, args),
  enableAutoMerge: (nodeId) => github.enableAutoMerge(nodeId),
  log: (m) => console.log(m),
};
