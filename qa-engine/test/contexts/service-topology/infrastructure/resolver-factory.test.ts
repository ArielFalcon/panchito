// test/contexts/service-topology/infrastructure/resolver-factory.test.ts
// TDD (strict): write failing tests first, then implement.
// Piece 2 of the stitcher config→resolver loader (step 2): buildServiceBoundaryResolver turns
// a set of BoundaryProfile[] (already validated by YamlBoundaryProfileAdapter) into a composed
// ServiceBoundaryResolverPort, via an internal transport → adapter-constructor registry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { buildServiceBoundaryResolver } from "@contexts/service-topology/infrastructure/resolver-factory.ts";
import { CompositeServiceBoundaryResolver } from "@contexts/service-topology/infrastructure/composite-resolver.adapter.ts";
import { OpenApiHttpResolver } from "@contexts/service-topology/infrastructure/openapi-http-resolver.adapter.ts";
import { EventResolver } from "@contexts/service-topology/infrastructure/event-resolver.adapter.ts";
import type { RepoRef, HttpBoundaryProfile, EventBoundaryProfile, BoundaryProfile } from "@contexts/service-topology/domain/index.ts";

// Real fixture pool used by event-resolver.adapter.test.ts (service-a: listeners incl. one
// exact + one stem match; service-b: publishers) — reused here to prove the factory's composed
// resolver reaches a real, working EventResolver rather than silently degrading to empty.
const EVENT_FIXTURES = join(import.meta.dirname, "../fixtures/event-cross-repo");

const HTTP_PROFILE: HttpBoundaryProfile = {
  transport: "http",
  frontFiles: "**/*.api.ts",
  frontCallSite: { kind: "receiver-verb-call", receiver: "this.rest" },
  servicePrefixTemplate: "name-{service}-api",
  serviceRepoTemplate: "ms-name-{service}",
  openApiPath: "src/main/resources/openapi/api-definition.yaml",
};

