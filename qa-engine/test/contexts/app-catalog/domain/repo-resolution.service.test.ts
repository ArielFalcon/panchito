// test/contexts/app-catalog/domain/repo-resolution.service.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "@contexts/app-catalog/domain/app.aggregate.ts";
import { RepoResolutionService } from "@contexts/app-catalog/domain/repo-resolution.service.ts";

const app = App.fromConfig({ name: "portfolio", repo: "org/portfolio", baseBranch: "main", code: false, shadow: true, services: [{ repo: "org/api" }], dev: { versionUrl: "https://dev" } });
const svc = new RepoResolutionService([app]);

test("a primary-repo slug resolves with role primary", () => {
  const r = svc.resolve("org/portfolio");
  assert.equal(r?.app.name, "portfolio");
  assert.equal(r?.role, "primary");
});
test("a service-repo slug resolves the owning app with role service", () => {
  const r = svc.resolve("org/api");
  assert.equal(r?.app.name, "portfolio");
  assert.equal(r?.role, "service");
});
test("an unknown slug resolves to null (never throws)", () => {
  assert.equal(svc.resolve("org/unknown"), null);
});
