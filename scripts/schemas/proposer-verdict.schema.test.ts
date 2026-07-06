import { test } from "node:test";
import assert from "node:assert/strict";
import { ProposerVerdictSchema, UNPARSEABLE_SENTINEL } from "./proposer-verdict.schema.ts";

// ── behavior tests — spec Requirement B (B1-B3) ────────────────────────────────

test("ProposerVerdictSchema: parses a valid http candidate into a well-formed profile", () => {
  const input = {
    candidates: [
      {
        transport: "http",
        frontFiles: "**/*.api.ts",
        frontCallSite: { kind: "receiver-verb-call", receiver: "this.rest" },
        servicePrefixTemplate: "name-{service}-api",
        serviceRepoTemplate: "ms-name-{service}",
        openApiPath: "openapi.json",
      },
    ],
  };
  const result = ProposerVerdictSchema.parse(input);
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0];
  assert.equal(candidate?.transport, "http");
  if (candidate?.transport === "http") {
    assert.equal(candidate.frontFiles, "**/*.api.ts");
    assert.equal(candidate.frontCallSite.kind, "receiver-verb-call");
    assert.equal(candidate.frontCallSite.receiver, "this.rest");
    assert.equal(candidate.servicePrefixTemplate, "name-{service}-api");
    assert.equal(candidate.serviceRepoTemplate, "ms-name-{service}");
    assert.equal(candidate.openApiPath, "openapi.json");
  }
});

test("ProposerVerdictSchema: parses a valid event candidate into a well-formed profile", () => {
  const input = {
    candidates: [
      {
        transport: "event",
        files: "**/*.java",
        eventPattern: {
          kind: "class-based-domain-events",
          listenerBaseType: "ListenerMessageDelegate",
          listenerEventCall: "convertMsgToSpecificType",
          subscriberBaseType: "DomainEventSubscriber",
          publishCall: "publishGenericMessage",
        },
      },
    ],
  };
  const result = ProposerVerdictSchema.parse(input);
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0];
  assert.equal(candidate?.transport, "event");
  if (candidate?.transport === "event") {
    assert.equal(candidate.files, "**/*.java");
    assert.equal(candidate.eventPattern.kind, "class-based-domain-events");
    assert.equal(candidate.eventPattern.listenerBaseType, "ListenerMessageDelegate");
    assert.equal(candidate.eventPattern.listenerEventCall, "convertMsgToSpecificType");
    assert.equal(candidate.eventPattern.subscriberBaseType, "DomainEventSubscriber");
    assert.equal(candidate.eventPattern.publishCall, "publishGenericMessage");
  }
});

test("ProposerVerdictSchema: a malformed middle entry is dropped (sentinel), valid siblings survive", () => {
  const input = {
    candidates: [
      {
        transport: "http",
        frontFiles: "**/*.api.ts",
        frontCallSite: { kind: "receiver-verb-call" },
        servicePrefixTemplate: "name-{service}-api",
        serviceRepoTemplate: "ms-name-{service}",
        openApiPath: "openapi.json",
      },
      {
        // malformed: missing required eventPattern.publishCall
        transport: "event",
        files: "**/*.java",
        eventPattern: {
          kind: "class-based-domain-events",
          listenerBaseType: "ListenerMessageDelegate",
          listenerEventCall: "convertMsgToSpecificType",
          subscriberBaseType: "DomainEventSubscriber",
          // publishCall intentionally omitted
        },
      },
      {
        transport: "event",
        files: "**/*.java",
        eventPattern: {
          kind: "class-based-domain-events",
          listenerBaseType: "ListenerMessageDelegate",
          listenerEventCall: "convertMsgToSpecificType",
          subscriberBaseType: "DomainEventSubscriber",
          publishCall: "publishGenericMessage",
        },
      },
    ],
  };
  const result = ProposerVerdictSchema.parse(input);
  assert.equal(result.candidates.length, 3);
  assert.equal(result.candidates[0]?.transport, "http");
  // entry #2 degrades to the recognizable sentinel, not dropped from the array (per-entry .catch)
  assert.deepEqual(result.candidates[1], UNPARSEABLE_SENTINEL);
  assert.equal(result.candidates[2]?.transport, "event");
  if (result.candidates[2]?.transport === "event") {
    assert.equal(result.candidates[2].eventPattern.publishCall, "publishGenericMessage");
  }
});

test("ProposerVerdictSchema: non-array candidates degrades to empty array via outer .catch([])", () => {
  const result = ProposerVerdictSchema.parse({ candidates: "not-an-array" });
  assert.deepEqual(result.candidates, []);
});

test("ProposerVerdictSchema: missing candidates key degrades to empty array", () => {
  const result = ProposerVerdictSchema.parse({});
  assert.deepEqual(result.candidates, []);
});

test("ProposerVerdictSchema: totally unparseable top-level shape degrades to empty array", () => {
  const result = ProposerVerdictSchema.parse("not even an object");
  assert.deepEqual(result.candidates, []);
});

test("UNPARSEABLE_SENTINEL is a recognizable, valid-shape http profile", () => {
  assert.equal(UNPARSEABLE_SENTINEL.transport, "http");
  if (UNPARSEABLE_SENTINEL.transport === "http") {
    assert.equal(UNPARSEABLE_SENTINEL.frontFiles, "__UNPARSEABLE__");
  }
});
