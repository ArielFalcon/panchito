// test/contexts/service-topology/infrastructure/config-to-resolver.integration.test.ts
// INTEGRATION GATE (step 2): proves the whole config→resolver chain end-to-end, with NO
// external repos — only the EXISTING step-1 fixtures under fixtures/{backend,frontend}.
//   stub reader (a YAML string) → YamlBoundaryProfileAdapter.forApp() → HttpBoundaryProfile[]
//     → buildServiceBoundaryResolver() → ServiceBoundaryResolverPort → resolveLinks(...)
// If any layer silently dropped or mis-shaped the config, this chain would resolve zero
// links against fixtures known (via openapi-http-resolver.adapter.test.ts) to produce exactly
// 2 matched links (listOrders, getOrderById) for the nname-shaped convention.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { YamlBoundaryProfileAdapter } from "@contexts/service-topology/infrastructure/yaml-boundary-profile.adapter.ts";
import { buildServiceBoundaryResolver } from "@contexts/service-topology/infrastructure/resolver-factory.ts";
import type { RepoRef, ServiceLink } from "@contexts/service-topology/domain/index.ts";

const FIXTURES = join(import.meta.dirname, "../fixtures");

// This YAML string is what a real config/apps/nname.yaml would declare under `boundaries:` —
// the exact convention the fixtures/{backend,frontend} pair encodes (same profile as
// NNAME_PROFILE in openapi-http-resolver.adapter.test.ts).
const NNAME_APP_YAML = `
name: nname
repo: org/nname-webapp
boundaries:
  - transport: http
    frontFiles: "**/*.api.ts"
    frontCallSite: { kind: receiver-verb-call, receiver: "this.rest" }
    servicePrefixTemplate: "name-{service}-api"
    serviceRepoTemplate: "ms-name-{service}"
    openApiPath: "src/main/resources/openapi/api-definition.yaml"
`;

const backendRepo: RepoRef = {
  repo: "ArielFalcon/ms-name-orders",
  mirrorDir: join(FIXTURES, "backend"),
};
const frontendRepo: RepoRef = {
  repo: "ArielFalcon/name-webapp",
  mirrorDir: join(FIXTURES, "frontend"),
};

test("INTEGRATION: config boundaries[] flows through provider → factory → resolveLinks with zero hardcoded pattern", async () => {
  const provider = new YamlBoundaryProfileAdapter(() => NNAME_APP_YAML);
  const profiles = await provider.forApp("nname");
  assert.equal(profiles.length, 1, "expected exactly one profile parsed from the config YAML");

  const resolver = buildServiceBoundaryResolver(profiles);
  const result = await resolver.resolveLinks([backendRepo], frontendRepo);

  assert.equal(
    result.links.length,
    2,
    `expected exactly 2 resolved links (listOrders, getOrderById), got ${result.links.length}: ${JSON.stringify(result.links.map((l) => l.contractRef))}`,
  );

  const listOrders = result.links.find((l: ServiceLink) => l.contractRef === "listOrders");
  assert.ok(listOrders, "expected a link with contractRef=listOrders");
  assert.equal(listOrders.transport, "http");
  assert.equal(listOrders.from.repo, frontendRepo.repo);
  assert.equal(listOrders.to.repo, backendRepo.repo);

  const getOrderById = result.links.find((l: ServiceLink) => l.contractRef === "getOrderById");
  assert.ok(getOrderById, "expected a link with contractRef=getOrderById (a real operationId from the backend contract)");

  // The chain must also still surface the fixture's drift/external/unresolved buckets — proving
  // the resolver reached via the factory is the real OpenApiHttpResolver, not a stub that only
  // ever returns links.
  assert.ok(result.drift.length > 0, "expected at least one drift finding (POST /orders is undeclared)");
  assert.ok(result.external.length > 0, "expected at least one external finding (name-unknown-api call)");
  assert.ok(result.unresolved.length > 0, "expected at least one unresolved finding (dynamic id arg)");
});

