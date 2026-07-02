// test/contexts/service-topology/infrastructure/level3-wiring.test.ts
// TDD: Level 3 wiring tests.
// 1. MirrorRegistryPort + StubMirrorRegistryAdapter
// 2. OpencodeRunInput.serviceLinks field presence and renderMain prompt section
// 3. GenerateTestsUseCase with optional ServiceBoundaryResolverPort
import { test } from "node:test";
import assert from "node:assert/strict";
import { StubMirrorRegistryAdapter } from "@contexts/service-topology/infrastructure/stub-mirror-registry.adapter.ts";
import type { MirrorRegistryPort } from "@kernel/ports/mirror-registry.port.ts";
import type { OpencodeRunInput } from "@contexts/generation/application/ports/generation-ports.ts";
import type { ServiceLink } from "@contexts/service-topology/domain/index.ts";
import type { GenerationPorts } from "@contexts/generation/application/generate-tests.use-case.ts";
import { GenerateTestsUseCase } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { ManifestEntry } from "@contexts/generation/application/ports/index.ts";

// ---- L3.1: MirrorRegistryPort + StubMirrorRegistryAdapter ----
// The stub must implement the port contract:
//   mirrorDir(repo: string): Promise<string>
// The stub must return a path (not throw) for any repo.

test("L3.1: StubMirrorRegistryAdapter implements MirrorRegistryPort and resolves any repo", async () => {
  const stub: MirrorRegistryPort = new StubMirrorRegistryAdapter();
  const path = await stub.mirrorDir("ArielFalcon/ms-name-orders");
  // The stub should return a non-empty string (the mirror dir path)
  assert.ok(typeof path === "string" && path.length > 0, `expected a non-empty string, got "${path}"`);
});

test("L3.1: StubMirrorRegistryAdapter returns a consistent path for the same repo", async () => {
  const stub: MirrorRegistryPort = new StubMirrorRegistryAdapter();
  const a = await stub.mirrorDir("org/repo");
  const b = await stub.mirrorDir("org/repo");
  assert.equal(a, b, "same repo should return the same path on each call");
});

// ---- L3.2: OpencodeRunInput.serviceLinks field ----
// The field must be optional (no existing tests break) and accept ServiceLink[].

test("L3.2: OpencodeRunInput accepts serviceLinks as an optional field", () => {
  const link: ServiceLink = {
    from: { repo: "front/webapp", file: "src/api.ts", symbol: "listOrders" },
    to: { repo: "back/api", file: "openapi.yaml", symbol: "listOrders" },
    transport: "http",
    contractRef: "listOrders",
    confidence: 1.0,
    source: "openapi-http",
  };
  // Construct an OpencodeRunInput with serviceLinks — must compile and be assignable.
  const input: OpencodeRunInput = {
    repo: "org/demo",
    sha: "abc",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    needsReview: false,
    target: "e2e",
    mode: "diff",
    appName: "a",
    serviceLinks: [link],
  };
  assert.ok(Array.isArray(input.serviceLinks), "serviceLinks should be an array");
  assert.equal(input.serviceLinks?.length, 1, "expected one serviceLink");
  assert.equal(input.serviceLinks?.[0]?.contractRef, "listOrders");
});

test("L3.2: OpencodeRunInput without serviceLinks is still valid (optional field)", () => {
  const input: OpencodeRunInput = {
    repo: "org/demo",
    sha: "abc",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    needsReview: false,
    target: "e2e",
    mode: "diff",
    appName: "a",
  };
  // serviceLinks is absent → no error, behaves as existing code
  assert.equal(input.serviceLinks, undefined, "serviceLinks is absent when not provided");
});

// ---- L3.3: GenerateTestsUseCase propagates serviceLinks to renderMain intact ----
// NOTE: no production renderMain implementation renders a "CROSS-REPO LINKS" prompt section
// from serviceLinks yet (that rendering is deferred to the runtime-wiring step — see the
// comment on OpencodeRunInput.serviceLinks in generation-ports.ts). What IS real today is that
// GenerateTestsUseCase.generate() passes the full OpencodeRunInput through to
// rendering.renderMain(input) unchanged — so serviceLinks (or its absence) reaches renderMain
// intact. These tests assert only that real propagation, via a stub renderMain that captures
// the input it received — the stub does NOT masquerade as production prompt rendering.

function makeGenerationPorts(capturedInput: { value: OpencodeRunInput | undefined }): GenerationPorts {
  return {
    runtime: {
      openSession: async () => ({
        prompt: async () => ({ output: '{"specs":[]}' }),
        dispose: () => {},
      }),
    },
    rendering: {
      render: () => "",
      renderMain: (input: OpencodeRunInput) => {
        // Stub renderMain: captures the input it was called with so the test can assert on
        // what the use-case PASSED, not on any rendering behavior (none is implemented here).
        capturedInput.value = input;
        return { text: "BASE_PROMPT", sectionSizes: {} };
      },
      renderWorker: () => ({ text: "", sectionSizes: {} }),
      renderReviewer: () => ({ text: "", sectionSizes: {} }),
      renderExplorer: () => "",
      specFileForFlow: (flow: string) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: () => ({ specs: [], parsed: true }),
      parseReview: () => ({ approved: true, corrections: [], valid: true, issues: [] }),
    },
    manifest: {
      read: async () => [],
      reconcile: async (_d: string, e: readonly ManifestEntry[]) => [...e] as ManifestEntry[],
    },
    budget: {
      capDiff: (d: string) => d,
      capText: (t: string) => t,
      budgetForRole: () => 0,
    },
  };
}

test("L3.3: GenerateTestsUseCase propagates serviceLinks to renderMain intact when present", async () => {
  const capturedInput: { value: OpencodeRunInput | undefined } = { value: undefined };
  const ports = makeGenerationPorts(capturedInput);
  const useCase = new GenerateTestsUseCase(ports);
  const link: ServiceLink = {
    from: { repo: "front/webapp", file: "src/orders.api.ts", symbol: "listOrders" },
    to: { repo: "back/api", file: "openapi.yaml", symbol: "listOrders" },
    transport: "http",
    contractRef: "listOrders",
    confidence: 1.0,
    source: "openapi-http",
  };
  await useCase.generate({
    repo: "org/demo",
    sha: "abc",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    needsReview: false,
    target: "e2e",
    mode: "diff",
    appName: "a",
    serviceLinks: [link],
  });
  assert.ok(capturedInput.value?.serviceLinks, "the use-case must pass serviceLinks through to renderMain");
  assert.equal(capturedInput.value?.serviceLinks?.length, 1);
  assert.equal(
    capturedInput.value?.serviceLinks?.[0],
    link,
    "renderMain must receive the SAME link object the use-case was given (passed through, not transformed)",
  );
});

test("L3.3: GenerateTestsUseCase passes serviceLinks as absent to renderMain when not provided", async () => {
  const capturedInput: { value: OpencodeRunInput | undefined } = { value: undefined };
  const ports = makeGenerationPorts(capturedInput);
  const useCase = new GenerateTestsUseCase(ports);
  await useCase.generate({
    repo: "org/demo",
    sha: "abc",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    needsReview: false,
    target: "e2e",
    mode: "diff",
    appName: "a",
    // serviceLinks absent
  });
  assert.equal(
    capturedInput.value?.serviceLinks,
    undefined,
    "renderMain must receive serviceLinks as undefined when the use-case was not given any",
  );
});
