// test/contexts/objective-signal/domain/assemble-change-coverage.test.ts
// THE VALUE KEYSTONE, closed: assembleChangeCoverage() is what turns CoverageCollectorPort's raw
// CoverageReport + the run's diff into the ChangeCoverage read-model DecideCoverageService.decide()
// consumes — the assembly step ObjectiveSignalPortAdapter's own header previously documented as
// missing. parseDiffHunks/computeChangeCoverage are ported verbatim from src/qa/change-coverage.ts;
// these tests pin the same fixture shapes as src/qa/change-coverage.test.ts (parity, not reinvention).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDiffHunks,
  computeChangeCoverage,
  assembleChangeCoverage,
} from "@contexts/objective-signal/domain/assemble-change-coverage.ts";
import { DecideCoverageService } from "@contexts/objective-signal/domain/decide-coverage.service.ts";
import type { CoverageReport } from "@contexts/objective-signal/application/ports/index.ts";

function lines(m: Map<string, Set<number>>): Record<string, number[]> {
  const o: Record<string, number[]> = {};
  for (const [k, v] of m) o[k] = [...v].sort((a, b) => a - b);
  return o;
}

// ── parseDiffHunks parity ──────────────────────────────────────────────────────────────────────

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

test("parseDiffHunks: a NEW file (all-added hunk) numbers lines starting at 1", () => {
  const diff = [
    "diff --git a/new.ts b/new.ts",
    "+++ b/new.ts",
    "@@ -0,0 +1,3 @@",
    "+line1",
    "+line2",
    "+line3",
  ].join("\n");
  assert.deepEqual(lines(parseDiffHunks(diff)), { "new.ts": [1, 2, 3] });
});

test("parseDiffHunks: a hunk CONTENT line starting with '+++ ' is NOT misread as a header", () => {
  const diff = [
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,1 +1,3 @@",
    " title",
    "+```diff",
    "++++ b/other.ts",
  ].join("\n");
  assert.deepEqual(lines(parseDiffHunks(diff)), { "README.md": [2, 3] });
});

// ── computeChangeCoverage intersection math parity ────────────────────────────────────────────

test("computeChangeCoverage: intersects, reports uncovered, computes ratio", () => {
  const changed = new Map([["a.ts", new Set([1, 2, 3, 4])]]);
  const covered = new Map([["a.ts", new Set([1, 2, 9])]]);
  const cc = computeChangeCoverage(changed, covered);
  assert.equal(cc.measured, true);
  assert.equal(cc.overall.changedLines, 4);
  assert.equal(cc.overall.coveredChanged, 2);
  assert.equal(cc.overall.ratio, 0.5);
  assert.deepEqual(cc.uncovered, [{ file: "a.ts", lines: [3, 4] }]);
  assert.equal(cc.branches, null); // the rewritten port carries no branch-coverage signal (yet)
});

test("computeChangeCoverage: a changed file with NO coverage data → measured stays false", () => {
  const cc = computeChangeCoverage(new Map([["a.ts", new Set([1, 2])]]), new Map());
  assert.equal(cc.measured, false);
  assert.equal(cc.overall.ratio, 0);
});

test("computeChangeCoverage: perFile ratios and multi-file intersection", () => {
  const changed = new Map([
    ["a.ts", new Set([1, 2, 3, 4])],
    ["b.ts", new Set([10, 11])],
  ]);
  const covered = new Map([
    ["a.ts", new Set([1, 2, 3])],
    ["b.ts", new Set([10, 11])],
  ]);
  const cc = computeChangeCoverage(changed, covered);
  const perFile = [...cc.perFile].sort((x, y) => x.file.localeCompare(y.file));
  assert.deepEqual(perFile, [
    { file: "a.ts", changed: 4, covered: 3, ratio: 0.75 },
    { file: "b.ts", changed: 2, covered: 2, ratio: 1 },
  ]);
});

// ── report-shape conversion (CoverageReport [{file,lines}] -> Map<string, Set<number>>) ─────────

