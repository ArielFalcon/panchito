// src/server/onboarding/write-boundaries.test.ts
// TDD (strict): write failing tests first, then implement.
// serializeBoundary() is the exact hand-built inverse of the REAL read-side parser
// (yaml-boundary-profile.adapter.ts) — the round-trip tests below drive that REAL parser
// (via YamlBoundaryProfileAdapter, reader-injected) so a drift between the two never ships
// silently. spliceBoundariesBlock() must be idempotent and must never touch any OTHER
// `${VAR}` placeholder or comment elsewhere in the document (spec C1, C4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { YamlBoundaryProfileAdapter } from "@contexts/service-topology/infrastructure/yaml-boundary-profile.adapter";
import type { HttpBoundaryProfile, EventBoundaryProfile } from "@contexts/service-topology/domain/index.ts";
import { serializeBoundary, spliceBoundariesBlock } from "./write-boundaries";

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

async function roundTrip(profile: HttpBoundaryProfile | EventBoundaryProfile) {
  const lines = serializeBoundary(profile);
  const yaml = ["name: \"fixture\"", "repo: \"org/fixture\"", "boundaries:", ...lines].join("\n");
  const adapter = new YamlBoundaryProfileAdapter(() => yaml);
  return adapter.forApp("fixture");
}

// ── round-trip via the REAL read-side parser (spec C1) ─────────────────────────

test("serializeBoundary: an http profile round-trips through the real parser unchanged", async () => {
  const profiles = await roundTrip(HTTP_PROFILE);
  assert.equal(profiles.length, 1);
  assert.deepEqual(profiles[0], HTTP_PROFILE);
});

test("serializeBoundary: an event profile round-trips through the real parser unchanged", async () => {
  const profiles = await roundTrip(EVENT_PROFILE);
  assert.equal(profiles.length, 1);
  assert.deepEqual(profiles[0], EVENT_PROFILE);
});

test("serializeBoundary: an http profile without an optional receiver round-trips unchanged", async () => {
  const profile: HttpBoundaryProfile = {
    ...HTTP_PROFILE,
    frontCallSite: { kind: "receiver-verb-call" },
  };
  const profiles = await roundTrip(profile);
  assert.equal(profiles.length, 1);
  assert.deepEqual(profiles[0], profile);
});

// ── idempotent splice (spec C4) ─────────────────────────────────────────────────

test("spliceBoundariesBlock: writing the same profile twice leaves exactly one boundaries: block", () => {
  const original = [
    'name: "fixture"',
    'repo: "org/fixture"',
    "",
    "dev:",
    '  baseUrl: "https://dev.example.internal"',
    "",
  ].join("\n");

  const once = spliceBoundariesBlock(original, serializeBoundary(HTTP_PROFILE));
  const twice = spliceBoundariesBlock(once, serializeBoundary(HTTP_PROFILE));

  const blockCount = (twice.match(/^boundaries:/gm) ?? []).length;
  assert.equal(blockCount, 1, "exactly one top-level boundaries: key must remain");
  assert.equal(once, twice, "splicing an identical profile a second time is a no-op");
});

test("spliceBoundariesBlock: replaces an existing boundaries: block with the new one, not appending", () => {
  const original = [
    'name: "fixture"',
    'repo: "org/fixture"',
    "boundaries:",
    "  - transport: http",
    '    frontFiles: "**/*.old.ts"',
    "    frontCallSite: { kind: receiver-verb-call, receiver: \"this.old\" }",
    '    servicePrefixTemplate: "old-{service}-api"',
    '    serviceRepoTemplate: "ms-old-{service}"',
    '    openApiPath: "old-openapi.yaml"',
    "dev:",
    '  baseUrl: "https://dev.example.internal"',
    "",
  ].join("\n");

  const replaced = spliceBoundariesBlock(original, serializeBoundary(EVENT_PROFILE));

  assert.equal((replaced.match(/^boundaries:/gm) ?? []).length, 1);
  assert.ok(!replaced.includes("old-openapi.yaml"), "the stale block must be fully removed");
  assert.ok(replaced.includes("class-based-domain-events"), "the new block must be present");
  assert.ok(replaced.includes('baseUrl: "https://dev.example.internal"'), "content after the old block must survive");
});

test("spliceBoundariesBlock: appends a boundaries: block when absent", () => {
  const original = ['name: "fixture"', 'repo: "org/fixture"', ""].join("\n");
  const spliced = spliceBoundariesBlock(original, serializeBoundary(HTTP_PROFILE));

  assert.equal((spliced.match(/^boundaries:/gm) ?? []).length, 1);
  assert.ok(spliced.includes("**/*.api.ts"));
});

