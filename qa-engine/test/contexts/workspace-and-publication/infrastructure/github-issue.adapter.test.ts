// test/contexts/workspace-and-publication/infrastructure/github-issue.adapter.test.ts
// migration-tier-4a: GitHubIssueAdapter now owns the POST /issues call itself — github.ts's
// openIssue closure is retired. The fake plays the HTTP boundary, pinning endpoint/headers/clamped
// body directly instead of only the delegated-call sequence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubIssueAdapter } from "@contexts/workspace-and-publication/infrastructure/github-issue.adapter.ts";
import { GITHUB_MAX_TITLE, GITHUB_MAX_BODY, type GitHubHttpDeps } from "@contexts/workspace-and-publication/infrastructure/github-http.ts";

const AUTH = { Authorization: "Bearer test-token" };

function fakeHttp(route: (url: string, init?: RequestInit) => { ok: boolean; status?: number; json?: unknown }): { http: GitHubHttpDeps; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    calls,
    http: {
      authHeaders: () => AUTH,
      fetch: async (url, init) => {
        calls.push({ url, init });
        const r = route(url, init);
        return {
          ok: r.ok,
          status: r.status ?? (r.ok ? 200 : 500),
          text: async () => JSON.stringify(r.json ?? {}),
          json: async () => r.json ?? {},
        } as unknown as Response;
      },
    },
  };
}

test("open POSTs to the issues endpoint and maps the url", async () => {
  const { http, calls } = fakeHttp(() => ({ ok: true, json: { html_url: "https://gh/org/app/issues/1" } }));
  const adapter = new GitHubIssueAdapter(http);
  const issue = await adapter.open("org/app", "E2E failed", "details");
  assert.match(issue.url, /org\/app\/issues\/1/);
  assert.equal(issue.number, 1);
  assert.equal(calls[0]!.url, "https://api.github.com/repos/org/app/issues");
  assert.equal((calls[0]!.init!.headers as Record<string, string>).Authorization, AUTH.Authorization);
});

test("throws when the URL has no issue number (FIX 13b — never silent 0)", async () => {
  const { http } = fakeHttp(() => ({ ok: true, json: { html_url: "https://gh/org/app/pull/5" } }));
  const adapter = new GitHubIssueAdapter(http);
  await assert.rejects(() => adapter.open("org/app", "title", "body"), /cannot parse issue number/);
});

test("throws on a GitHub error response", async () => {
  const { http } = fakeHttp(() => ({ ok: false, status: 500, json: { message: "boom" } }));
  const adapter = new GitHubIssueAdapter(http);
  await assert.rejects(() => adapter.open("org/app", "title", "body"), /GitHub error 500/);
});

test("clamps an oversized title/body before sending", async () => {
  const { http, calls } = fakeHttp(() => ({ ok: true, json: { html_url: "https://gh/org/app/issues/9" } }));
  await new GitHubIssueAdapter(http).open("org/app", "t".repeat(500), "b".repeat(100_000));
  const body = JSON.parse(calls[0]!.init!.body as string) as { title: string; body: string };
  assert.ok(body.title.length <= GITHUB_MAX_TITLE);
  assert.ok(body.body.length <= GITHUB_MAX_BODY);
});
