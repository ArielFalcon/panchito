import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, updateApp, deleteApp, type AppAdminDeps, type CreateAppInput } from "./app-admin";
import type { AppConfig } from "../orchestrator/config-loader";
import { buildYaml, type OnboardInput } from "./onboard";
import { serializeBoundary, spliceBoundariesBlock } from "./onboarding/write-boundaries";
import type { HttpBoundaryProfile, EventBoundaryProfile } from "@contexts/service-topology/domain/index.ts";

const HTTP_BOUNDARY: HttpBoundaryProfile = {
  transport: "http",
  frontFiles: "**/*.api.ts",
  frontCallSite: { kind: "receiver-verb-call", receiver: "this.rest" },
  servicePrefixTemplate: "name-{service}-api",
  serviceRepoTemplate: "ms-name-{service}",
  openApiPath: "src/main/resources/openapi/api-definition.yaml",
};

const EVENT_BOUNDARY: EventBoundaryProfile = {
  transport: "event",
  files: "**/*.java",
  eventPattern: {
    kind: "class-based-domain-events",
    listenerBaseType: "ListenerMessageDelegate",
    listenerEventCall: "convertMsgToSpecificType",
    subscriberBaseType: "DomainEventSubscriber",
    publishCall: "publishGenericMessage",
  },
};

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

test("updateApp loads existing config, merges changes, and writes", async () => {
  const deps = makeDeps();
  const r = await updateApp(
    { name: "shop", baseUrl: "https://new.dev.shop.io", shadow: false },
    deps,
  );
  assert.equal(r.ok, true);
  assert.equal(r.name, "shop");
  const yaml = deps.written["shop"] ?? "";
  assert.match(yaml, /baseUrl: "https:\/\/new\.dev\.shop\.io"/);
  assert.match(yaml, /shadow: false/);
  assert.match(yaml, /repo: "org\/shop-front"/);
});

test("updateApp validates repo when it changes", async () => {
  const deps = makeDeps();
  const r = await updateApp(
    { name: "shop", repo: "org/new-repo" },
    deps,
  );
  assert.equal(r.ok, true);
  assert.match(deps.written["shop"] ?? "", /repo: "org\/new-repo"/);
});

test("updateApp rejects invalid config", async () => {
  const deps = makeDeps();
  const r = await updateApp(
    { name: "shop", baseUrl: "not-a-url" },
    deps,
  );
  assert.equal(r.ok, false);
  assert.ok((r.errors ?? []).length > 0);
  assert.deepEqual(deps.written, {});
});

test("updateApp returns 404 when app does not exist", async () => {
  const deps = makeDeps({
    loadApp: () => { throw new Error("not found"); },
  });
  const r = await updateApp({ name: "missing", baseUrl: "https://x" }, deps);
  assert.equal(r.ok, false);
  assert.match(r.errors?.[0] ?? "", /not found/);
});

test("updateApp dryRun returns yaml without writing", async () => {
  const deps = makeDeps();
  const r = await updateApp({ name: "shop", shadow: false, dryRun: true }, deps);
  assert.equal(r.ok, true);
  assert.ok(r.yaml);
  assert.deepEqual(deps.written, {});
});

test("updateApp preserves an existing boundaries block, in order, across a rebuild", async () => {
  const deps = makeDeps({
    loadApp: (name: string) => ({
      name,
      repo: "org/shop-front",
      qa: { needsReview: true, testDataPrefix: "qa" },
      report: { onFailure: "github-issue" },
      dev: { baseUrl: "https://x" },
      boundaries: [HTTP_BOUNDARY, EVENT_BOUNDARY],
    }) as unknown as AppConfig,
  });

  const r = await updateApp({ name: "shop", baseUrl: "https://new" }, deps);

  assert.equal(r.ok, true);
  const yaml = deps.written["shop"] ?? "";
  assert.match(yaml, /boundaries:/);
  assert.match(yaml, /openApiPath: "src\/main\/resources\/openapi\/api-definition\.yaml"/);
  assert.match(yaml, /listenerBaseType: "ListenerMessageDelegate"/);
  // order: the http entry (first in the input array) must appear before the event entry
  assert.ok(yaml.indexOf("transport: http") < yaml.indexOf("transport: event"));

  const expectedOnboard: OnboardInput = {
    name: "shop",
    repo: "org/shop-front",
    baseBranch: "main",
    baseUrl: "https://new",
    target: "e2e",
    needsReview: true,
    shadow: true,
    testDataPrefix: "qa",
  };
  const expected = spliceBoundariesBlock(buildYaml(expectedOnboard), [
    ...serializeBoundary(HTTP_BOUNDARY),
    ...serializeBoundary(EVENT_BOUNDARY),
  ]);
  assert.equal(yaml, expected);
});

test("updateApp dryRun returns the preserved boundaries block without writing", async () => {
  const deps = makeDeps({
    loadApp: (name: string) => ({
      name,
      repo: "org/shop-front",
      qa: { needsReview: true, testDataPrefix: "qa" },
      report: { onFailure: "github-issue" },
      dev: { baseUrl: "https://x" },
      boundaries: [HTTP_BOUNDARY],
    }) as unknown as AppConfig,
  });

  const r = await updateApp({ name: "shop", baseUrl: "https://new", dryRun: true }, deps);

  assert.equal(r.ok, true);
  assert.deepEqual(deps.written, {});
  assert.match(r.yaml ?? "", /boundaries:/);
  assert.match(r.yaml ?? "", /openApiPath: "src\/main\/resources\/openapi\/api-definition\.yaml"/);
});

test("updateApp with no boundaries stays byte-identical to today's output", async () => {
  const deps = makeDeps();

  const r = await updateApp({ name: "shop", baseUrl: "https://new" }, deps);

  assert.equal(r.ok, true);
  const yaml = deps.written["shop"] ?? "";
  assert.doesNotMatch(yaml, /boundaries:/);

  const expectedOnboard: OnboardInput = {
    name: "shop",
    repo: "org/shop-front",
    baseBranch: "main",
    baseUrl: "https://new",
    target: "e2e",
    needsReview: true,
    shadow: true,
    testDataPrefix: "qa",
  };
  assert.equal(yaml, buildYaml(expectedOnboard));
});
