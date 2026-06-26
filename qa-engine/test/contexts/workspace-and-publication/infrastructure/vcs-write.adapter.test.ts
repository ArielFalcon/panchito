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
