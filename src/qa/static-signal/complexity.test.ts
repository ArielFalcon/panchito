import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLizardCsv } from "./complexity";

// Real CSV column layout (lizard 1.23.0, no header row):
// col[0]=nloc, col[1]=ccn, col[2]=token, col[3]=param, col[4]=length,
// col[5]="fn@start-end@/abs/path", col[6]=/abs/file, col[7]=function_name,
// col[8]=long_name, col[9]=start_line, col[10]=end_line
// Values are unquoted numbers or double-quoted strings.

test("parseLizardCsv extracts ccn/nloc/function/line, repo-relative", () => {
  const csv = readFileSync(join(import.meta.dirname, "__fixtures__", "lizard-big.csv"), "utf8");
  const hotspots = parseLizardCsv(csv, "/tmp");
  const big = hotspots.find((h) => h.function === "big");
  assert.ok(big, "should find a hotspot for function 'big'");
  assert.ok(big!.ccn >= 3, `expected ccn >= 3, got ${big!.ccn}`);
  assert.equal(typeof big!.line, "number", "line should be a number");
  assert.equal(typeof big!.nloc, "number", "nloc should be a number");
  assert.equal(typeof big!.ccn, "number", "ccn should be a number");
  assert.ok(big!.file.length > 0, "file should be non-empty");
});

test("parseLizardCsv filters out functions below ccn threshold", () => {
  // A bare single-path function (ccn=1) should be excluded by the ccn>=5 filter.
  const singlePathCsv = `1,1,5,0,1,"noop@1-1@/tmp/noop.js","/tmp/noop.js","noop","noop (  )",1,1\n`;
  const hotspots = parseLizardCsv(singlePathCsv, "/tmp");
  assert.equal(hotspots.length, 0, "functions with ccn < 5 must not appear");
});

test("parseLizardCsv normalizes file path relative to repoDir", () => {
  const csv = readFileSync(join(import.meta.dirname, "__fixtures__", "lizard-big.csv"), "utf8");
  const hotspots = parseLizardCsv(csv, "/tmp");
  const big = hotspots.find((h) => h.function === "big");
  assert.ok(big, "hotspot for big must exist");
  // Absolute /tmp/big.js stripped of /tmp/ prefix → big.js
  assert.equal(big!.file, "big.js");
});

test("parseLizardCsv handles empty input", () => {
  const hotspots = parseLizardCsv("", "/tmp");
  assert.deepEqual(hotspots, []);
});

test("parseLizardCsv skips malformed lines gracefully", () => {
  const csv = `not,enough,columns\n14,7,63,1,14,"big@1-14@/tmp/big.js","/tmp/big.js","big","big ( x )",1,14\n`;
  const hotspots = parseLizardCsv(csv, "/tmp");
  // The malformed line is skipped; the valid line (ccn=7) is kept.
  assert.equal(hotspots.length, 1);
  assert.equal(hotspots[0]!.function, "big");
});
