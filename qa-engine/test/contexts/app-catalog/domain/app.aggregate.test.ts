// test/contexts/app-catalog/domain/app.aggregate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "@contexts/app-catalog/domain/app.aggregate.ts";

const e2e = { name: "portfolio", repo: "org/portfolio", baseBranch: "main", code: false, shadow: true, services: [], dev: { versionUrl: "https://dev/version" } };

test("an e2e app requires a dev block", () => {
  assert.throws(() => App.fromConfig({ ...e2e, dev: undefined }), /dev is required/);
});

test("a code app does NOT require dev and rejects services", () => {
  assert.doesNotThrow(() => App.fromConfig({ name: "lib", repo: "org/lib", baseBranch: "main", code: true, shadow: false, services: [] }));
  assert.throws(() => App.fromConfig({ name: "lib", repo: "org/lib", baseBranch: "main", code: true, shadow: false, services: [{ repo: "org/svc" }] }), /services are only valid for e2e/);
});

test("service repo must not equal the primary (distinct error message)", () => {
  // FIX 13c: two distinct invariants → two distinct messages so operators can diagnose the violation.
  assert.throws(() => App.fromConfig({ ...e2e, services: [{ repo: "org/portfolio" }] }), /circular dependency/);
});
test("service repos must be unique among themselves (distinct error message)", () => {
  assert.throws(() => App.fromConfig({ ...e2e, services: [{ repo: "org/svc" }, { repo: "org/svc" }] }), /unique/);
});

test("a valid e2e app exposes its repos", () => {
  const app = App.fromConfig({ ...e2e, services: [{ repo: "org/svc" }] });
  assert.equal(app.name, "portfolio");
  assert.equal(app.primaryRepo, "org/portfolio");
  assert.deepEqual(app.serviceRepos, ["org/svc"]);
});
