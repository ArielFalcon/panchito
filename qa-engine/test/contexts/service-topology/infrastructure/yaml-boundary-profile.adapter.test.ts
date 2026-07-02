// test/contexts/service-topology/infrastructure/yaml-boundary-profile.adapter.test.ts
// TDD (strict): write failing tests first, then implement.
// Piece 1 of the stitcher config→resolver loader (step 2 + step 3): YamlBoundaryProfileAdapter
// reads+validates config/apps/<app>.yaml `boundaries[]` into BoundaryProfile[] (a mix of
// HttpBoundaryProfile and EventBoundaryProfile entries, dispatched by `transport`). The reader
// is injected — no filesystem access in these tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  YamlBoundaryProfileAdapter,
  parseHttpBoundaryProfile,
  parseEventBoundaryProfile,
} from "@contexts/service-topology/infrastructure/yaml-boundary-profile.adapter.ts";
import type { EventBoundaryProfile, HttpBoundaryProfile } from "@contexts/service-topology/domain/index.ts";

// ==========================================
// parseHttpBoundaryProfile — pure validator unit tests
// ==========================================

const VALID_RAW = {
  transport: "http",
  frontFiles: "**/*.api.ts",
  frontCallSite: { kind: "receiver-verb-call", receiver: "this.rest" },
  servicePrefixTemplate: "name-{service}-api",
  serviceRepoTemplate: "ms-name-{service}",
  openApiPath: "src/main/resources/openapi/api-definition.yaml",
};

test("parseHttpBoundaryProfile: a fully valid entry returns an HttpBoundaryProfile", () => {
  const result = parseHttpBoundaryProfile(VALID_RAW);
  assert.ok(result !== null, "expected a non-null profile for a valid entry");
  assert.equal(result.transport, "http");
  assert.equal(result.frontFiles, "**/*.api.ts");
  assert.deepEqual(result.frontCallSite, { kind: "receiver-verb-call", receiver: "this.rest" });
  assert.equal(result.servicePrefixTemplate, "name-{service}-api");
  assert.equal(result.serviceRepoTemplate, "ms-name-{service}");
  assert.equal(result.openApiPath, "src/main/resources/openapi/api-definition.yaml");
});

test("parseHttpBoundaryProfile: missing transport returns null", () => {
  const { transport, ...rest } = VALID_RAW;
  const result = parseHttpBoundaryProfile(rest);
  assert.equal(result, null);
});

test("parseHttpBoundaryProfile: unknown transport returns null", () => {
  const result = parseHttpBoundaryProfile({ ...VALID_RAW, transport: "grpc" });
  assert.equal(result, null);
});

test("parseHttpBoundaryProfile: missing frontFiles returns null", () => {
  const { frontFiles, ...rest } = VALID_RAW;
  const result = parseHttpBoundaryProfile(rest);
  assert.equal(result, null);
});

test("parseHttpBoundaryProfile: non-string frontFiles returns null", () => {
  const result = parseHttpBoundaryProfile({ ...VALID_RAW, frontFiles: 123 });
  assert.equal(result, null);
});

test("parseHttpBoundaryProfile: missing servicePrefixTemplate returns null", () => {
  const { servicePrefixTemplate, ...rest } = VALID_RAW;
  const result = parseHttpBoundaryProfile(rest);
  assert.equal(result, null);
});

test("parseHttpBoundaryProfile: missing serviceRepoTemplate returns null", () => {
  const { serviceRepoTemplate, ...rest } = VALID_RAW;
  const result = parseHttpBoundaryProfile(rest);
  assert.equal(result, null);
});

test("parseHttpBoundaryProfile: missing openApiPath returns null", () => {
  const { openApiPath, ...rest } = VALID_RAW;
  const result = parseHttpBoundaryProfile(rest);
  assert.equal(result, null);
});

test("parseHttpBoundaryProfile: non-string openApiPath returns null", () => {
  const result = parseHttpBoundaryProfile({ ...VALID_RAW, openApiPath: ["a", "b"] });
  assert.equal(result, null);
});

