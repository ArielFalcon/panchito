// qa-engine/test/contexts/service-topology/infrastructure/mirror-registry.adapter.test.ts
//
// RED for S1.2 (design §3.2): MirrorRegistryAdapter is the production MirrorRegistryPort —
// the Phase-3 real implementation that replaces StubMirrorRegistryAdapter in ACTIVE
// composition. Single-sources the working-copy naming formula
// `join(mirrorRoot, repo.replaceAll("/", "__"))` — the SAME formula the repo-mirror
// working-copy factory already uses — reached ONLY through the port method (mirrorDir),
// never via a static shortcut.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MirrorRegistryAdapter } from "@contexts/service-topology/infrastructure/mirror-registry.adapter.ts";

test("mirrorDir(repo) resolves to join(mirrorRoot, repo.replaceAll('/', '__'))", async () => {
  const adapter = new MirrorRegistryAdapter("/mirrors");
  const dir = await adapter.mirrorDir("org/ms-orders");
  assert.equal(dir, "/mirrors/org__ms-orders");
});

test("replaceAll semantics: EVERY '/' in the repo identity is replaced, not just the first", async () => {
  const adapter = new MirrorRegistryAdapter("/mirrors");
  const dir = await adapter.mirrorDir("org/team/ms-orders");
  assert.equal(dir, "/mirrors/org__team__ms-orders");
  // A regression that only replaces the FIRST slash would produce "/mirrors/org__team/ms-orders" —
  // assert the full string, not just a substring, so that regression is caught.
  assert.ok(!dir.includes("/ms-orders"), "no bare '/' must survive the encoding");
});

test("mirrorDir is reached through the MirrorRegistryPort interface (no static shortcut)", async () => {
  const adapter: import("@kernel/ports/mirror-registry.port.ts").MirrorRegistryPort = new MirrorRegistryAdapter(
    "/mirrors",
  );
  const dir = await adapter.mirrorDir("org/svc");
  assert.equal(dir, "/mirrors/org__svc");
});
