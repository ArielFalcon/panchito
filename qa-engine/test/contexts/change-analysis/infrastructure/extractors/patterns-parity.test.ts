// Parity test: assert the ported qa-engine pattern extractor matches the legacy src/ function
// byte-for-byte. sg (ast-grep) IS available in this test environment, so this covers the pure
// JSON parser AND the full end-to-end extractPatterns over a real fixture file (real sg subprocess).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAstGrepJson,
  patternsForLanguage,
  extractPatterns,
} from "@contexts/change-analysis/infrastructure/extractors/patterns.ts";
import {
  parseAstGrepJson as legacyParseJson,
  patternsForLanguage as legacyPatternsForLanguage,
  extractPatterns as legacyExtract,
} from "../../../../../../src/qa/static-signal/patterns.ts";

const fixturesDir = join(import.meta.dirname, "../../../../../../src/qa/static-signal/__fixtures__");

test("PARITY: parseAstGrepJson maps matches to {file, pattern}, identically to legacy", () => {
  const json = readFileSync(join(fixturesDir, "astgrep-fetch.json"), "utf8");
  const ported = parseAstGrepJson(json, "api-call", "/tmp");
  const expected = legacyParseJson(json, "api-call", "/tmp");
  assert.deepEqual(ported, expected);
  assert.ok(ported.some((m) => m.pattern === "api-call" && m.source === "ast-grep"));
});

test("PARITY: patternsForLanguage routes ast-grep-capable vs. fallback languages identically", () => {
  assert.equal(patternsForLanguage("go"), legacyPatternsForLanguage("go"));
  assert.equal(patternsForLanguage("typescript"), legacyPatternsForLanguage("typescript"));
  assert.equal(patternsForLanguage("go"), "regex");
  assert.equal(patternsForLanguage("typescript"), "ast-grep");
});

test("PARITY: extractPatterns over a real fetch() call (real sg subprocess) matches legacy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-patterns-parity-"));
  try {
    writeFileSync(join(dir, "p.js"), `fetch("/api/x").then(r=>r.json())\n`);
    const diff = "diff --git a/p.js b/p.js\n--- a/p.js\n+++ b/p.js\n@@ -0,0 +1 @@\n+fetch(\"/api/x\")\n";
    const ported = await extractPatterns(["p.js"], dir, diff);
    const expected = await legacyExtract(["p.js"], dir, diff);
    assert.deepEqual(ported, expected);
    // Non-trivial: a real fetch() call must be detected as an "api-call" ast-grep pattern.
    assert.ok(ported.some((p) => p.pattern === "api-call" && p.source === "ast-grep"),
      `expected an api-call ast-grep match, got ${JSON.stringify(ported)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PARITY: extractPatterns falls back to regex for an unsupported language, matching legacy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-patterns-parity-fallback-"));
  try {
    writeFileSync(join(dir, "handler.go"), `func Handle() {}\n`);
    const diff = [
      "diff --git a/handler.go b/handler.go",
      "--- a/handler.go",
      "+++ b/handler.go",
      "@@ -0,0 +1,3 @@",
      "+func Handle(w http.ResponseWriter, r *http.Request) {",
      "+  body := r.Body",
      "+}",
    ].join("\n");
    const ported = await extractPatterns(["handler.go"], dir, diff);
    const expected = await legacyExtract(["handler.go"], dir, diff);
    assert.deepEqual(ported, expected);
    // Non-trivial: unsupported language files must ALL be tagged "regex" source (never ast-grep).
    assert.ok(ported.every((p) => p.source === "regex"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