test("parseHttpBoundaryProfile: missing frontCallSite returns null", () => {
  const { frontCallSite, ...rest } = VALID_RAW;
  const result = parseHttpBoundaryProfile(rest);
  assert.equal(result, null);
});

test("parseHttpBoundaryProfile: frontCallSite missing kind returns null", () => {
  const result = parseHttpBoundaryProfile({ ...VALID_RAW, frontCallSite: { receiver: "this.rest" } });
  assert.equal(result, null);
});

test("parseHttpBoundaryProfile: frontCallSite with non-string kind returns null", () => {
  const result = parseHttpBoundaryProfile({ ...VALID_RAW, frontCallSite: { kind: 42 } });
  assert.equal(result, null);
});

test("parseHttpBoundaryProfile: frontCallSite without receiver is still valid (receiver is optional)", () => {
  const result = parseHttpBoundaryProfile({ ...VALID_RAW, frontCallSite: { kind: "receiver-verb-call" } });
  assert.ok(result !== null, "expected a non-null profile when frontCallSite has no receiver");
  assert.deepEqual(result.frontCallSite, { kind: "receiver-verb-call" });
});

test("parseHttpBoundaryProfile: entirely malformed input (null) returns null", () => {
  const result = parseHttpBoundaryProfile(null);
  assert.equal(result, null);
});

test("parseHttpBoundaryProfile: entirely malformed input (a string) returns null", () => {
  const result = parseHttpBoundaryProfile("not an object");
  assert.equal(result, null);
});

test("parseHttpBoundaryProfile: an empty-string required field returns null (blank config is unusable)", () => {
  const result = parseHttpBoundaryProfile({ ...VALID_RAW, openApiPath: "" });
  assert.equal(result, null);
});

test("parseHttpBoundaryProfile: a whitespace-only required field returns null", () => {
  const result = parseHttpBoundaryProfile({ ...VALID_RAW, servicePrefixTemplate: "   " });
  assert.equal(result, null);
});

test("parseHttpBoundaryProfile: frontCallSite with an unknown (non-catalogued) kind returns null", () => {
  const result = parseHttpBoundaryProfile({ ...VALID_RAW, frontCallSite: { kind: "unknown-shape", receiver: "this.rest" } });
  assert.equal(result, null);
});

// ==========================================
// YamlBoundaryProfileAdapter — reader-injected, no filesystem
// ==========================================

const VALID_YAML = `
boundaries:
  - transport: http
    frontFiles: "**/*.api.ts"
    frontCallSite: { kind: receiver-verb-call, receiver: "this.rest" }
    servicePrefixTemplate: "name-{service}-api"
    serviceRepoTemplate: "ms-name-{service}"
    openApiPath: "src/main/resources/openapi/api-definition.yaml"
`;

test("YamlBoundaryProfileAdapter.forApp: a valid boundaries[] entry returns one HttpBoundaryProfile with the right fields", async () => {
  const adapter = new YamlBoundaryProfileAdapter(() => VALID_YAML);
  const profiles = await adapter.forApp("nname");
  assert.equal(profiles.length, 1);
  const profile = profiles[0]!;
  assert.equal(profile.transport, "http");
  assert.equal(profile.frontFiles, "**/*.api.ts");
  assert.deepEqual(profile.frontCallSite, { kind: "receiver-verb-call", receiver: "this.rest" });
  assert.equal(profile.servicePrefixTemplate, "name-{service}-api");
  assert.equal(profile.serviceRepoTemplate, "ms-name-{service}");
  assert.equal(profile.openApiPath, "src/main/resources/openapi/api-definition.yaml");
});

test("YamlBoundaryProfileAdapter.forApp: absent boundaries key returns []", async () => {
  const adapter = new YamlBoundaryProfileAdapter(() => "name: someapp\nrepo: org/someapp\n");
  const profiles = await adapter.forApp("someapp");
  assert.deepEqual(profiles, []);
});

