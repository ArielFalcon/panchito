// Integración con GitHub: abrir Issues (fallo/inválido) y abrir PRs con los E2E
// generados (auto-merge si el harness pasó). En verde sin fallos no hay ruido.

import { requireEnv } from "../util/env";

export interface PullRequest {
  url: string;
  nodeId: string;
  number: number;
}

export const github = {
  async openIssue(
    repo: string,
    title: string,
    body: string,
  ): Promise<{ url: string }> {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requireEnv("GITHUB_TOKEN")}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
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
      headers: {
        Authorization: `Bearer ${requireEnv("GITHUB_TOKEN")}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`GitHub PR error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { html_url: string; node_id: string; number: number };
    return { url: data.html_url, nodeId: data.node_id, number: data.number };
  },

  // Auto-merge vía GraphQL: el PR se fusiona cuando los checks REQUERIDOS del
  // repo pasen. Requiere que el repo tenga "Allow auto-merge" activado (y, en la
  // práctica, branch protection con checks). Si no, la mutación falla → el
  // llamador lo trata como best-effort y deja el PR abierto.
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

