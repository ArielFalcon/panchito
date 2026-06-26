// test/contexts/app-catalog/infrastructure/yaml-app-config.adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { YamlAppConfigAdapter } from "@contexts/app-catalog/infrastructure/yaml-app-config.adapter.ts";

const raw = { name: "portfolio", repo: "org/portfolio", baseBranch: "main", code: false, qa: { shadow: true }, services: [{ repo: "org/api" }], dev: { versionUrl: "https://dev" } };

test("load maps a legacy config to an AppConfigSnapshot", async () => {
  const adapter = new YamlAppConfigAdapter({ load: (n) => ({ ...raw, name: n }), list: () => [raw] });
  const snap = await adapter.load("portfolio");
  assert.equal(snap.name, "portfolio");
  assert.equal(snap.repo, "org/portfolio");
  assert.equal(snap.shadow, true);
  assert.deepEqual(snap.services.map((s) => s.repo), ["org/api"]);
});

test("resolveByRepo finds the owning app + role across all configs", async () => {
  const adapter = new YamlAppConfigAdapter({ load: () => raw, list: () => [raw] });
  const service = await adapter.resolveByRepo("org/api");
  assert.equal(service.length, 1);
  assert.equal(service[0]?.role, "service");
  const primary = await adapter.resolveByRepo("org/portfolio");
  assert.equal(primary.length, 1);
  assert.equal(primary[0]?.role, "primary");
  assert.deepEqual(await adapter.resolveByRepo("org/nope"), []);
});

test("resolveByRepo fans out a repo that is primary of one app AND service of another", async () => {
  // Pins the legacy loadAppConfigsByRepo fan-out (config-loader.test.ts): a repo can be the
  // primary of its own code-mode app AND a service of another app's e2e suite — BOTH webhook runs
  // must be enqueued, so the adapter must return BOTH matches, not the first.
  const ordersCfg = { name: "orders", repo: "org/orders-svc", code: true };
  const shopCfg = { name: "shop", repo: "org/shop-front", services: [{ repo: "org/orders-svc" }], dev: { versionUrl: "https://dev" } };
  const adapter = new YamlAppConfigAdapter({ load: () => ordersCfg, list: () => [ordersCfg, shopCfg] });
  const matches = await adapter.resolveByRepo("org/orders-svc");
  const roles = matches.map((m) => `${m.app.name}:${m.role}`).sort();
  assert.deepEqual(roles, ["orders:primary", "shop:service"]);
});