test("YamlBoundaryProfileAdapter.forApp: an entry missing openApiPath is skipped, other valid entries survive", async () => {
  const yaml = `
boundaries:
  - transport: http
    frontFiles: "**/*.api.ts"
    frontCallSite: { kind: receiver-verb-call, receiver: "this.rest" }
    servicePrefixTemplate: "name-{service}-api"
    serviceRepoTemplate: "ms-name-{service}"
    # openApiPath missing here
  - transport: http
    frontFiles: "**/*.api.ts"
    frontCallSite: { kind: receiver-verb-call, receiver: "this.http" }
    servicePrefixTemplate: "{service}-service"
    serviceRepoTemplate: "{service}-service-repo"
    openApiPath: "src/main/resources/openapi/api-definition.yaml"
`;
  const adapter = new YamlBoundaryProfileAdapter(() => yaml);
  const profiles = await adapter.forApp("mixed");
  assert.equal(profiles.length, 1, "expected only the valid second entry to survive");
  const profile = profiles[0]!;
  assert.equal(profile.transport, "http");
  assert.equal((profile as HttpBoundaryProfile).frontCallSite.receiver, "this.http");
});

test("YamlBoundaryProfileAdapter.forApp: an entry with unknown transport is skipped, valid entries survive", async () => {
  const yaml = `
boundaries:
  - transport: grpc
    frontFiles: "**/*.api.ts"
    frontCallSite: { kind: receiver-verb-call, receiver: "this.rest" }
    servicePrefixTemplate: "name-{service}-api"
    serviceRepoTemplate: "ms-name-{service}"
    openApiPath: "src/main/resources/openapi/api-definition.yaml"
  - transport: http
    frontFiles: "**/*.api.ts"
    frontCallSite: { kind: receiver-verb-call, receiver: "this.rest" }
    servicePrefixTemplate: "name-{service}-api"
    serviceRepoTemplate: "ms-name-{service}"
    openApiPath: "src/main/resources/openapi/api-definition.yaml"
`;
  const adapter = new YamlBoundaryProfileAdapter(() => yaml);
  const profiles = await adapter.forApp("grpc-app");
  assert.equal(profiles.length, 1, "expected only the http entry to survive, grpc skipped");
  assert.equal(profiles[0]!.transport, "http");
});

test("YamlBoundaryProfileAdapter.forApp: an entry with an unknown frontCallSite kind is skipped", async () => {
  const yaml = `
boundaries:
  - transport: http
    frontFiles: "**/*.api.ts"
    frontCallSite: { kind: mystery-shape, receiver: "this.rest" }
    servicePrefixTemplate: "name-{service}-api"
    serviceRepoTemplate: "ms-name-{service}"
    openApiPath: "src/main/resources/openapi/api-definition.yaml"
`;
  const adapter = new YamlBoundaryProfileAdapter(() => yaml);
  const profiles = await adapter.forApp("mystery");
  assert.deepEqual(profiles, [], "an unknown call-site kind cannot be resolved — skip it at load time");
});

test("YamlBoundaryProfileAdapter.forApp: a reader that throws returns [] (fail-open)", async () => {
  const adapter = new YamlBoundaryProfileAdapter(() => {
    throw new Error("file not found");
  });
  const profiles = await adapter.forApp("missing-app");
  assert.deepEqual(profiles, []);
});

test("YamlBoundaryProfileAdapter.forApp: non-YAML garbage content returns [] (fail-open)", async () => {
  const adapter = new YamlBoundaryProfileAdapter(() => "{{{ not: valid: yaml ][");
  const profiles = await adapter.forApp("garbage-app");
  assert.deepEqual(profiles, []);
});

test("YamlBoundaryProfileAdapter.forApp: passes the app name to the injected reader", async () => {
  let receivedName: string | null = null;
  const adapter = new YamlBoundaryProfileAdapter((name) => {
    receivedName = name;
    return "boundaries: []";
  });
  await adapter.forApp("nname");
  assert.equal(receivedName, "nname");
});

