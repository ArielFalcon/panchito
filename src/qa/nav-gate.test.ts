import { test } from "node:test";
import assert from "node:assert/strict";
import { decideNav, normalizeRoute, routesMatch } from "./nav-gate";

// The deterministic navigation gate (precise): on a re-generation turn the agent may NOT navigate a
// route the injected grounding already covers (it must transcribe instead), but MAY navigate an
// uncovered route (the anti-blinding escape). It FAILS OPEN — anything unparseable or uncertain is
// allowed, because wrongly blocking a navigation blinds the agent (worse than wasted exploration).

// ── normalizeRoute (hash-route aware) ─────────────────────────────────────────
test("nav-gate normalizeRoute: hash-routed SPA URL → the route path", () => {
  assert.equal(normalizeRoute("http://host.docker.internal:8080/#!/owners/new"), "/owners/new");
});

test("nav-gate normalizeRoute: plain path URL strips origin, query and trailing slash", () => {
  assert.equal(normalizeRoute("http://host:8080/owners/new/?x=1"), "/owners/new");
});

test("nav-gate normalizeRoute: a relative hash route", () => {
  assert.equal(normalizeRoute("/#!/owners/details/8"), "/owners/details/8");
});

test("nav-gate normalizeRoute: strips a trailing UI fragment after the hash route", () => {
  assert.equal(normalizeRoute("http://host/#!/owners/details/8#tab=visits"), "/owners/details/8");
});

test("nav-gate normalizeRoute: strips a query INSIDE the hash route", () => {
  assert.equal(normalizeRoute("/#!/owners/new?page=2"), "/owners/new");
});

test("nav-gate normalizeRoute: single hash (no bang) still yields the route", () => {
  assert.equal(normalizeRoute("http://host/#/owners"), "/owners");
});

test("nav-gate normalizeRoute: root URL → /", () => {
  assert.equal(normalizeRoute("http://host:8080/"), "/");
});

test("nav-gate normalizeRoute: non-web schemes → null (not coerced into a path)", () => {
  assert.equal(normalizeRoute("javascript:alert(1)"), null);
  assert.equal(normalizeRoute("about:blank"), null);
});

test("nav-gate normalizeRoute: protocol-relative URL → null", () => {
  assert.equal(normalizeRoute("//host/owners/new"), null);
});

test("nav-gate normalizeRoute: empty/garbage/non-string → null (caller fails open)", () => {
  assert.equal(normalizeRoute(""), null);
  assert.equal(normalizeRoute("   "), null);
  assert.equal(normalizeRoute(undefined as unknown as string), null);
  assert.equal(normalizeRoute(123 as unknown as string), null);
});

// ── routesMatch (exact OR :param template — NO blind numeric collapse) ─────────
test("nav-gate routesMatch: a :param template matches a concrete id", () => {
  assert.equal(routesMatch("/owners/details/:id", "/owners/details/8"), true);
});

test("nav-gate routesMatch: two DIFFERENT concrete ids do NOT match (avoid blinding on a sibling)", () => {
  assert.equal(routesMatch("/owners/details/8", "/owners/details/12"), false);
});

test("nav-gate routesMatch: numeric LITERALS (year/page/month) are NOT wildcards — distinct → no match", () => {
  assert.equal(routesMatch("/reports/2024", "/reports/2025"), false);
  assert.equal(routesMatch("/owners/list/page/2", "/owners/list/page/3"), false);
});

test("nav-gate routesMatch: distinct routes do not match", () => {
  assert.equal(routesMatch("/owners/new", "/owners/edit"), false);
});

test("nav-gate routesMatch: different segment counts never match", () => {
  assert.equal(routesMatch("/owners/details/:id", "/owners/details/8/edit"), false);
});

// ── decideNav ─────────────────────────────────────────────────────────────────
test("nav-gate decideNav: a FIRST pass always allows navigation (exploration is expected)", () => {
  const d = decideNav({ isRegen: false, groundedRoutes: ["/owners/new"], requestedUrl: "http://h/#!/owners/new" });
  assert.equal(d.allow, true);
});

test("nav-gate decideNav: a regen BLOCKS a route the grounding already covers", () => {
  const d = decideNav({ isRegen: true, groundedRoutes: ["/#!/owners/new"], requestedUrl: "http://h:8080/#!/owners/new" });
  assert.equal(d.allow, false);
});

test("nav-gate decideNav: a regen ALLOWS an uncovered route (anti-blinding escape)", () => {
  const d = decideNav({ isRegen: true, groundedRoutes: ["/#!/owners/new"], requestedUrl: "http://h:8080/#!/visits/new" });
  assert.equal(d.allow, true);
});

test("nav-gate decideNav: a regen blocks a concrete id when grounding provides the :param TEMPLATE", () => {
  const d = decideNav({ isRegen: true, groundedRoutes: ["/#!/owners/details/:id"], requestedUrl: "http://h/#!/owners/details/8" });
  assert.equal(d.allow, false);
});

test("nav-gate decideNav: a numeric-LITERAL sibling route (different year) is ALLOWED, never falsely blocked", () => {
  const d = decideNav({ isRegen: true, groundedRoutes: ["/#!/reports/2024"], requestedUrl: "http://h/#!/reports/2025" });
  assert.equal(d.allow, true);
});

test("nav-gate decideNav: two DIFFERENT concrete ids are ALLOWED (no blind collapse)", () => {
  const d = decideNav({ isRegen: true, groundedRoutes: ["/#!/owners/details/8"], requestedUrl: "http://h/#!/owners/details/12" });
  assert.equal(d.allow, true);
});

test("nav-gate decideNav: case-mismatched routes ALLOW (case-sensitive by design — never a false block)", () => {
  const d = decideNav({ isRegen: true, groundedRoutes: ["/#!/owners/new"], requestedUrl: "http://h/#!/Owners/New" });
  assert.equal(d.allow, true);
});

test("nav-gate decideNav: FAIL-OPEN when there are no grounded routes (never blind by accident)", () => {
  const d = decideNav({ isRegen: true, groundedRoutes: [], requestedUrl: "http://h/#!/owners/new" });
  assert.equal(d.allow, true);
});

test("nav-gate decideNav: FAIL-OPEN on an unparseable requested URL", () => {
  const d = decideNav({ isRegen: true, groundedRoutes: ["/owners/new"], requestedUrl: "" });
  assert.equal(d.allow, true);
});
