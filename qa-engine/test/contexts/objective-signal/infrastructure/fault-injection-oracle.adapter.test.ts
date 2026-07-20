// test/contexts/objective-signal/infrastructure/fault-injection-oracle.adapter.test.ts
// migration-tier-1-2, Slice 2: the orchestration previously in
// src/qa/learning/fault-injection-e2e.ts's runFaultInjectionOracle is now absorbed into
// measure() itself. Ctor is (runCorrupted, countInjected, baseUrl) — the adapter is
// self-contained, no injected "runner closure" wraps a legacy function anymore.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FaultInjectionOracleAdapter } from "@contexts/objective-signal/infrastructure/fault-injection-oracle.adapter.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";

const sha = Sha.of("abcdef1");
const br = BlastRadius.of(sha, ["src/svc.ts"]);
const BASE_URL = "https://dev.example.com";

test("returns valueScore null when baselineCases is missing (guard short-circuits before runCorrupted)", async () => {
  const adapter = new FaultInjectionOracleAdapter(
    async () => {
      throw new Error("runCorrupted must not run when baselineCases is absent (guard should short-circuit)");
    },
    () => 0,
    BASE_URL,
  );
  const r = await adapter.measure(br, "/m/repo", "qa-bot-abc"); // no 4th arg
  assert.equal(r.valueScore, null);
  assert.match(r.details, /needs e2eDir \+ baseUrl \+ baseline-passing specs/);
});

test("computes the response-oracle catch-rate from a corrupted re-run, with a -fi namespace suffix", async () => {
  let seen: { dir: string; baseUrl: string; namespace: string } | null = null;
  const adapter = new FaultInjectionOracleAdapter(
    async (args) => {
      seen = args;
      return {
        verdict: "fail",
        cases: [
          { name: "a", status: "fail" as const },
          { name: "b", status: "pass" as const },
        ],
      };
    },
    () => 3,
    BASE_URL,
  );
  const r = await adapter.measure(br, "/m/repo", "qa-bot-abc", ["a", "b"]);
  assert.equal(seen!.dir, "/m/repo");
  assert.equal(seen!.baseUrl, BASE_URL);
  assert.equal(seen!.namespace, "qa-bot-abc-fi", "the fault-injection re-run namespace must be isolated with a -fi suffix");
  assert.equal(r.valueScore, 0.5);
  assert.equal(r.killedCount, 1);
  assert.equal(r.mutantCount, 2);
  assert.equal(typeof r.details, "string", "details field must be present — ValueOracleResult has 4 fields");
});

test("returns null when the corrupted re-run is inconclusive (infra-error)", async () => {
  const adapter = new FaultInjectionOracleAdapter(async () => ({ verdict: "infra-error", cases: [] }), () => 0, BASE_URL);
  const r = await adapter.measure(br, "/m/repo", "qa-bot-abc", ["a"]);
  assert.equal(r.valueScore, null);
  assert.match(r.details, /inconclusive \(infra\)/);
});

test("returns null when no JSON responses were intercepted (not applicable — never gates)", async () => {
  const adapter = new FaultInjectionOracleAdapter(
    async () => ({ verdict: "pass", cases: [{ name: "a", status: "pass" as const }] }),
    () => 0,
    BASE_URL,
  );
  const r = await adapter.measure(br, "/m/repo", "qa-bot-abc", ["a"]);
  assert.equal(r.valueScore, null);
  assert.equal(r.mutantCount, 0);
  assert.equal(r.killedCount, 0);
  assert.match(r.details, /not applicable to this app's flows/);
});

test("returns null when the corrupted re-run executed none of the baseline-passing specs", async () => {
  const adapter = new FaultInjectionOracleAdapter(
    async () => ({ verdict: "fail", cases: [{ name: "other", status: "fail" as const }] }),
    () => 3,
    BASE_URL,
  );
  const r = await adapter.measure(br, "/m/repo", "qa-bot-abc", ["a"]);
  assert.equal(r.valueScore, null);
  assert.match(r.details, /executed none of the baseline-passing specs/);
});
