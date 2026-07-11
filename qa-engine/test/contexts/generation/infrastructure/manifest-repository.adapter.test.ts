// test/contexts/generation/infrastructure/manifest-repository.adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ManifestRepositoryAdapter } from "@contexts/generation/infrastructure/manifest-repository.adapter.ts";

// migration-tier-4b Slice 2: ManifestEntry's targets/changeRef are now REQUIRED at the type level
// (the canonical @kernel/manifest/manifest-entry.ts shape) — every fixture below is updated to
// populate both, matching what every LIVE writer (generate-tests.use-case.ts's rawEntries) already does.

test("read delegates to the injected manifest reader", async () => {
  let seenDir = "";
  const adapter = new ManifestRepositoryAdapter({
    readManifest: async (dir) => { seenDir = dir; return [{ id: "1", file: "e2e/a.spec.ts", flow: "login", objective: "o", targets: ["t"], changeRef: { sha: "s", type: "feat" } }]; },
    reconcileManifest: async (_dir, entries) => [...entries],
  });
  const entries = await adapter.read("/m/e2e");
  assert.equal(seenDir, "/m/e2e");
  assert.equal(entries[0]?.id, "1");
});

test("reconcile delegates and forwards the on-disk-pruned entries", async () => {
  let called = false;
  const adapter = new ManifestRepositoryAdapter({
    readManifest: async () => [],
    reconcileManifest: async (_dir, entries) => { called = true; return entries.filter((e) => e.id !== "stale"); },
  });
  const out = await adapter.reconcile("/m/e2e", [
    { id: "1", file: "e2e/a.spec.ts", flow: "f", objective: "o", targets: ["t"], changeRef: { sha: "s", type: "feat" } },
    { id: "stale", file: "e2e/x.spec.ts", flow: "f", objective: "o", targets: ["t"], changeRef: { sha: "s", type: "feat" } },
  ]);
  assert.equal(called, true);
  assert.deepEqual(out.map((e) => e.id), ["1"]); // stale entry pruned by the injected reconcile
});
