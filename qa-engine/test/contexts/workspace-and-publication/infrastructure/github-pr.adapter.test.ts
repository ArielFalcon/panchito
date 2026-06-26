// test/contexts/workspace-and-publication/infrastructure/github-pr.adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubPrAdapter } from "@contexts/workspace-and-publication/infrastructure/github-pr.adapter.ts";

const pr = { url: "https://gh/pr/7", nodeId: "NODE", number: 7 };

test("opens the PR and enables auto-merge on the happy path", async () => {
  const log: string[] = [];
  const adapter = new GitHubPrAdapter({
    createPullRequest: async () => pr,
    enableAutoMerge: async (id) => { log.push(`am:${id}`); },
    mergePullRequest: async () => { log.push("direct"); },
  });
  const out = await adapter.openWithAutoMerge("org/app", "qa/e2e-abc", "T", "B");
  assert.equal(out.url, pr.url);
  assert.equal(out.number, 7);
  assert.deepEqual(log, ["am:NODE"]); // direct merge NOT attempted
});

test("falls back to a direct merge when auto-merge is unavailable", async () => {
  const log: string[] = [];
  const adapter = new GitHubPrAdapter({
    createPullRequest: async () => pr,
    enableAutoMerge: async () => { throw new Error("auto-merge not allowed"); },
    mergePullRequest: async (repo, n) => { log.push(`direct:${repo}:${n}`); },
  });
  await adapter.openWithAutoMerge("org/app", "qa/e2e-abc", "T", "B");
  assert.deepEqual(log, ["direct:org/app:7"]);
});

// WP-05 (test-only — pins TODAY's behavior; the throw-vs-return contract decision is DEFERRED).
// When BOTH enableAutoMerge AND mergePullRequest throw, the adapter returns a PullRequest without
// throwing. The caller has no way to distinguish 'PR merged' from 'PR open but both merge paths
// failed', but changing the return type is a GitHubPrPort contract change — deferred to Phase 2.
// This test pins the current silent-swallow so a future change is visible and deliberate.
test("returns a PullRequest without throwing when both auto-merge and direct-merge fail (double-failure path, current behavior)", async () => {
  const adapter = new GitHubPrAdapter({
    createPullRequest: async () => pr,
    enableAutoMerge: async () => { throw new Error("auto-merge not allowed"); },
    mergePullRequest: async () => { throw new Error("direct merge not allowed"); },
  });
  // Must resolve (not reject) — the double-failure catch swallows and returns the PR reference.
  const out = await adapter.openWithAutoMerge("org/app", "qa/e2e-abc", "T", "B");
  assert.equal(out.url, pr.url, "PR url must be returned even when both merge paths fail");
  assert.equal(out.number, pr.number, "PR number must be returned even when both merge paths fail");
});
