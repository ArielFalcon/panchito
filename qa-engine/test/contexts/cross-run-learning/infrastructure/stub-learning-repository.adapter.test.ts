// test/contexts/cross-run-learning/infrastructure/stub-learning-repository.adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { StubLearningRepository } from "@contexts/cross-run-learning/infrastructure/stub-learning-repository.adapter.ts";
import { Sha } from "@kernel/sha.ts";

test("topRules always returns [] (no rules ever influence the prompt in v1)", async () => {
  const repo = new StubLearningRepository();
  assert.deepEqual(await repo.topRules(Sha.of("abcdef1"), 10), []);
});

test("save and applyOutcome are no-ops that never throw (off-path, fail-open)", async () => {
  const repo = new StubLearningRepository();
  await assert.doesNotReject(repo.save({ id: "r1", trigger: "t", action: "a", errorClass: "E-X", archetype: null, status: "candidate", confidence: "low", usageCount: 0, outcomeCount: 0, successRate: null, lastVerified: null, source: "oracle", at: new Date().toISOString() }));
  await assert.doesNotReject(repo.applyOutcome({} as never));
});
