// test/contexts/qa-run-orchestration/infrastructure/bridges/learning-port.adapter.test.ts
// RED-first (Task E.0): LearningPortAdapter delegates fold() to the REAL LearningRepositoryPort.
// applyOutcome and retrieve() to topRules. Off-path by contract: a fold failure is logged and
// swallowed, NEVER thrown/re-raised — the caller (RunQaUseCase) must never see a learning fault.
//
// W3 F1/F3a (dual-judge round): retrieve() now projects the FULL structured RetrievedRule shape
// (trigger/action/errorClass/status/confidence), not bare trigger strings — the projection tests
// below assert every field survives the LearningRule -> RetrievedRule mapping. F3a: retrieve() also
// calls the store's optional incrementUsage on exactly the retrieved ids, mirroring legacy's
// retrieveRules() -> incrementRuleUsage(included.map(r => r.id)) (src/qa/learning/retrieval.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { LearningPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/learning-port.adapter.ts";
import { StubLearningRepository } from "@contexts/cross-run-learning/infrastructure/stub-learning-repository.adapter.ts";
import type { LearningRepositoryPort, LearningRule } from "@contexts/cross-run-learning/application/ports/index.ts";
import { Sha } from "@kernel/sha.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";

const outcome: RunOutcome = {
  runId: "r1", app: "app", sha: "abc1234", mode: "diff", target: "e2e", verdict: "pass",
  errorClass: null,
  gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
  rulesRetrieved: [], at: new Date().toISOString(),
};

test("fold() delegates to LearningRepositoryPort.applyOutcome verbatim", async () => {
  let captured: RunOutcome | undefined;
  const repo: LearningRepositoryPort = {
    save: async () => {},
    topRules: async () => [],
    applyOutcome: async (o) => { captured = o; },
  };
  const adapter = new LearningPortAdapter(repo, "app");

  await adapter.fold(outcome);

  assert.equal(captured, outcome);
});

test("fold() swallows a failure — off-path by contract, never gates publish", async () => {
  const repo: LearningRepositoryPort = {
    save: async () => {},
    topRules: async () => [],
    applyOutcome: async () => { throw new Error("sqlite is locked"); },
  };
  const adapter = new LearningPortAdapter(repo, "app");

  // Must NOT throw/reject — a fold failure is logged and swallowed, per the port's own contract.
  await assert.doesNotReject(() => adapter.fold(outcome));
});

test("retrieve() delegates to LearningRepositoryPort.topRules and returns the FULL structured rule (W3 F1)", async () => {
  const rule: LearningRule = {
    id: "r1", trigger: "selector absent", action: "use role+name", errorClass: "E-EXEC-FAIL",
    archetype: null, status: "active", confidence: "high", usageCount: 3, outcomeCount: 3,
    successRate: 1, lastVerified: null, source: "run-1", at: new Date().toISOString(),
  };
  const repo: LearningRepositoryPort = {
    save: async () => {},
    topRules: async () => [rule],
    applyOutcome: async () => {},
  };
  const adapter = new LearningPortAdapter(repo, "app");

  const result = await adapter.retrieve(Sha.of("abc1234"));

  assert.deepEqual(result, [{
    trigger: "selector absent",
    action: "use role+name",
    errorClass: "E-EXEC-FAIL",
    status: "active",
    confidence: "high",
  }]);
});

test("retrieve() narrows a candidate rule's status verbatim (not coerced to active)", async () => {
  const rule: LearningRule = {
    id: "r2", trigger: "flaky wait", action: "use expect.poll", errorClass: "E-FLAKY",
    archetype: null, status: "candidate", confidence: "low", usageCount: 0, outcomeCount: 0,
    successRate: null, lastVerified: null, source: "run-2", at: new Date().toISOString(),
  };
  const repo: LearningRepositoryPort = {
    save: async () => {},
    topRules: async () => [rule],
    applyOutcome: async () => {},
  };
  const adapter = new LearningPortAdapter(repo, "app");

  const result = await adapter.retrieve(Sha.of("abc1234"));

  assert.equal(result[0]?.status, "candidate");
});

test("retrieve() with the StubLearningRepository (v1 default) returns [] — provably off-path", async () => {
  const adapter = new LearningPortAdapter(new StubLearningRepository(), "app");

  const result = await adapter.retrieve(Sha.of("abc1234"));

  assert.deepEqual(result, []);
});

// ── W3 F3a (dual-judge round): usageCount tracking — retrieve() must increment usage on exactly
// the retrieved set, mirroring legacy's own retrieveRules() -> incrementRuleUsage() call. ────────

test("retrieve() calls LearningRepositoryPort.incrementUsage with the retrieved rule ids", async () => {
  const rule: LearningRule = {
    id: "r3", trigger: "no aria label", action: "add role+name", errorClass: "E-EXEC-FAIL",
    archetype: null, status: "active", confidence: "medium", usageCount: 1, outcomeCount: 1,
    successRate: 0.8, lastVerified: null, source: "run-3", at: new Date().toISOString(),
  };
  let incrementedIds: readonly string[] | undefined;
  const repo: LearningRepositoryPort = {
    save: async () => {},
    topRules: async () => [rule],
    applyOutcome: async () => {},
    incrementUsage: async (ids) => { incrementedIds = ids; },
  };
  const adapter = new LearningPortAdapter(repo, "app");

  await adapter.retrieve(Sha.of("abc1234"));

  assert.deepEqual(incrementedIds, ["r3"]);
});

test("retrieve() never calls incrementUsage when nothing was retrieved (no phantom usage)", async () => {
  let incrementCalled = false;
  const repo: LearningRepositoryPort = {
    save: async () => {},
    topRules: async () => [],
    applyOutcome: async () => {},
    incrementUsage: async () => { incrementCalled = true; },
  };
  const adapter = new LearningPortAdapter(repo, "app");

  await adapter.retrieve(Sha.of("abc1234"));

  assert.equal(incrementCalled, false);
});

test("retrieve() tolerates a store without incrementUsage wired (optional method, off-path)", async () => {
  const rule: LearningRule = {
    id: "r4", trigger: "t", action: "a", errorClass: "E-X", archetype: null, status: "active",
    confidence: "low", usageCount: 0, outcomeCount: 0, successRate: null, lastVerified: null,
    source: "run-4", at: new Date().toISOString(),
  };
  const repo: LearningRepositoryPort = {
    save: async () => {},
    topRules: async () => [rule],
    applyOutcome: async () => {},
    // incrementUsage intentionally omitted
  };
  const adapter = new LearningPortAdapter(repo, "app");

  await assert.doesNotReject(() => adapter.retrieve(Sha.of("abc1234")));
});
