import { test } from "node:test";
import assert from "node:assert/strict";

import { buildTestIdIndex } from "./route-catalog";

// Pillar 2 (selector grounding — docs/superpowers/selector-grounding-root-cause-and-design.md):
// the per-route Selector Catalog exposes a test-id index the verification gate can check getByTestId
// against — the family that was NON_EXTRACTABLE and so caught only by a 30s timeout. The index is built
// from a ROLE-INDEPENDENT capture (a `<div data-cy=x>` with no ARIA role must be included — the
// computedRole gate at dom-snapshot.ts:700 drops it today) and COUNTS occurrences (count>1 ⇒ a
// strict-mode ambiguity that would otherwise only surface at runtime).

test("buildTestIdIndex counts each captured test-id value (presence + uniqueness)", () => {
  const idx = buildTestIdIndex(["submit", "username", "submit"]);
  assert.equal(idx.get("submit"), 2, "a duplicate test-id → count 2 (pre-exec ambiguity signal)");
  assert.equal(idx.get("username"), 1);
  assert.equal(idx.has("never-captured"), false, "a value never captured is absent");
});

test("buildTestIdIndex is empty when no test-ids were captured", () => {
  assert.equal(buildTestIdIndex([]).size, 0);
});

test("buildTestIdIndex ignores blank / whitespace-only values", () => {
  const idx = buildTestIdIndex(["", "   ", "ok"]);
  assert.equal(idx.size, 1);
  assert.equal(idx.get("ok"), 1);
});
