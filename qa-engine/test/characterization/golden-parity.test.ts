import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runOutcomeEquivalent, type ComparableOutcome } from "./equivalence.ts";

// Each committed golden must round-trip through the comparator against itself (sanity: the
// comparator accepts real captured shapes). Plan 6 extends this file to compare the REWRITTEN
// engine's output for the same scenario against the golden.
const dir = join(import.meta.dirname, "goldens");

test("goldens: all 10 canonical scenarios are captured", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 10, `expected 10 goldens, found ${files.length}`);
});

for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  test(`golden ${file}: round-trips through the equivalence comparator`, () => {
    const golden = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const asComparable: ComparableOutcome = { runId: "x", at: "y", ...golden };
    assert.equal(runOutcomeEquivalent(asComparable, asComparable).equal, true);
  });
}
