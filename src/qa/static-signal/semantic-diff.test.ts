import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDifftJson } from "./semantic-diff";

const fx = (n: string) => readFileSync(join(import.meta.dirname, "__fixtures__", n), "utf8");

// difft 0.69.0 (with DFT_UNSTABLE=yes) emits NDJSON where each line is a JSON object
// with a `status` field: "unchanged" when the diff is purely cosmetic (whitespace/comment),
// "changed" when there is a real semantic difference. A cosmetic-only file therefore
// produces a line with status:"unchanged" — cosmetic:true. A real change produces
// status:"changed" — cosmetic:false.

test("parseDifftJson marks a whitespace-only change cosmetic", () => {
  const kinds = parseDifftJson(fx("difft-cosmetic.json"));
  // The fixture contains a single NDJSON line with status:"unchanged".
  // parseDifftJson must return at least one entry, and all entries for this
  // unchanged file should be marked cosmetic.
  assert.ok(kinds.length > 0, "expected at least one FileChangeKind entry");
  assert.equal(kinds.some((k) => k.cosmetic), true);
});

test("parseDifftJson marks a value change non-cosmetic", () => {
  const kinds = parseDifftJson(fx("difft-real.json"));
  assert.ok(kinds.length > 0, "expected at least one FileChangeKind entry");
  assert.equal(kinds.every((k) => !k.cosmetic), true);
});
