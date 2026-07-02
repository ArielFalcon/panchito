import { test } from "node:test";
import assert from "node:assert/strict";

import { confidentWindowEnd, extractTestIdSelectorsWithIndex } from "@contexts/generation/infrastructure/selector-catalog-window.ts";

// Pillar 2 slice 4 dependency surface: the catalog gate's confident window (lexically before the first
// click/tap or the second goto — where the initial-route catalog is still the live DOM) and the
// getByTestId extraction WITH source index (so the gate can tell which selectors fall inside it).

test("confidentWindowEnd returns the index of the first click", () => {
  const spec = `await page.goto("/login"); await page.getByTestId("submit").click();`;
  const end = confidentWindowEnd(spec);
  assert.ok(end > 0 && end < spec.length, "window closes at a real position before end of source");
});

test("confidentWindowEnd is Infinity when nothing closes the window (no click, no second goto)", () => {
  const spec = `await page.goto("/login"); await expect(page.getByTestId("welcome")).toBeVisible();`;
  assert.equal(confidentWindowEnd(spec), Infinity);
});

test("confidentWindowEnd closes on the SECOND goto, not the first", () => {
  const spec = `await page.goto("/login"); await page.goto("/dashboard"); await page.getByTestId("x").click();`;
  const firstGotoIdx = spec.indexOf(".goto(");
  const secondGotoIdx = spec.indexOf(".goto(", firstGotoIdx + 1);
  const end = confidentWindowEnd(spec);
  assert.ok(end > firstGotoIdx, "window does not close on the first goto");
  assert.ok(end <= secondGotoIdx + 20, "window closes at or near the second goto");
});

test("confidentWindowEnd does NOT close on fill/type/press/hover/check/selectOption (non-navigating actions)", () => {
  const spec = `await page.goto("/login"); await page.getByTestId("email").fill("x"); await page.getByTestId("pw").press("a"); await page.getByTestId("after").click();`;
  const clickIdx = spec.indexOf(".click(");
  const end = confidentWindowEnd(spec);
  assert.ok(end <= clickIdx + 10, "fill/press do not close the window; only the click does");
});

test("confidentWindowEnd closes on dblclick and tap (click variants)", () => {
  const dbl = `await page.goto("/x"); await page.getByTestId("a").dblclick(); await page.getByTestId("b");`;
  const tap = `await page.goto("/x"); await page.getByTestId("a").tap(); await page.getByTestId("b");`;
  assert.ok(confidentWindowEnd(dbl) < Infinity);
  assert.ok(confidentWindowEnd(tap) < Infinity);
});

test("extractTestIdSelectorsWithIndex returns value + index for each getByTestId call, in source order", () => {
  const spec = `await page.getByTestId("first").click(); await page.getByTestId("second").fill("x");`;
  const found = extractTestIdSelectorsWithIndex(spec);
  assert.equal(found.length, 2);
  assert.equal(found[0]!.value, "first");
  assert.equal(found[1]!.value, "second");
  assert.ok(found[0]!.index < found[1]!.index, "indices are in source order");
});

test("extractTestIdSelectorsWithIndex drops interpolated (computed) values", () => {
  const spec = "await page.getByTestId(`item-${id}`).click();";
  assert.deepEqual(extractTestIdSelectorsWithIndex(spec), []);
});

test("extractTestIdSelectorsWithIndex ignores a commented-out getByTestId (W5 parity)", () => {
  const spec = `// await page.getByTestId("ghost").click();\nawait page.getByTestId("real").click();`;
  const found = extractTestIdSelectorsWithIndex(spec);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.value, "real");
});

test("extractTestIdSelectorsWithIndex returns empty array when no getByTestId calls exist", () => {
  const spec = `await page.getByRole("button", { name: "Save" }).click();`;
  assert.deepEqual(extractTestIdSelectorsWithIndex(spec), []);
});

test("extractTestIdSelectorsWithIndex — a URL inside a string is not mistaken for a comment (string-aware strip)", () => {
  const spec = `await page.goto("https://example.com/x"); // comment\nawait page.getByTestId("real").click();`;
  const found = extractTestIdSelectorsWithIndex(spec);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.value, "real");
});
