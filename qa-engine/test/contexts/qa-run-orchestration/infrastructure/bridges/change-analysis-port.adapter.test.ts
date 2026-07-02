// test/contexts/qa-run-orchestration/infrastructure/bridges/change-analysis-port.adapter.test.ts
// RED-first (Task E.0): ChangeAnalysisPortAdapter must DELEGATE to the REAL sibling collaborator —
// change-analysis's VcsReadPort (blastRadius for analyze()) and the domain classifyCommit(message,
// diff) function (for classify(), sourcing message/diff from the SAME VcsReadPort). NO new policy —
// this is a shape/delegation test, not a re-test of classifyCommit's own classification table (that
// lives in commit-classification.test.ts / commit-classification-parity.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeAnalysisPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/change-analysis-port.adapter.ts";
import { Sha } from "@kernel/sha.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import type { VcsReadPort } from "@contexts/change-analysis/application/ports/index.ts";

function fakeVcsRead(overrides: Partial<VcsReadPort> = {}): VcsReadPort {
  return {
    diff: async () => "diff --git a/src/foo.ts b/src/foo.ts\n+++ b/src/foo.ts\n+if (x) { return 1; }\n",
    message: async () => "feat: add foo",
    blastRadius: async (sha) => BlastRadius.of(sha, ["src/foo.ts"]),
    ...overrides,
  };
}

test("analyze() delegates to VcsReadPort.blastRadius and returns its BlastRadius verbatim", async () => {
  const sha = Sha.of("abc1234");
  const expected = BlastRadius.of(sha, ["src/a.ts", "src/b.ts"]);
  let calledWith: Sha | undefined;
  const vcs = fakeVcsRead({
    blastRadius: async (s) => { calledWith = s; return expected; },
  });
  const adapter = new ChangeAnalysisPortAdapter(vcs);

  const result = await adapter.analyze(sha);

  assert.equal(calledWith, sha, "must forward the SAME Sha to VcsReadPort.blastRadius");
  assert.deepEqual([...result.changedFiles], ["src/a.ts", "src/b.ts"]);
  assert.equal(result.sha, sha);
});

test("classify() sources message+diff from VcsReadPort and delegates to classifyCommit verbatim", async () => {
  const sha = Sha.of("def5678");
  const vcs = fakeVcsRead({
    message: async () => "feat: new checkout flow",
    diff: async () => "diff --git a/src/checkout.ts b/src/checkout.ts\n+++ b/src/checkout.ts\n+if (total > 0) { charge(); }\n",
  });
  const adapter = new ChangeAnalysisPortAdapter(vcs);

  const result = await adapter.classify(sha);

  // feat -> generate (DEFAULT_ACTION table in commit-classification.ts) — proves REAL delegation,
  // not an invented/hardcoded action.
  assert.equal(result.action, "generate");
  assert.match(result.reason, /type=feat/);
});

test("classify() escalates a contradicting refactor message to generate (delegated, not reinvented)", async () => {
  const sha = Sha.of("aaa9999");
  const vcs = fakeVcsRead({
    message: async () => "refactor: tidy pricing",
    diff: async () => "diff --git a/src/pricing.ts b/src/pricing.ts\n+++ b/src/pricing.ts\n+if (discount > 0) { return price * discount; }\n",
  });
  const adapter = new ChangeAnalysisPortAdapter(vcs);

  const result = await adapter.classify(sha);

  assert.equal(result.action, "generate");
  assert.match(result.reason, /escalated to generate/);
});
