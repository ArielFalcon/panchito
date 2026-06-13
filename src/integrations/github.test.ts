import { test } from "node:test";
import assert from "node:assert/strict";
import { clampTitle, clampBody, GITHUB_MAX_TITLE, GITHUB_MAX_BODY, github, GitHubDeps } from "./github";

// ghHeaders() requires GITHUB_TOKEN; provide a dummy so the boundary tests exercise
// the fetch logic, not the env-check logic.
process.env.GITHUB_TOKEN = "ghp_dummy_token_for_tests";

// These are the boundary guards: the single choke point every Issue/PR passes
// through, so NO caller can produce a 422 ("title/body is too long"). The real
// fetch is the deliberately-uncovered integration; the pure clamp logic is not.

test("clampTitle leaves a short title unchanged", () => {
  assert.equal(clampTitle("QA E2E tests failed at abc123"), "QA E2E tests failed at abc123");
});

test("clampTitle truncates to GitHub's 256-char limit with an ellipsis", () => {
  const out = clampTitle("t".repeat(500));
  assert.ok(out.length <= GITHUB_MAX_TITLE, `title length ${out.length} should be <= ${GITHUB_MAX_TITLE}`);
  assert.match(out, /…$/);
});

test("clampBody leaves a body under the limit unchanged", () => {
  assert.equal(clampBody("a short issue body"), "a short issue body");
});

test("clampBody truncates an oversized body to GitHub's 65536-char limit", () => {
  const out = clampBody("b".repeat(100_000));
  assert.ok(out.length <= GITHUB_MAX_BODY, `body length ${out.length} should be <= ${GITHUB_MAX_BODY}`);
  assert.match(out, /truncated/);
});

// ── Integration tests: GitHub API boundary failure modes ────────────────────

function mockDeps(response: { ok: boolean; status: number; statusText?: string; json?: unknown; headers?: Record<string, string> }): GitHubDeps {
  return {
    fetch: async () =>
      ({
        ok: response.ok,
        status: response.status,
        statusText: response.statusText ?? "",
        headers: {
          get: (k: string) => (response.headers ? response.headers[k] : null),
        },
        text: async () => JSON.stringify(response.json ?? {}),
        json: async () => response.json ?? {},
      }) as unknown as Response,
  };
}

function routedDeps(routes: (url: string) => unknown): GitHubDeps {
  return {
    fetch: async (url: string) =>
      ({
        ok: true, status: 200, statusText: "",
        headers: { get: () => null },
        text: async () => JSON.stringify(routes(url) ?? {}),
        json: async () => routes(url) ?? {},
      }) as unknown as Response,
  };
}

test("getPrStatus(requiredContext): aggregate that LACKS the named 'ci' check → 'none' (fail-safe, never promotes)", async () => {
  const deps = routedDeps((url) =>
    url.includes("/pulls/")
      ? { merged: false, state: "open", head: { sha: "abc" } }
      : url.includes("/check-runs")
        ? { check_runs: [{ name: "lint", status: "completed", conclusion: "success" }] } // 'ci' absent
        : { state: "success", total_count: 0, statuses: [] });
  const s = await github.getPrStatus("o/r", 1, deps, "ci");
  assert.equal(s.checks, "none"); // the required 'ci' check never ran → never treated as green
});

test("getPrStatus(requiredContext): only the named 'ci' decides — an unrelated red check is ignored", async () => {
  const deps = routedDeps((url) =>
    url.includes("/pulls/")
      ? { merged: false, state: "open", head: { sha: "abc" } }
      : url.includes("/check-runs")
        ? { check_runs: [
            { name: "ci", status: "completed", conclusion: "success" },
            { name: "preview-deploy", status: "completed", conclusion: "failure" },
          ] }
        : { state: "failure", total_count: 1, statuses: [{ context: "preview-deploy", state: "failure" }] });
  const s = await github.getPrStatus("o/r", 1, deps, "ci");
  assert.equal(s.checks, "success"); // 'ci' passed; the unrelated preview-deploy failure does not block
});

