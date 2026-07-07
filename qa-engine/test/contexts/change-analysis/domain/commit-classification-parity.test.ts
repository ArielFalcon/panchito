// Parity tests: assert the kernel classifyCommit matches the legacy src/ function byte-for-byte.
// This file imports from src/ (outside qa-engine rootDir) and is excluded from qa-engine typecheck
// (see qa-engine/tsconfig.json exclude list) — identical pattern to diff-parser-parity.test.ts.
// The tests still run via tsx at runtime and are the strangler guard keeping the port honest
// until Plan 7 cutover deletes the legacy originals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCommit, classifyRange } from "@contexts/change-analysis/domain/commit-classification.ts";
import { classifyCommit as legacy, classifyRange as legacyRange } from "../../../../../src/qa/commit-classify.ts";

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

// ── WS7.3(a)/(b)/(c) PARITY: the qa-engine domain copy and the legacy twin must agree on every
// new escalation path this remediation slice adds (template extensions, removed-logic, migrations).

test("PARITY WS7.3(a): .html template with added logic", () => {
  const d = ["diff --git a/src/index.html b/src/index.html", "--- a/src/index.html", "+++ b/src/index.html", "@@ -1,1 +1,2 @@", " <html>", "+<script>if (loggedIn) redirect();</script>"].join("\n");
  assert.deepEqual(classifyCommit("chore: tweak markup", d), legacy("chore: tweak markup", d));
});

test("PARITY WS7.3(a): .astro template with added logic", () => {
  const d = ["diff --git a/src/pages/index.astro b/src/pages/index.astro", "--- a/src/pages/index.astro", "+++ b/src/pages/index.astro", "@@ -1,1 +1,2 @@", " ---", "+if (isAdmin) { return Astro.redirect('/admin'); }"].join("\n");
  assert.deepEqual(classifyCommit("style: format", d), legacy("style: format", d));
});

test("PARITY WS7.3(b): removal-heavy skip commit escalates to regression", () => {
  const d = ["diff --git a/src/svc.ts b/src/svc.ts", "--- a/src/svc.ts", "+++ b/src/svc.ts", "@@ -1,2 +1,1 @@", " export class S {", "-if (legacyFlag) doOldThing();", " }"].join("\n");
  assert.deepEqual(classifyCommit("chore: cleanup dead code", d), legacy("chore: cleanup dead code", d));
});

test("PARITY WS7.3(c): Flyway migration escalates to regression", () => {
  const d = [
    "diff --git a/db/migration/V2__add_column.sql b/db/migration/V2__add_column.sql",
    "--- /dev/null", "+++ b/db/migration/V2__add_column.sql",
    "@@ -0,0 +1,1 @@", "+ALTER TABLE owners ADD COLUMN loyalty_points INT;",
  ].join("\n");
  assert.deepEqual(classifyCommit("chore: db update", d), legacy("chore: db update", d));
});

test("PARITY WS7.3(c): unrelated .sql outside a migration path does not escalate", () => {
  const d = ["diff --git a/scripts/adhoc-report.sql b/scripts/adhoc-report.sql", "--- a/scripts/adhoc-report.sql", "+++ b/scripts/adhoc-report.sql", "@@ -1,1 +1,2 @@", " SELECT 1;", "+SELECT 2;"].join("\n");
  assert.deepEqual(classifyCommit("chore: report tweak", d), legacy("chore: report tweak", d));
});

// ── WS7.1 PARITY: classifyRange must agree with its legacy twin, including the head-intent and
// MAX-severity reduction semantics.

test("PARITY WS7.1: classifyRange with no range matches classifyCommit on both sides", () => {
  const d = srcDiff(["if (a) return;"]);
  assert.deepEqual(classifyRange("feat: x", [], d), classifyCommit("feat: x", d));
  assert.deepEqual(legacyRange("feat: x", [], d), legacy("feat: x", d));
  assert.deepEqual(classifyRange("feat: x", [], d), legacyRange("feat: x", [], d));
});

test("PARITY WS7.1: a feat buried under a chore head escalates on both sides, head intent preserved", () => {
  const d = srcDiff(["if (a) return;"]);
  const got = classifyRange("chore: bump deps", ["feat: x"], d);
  const exp = legacyRange("chore: bump deps", ["feat: x"], d);
  assert.deepEqual(got, exp);
  assert.equal(got.action, "generate");
  assert.equal(got.type, "chore");
});
