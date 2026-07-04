// test/contexts/qa-run-orchestration/infrastructure/bridges/service-links-port.adapter.test.ts
//
// RED for S1.3 (design §3.3): ServiceLinksPortAdapter composes an injected
// BoundaryProfileProviderPort + MirrorRegistryPort + the REAL buildServiceBoundaryResolver
// against on-disk-verified mirror dirs into ONE ServiceLinksPort.resolve() call. NEVER throws:
// every failure mode (missing mirror, empty profiles, resolver throw, a rejecting
// MirrorRegistryPort) degrades to { links: [], drift: [] }.
//
// The mirror-existence check is real (a temp directory with real files/subdirs), not a module
// mock, so the test stays honest about what existsSync actually sees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceLinksPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/service-links-port.adapter.ts";
import type { BoundaryProfileProviderPort } from "@contexts/service-topology/application/ports/index.ts";
import type { BoundaryProfile } from "@contexts/service-topology/domain/index.ts";
import type { MirrorRegistryPort } from "@kernel/ports/mirror-registry.port.ts";

function fakeMirrors(dirs: Record<string, string>): MirrorRegistryPort {
  return {
    mirrorDir: async (repo: string) => {
      const dir = dirs[repo];
      if (dir === undefined) throw new Error(`fakeMirrors: no dir registered for repo "${repo}"`);
      return dir;
    },
  };
}

function fakeProfiles(profiles: BoundaryProfile[]): BoundaryProfileProviderPort {
  return { forApp: async () => profiles };
}

// A REAL http profile against a REAL OpenAPI fixture, so the test exercises the ACTUAL
// resolver (buildServiceBoundaryResolver + OpenApiHttpResolver), not a re-mocked one.
const httpProfile: BoundaryProfile = {
  transport: "http",
  frontFiles: "*.api.ts",
  frontCallSite: { kind: "receiver-verb-call", receiver: "this.rest" },
  servicePrefixTemplate: "name-{service}-api",
  serviceRepoTemplate: "ms-name-{service}",
  openApiPath: "openapi.yaml",
};

