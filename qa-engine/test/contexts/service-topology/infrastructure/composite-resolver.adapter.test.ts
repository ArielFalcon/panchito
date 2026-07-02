// test/contexts/service-topology/infrastructure/composite-resolver.adapter.test.ts
// TDD: composite dedup + per-resolver error isolation
import { test } from "node:test";
import assert from "node:assert/strict";
import { CompositeServiceBoundaryResolver } from "@contexts/service-topology/infrastructure/composite-resolver.adapter.ts";
import { StubServiceBoundaryResolver } from "@contexts/service-topology/infrastructure/stub-resolver.adapter.ts";
import type { ServiceBoundaryResolverPort, ResolveLinksResult } from "@contexts/service-topology/application/ports/index.ts";
import type { RepoRef, ServiceLink, ServiceSymbolRef, ContractDrift } from "@contexts/service-topology/domain/index.ts";

const FRONT: RepoRef = { repo: "front/webapp", mirrorDir: "/front" };
const BACK: RepoRef = { repo: "back/api", mirrorDir: "/back" };
const fromRef: ServiceSymbolRef = { repo: "front/webapp", file: "src/api.ts", symbol: "getUser" };
const toRef: ServiceSymbolRef = { repo: "back/api", file: "openapi.yaml", symbol: "getUser" };

function makeLink(contractRef: string, confidence = 1.0): ServiceLink {
  return { from: fromRef, to: toRef, transport: "http", contractRef, confidence, source: "test" };
}

function makeResolver(result: ResolveLinksResult): ServiceBoundaryResolverPort {
  return { resolveLinks: async () => result };
}

function emptyResult(): ResolveLinksResult {
  return { links: [], drift: [], external: [], unresolved: [] };
}

// ---- StubServiceBoundaryResolver ----
test("StubServiceBoundaryResolver.resolveLinks returns empty result without throwing", async () => {
  const stub = new StubServiceBoundaryResolver();
  const result = await stub.resolveLinks([BACK], FRONT);
  assert.deepEqual(result.links, []);
  assert.deepEqual(result.drift, []);
});

// ---- Composite: delegates to all resolvers and merges links ----
test("CompositeServiceBoundaryResolver merges links from multiple resolvers", async () => {
  const r1 = makeResolver({ links: [makeLink("opA")], drift: [], external: [], unresolved: [] });
  const r2 = makeResolver({ links: [makeLink("opB")], drift: [], external: [], unresolved: [] });
  const composite = new CompositeServiceBoundaryResolver([r1, r2]);
  const result = await composite.resolveLinks([BACK], FRONT);
  assert.equal(result.links.length, 2);
});

// ---- Composite: deduplicates identical links, keeping highest confidence ----
test("CompositeServiceBoundaryResolver deduplicates links with same key, keeping highest confidence", async () => {
  const low = { ...makeLink("opA"), confidence: 0.5 };
  const high = { ...makeLink("opA"), confidence: 0.9 };
  const r1 = makeResolver({ links: [low], drift: [], external: [], unresolved: [] });
  const r2 = makeResolver({ links: [high], drift: [], external: [], unresolved: [] });
  const composite = new CompositeServiceBoundaryResolver([r1, r2]);
  const result = await composite.resolveLinks([BACK], FRONT);
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0]!.confidence, 0.9);
});

// ---- Composite: two links with same call-site/handler but different contractRef are NOT collapsed ----
test("CompositeServiceBoundaryResolver keeps two links that differ only by contractRef", async () => {
  const r1 = makeResolver({ links: [makeLink("opA"), makeLink("opB")], drift: [], external: [], unresolved: [] });
  const composite = new CompositeServiceBoundaryResolver([r1]);
  const result = await composite.resolveLinks([BACK], FRONT);
  assert.equal(result.links.length, 2);
});

// ---- Composite: a throwing resolver is isolated and does not break others ----
test("CompositeServiceBoundaryResolver isolates a throwing resolver and returns results from others", async () => {
  const bad: ServiceBoundaryResolverPort = { resolveLinks: async () => { throw new Error("resolver exploded"); } };
  const good = makeResolver({ links: [makeLink("opOk")], drift: [], external: [], unresolved: [] });
  const composite = new CompositeServiceBoundaryResolver([bad, good]);
  const result = await composite.resolveLinks([BACK], FRONT);
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0]!.contractRef, "opOk");
});

// ---- Composite: merges drift, external, unresolved from all resolvers ----
test("CompositeServiceBoundaryResolver merges drift/external/unresolved from all resolvers", async () => {
  const r1 = makeResolver({ links: [], drift: [{ from: fromRef, verb: "DELETE", path: "/gone" }], external: [], unresolved: [] });
  const r2 = makeResolver({ links: [], drift: [], external: [{ path: "name-other-api/x", verb: "GET" }], unresolved: [{ rawArg: "dynId", file: "f.ts" }] });
  const composite = new CompositeServiceBoundaryResolver([r1, r2]);
  const result = await composite.resolveLinks([BACK], FRONT);
  assert.equal(result.drift.length, 1);
  assert.equal(result.external.length, 1);
  assert.equal(result.unresolved.length, 1);
});

// ---- Fix 2: dedup drift, external, unresolved across resolvers ----
test("CompositeServiceBoundaryResolver deduplicates identical drift entries from multiple resolvers", async () => {
  const sameDrift = { from: fromRef, verb: "DELETE", path: "/name-orders-api/gone" };
  const r1 = makeResolver({ links: [], drift: [sameDrift], external: [], unresolved: [] });
  const r2 = makeResolver({ links: [], drift: [sameDrift], external: [], unresolved: [] });
  const composite = new CompositeServiceBoundaryResolver([r1, r2]);
  const result = await composite.resolveLinks([BACK], FRONT);
  assert.equal(result.drift.length, 1, "identical drift entries from two resolvers should be deduped to one");
});

