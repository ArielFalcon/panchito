import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRouteCatalog, buildTestIdIndex, degradedRouteWarning } from "./route-catalog";

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

// Slice 2 — capture confidence (status/settled) + loud degraded.
// buildRouteCatalog is the PURE adapter from the capture DTO (RouteSnapshot) to the gate-facing
// RouteCatalog. status/settled gate whether the future fail-closed path may trust the catalog: a
// capture error ⇒ "degraded"; absence of an explicit settle ⇒ settled:false (conservative — never
// fail-closed on an unknown). degradedRouteWarning surfaces real capture failures LOUDLY (CLAUDE.md:
// never swallow), replacing the silent `catch{return []}` reopen — unsettled is NOT warned per-route
// (expected on SPAs; it stays advisory in the catalog).

test("buildRouteCatalog maps a captured+settled snapshot to a trusted catalog", () => {
  const testIds = new Map([["save", 1]]);
  const cat = buildRouteCatalog({ route: "/login", nodes: ["button: Save"], settled: true, testIds });
  assert.equal(cat.route, "/login");
  assert.equal(cat.status, "captured");
  assert.equal(cat.settled, true);
  assert.equal(cat.testIds.get("save"), 1);
});

test("buildRouteCatalog marks a capture error as degraded (never trusted)", () => {
  const cat = buildRouteCatalog({ route: "/owners", error: "Timeout 15000ms exceeded" });
  assert.equal(cat.status, "degraded");
  assert.equal(cat.settled, false, "a degraded route is never settled");
  assert.equal(cat.testIds.size, 0, "no index from a failed capture");
});

test("buildRouteCatalog defaults settled to false when the capture did not confirm it", () => {
  // A snapshot that captured nodes but never resolved the secondary networkidle settle (late-hydration
  // SPA): present-but-unsettled ⇒ advisory, never fail-closed.
  const cat = buildRouteCatalog({ route: "/spa", nodes: ["link: Home"] });
  assert.equal(cat.status, "captured");
  assert.equal(cat.settled, false);
});

test("degradedRouteWarning lists the degraded routes loudly and is undefined when all captured", () => {
  const captured = buildRouteCatalog({ route: "/ok", nodes: ["x: y"], settled: true });
  const degraded = buildRouteCatalog({ route: "/broken", error: "net::ERR" });
  const warning = degradedRouteWarning([captured, degraded]);
  assert.ok(warning, "a degraded route must produce a warning");
  assert.match(warning, /WARNING/);
  assert.match(warning, /\/broken/);
  assert.doesNotMatch(warning, /\/ok/, "captured routes are not named in the degraded warning");
  assert.equal(degradedRouteWarning([captured]), undefined, "all-captured ⇒ no warning");
});
