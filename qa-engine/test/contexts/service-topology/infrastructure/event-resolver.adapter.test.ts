// test/contexts/service-topology/infrastructure/event-resolver.adapter.test.ts
// TDD (strict): write failing tests first, then implement.
// EventResolver: config-driven backend↔backend EVENT boundary resolver. Every app-specific
// pattern (listener base type, event-consume call, subscriber base type, publish call) comes
// from the injected EventBoundaryProfile — this class carries no literal from any one watched
// app (Invariant #1). Fixtures under fixtures/event-cross-repo/ use generic Foo/Bar/Orphan
// names, never nname's real identifiers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { EventResolver } from "@contexts/service-topology/infrastructure/event-resolver.adapter.ts";
import type { RepoRef, EventBoundaryProfile, ServiceLink } from "@contexts/service-topology/domain/index.ts";

const FIXTURES = join(import.meta.dirname, "../fixtures");

// The event boundary convention as an injected config object — NOT core constants. Every
// fixture under fixtures/event-cross-repo/ encodes this exact convention.
const PROFILE: EventBoundaryProfile = {
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

// ---- Fixture layout ----
// test/contexts/service-topology/fixtures/event-cross-repo/
//   service-a/  — listeners: FooCreatedListenerNats (exact, consumes FooCreatedEvent),
//                             BarModelListenerNats (stem, consumes BarEvent),
//                             LonelyOrphanListener (no counterpart)
//   service-b/  — publishers: FooEventEmitter (variant-B, publishes FooCreatedEvent exactly),
//                              BarEventBroker + BarEventPublisherNatsImpl (variant-A, publishes
//                              the domain model "Bar" — stems to the same "Bar" as BarEvent),
//                              LonelyPublisher (no counterpart)

const serviceA: RepoRef = {
  repo: "org/service-a",
  mirrorDir: join(FIXTURES, "event-cross-repo/service-a"),
};
const serviceB: RepoRef = {
  repo: "org/service-b",
  mirrorDir: join(FIXTURES, "event-cross-repo/service-b"),
};

test("EventResolver.resolveLinks: exact event-name match produces a link with confidence 1.0", async () => {
  const resolver = new EventResolver(PROFILE);
  const result = await resolver.resolveLinks([serviceA, serviceB], serviceA);
  const link = result.links.find((l: ServiceLink) => l.contractRef === "FooCreatedEvent");
  assert.ok(link, "expected a link for the exact-matched FooCreatedEvent");
  assert.equal(link.confidence, 1.0);
  assert.equal(link.transport, "event");
  assert.equal(link.source, "event-topic");
  assert.equal(link.from.repo, serviceB.repo);
  assert.equal(link.from.symbol, "FooEventEmitter");
  assert.equal(link.to.repo, serviceA.repo);
  assert.equal(link.to.symbol, "FooCreatedListenerNats");
});

test("EventResolver.resolveLinks: stem match (XModel ~ XEvent) produces a link with confidence 0.7", async () => {
  const resolver = new EventResolver(PROFILE);
  const result = await resolver.resolveLinks([serviceA, serviceB], serviceA);
  const link = result.links.find((l: ServiceLink) => l.to.symbol === "BarModelListenerNats");
  assert.ok(link, "expected a stem-matched link into BarModelListenerNats");
  assert.equal(link.confidence, 0.7);
  assert.equal(link.transport, "event");
  assert.equal(link.from.repo, serviceB.repo);
  assert.equal(link.from.symbol, "BarEventPublisherNatsImpl");
});

test("EventResolver.resolveLinks: a publisher or listener with no counterpart produces no link (and does not throw)", async () => {
  const resolver = new EventResolver(PROFILE);
  const result = await resolver.resolveLinks([serviceA, serviceB], serviceA);
  const orphanLink = result.links.find(
    (l: ServiceLink) => l.to.symbol === "LonelyOrphanListener" || l.from.symbol === "LonelyPublisher",
  );
  assert.equal(orphanLink, undefined, "an unmatched listener/publisher must not produce a link");
});

test("EventResolver.resolveLinks: exactly two links are produced from the fixture pool (no phantom matches)", async () => {
  const resolver = new EventResolver(PROFILE);
  const result = await resolver.resolveLinks([serviceA, serviceB], serviceA);
  assert.equal(
    result.links.length,
    2,
    `expected exactly 2 links (FooCreatedEvent exact + Bar/BarEvent stem), got ${result.links.length}: ${JSON.stringify(result.links.map((l) => l.contractRef))}`,
  );
});

test("EventResolver.resolveLinks: fail-open — an unreadable/nonexistent repo dir does not throw, resolves to empty for that repo", async () => {
  const resolver = new EventResolver(PROFILE);
  const missing: RepoRef = { repo: "org/nonexistent", mirrorDir: "/nonexistent/path/xyz" };
  const result = await resolver.resolveLinks([missing], missing);
  assert.deepEqual(result, { links: [], drift: [], external: [], unresolved: [] });
});

test("EventResolver.resolveLinks: fail-open — an unknown eventPattern.kind resolves to empty without throwing", async () => {
  const badProfile: EventBoundaryProfile = {
    ...PROFILE,
    eventPattern: { ...PROFILE.eventPattern, kind: "mystery-shape" },
  };
  const resolver = new EventResolver(badProfile);
  const result = await resolver.resolveLinks([serviceA, serviceB], serviceA);
  assert.deepEqual(result, { links: [], drift: [], external: [], unresolved: [] });
});

test("EventResolver.resolveLinks: drift/external/unresolved buckets are empty (events have no direct equivalent)", async () => {
  const resolver = new EventResolver(PROFILE);
  const result = await resolver.resolveLinks([serviceA, serviceB], serviceA);
  assert.deepEqual(result.drift, []);
  assert.deepEqual(result.external, []);
  assert.deepEqual(result.unresolved, []);
});

// ==========================================
// DETERMINISM REGRESSION: duplicate event-name publishers, walk() file-collection order
// ==========================================
// TWO publishers ("AlphaDuplicateEventPublisher.java" and "ZuluDuplicateEventPublisher.java")
// publish the SAME event name ("SharedDuplicateEvent") from the same directory — realistic in
// nname's dual-transport (NATS+Rabbit) world, where a relay or dual-publish of one event is
// plausible. The JOIN is first-match-wins (`publishers.find(...)`), so the emitted link's `from`
// is only deterministic across runs if the underlying file-collection order (walk()'s
// `readdirSync`) is itself stable — i.e. sorted, not filesystem-dependent.
const serviceDupPublisher: RepoRef = {
  repo: "org/service-dup-publisher",
  mirrorDir: join(FIXTURES, "event-duplicate-publishers/service-dup"),
};
const serviceDupListener: RepoRef = {
  repo: "org/service-dup-listener",
  mirrorDir: join(FIXTURES, "event-duplicate-publishers/service-dup-listener"),
};

test("DETERMINISM: two same-named-event publishers in one directory resolve to the stable, lexicographically-first file every run", async () => {
  const resolver = new EventResolver(PROFILE);
  const runs = await Promise.all(
    Array.from({ length: 5 }, () => resolver.resolveLinks([serviceDupPublisher, serviceDupListener], serviceDupPublisher)),
  );
  const froms = runs.map((result) => {
    const link = result.links.find((l: ServiceLink) => l.to.symbol === "SharedDuplicateEventListenerNats");
    assert.ok(link, "expected a link into SharedDuplicateEventListenerNats");
    return link.from.file;
  });
  // Every run must agree on the SAME file — non-determinism here would show up as disagreement
  // across the 5 repeated runs even on a filesystem whose readdir happens to already be sorted.
  assert.ok(
    froms.every((f) => f === froms[0]),
    `walk() file order must be deterministic across runs, got: ${JSON.stringify(froms)}`,
  );
  // And it must specifically be the lexicographically FIRST of the two candidate files — proving
  // the resolver's file collection is sorted, not just "some" stable order.
  assert.equal(
    froms[0],
    "src/main/java/publisher/AlphaDuplicateEventPublisher.java",
    "the first-match join must resolve to the lexicographically-first publisher file, deterministically",
  );
});

// ==========================================
// AGNOSTICISM PROOF (Invariant #1) — REQUIRED acceptance test
// ==========================================
// A SECOND, DIFFERENT profile — a completely different base type (AbstractConsumer vs nname's
// ListenerMessageDelegate), event-consume method (deserialize vs convertMsgToSpecificType),
// subscriber base type (EventSink vs DomainEventSubscriber), and publish method (emit vs
// publishGenericMessage) — resolved through the SAME EventResolver/catalog core. If the core
// still carried an nname literal anywhere, this fixture would resolve nothing: it deliberately
// shares NO string pattern with the nname-shaped fixtures.
const ALT_PROFILE: EventBoundaryProfile = {
  transport: "event",
  files: "**/*.java",
  eventPattern: {
    kind: "class-based-domain-events",
    listenerBaseType: "AbstractConsumer",
    listenerEventCall: "deserialize",
    subscriberBaseType: "EventSink",
    publishCall: "emit",
  },
};
const serviceX: RepoRef = {
  repo: "org/service-x",
  mirrorDir: join(FIXTURES, "event-alt-profile/service-x"),
};
const serviceY: RepoRef = {
  repo: "org/service-y",
  mirrorDir: join(FIXTURES, "event-alt-profile/service-y"),
};

test("AGNOSTICISM: a second profile (AbstractConsumer/deserialize/EventSink/emit) resolves through the same core", async () => {
  const resolver = new EventResolver(ALT_PROFILE);
  const result = await resolver.resolveLinks([serviceX, serviceY], serviceX);
  const link = result.links.find((l: ServiceLink) => l.contractRef === "WidgetUpdatedEvent");
  assert.ok(link, "expected a matched ServiceLink with contractRef=WidgetUpdatedEvent under the alt profile");
  assert.equal(link.confidence, 1.0);
  assert.equal(link.transport, "event");
  assert.equal(link.source, "event-topic");
  assert.equal(link.from.repo, serviceY.repo);
  assert.equal(link.from.symbol, "WidgetEventEmitter");
  assert.equal(link.to.repo, serviceX.repo);
  assert.equal(link.to.symbol, "WidgetUpdatedConsumer");
});

test("AGNOSTICISM: the alt profile's shape (AbstractConsumer/deserialize) does NOT leak into an nname-profile run, and vice versa", async () => {
  // Cross-check: running the nname-shaped PROFILE against the alt fixtures (AbstractConsumer/
  // deserialize/emit shapes) must find nothing, because PROFILE's listenerBaseType is
  // "ListenerMessageDelegate" — proving every base-type/method name is genuinely read from the
  // injected profile, not from a core default.
  const resolver = new EventResolver(PROFILE);
  const result = await resolver.resolveLinks([serviceX, serviceY], serviceX);
  assert.equal(result.links.length, 0, "nname-shaped profile must not match AbstractConsumer/deserialize/emit call-sites");
});
