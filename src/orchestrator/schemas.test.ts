import { test } from "node:test";
import assert from "node:assert/strict";
import { AppConfigSchema } from "./schemas";

const base = {
  name: "shop",
  repo: "org/shop-front",
  dev: { baseUrl: "https://dev.shop.io" },
  qa: { needsReview: true, testDataPrefix: "qa-shop" },
  report: { onFailure: "github-issue" },
};

test("accepts an app with services[] (repo + optional openapi/versionUrl/baseBranch)", () => {
  const cfg = AppConfigSchema.parse({
    ...base,
    services: [
      { repo: "org/orders-svc", openapi: "**/openapi/*.yaml", versionUrl: "https://dev-api.shop.io/orders/version" },
      { repo: "org/payments-svc", baseBranch: "develop" },
    ],
  });
  assert.equal(cfg.services?.length, 2);
  assert.equal(cfg.services?.[0]?.repo, "org/orders-svc");
  assert.equal(cfg.services?.[1]?.baseBranch, "develop");
});

test("an app without services still parses (backward compatible)", () => {
  const cfg = AppConfigSchema.parse(base);
  assert.equal(cfg.services, undefined);
});

test("rejects services on a code-mode app", () => {
  assert.throws(() =>
    AppConfigSchema.parse({
      ...base,
      dev: undefined,
      code: true,
      services: [{ repo: "org/orders-svc" }],
    }),
  );
});

test("rejects a service repo that duplicates the primary repo", () => {
  assert.throws(() =>
    AppConfigSchema.parse({ ...base, services: [{ repo: "org/shop-front" }] }),
  );
});

test("rejects duplicate service repos", () => {
  assert.throws(() =>
    AppConfigSchema.parse({
      ...base,
      services: [{ repo: "org/orders-svc" }, { repo: "org/orders-svc" }],
    }),
  );
});

test("qa.parallelDiff parses and defaults to undefined", () => {
  const on = AppConfigSchema.parse({ ...base, qa: { ...base.qa, parallelDiff: true } });
  assert.equal(on.qa.parallelDiff, true);
  const off = AppConfigSchema.parse(base);
  assert.equal(off.qa.parallelDiff, undefined);
});
