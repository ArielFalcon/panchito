// src/contexts/workspace-and-publication/infrastructure/github-issue.adapter.ts
// migration-tier-4a: owns the POST /issues call directly — the src/integrations/github.ts openIssue
// closure is retired (zero remaining production callers once this lands). `fetch`/`authHeaders` are
// injected so no GITHUB_TOKEN / network is needed in tests.
import type { GitHubIssuePort, Issue } from "../application/ports/index.ts";
import { clampTitle, clampBody, type GitHubHttpDeps } from "./github-http.ts";

export class GitHubIssueAdapter implements GitHubIssuePort {
  constructor(private readonly http: GitHubHttpDeps) {}

  async open(repo: string, title: string, body: string): Promise<Issue> {
    const res = await this.http.fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: { ...this.http.authHeaders(), Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({ title: clampTitle(title), body: clampBody(body) }),
    });
    if (!res.ok) throw new Error(`GitHub error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { html_url: string };
    const url = data.html_url;
    // FIX 13b: never silently return number:0 — a sentinel 0 looks like a valid issue number to
    // callers and makes the issue unaddressable. Throw explicitly so the caller surfaces the problem
    // loudly (an issue URL without a number is a GitHub API contract violation).
    const match = url.match(/\/issues\/(\d+)/);
    if (!match) throw new Error(`GitHubIssueAdapter: cannot parse issue number from URL: ${url}`);
    return { url, number: Number(match[1]) };
  }
}
