import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiffHunks, normalizeRepoPath, type CoveredLines } from "./diff-hunks";

function lines(m: CoveredLines): Record<string, number[]> {
  const o: Record<string, number[]> = {};
  for (const [k, v] of m) o[k] = [...v].sort((a, b) => a - b);
  return o;
}

test("parseDiffHunks: added lines numbered on the new side, context advances, deletions don't", () => {
  const diff = [
    "diff --git a/src/foo.ts b/src/foo.ts",
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "@@ -10,3 +10,4 @@ ctx",
    " keep10",
    "-removed",
    "+added11",
    "+added12",
    " keep13",
  ].join("\n");
  assert.deepEqual(lines(parseDiffHunks(diff)), { "src/foo.ts": [11, 12] });
});

test("parseDiffHunks: multiple files and hunks, ignores /dev/null (deleted file)", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "+++ b/a.ts",
    "@@ -1,0 +1,2 @@",
    "+x",
    "+y",
    "diff --git a/gone.ts b/gone.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-old1",
    "-old2",
  ].join("\n");
  assert.deepEqual(lines(parseDiffHunks(diff)), { "a.ts": [1, 2] });
});

test("parseDiffHunks: a hunk CONTENT line starting with '+++ ' is NOT misread as a header", () => {
  // adding a diff snippet into a doc: the added content line is literally "+++ b/other.ts"
  const diff = [
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,1 +1,3 @@",
    " title",
    "+```diff",
    "++++ b/other.ts",
  ].join("\n");
  // both added lines belong to README.md; other.ts must NOT appear
  assert.deepEqual(lines(parseDiffHunks(diff)), { "README.md": [2, 3] });
});

test("normalizeRepoPath strips repoDir, ./ and leading slashes", () => {
  assert.equal(normalizeRepoPath("/repo/src/a.ts", "/repo"), "src/a.ts");
  assert.equal(normalizeRepoPath("./src/a.ts"), "src/a.ts");
  assert.equal(normalizeRepoPath("src\\a.ts"), "src/a.ts");
});
