// test/contexts/objective-signal/domain/render-coverage-gap.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCoverageGap } from "@contexts/objective-signal/domain/render-coverage-gap.ts";

// post-cutover-remediation P2c (unit 5): the enforce-mode regen's own coverage-gap renderer. Closes
// assemble-change-coverage.ts's own documented deferral ("renderUncovered is deliberately NOT
// ported... no enforce-mode regeneration hook that consumes a coverage-gap string" — see that
// file's header). HAND-WRITTEN expected outputs (no live comparator — the legacy renderUncovered
// was deleted at cutover 1228ea7; only a stale worktree copy remains). Symmetric to the legacy
// renderUncovered's own line-compaction behavior (git show 1228ea7^:src/qa/change-coverage.ts:184),
// adapted to the widened ObjectiveSignalPort.measure() return shape — `uncovered?: {file;
// lines: number[]}[]`, no `overall.ratio` (the port doesn't carry a nested ChangeCoverage), so the
// rendered text omits the legacy's ratio-percentage prefix.

test("renderCoverageGap: empty uncovered array — all covered message", () => {
  assert.equal(renderCoverageGap([]), "all changed lines are covered by the tests");
});

test("renderCoverageGap: one file, contiguous lines — compacts into a range", () => {
  const out = renderCoverageGap([{ file: "src/a.ts", lines: [10, 11, 12] }]);
  assert.equal(out, "changed lines NOT exercised by any test:\n- src/a.ts: lines 10-12");
});

test("renderCoverageGap: one file, non-contiguous lines — compacts into comma-separated parts", () => {
  const out = renderCoverageGap([{ file: "src/a.ts", lines: [3, 5, 6, 7, 20] }]);
  assert.equal(out, "changed lines NOT exercised by any test:\n- src/a.ts: lines 3, 5-7, 20");
});

test("renderCoverageGap: many files — one line per file, in input order", () => {
  const out = renderCoverageGap([
    { file: "src/a.ts", lines: [1] },
    { file: "src/b.ts", lines: [2, 3] },
  ]);
  assert.equal(
    out,
    "changed lines NOT exercised by any test:\n- src/a.ts: lines 1\n- src/b.ts: lines 2-3",
  );
});

test("renderCoverageGap: over the max (default 10) truncates and reports the remainder count", () => {
  const uncovered = Array.from({ length: 12 }, (_, i) => ({ file: `src/f${i}.ts`, lines: [1] }));
  const out = renderCoverageGap(uncovered);
  const lines = out.split("\n");
  // Header + 10 file lines + 1 "…and N more" trailer.
  assert.equal(lines.length, 12);
  assert.equal(lines[0], "changed lines NOT exercised by any test:");
  assert.equal(lines[11], "…and 2 more file(s)");
});

test("renderCoverageGap: a custom max truncates at the caller's own bound", () => {
  const uncovered = [
    { file: "src/a.ts", lines: [1] },
    { file: "src/b.ts", lines: [2] },
    { file: "src/c.ts", lines: [3] },
  ];
  const out = renderCoverageGap(uncovered, 2);
  assert.equal(out, "changed lines NOT exercised by any test:\n- src/a.ts: lines 1\n- src/b.ts: lines 2\n…and 1 more file(s)");
});

test("renderCoverageGap: exactly at the max — no truncation trailer", () => {
  const uncovered = [
    { file: "src/a.ts", lines: [1] },
    { file: "src/b.ts", lines: [2] },
  ];
  const out = renderCoverageGap(uncovered, 2);
  assert.equal(out, "changed lines NOT exercised by any test:\n- src/a.ts: lines 1\n- src/b.ts: lines 2");
});
