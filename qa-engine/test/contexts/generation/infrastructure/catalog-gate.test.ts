import { test } from "node:test";
import assert from "node:assert/strict";

import { catalogGate } from "@contexts/generation/infrastructure/catalog-gate.ts";
import type { RouteCatalog } from "@contexts/generation/infrastructure/route-catalog.ts";

// Pillar 2 slice 4 (docs/superpowers/selector-grounding-root-cause-and-design.md): the confidence-aware
// gate fail-closes on a fabricated test-id BEFORE execution (cheap regeneration, not a 30s timeout) —
// but ONLY inside the confident window (captured && settled route, pre-first-navigation). Everywhere
// else it is advisory and the runtime executor is the backstop. It must NEVER turn a valid spec invalid.

function cat(over: Partial<RouteCatalog>): RouteCatalog {
  return { route: "/login", status: "captured", settled: true, testIds: new Map(), ...over };
}

test("catalogGate: a fabricated test-id in the confident window (captured&&settled) is fail-closed", () => {
  const spec = `await page.goto("/login"); await page.getByTestId("ghost-btn").click();`;
  const r = catalogGate(spec, cat({ testIds: new Map([["real-btn", 1]]) }));
  assert.deepEqual(r.failClosed, ["ghost-btn"], "absent test-id in the window → regenerate, not a 30s timeout");
});

test("catalogGate: a present test-id is not fail-closed and counts toward inWindow", () => {
  const spec = `await page.goto("/login"); await page.getByTestId("real-btn").click();`;
  const r = catalogGate(spec, cat({ testIds: new Map([["real-btn", 1]]) }));
  assert.deepEqual(r.failClosed, []);
  assert.equal(r.inWindow, 1);
});

test("catalogGate: settled===false → advisory, never fail-closed (safe direction)", () => {
  const spec = `await page.goto("/spa"); await page.getByTestId("ghost").click();`;
  const r = catalogGate(spec, cat({ route: "/spa", settled: false }));
  assert.deepEqual(r.failClosed, [], "an unsettled catalog is untrusted → no fail-closed");
  assert.equal(r.advisory, 1);
});

test("catalogGate: a degraded catalog → advisory, never fail-closed", () => {
  const spec = `await page.goto("/x"); await page.getByTestId("ghost").click();`;
  const r = catalogGate(spec, cat({ route: "/x", status: "degraded", settled: false }));
  assert.deepEqual(r.failClosed, []);
  assert.equal(r.advisory, 1);
});

test("catalogGate: a post-navigation test-id is advisory even if absent (no false block)", () => {
  const spec = [
    `await page.goto("/login");`,
    `await page.getByTestId("submit").click();`, // closes the window
    `await page.getByTestId("only-on-next-page");`, // absent from /login but its page is not this catalog
  ].join("\n");
  const r = catalogGate(spec, cat({ testIds: new Map([["submit", 1]]) }));
  assert.deepEqual(r.failClosed, [], "a post-click absent selector is NOT fail-closed");
  assert.equal(r.inWindow, 1, "only the pre-click submit is in the window");
  assert.equal(r.advisory, 1, "the post-nav selector is advisory");
});

test("catalogGate: no test-ids → empty result (never throws)", () => {
  const r = catalogGate(`await page.goto("/x"); await page.getByRole("button", { name: "Save" }).click();`, cat({}));
  assert.deepEqual(r, { failClosed: [], inWindow: 0, advisory: 0 });
});
