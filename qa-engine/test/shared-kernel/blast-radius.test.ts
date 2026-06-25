import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";

test("BlastRadius: groups changed files under a Sha and is immutable", () => {
  const br = BlastRadius.of(Sha.of("abc1234"), ["src/a.ts", "src/b.ts"]);
  assert.equal(br.sha.value, "abc1234");
  assert.deepEqual(br.changedFiles, ["src/a.ts", "src/b.ts"]);
  assert.equal(br.isEmpty, false);
  assert.throws(() => { (br.changedFiles as string[]).push("x"); }); // frozen
});

test("BlastRadius: dedupes and sorts changed files for a deterministic identity", () => {
  const br = BlastRadius.of(Sha.of("abc1234"), ["src/b.ts", "src/a.ts", "src/b.ts"]);
  assert.deepEqual(br.changedFiles, ["src/a.ts", "src/b.ts"]);
});

test("BlastRadius: empty changed-file set is reported as empty", () => {
  assert.equal(BlastRadius.of(Sha.of("abc1234"), []).isEmpty, true);
});
