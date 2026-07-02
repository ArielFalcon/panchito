// qa-engine/test/shared-kernel/sha.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";

test("Sha: accepts a full 40-char hex sha and exposes value + short", () => {
  const s = Sha.of("a".repeat(40));
  assert.equal(s.value, "a".repeat(40));
  assert.equal(s.short, "aaaaaaa"); // 7 chars
  assert.equal(String(s), "a".repeat(40));
});

test("Sha: accepts abbreviated shas across the git object-name range (4..40)", () => {
  assert.equal(Sha.of("abc1234").value, "abc1234"); // 7 — git conventional short sha
  assert.equal(Sha.of("abc123").value, "abc123");   // 6 — the characterization fixture
  assert.equal(Sha.of("abcd").value, "abcd");        // 4 — git's minimum abbreviation (core.abbrev)
});

test("Sha: rejects empty, non-hex, and below-minimum input", () => {
  assert.throws(() => Sha.of(""), /Sha/);
  assert.throws(() => Sha.of("xyz1234"), /Sha/);     // non-hex characters
  assert.throws(() => Sha.of("abc"), /Sha/);          // 3 — below git's 4-char minimum
});

test("Sha: equals compares by value", () => {
  assert.equal(Sha.of("abc1234").equals(Sha.of("abc1234")), true);
  assert.equal(Sha.of("abc1234").equals(Sha.of("def5678")), false);
});

test("Sha: tryOf returns null instead of throwing on bad input", () => {
  assert.equal(Sha.tryOf("nope"), null);
  assert.equal(Sha.tryOf("abc1234")?.value, "abc1234");
});
