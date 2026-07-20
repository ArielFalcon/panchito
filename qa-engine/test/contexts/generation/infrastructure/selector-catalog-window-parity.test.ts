// Parity test (FIXTURE-SNAPSHOT, migration-wiring-phase-2 Slice 8b-4): pins the ported qa-engine
// catalog-window functions against src/qa/selector-check.ts's confidentWindowEnd +
// extractTestIdSelectorsWithIndex. That legacy module was deleted (this was a THIRD pin the
// deletion design missed alongside qa-run-orchestration/domain/helpers/selector-check-parity.test.ts
// and execute.test.ts's selectorPresent import — recorded as a load-bearing correction). Expected
// values were captured by running the legacy module directly against these exact samples before
// deletion. This file no longer imports src/, so it was removed from qa-engine/tsconfig.json's
// "exclude" list and qa-engine/tsconfig.parity.json's "include" list in the same commit.
import { test } from "node:test";
import assert from "node:assert/strict";

import { confidentWindowEnd as ported, extractTestIdSelectorsWithIndex as portedExtract } from "@contexts/generation/infrastructure/selector-catalog-window.ts";

test("PARITY: confidentWindowEnd matches legacy — closes on first click", () => {
  const spec = `await page.goto("/login"); await page.getByTestId("submit").click();`;
  assert.equal(ported(spec), 59);
});

test("PARITY: confidentWindowEnd matches legacy — Infinity when nothing closes it", () => {
  const spec = `await page.goto("/login"); await expect(page.getByTestId("welcome")).toBeVisible();`;
  assert.equal(ported(spec), Infinity);
});

test("PARITY: confidentWindowEnd matches legacy — closes on the SECOND goto", () => {
  const spec = `await page.goto("/login"); await page.goto("/dashboard"); await page.getByTestId("x").click();`;
  assert.equal(ported(spec), 37);
});

test("PARITY: confidentWindowEnd matches legacy — fill/press do not close the window", () => {
  const spec = `await page.goto("/login"); await page.getByTestId("email").fill("x"); await page.getByTestId("pw").press("a"); await page.getByTestId("after").click();`;
  assert.equal(ported(spec), 142);
});

test("PARITY: confidentWindowEnd matches legacy — dblclick and tap close the window too", () => {
  const dbl = `await page.goto("/x"); await page.getByTestId("a").dblclick(); await page.getByTestId("b");`;
  const tap = `await page.goto("/x"); await page.getByTestId("a").tap(); await page.getByTestId("b");`;
  assert.equal(ported(dbl), 50);
  assert.equal(ported(tap), 50);
});

test("PARITY: extractTestIdSelectorsWithIndex matches legacy — multiple calls in source order", () => {
  const spec = `await page.getByTestId("first").click(); await page.getByTestId("second").fill("x");`;
  assert.deepEqual(portedExtract(spec), [{ value: "first", index: 10 }, { value: "second", index: 51 }]);
});

test("PARITY: extractTestIdSelectorsWithIndex matches legacy — drops interpolated values", () => {
  const spec = "await page.getByTestId(`item-${id}`).click();";
  assert.deepEqual(portedExtract(spec), []);
});

test("PARITY: extractTestIdSelectorsWithIndex matches legacy — a commented-out call is not extracted (W5)", () => {
  const spec = `// await page.getByTestId("ghost").click();\nawait page.getByTestId("real").click();`;
  assert.deepEqual(portedExtract(spec), [{ value: "real", index: 10 }]);
});

test("PARITY: extractTestIdSelectorsWithIndex matches legacy — a URL inside a string is not mistaken for a comment", () => {
  const spec = `await page.goto("https://example.com/x"); // comment\nawait page.getByTestId("real").click();`;
  assert.deepEqual(portedExtract(spec), [{ value: "real", index: 54 }]);
});

test("PARITY: extractTestIdSelectorsWithIndex matches legacy — empty when no getByTestId calls exist", () => {
  const spec = `await page.getByRole("button", { name: "Save" }).click();`;
  assert.deepEqual(portedExtract(spec), []);
});
