import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCommit, classifyRange } from "@contexts/change-analysis/domain/commit-classification.ts";

const srcDiff = (added: string[]) => [
  "diff --git a/src/svc.ts b/src/svc.ts", "--- a/src/svc.ts", "+++ b/src/svc.ts",
  `@@ -1,1 +1,${added.length + 1} @@`, " export class S {", ...added.map((l) => "+" + l), " }",
].join("\n");

// WS7.3(b): a diff that REMOVES logic lines (no additions), across a source file.
const removalDiff = (removed: string[]) => [
  "diff --git a/src/svc.ts b/src/svc.ts", "--- a/src/svc.ts", "+++ b/src/svc.ts",
  `@@ -1,${removed.length + 1} +1,1 @@`, " export class S {", ...removed.map((l) => "-" + l), " }",
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

// ── WS7.3(a): .html/.astro template extensions ────────────────────────────────────────────────

test("WS7.3(a): a .html template diff with added logic escalates a skip-typed commit to generate", () => {
  const d = [
    "diff --git a/src/index.html b/src/index.html", "--- a/src/index.html", "+++ b/src/index.html",
    "@@ -1,1 +1,2 @@", " <html>", "+<script>if (loggedIn) redirect();</script>",
  ].join("\n");
  const c = classifyCommit("chore: tweak markup", d);
  assert.equal(c.action, "generate");
  assert.equal(c.contradiction, true);
});

test("WS7.3(a): a .astro template diff with added logic escalates a skip-typed commit to generate", () => {
  const d = [
    "diff --git a/src/pages/index.astro b/src/pages/index.astro", "--- a/src/pages/index.astro", "+++ b/src/pages/index.astro",
    "@@ -1,1 +1,2 @@", " ---", "+if (isAdmin) { return Astro.redirect('/admin'); }",
  ].join("\n");
  const c = classifyCommit("style: format", d);
  assert.equal(c.action, "generate");
});

// ── WS7.3(b): removal-heavy skip-typed commits escalate to REGRESSION (not generate) ───────────

test("WS7.3(b): a chore commit that REMOVES logic escalates to regression, not generate", () => {
  const c = classifyCommit("chore: cleanup dead code", removalDiff(["if (legacyFlag) doOldThing();"]));
  assert.equal(c.action, "regression");
  assert.equal(c.contradiction, true);
});

test("WS7.3(b): a pure relocation (removed logic line re-added elsewhere) does NOT escalate", () => {
  const relocated = [
    "diff --git a/src/svc.ts b/src/svc.ts", "--- a/src/svc.ts", "+++ b/src/svc.ts",
    "@@ -1,3 +1,3 @@", " export class S {", "-  if (x) return 1;", "+  if (x) return 1;", " }",
  ].join("\n");
  const c = classifyCommit("chore: move guard", relocated);
  assert.equal(c.action, "skip", "a relocated line is not genuinely removed logic");
});

test("WS7.3(b): a regression-typed commit (refactor) with removed logic stays regression (untouched by this escalation)", () => {
  // The (b) escalation only fires for action === "skip" — a refactor already runs the suite.
  const c = classifyCommit("refactor: drop dead branch", removalDiff(["if (deadFlag) noop();"]));
  assert.equal(c.action, "regression");
});

// ── WS7.3(c): SQL migrations escalate a skip-typed commit to regression ────────────────────────

test("WS7.3(c): a Flyway-style migration file escalates a chore commit to regression", () => {
  const d = [
    "diff --git a/db/migration/V2__add_column.sql b/db/migration/V2__add_column.sql",
    "--- /dev/null", "+++ b/db/migration/V2__add_column.sql",
    "@@ -0,0 +1,1 @@", "+ALTER TABLE owners ADD COLUMN loyalty_points INT;",
  ].join("\n");
  const c = classifyCommit("chore: db update", d);
  assert.equal(c.action, "regression");
  assert.equal(c.contradiction, true);
});

test("WS7.3(c): a numeric-sequence migration filename also escalates", () => {
  const d = [
    "diff --git a/migrations/003_drop_legacy_table.sql b/migrations/003_drop_legacy_table.sql",
    "--- /dev/null", "+++ b/migrations/003_drop_legacy_table.sql",
    "@@ -0,0 +1,1 @@", "+DROP TABLE legacy_orders;",
  ].join("\n");
  assert.equal(classifyCommit("build: migration", d).action, "regression");
});

test("WS7.3(c): an unrelated .sql file OUTSIDE a migration path/naming convention does NOT escalate", () => {
  const d = [
    "diff --git a/scripts/adhoc-report.sql b/scripts/adhoc-report.sql",
    "--- a/scripts/adhoc-report.sql", "+++ b/scripts/adhoc-report.sql",
    "@@ -1,1 +1,2 @@", " SELECT 1;", "+SELECT 2;",
  ].join("\n");
  assert.equal(classifyCommit("chore: report tweak", d).action, "skip");
});

// ── WS7.1: classifyRange — MAX-severity reduction over a commit range ──────────────────────────

test("classifyRange: a single message (no range) is byte-identical to classifyCommit", () => {
  const diff = srcDiff(["if (x) return 1;"]);
  const single = classifyCommit("feat: add x", diff);
  const ranged = classifyRange("feat: add x", [], diff);
  assert.deepEqual(ranged, single);
});

test("classifyRange: a feat buried under a chore head still generates (MAX severity wins)", () => {
  const diff = srcDiff(["if (x) return 1;"]);
  const c = classifyRange("chore: bump deps", ["feat: add x"], diff);
  assert.equal(c.action, "generate");
});

test("classifyRange: intent (type/message/changedFiles) is ALWAYS the head commit's own", () => {
  const diff = srcDiff(["if (x) return 1;"]);
  const c = classifyRange("chore: bump deps", ["feat: add x"], diff);
  assert.equal(c.type, "chore", "intent must reflect the HEAD commit, not the escalating one");
  assert.equal(c.message, "chore: bump deps");
});

test("classifyRange: regression outranks skip even with no logic escalation", () => {
  const diff = "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,2 @@\n # Title\n+prose";
  const c = classifyRange("docs: typo", ["refactor: tidy"], diff);
  assert.equal(c.action, "regression");
});

test("classifyRange: all-skip range stays skip", () => {
  const diff = "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,2 @@\n # Title\n+prose";
  const c = classifyRange("docs: typo", ["chore: bump"], diff);
  assert.equal(c.action, "skip");
});
