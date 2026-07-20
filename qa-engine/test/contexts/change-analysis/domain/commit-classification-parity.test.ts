// Parity tests: pin the kernel classifyCommit/classifyRange against FROZEN snapshot literals
// captured from the legacy src/qa/commit-classify.ts BEFORE that file was deleted
// (migration-tier-1-2, Slice 4). This file no longer imports src/ and is no longer excluded from
// qa-engine's typecheck.
//
// WARNING (judgment-day round-1, frozen-snapshot discipline — precedent:
// error-class-parity.test.ts's LEGACY_RESOLVE_ERROR_CLASS_SNAPSHOT): the literals asserted below
// are a FROZEN oracle, captured by running the legacy classifyCommit/classifyRange against these
// exact inputs immediately before src/qa/commit-classify.ts was deleted. The legacy source no
// longer exists, so there is no live re-derivation possible. If a change to
// qa-engine/src/contexts/change-analysis/domain/commit-classification.ts makes one of these
// assertions fail, that failure is signaling a REAL behavioral divergence from the legacy oracle,
// not a stale fixture. Editing a snapshot VALUE here to make a failing test pass silently
// rebaselines away that regression instead of fixing it — never do that without a written
// justification (in the commit message or a comment here) for why the NEW value is the correct
// behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCommit, classifyRange, type CommitClassification } from "@contexts/change-analysis/domain/commit-classification.ts";

const srcDiff = (added: string[]) => [
  "diff --git a/src/svc.ts b/src/svc.ts", "--- a/src/svc.ts", "+++ b/src/svc.ts",
  `@@ -1,1 +1,${added.length + 1} @@`, " export class S {", ...added.map((l) => "+" + l), " }",
].join("\n");

test("FROZEN PARITY: matches the legacy classifyCommit decision table (pinned pre-deletion)", () => {
  const cases: Array<[string, string, CommitClassification]> = [
    [
      "feat: x",
      srcDiff(["if (a) return;"]),
      { type: "feat", breaking: false, message: "feat: x", body: undefined, changedFiles: ["src/svc.ts"], hasLogicChange: true, contradiction: false, action: "generate", reason: "type=feat" },
    ],
    [
      "refactor: move",
      srcDiff(["const moved = 1;"]),
      { type: "refactor", breaking: false, message: "refactor: move", body: undefined, changedFiles: ["src/svc.ts"], hasLogicChange: false, contradiction: false, action: "regression", reason: "type=refactor" },
    ],
    [
      "style: format",
      srcDiff(["const s = \"   spaced   \";"]),
      { type: "style", breaking: false, message: "style: format", body: undefined, changedFiles: ["src/svc.ts"], hasLogicChange: false, contradiction: false, action: "skip", reason: "type=style" },
    ],
    [
      "docs: readme",
      "diff --git a/x.md b/x.md\n--- a/x.md\n+++ b/x.md\n@@ -1,1 +1,2 @@\n a\n+b",
      { type: "docs", breaking: false, message: "docs: readme", body: undefined, changedFiles: ["x.md"], hasLogicChange: false, contradiction: false, action: "skip", reason: "type=docs" },
    ],
    [
      "perf: faster loop",
      srcDiff(["for (let i=0;i<n;i++) work();"]),
      { type: "perf", breaking: false, message: "perf: faster loop", body: undefined, changedFiles: ["src/svc.ts"], hasLogicChange: true, contradiction: true, action: "generate", reason: "message 'perf' expected no tests, but the diff adds logic → escalated to generate" },
    ],
  ];
  for (const [msg, d, expected] of cases) {
    assert.deepEqual(classifyCommit(msg, d), expected, `FROZEN divergence on: ${msg}`);
  }
});

test("FROZEN PARITY relocation-subtraction: a logic line that moved (both + and - sides) is NOT escalated to generate", () => {
  // The genuinelyAddedLogic walker subtracts lines that appear on BOTH the +- and -- sides
  // (content relocation: same text removed elsewhere and added here). A moved line is NOT net-new
  // logic, so classifyCommit must return "regression" (or "skip") — NOT "generate".
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
  const got = classifyCommit("refactor: move guard", relocatedDiff);
  const expected: CommitClassification = {
    type: "refactor", breaking: false, message: "refactor: move guard", body: undefined, changedFiles: ["src/svc.ts"],
    hasLogicChange: false, contradiction: false, action: "regression", reason: "type=refactor",
  };
  assert.deepEqual(got, expected, "FROZEN: relocation-subtraction path diverged from the pinned legacy behavior");
  assert.equal(got.action, "regression", "a moved logic line should NOT escalate refactor to generate");
});

// ── WS7.3(a)/(b)/(c) FROZEN PARITY: the qa-engine domain copy must keep agreeing with the pinned
// legacy escalation paths (template extensions, removed-logic, migrations) captured pre-deletion.

