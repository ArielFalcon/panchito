// test/contexts/workspace-and-publication/infrastructure/mirror-gc.adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { MirrorGcAdapter } from "@contexts/workspace-and-publication/infrastructure/mirror-gc.adapter.ts";

test("prune delegates to the injected gc fn with the mirrorDir", async () => {
  let seen: string | null = null;
  const adapter = new MirrorGcAdapter(async (dir) => { seen = dir; });
  await adapter.prune("/mirrors/org-app");
  assert.equal(seen, "/mirrors/org-app");
});

test("prune delegates with a different mirrorDir (no hardcoded path)", async () => {
  const seen: string[] = [];
  const adapter = new MirrorGcAdapter(async (dir) => { seen.push(dir); });
  await adapter.prune("/mirrors/repo-a");
  await adapter.prune("/mirrors/repo-b");
  assert.deepEqual(seen, ["/mirrors/repo-a", "/mirrors/repo-b"]);
});

test("errors from the injected gc fn propagate (not swallowed)", async () => {
  const adapter = new MirrorGcAdapter(async () => { throw new Error("gc failed"); });
  await assert.rejects(() => adapter.prune("/m"), /gc failed/);
});