test("openIssue throws on GitHub 500 error", async () => {
  const deps = mockDeps({ ok: false, status: 500, statusText: "Internal Server Error", json: { message: "boom" } });
  await assert.rejects(() => github.openIssue("org/app", "title", "body", deps), /GitHub error 500/);
});

test("openIssue throws on GitHub 401 auth failure", async () => {
  const deps = mockDeps({ ok: false, status: 401, statusText: "Unauthorized" });
  await assert.rejects(() => github.openIssue("org/app", "title", "body", deps), /GitHub error 401/);
});

test("createPullRequest throws on GitHub 422 validation error", async () => {
  const deps = mockDeps({ ok: false, status: 422, json: { message: "Validation Failed" } });
  await assert.rejects(
    () => github.createPullRequest("org/app", { title: "t", head: "h", base: "main", body: "b" }, deps),
    /GitHub PR error 422/,
  );
});

test("enableAutoMerge throws when GraphQL returns errors", async () => {
  const deps = mockDeps({ ok: true, status: 200, json: { errors: [{ message: "Auto-merge is not allowed" }] } });
  await assert.rejects(() => github.enableAutoMerge("nodeId", "SQUASH", deps), /Auto-merge is not allowed/);
});

test("enableAutoMerge throws on HTTP error", async () => {
  const deps = mockDeps({ ok: false, status: 403, json: {} });
  await assert.rejects(() => github.enableAutoMerge("nodeId", "SQUASH", deps), /GitHub auto-merge: 403/);
});

test("mergePullRequest throws on GitHub merge error", async () => {
  const deps = mockDeps({ ok: false, status: 405, json: { message: "Merge conflict" } });
  await assert.rejects(() => github.mergePullRequest("org/app", 7, "squash", deps), /GitHub merge error 405/);
});

test("getPullRequest throws on GitHub get PR error", async () => {
  const deps = mockDeps({ ok: false, status: 404 });
  await assert.rejects(() => github.getPullRequest("org/app", 7, deps), /GitHub get PR error 404/);
});

test("getPrStatus throws on PR fetch failure", async () => {
  const deps = mockDeps({ ok: false, status: 404 });
  await assert.rejects(() => github.getPrStatus("org/app", 7, deps), /GitHub get PR error 404/);
});

test("getPrStatus throws on check-runs fetch failure", async () => {
  let callCount = 0;
  const deps: GitHubDeps = {
    fetch: async (_input, _init?) => {
      callCount++;
      if (callCount === 1) {
        // PR fetch succeeds
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ merged: false, state: "open", head: { sha: "abc" } }),
          json: async () => ({ merged: false, state: "open", head: { sha: "abc" } }),
        } as unknown as Response;
      }
      // check-runs fails
      return {
        ok: false,
        status: 500,
        headers: { get: () => null },
        text: async () => "error",
        json: async () => ({}),
      } as unknown as Response;
    },
  };
  await assert.rejects(() => github.getPrStatus("org/app", 7, deps), /GitHub check-runs error 500/);
});

test("getRepo throws with specific message on 404", async () => {
  const deps = mockDeps({ ok: false, status: 404 });
  await assert.rejects(() => github.getRepo("org/nonexistent", deps), /repo 'org\/nonexistent' not found/);
});

test("getRepo throws on other errors", async () => {
  const deps = mockDeps({ ok: false, status: 500 });
  await assert.rejects(() => github.getRepo("org/app", deps), /GitHub get repo error 500/);
});

test("listRepos throws on rate limit with reset time", async () => {
  const deps = mockDeps({
    ok: false,
    status: 403,
    headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 3600) },
  });
  await assert.rejects(() => github.listRepos("org", 1, 10, deps), /rate limit exceeded/);
});

test("listRepos throws when neither user nor org repos are found", async () => {
  const deps = mockDeps({ ok: false, status: 404 });
  await assert.rejects(() => github.listRepos("ghost-owner", 1, 10, deps), /no repos found/);
});
