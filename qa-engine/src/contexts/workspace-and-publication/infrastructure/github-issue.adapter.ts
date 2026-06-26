// src/contexts/workspace-and-publication/infrastructure/github-issue.adapter.ts
// WRAP of github.openIssue. The legacy call returns { url } only; the port wants { url, number }
// — we parse the issue number from the url tail (best-effort, 0 when absent). Injected so the test
// needs no GITHUB_TOKEN / network.
import type { GitHubIssuePort, Issue } from "../application/ports/index.ts";

type OpenIssue = (repo: string, title: string, body: string) => Promise<{ url: string }>;

export class GitHubIssueAdapter implements GitHubIssuePort {
  constructor(private readonly openIssue: OpenIssue) {}
  async open(repo: string, title: string, body: string): Promise<Issue> {
    const { url } = await this.openIssue(repo, title, body);
    const match = url.match(/\/issues\/(\d+)/);
    // FIX 13b: never silently return number:0 — a sentinel 0 looks like a valid issue number
    // to callers and makes the issue unaddressable. Throw explicitly so the caller surface the
    // problem loudly (an issue URL without a number is a GitHub API contract violation).
    if (!match) throw new Error(`GitHubIssueAdapter: cannot parse issue number from URL: ${url}`);
    return { url, number: Number(match[1]) };
  }
}
