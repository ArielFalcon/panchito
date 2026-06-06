import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDiffHunks,
  computeChangeCoverage,
  decideCoverage,
  blocksPublish,
  renderUncovered,
  normalizeRepoPath,
  parseLcov,
  parseIstanbulJson,
  parseV8Coverage,
  resolveUrlToRepoFile,
  CoveredLines,
  DEFAULT_COVERAGE_POLICY,
} from "./change-coverage";

function lines(m: CoveredLines): Record<string, number[]> {
  const o: Record<string, number[]> = {};
  for (const [k, v] of m) o[k] = [...v].sort((a, b) => a - b);
  return o;
}

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

test("parseDiffHunks: a hunk CONTENT line starting with '+++ ' is NOT misread as a header", () => {
  // adding a diff snippet into a doc: the added content line is literally "+++ b/other.ts"
  const diff = [
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,1 +1,3 @@",
    " title",
    "+```diff",
    "++++ b/other.ts",
  ].join("\n");
  // both added lines belong to README.md; other.ts must NOT appear
  assert.deepEqual(lines(parseDiffHunks(diff)), { "README.md": [2, 3] });
});

test("computeChangeCoverage: intersects, reports uncovered, computes ratio", () => {
  const changed: CoveredLines = new Map([["a.ts", new Set([1, 2, 3, 4])]]);
  const covered: CoveredLines = new Map([["a.ts", new Set([1, 2, 9])]]);
  const cc = computeChangeCoverage(changed, covered);
  assert.equal(cc.measured, true);
  assert.equal(cc.overall.changedLines, 4);
  assert.equal(cc.overall.coveredChanged, 2);
  assert.equal(cc.overall.ratio, 0.5);
  assert.deepEqual(cc.uncovered, [{ file: "a.ts", lines: [3, 4] }]);
});

test("computeChangeCoverage: a changed file with NO coverage data → measured stays false", () => {
  const cc = computeChangeCoverage(new Map([["a.ts", new Set([1, 2])]]), new Map());
  assert.equal(cc.measured, false);
  assert.equal(cc.overall.ratio, 0); // 0 covered of 2 changed
});

test("decideCoverage: unmeasured/empty → unknown; ratio vs minRatio → pass/fail", () => {
  assert.equal(decideCoverage(null, DEFAULT_COVERAGE_POLICY), "unknown");
  const unmeasured = computeChangeCoverage(new Map([["a.ts", new Set([1])]]), new Map());
  assert.equal(decideCoverage(unmeasured, DEFAULT_COVERAGE_POLICY), "unknown");
  const high = computeChangeCoverage(new Map([["a.ts", new Set([1, 2, 3, 4])]]), new Map([["a.ts", new Set([1, 2, 3])]]));
  assert.equal(decideCoverage(high, { mode: "signal", minRatio: 0.7 }), "pass"); // 0.75 ≥ 0.7
  const low = computeChangeCoverage(new Map([["a.ts", new Set([1, 2, 3, 4])]]), new Map([["a.ts", new Set([1])]]));
  assert.equal(decideCoverage(low, { mode: "signal", minRatio: 0.7 }), "fail"); // 0.25 < 0.7
});

test("blocksPublish: only enforce+fail blocks; signal never blocks; unknown never blocks", () => {
  assert.equal(blocksPublish("fail", { mode: "enforce", minRatio: 0.7 }), true);
  assert.equal(blocksPublish("fail", { mode: "signal", minRatio: 0.7 }), false);
  assert.equal(blocksPublish("unknown", { mode: "enforce", minRatio: 0.7 }), false);
  assert.equal(blocksPublish("pass", { mode: "enforce", minRatio: 0.7 }), false);
});

test("renderUncovered compacts contiguous line ranges", () => {
  const cc = computeChangeCoverage(new Map([["a.ts", new Set([1, 2, 3, 7, 9, 10])]]), new Map([["a.ts", new Set([])]]));
  const r = renderUncovered(cc);
  assert.match(r, /a\.ts: lines 1-3, 7, 9-10/);
});

test("normalizeRepoPath strips repoDir, ./ and leading slashes", () => {
  assert.equal(normalizeRepoPath("/repo/src/a.ts", "/repo"), "src/a.ts");
  assert.equal(normalizeRepoPath("./src/a.ts"), "src/a.ts");
  assert.equal(normalizeRepoPath("src\\a.ts"), "src/a.ts");
});

test("parseLcov: covered lines are DA with hits>0, per SF file", () => {
  const lcov = ["SF:/repo/src/a.ts", "DA:1,3", "DA:2,0", "DA:5,1", "end_of_record"].join("\n");
  assert.deepEqual(lines(parseLcov(lcov, "/repo")), { "src/a.ts": [1, 5] });
});

test("parseIstanbulJson: lines from statements with s>0", () => {
  const json = {
    "/repo/src/a.ts": {
      path: "/repo/src/a.ts",
      statementMap: { "0": { start: { line: 1 }, end: { line: 1 } }, "1": { start: { line: 4 }, end: { line: 5 } } },
      s: { "0": 2, "1": 0 },
    },
  };
  assert.deepEqual(lines(parseIstanbulJson(json, "/repo")), { "src/a.ts": [1] });
});

test("resolveUrlToRepoFile matches by path suffix; no match → null", () => {
  assert.equal(resolveUrlToRepoFile("http://dev/src/components/Foo.tsx", ["src/components/Foo.tsx"]), "src/components/Foo.tsx");
  assert.equal(resolveUrlToRepoFile("http://dev/assets/index-abc123.js", ["src/Foo.tsx"]), null);
});

test("parseV8Coverage maps covered byte ranges to source lines for matched files", () => {
  // source: line1\nline2\nline3  → offsets: l1=0..5, l2=6..11, l3=12..
  const source = "line1\nline2\nline3\n";
  const entries = [
    {
      url: "http://dev/src/a.ts",
      source,
      functions: [{ ranges: [{ startOffset: 0, endOffset: 5, count: 1 }, { startOffset: 12, endOffset: 17, count: 0 }] }],
    },
  ];
  assert.deepEqual(lines(parseV8Coverage(entries, ["src/a.ts"])), { "src/a.ts": [1] }); // line 3 had count 0
});
