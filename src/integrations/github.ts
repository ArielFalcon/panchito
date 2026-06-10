// GitHub integration: open Issues (failure/invalid) and open PRs with the
// generated E2E tests (auto-merge when the harness passed). On green with no
// failures, nothing is done (no noise).

import { requireEnv } from "../util/env";

// GitHub's documented hard limits for Issue/PR fields. Exceeding either is a 422
// ("title/body is too long"). This module is the single boundary every Issue/PR
// passes through, so we clamp here UNCONDITIONALLY — no caller (reporter, publish,
// maintainer, or any future one) can produce a rejected request. Callers should
// still budget their content for graceful truncation; this is the last-ditch net
// that closes the whole failure class.
export const GITHUB_MAX_TITLE = 256;
export const GITHUB_MAX_BODY = 65536;

export interface GitHubDeps {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export const defaultGitHubDeps: GitHubDeps = {
  fetch: (input, init?) => globalThis.fetch(input, init),
};

export function clampTitle(title: string): string {
  if (title.length <= GITHUB_MAX_TITLE) return title;
  return title.slice(0, GITHUB_MAX_TITLE - 1).trimEnd() + "…";
}

export function clampBody(body: string): string {
  if (body.length <= GITHUB_MAX_BODY) return body;
  const notice = "\n\n_…(truncated to fit GitHub's 65536-character limit)_";
  return body.slice(0, GITHUB_MAX_BODY - notice.length) + notice;
}

export interface PullRequest {
  url: string;
  nodeId: string;
  number: number;
}

export interface PrState {
  merged: boolean;
  state: string; // "open" | "closed"
}

export interface RepoInfo {
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
}

function ghHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${requireEnv("GITHUB_TOKEN")}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };
}

