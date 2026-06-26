// test/contexts/workspace-and-publication/infrastructure/github-issue.adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubIssueAdapter } from "@contexts/workspace-and-publication/infrastructure/github-issue.adapter.ts";

test("open delegates to github.openIssue and maps the url", async () => {
  const adapter = new GitHubIssueAdapter(async (repo, title) => ({ url: `https://gh/${repo}/issues/1#${title}` }));
  const issue = await adapter.open("org/app", "E2E failed", "details");
  assert.match(issue.url, /org\/app\/issues\/1/);
  assert.equal(issue.number, 1); // parsed from url tail; throws if absent (FIX 13b — never silent 0)
});

test("throws when the URL has no issue number (FIX 13b — never silent 0)", async () => {
  const adapter = new GitHubIssueAdapter(async () => ({ url: "https://gh/org/app/pull/5" }));
  await assert.rejects(() => adapter.open("org/app", "title", "body"), /cannot parse issue number/);
});