test("FROZEN PARITY WS7.3(a): .html template with added logic", () => {
  const d = ["diff --git a/src/index.html b/src/index.html", "--- a/src/index.html", "+++ b/src/index.html", "@@ -1,1 +1,2 @@", " <html>", "+<script>if (loggedIn) redirect();</script>"].join("\n");
  const expected: CommitClassification = {
    type: "chore", breaking: false, message: "chore: tweak markup", body: undefined, changedFiles: ["src/index.html"],
    hasLogicChange: true, contradiction: true, action: "generate",
    reason: "message 'chore' expected no tests, but the diff adds logic → escalated to generate",
  };
  assert.deepEqual(classifyCommit("chore: tweak markup", d), expected);
});

test("FROZEN PARITY WS7.3(a): .astro template with added logic", () => {
  const d = ["diff --git a/src/pages/index.astro b/src/pages/index.astro", "--- a/src/pages/index.astro", "+++ b/src/pages/index.astro", "@@ -1,1 +1,2 @@", " ---", "+if (isAdmin) { return Astro.redirect('/admin'); }"].join("\n");
  const expected: CommitClassification = {
    type: "style", breaking: false, message: "style: format", body: undefined, changedFiles: ["src/pages/index.astro"],
    hasLogicChange: true, contradiction: true, action: "generate",
    reason: "message 'style' expected no tests, but the diff adds logic → escalated to generate",
  };
  assert.deepEqual(classifyCommit("style: format", d), expected);
});

test("FROZEN PARITY WS7.3(b): removal-heavy skip commit escalates to regression", () => {
  const d = ["diff --git a/src/svc.ts b/src/svc.ts", "--- a/src/svc.ts", "+++ b/src/svc.ts", "@@ -1,2 +1,1 @@", " export class S {", "-if (legacyFlag) doOldThing();", " }"].join("\n");
  const expected: CommitClassification = {
    type: "chore", breaking: false, message: "chore: cleanup dead code", body: undefined, changedFiles: ["src/svc.ts"],
    hasLogicChange: false, contradiction: true, action: "regression",
    reason: "message 'chore' expected no tests, but the diff REMOVES logic (1 line(s)) → escalated to regression (stale specs may surface)",
  };
  assert.deepEqual(classifyCommit("chore: cleanup dead code", d), expected);
});

test("FROZEN PARITY WS7.3(c): Flyway migration escalates to regression", () => {
  const d = [
    "diff --git a/db/migration/V2__add_column.sql b/db/migration/V2__add_column.sql",
    "--- /dev/null", "+++ b/db/migration/V2__add_column.sql",
    "@@ -0,0 +1,1 @@", "+ALTER TABLE owners ADD COLUMN loyalty_points INT;",
  ].join("\n");
  const expected: CommitClassification = {
    type: "chore", breaking: false, message: "chore: db update", body: undefined, changedFiles: ["db/migration/V2__add_column.sql"],
    hasLogicChange: false, contradiction: true, action: "regression",
    reason: "message 'chore' expected no tests, but the diff adds a DB migration → escalated to regression",
  };
  assert.deepEqual(classifyCommit("chore: db update", d), expected);
});

test("FROZEN PARITY WS7.3(c): unrelated .sql outside a migration path does not escalate", () => {
  const d = ["diff --git a/scripts/adhoc-report.sql b/scripts/adhoc-report.sql", "--- a/scripts/adhoc-report.sql", "+++ b/scripts/adhoc-report.sql", "@@ -1,1 +1,2 @@", " SELECT 1;", "+SELECT 2;"].join("\n");
  const expected: CommitClassification = {
    type: "chore", breaking: false, message: "chore: report tweak", body: undefined, changedFiles: ["scripts/adhoc-report.sql"],
    hasLogicChange: false, contradiction: false, action: "skip", reason: "type=chore",
  };
  assert.deepEqual(classifyCommit("chore: report tweak", d), expected);
});

// ── WS7.1 FROZEN PARITY: classifyRange must keep agreeing with the pinned legacy head-intent and
// MAX-severity reduction semantics.

test("FROZEN PARITY WS7.1: classifyRange with no range matches classifyCommit on both sides", () => {
  const d = srcDiff(["if (a) return;"]);
  const expected: CommitClassification = {
    type: "feat", breaking: false, message: "feat: x", body: undefined, changedFiles: ["src/svc.ts"],
    hasLogicChange: true, contradiction: false, action: "generate", reason: "type=feat",
  };
  assert.deepEqual(classifyRange("feat: x", [], d), expected);
  assert.deepEqual(classifyCommit("feat: x", d), expected);
  assert.deepEqual(classifyRange("feat: x", [], d), classifyCommit("feat: x", d));
});

test("FROZEN PARITY WS7.1: a feat buried under a chore head escalates on both sides, head intent preserved", () => {
  const d = srcDiff(["if (a) return;"]);
  const got = classifyRange("chore: bump deps", ["feat: x"], d);
  const expected: CommitClassification = {
    type: "chore", breaking: false, message: "chore: bump deps", body: undefined, changedFiles: ["src/svc.ts"],
    hasLogicChange: true, contradiction: true, action: "generate",
    reason: "range of 2 commit(s): message 'chore' expected no tests, but the diff adds logic → escalated to generate",
  };
  assert.deepEqual(got, expected);
  assert.equal(got.action, "generate");
  assert.equal(got.type, "chore");
});
