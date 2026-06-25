// Parity tests: assert the kernel classifyCommit matches the legacy src/ function byte-for-byte.
// This file imports from src/ (outside qa-engine rootDir) and is excluded from qa-engine typecheck
// (see qa-engine/tsconfig.json exclude list) — identical pattern to diff-parser-parity.test.ts.
// The tests still run via tsx at runtime and are the strangler guard keeping the port honest
// until Plan 7 cutover deletes the legacy originals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCommit } from "@contexts/change-analysis/domain/commit-classification.ts";
import { classifyCommit as legacy } from "../../../../../src/qa/commit-classify.ts";

const srcDiff = (added: string[]) => [
  "diff --git a/src/svc.ts b/src/svc.ts", "--- a/src/svc.ts", "+++ b/src/svc.ts",
  `@@ -1,1 +1,${added.length + 1} @@`, " export class S {", ...added.map((l) => "+" + l), " }",
].join("\n");

test("PARITY: matches legacy classifyCommit across the decision table", () => {
  const cases: Array<[string, string]> = [
    ["feat: x", srcDiff(["if (a) return;"])],
    ["refactor: move", srcDiff(["const moved = 1;"])],
    ["style: format", srcDiff(["const s = \"   spaced   \";"])],
    ["docs: readme", "diff --git a/x.md b/x.md\n--- a/x.md\n+++ b/x.md\n@@ -1,1 +1,2 @@\n a\n+b"],
    ["perf: faster loop", srcDiff(["for (let i=0;i<n;i++) work();"])],
  ];
  for (const [msg, d] of cases) {
    assert.deepEqual(classifyCommit(msg, d), legacy(msg, d), `divergence on: ${msg}`);
  }
});

test("PARITY relocation-subtraction: a logic line that moved (both + and - sides) is NOT escalated to generate", () => {
  // The genuinelyAddedLogic walker subtracts lines that appear on BOTH the +- and -- sides
  // (content relocation: same text removed elsewhere and added here). A moved line is NOT net-new
  // logic, so classifyCommit must return "regression" (or "skip") — NOT "generate".
  // If the subtraction path is mis-ported, the + line looks like new logic → wrong escalation.
  const relocatedDiff = [
    "diff --git a/src/svc.ts b/src/svc.ts",
    "--- a/src/svc.ts",
    "+++ b/src/svc.ts",
    "@@ -1,4 +1,4 @@",
    " export class S {",
    "-  if (x) return 1;",
    "+  if (x) return 1;",
    " }",
  ].join("\n");
  // Both legacy and new impl must agree: no net-new logic → "regression" (not "generate").
  const got = classifyCommit("refactor: move guard", relocatedDiff);
  const exp = legacy("refactor: move guard", relocatedDiff);
  assert.deepEqual(got, exp, "relocation-subtraction path diverged from legacy");
  assert.equal(got.action, "regression",
    "a moved logic line should NOT escalate refactor to generate");
});