test("CompositeServiceBoundaryResolver deduplicates identical external entries from multiple resolvers", async () => {
  const sameExt = { path: "name-other-api/x", verb: "GET" };
  const r1 = makeResolver({ links: [], drift: [], external: [sameExt], unresolved: [] });
  const r2 = makeResolver({ links: [], drift: [], external: [sameExt], unresolved: [] });
  const composite = new CompositeServiceBoundaryResolver([r1, r2]);
  const result = await composite.resolveLinks([BACK], FRONT);
  assert.equal(result.external.length, 1, "identical external entries from two resolvers should be deduped to one");
});

test("CompositeServiceBoundaryResolver deduplicates identical unresolved entries from multiple resolvers", async () => {
  const sameUnresolved = { rawArg: "dynId", file: "src/api.ts" };
  const r1 = makeResolver({ links: [], drift: [], external: [], unresolved: [sameUnresolved] });
  const r2 = makeResolver({ links: [], drift: [], external: [], unresolved: [sameUnresolved] });
  const composite = new CompositeServiceBoundaryResolver([r1, r2]);
  const result = await composite.resolveLinks([BACK], FRONT);
  assert.equal(result.unresolved.length, 1, "identical unresolved entries from two resolvers should be deduped to one");
});

// ==========================================
// LEVEL 1 CORRECTNESS FIXES (RED → GREEN)
// ==========================================

// ---- L1.3: composite drift dedup must include from.file ----
// When two resolvers independently surface drift from different files (same verb+path but different
// from.file), the composite must NOT collapse them to one entry (from.file distinguishes them).
test("L1.3: CompositeServiceBoundaryResolver drift dedup includes from.file (two files, same endpoint → two drift entries)", async () => {
  const driftFile1: ContractDrift = {
    from: { repo: "front/webapp", file: "src/alpha.api.ts", symbol: "createOrder" },
    verb: "POST",
    path: "name-orders-api/orders",
  };
  const driftFile2: ContractDrift = {
    from: { repo: "front/webapp", file: "src/beta.api.ts", symbol: "createOrder" },
    verb: "POST",
    path: "name-orders-api/orders",
  };
  const r1 = makeResolver({ links: [], drift: [driftFile1], external: [], unresolved: [] });
  const r2 = makeResolver({ links: [], drift: [driftFile2], external: [], unresolved: [] });
  const composite = new CompositeServiceBoundaryResolver([r1, r2]);
  const result = await composite.resolveLinks([BACK], FRONT);
  assert.equal(
    result.drift.length,
    2,
    `expected 2 drift entries (different from.file), got ${result.drift.length}: ${JSON.stringify(result.drift.map((d) => d.from.file))}`,
  );
});

// ==========================================
// ROUND 2 FINDINGS (RED → GREEN)
// ==========================================

// ---- R2-F6: drift dedup must include from.symbol ----
// Two methods in the SAME file each calling the same undeclared endpoint should produce
// two drift entries, not one. The current dedup key is `from.file|verb|path` — adding
// `from.symbol` ensures per-method granularity.
test("R2-F6: drift dedup includes from.symbol (two methods same file, same endpoint → two drift entries)", async () => {
  const driftMethod1: ContractDrift = {
    from: { repo: "front/webapp", file: "src/api.ts", symbol: "createOrder" },
    verb: "POST",
    path: "name-orders-api/orders",
  };
  const driftMethod2: ContractDrift = {
    from: { repo: "front/webapp", file: "src/api.ts", symbol: "duplicateOrder" },
    verb: "POST",
    path: "name-orders-api/orders",
  };
  // Two different resolvers, each surfacing drift from a different method in the SAME file.
  const r1 = makeResolver({ links: [], drift: [driftMethod1], external: [], unresolved: [] });
  const r2 = makeResolver({ links: [], drift: [driftMethod2], external: [], unresolved: [] });
  const composite = new CompositeServiceBoundaryResolver([r1, r2]);
  const result = await composite.resolveLinks([BACK], FRONT);
  assert.equal(
    result.drift.length,
    2,
    `expected 2 drift entries (different from.symbol), got ${result.drift.length}: ${JSON.stringify(result.drift.map((d) => d.from.symbol))}`,
  );
});

// ---- L1.4: composite sync-throw — a resolver that throws synchronously must be isolated ----
// resolveWithTimeout currently passes the Promise from resolver.resolveLinks(...) to .then().
// If resolver.resolveLinks throws SYNCHRONOUSLY (before returning a Promise), the .then() is
// never reached and the synchronous throw propagates through Promise.all, breaking all resolvers.
// The composite must guard against synchronous throws too.
test("L1.4: CompositeServiceBoundaryResolver isolates a SYNCHRONOUSLY throwing resolver", async () => {
  const syncThrow: ServiceBoundaryResolverPort = {
    resolveLinks: () => {
      throw new Error("synchronous throw before returning Promise");
    },
  };
  const good = makeResolver({ links: [makeLink("opOk")], drift: [], external: [], unresolved: [] });
  const composite = new CompositeServiceBoundaryResolver([syncThrow, good]);
  // Must NOT throw and must return the good resolver's results
  const result = await composite.resolveLinks([BACK], FRONT);
  assert.equal(result.links.length, 1, "expected good resolver's link even when sibling throws synchronously");
  assert.equal(result.links[0]!.contractRef, "opOk");
});
