import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCommit, parseChangedFiles } from "./commit-classify";

const logicDiff = [
  "diff --git a/src/checkout.ts b/src/checkout.ts",
  "+++ b/src/checkout.ts",
  "+if (cart.items > 10) {",
  "+  return applyDiscount(cart);",
  "+}",
].join("\n");

const commentDiff = [
  "diff --git a/src/checkout.ts b/src/checkout.ts",
  "+++ b/src/checkout.ts",
  "+// fix a typo in the comment",
].join("\n");

const movedLineDiff = [
  "diff --git a/src/checkout.ts b/src/checkout.ts",
  "+++ b/src/checkout.ts",
  "-  doThing(x);",
  "+  doThing(x);",
].join("\n");

test("feat → generate", () => {
  assert.equal(classifyCommit("feat: new payment screen", logicDiff).action, "generate");
});

test("fix → generate (regression test for the bug)", () => {
  assert.equal(classifyCommit("fix(checkout): fails with >10 items", logicDiff).action, "generate");
});

test("refactor without new logic → regression only", () => {
  const c = classifyCommit("refactor: unify auth", movedLineDiff);
  assert.equal(c.action, "regression");
  assert.equal(c.contradiction, false);
});

test("style with only comments → skip", () => {
  assert.equal(classifyCommit("style: fix comments", commentDiff).action, "skip");
});

test("CONTRADICTION: refactor but the diff adds logic → escalates to generate", () => {
  const c = classifyCommit("refactor: cleanup", logicDiff);
  assert.equal(c.action, "generate");
  assert.equal(c.contradiction, true);
  assert.match(c.reason, /adds logic/);
});

test("a breaking change always generates", () => {
  assert.equal(classifyCommit("refactor!: change the auth contract", commentDiff).action, "generate");
  assert.equal(classifyCommit("feat: x\n\nBREAKING CHANGE: api", commentDiff).breaking, true);
});

test("a moved line is not mistaken for added logic (net 0)", () => {
  assert.equal(classifyCommit("style: reorder", movedLineDiff).hasLogicChange, false);
});

test("unknown type → generate (when in doubt)", () => {
  assert.equal(classifyCommit("update stuff", logicDiff).type, "unknown");
  assert.equal(classifyCommit("update stuff", logicDiff).action, "generate");
});

test("derives the changed files from the diff (scope is inferred from these)", () => {
  const files = parseChangedFiles(logicDiff);
  assert.deepEqual(files, ["src/checkout.ts"]);
});

test("logic counts only in source files (a .md with an if does not count)", () => {
  const mdDiff = ["diff --git a/README.md b/README.md", "+++ b/README.md", "+if you want to..."].join("\n");
  assert.equal(classifyCommit("docs: update readme", mdDiff).hasLogicChange, false);
});
