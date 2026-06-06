// GitHub integration: open Issues (failure/invalid) and open PRs with the
// generated E2E tests (auto-merge when the harness passed). On green with no
// failures, nothing is done (no noise).

import { requireEnv } from "../util/env";

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
  ): Promise<{ url: string }> {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: ghHeaders(),
      body: JSON.stringify({ title, body }),
    });
    if (!res.ok) throw new Error(`GitHub error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { html_url: string };
    return { url: data.html_url };
  },

  async createPullRequest(
    repo: string,
    args: { title: string; head: string; base: string; body: string },
  ): Promise<PullRequest> {
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
      method: "POST",
      headers: ghHeaders(),
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`GitHub PR error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { html_url: string; node_id: string; number: number };
    return { url: data.html_url, nodeId: data.node_id, number: data.number };
  },

  // Auto-merge via GraphQL: the PR merges once the repo's REQUIRED checks pass.
  // Requires the repo to have "Allow auto-merge" enabled (and, in practice,
  // branch protection with checks). Otherwise, the mutation fails and the caller
  // treats it as best-effort, leaving the PR open.
  async enableAutoMerge(nodeId: string, mergeMethod = "SQUASH"): Promise<void> {
    const res = await fetch("https://api.github.com/graphql", {
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
  async mergePullRequest(repo: string, number: number, mergeMethod = "squash"): Promise<void> {
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}/merge`, {
      method: "PUT",
      headers: ghHeaders(),
      body: JSON.stringify({ merge_method: mergeMethod }),
    });
    if (!res.ok) throw new Error(`GitHub merge error ${res.status}: ${await res.text()}`);
  },

  async getPullRequest(repo: string, number: number): Promise<PrState> {
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}`, {
      headers: ghHeaders(),
    });
    if (!res.ok) throw new Error(`GitHub get PR error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { merged: boolean; state: string };
    return { merged: data.merged, state: data.state };
  },

  // The OUTER GUARD's read side: the aggregate CI state of a PR's head commit, combining the
  // modern Checks API and the legacy commit-status API. The maintainer promote path only merges
  // to main on "success", so a fix that fails CI never lands — independently of the in-process
  // safety gates. "success" when there are no checks at all (nothing to wait on).
  async getChecksStatus(repo: string, number: number): Promise<"pending" | "success" | "failure"> {
    const prRes = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}`, { headers: ghHeaders() });
    if (!prRes.ok) throw new Error(`GitHub get PR error ${prRes.status}: ${await prRes.text()}`);
    const pr = (await prRes.json()) as { head: { sha: string } };
    const sha = pr.head.sha;

    const [crRes, stRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${repo}/commits/${sha}/check-runs`, { headers: ghHeaders() }),
      fetch(`https://api.github.com/repos/${repo}/commits/${sha}/status`, { headers: ghHeaders() }),
    ]);
    if (!crRes.ok) throw new Error(`GitHub check-runs error ${crRes.status}: ${await crRes.text()}`);
    if (!stRes.ok) throw new Error(`GitHub status error ${stRes.status}: ${await stRes.text()}`);
    const cr = (await crRes.json()) as { check_runs?: Array<{ status: string; conclusion: string | null }> };
    const st = (await stRes.json()) as { state: string; total_count: number };

    let pending = false;
    let failure = false;
    for (const run of cr.check_runs ?? []) {
      if (run.status !== "completed") pending = true;
      else if (run.conclusion && !["success", "neutral", "skipped"].includes(run.conclusion)) failure = true;
    }
    if (st.total_count > 0) {
      if (st.state === "pending") pending = true;
      if (st.state === "failure" || st.state === "error") failure = true;
    }
    if (failure) return "failure";
    if (pending) return "pending";
    return "success";
  },

  async getRepo(repo: string): Promise<RepoInfo> {
    const res = await fetch(`https://api.github.com/repos/${repo}`, {
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
};