test("happy path: real profiles + on-disk mirrors -> resolve() returns the resolver's real { links, drift }", async () => {
  const root = mkdtempSync(join(tmpdir(), "service-links-"));
  try {
    const frontDir = join(root, "front");
    const orderDir = join(root, "ms-name-orders");
    mkdirSync(frontDir, { recursive: true });
    mkdirSync(orderDir, { recursive: true });

    const mirrors = fakeMirrors({ "org/front": frontDir, "org/ms-orders": orderDir });
    const profiles = fakeProfiles([httpProfile]);
    const adapter = new ServiceLinksPortAdapter(profiles, mirrors, {
      appName: "app",
      primaryRepo: "org/front",
      services: [{ repo: "org/ms-orders" }],
    });

    const result = await adapter.resolve();
    assert.ok(Array.isArray(result.links), "links must be an array (real resolver output, empty because fixture has no matching source files)");
    assert.ok(Array.isArray(result.drift), "drift must be an array");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a service whose mirror dir does not exist on disk is OMITTED from system; remaining services still resolve", async () => {
  const root = mkdtempSync(join(tmpdir(), "service-links-"));
  try {
    const frontDir = join(root, "front");
    mkdirSync(frontDir, { recursive: true });
    const missingDir = join(root, "does-not-exist");

    const mirrors = fakeMirrors({ "org/front": frontDir, "org/ms-orders": missingDir });
    const profiles = fakeProfiles([httpProfile]);
    const adapter = new ServiceLinksPortAdapter(profiles, mirrors, {
      appName: "app",
      primaryRepo: "org/front",
      services: [{ repo: "org/ms-orders" }],
    });

    const result = await adapter.resolve();
    assert.deepEqual(result, { links: [], drift: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ALL services' mirror dirs missing -> resolve() returns { links: [], drift: [] } without calling the resolver", async () => {
  const root = mkdtempSync(join(tmpdir(), "service-links-"));
  try {
    const frontDir = join(root, "front");
    mkdirSync(frontDir, { recursive: true });

    const mirrors = fakeMirrors({ "org/front": frontDir, "org/ms-a": join(root, "missing-a"), "org/ms-b": join(root, "missing-b") });
    let forAppCalled = false;
    const profiles: BoundaryProfileProviderPort = {
      forApp: async () => {
        forAppCalled = true;
        return [httpProfile];
      },
    };
    const adapter = new ServiceLinksPortAdapter(profiles, mirrors, {
      appName: "app",
      primaryRepo: "org/front",
      services: [{ repo: "org/ms-a" }, { repo: "org/ms-b" }],
    });

    const result = await adapter.resolve();
    assert.deepEqual(result, { links: [], drift: [] });
    assert.equal(forAppCalled, false, "the resolver's profile source must never be constructed when system is empty");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("front (primary) mirror dir missing -> resolve() returns { links: [], drift: [] }", async () => {
  const root = mkdtempSync(join(tmpdir(), "service-links-"));
  try {
    const orderDir = join(root, "ms-name-orders");
    mkdirSync(orderDir, { recursive: true });

    const mirrors = fakeMirrors({ "org/front": join(root, "front-missing"), "org/ms-orders": orderDir });
    const profiles = fakeProfiles([httpProfile]);
    const adapter = new ServiceLinksPortAdapter(profiles, mirrors, {
      appName: "app",
      primaryRepo: "org/front",
      services: [{ repo: "org/ms-orders" }],
    });

    const result = await adapter.resolve();
    assert.deepEqual(result, { links: [], drift: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("empty profiles (boundaryProfiles.forApp returns []) -> { links: [], drift: [] }, resolver never constructed", async () => {
  const root = mkdtempSync(join(tmpdir(), "service-links-"));
  try {
    const frontDir = join(root, "front");
    const orderDir = join(root, "ms-name-orders");
    mkdirSync(frontDir, { recursive: true });
    mkdirSync(orderDir, { recursive: true });

    const mirrors = fakeMirrors({ "org/front": frontDir, "org/ms-orders": orderDir });
    const profiles = fakeProfiles([]);
    const adapter = new ServiceLinksPortAdapter(profiles, mirrors, {
      appName: "app",
      primaryRepo: "org/front",
      services: [{ repo: "org/ms-orders" }],
    });

    const result = await adapter.resolve();
    assert.deepEqual(result, { links: [], drift: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("boundaryProfiles.forApp THROWS -> caught by the adapter's own try/catch -> { links: [], drift: [] }, never propagates", async () => {
  const root = mkdtempSync(join(tmpdir(), "service-links-"));
  try {
    const frontDir = join(root, "front");
    const orderDir = join(root, "ms-name-orders");
    mkdirSync(frontDir, { recursive: true });
    mkdirSync(orderDir, { recursive: true });

    const mirrors = fakeMirrors({ "org/front": frontDir, "org/ms-orders": orderDir });
    const profiles: BoundaryProfileProviderPort = {
      forApp: async () => {
        throw new Error("boom");
      },
    };
    const adapter = new ServiceLinksPortAdapter(profiles, mirrors, {
      appName: "app",
      primaryRepo: "org/front",
      services: [{ repo: "org/ms-orders" }],
    });

    await assert.doesNotReject(async () => {
      const result = await adapter.resolve();
      assert.deepEqual(result, { links: [], drift: [] });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "MirrorRegistryPort.mirrorDir() REJECTS (not just resolves to a missing path) -> caught ONLY at the whole-resolve() " +
    "try/catch level (Promise.all rejection bubbles past the per-RepoRef existsSync check) -> still degrades to " +
    "{ links: [], drift: [] }, never throws past the adapter boundary. (ADR-2 nuance: per-RepoRef isolation via " +
    "existsSync holds for a resolving-but-missing path; a REJECTING port method is a different failure granularity — " +
    "whole-resolve(), not per-service. Moot for the concrete synchronous-join MirrorRegistryAdapter, which cannot " +
    "reject, but a future MirrorRegistryPort implementation that CAN reject must know this granularity guarantee.)",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "service-links-"));
    try {
      const frontDir = join(root, "front");
      mkdirSync(frontDir, { recursive: true });

      const rejectingMirrors: MirrorRegistryPort = {
        mirrorDir: async (repo: string) => {
          if (repo === "org/front") return frontDir;
          throw new Error("mirror registry unavailable");
        },
      };
      const profiles = fakeProfiles([httpProfile]);
      const adapter = new ServiceLinksPortAdapter(profiles, rejectingMirrors, {
        appName: "app",
        primaryRepo: "org/front",
        services: [{ repo: "org/ms-orders" }],
      });

      await assert.doesNotReject(async () => {
        const result = await adapter.resolve();
        assert.deepEqual(result, { links: [], drift: [] });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
