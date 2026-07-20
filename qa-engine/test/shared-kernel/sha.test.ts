// qa-engine/test/shared-kernel/sha.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha, shaMatches } from "@kernel/sha.ts";

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

// shaMatches: relocated verbatim from src/env/deploy-gate.ts (migration-tier-3, Decision 2).
// Raw string-in signature preserved on purpose — callers pass untrusted/possibly-short strings
// (e.g. v?.sha from a version poll), which a Sha-typed method would force through validation
// that changes behavior.
const FULL = "abc1234def5678abc1234def5678abc1234def56"; // 40-char SHA
const SHORT = "abc1234"; // the 7-char short form many /version endpoints emit

test("shaMatches: equal, and short-vs-full prefix either way (case-insensitive)", () => {
  assert.equal(shaMatches(FULL, FULL), true);
  assert.equal(shaMatches(SHORT, FULL), true); // /version short vs full trigger
  assert.equal(shaMatches(FULL, SHORT), true); // full /version vs short trigger
  assert.equal(shaMatches(FULL.toUpperCase(), SHORT), true);
});

test("shaMatches: different SHAs and too-short prefixes never match", () => {
  assert.equal(shaMatches("def5678abc", FULL), false); // different
  assert.equal(shaMatches("abc", FULL), false); // 3-char prefix is below the 7-char floor
  assert.equal(shaMatches("", FULL), false);
  assert.equal(shaMatches(undefined, FULL), false);
});
