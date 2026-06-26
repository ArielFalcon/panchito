// test/contexts/objective-signal/infrastructure/fault-injection-oracle.adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { FaultInjectionOracleAdapter } from "@contexts/objective-signal/infrastructure/fault-injection-oracle.adapter.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";

const sha = Sha.of("abcdef1");
const br = BlastRadius.of(sha, ["src/svc.ts"]);
const BASE_URL = "https://dev.example.com";

test("delegates to runFaultInjectionOracle with e2eDir + baseUrl + namespace from measure args", async () => {
  let seen: { e2eDir: string; baseUrl: string; namespace: string } | null = null;
  const adapter = new FaultInjectionOracleAdapter(async (input) => {
    seen = { e2eDir: input.e2eDir, baseUrl: input.baseUrl, namespace: input.namespace };
    return { valueScore: 0.75, mutantCount: 4, killedCount: 3, details: "3/4 specs noticed corruption" };
  }, BASE_URL);
  const r = await adapter.measure(br, "/m/repo", `qa-bot-${sha.value}`);
  assert.equal(seen!.e2eDir, "/m/repo");
  assert.equal(seen!.baseUrl, BASE_URL);
  assert.equal(seen!.namespace, `qa-bot-${sha.value}`);
  assert.equal(r.valueScore, 0.75);
  assert.equal(r.killedCount, 3);
  assert.equal(typeof r.details, "string", "details field must be present — ValueOracleResult has 4 fields");
});

test("threads baselineCases (4th measure arg) into the runner input when present", async () => {
  let seenBaseline: string[] | undefined = ["sentinel"]; // sentinel ≠ what we expect
  const adapter = new FaultInjectionOracleAdapter(async (input) => {
    seenBaseline = input.baselineCases;
    return { valueScore: 0.5, mutantCount: 2, killedCount: 1, details: "1/2" };
  }, BASE_URL);
  await adapter.measure(br, "/m/repo", "qa-bot-abc", ["login.spec.ts", "checkout.spec.ts"]);
  assert.deepEqual(seenBaseline, ["login.spec.ts", "checkout.spec.ts"]);
});

test("omits baselineCases from the runner input when measure is called without it (3-arg call)", async () => {
  let hadBaselineKey = true;
  const adapter = new FaultInjectionOracleAdapter(async (input) => {
    hadBaselineKey = "baselineCases" in input;
    return { valueScore: null, mutantCount: 0, killedCount: 0, details: "no baseline" };
  }, BASE_URL);
  await adapter.measure(br, "/m/repo", "qa-bot-abc");
  assert.equal(hadBaselineKey, false, "no baselineCases key when measure is called without baseline specs");
});

test("when the runner returns null (no JSON intercepted), returns valueScore:null with a details string (never gates)", async () => {
  const adapter = new FaultInjectionOracleAdapter(async () => null, BASE_URL);
  const r = await adapter.measure(br, "/m/repo", "qa-bot-abc");
  assert.equal(r.valueScore, null);
  assert.equal(r.mutantCount, 0);
  assert.equal(r.killedCount, 0);
  assert.equal(typeof r.details, "string");
  assert.ok(r.details.length > 0, "details must describe why no score was recorded");
});
