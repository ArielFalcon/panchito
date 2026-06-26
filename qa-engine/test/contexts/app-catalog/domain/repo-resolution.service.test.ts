// test/contexts/app-catalog/domain/repo-resolution.service.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "@contexts/app-catalog/domain/app.aggregate.ts";
import { RepoResolutionService } from "@contexts/app-catalog/domain/repo-resolution.service.ts";

const app = App.fromConfig({ name: "portfolio", repo: "org/portfolio", baseBranch: "main", code: false, shadow: true, services: [{ repo: "org/api" }], dev: { versionUrl: "https://dev" } });
const svc = new RepoResolutionService([app]);

test("a primary-repo slug resolves with role primary", () => {
  const r = svc.resolve("org/portfolio");
  assert.equal(r.length, 1);
  assert.equal(r[0]?.app.name, "portfolio");
  assert.equal(r[0]?.role, "primary");
});
test("a service-repo slug resolves the owning app with role service", () => {
  const r = svc.resolve("org/api");
  assert.equal(r.length, 1);
  assert.equal(r[0]?.app.name, "portfolio");
  assert.equal(r[0]?.role, "service");
});
test("an unknown slug resolves to an empty array (never throws)", () => {
  assert.deepEqual(svc.resolve("org/unknown"), []);
});
test("a repo that is primary of one app AND service of another fans out to BOTH", () => {
  // Pins the legacy loadAppConfigsByRepo fan-out semantics at the domain level: ordersApp owns
  // org/orders-svc as its primary (code mode), and shopApp lists it as a service of its e2e suite.
  const ordersApp = App.fromConfig({ name: "orders", repo: "org/orders-svc", baseBranch: "main", code: true, shadow: false, services: [] });
  const shopApp = App.fromConfig({ name: "shop", repo: "org/shop-front", baseBranch: "main", code: false, shadow: false, services: [{ repo: "org/orders-svc" }], dev: { versionUrl: "https://dev" } });
  const fanOut = new RepoResolutionService([ordersApp, shopApp]).resolve("org/orders-svc");
  const roles = fanOut.map((m) => `${m.app.name}:${m.role}`).sort();
  assert.deepEqual(roles, ["orders:primary", "shop:service"]);
});
