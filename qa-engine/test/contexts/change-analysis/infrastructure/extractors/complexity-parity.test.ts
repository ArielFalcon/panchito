// Parity test: assert the ported qa-engine complexity extractor matches the legacy src/ function
// byte-for-byte. lizard is not guaranteed to be installed in every test environment, so the
// primary comparison uses parseLizardCsv (the pure, fully deterministic CSV parser) against the
// real fixture CSV — this is the actual meaningfully-testable logic; extractComplexity itself is
// a thin binary-invocation wrapper around it (fail-open when lizard is absent, exercised below).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLizardCsv, extractComplexity } from "@contexts/change-analysis/infrastructure/extractors/complexity.ts";
import { parseLizardCsv as legacyParse, extractComplexity as legacyExtract } from "../../../../../../src/qa/static-signal/complexity.ts";

const fixturesDir = join(import.meta.dirname, "../../../../../../src/qa/static-signal/__fixtures__");

test("PARITY: parseLizardCsv extracts hotspots identically to legacy on the real fixture", () => {
  const csv = readFileSync(join(fixturesDir, "lizard-big.csv"), "utf8");
  const ported = parseLizardCsv(csv, "/tmp");
  const expected = legacyParse(csv, "/tmp");
  assert.deepEqual(ported, expected);
  // Non-trivial: the fixture's "big" function has ccn>=7 (above the ccn>=5 threshold) — proves
  // the CSV was actually parsed and filtered, not just returning an empty degrade.
  assert.ok(ported.some((h) => h.function === "big" && h.ccn >= 5));
  assert.equal(ported.find((h) => h.function === "big")?.file, "big.js", "path must be repo-relative");
});

test("PARITY: ccn-threshold filtering (below 5) matches legacy — both produce []", () => {
  const singlePathCsv = `1,1,5,0,1,"noop@1-1@/tmp/noop.js","/tmp/noop.js","noop","noop (  )",1,1\n`;
  const ported = parseLizardCsv(singlePathCsv, "/tmp");
  const expected = legacyParse(singlePathCsv, "/tmp");
  assert.deepEqual(ported, expected);
  assert.deepEqual(ported, []);
});

test("PARITY: malformed CSV lines are skipped identically, valid line survives", () => {
  const csv = `not,enough,columns\n14,7,63,1,14,"big@1-14@/tmp/big.js","/tmp/big.js","big","big ( x )",1,14\n`;
  const ported = parseLizardCsv(csv, "/tmp");
  const expected = legacyParse(csv, "/tmp");
  assert.deepEqual(ported, expected);
  assert.equal(ported.length, 1);
});

test("PARITY: extractComplexity degrades to [] identically when the binary is unavailable (fail-open)", async () => {
  const ported = await extractComplexity(["a.ts"], "/tmp");
  const expected = await legacyExtract(["a.ts"], "/tmp");
  assert.deepEqual(ported, expected);
});

test("PARITY: extractComplexity returns [] for an empty file list without spawning, matching legacy", async () => {
  const ported = await extractComplexity([], "/tmp");
  const expected = await legacyExtract([], "/tmp");
  assert.deepEqual(ported, []);
  assert.deepEqual(ported, expected);
});
