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
  assert.equal((await adapter.resolveByRepo("org/api"))?.role, "service");
  assert.equal((await adapter.resolveByRepo("org/portfolio"))?.role, "primary");
  assert.equal(await adapter.resolveByRepo("org/nope"), null);
});
