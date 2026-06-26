// test/contexts/objective-signal/infrastructure/fault-injection-oracle-parity.test.ts
// PARITY (kills false-green PC-003): wrap the REAL legacy runFaultInjectionOracle through the
// FaultInjectionOracleAdapter with STUBBED FaultInjectionDeps (no Playwright). This proves the
// FUNCTIONAL contract — that the baselineCases channel actually reaches the legacy null-guard
// (fault-injection-e2e.ts: returns valueScore:null when baselineCases is absent/empty) — not just
// adapter wiring. A gutted adapter that drops baselineCases makes the WITH-baseline test fail
// (the real guard fires and the score never becomes defined).
//
// Excluded from qa-engine/tsconfig.json typecheck (like every other *-parity.test.ts) because the
// direct src/ relative import drags the legacy graph outside the composite project's rootDir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FaultInjectionOracleAdapter } from "@contexts/objective-signal/infrastructure/fault-injection-oracle.adapter.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";
import {
  runFaultInjectionOracle,
  type FaultInjectionDeps,
} from "../../../../../src/qa/learning/fault-injection-e2e.ts";
import type { QaRunResult } from "../../../../../src/types.ts";

const sha = Sha.of("abcdef1");
const br = BlastRadius.of(sha, ["src/svc.ts"]);
const BASE_URL = "https://dev.example.com";

// Build an adapter whose runner is the REAL oracle bound to the supplied stubbed deps.
function realOracleAdapter(deps: FaultInjectionDeps): FaultInjectionOracleAdapter {
  return new FaultInjectionOracleAdapter(
    (input) =>
      runFaultInjectionOracle(
        {
          target: "e2e",
          repoDir: input.e2eDir,
          e2eDir: input.e2eDir,
          baseUrl: input.baseUrl,
          namespace: input.namespace,
          baselineCases: input.baselineCases,
        },
        deps,
      ),
    BASE_URL,
  );
}

test("real oracle through the adapter: WITHOUT baselineCases -> valueScore null (the legacy guard fires)", async () => {
  // runCorrupted must NOT run: the legacy guard short-circuits before it because baselineCases is
  // absent. A regression that injected baselineCases anyway would skip the guard and throw here.
  const stubDeps: FaultInjectionDeps = {
    runCorrupted: async () => {
      throw new Error("runCorrupted must not run when baselineCases is absent (guard should short-circuit)");
    },
    countInjected: () => 0,
  };
  const r = await realOracleAdapter(stubDeps).measure(br, "/m/repo", "qa-bot-abc"); // no 4th arg
  assert.equal(r.valueScore, null, "real oracle returns null with no baseline-passing specs");
  assert.equal(typeof r.details, "string");
  assert.ok(r.details.length > 0, "details must describe why no score was recorded");
});

test("real oracle through the adapter: WITH baselineCases + stubbed green path -> a defined score", async () => {
  const baseline = ["login.spec.ts", "checkout.spec.ts"];
  // Corrupted re-run: login STAYS green (weak oracle) and checkout FLIPS to fail via a plain
  // assertion timeout (a genuine catch, not a flow-break) -> catch-rate 1/2 = 0.5.
  const corruptedRun: QaRunResult = {
    sha: sha.value,
    verdict: "fail",
    passed: false,
    cases: [
      { name: "login.spec.ts", status: "pass" },
      { name: "checkout.spec.ts", status: "fail", detail: "expect(locator).toBeVisible timed out" },
    ],
    logs: "",
  };
  const stubDeps: FaultInjectionDeps = {
    runCorrupted: async () => corruptedRun,
    countInjected: () => 3, // some JSON was intercepted -> oracle is applicable
  };
  const r = await realOracleAdapter(stubDeps).measure(br, "/m/repo", "qa-bot-abc", baseline);
  assert.notEqual(r.valueScore, null, "a defined result when baseline specs are threaded through");
  assert.equal(r.valueScore, 0.5, "1 of 2 baseline-passing specs noticed the corruption");
  assert.equal(r.killedCount, 1);
  assert.equal(r.mutantCount, 2);
});
