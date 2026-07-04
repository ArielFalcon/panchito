import { test } from "node:test";
import assert from "node:assert/strict";
import { AppConfigSchema, ManifestEntrySchema } from "./schemas";

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

// ── manifest entry: write↔read alignment (post-ADR-001, Phase 3.1) ─────────────

const manifestEntry = {
  id: "login",
  objective: "valid credentials reach the dashboard",
  flow: "login",
  targets: ["AuthService.login"],
  changeRef: { sha: "abc123", type: "feat" },
};

test("ManifestEntrySchema accepts a well-formed entry", () => {
  assert.equal(ManifestEntrySchema.safeParse(manifestEntry).success, true);
});

test("ManifestEntrySchema rejects empty targets / empty objective — write uses the read invariant (Phase 3.1)", () => {
  // The write path (opencode-client) validates each entry with THIS schema before writing,
  // so it can never emit a manifest that read-validation would later reject (empty targets
  // is a deliberate invariant — see qa/metadata.test.ts). The bad entry is dropped at write
  // with a warning rather than corrupting e2e/.qa/manifest.json.
  assert.equal(ManifestEntrySchema.safeParse({ ...manifestEntry, targets: [] }).success, false);
  assert.equal(ManifestEntrySchema.safeParse({ ...manifestEntry, objective: "" }).success, false);
});

// ── e2e.testIdAttribute config field ─────────────────────────────────────────

test("AppConfigSchema accepts e2e.testIdAttribute override (e.g. data-cy)", () => {
  const cfg = AppConfigSchema.parse({ ...base, e2e: { testIdAttribute: "data-cy" } });
  assert.equal(cfg.e2e?.testIdAttribute, "data-cy");
});

test("AppConfigSchema accepts e2e block with no testIdAttribute (field optional)", () => {
  const cfg = AppConfigSchema.parse({ ...base, e2e: {} });
  assert.equal(cfg.e2e?.testIdAttribute, undefined);
});

test("AppConfigSchema accepts no e2e block at all (block optional)", () => {
  const cfg = AppConfigSchema.parse(base);
  assert.equal(cfg.e2e, undefined);
});

test("AppConfigSchema rejects testIdAttribute: empty string", () => {
  assert.throws(() => AppConfigSchema.parse({ ...base, e2e: { testIdAttribute: "" } }));
});

// ── qa.specTriage config flag ─────────────────────────────────────────────────

test("qa.specTriage: true parses without error", () => {
  const cfg = AppConfigSchema.parse({ ...base, qa: { ...base.qa, specTriage: true } });
  assert.equal(cfg.qa.specTriage, true);
});

test("qa.specTriage: absent defaults to undefined (falsy, feature is default-OFF)", () => {
  const cfg = AppConfigSchema.parse(base);
  assert.equal(cfg.qa.specTriage, undefined);
});

test("qa.specTriage: false parses without error", () => {
  const cfg = AppConfigSchema.parse({ ...base, qa: { ...base.qa, specTriage: false } });
  assert.equal(cfg.qa.specTriage, false);
});

// ── boundaries[] config (Stitcher → Generation seam, S1.1) ────────────────────
// Shallow/pass-through validation: field names copied verbatim from
// YamlBoundaryProfileAdapter's REQUIRED_HTTP_STRING_FIELDS/REQUIRED_EVENT_PATTERN_STRING_FIELDS.
// Deep validation (catalog-key checks, blank-string rejection) stays owned by that adapter —
// this schema only stops config-loader stripping the block and gives AppConfig.boundaries a shape.

const httpBoundary = {
  transport: "http",
  frontFiles: "**/*.api.ts",
  frontCallSite: { kind: "receiver-verb-call", receiver: "this.rest" },
  servicePrefixTemplate: "name-{service}-api",
  serviceRepoTemplate: "ms-name-{service}",
  openApiPath: "openapi/openapi.yaml",
};

const eventBoundary = {
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

test("boundaries[]: a valid http entry parses, AppConfig.boundaries is a validated array, order preserved", () => {
  const cfg = AppConfigSchema.parse({ ...base, boundaries: [httpBoundary] });
  assert.equal(cfg.boundaries?.length, 1);
  assert.deepEqual(cfg.boundaries?.[0], httpBoundary);
});

test("boundaries[]: a valid event entry parses, all EventBoundarySchema fields present", () => {
  const cfg = AppConfigSchema.parse({ ...base, boundaries: [eventBoundary] });
  assert.equal(cfg.boundaries?.length, 1);
  assert.deepEqual(cfg.boundaries?.[0], eventBoundary);
});

test("boundaries[]: http + event entries together parse in the same order given", () => {
  const cfg = AppConfigSchema.parse({ ...base, boundaries: [httpBoundary, eventBoundary] });
  assert.equal(cfg.boundaries?.length, 2);
  assert.deepEqual(cfg.boundaries?.[0], httpBoundary);
  assert.deepEqual(cfg.boundaries?.[1], eventBoundary);
});

test("boundaries[]: an http entry missing a required field (no openApiPath) THROWS", () => {
  const { openApiPath: _drop, ...incomplete } = httpBoundary;
  assert.throws(() => AppConfigSchema.parse({ ...base, boundaries: [incomplete] }));
});

test("boundaries[]: an entry with an unknown transport THROWS (discriminated union reject)", () => {
  assert.throws(() =>
    AppConfigSchema.parse({ ...base, boundaries: [{ ...httpBoundary, transport: "rpc" }] }),
  );
});

test("boundaries[]: no boundaries key at all -> AppConfig.boundaries is undefined (not [], no throw)", () => {
  const cfg = AppConfigSchema.parse(base);
  assert.equal(cfg.boundaries, undefined);
});

test("boundaries[]: code:true app with non-empty boundaries[] THROWS (boundaries are e2e-only)", () => {
  assert.throws(() =>
    AppConfigSchema.parse({ ...base, dev: undefined, code: true, boundaries: [httpBoundary] }),
  );
});

test("boundaries[]: code:true app with NO boundaries[] still parses (empty/absent never blocked by the refine)", () => {
  const cfg = AppConfigSchema.parse({ ...base, dev: undefined, code: true });
  assert.equal(cfg.boundaries, undefined);
});
