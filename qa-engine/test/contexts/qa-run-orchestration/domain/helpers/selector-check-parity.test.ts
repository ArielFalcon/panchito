import { test } from "node:test";
import assert from "node:assert/strict";
// PARITY: the re-ported checkSpecSelectors (Task D.4's Lever-2 dependency, sub-decision 2) must
// match src/qa/selector-check.ts's CURRENT checkSpecSelectors exactly. Re-ported here (not reused
// from test-execution/domain/selector-check.service.ts) because that sibling copy has DRIFTED
// (missing the string-aware comment-strip + catalog-gate additions from recent Pillar-2 work) — this
// task re-ports from the TRUE current legacy source directly, scoped to ONLY checkSpecSelectors and
// its direct dependencies (the catalog-gate extractors are addendum G2's separate, out-of-scope
// concern). This file imports src/qa/selector-check.ts, so it is added to the qa-engine typecheck
// "exclude" list (same parity-import pattern as derive-cycle-backstop-parity.test.ts).
import {
  checkSpecSelectors,
  type ProposedSelector,
} from "@contexts/qa-run-orchestration/domain/helpers/selector-check.ts";
import { checkSpecSelectors as legacy } from "../../../../../../src/qa/selector-check.ts";

test("PARITY: checkSpecSelectors matches legacy — present + unique selector", () => {
  const specs = [`await page.getByRole("button", { name: "Add Owner" }).click();`];
  const trees = [["button: Add Owner", "textbox: Name"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), legacy(specs, trees));
});

test("PARITY: checkSpecSelectors matches legacy — verifiable-absent selector", () => {
  const specs = [`await page.getByRole("button", { name: "Submit" }).click();`];
  const trees = [["button: Cancel", "textbox: Name"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), legacy(specs, trees));
});

test("PARITY: checkSpecSelectors matches legacy — MULTIPLE-node strict-mode ambiguity", () => {
  const specs = [`await page.getByRole("textbox", { name: "Owner name" }).fill("x");`];
  const trees = [["textbox: Owner name", "textbox: Owner name"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), legacy(specs, trees));
});

test("PARITY: checkSpecSelectors matches legacy — unverifiable (role never seen with a real name)", () => {
  const specs = [`await page.getByRole("button", { name: "Ghost" }).click();`];
  const trees = [["textbox: Name"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), legacy(specs, trees));
});

test("PARITY: checkSpecSelectors matches legacy — non-extractable locator flags anyNonExtractable", () => {
  const specs = [`await page.getByTestId("submit-btn").click();`];
  const trees = [["button: Submit"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), legacy(specs, trees));
});

test("PARITY: checkSpecSelectors matches legacy — per-tree (never fused): present on tree A, absent on tree B is NOT absent", () => {
  const specs = [`await page.getByRole("button", { name: "Checkout" }).click();`];
  const trees = [["button: Checkout"], ["textbox: Search"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), legacy(specs, trees));
});

test("PARITY: checkSpecSelectors matches legacy — a commented-out selector is not extracted (W5)", () => {
  const specs = [
    `// await page.getByRole("button", { name: "Ghost" }).click();\nawait page.getByRole("button", { name: "Real" }).click();`,
  ];
  const trees = [["button: Real"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), legacy(specs, trees));
});

test("PARITY: checkSpecSelectors matches legacy — a URL inside a string is not mistaken for a comment (string-aware strip)", () => {
  const specs = [`await page.goto("https://example.com/checkout"); // comment\nawait page.getByRole("button", { name: "Pay" }).click();`];
  const trees = [["button: Pay"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), legacy(specs, trees));
});

test("PARITY: checkSpecSelectors matches legacy — empty trees yields empty findings (safe no-op)", () => {
  const specs = [`await page.getByRole("button", { name: "Submit" }).click();`];
  const trees: string[][] = [];
  assert.deepEqual(checkSpecSelectors(specs, trees), legacy(specs, trees));
});

test("PARITY: checkSpecSelectors matches legacy — custom treeLabel threads into the absent message", () => {
  const specs = [`await page.getByRole("button", { name: "Submit" }).click();`];
  const trees = [["button: Cancel"]];
  assert.deepEqual(checkSpecSelectors(specs, trees, "pre-write"), legacy(specs, trees, "pre-write"));
});

test("PARITY: checkSpecSelectors matches legacy — (present) structural marker never name-matches (W2)", () => {
  const specs = [`await page.getByRole("row", { name: "Present" }).click();`];
  const trees = [["row: (present)"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), legacy(specs, trees));
});

test("PARITY: checkSpecSelectors matches legacy — getByText and getByLabel kinds", () => {
  const specs = [
    `await page.getByText("Welcome back").click(); await page.getByLabel("Email").fill("x@example.com");`,
  ];
  const trees = [["text: Welcome back", "textbox: Email"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), legacy(specs, trees));
});

test("PARITY: checkSpecSelectors matches legacy — multiple spec sources aggregate findings", () => {
  const specs = [
    `await page.getByRole("button", { name: "Save" }).click();`,
    `await page.getByRole("button", { name: "Delete" }).click();`,
  ];
  const trees = [["button: Save"]];
  assert.deepEqual(checkSpecSelectors(specs, trees), legacy(specs, trees));
});

test("PARITY: ProposedSelector shape round-trips through both copies identically (structural sanity)", () => {
  const sel: ProposedSelector = { kind: "role", role: "button", name: "Submit", exact: true };
  assert.deepEqual(sel, { kind: "role", role: "button", name: "Submit", exact: true });
});