// ── ${VAR} placeholders and comments elsewhere stay byte-identical (spec C1) ────

test("spliceBoundariesBlock: never touches ${VAR} placeholders or comments outside the boundaries block", () => {
  const original = [
    "# Watched-app template. COPY to config/apps/<your-app>.yaml and fill it in.",
    "# ${VARS} are expanded from the environment (.env) — do not put secrets here.",
    "",
    'name: "fixture"',
    'repo: "org/fixture"',
    "",
    "dev:",
    '  baseUrl: "${DEV_BASE_URL}"',
    '  versionUrl: "${DEV_VERSION_URL}"',
    "",
    "qa:",
    "  needsReview: true",
    "",
  ].join("\n");

  const spliced = spliceBoundariesBlock(original, serializeBoundary(HTTP_PROFILE));

  const untouchedLines = original.split("\n").filter((l) => !l.startsWith("boundaries:"));
  for (const line of untouchedLines) {
    assert.ok(spliced.includes(line), `expected untouched line to survive byte-identical: ${line}`);
  }
});

// ── adversarial: unescaped double-quoted scalars corrupt the document (review finding #1) ──
// Every value below is LLM-sourced free-form text. serializeBoundary interpolates it into a
// bare `"..."` scalar with no escaping. The real read-side parser (YamlBoundaryProfileAdapter)
// either throws YAMLParseError (swallowed internally into an empty []) or, worse, silently
// misinterprets a raw backslash as a YAML escape sequence — both are corruption, not a
// round-trip. Each case below must satisfy parse(serialize(x)) deep-equals x.

test("serializeBoundary: an http profile with a double quote in frontFiles round-trips unchanged", async () => {
  const profile: HttpBoundaryProfile = { ...HTTP_PROFILE, frontFiles: '**/*."weird".ts' };
  const profiles = await roundTrip(profile);
  assert.equal(profiles.length, 1);
  assert.deepEqual(profiles[0], profile);
});

test("serializeBoundary: an http profile with a backslash in frontCallSite.receiver round-trips unchanged", async () => {
  const profile: HttpBoundaryProfile = {
    ...HTTP_PROFILE,
    frontCallSite: { kind: "receiver-verb-call", receiver: "this.rest\\api" },
  };
  const profiles = await roundTrip(profile);
  assert.equal(profiles.length, 1);
  assert.deepEqual(profiles[0], profile);
});

test("serializeBoundary: an http profile with an embedded newline in servicePrefixTemplate round-trips unchanged", async () => {
  const profile: HttpBoundaryProfile = {
    ...HTTP_PROFILE,
    servicePrefixTemplate: "name-{service}-api\nrogue: injected",
  };
  const profiles = await roundTrip(profile);
  assert.equal(profiles.length, 1);
  assert.deepEqual(profiles[0], profile);
});

test("serializeBoundary: an http profile with a colon in serviceRepoTemplate round-trips unchanged", async () => {
  const profile: HttpBoundaryProfile = { ...HTTP_PROFILE, serviceRepoTemplate: "ms-name-{service}: v2" };
  const profiles = await roundTrip(profile);
  assert.equal(profiles.length, 1);
  assert.deepEqual(profiles[0], profile);
});

test("serializeBoundary: an http profile with a hash in openApiPath round-trips unchanged", async () => {
  const profile: HttpBoundaryProfile = { ...HTTP_PROFILE, openApiPath: "src/main/resources/openapi/api#v2.yaml" };
  const profiles = await roundTrip(profile);
  assert.equal(profiles.length, 1);
  assert.deepEqual(profiles[0], profile);
});

test("serializeBoundary: an event profile with a double quote in files round-trips unchanged", async () => {
  const profile: EventBoundaryProfile = { ...EVENT_PROFILE, files: '**/*."weird".java' };
  const profiles = await roundTrip(profile);
  assert.equal(profiles.length, 1);
  assert.deepEqual(profiles[0], profile);
});

test("serializeBoundary: an event profile with a backslash and newline across every eventPattern string round-trips unchanged", async () => {
  const profile: EventBoundaryProfile = {
    ...EVENT_PROFILE,
    eventPattern: {
      kind: "class-based-domain-events",
      listenerBaseType: 'Listener"Base\\Type',
      listenerEventCall: "convertMsgToSpecificType\ninjected: true",
      subscriberBaseType: "Domain\\EventSubscriber",
      publishCall: 'publish"GenericMessage',
    },
  };
  const profiles = await roundTrip(profile);
  assert.equal(profiles.length, 1);
  assert.deepEqual(profiles[0], profile);
});

