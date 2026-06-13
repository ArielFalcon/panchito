import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeVlq, decodeMappings, normalizeSourcePath, coveredOriginalLines } from "./source-map";

test("decodeVlq decodes base64-VLQ fields (incl. continuation + sign)", () => {
  assert.deepEqual(decodeVlq("A"), [0]);
  assert.deepEqual(decodeVlq("C"), [1]);
  assert.deepEqual(decodeVlq("D"), [-1]); // odd low bit = negative
  assert.deepEqual(decodeVlq("AAAA"), [0, 0, 0, 0]);
  assert.deepEqual(decodeVlq("ACEA"), [0, 1, 2, 0]);
});

test("decodeMappings accumulates source/line/col across lines, resets genCol per line", () => {
  const segs = decodeMappings("AAAA;ACEA");
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[0], { genLine: 0, genCol: 0, sourceIndex: 0, origLine: 0, origCol: 0 });
  assert.deepEqual(segs[1], { genLine: 1, genCol: 0, sourceIndex: 1, origLine: 2, origCol: 0 });
});

test("normalizeSourcePath strips webpack scheme, ./ and leading slashes", () => {
  assert.equal(normalizeSourcePath("webpack:///./src/app/foo.component.ts"), "src/app/foo.component.ts");
  assert.equal(normalizeSourcePath("../../src/lib/x.ts"), "src/lib/x.ts");
  assert.equal(normalizeSourcePath("app/x.ts", "webpack:///src"), "src/app/x.ts");
});

test("coveredOriginalLines maps covered bundle bytes back to original source files/lines", () => {
  // Two segments: bundle (line0,col0)→source0 line0; bundle (line1,col0)→source1 line2.
  const map = { sources: ["src/a.ts", "src/b.ts"], mappings: "AAAA;ACEA" };
  const genLineStarts = [0, 10]; // generated line 0 at byte 0, line 1 at byte 10
  // Only byte 0 executed → only source0's line should be covered; source1 (byte 10) is not.
  const covered = coveredOriginalLines(
    map,
    genLineStarts,
    (b) => b === 0,
    (s) => (s === "src/a.ts" || s === "src/b.ts" ? s : null),
  );
  assert.deepEqual([...covered.keys()], ["src/a.ts"]);
  assert.deepEqual([...covered.get("src/a.ts")!], [1]); // origLine 0 → 1-based line 1
});

test("coveredOriginalLines ignores sources that do not resolve to a changed repo file", () => {
  const map = { sources: ["node_modules/lib/x.js"], mappings: "AAAA" };
  const covered = coveredOriginalLines(map, [0], () => true, () => null);
  assert.equal(covered.size, 0);
});
