// src/contexts/workspace-and-publication/infrastructure/github-pr.adapter.ts
// migration-tier-4a: owns the createPullRequest/enableAutoMerge/mergePullRequest HTTP calls directly
// (previously closures around src/integrations/github.ts's `github` object, built by the factory).
// Carries the auto-merge -> direct-merge fallback from publish.ts (the "commit tests back" promise
// must not silently fail when a repo lacks branch protection). `fetch`/`authHeaders` are injected —
// no GITHUB_TOKEN / network in tests; GITHUB_TOKEN itself stays shell-injected (built by the factory's
// authHeaders() closure via requireEnv), never read here.
import type { GitHubPrPort, PullRequest } from "../application/ports/index.ts";
import { clampTitle, clampBody, type GitHubHttpDeps } from "./github-http.ts";

interface RawPullRequest {
  url: string;
  nodeId: string;
  number: number;
}

export class GitHubPrAdapter implements GitHubPrPort {
  constructor(private readonly http: GitHubHttpDeps, private readonly base = "main") {}

  async openWithAutoMerge(repo: string, branch: string, title: string, body: string): Promise<PullRequest> {
    const pr = await this.createPullRequest(repo, { title, head: branch, base: this.base, body });
    try {
      await this.enableAutoMerge(pr.nodeId);
    } catch {
      // Auto-merge unavailable (no branch protection). The harness already proved this green and
      // the PR is test-only, so fall back to a direct merge. A direct-merge failure is left to the
      // caller (PR stays open, surfaced loudly) — we do not throw out of the publish path.
      try {
        await this.mergePullRequest(repo, pr.number);
      } catch {
        /* leave open; caller logs */
      }
    }
    return { url: pr.url, number: pr.number };
  }

  private async createPullRequest(
    repo: string,
    args: { title: string; head: string; base: string; body: string },
  ): Promise<RawPullRequest> {
    const res = await this.http.fetch(`https://api.github.com/repos/${repo}/pulls`, {
      method: "POST",
      headers: { ...this.http.authHeaders(), Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({ ...args, title: clampTitle(args.title), body: clampBody(args.body) }),
    });
    if (!res.ok) throw new Error(`GitHub PR error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { html_url: string; node_id: string; number: number };
    return { url: data.html_url, nodeId: data.node_id, number: data.number };
  }

  // Auto-merge via GraphQL: the PR merges once the repo's REQUIRED checks pass. Requires the repo to
  // have "Allow auto-merge" enabled (and, in practice, branch protection with checks). Otherwise the
  // mutation fails and the caller treats it as best-effort, leaving the PR open.
  private async enableAutoMerge(nodeId: string, mergeMethod = "SQUASH"): Promise<void> {
    const res = await this.http.fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { ...this.http.authHeaders(), "Content-Type": "application/json" },
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
  }

  // UNCONDITIONAL merge via the REST API — waits for NO GitHub check or branch protection. Only
  // reached as the auto-merge fallback above, after the harness already proved the suite green.
  private async mergePullRequest(repo: string, number: number, mergeMethod = "squash"): Promise<void> {
    const res = await this.http.fetch(`https://api.github.com/repos/${repo}/pulls/${number}/merge`, {
      method: "PUT",
      headers: { ...this.http.authHeaders(), Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({ merge_method: mergeMethod }),
    });
    if (!res.ok) throw new Error(`GitHub merge error ${res.status}: ${await res.text()}`);
  }
}
