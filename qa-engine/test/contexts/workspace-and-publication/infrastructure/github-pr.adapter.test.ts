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