test("YamlBoundaryProfileAdapter.forApp: boundaries as a non-array value returns [] (fail-open)", async () => {
  const adapter = new YamlBoundaryProfileAdapter(() => "boundaries: not-an-array");
  const profiles = await adapter.forApp("bad-shape");
  assert.deepEqual(profiles, []);
});

// ==========================================
// parseEventBoundaryProfile — pure validator unit tests (step 3)
// ==========================================

const VALID_EVENT_RAW = {
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

test("parseEventBoundaryProfile: a fully valid entry returns an EventBoundaryProfile", () => {
  const result = parseEventBoundaryProfile(VALID_EVENT_RAW);
  assert.ok(result !== null, "expected a non-null profile for a valid entry");
  assert.equal(result.transport, "event");
  assert.equal(result.files, "**/*.java");
  assert.deepEqual(result.eventPattern, VALID_EVENT_RAW.eventPattern);
});

test("parseEventBoundaryProfile: missing transport returns null", () => {
  const { transport, ...rest } = VALID_EVENT_RAW;
  const result = parseEventBoundaryProfile(rest);
  assert.equal(result, null);
});

test("parseEventBoundaryProfile: unknown transport returns null", () => {
  const result = parseEventBoundaryProfile({ ...VALID_EVENT_RAW, transport: "grpc" });
  assert.equal(result, null);
});

test("parseEventBoundaryProfile: missing files returns null", () => {
  const { files, ...rest } = VALID_EVENT_RAW;
  const result = parseEventBoundaryProfile(rest);
  assert.equal(result, null);
});

test("parseEventBoundaryProfile: blank files returns null", () => {
  const result = parseEventBoundaryProfile({ ...VALID_EVENT_RAW, files: "   " });
  assert.equal(result, null);
});

test("parseEventBoundaryProfile: missing eventPattern returns null", () => {
  const { eventPattern, ...rest } = VALID_EVENT_RAW;
  const result = parseEventBoundaryProfile(rest);
  assert.equal(result, null);
});

test("parseEventBoundaryProfile: eventPattern missing kind returns null", () => {
  const { kind, ...restPattern } = VALID_EVENT_RAW.eventPattern;
  const result = parseEventBoundaryProfile({ ...VALID_EVENT_RAW, eventPattern: restPattern });
  assert.equal(result, null);
});

test("parseEventBoundaryProfile: eventPattern with an unknown (non-catalogued) kind returns null", () => {
  const result = parseEventBoundaryProfile({
    ...VALID_EVENT_RAW,
    eventPattern: { ...VALID_EVENT_RAW.eventPattern, kind: "unknown-shape" },
  });
  assert.equal(result, null);
});

test("parseEventBoundaryProfile: eventPattern missing listenerBaseType returns null", () => {
  const { listenerBaseType, ...restPattern } = VALID_EVENT_RAW.eventPattern;
  const result = parseEventBoundaryProfile({ ...VALID_EVENT_RAW, eventPattern: restPattern });
  assert.equal(result, null);
});

test("parseEventBoundaryProfile: eventPattern blank listenerEventCall returns null", () => {
  const result = parseEventBoundaryProfile({
    ...VALID_EVENT_RAW,
    eventPattern: { ...VALID_EVENT_RAW.eventPattern, listenerEventCall: "" },
  });
  assert.equal(result, null);
});

test("parseEventBoundaryProfile: eventPattern missing subscriberBaseType returns null", () => {
  const { subscriberBaseType, ...restPattern } = VALID_EVENT_RAW.eventPattern;
  const result = parseEventBoundaryProfile({ ...VALID_EVENT_RAW, eventPattern: restPattern });
  assert.equal(result, null);
});

test("parseEventBoundaryProfile: eventPattern missing publishCall returns null", () => {
  const { publishCall, ...restPattern } = VALID_EVENT_RAW.eventPattern;
  const result = parseEventBoundaryProfile({ ...VALID_EVENT_RAW, eventPattern: restPattern });
  assert.equal(result, null);
});

test("parseEventBoundaryProfile: entirely malformed input (null) returns null", () => {
  const result = parseEventBoundaryProfile(null);
  assert.equal(result, null);
});

// ==========================================
// YamlBoundaryProfileAdapter.forApp — dispatch by transport (step 3)
// ==========================================

const VALID_EVENT_YAML = `
boundaries:
  - transport: event
    files: "**/*.java"
    eventPattern:
      kind: class-based-domain-events
      listenerBaseType: "ListenerMessageDelegate"
      listenerEventCall: "convertMsgToSpecificType"
      subscriberBaseType: "DomainEventSubscriber"
      publishCall: "publishGenericMessage"
`;

test("YamlBoundaryProfileAdapter.forApp: a valid event boundaries[] entry returns one EventBoundaryProfile with the right fields", async () => {
  const adapter = new YamlBoundaryProfileAdapter(() => VALID_EVENT_YAML);
  const profiles = await adapter.forApp("some-app");
  assert.equal(profiles.length, 1);
  const profile = profiles[0]! as EventBoundaryProfile;
  assert.equal(profile.transport, "event");
  assert.equal(profile.files, "**/*.java");
  assert.equal(profile.eventPattern.kind, "class-based-domain-events");
  assert.equal(profile.eventPattern.listenerBaseType, "ListenerMessageDelegate");
});

test("YamlBoundaryProfileAdapter.forApp: an event entry with a missing required field is skipped with a warning (does not throw)", async () => {
  const yaml = `
boundaries:
  - transport: event
    eventPattern:
      kind: class-based-domain-events
      listenerBaseType: "ListenerMessageDelegate"
      listenerEventCall: "convertMsgToSpecificType"
      subscriberBaseType: "DomainEventSubscriber"
      publishCall: "publishGenericMessage"
`; // files field missing
  const adapter = new YamlBoundaryProfileAdapter(() => yaml);
  const profiles = await adapter.forApp("missing-files");
  assert.deepEqual(profiles, [], "an event entry missing the required files field must be skipped, not throw");
});

test("YamlBoundaryProfileAdapter.forApp: an event entry with an unknown eventPattern.kind is skipped with a warning", async () => {
  const yaml = `
boundaries:
  - transport: event
    files: "**/*.java"
    eventPattern:
      kind: mystery-shape
      listenerBaseType: "ListenerMessageDelegate"
      listenerEventCall: "convertMsgToSpecificType"
      subscriberBaseType: "DomainEventSubscriber"
      publishCall: "publishGenericMessage"
`;
  const adapter = new YamlBoundaryProfileAdapter(() => yaml);
  const profiles = await adapter.forApp("mystery-kind");
  assert.deepEqual(profiles, [], "an unknown eventPattern.kind cannot be resolved — skip it at load time");
});

test("YamlBoundaryProfileAdapter.forApp: a YAML with BOTH an http boundary and an event boundary returns both, correctly typed", async () => {
  const yaml = `
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
      listenerBaseType: "ListenerMessageDelegate"
      listenerEventCall: "convertMsgToSpecificType"
      subscriberBaseType: "DomainEventSubscriber"
      publishCall: "publishGenericMessage"
`;
  const adapter = new YamlBoundaryProfileAdapter(() => yaml);
  const profiles = await adapter.forApp("mixed-transports");
  assert.equal(profiles.length, 2, "expected both the http and the event entry to survive");

  const httpProfile = profiles.find((p): p is HttpBoundaryProfile => p.transport === "http");
  assert.ok(httpProfile, "expected an http profile in the mixed result");
  assert.equal(httpProfile.openApiPath, "src/main/resources/openapi/api-definition.yaml");

  const eventProfile = profiles.find((p): p is EventBoundaryProfile => p.transport === "event");
  assert.ok(eventProfile, "expected an event profile in the mixed result");
  assert.equal(eventProfile.eventPattern.kind, "class-based-domain-events");
});
