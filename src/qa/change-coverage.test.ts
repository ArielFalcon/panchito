import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseDiffHunks,
  computeChangeCoverage,
  decideCoverage,
  blocksPublish,
  renderUncovered,
  normalizeRepoPath,
  parseLcov,
  parseLcovBranches,
  parseJacocoXml,
  parseIstanbulJson,
  parseIstanbulBranches,
  parseV8Coverage,
  resolveUrlToRepoFile,
  clearRunArtifacts,
  CoveredLines,
  CoveredBranches,
  DEFAULT_COVERAGE_POLICY,
} from "./change-coverage";

function lines(m: CoveredLines): Record<string, number[]> {
  const o: Record<string, number[]> = {};
  for (const [k, v] of m) o[k] = [...v].sort((a, b) => a - b);
  return o;
}

// Determinism keystone: stale V8 dumps from a prior same-SHA run (gitignored, so they
// survive `git clean -fd`) must be removed before a new measurement — otherwise
// collectBrowserCoverage would union them and credit coverage to tests that did not run
// this time, flipping a genuinely-uncovered change to a false "pass".
// Also clears fault-injection oracle artifacts which accumulate in the gitignored mirror.
test("clearRunArtifacts removes coverage AND fault-injection dirs (idempotent)", () => {
  const e2eDir = mkdtempSync(join(tmpdir(), "cc-clear-"));
  const ns = "qa-bot-abc1234";
  const coverageDir = join(e2eDir, ".qa", "coverage", ns);
  const faultDir = join(e2eDir, ".qa", "fault-injection", ns);
  mkdirSync(coverageDir, { recursive: true });
  mkdirSync(faultDir, { recursive: true });
  writeFileSync(join(coverageDir, "stale-0-0.json"), "[]");
  writeFileSync(join(faultDir, "oracle-0.json"), "{}");
  assert.equal(existsSync(coverageDir), true);
  assert.equal(existsSync(faultDir), true);

  clearRunArtifacts(e2eDir, ns);
  assert.equal(existsSync(join(e2eDir, ".qa", "coverage")), false); // whole coverage tree gone
  assert.equal(existsSync(join(e2eDir, ".qa", "fault-injection")), false); // whole fault-injection tree gone

  assert.doesNotThrow(() => clearRunArtifacts(e2eDir, ns)); // idempotent on absent dirs
  rmSync(e2eDir, { recursive: true, force: true });
});

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

test("parseJacocoXml maps JVM coverage to the changed repo file by package suffix (Java code-mode)", () => {
  const xml = `<report name="app">
<package name="com/example">
<sourcefile name="Foo.java">
<line nr="10" mi="0" ci="3"/>
<line nr="11" mi="2" ci="0"/>
<line nr="12" mi="0" ci="1"/>
</sourcefile>
</package>
</report>`;
  const cov = parseJacocoXml(xml, ["src/main/java/com/example/Foo.java"]);
  assert.deepEqual([...cov.keys()], ["src/main/java/com/example/Foo.java"]);
  assert.deepEqual([...cov.get("src/main/java/com/example/Foo.java")!].sort((a, b) => a - b), [10, 12]); // ci>0 only
});

test("parseV8Coverage uses the SOURCE MAP for a bundled/hashed URL (ORACLE-03 keystone)", () => {
  // The served script is a hashed bundle whose URL matches no repo path; coverage must be mapped
  // back to original sources via the source map. mappings "AAAA;ACEA": bundle (l0,c0)→src0 line0,
  // bundle (l1,c0)→src1 line2. Only bundle byte 0 (line 0) executed → only src/a.ts:1 is covered.
  const entries = [
    {
      url: "https://app.example.com/main.a1b2c3d4.js", // hashed bundle — no suffix match to any repo file
      source: "ab\ncd",
      functions: [{ ranges: [{ startOffset: 0, endOffset: 2, count: 1 }] }],
      map: { version: 3, sources: ["src/a.ts", "src/b.ts"], mappings: "AAAA;ACEA" },
    },
  ];
  assert.deepEqual(lines(parseV8Coverage(entries, ["src/a.ts", "src/b.ts"])), { "src/a.ts": [1] });
});

test("parseV8Coverage carves out a NESTED count==0 range (no over-reporting)", () => {
  // 5 single-char lines. A whole-module range (count 1) with a nested count-0 hole over
  // lines 3-4 — those lines never ran and must NOT be reported covered.
  const source = "a\nb\nc\nd\ne\n"; // bytes: l1=[0,2) l2=[2,4) l3=[4,6) l4=[6,8) l5=[8,10)
  const entries = [
    {
      url: "http://dev/src/x.ts",
      source,
      functions: [{ ranges: [
        { startOffset: 0, endOffset: 10, count: 1 }, // outer: whole module executed
        { startOffset: 4, endOffset: 8, count: 0 }, // inner hole: lines 3-4 did NOT run
      ] }],
    },
  ];
  assert.deepEqual(lines(parseV8Coverage(entries, ["src/x.ts"])), { "src/x.ts": [1, 2, 5] });
});

