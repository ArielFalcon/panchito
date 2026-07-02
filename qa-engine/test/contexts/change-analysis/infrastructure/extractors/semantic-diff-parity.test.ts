// Parity test: assert the ported qa-engine semantic-diff extractor matches the legacy src/
// function byte-for-byte. difft IS available in this test environment (unlike lizard), so this
// covers BOTH the pure parser (parseDifftJson, against the real fixture NDJSON) AND the full
// end-to-end extractSemanticDiff over a real temp git repo (materializeBlob + difft subprocess).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDifftJson, extractSemanticDiff } from "@contexts/change-analysis/infrastructure/extractors/semantic-diff.ts";
import { parseDifftJson as legacyParse, extractSemanticDiff as legacyExtract } from "../../../../../../src/qa/static-signal/semantic-diff.ts";

const fixturesDir = join(import.meta.dirname, "../../../../../../src/qa/static-signal/__fixtures__");
const fx = (n: string) => readFileSync(join(fixturesDir, n), "utf8");

test("PARITY: parseDifftJson marks a whitespace-only change cosmetic, matching legacy", () => {
  const json = fx("difft-cosmetic.json");
  const ported = parseDifftJson(json);
  const expected = legacyParse(json);
  assert.deepEqual(ported, expected);
  assert.ok(ported.length > 0);
  assert.equal(ported.some((k) => k.cosmetic), true);
});

test("PARITY: parseDifftJson marks a value change non-cosmetic, matching legacy", () => {
  const json = fx("difft-real.json");
  const ported = parseDifftJson(json);
  const expected = legacyParse(json);
  assert.deepEqual(ported, expected);
  assert.ok(ported.length > 0);
  assert.equal(ported.every((k) => !k.cosmetic), true);
});

// Real end-to-end: a temp git repo with two commits — one purely cosmetic (whitespace), one a
// genuine logic change — exercised through the REAL difft subprocess (available in this env).
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "qa-semdiff-parity-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "a.js"), "function f(x) {\n  return x + 1;\n}\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
  // Commit 2: a genuine semantic change (return x + 2 instead of x + 1).
  writeFileSync(join(dir, "a.js"), "function f(x) {\n  return x + 2;\n}\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "logic change"], { cwd: dir });
  return dir;
}

test("PARITY: extractSemanticDiff over a real git repo + real difft subprocess matches legacy", async () => {
  const dir = makeRepo();
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
    const diff = execFileSync("git", ["diff", "HEAD^", "HEAD"], { cwd: dir }).toString();
    const ported = await extractSemanticDiff(diff, dir, sha);
    const expected = await legacyExtract(diff, dir, sha);
    assert.deepEqual(ported, expected);
    // Non-trivial: a real value change (x+1 → x+2) must be classified non-cosmetic by BOTH.
    assert.ok(ported.length > 0, `expected at least one FileChangeKind, got ${JSON.stringify(ported)}`);
    assert.ok(ported.some((k) => k.file === "a.js" && k.cosmetic === false),
      `expected a.js to be classified as a real (non-cosmetic) change; got ${JSON.stringify(ported)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PARITY: extractSemanticDiff returns [] when the diff touches no files, matching legacy", async () => {
  const dir = makeRepo();
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
    const ported = await extractSemanticDiff("", dir, sha);
    const expected = await legacyExtract("", dir, sha);
    assert.deepEqual(ported, []);
    assert.deepEqual(ported, expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
