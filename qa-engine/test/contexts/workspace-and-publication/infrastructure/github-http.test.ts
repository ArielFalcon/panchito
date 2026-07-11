// test/contexts/workspace-and-publication/infrastructure/github-http.test.ts
// migration-tier-4a: clampTitle/clampBody moved here from src/integrations/github.ts (deliberately
// duplicated, not shared — see github-http.ts's own header) so GitHubPrAdapter/GitHubIssueAdapter can
// clamp without importing src/. Same boundary-guard tests as the legacy github.test.ts pinned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clampTitle, clampBody, GITHUB_MAX_TITLE, GITHUB_MAX_BODY } from "@contexts/workspace-and-publication/infrastructure/github-http.ts";

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