test("parseV8Coverage still reports every line of a fully-covered function", () => {
  const source = "a\nb\nc\n";
  const entries = [{ url: "http://dev/src/y.ts", source, functions: [{ ranges: [{ startOffset: 0, endOffset: 6, count: 1 }] }] }];
  assert.deepEqual(lines(parseV8Coverage(entries, ["src/y.ts"])), { "src/y.ts": [1, 2, 3] });
});

function branchTally(m: CoveredBranches): Record<string, Record<number, { total: number; taken: number }>> {
  const o: Record<string, Record<number, { total: number; taken: number }>> = {};
  for (const [f, perLine] of m) { o[f] = {}; for (const [ln, t] of perLine) o[f][ln] = t; }
  return o;
}

test("parseLcovBranches: BRDA tallies total and taken per line", () => {
  const lcov = ["SF:/repo/src/a.ts", "BRDA:5,0,0,1", "BRDA:5,0,1,-", "BRDA:8,0,0,3", "end_of_record"].join("\n");
  assert.deepEqual(branchTally(parseLcovBranches(lcov, "/repo")), { "src/a.ts": { 5: { total: 2, taken: 1 }, 8: { total: 1, taken: 1 } } });
});

test("parseIstanbulBranches: branchMap loc.start.line with b>0 counts as taken", () => {
  const json = { "/repo/src/a.ts": { path: "/repo/src/a.ts", branchMap: { "0": { loc: { start: { line: 5 } }, locations: [{ start: { line: 5 } }, { start: { line: 5 } }] } }, b: { "0": [3, 0] } } };
  assert.deepEqual(branchTally(parseIstanbulBranches(json, "/repo")), { "src/a.ts": { 5: { total: 2, taken: 1 } } });
});

test("computeChangeCoverage folds branch tally restricted to changed lines", () => {
  const changed: CoveredLines = new Map([["src/a.ts", new Set([5, 8])]]);
  const coveredLines: CoveredLines = new Map([["src/a.ts", new Set([5, 8])]]);
  const coveredBranches: CoveredBranches = new Map([["src/a.ts", new Map([[5, { total: 2, taken: 1 }], [99, { total: 4, taken: 4 }]])]]);
  const cc = computeChangeCoverage(changed, coveredLines, coveredBranches);
  assert.deepEqual(cc.branches, { changedBranches: 2, takenBranches: 1, ratio: 0.5 });
});

test("computeChangeCoverage: branches null when no branch data", () => {
  const changed: CoveredLines = new Map([["src/a.ts", new Set([1])]]);
  const cc = computeChangeCoverage(changed, new Map([["src/a.ts", new Set([1])]]));
  assert.equal(cc.branches, null);
});

// An INDEPENDENT base64-VLQ encoder (the inverse of source-map.ts's decoder), so the realistic
// keystone test below feeds the decoder real round-tripped data rather than a hand-picked string —
// proving it on inputs a real bundler emits, not just the toy "AAAA;ACEA" smoke case.
const VLQ_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function encodeVlq(num: number): string {
  let vlq = num < 0 ? (-num << 1) | 1 : num << 1;
  let out = "";
  do {
    let digit = vlq & 31;
    vlq >>>= 5;
    if (vlq > 0) digit |= 32; // continuation bit
    out += VLQ_B64[digit];
  } while (vlq > 0);
  return out;
}
// segs[genLine] = list of ABSOLUTE [genCol, srcIdx, origLine, origCol] tuples (0-based). Encodes the
// source-map v3 deltas: genCol resets per generated line; srcIdx/origLine/origCol are cumulative.
function encodeMappings(segs: number[][][]): string {
  let srcIdx = 0, origLine = 0, origCol = 0;
  return segs
    .map((line) => {
      let genCol = 0;
      return line
        .map(([gc, si, ol, oc]) => {
          const seg = [gc! - genCol, si! - srcIdx, ol! - origLine, oc! - origCol].map(encodeVlq).join("");
          genCol = gc!; srcIdx = si!; origLine = ol!; origCol = oc!;
          return seg;
        })
        .join(",");
    })
    .join(";");
}

