// test/contexts/workspace-and-publication/infrastructure/github-pr.adapter.test.ts
// migration-tier-4a: GitHubPrAdapter now owns the createPullRequest/enableAutoMerge/mergePullRequest
// HTTP calls itself — the fake here plays the role src/integrations/github.ts's `github` object used
// to play, routed by URL so the adapter's own request-shape (endpoint/headers/clamped body) is pinned,
// not just the call sequence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubPrAdapter } from "@contexts/workspace-and-publication/infrastructure/github-pr.adapter.ts";
import { GITHUB_MAX_TITLE, GITHUB_MAX_BODY, type GitHubHttpDeps } from "@contexts/workspace-and-publication/infrastructure/github-http.ts";

const AUTH = { Authorization: "Bearer test-token" };
const prPayload = { html_url: "https://gh/pr/7", node_id: "NODE", number: 7 };

interface FakeCall { url: string; init?: RequestInit; }

function fakeHttp(route: (url: string, init?: RequestInit) => { ok: boolean; status?: number; json?: unknown }): { http: GitHubHttpDeps; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
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

function bodyOf(call: FakeCall): Record<string, unknown> {
  return JSON.parse(call.init!.body as string) as Record<string, unknown>;
}

function headersOf(call: FakeCall): Record<string, string> {
  return call.init!.headers as Record<string, string>;
}

test("opens the PR and enables auto-merge on the happy path", async () => {
  const { http, calls } = fakeHttp((url) => {
    if (url.endsWith("/repos/org/app/pulls")) return { ok: true, json: prPayload };
    if (url.endsWith("/graphql")) return { ok: true, json: {} };
    throw new Error(`unexpected url ${url}`);
  });
  const adapter = new GitHubPrAdapter(http);
  const out = await adapter.openWithAutoMerge("org/app", "qa/e2e-abc", "T", "B");
  assert.equal(out.url, prPayload.html_url);
  assert.equal(out.number, 7);
  assert.equal(calls.length, 2, "create + auto-merge only — no direct-merge fallback attempted");
  assert.equal(headersOf(calls[0]!).Authorization, AUTH.Authorization);
});

test("createPullRequest defaults base to 'main' and honors an explicit base", async () => {
  const { http, calls } = fakeHttp((url) => {
    if (url.endsWith("/pulls")) return { ok: true, json: prPayload };
    return { ok: true, json: {} };
  });
  await new GitHubPrAdapter(http).openWithAutoMerge("org/app", "qa/e2e-abc", "T", "B");
  assert.equal(bodyOf(calls[0]!).base, "main");

  const { http: http2, calls: calls2 } = fakeHttp((url) => {
    if (url.endsWith("/pulls")) return { ok: true, json: prPayload };
    return { ok: true, json: {} };
  });
  await new GitHubPrAdapter(http2, "develop").openWithAutoMerge("org/app", "qa/e2e-abc", "T", "B");
  assert.equal(bodyOf(calls2[0]!).base, "develop");
});

test("clamps an oversized title/body before creating the PR", async () => {
  const { http, calls } = fakeHttp(() => ({ ok: true, json: prPayload }));
  await new GitHubPrAdapter(http).openWithAutoMerge("org/app", "qa/e2e-abc", "t".repeat(500), "b".repeat(100_000));
  const body = bodyOf(calls[0]!);
  assert.ok((body.title as string).length <= GITHUB_MAX_TITLE);
  assert.ok((body.body as string).length <= GITHUB_MAX_BODY);
});

test("falls back to a direct merge when auto-merge is unavailable", async () => {
  const { http, calls } = fakeHttp((url) => {
    if (url.endsWith("/pulls")) return { ok: true, json: prPayload };
    if (url.endsWith("/graphql")) return { ok: false, status: 403, json: {} };
    if (url.endsWith("/pulls/7/merge")) return { ok: true, json: {} };
    throw new Error(`unexpected url ${url}`);
  });
  const out = await new GitHubPrAdapter(http).openWithAutoMerge("org/app", "qa/e2e-abc", "T", "B");
  assert.equal(out.number, 7);
  assert.equal(calls.length, 3, "create + failed auto-merge + direct-merge fallback");
  assert.equal(calls[2]!.url.endsWith("/pulls/7/merge"), true);
});

// WP-05 (test-only — pins TODAY's behavior; the throw-vs-return contract decision is DEFERRED).
// When BOTH enableAutoMerge AND mergePullRequest throw, the adapter returns a PullRequest without
// throwing. The caller has no way to distinguish 'PR merged' from 'PR open but both merge paths
// failed', but changing the return type is a GitHubPrPort contract change — deferred to Phase 2.
test("returns a PullRequest without throwing when both auto-merge and direct-merge fail (double-failure path, current behavior)", async () => {
  const { http } = fakeHttp((url) => {
    if (url.endsWith("/pulls")) return { ok: true, json: prPayload };
    if (url.endsWith("/graphql")) return { ok: false, status: 403, json: {} };
    if (url.endsWith("/pulls/7/merge")) return { ok: false, status: 405, json: {} };
    throw new Error(`unexpected url ${url}`);
  });
  const out = await new GitHubPrAdapter(http).openWithAutoMerge("org/app", "qa/e2e-abc", "T", "B");
  assert.equal(out.url, prPayload.html_url, "PR url must be returned even when both merge paths fail");
  assert.equal(out.number, prPayload.number, "PR number must be returned even when both merge paths fail");
});

test("openWithAutoMerge throws when createPullRequest itself fails (never swallowed)", async () => {
  const { http } = fakeHttp(() => ({ ok: false, status: 422, json: { message: "Validation Failed" } }));
  await assert.rejects(
    () => new GitHubPrAdapter(http).openWithAutoMerge("org/app", "qa/e2e-abc", "T", "B"),
    /GitHub PR error 422/,
  );
});
