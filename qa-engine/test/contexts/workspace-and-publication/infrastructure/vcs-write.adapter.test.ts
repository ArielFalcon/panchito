// test/contexts/workspace-and-publication/infrastructure/vcs-write.adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { VcsWriteAdapter } from "@contexts/workspace-and-publication/infrastructure/vcs-write.adapter.ts";

test("commit stages the files and commits with the message", async () => {
  const calls: string[][] = [];
  const adapter = new VcsWriteAdapter(async (args) => { calls.push(args); return ""; });
  await adapter.commit("/m", "test(e2e): qa", ["e2e/a.spec.ts"]);
  assert.deepEqual(calls[0], ["add", "--", "e2e/a.spec.ts"]);
  assert.ok(calls[1]?.includes("commit"));
  assert.ok(calls[1]?.includes("test(e2e): qa"));
});

test("push force-with-leases the branch to origin", async () => {
  const calls: string[][] = [];
  const adapter = new VcsWriteAdapter(async (args) => { calls.push(args); return ""; });
  await adapter.push("/m", "qa/e2e-abc");
  assert.ok(calls[0]?.includes("push"));
  assert.ok(calls[0]?.includes("--force-with-lease"));
  assert.ok(calls[0]?.includes("qa/e2e-abc"));
});

// PROD-BLOCKER fix: the rewritten publish path never staged/committed/pushed the agent's generated
// tests before calling GitHub's PR API (VcsWriteAdapter was never instantiated in composition-root
// — grep-confirmed zero references outside this test file). Widening this adapter with the
// remaining legacy git-mechanics primitives (src/integrations/publish.ts's publishChanges: checkout
// -B, status-check/skip-if-no-changes, and the local-exclude write) so it becomes the complete git
// side of publish — reused by the PublicationPortAdapter "pr" route (publication-port.adapter.ts)
// via a duck-typed collaborator interface, never a direct import (arch-lint confinement).

test("checkoutBranch creates/resets the branch with checkout -B", async () => {
  const calls: string[][] = [];
  const adapter = new VcsWriteAdapter(async (args) => { calls.push(args); return ""; });
  await adapter.checkoutBranch("/m", "qa/e2e-abc1234");
  assert.deepEqual(calls[0], ["checkout", "-B", "qa/e2e-abc1234"]);
});

test("hasChanges returns true when git status --porcelain reports changes under the given pathspecs", async () => {
  const adapter = new VcsWriteAdapter(async () => "M e2e/login.spec.ts\n");
  const changed = await adapter.hasChanges("/m", ["e2e"]);
  assert.equal(changed, true);
});

test("hasChanges returns false when git status --porcelain is empty for the given pathspecs (skip-if-no-changes)", async () => {
  const adapter = new VcsWriteAdapter(async () => "");
  const changed = await adapter.hasChanges("/m", ["e2e"]);
  assert.equal(changed, false);
});

test("hasChanges scopes the status check to the exact pathspecs (never the whole repo)", async () => {
  const calls: string[][] = [];
  const adapter = new VcsWriteAdapter(async (args) => { calls.push(args); return ""; });
  await adapter.hasChanges("/m", ["e2e"]);
  assert.deepEqual(calls[0], ["status", "--porcelain", "--", "e2e"]);
});

test("writeExcludes writes gitignore-style patterns to .git/info/exclude (local, never committed)", async () => {
  const writes: { dir: string; patterns: readonly string[] }[] = [];
  const adapter = new VcsWriteAdapter(
    async () => "",
    (dir, patterns) => { writes.push({ dir, patterns }); },
  );
  await adapter.writeExcludes("/m", ["node_modules/", ".qa/coverage/"]);
  assert.deepEqual(writes[0], { dir: "/m", patterns: ["node_modules/", ".qa/coverage/"] });
});