// THE KEYSTONE, END TO END, on real-world-shaped input. A production Angular deploy serves a hashed,
// MINIFIED bundle: many original files collapsed onto few generated lines, tokens at arbitrary
// columns, and source lines OUT OF ORDER (the minifier reorders) → negative origLine deltas in the
// `mappings`. This exercises the whole chain a real run does — diff → V8 coverage resolved through the
// bundle's source map → intersect with the changed lines → signal/enforce decision — and asserts a
// MEASURED ratio, not "unknown". If the VLQ decode, the webpack://+sourceRoot normalization, the
// covered-byte attribution, or the intersection were wrong, the ratio would be wrong here.
test("change-coverage end to end: a minified bundle's coverage maps back to the changed Angular source (measured, not unknown)", () => {
  // Two original files collapsed into a 2-line bundle. genLine 0 holds three login tokens; genLine 1
  // holds a login token then a util token. Tokens sit at columns 0/4/8 so each maps to a distinct byte.
  const bundle = "aaa;bbb;ccc\nddd;eee"; // line0 bytes 0..10, '\n' at 11, line1 bytes 12..18
  const mappings = encodeMappings([
    // genLine 0: src0 (login) original lines 3,4,5 (0-based 2,3,4)
    [[0, 0, 2, 0], [4, 0, 3, 0], [8, 0, 4, 0]],
    // genLine 1: src0 (login) original line 8 (0-based 7); then src1 (util) original line 1 (0-based 0)
    [[0, 0, 7, 0], [4, 1, 0, 0]], // the [4,1,0,0] segment carries a NEGATIVE origLine delta (7→0)
  ]);
  const entries = [
    {
      url: "https://app.example.com/main.9f8e7d6c.js", // hashed bundle — matches no repo path
      source: bundle,
      functions: [
        {
          ranges: [
            { startOffset: 0, endOffset: 4, count: 1 }, // byte 0 (login:3 token) executed
            { startOffset: 4, endOffset: 8, count: 0 }, // byte 4 (login:4 token) did NOT execute
            { startOffset: 8, endOffset: 11, count: 1 }, // byte 8 (login:5 token) executed
            { startOffset: 12, endOffset: 16, count: 1 }, // byte 12 (login:8 token) executed
            { startOffset: 16, endOffset: 19, count: 0 }, // byte 16 (util token) did NOT execute
          ],
        },
      ],
      map: {
        version: 3,
        sourceRoot: "webpack:///",
        sources: ["./src/app/login.component.ts", "./src/app/util.ts"], // webpack scheme + ./ prefix
        mappings,
      },
    },
  ];

  // The diff for this commit touched login.component.ts lines 3,4,5,8 (added lines on the new side).
  const diff = [
    "diff --git a/src/app/login.component.ts b/src/app/login.component.ts",
    "--- a/src/app/login.component.ts",
    "+++ b/src/app/login.component.ts",
    "@@ -1,5 +1,8 @@",
    " line1",
    " line2",
    "+line3",
    "+line4",
    "+line5",
    " line6",
    " line7",
    "+line8",
  ].join("\n");

  const changed = parseDiffHunks(diff);
  assert.deepEqual(lines(changed), { "src/app/login.component.ts": [3, 4, 5, 8] });

  // The bundle's coverage, resolved through the source map, must land on the ORIGINAL Angular lines.
  const covered = parseV8Coverage(entries, ["src/app/login.component.ts"]);
  assert.deepEqual(lines(covered), { "src/app/login.component.ts": [3, 5, 8] }); // line 4 token never ran

  const cc = computeChangeCoverage(changed, covered);
  assert.equal(cc.measured, true); // the keystone is NOT "unknown" for a bundled deploy
  assert.equal(cc.overall.changedLines, 4);
  assert.equal(cc.overall.coveredChanged, 3);
  assert.equal(cc.overall.ratio, 0.75);
  assert.deepEqual(cc.uncovered, [{ file: "src/app/login.component.ts", lines: [4] }]);

  // The policy decision rides on that measured ratio: 0.75 passes a 0.70 bar, fails a 0.80 bar, and
  // only enforce+fail blocks publishing — signal records the same gap without blocking.
  assert.equal(decideCoverage(cc, { mode: "signal", minRatio: 0.7 }), "pass");
  assert.equal(decideCoverage(cc, { mode: "enforce", minRatio: 0.8 }), "fail");
  assert.equal(blocksPublish(decideCoverage(cc, { mode: "enforce", minRatio: 0.8 }), { mode: "enforce", minRatio: 0.8 }), true);
  assert.equal(blocksPublish(decideCoverage(cc, { mode: "signal", minRatio: 0.8 }), { mode: "signal", minRatio: 0.8 }), false);
  assert.match(renderUncovered(cc), /login\.component\.ts: lines 4/);
});
