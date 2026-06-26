// test/contexts/objective-signal/infrastructure/stryker-mutation-oracle.adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { StrykerMutationOracleAdapter } from "@contexts/objective-signal/infrastructure/stryker-mutation-oracle.adapter.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";

const sha = Sha.of("abcdef1");
const br = BlastRadius.of(sha, ["src/svc.ts"]);

test("delegates to runMutationOracle with repoDir (not specDir) + changedFiles from BlastRadius", async () => {
  let seen: { repoDir: string; namespace: string; changedFiles?: string[] } | null = null;
  const adapter = new StrykerMutationOracleAdapter(async (input) => {
    seen = { repoDir: input.repoDir, namespace: input.namespace, changedFiles: input.changedFiles };
    return { valueScore: 0.8, mutantCount: 10, killedCount: 8, details: "8/10 killed" };
  });
  const r = await adapter.measure(br, "/m/repo", `qa-bot-${sha.value}`);
  assert.equal(seen!.repoDir, "/m/repo");
  assert.equal(seen!.namespace, `qa-bot-${sha.value}`);
  assert.deepEqual(seen!.changedFiles, ["src/svc.ts"]);
  assert.equal(r.valueScore, 0.8);
  assert.equal(r.killedCount, 8);
  assert.equal(typeof r.details, "string", "details field must be present — ValueOracleResult has 4 fields");
});

test("a non-JS ecosystem returns a null score with a details string (never gates — signal only)", async () => {
  const adapter = new StrykerMutationOracleAdapter(async () => ({ valueScore: null, mutantCount: 0, killedCount: 0, details: "ecosystem not supported" }));
  const r = await adapter.measure(br, "/m/repo", "qa-bot-abc");
  assert.equal(r.valueScore, null);
  assert.equal(typeof r.details, "string");
});