// This YAML string declares an EVENT boundary — the same convention the
// fixtures/event-cross-repo/{service-a,service-b} pair encodes (step 3, mirrors the http
// integration test above but through the EVENT transport end-to-end).
const NNAME_EVENT_APP_YAML = `
name: nname
repo: org/nname-webapp
boundaries:
  - transport: event
    files: "**/*.java"
    eventPattern:
      kind: class-based-domain-events
      listenerBaseType: ListenerMessageDelegate
      listenerEventCall: convertMsgToSpecificType
      subscriberBaseType: DomainEventSubscriber
      publishCall: publishGenericMessage
`;

const serviceARepo: RepoRef = {
  repo: "org/service-a",
  mirrorDir: join(FIXTURES, "event-cross-repo/service-a"),
};
const serviceBRepo: RepoRef = {
  repo: "org/service-b",
  mirrorDir: join(FIXTURES, "event-cross-repo/service-b"),
};

test("INTEGRATION: an EVENT boundaries[] entry flows through provider → factory → resolveLinks with zero hardcoded pattern", async () => {
  const provider = new YamlBoundaryProfileAdapter(() => NNAME_EVENT_APP_YAML);
  const profiles = await provider.forApp("nname");
  assert.equal(profiles.length, 1, "expected exactly one event profile parsed from the config YAML");

  const resolver = buildServiceBoundaryResolver(profiles);
  const result = await resolver.resolveLinks([serviceARepo, serviceBRepo], serviceARepo);

  assert.equal(
    result.links.length,
    2,
    `expected exactly 2 resolved event links (exact + stem), got ${result.links.length}: ${JSON.stringify(result.links.map((l) => l.contractRef))}`,
  );

  const exactLink = result.links.find((l: ServiceLink) => l.to.symbol === "FooCreatedListenerNats");
  assert.ok(exactLink, "expected the exact-matched link into FooCreatedListenerNats");
  assert.equal(exactLink.transport, "event");
  assert.equal(exactLink.confidence, 1.0);
  assert.equal(exactLink.from.repo, serviceBRepo.repo);
  assert.equal(exactLink.to.repo, serviceARepo.repo);

  const stemLink = result.links.find((l: ServiceLink) => l.to.symbol === "BarModelListenerNats");
  assert.ok(stemLink, "expected the stem-matched link into BarModelListenerNats");
  assert.equal(stemLink.confidence, 0.7);

  // Events have no drift/external equivalent — the chain must surface empty buckets, not throw.
  assert.deepEqual(result.drift, []);
  assert.deepEqual(result.external, []);
  assert.deepEqual(result.unresolved, []);
});

test("INTEGRATION: a config YAML declaring BOTH an http and an event boundary resolves BOTH transports through one composed resolver", async () => {
  const mixedYaml = `
name: nname
repo: org/nname-webapp
boundaries:
  - transport: http
    frontFiles: "**/*.api.ts"
    frontCallSite: { kind: receiver-verb-call, receiver: "this.rest" }
    servicePrefixTemplate: "name-{service}-api"
    serviceRepoTemplate: "ms-name-{service}"
    openApiPath: "src/main/resources/openapi/api-definition.yaml"
  - transport: event
    files: "**/*.java"
    eventPattern:
      kind: class-based-domain-events
      listenerBaseType: ListenerMessageDelegate
      listenerEventCall: convertMsgToSpecificType
      subscriberBaseType: DomainEventSubscriber
      publishCall: publishGenericMessage
`;
  const provider = new YamlBoundaryProfileAdapter(() => mixedYaml);
  const profiles = await provider.forApp("nname");
  assert.equal(profiles.length, 2, "expected both the http and the event boundary to parse");

  const resolver = buildServiceBoundaryResolver(profiles);

  // Resolve over the HTTP fixture pair — must still yield the http links (proves the composite
  // runs the http resolver even though an event profile is ALSO registered).
  const httpResult = await resolver.resolveLinks([backendRepo], frontendRepo);
  assert.ok(httpResult.links.some((l) => l.transport === "http" && l.contractRef === "listOrders"));

  // Resolve over the EVENT fixture pair — must yield the event links too (proves the composite
  // runs the event resolver even though an http profile is ALSO registered). Passing the http
  // fixtures' repos here contributes nothing (no .java files in them) — fail-open, not a throw.
  const eventResult = await resolver.resolveLinks([serviceARepo, serviceBRepo, backendRepo], serviceARepo);
  assert.ok(eventResult.links.some((l) => l.transport === "event" && l.to.symbol === "FooCreatedListenerNats"));
});
