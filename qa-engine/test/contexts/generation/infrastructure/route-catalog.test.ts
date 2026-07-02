import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRouteCatalog, buildTestIdIndex, degradedRouteWarning } from "@contexts/generation/infrastructure/route-catalog.ts";

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

// ── Fix 2 (audit leak 5): degrade on classified runtimeErrors, zero nodes, or a redirect ──
// A route can render "successfully" (no capture `error`) yet still be UNTRUSTWORTHY grounding: a
// broken client-side render throws a pageerror / logs a framework error, the page ends up with zero
// interactive nodes, or the app silently redirected (e.g. bounced to a login page). All three must
// degrade the SAME way a capture `error` does — never fail-closed-block (that invariant belongs to
// catalog-gate.ts and is NOT touched here), only lose trust.

test("buildRouteCatalog degrades a route with a pageerror runtime signal (always a strong signal)", () => {
  const cat = buildRouteCatalog({
    route: "/owners/new",
    nodes: ["button: Submit"],
    settled: true,
    runtimeErrors: [{ type: "pageerror", text: "TypeError: Cannot read properties of undefined" }],
  });
  assert.equal(cat.status, "degraded", "an uncaught pageerror must degrade the route");
});

test("buildRouteCatalog degrades a route whose console errors match FRAMEWORK_ERROR_RE (NG#### / ERROR Error: / Uncaught / Unhandled Promise rejection)", () => {
  const cases = ["NG0100: Expression changed", "ERROR Error: something broke", "Uncaught ReferenceError: x", "Unhandled Promise rejection: y"];
  for (const text of cases) {
    const cat = buildRouteCatalog({ route: "/x", nodes: ["button: y"], settled: true, runtimeErrors: [{ type: "console", text }] });
    assert.equal(cat.status, "degraded", `console text "${text}" must match FRAMEWORK_ERROR_RE and degrade`);
  }
});

test("buildRouteCatalog does NOT degrade on benign console noise (favicon / resource load / net::ERR_)", () => {
  const cases = ["Failed to load resource: the server responded with 404", "favicon.ico 404", "net::ERR_INTERNET_DISCONNECTED"];
  for (const text of cases) {
    const cat = buildRouteCatalog({ route: "/x", nodes: ["button: y"], settled: true, runtimeErrors: [{ type: "console", text }] });
    assert.equal(cat.status, "captured", `benign noise "${text}" must NOT degrade the route`);
  }
});

test("buildRouteCatalog does NOT degrade on a bare 'Error:' console message (deliberate — avoids false positives on handled/logged errors)", () => {
  const cat = buildRouteCatalog({ route: "/x", nodes: ["button: y"], settled: true, runtimeErrors: [{ type: "console", text: "Error: something was logged, not thrown" }] });
  assert.equal(cat.status, "captured", "a bare 'Error:' must not match the classifier (mirrors failure-adjudicator.ts)");
});

test("buildRouteCatalog degrades a route with zero captured nodes", () => {
  const cat = buildRouteCatalog({ route: "/blank", nodes: [], settled: true });
  assert.equal(cat.status, "degraded", "an empty nodes[] must degrade — likely a broken render");
});

test("buildRouteCatalog degrades a route with undefined nodes (never captured)", () => {
  const cat = buildRouteCatalog({ route: "/blank", settled: true });
  assert.equal(cat.status, "degraded");
});

test("buildRouteCatalog degrades a route whose finalUrl path diverges from the requested route (redirect)", () => {
  const cat = buildRouteCatalog({ route: "/owners/new", nodes: ["button: Login"], settled: true, finalUrl: "http://dev.example.com/login" });
  assert.equal(cat.status, "degraded", "a redirect away from the requested route must degrade — the captured DOM is not the requested page");
});

test("buildRouteCatalog does NOT degrade when finalUrl matches the requested route (same path, normalized leading slash)", () => {
  const cat = buildRouteCatalog({ route: "/owners/new", nodes: ["button: Submit"], settled: true, finalUrl: "http://dev.example.com/owners/new" });
  assert.equal(cat.status, "captured");
});

test("buildRouteCatalog does NOT degrade a hash-routed SPA route (the route lives in the fragment, not the URL path)", () => {
  // AngularJS-style hash router (e.g. PetClinic "/#!/owners/new"): the requested route's URL pathname
  // is "/" and so is the finalUrl's — comparing the RAW route string against finalUrl.pathname would
  // falsely degrade EVERY hash route. Redirect detection must compare parsed pathnames only.
  const cat = buildRouteCatalog({ route: "/#!/owners/new", nodes: ["button: Submit"], settled: true, finalUrl: "http://dev.example.com/#!/owners/new" });
  assert.equal(cat.status, "captured", "a hash route whose finalUrl carries the same fragment must NOT be treated as a redirect");
});

test("buildRouteCatalog does NOT degrade a route carrying a query string (query is not a path divergence)", () => {
  const cat = buildRouteCatalog({ route: "/owners?page=2", nodes: ["button: Next"], settled: true, finalUrl: "http://dev.example.com/owners?page=2" });
  assert.equal(cat.status, "captured", "the ?query must be excluded from the pathname comparison");
});

test("buildRouteCatalog does NOT degrade on a trailing-slash normalization by the server (/owners → /owners/)", () => {
  const cat = buildRouteCatalog({ route: "/owners", nodes: ["button: Add"], settled: true, finalUrl: "http://dev.example.com/owners/" });
  assert.equal(cat.status, "captured", "a trailing-slash-only difference is not a redirect away from the route");
});

test("buildRouteCatalog is byte-identical to today's behavior when runtimeErrors/finalUrl are absent (parity guard)", () => {
  const cat = buildRouteCatalog({ route: "/login", nodes: ["button: Save"], settled: true, testIds: new Map([["save", 1]]) });
  assert.equal(cat.status, "captured");
  assert.equal(cat.settled, true);
});
