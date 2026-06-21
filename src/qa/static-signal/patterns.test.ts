import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAstGrepJson, patternsForLanguage } from "./patterns";

test("parseAstGrepJson maps matches to {file, pattern}", () => {
  const json = readFileSync(join(import.meta.dirname, "__fixtures__", "astgrep-fetch.json"), "utf8");
  const matches = parseAstGrepJson(json, "api-call", "/tmp");
  assert.ok(matches.some((m) => m.pattern === "api-call" && m.source === "ast-grep"));
});

test("patternsForLanguage falls back to regex when language has no ast-grep rules", () => {
  assert.equal(patternsForLanguage("go"), "regex");
  assert.equal(patternsForLanguage("typescript"), "ast-grep");
});