test("serializeBoundary: a value containing a double quote does not inject a rogue structural line into the surrounding document", async () => {
  const profile: HttpBoundaryProfile = {
    ...HTTP_PROFILE,
    servicePrefixTemplate: 'name-{service}-api"\nrogueKey: "injected',
  };
  const lines = serializeBoundary(profile);
  const yaml = ["name: \"fixture\"", "repo: \"org/fixture\"", "boundaries:", ...lines, "dev:", "  baseUrl: \"https://dev.example.internal\""].join("\n");
  const adapter = new YamlBoundaryProfileAdapter(() => yaml);
  const profiles = await adapter.forApp("fixture");
  assert.equal(profiles.length, 1, "the malicious value must not corrupt the document structure");
  assert.deepEqual(profiles[0], profile);
});

// ── adversarial: a top-level comment after the boundaries block is swallowed (review finding #2) ──

test("spliceBoundariesBlock: a top-level comment after the block survives a re-splice byte-identical", () => {
  // No blank-line separator between the block's last child and the comment — this is the exact
  // shape that swallows the comment (endsBoundariesBlock only stops at a blank line or a
  // non-indented `key:` line; a non-indented `#comment` line matches neither).
  const original = [
    'name: "fixture"',
    'repo: "org/fixture"',
    "boundaries:",
    "  - transport: http",
    '    frontFiles: "**/*.old.ts"',
    "    frontCallSite: { kind: receiver-verb-call, receiver: \"this.old\" }",
    '    servicePrefixTemplate: "old-{service}-api"',
    '    serviceRepoTemplate: "ms-old-{service}"',
    '    openApiPath: "old-openapi.yaml"',
    "# a top-level comment describing the next section",
    "dev:",
    '  baseUrl: "https://dev.example.internal"',
    "",
  ].join("\n");

  const once = spliceBoundariesBlock(original, serializeBoundary(HTTP_PROFILE));
  const twice = spliceBoundariesBlock(once, serializeBoundary(HTTP_PROFILE));

  assert.ok(
    once.includes("# a top-level comment describing the next section"),
    "the top-level comment must survive the first splice",
  );
  assert.equal(
    (once.match(/^boundaries:/gm) ?? []).length,
    1,
    "exactly one top-level boundaries: block after the first splice",
  );
  assert.equal(once, twice, "a second splice must be a byte-identical no-op, including the comment");
});

test("spliceBoundariesBlock: an indented comment inside the block is replaced along with the block, not preserved", () => {
  // Contrast with the top-level-comment test above: an INDENTED `#comment` line between the
  // block's children is still part of the block's own content and must be replaced/removed
  // along with the rest of the stale block, not treated as a document-level boundary.
  const original = [
    'name: "fixture"',
    'repo: "org/fixture"',
    "boundaries:",
    "  - transport: http",
    '    frontFiles: "**/*.old.ts"',
    "    frontCallSite: { kind: receiver-verb-call, receiver: \"this.old\" }",
    "    # an indented comment describing the next field",
    '    servicePrefixTemplate: "old-{service}-api"',
    '    serviceRepoTemplate: "ms-old-{service}"',
    '    openApiPath: "old-openapi.yaml"',
    "dev:",
    '  baseUrl: "https://dev.example.internal"',
    "",
  ].join("\n");

  const replaced = spliceBoundariesBlock(original, serializeBoundary(EVENT_PROFILE));

  assert.ok(
    !replaced.includes("# an indented comment describing the next field"),
    "an indented comment belonging to the stale block must be replaced away with it",
  );
  assert.ok(replaced.includes('baseUrl: "https://dev.example.internal"'), "content after the old block must survive");
});

// ── defense in depth: unquoted `kind` interpolation (review finding #3) ──

test("serializeBoundary: a frontCallSite.kind containing a colon still yields structurally valid YAML", async () => {
  const profile: HttpBoundaryProfile = {
    ...HTTP_PROFILE,
    frontCallSite: { kind: "receiver-verb-call: rogue", receiver: "this.rest" },
  };
  const lines = serializeBoundary(profile);
  const yaml = ["name: \"fixture\"", "repo: \"org/fixture\"", "boundaries:", ...lines].join("\n");
  const adapter = new YamlBoundaryProfileAdapter(() => yaml);
  // The unknown/malformed kind is correctly rejected by the read-side catalog check (warn+skip,
  // see parseHttpBoundaryProfile) — that is expected domain behavior, not corruption. What must
  // NOT happen is the flow-map syntax itself breaking (a bare, unquoted colon inside `{ ... }`
  // throws "Block collections are not allowed within flow collections", which would abort
  // parsing the WHOLE document rather than just skipping this one malformed entry).
  const profiles = await adapter.forApp("fixture");
  assert.equal(profiles.length, 0, "an unknown kind is rejected by the catalog check, not a parse crash");
});
