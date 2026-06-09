import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, deleteApp, type AppAdminDeps, type CreateAppInput } from "./app-admin";
import type { AppConfig } from "../orchestrator/config-loader";

function makeDeps(overrides: Partial<AppAdminDeps> = {}): AppAdminDeps & { written: Record<string, string>; removed: string[] } {
  const written: Record<string, string> = {};
  const removed: string[] = [];
  return Object.assign(
    {
      written,
      removed,
      getRepoInfo: async (repo: string) => ({
        name: repo.split("/")[1] ?? repo,
        fullName: repo,
        private: false,
        defaultBranch: "main",
        description: null,
      }),
      configExists: () => false,
      writeConfig: (name: string, yaml: string) => { written[name] = yaml; return `/app/config/apps/${name}.yaml`; },
      deleteConfig: (name: string) => { removed.push(`config:${name}`); },
      deleteMirror: (repo: string) => { removed.push(`mirror:${repo}`); },
      deleteHistory: (app: string) => { removed.push(`history:${app}`); return 1; },
      applyEnv: (vars: Record<string, string>) => Object.keys(vars),
      loadApp: (name: string) => ({
        name,
        repo: "org/shop-front",
        qa: { needsReview: true, testDataPrefix: "qa" },
        report: { onFailure: "github-issue" },
        dev: { baseUrl: "https://x" },
      }) as unknown as AppConfig,
      env: {} as Record<string, string | undefined>,
    },
    overrides,
  ) as AppAdminDeps & { written: Record<string, string>; removed: string[] };
}

test("validateOnly returns repoInfo without writing anything", async () => {
  const deps = makeDeps();
  const r = await createApp({ repo: "org/shop-front", validateOnly: true }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.repoInfo?.defaultBranch, "main");
  assert.deepEqual(deps.written, {});
});

test("dryRun returns the YAML (with services) without writing", async () => {
  const deps = makeDeps();
  const r = await createApp(
    {
      repo: "org/shop-front", name: "shop", baseUrl: "https://dev.shop.io", target: "e2e",
      needsReview: true, shadow: true, testDataPrefix: "qa-shop",
      services: [{ repo: "org/orders-svc", openapi: "api/*.yaml" }],
      dryRun: true,
    },
    deps,
  );
  assert.equal(r.ok, true);
  assert.match(r.yaml ?? "", /- repo: "org\/orders-svc"/);
  assert.deepEqual(deps.written, {});
});

test("create applies env FIRST, validates the expanded YAML, then writes", async () => {
  const order: string[] = [];
  const deps = makeDeps({
    applyEnv: (vars: Record<string, string>) => { order.push("env"); return Object.keys(vars); },
    writeConfig: (name: string, _yaml: string) => { order.push("write"); return `/x/${name}.yaml`; },
  });
  const r = await createApp(
    {
      repo: "org/shop-front", name: "shop", baseUrl: "https://dev.shop.io", target: "e2e",
      needsReview: true, shadow: true, testDataPrefix: "qa-shop",
      env: { SHOP_TOKEN: "t" },
    },
    deps,
  );
  assert.equal(r.ok, true);
  assert.deepEqual(order, ["env", "write"]);
  assert.deepEqual(r.envApplied, ["SHOP_TOKEN"]);
  assert.equal(JSON.stringify(r).includes("\"t\""), false); // the secret value never leaves
});

test("invalid config returns the Zod errors and writes nothing", async () => {
  const deps = makeDeps();
  const r = await createApp(
    { repo: "org/shop-front", name: "shop", baseUrl: "not-a-url", target: "e2e", needsReview: true, shadow: true, testDataPrefix: "qa" },
    deps,
  );
  assert.equal(r.ok, false);
  assert.ok((r.errors ?? []).length > 0);
  assert.deepEqual(deps.written, {});
});

test("duplicate name or invalid name is rejected", async () => {
  const dup = await createApp(
    { repo: "o/r", name: "shop", baseUrl: "https://x", target: "e2e", needsReview: true, shadow: true, testDataPrefix: "qa" },
    makeDeps({ configExists: () => true }),
  );
  assert.equal(dup.ok, false);
  const bad = await createApp(
    { repo: "o/r", name: "../evil", baseUrl: "https://x", target: "e2e", needsReview: true, shadow: true, testDataPrefix: "qa" },
    makeDeps(),
  );
  assert.equal(bad.ok, false);
});

test("deleteApp removes the config; purge also removes the PRIMARY mirror and history", () => {
  const deps = makeDeps();
  const plain = deleteApp("shop", false, deps);
  assert.deepEqual(plain.removed, ["config:shop"]);
  const deps2 = makeDeps();
  const purged = deleteApp("shop", true, deps2);
  assert.deepEqual(purged.removed, ["config:shop", "mirror:org/shop-front", "history:shop"]);
});