export const github = {
  async openIssue(
    repo: string,
    title: string,
    body: string,
    deps: GitHubDeps = defaultGitHubDeps,
  ): Promise<{ url: string }> {
    const res = await deps.fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: ghHeaders(),
      body: JSON.stringify({ title: clampTitle(title), body: clampBody(body) }),
    });
    if (!res.ok) throw new Error(`GitHub error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { html_url: string };
    return { url: data.html_url };
  },

  async createPullRequest(
    repo: string,
    args: { title: string; head: string; base: string; body: string },
    deps: GitHubDeps = defaultGitHubDeps,
  ): Promise<PullRequest> {
    const res = await deps.fetch(`https://api.github.com/repos/${repo}/pulls`, {
      method: "POST",
      headers: ghHeaders(),
      body: JSON.stringify({ ...args, title: clampTitle(args.title), body: clampBody(args.body) }),
    });
    if (!res.ok) throw new Error(`GitHub PR error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { html_url: string; node_id: string; number: number };
    return { url: data.html_url, nodeId: data.node_id, number: data.number };
  },

  // Auto-merge via GraphQL: the PR merges once the repo's REQUIRED checks pass.
  // Requires the repo to have "Allow auto-merge" enabled (and, in practice,
  // branch protection with checks). Otherwise, the mutation fails and the caller
  // treats it as best-effort, leaving the PR open.
  async enableAutoMerge(nodeId: string, mergeMethod = "SQUASH", deps: GitHubDeps = defaultGitHubDeps): Promise<void> {
    const res = await deps.fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requireEnv("GITHUB_TOKEN")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query:
          "mutation($id:ID!,$m:PullRequestMergeMethod!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$m}){pullRequest{id}}}",
        variables: { id: nodeId, m: mergeMethod },
      }),
    });
    const data = (await res.json()) as { errors?: Array<{ message: string }> };
    if (!res.ok || data.errors?.length) {
      throw new Error(`GitHub auto-merge: ${data.errors?.[0]?.message ?? res.status}`);
    }
  },

  // Deterministically merge a PR via the REST API (used by the maintainer self-update
  // AFTER the orchestrator's own typecheck+test gate passes — so the merge does not
  // depend on the repo having branch protection / "Allow auto-merge" configured).
  async mergePullRequest(repo: string, number: number, mergeMethod = "squash", deps: GitHubDeps = defaultGitHubDeps): Promise<void> {
    const res = await deps.fetch(`https://api.github.com/repos/${repo}/pulls/${number}/merge`, {
      method: "PUT",
      headers: ghHeaders(),
      body: JSON.stringify({ merge_method: mergeMethod }),
    });
    if (!res.ok) throw new Error(`GitHub merge error ${res.status}: ${await res.text()}`);
  },

  async getPullRequest(repo: string, number: number, deps: GitHubDeps = defaultGitHubDeps): Promise<PrState> {
    const res = await deps.fetch(`https://api.github.com/repos/${repo}/pulls/${number}`, {
      headers: ghHeaders(),
    });
    if (!res.ok) throw new Error(`GitHub get PR error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { merged: boolean; state: string };
    return { merged: data.merged, state: data.state };
  },

  // The OUTER GUARD's read side: the merge + aggregate-CI state of a PR, combining the PR object
  // (merged/state) with the modern Checks API and the legacy commit-status API on the head commit.
  // `checks` distinguishes "none" (NO checks exist yet/at all) from "success" (checks ran and are
  // green) — critical so the promote loop does not merge during the window before CI registers.
  async getPrStatus(
    repo: string,
    number: number,
    deps: GitHubDeps = defaultGitHubDeps,
  ): Promise<{ merged: boolean; state: string; checks: "pending" | "success" | "failure" | "none" }> {
    const prRes = await deps.fetch(`https://api.github.com/repos/${repo}/pulls/${number}`, { headers: ghHeaders() });
    if (!prRes.ok) throw new Error(`GitHub get PR error ${prRes.status}: ${await prRes.text()}`);
    const pr = (await prRes.json()) as { merged: boolean; state: string; head: { sha: string } };
    const sha = pr.head.sha;

    const [crRes, stRes] = await Promise.all([
      deps.fetch(`https://api.github.com/repos/${repo}/commits/${sha}/check-runs`, { headers: ghHeaders() }),
      deps.fetch(`https://api.github.com/repos/${repo}/commits/${sha}/status`, { headers: ghHeaders() }),
    ]);
    if (!crRes.ok) throw new Error(`GitHub check-runs error ${crRes.status}: ${await crRes.text()}`);
    if (!stRes.ok) throw new Error(`GitHub status error ${stRes.status}: ${await stRes.text()}`);
    const cr = (await crRes.json()) as { check_runs?: Array<{ status: string; conclusion: string | null }> };
    const st = (await stRes.json()) as { state: string; total_count: number };

    const runs = cr.check_runs ?? [];
    let pending = false;
    let failure = false;
    for (const run of runs) {
      if (run.status !== "completed") pending = true;
      else if (run.conclusion && !["success", "neutral", "skipped"].includes(run.conclusion)) failure = true;
    }
    if (st.total_count > 0) {
      if (st.state === "pending") pending = true;
      if (st.state === "failure" || st.state === "error") failure = true;
    }
    const total = runs.length + st.total_count;
    const checks = failure ? "failure" : pending ? "pending" : total === 0 ? "none" : "success";
    return { merged: pr.merged, state: pr.state, checks };
  },

  async getRepo(repo: string, deps: GitHubDeps = defaultGitHubDeps): Promise<RepoInfo> {
    const res = await deps.fetch(`https://api.github.com/repos/${repo}`, {
      headers: ghHeaders(),
    });
    if (res.status === 404) {
      throw new Error(`repo '${repo}' not found or token lacks access (private repo needs GITHUB_TOKEN with 'repo' scope)`);
    }
    if (!res.ok) throw new Error(`GitHub get repo error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      name: string; full_name: string; private: boolean;
      default_branch: string; description: string | null;
    };
    return {
      name: data.name,
      fullName: data.full_name,
      private: data.private,
      defaultBranch: data.default_branch,
      description: data.description,
    };
  },

  async listRepos(owner: string, page = 1, perPage = 10, deps: GitHubDeps = defaultGitHubDeps): Promise<{ repos: RepoInfo[]; hasMore: boolean }> {
    const ghRepos = async (endpoint: string): Promise<Response | null> => {
      const url = `https://api.github.com/${endpoint}?per_page=${perPage}&page=${page}&sort=updated`;
      const res = await deps.fetch(url, { headers: ghHeaders() });
      if (res.status === 404) return null;
      if (res.status === 403 && res.headers.get("X-RateLimit-Remaining") === "0") {
        const reset = res.headers.get("X-RateLimit-Reset");
        const resetDate = reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : "soon";
        throw new Error(`GitHub API rate limit exceeded — resets at ${resetDate}. Wait or use a token with higher limits.`);
      }
      if (!res.ok) throw new Error(`GitHub list repos error ${res.status}: ${await res.text()}`);
      return res;
    };

    let res: Response | null;
    if (owner === "@me" || !owner) {
      res = await ghRepos("user/repos");
      if (!res) throw new Error("no repos found for your account — check GITHUB_TOKEN has 'repo' or 'public_repo' scope");
    } else {
      res = await ghRepos(`users/${encodeURIComponent(owner)}/repos`);
      if (!res) res = await ghRepos(`orgs/${encodeURIComponent(owner)}/repos`);
      if (!res) throw new Error(`no repos found for '${owner}' — check the name is correct and the token has access`);
    }

    const items = (await res.json()) as Array<{
      name: string; full_name: string; private: boolean;
      default_branch: string; description: string | null;
    }>;
    return {
      repos: items.map((r) => ({
        name: r.name,
        fullName: r.full_name,
        private: r.private,
        defaultBranch: r.default_branch,
        description: r.description,
      })),
      hasMore: items.length === perPage,
    };
  },
};
