// PARITY vs src/qa/nav-gate.ts (HEAD). Excluded from qa-engine typecheck; runs via tsx.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NavGateService,
  normalizeRoute,
  routesMatch,
  decideNav,
  type NavGateInput,
} from "@contexts/test-execution/domain/nav-gate.service.ts";
import {
  normalizeRoute as legacyNormalizeRoute,
  routesMatch as legacyRoutesMatch,
  decideNav as legacyDecideNav,
} from "../../../../../src/qa/nav-gate.ts";

const svc = new NavGateService();

const urls = [
  "",
  "http://localhost/owners",
  "http://localhost/owners/42",
  "http://localhost/owners/42/edit",
  "http://localhost/#/owners/new",
  "http://localhost/#!/pets",
  "http://localhost/owners?page=2",
  "/owners",
  "//protocol-relative",
  "ftp://not-web",
  "   ",
];

test("PARITY: normalizeRoute matches legacy across sample URLs", () => {
  for (const url of urls) {
    assert.equal(normalizeRoute(url), legacyNormalizeRoute(url), JSON.stringify(url));
  }
});

const routePairs: Array<[string, string]> = [
  ["/owners", "/owners"],
  ["/owners/:id", "/owners/42"],
  ["/owners/:id", "/owners/42/extra"],
  ["/owners", "/pets"],
  ["/owners/:id/edit", "/owners/42/edit"],
  ["/a/b/:c", "/a/b/hello"],
];

test("PARITY: routesMatch matches legacy across sample pairs", () => {
  for (const [g, r] of routePairs) {
    assert.equal(routesMatch(g, r), legacyRoutesMatch(g, r), JSON.stringify({ g, r }));
  }
});

const inputs: NavGateInput[] = [
  { isRegen: false, groundedRoutes: ["/owners"], requestedUrl: "http://localhost/owners" },
  { isRegen: true, groundedRoutes: ["/owners"], requestedUrl: "http://localhost/owners" },
  { isRegen: true, groundedRoutes: ["/owners"], requestedUrl: "http://localhost/pets" },
  { isRegen: true, groundedRoutes: [], requestedUrl: "http://localhost/owners" },
  { isRegen: true, groundedRoutes: ["/owners"], requestedUrl: "" },
  { isRegen: true, groundedRoutes: ["/owners/:id"], requestedUrl: "http://localhost/owners/99" },
];

test("PARITY: decideNav matches legacy across sample inputs", () => {
  for (const input of inputs) {
    const svcResult = svc.decideNav(input);
    const legacyResult = legacyDecideNav(input);
    assert.equal(svcResult.allow, legacyResult.allow, JSON.stringify(input));
    assert.equal(svcResult.reason, legacyResult.reason, JSON.stringify(input));
  }
});
