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

const springConfigDiff = [
  "diff --git a/src/main/resources/application.yml b/src/main/resources/application.yml",
  "+++ b/src/main/resources/application.yml",
  "+  feature:",
  "+    new-checkout-flow: true",
].join("\n");

const pomBumpDiff = [
  "diff --git a/pom.xml b/pom.xml",
  "+++ b/pom.xml",
  "+    <version>2.7.5</version>",
].join("\n");

test("chore that changes Spring application.yml behavior → escalated to generate", () => {
  const c = classifyCommit("chore: tweak config", springConfigDiff);
  assert.equal(c.action, "generate");
  assert.equal(c.contradiction, true);
});

test("chore that only bumps a pom.xml dependency version → stays skip (no over-escalation)", () => {
  assert.equal(classifyCommit("chore: bump spring-boot", pomBumpDiff).action, "skip");
});

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

// A NEW branch in one file must not be cancelled out by an UNRELATED removal in another
// (the dangerous "net-zero masks a new branch" bug: a behavior change going untested).
test("a new branch is not masked by an unrelated removal elsewhere (escalates)", () => {
  const maskedDiff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "+++ b/src/a.ts",
    "+if (user.isAdmin) { grantAccess(); }",
    "diff --git a/src/b.ts b/src/b.ts",
    "+++ b/src/b.ts",
    "-if (legacyFlag) { doOld(); }",
  ].join("\n");
  const c = classifyCommit("refactor: cleanup", maskedDiff);
  assert.equal(c.hasLogicChange, true); // genuinely-added logic, not net
  assert.equal(c.action, "generate");
  assert.equal(c.contradiction, true);
});

// A genuine relocation (identical line removed and re-added) is still NOT new logic,
// even when added in one place and removed in another within the diff.
test("a relocated logic line across files is not counted as new logic", () => {
  const relocateDiff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "+++ b/src/a.ts",
    "-  return compute(x);",
    "diff --git a/src/b.ts b/src/b.ts",
    "+++ b/src/b.ts",
    "+  return compute(x);",
  ].join("\n");
  assert.equal(classifyCommit("refactor: move helper", relocateDiff).hasLogicChange, false);
});

// A string literal that happens to contain code-like words (if/return/parens) is copy,
// not logic — a `style` commit tweaking it must not be force-escalated to generate.
test("code-like words inside a string literal do not look like logic", () => {
  const stringDiff = [
    "diff --git a/src/x.ts b/src/x.ts",
    "+++ b/src/x.ts",
    '+const msg = "please return the item if it is broken";',
  ].join("\n");
  const c = classifyCommit("style: copy tweak", stringDiff);
  assert.equal(c.hasLogicChange, false);
  assert.equal(c.action, "skip");
});