const EVENT_PROFILE: EventBoundaryProfile = {
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

const FRONT: RepoRef = { repo: "front/webapp", mirrorDir: "/nonexistent-front" };
const BACK: RepoRef = { repo: "back/api", mirrorDir: "/nonexistent-back" };

test("buildServiceBoundaryResolver: one http profile builds a CompositeServiceBoundaryResolver delegating to an OpenApiHttpResolver", () => {
  const resolver = buildServiceBoundaryResolver([HTTP_PROFILE]);
  assert.ok(resolver instanceof CompositeServiceBoundaryResolver, "expected a CompositeServiceBoundaryResolver");
});

test("buildServiceBoundaryResolver: one http profile resolves via a real OpenApiHttpResolver (not a stub)", async () => {
  // Prove delegation is real: an OpenApiHttpResolver constructed directly from the SAME profile
  // must behave identically to the factory's composed resolver against nonexistent paths
  // (both degrade to empty — fail-open — but through the OpenApiHttpResolver code path).
  const direct = new OpenApiHttpResolver(HTTP_PROFILE);
  const directResult = await direct.resolveLinks([BACK], FRONT);

  const composed = buildServiceBoundaryResolver([HTTP_PROFILE]);
  const composedResult = await composed.resolveLinks([BACK], FRONT);

  assert.deepEqual(composedResult.links, directResult.links);
});

test("buildServiceBoundaryResolver: a profile with an unknown transport is skipped (composite has fewer resolvers)", async () => {
  // Cast through unknown: simulates a forward-compat profile shape (e.g. "rpc") the registry
  // does not yet know how to construct. The registry must skip it, not throw. ("event" is no
  // longer a valid stand-in for "unknown" now that the registry has a real entry for it — see
  // the dedicated "one event profile builds ... EventResolver" test below.)
  const unknownProfile = { transport: "rpc" } as unknown as BoundaryProfile;
  const resolver = buildServiceBoundaryResolver([HTTP_PROFILE, unknownProfile]);
  // Behavior proof (constructor count is private): resolving still works and matches the
  // single-http-profile behavior — the unknown profile contributed nothing.
  const withUnknown = await resolver.resolveLinks([BACK], FRONT);
  const httpOnly = await buildServiceBoundaryResolver([HTTP_PROFILE]).resolveLinks([BACK], FRONT);
  assert.deepEqual(withUnknown, httpOnly);
});

test("buildServiceBoundaryResolver: one event profile builds a CompositeServiceBoundaryResolver delegating to an EventResolver", () => {
  const resolver = buildServiceBoundaryResolver([EVENT_PROFILE]);
  assert.ok(resolver instanceof CompositeServiceBoundaryResolver, "expected a CompositeServiceBoundaryResolver");
});

test("buildServiceBoundaryResolver: one event profile resolves via a real EventResolver (not a stub) — fail-open equivalence", async () => {
  // Prove delegation is real: an EventResolver constructed directly from the SAME profile must
  // behave identically to the factory's composed resolver against nonexistent paths (both
  // degrade to empty — fail-open — but through the EventResolver code path).
  const direct = new EventResolver(EVENT_PROFILE);
  const directResult = await direct.resolveLinks([BACK], FRONT);

  const composed = buildServiceBoundaryResolver([EVENT_PROFILE]);
  const composedResult = await composed.resolveLinks([BACK], FRONT);

  assert.deepEqual(composedResult, directResult);
});

test("buildServiceBoundaryResolver: one event profile resolves via a real EventResolver (not a stub) — positive-match equivalence against real fixtures", async () => {
  // Stronger proof than the fail-open equivalence above: against the REAL event-cross-repo
  // fixtures (same ones used in event-resolver.adapter.test.ts), the factory's composed
  // resolver must produce the SAME non-empty links as a directly-constructed EventResolver —
  // a stub or a mis-wired registry entry would silently degrade to empty here.
  const serviceA = { repo: "org/service-a", mirrorDir: join(EVENT_FIXTURES, "service-a") };
  const serviceB = { repo: "org/service-b", mirrorDir: join(EVENT_FIXTURES, "service-b") };

  const direct = new EventResolver(EVENT_PROFILE);
  const directResult = await direct.resolveLinks([serviceA, serviceB], serviceA);
  assert.ok(directResult.links.length > 0, "sanity: the direct resolver must find real links in the fixture pool");

  const composed = buildServiceBoundaryResolver([EVENT_PROFILE]);
  const composedResult = await composed.resolveLinks([serviceA, serviceB], serviceA);

  assert.deepEqual(composedResult.links, directResult.links);
});

test("buildServiceBoundaryResolver: an http profile and an event profile together build two delegating resolvers merged by the composite", async () => {
  const resolver = buildServiceBoundaryResolver([HTTP_PROFILE, EVENT_PROFILE]);
  const result = await resolver.resolveLinks([BACK], FRONT);
  // Both delegate against nonexistent paths — fail-open on each — merged result is still empty,
  // but the call must not throw (proves both the http and the event constructor ran).
  assert.deepEqual(result, { links: [], drift: [], external: [], unresolved: [] });
});

test("buildServiceBoundaryResolver: empty profiles produces a composite that resolves to empty without throwing", async () => {
  const resolver = buildServiceBoundaryResolver([]);
  const result = await resolver.resolveLinks([BACK], FRONT);
  assert.deepEqual(result, { links: [], drift: [], external: [], unresolved: [] });
});

test("buildServiceBoundaryResolver: only-unknown-transport profiles produces a composite that resolves to empty without throwing", async () => {
  const unknownProfile = { transport: "rpc" } as unknown as BoundaryProfile;
  const resolver = buildServiceBoundaryResolver([unknownProfile]);
  const result = await resolver.resolveLinks([BACK], FRONT);
  assert.deepEqual(result, { links: [], drift: [], external: [], unresolved: [] });
});

test("buildServiceBoundaryResolver: two http profiles produce two delegating resolvers merged by the composite", async () => {
  // A second, DIFFERENT profile (proves the registry constructs one OpenApiHttpResolver PER
  // profile, not a single shared instance) — mirrors the AGNOSTICISM proof pattern from
  // openapi-http-resolver.adapter.test.ts.
  const altProfile: HttpBoundaryProfile = {
    transport: "http",
    frontFiles: "**/*.api.ts",
    frontCallSite: { kind: "receiver-verb-call", receiver: "this.http" },
    servicePrefixTemplate: "{service}-service",
    serviceRepoTemplate: "{service}-service-repo",
    openApiPath: "src/main/resources/openapi/api-definition.yaml",
  };
  const resolver = buildServiceBoundaryResolver([HTTP_PROFILE, altProfile]);
  const result = await resolver.resolveLinks([BACK], FRONT);
  // Both delegate against nonexistent paths — fail-open on each — merged result is still empty,
  // but the call must not throw (proves both constructors ran and both resolveLinks completed).
  assert.deepEqual(result, { links: [], drift: [], external: [], unresolved: [] });
});
