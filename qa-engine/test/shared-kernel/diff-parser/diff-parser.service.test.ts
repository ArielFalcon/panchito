import { test } from "node:test";
import assert from "node:assert/strict";
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";

const svc = new DiffParserService();

function diff(file: string, body: string[]): string {
  return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, ...body].join("\n");
}

test("changedLines: added lines are numbered on the new side", () => {
  const d = diff("src/a.ts", ["@@ -1,2 +1,3 @@", " ctx", "+added one", "+added two"]);
  const map = svc.changedLines(d);
  assert.deepEqual([...(map.get("src/a.ts") ?? new Set())].sort((x, y) => x - y), [2, 3]);
});

test("changedLines: pure deletion contributes no new lines (file absent)", () => {
  const d = diff("src/b.ts", ["@@ -1,2 +1,1 @@", " ctx", "-gone"]);
  const map = svc.changedLines(d);
  assert.equal(map.has("src/b.ts"), false);
});

test("changedLines: a '+++ '/'--- ' INSIDE hunk content is not mistaken for a header", () => {
  const d = diff("docs/x.md", ["@@ -1,1 +1,3 @@", " intro", "+--- a/fake", "+++ b/fake"]);
  const map = svc.changedLines(d);
  // both added lines belong to docs/x.md, not a phantom "fake" file
  assert.deepEqual([...(map.get("docs/x.md") ?? new Set())].sort((x, y) => x - y), [2, 3]);
  assert.equal(map.has("fake"), false);
});

test("changedFiles: every changed path (added, modified, deleted) from the diff --git headers", () => {
  const d = [
    "diff --git a/src/added.ts b/src/added.ts",
    "--- /dev/null",
    "+++ b/src/added.ts",
    "@@ -0,0 +1,1 @@",
    "+new",
    "diff --git a/src/mod.ts b/src/mod.ts",
    "--- a/src/mod.ts",
    "+++ b/src/mod.ts",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
  ].join("\n");
  assert.deepEqual(svc.changedFiles(d).sort(), ["src/added.ts", "src/mod.ts"]);
});

test("modifiedFiles: only files present on BOTH sides (a pure add is excluded)", () => {
  const d = [
    "diff --git a/src/added.ts b/src/added.ts",
    "--- /dev/null",
    "+++ b/src/added.ts",
    "@@ -0,0 +1,1 @@",
    "+new",
    "diff --git a/src/mod.ts b/src/mod.ts",
    "--- a/src/mod.ts",
    "+++ b/src/mod.ts",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
  ].join("\n");
  // added.ts has --- /dev/null (not --- a/...), so it is NOT a modification
  assert.deepEqual(svc.modifiedFiles(d), ["src/mod.ts"]);
});
