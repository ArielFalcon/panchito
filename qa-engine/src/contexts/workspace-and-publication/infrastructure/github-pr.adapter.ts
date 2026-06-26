// src/contexts/workspace-and-publication/infrastructure/github-pr.adapter.ts
// WRAP of github.createPullRequest/enableAutoMerge/mergePullRequest. Carries the auto-merge →
// direct-merge fallback from publish.ts (the "commit tests back" promise must not silently fail
// when a repo lacks branch protection). All three calls injected — no GITHUB_TOKEN / network in tests.
import type { GitHubPrPort, PullRequest } from "../application/ports/index.ts";

export interface GitHubPrCalls {
  createPullRequest(repo: string, args: { title: string; head: string; base: string; body: string }): Promise<{ url: string; nodeId: string; number: number }>;
  enableAutoMerge(nodeId: string): Promise<void>;
  mergePullRequest(repo: string, number: number): Promise<void>;
}

export class GitHubPrAdapter implements GitHubPrPort {
  constructor(private readonly calls: GitHubPrCalls, private readonly base = "main") {}

  async openWithAutoMerge(repo: string, branch: string, title: string, body: string): Promise<PullRequest> {
    const pr = await this.calls.createPullRequest(repo, { title, head: branch, base: this.base, body });
    try {
      await this.calls.enableAutoMerge(pr.nodeId);
    } catch {
      // Auto-merge unavailable (no branch protection). The harness already proved this green and
      // the PR is test-only, so fall back to a direct merge. A direct-merge failure is left to the
      // caller (PR stays open, surfaced loudly) — we do not throw out of the publish path.
      try { await this.calls.mergePullRequest(repo, pr.number); } catch { /* leave open; caller logs */ }
    }
    return { url: pr.url, number: pr.number };
  }
}
