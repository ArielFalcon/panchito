// Parity test: assert the ported qa-engine route-catalog functions match the legacy src/qa/
// route-catalog.ts byte-for-byte. This file imports from src/ (outside qa-engine rootDir) and is
// excluded from qa-engine typecheck (see qa-engine/tsconfig.json exclude list) — identical pattern to
// symbols-parity.test.ts (Plan 7.3). Runs via tsx at runtime; the strangler guard keeping the port
// honest until Plan 7 cutover deletes the legacy original (Plan 7.4a).
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRouteCatalog as ported, buildTestIdIndex as portedIndex, degradedRouteWarning as portedWarning } from "@contexts/generation/infrastructure/route-catalog.ts";
import { buildRouteCatalog as legacy, buildTestIdIndex as legacyIndex, degradedRouteWarning as legacyWarning } from "../../../../../src/qa/route-catalog.ts";

test("PARITY: buildTestIdIndex matches legacy byte-for-byte on a representative capture", () => {
  const values = ["submit", "username", "submit", "", "   ", "unique-id"];
  assert.deepEqual(portedIndex(values), legacyIndex(values));
});

test("PARITY: buildRouteCatalog matches legacy on a captured+settled snapshot", () => {
  const snapshot = { route: "/login", nodes: ["button: Save"], settled: true, testIds: new Map([["save", 1]]) };
  assert.deepEqual(ported(snapshot), legacy(snapshot));
});

test("PARITY: buildRouteCatalog matches legacy on a degraded (errored) snapshot", () => {
  const snapshot = { route: "/owners", error: "Timeout 15000ms exceeded" };
  assert.deepEqual(ported(snapshot), legacy(snapshot));
});

test("PARITY: buildRouteCatalog matches legacy when settled is unconfirmed (conservative default)", () => {
  const snapshot = { route: "/spa", nodes: ["link: Home"] };
  assert.deepEqual(ported(snapshot), legacy(snapshot));
});

test("PARITY: degradedRouteWarning matches legacy wording and route naming", () => {
  const captured = ported({ route: "/ok", nodes: ["x: y"], settled: true });
  const degraded = ported({ route: "/broken", error: "net::ERR" });
  assert.equal(portedWarning([captured, degraded]), legacyWarning([captured, degraded]));
  assert.equal(portedWarning([captured]), legacyWarning([captured]));
});
