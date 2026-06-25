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

test("Sha: accepts an abbreviated hex sha (>= 7 chars)", () => {
  assert.equal(Sha.of("abc1234").value, "abc1234");
});

test("Sha: rejects empty, non-hex, and too-short input", () => {
  assert.throws(() => Sha.of(""), /Sha/);
  assert.throws(() => Sha.of("xyz1234"), /Sha/);
  assert.throws(() => Sha.of("abc"), /Sha/); // < 7
});

test("Sha: equals compares by value", () => {
  assert.equal(Sha.of("abc1234").equals(Sha.of("abc1234")), true);
  assert.equal(Sha.of("abc1234").equals(Sha.of("def5678")), false);
});

test("Sha: tryOf returns null instead of throwing on bad input", () => {
  assert.equal(Sha.tryOf("nope"), null);
  assert.equal(Sha.tryOf("abc1234")?.value, "abc1234");
});