test("assembleChangeCoverage: converts CoverageReport's array-of-objects shape and intersects with the diff", () => {
  const diff = [
    "diff --git a/src/checkout.ts b/src/checkout.ts",
    "+++ b/src/checkout.ts",
    "@@ -1,0 +1,3 @@",
    "+line1",
    "+line2",
    "+line3",
  ].join("\n");
  const report: CoverageReport = { covered: [{ file: "src/checkout.ts", lines: [1, 2] }] };

  const cc = assembleChangeCoverage(diff, report);

  assert.equal(cc.measured, true);
  assert.equal(cc.overall.changedLines, 3);
  assert.equal(cc.overall.coveredChanged, 2);
  assert.deepEqual(cc.uncovered, [{ file: "src/checkout.ts", lines: [3] }]);
});

test("assembleChangeCoverage: a file in the report that the diff never touched contributes nothing", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,0 +1,1 @@",
    "+x",
  ].join("\n");
  const report: CoverageReport = { covered: [{ file: "src/unrelated.ts", lines: [1, 2, 3] }] };

  const cc = assembleChangeCoverage(diff, report);

  assert.equal(cc.measured, false); // a.ts (the only changed file) has no matching report entry
  assert.equal(cc.overall.changedLines, 1);
  assert.equal(cc.overall.coveredChanged, 0);
});

// ── zero-changed-lines semantics (matches legacy: decide() -> "unknown") ─────────────────────────

test("assembleChangeCoverage: a diff with no added lines (pure deletion) → measured but decide() reads unknown", () => {
  const diff = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +0,0 @@", "-x", "-y"].join("\n");
  const report: CoverageReport = { covered: [] };

  const cc = assembleChangeCoverage(diff, report);
  assert.equal(cc.overall.changedLines, 0);

  const svc = new DecideCoverageService();
  const status = svc.decide(cc, { mode: "enforce", minRatio: 0.7 });
  assert.equal(status, "unknown", "zero changed lines must decide to unknown, matching legacy decideCoverage's own changedLines===0 guard");
  assert.equal(svc.blocks(status, { mode: "enforce", minRatio: 0.7 }), false, "unknown must never block, even in enforce mode");
});

// ── MUTATION-PROOF: the keystone actually gates on real ratios ──────────────────────────────────

test("KEYSTONE: uncovered diff lines under a real assembler → decide() returns fail under enforce, and blocks publish", () => {
  const diff = [
    "diff --git a/src/checkout.ts b/src/checkout.ts",
    "+++ b/src/checkout.ts",
    "@@ -1,0 +1,4 @@",
    "+a",
    "+b",
    "+c",
    "+d",
  ].join("\n");
  // Only 1 of 4 changed lines covered — ratio 0.25, below the 0.7 default minRatio.
  const report: CoverageReport = { covered: [{ file: "src/checkout.ts", lines: [1] }] };

  const cc = assembleChangeCoverage(diff, report);
  const svc = new DecideCoverageService();
  const policy = { mode: "enforce" as const, minRatio: 0.7 };
  const status = svc.decide(cc, policy);

  assert.equal(status, "fail");
  assert.equal(svc.blocks(status, policy), true, "enforce mode must block publish on a real coverage gap");
});

test("KEYSTONE: the SAME uncovered gap under signal mode never blocks (records only)", () => {
  const diff = [
    "diff --git a/src/checkout.ts b/src/checkout.ts",
    "+++ b/src/checkout.ts",
    "@@ -1,0 +1,4 @@",
    "+a",
    "+b",
    "+c",
    "+d",
  ].join("\n");
  const report: CoverageReport = { covered: [{ file: "src/checkout.ts", lines: [1] }] };

  const cc = assembleChangeCoverage(diff, report);
  const svc = new DecideCoverageService();
  const policy = { mode: "signal" as const, minRatio: 0.7 };
  const status = svc.decide(cc, policy);

  assert.equal(status, "fail"); // the STATUS is still fail (an honest signal)...
  assert.equal(svc.blocks(status, policy), false, "...but signal mode must never block publish on it");
});

test("KEYSTONE: no assembler / no diff still decides unknown and NEVER blocks (unchanged safe default)", () => {
  const svc = new DecideCoverageService();
  for (const mode of ["off", "signal", "enforce"] as const) {
    const policy = { mode, minRatio: 0.7 };
    const status = svc.decide(null, policy);
    assert.equal(status, "unknown");
    assert.equal(svc.blocks(status, policy), false);
  }
});
