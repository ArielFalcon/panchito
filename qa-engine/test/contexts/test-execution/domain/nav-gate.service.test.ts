import { test } from "node:test";
import assert from "node:assert/strict";
import { NavGateService } from "@contexts/test-execution/domain/nav-gate.service.ts";

const svc = new NavGateService();

test("first-pass (not a regen) always allows navigation", () => {
  const d = svc.decideNav({ isRegen: false, groundedRoutes: ["/owners"], requestedUrl: "http://localhost/owners" });
  assert.equal(d.allow, true);
  assert.match(d.reason, /first-pass/);
});

test("regen navigating to a grounded route is blocked", () => {
  const d = svc.decideNav({ isRegen: true, groundedRoutes: ["/owners"], requestedUrl: "http://localhost/owners" });
  assert.equal(d.allow, false);
  assert.match(d.reason, /grounded/);
});

test("regen navigating to an ungrounded route is allowed", () => {
  const d = svc.decideNav({ isRegen: true, groundedRoutes: ["/owners"], requestedUrl: "http://localhost/pets" });
  assert.equal(d.allow, true);
  assert.match(d.reason, /not grounded/);
});

test("fail-open: unparseable URL allows navigation", () => {
  const d = svc.decideNav({ isRegen: true, groundedRoutes: ["/owners"], requestedUrl: "" });
  assert.equal(d.allow, true);
  assert.match(d.reason, /fail-open/);
});

test("fail-open: no grounded routes allows navigation", () => {
  const d = svc.decideNav({ isRegen: true, groundedRoutes: [], requestedUrl: "http://localhost/owners" });
  assert.equal(d.allow, true);
  assert.match(d.reason, /fail-open/);
});

test("normalizeRoute: hash-routed URL extracts the SPA route", () => {
  const route = svc.normalizeRoute("http://localhost/#/owners/new");
  assert.equal(route, "/owners/new");
});

test("normalizeRoute: path-routed URL strips origin", () => {
  const route = svc.normalizeRoute("http://localhost/owners/1");
  assert.equal(route, "/owners/1");
});

test("normalizeRoute: empty string returns null (fail-open)", () => {
  assert.equal(svc.normalizeRoute(""), null);
});

test("routesMatch: :param template matches any concrete segment", () => {
  assert.equal(svc.routesMatch("/owners/:id", "/owners/42"), true);
});

test("routesMatch: different segment counts do not match", () => {
  assert.equal(svc.routesMatch("/owners/:id", "/owners/42/extra"), false);
});

test("routesMatch: identical routes match", () => {
  assert.equal(svc.routesMatch("/owners", "/owners"), true);
});
