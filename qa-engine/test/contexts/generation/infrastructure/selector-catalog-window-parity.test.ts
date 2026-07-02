// Parity test: assert the ported qa-engine catalog-window functions match the legacy
// src/qa/selector-check.ts's confidentWindowEnd + extractTestIdSelectorsWithIndex byte-for-byte. This
// file imports from src/ (outside qa-engine rootDir) and is excluded from qa-engine typecheck (see
// qa-engine/tsconfig.json exclude list) — identical pattern to route-catalog-parity.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";

import { confidentWindowEnd as ported, extractTestIdSelectorsWithIndex as portedExtract } from "@contexts/generation/infrastructure/selector-catalog-window.ts";
import { confidentWindowEnd as legacy, extractTestIdSelectorsWithIndex as legacyExtract } from "../../../../../src/qa/selector-check.ts";

test("PARITY: confidentWindowEnd matches legacy — closes on first click", () => {
  const spec = `await page.goto("/login"); await page.getByTestId("submit").click();`;
  assert.equal(ported(spec), legacy(spec));
});

test("PARITY: confidentWindowEnd matches legacy — Infinity when nothing closes it", () => {
  const spec = `await page.goto("/login"); await expect(page.getByTestId("welcome")).toBeVisible();`;
  assert.equal(ported(spec), legacy(spec));
});

test("PARITY: confidentWindowEnd matches legacy — closes on the SECOND goto", () => {
  const spec = `await page.goto("/login"); await page.goto("/dashboard"); await page.getByTestId("x").click();`;
  assert.equal(ported(spec), legacy(spec));
});

test("PARITY: confidentWindowEnd matches legacy — fill/press do not close the window", () => {
  const spec = `await page.goto("/login"); await page.getByTestId("email").fill("x"); await page.getByTestId("pw").press("a"); await page.getByTestId("after").click();`;
  assert.equal(ported(spec), legacy(spec));
});

test("PARITY: confidentWindowEnd matches legacy — dblclick and tap close the window too", () => {
  const dbl = `await page.goto("/x"); await page.getByTestId("a").dblclick(); await page.getByTestId("b");`;
  const tap = `await page.goto("/x"); await page.getByTestId("a").tap(); await page.getByTestId("b");`;
  assert.equal(ported(dbl), legacy(dbl));
  assert.equal(ported(tap), legacy(tap));
});

test("PARITY: extractTestIdSelectorsWithIndex matches legacy — multiple calls in source order", () => {
  const spec = `await page.getByTestId("first").click(); await page.getByTestId("second").fill("x");`;
  assert.deepEqual(portedExtract(spec), legacyExtract(spec));
});

test("PARITY: extractTestIdSelectorsWithIndex matches legacy — drops interpolated values", () => {
  const spec = "await page.getByTestId(`item-${id}`).click();";
  assert.deepEqual(portedExtract(spec), legacyExtract(spec));
});

test("PARITY: extractTestIdSelectorsWithIndex matches legacy — a commented-out call is not extracted (W5)", () => {
  const spec = `// await page.getByTestId("ghost").click();\nawait page.getByTestId("real").click();`;
  assert.deepEqual(portedExtract(spec), legacyExtract(spec));
});

test("PARITY: extractTestIdSelectorsWithIndex matches legacy — a URL inside a string is not mistaken for a comment", () => {
  const spec = `await page.goto("https://example.com/x"); // comment\nawait page.getByTestId("real").click();`;
  assert.deepEqual(portedExtract(spec), legacyExtract(spec));
});

test("PARITY: extractTestIdSelectorsWithIndex matches legacy — empty when no getByTestId calls exist", () => {
  const spec = `await page.getByRole("button", { name: "Save" }).click();`;
  assert.deepEqual(portedExtract(spec), legacyExtract(spec));
});
