// test/contexts/qa-run-orchestration/infrastructure/bridges/learning-port.adapter.test.ts
// RED-first (Task E.0): LearningPortAdapter delegates fold() to the REAL LearningRepositoryPort.
// applyOutcome and retrieve() to topRules. Off-path by contract: a fold failure is logged and
// swallowed, NEVER thrown/re-raised — the caller (RunQaUseCase) must never see a learning fault.
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

test("retrieve() delegates to LearningRepositoryPort.topRules and returns rule triggers", async () => {
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

  assert.deepEqual(result, ["selector absent"]);
});

test("retrieve() with the StubLearningRepository (v1 default) returns [] — provably off-path", async () => {
  const adapter = new LearningPortAdapter(new StubLearningRepository(), "app");

  const result = await adapter.retrieve(Sha.of("abc1234"));

  assert.deepEqual(result, []);
});
