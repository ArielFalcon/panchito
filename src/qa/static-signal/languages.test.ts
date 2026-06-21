import test from "node:test";
import assert from "node:assert/strict";
import { languageForFile, SUPPORTED_LANGUAGES } from "./languages";
test("languageForFile maps known extensions", () => {
  assert.equal(languageForFile("src/a.ts"), "typescript");
  assert.equal(languageForFile("src/a.tsx"), "typescript");
  assert.equal(languageForFile("src/a.js"), "javascript");
  assert.equal(languageForFile("src/Main.java"), "java");
});
test("languageForFile returns null for unsupported extensions (degrade)", () => {
  assert.equal(languageForFile("src/main.go"), null);
  assert.equal(languageForFile("README.md"), null);
});
test("SUPPORTED_LANGUAGES is the single source of truth", () => {
  assert.deepEqual([...SUPPORTED_LANGUAGES].sort(), ["java", "javascript", "typescript"]);
});
