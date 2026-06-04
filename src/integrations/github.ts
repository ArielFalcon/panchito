// GitHub integration: open Issues (failure/invalid) and open PRs with the
// generated E2E tests (auto-merge when the harness passed). On green with no
// failures, nothing is done (no noise).

import { requireEnv } from "../util/env";

export interface PullRequest {
  url: string;
  nodeId: string;
  number: number;
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
  // branch protection with checks). Otherwise the mutation fails and the caller
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
};
