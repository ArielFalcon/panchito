import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCommit } from "@contexts/change-analysis/domain/commit-classification.ts";

const srcDiff = (added: string[]) => [
  "diff --git a/src/svc.ts b/src/svc.ts", "--- a/src/svc.ts", "+++ b/src/svc.ts",
  `@@ -1,1 +1,${added.length + 1} @@`, " export class S {", ...added.map((l) => "+" + l), " }",
].join("\n");

test("feat → generate", () => {
  assert.equal(classifyCommit("feat: add checkout", srcDiff(["if (x) return 1;"])).action, "generate");
});

test("docs with no logic → skip (no token spend)", () => {
  const d = ["diff --git a/README.md b/README.md", "--- a/README.md", "+++ b/README.md", "@@ -1,1 +1,2 @@", " # Title", "+more prose"].join("\n");
  assert.equal(classifyCommit("docs: update readme", d).action, "skip");
});

test("CONTRADICTION: refactor whose diff adds net logic escalates to generate", () => {
  const c = classifyCommit("refactor: rename", srcDiff(["if (newBranch) doThing();"]));
  assert.equal(c.action, "generate");
  assert.equal(c.contradiction, true);
});

test("breaking change always generates", () => {
  assert.equal(classifyCommit("chore!: drop v1", srcDiff(["return;"])).action, "generate");
});
