// Parity test: assert the ported qa-engine catalogGate matches the legacy src/qa/catalog-gate.ts
// byte-for-byte (Pillar 2 slice 4 — the anti-hallucination test-id gate). This file imports from src/
// (outside qa-engine rootDir) and is excluded from qa-engine typecheck (see qa-engine/tsconfig.json
// exclude list) — identical pattern to route-catalog-parity.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";

import { catalogGate as ported } from "@contexts/generation/infrastructure/catalog-gate.ts";
import type { RouteCatalog } from "@contexts/generation/infrastructure/route-catalog.ts";
import { catalogGate as legacy } from "../../../../../src/qa/catalog-gate.ts";
import type { RouteCatalog as LegacyRouteCatalog } from "../../../../../src/qa/route-catalog.ts";

function cat(over: Partial<RouteCatalog>): RouteCatalog {
  return { route: "/login", status: "captured", settled: true, testIds: new Map(), ...over };
}

function legacyCat(over: Partial<LegacyRouteCatalog>): LegacyRouteCatalog {
  return { route: "/login", status: "captured", settled: true, testIds: new Map(), ...over };
}

test("PARITY: catalogGate matches legacy — a fabricated test-id in the confident window is fail-closed", () => {
  const spec = `await page.goto("/login"); await page.getByTestId("ghost-btn").click();`;
  assert.deepEqual(
    ported(spec, cat({ testIds: new Map([["real-btn", 1]]) })),
    legacy(spec, legacyCat({ testIds: new Map([["real-btn", 1]]) })),
  );
});

test("PARITY: catalogGate matches legacy — a present test-id is not fail-closed", () => {
  const spec = `await page.goto("/login"); await page.getByTestId("real-btn").click();`;
  assert.deepEqual(
    ported(spec, cat({ testIds: new Map([["real-btn", 1]]) })),
    legacy(spec, legacyCat({ testIds: new Map([["real-btn", 1]]) })),
  );
});

test("PARITY: catalogGate matches legacy — settled===false is advisory", () => {
  const spec = `await page.goto("/spa"); await page.getByTestId("ghost").click();`;
  assert.deepEqual(
    ported(spec, cat({ route: "/spa", settled: false })),
    legacy(spec, legacyCat({ route: "/spa", settled: false })),
  );
});

test("PARITY: catalogGate matches legacy — a degraded catalog is advisory", () => {
  const spec = `await page.goto("/x"); await page.getByTestId("ghost").click();`;
  assert.deepEqual(
    ported(spec, cat({ route: "/x", status: "degraded", settled: false })),
    legacy(spec, legacyCat({ route: "/x", status: "degraded", settled: false })),
  );
});

test("PARITY: catalogGate matches legacy — a post-navigation test-id is advisory", () => {
  const spec = [
    `await page.goto("/login");`,
    `await page.getByTestId("submit").click();`,
    `await page.getByTestId("only-on-next-page");`,
  ].join("\n");
  assert.deepEqual(
    ported(spec, cat({ testIds: new Map([["submit", 1]]) })),
    legacy(spec, legacyCat({ testIds: new Map([["submit", 1]]) })),
  );
});

test("PARITY: catalogGate matches legacy — no test-ids yields an identical empty result", () => {
  const spec = `await page.goto("/x"); await page.getByRole("button", { name: "Save" }).click();`;
  assert.deepEqual(ported(spec, cat({})), legacy(spec, legacyCat({})));
});
