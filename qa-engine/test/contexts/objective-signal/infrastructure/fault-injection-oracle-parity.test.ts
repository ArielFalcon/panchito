// test/contexts/objective-signal/infrastructure/fault-injection-oracle-parity.test.ts
// PARITY (kills false-green PC-003): pins FaultInjectionOracleAdapter.measure() against FROZEN
// snapshot literals captured from the legacy src/qa/learning/fault-injection-e2e.ts's
// runFaultInjectionOracle BEFORE that file was deleted (migration-tier-1-2, Slice 2). The
// orchestration is now absorbed into the adapter itself (see fault-injection-oracle.adapter.ts) —
// no src/ import remains in this file, and it is no longer excluded from qa-engine's typecheck.
//
// WARNING (judgment-day round-1, frozen-snapshot discipline — precedent:
// error-class-parity.test.ts's LEGACY_RESOLVE_ERROR_CLASS_SNAPSHOT): the two literals asserted
// below are a FROZEN oracle — the legacy source they were captured from
// (src/qa/learning/fault-injection-e2e.ts) no longer exists, so there is no live re-derivation
// possible. If a change to the adapter's absorbed orchestration makes one of these assertions
// fail, that failure is signaling a REAL behavioral divergence from the legacy oracle, not a
// stale fixture. Editing a snapshot VALUE here to make a failing test pass silently rebaselines
// away that regression instead of fixing it — never do that without a written justification (in
// the commit message or a comment here) for why the NEW value is the correct behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FaultInjectionOracleAdapter } from "@contexts/objective-signal/infrastructure/fault-injection-oracle.adapter.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";

const sha = Sha.of("abcdef1");
const br = BlastRadius.of(sha, ["src/svc.ts"]);
const BASE_URL = "https://dev.example.com";

test("FROZEN: WITHOUT baselineCases -> valueScore null (legacy guard behavior, pinned pre-deletion)", async () => {
  // runCorrupted must NOT run: the legacy guard short-circuits before it because baselineCases is
  // absent. A regression that injected baselineCases anyway would skip the guard and throw here.
  const adapter = new FaultInjectionOracleAdapter(
    async () => {
      throw new Error("runCorrupted must not run when baselineCases is absent (guard should short-circuit)");
    },
    () => 0,
    BASE_URL,
  );
  const r = await adapter.measure(br, "/m/repo", "qa-bot-abc"); // no 4th arg
  assert.equal(r.valueScore, null, "FROZEN: legacy oracle returns null with no baseline-passing specs");
  assert.equal(typeof r.details, "string");
  assert.ok(r.details.length > 0, "FROZEN: details must describe why no score was recorded");
});

test("FROZEN: WITH baselineCases + stubbed corrupted run -> 0.5 / killed 1 / mutant 2 (legacy arithmetic, pinned pre-deletion)", async () => {
  // Corrupted re-run: login STAYS green (weak oracle) and checkout FLIPS to fail via a plain
  // assertion timeout (a genuine catch, not a flow-break) -> catch-rate 1/2 = 0.5.
  const adapter = new FaultInjectionOracleAdapter(
    async () => ({
      verdict: "fail",
      cases: [
        { name: "login.spec.ts", status: "pass" as const },
        { name: "checkout.spec.ts", status: "fail" as const, detail: "expect(locator).toBeVisible timed out" },
      ],
    }),
    () => 3, // some JSON was intercepted -> oracle is applicable
    BASE_URL,
  );
  const r = await adapter.measure(br, "/m/repo", "qa-bot-abc", ["login.spec.ts", "checkout.spec.ts"]);
  assert.notEqual(r.valueScore, null, "FROZEN: a defined result when baseline specs are threaded through");
  assert.equal(r.valueScore, 0.5, "FROZEN: 1 of 2 baseline-passing specs noticed the corruption");
  assert.equal(r.killedCount, 1);
  assert.equal(r.mutantCount, 2);
});
