// PARITY vs src/qa/selector-check.ts (HEAD). Excluded from qa-engine typecheck; runs via tsx.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SelectorCheckService } from "@contexts/test-execution/domain/selector-check.service.ts";
import { checkSpecSelectors, unscopedMultipleContradictions } from "../../../../../src/qa/selector-check.ts";

const svc = new SelectorCheckService();
const DOM_TREE = ["button: Submit", "button: Buy now", "textbox: Email"];
const fixtures: Array<{ srcs: string[]; trees: string[][] }> = [
  { srcs: [`page.getByRole("button", { name: "Submit" }).click()`], trees: [DOM_TREE] },
  { srcs: [`page.getByRole("button", { name: "Missing" }).click()`], trees: [DOM_TREE] },
  { srcs: [`page.getByTestId("id")`], trees: [DOM_TREE] },
  { srcs: [], trees: [DOM_TREE] },
  { srcs: [`page.getByRole("button").click()`], trees: [["button: A", "button: B"]] },
  // ARIA-state-suffix: parseLine must strip the [disabled] token so role/name still match — pins the
  // user's ARIA_STATE_STRIP_RE behavior (a stale copy would treat the suffix as part of the name).
  { srcs: [`page.getByRole("button", { name: "Submit" }).click()`], trees: [["button: Submit [disabled]"]] },
  // page-rooted MULTIPLE next to a non-extractable locator: exercises unscopedMultipleContradictions'
  // suppression path (anyNonExtractable=true ⇒ only the page-rooted MULTIPLE survives).
  { srcs: [`page.getByRole("button").click(); page.getByTestId("x").click()`], trees: [["button: A", "button: B"]] },
];

test("PARITY: SelectorCheckService.check matches checkSpecSelectors across the fixture table", () => {
  for (const { srcs, trees } of fixtures) {
    const legacy = checkSpecSelectors(srcs, trees);
    const svcResult = svc.check(srcs, trees);
    // deepEqual compares contradictions[], absentKeys (Set→Array), booleans
    assert.deepEqual(
      { ...svcResult, absentKeys: [...svcResult.absentKeys].sort() },
      { ...legacy, absentKeys: [...legacy.absentKeys].sort() },
      JSON.stringify({ srcs, treeLen: trees[0]?.length }),
    );
  }
});

test("PARITY: SelectorCheckService.unscopedMultiple matches unscopedMultipleContradictions", () => {
  for (const { srcs, trees } of fixtures) {
    assert.deepEqual(
      svc.unscopedMultiple(srcs, trees, "pre-write"),
      unscopedMultipleContradictions(srcs, trees, "pre-write"),
      JSON.stringify({ srcs, treeLen: trees[0]?.length }),
    );
  }
});
