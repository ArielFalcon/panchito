// test/contexts/qa-run-orchestration/infrastructure/bridges/change-analysis-port.adapter.test.ts
// RED-first (Task E.0): ChangeAnalysisPortAdapter must DELEGATE to the REAL sibling collaborator —
// the domain classifyCommit(message, diff) function (for classify(), sourcing message/diff from
// the SAME VcsReadPort). NO new policy — this is a shape/delegation test, not a re-test of
// classifyCommit's own classification table (that lives in commit-classification.test.ts /
// commit-classification-parity.test.ts).
//
// WS7.7(a) (full-flow remediation, hygiene): analyze() was DELETED from ChangeAnalysisPort (zero
// production callers) — its own delegation test is removed here too. fakeVcsRead still declares
// blastRadius in its default shape because VcsReadPort itself still requires it (a real, separate
// caller exists elsewhere — see change-analysis-port.adapter.ts's own header).
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

// ── "Dynamic diff" fix (engram #936): classify() already sources the commit's diff from
// VcsReadPort.diff(sha) internally (to pass into classifyCommit), but previously discarded it after
// classification — RunQaUseCase had no way to reach the REAL per-run diff for generation. Surfacing
// the SAME diff already fetched here (no second VCS round-trip) closes that gap.

test("classify() surfaces the SAME diff it already fetched from VcsReadPort for classifyCommit (no second VCS round-trip)", async () => {
  const sha = Sha.of("def5678");
  let diffCallCount = 0;
  const theDiff = "diff --git a/src/checkout.ts b/src/checkout.ts\n+++ b/src/checkout.ts\n+if (total > 0) { charge(); }\n";
  const vcs = fakeVcsRead({
    message: async () => "feat: new checkout flow",
    diff: async () => { diffCallCount++; return theDiff; },
  });
  const adapter = new ChangeAnalysisPortAdapter(vcs);

  const result = await adapter.classify(sha);

  assert.equal(result.diff, theDiff, "classify() must return the SAME diff it fetched to classify the commit, not discard it");
  assert.equal(diffCallCount, 1, "classify() must fetch the diff exactly once — reuse the SAME value for both classification and the returned diff, never a second VcsReadPort.diff() call");
});

// ── W2 fix (F5, CommitIntent threading): classifyCommit() already derives the FULL CommitIntent
// (type/breaking/message/body/changedFiles) as part of its own CommitClassification return — this
// bridge previously discarded everything except {action, reason}. classify() must now surface it.

test("classify() surfaces the FULL CommitIntent classifyCommit() already derived (type/breaking/message/body/changedFiles)", async () => {
  const sha = Sha.of("def5678");
  const vcs = fakeVcsRead({
    message: async () => "feat: new checkout flow\n\nAdds the checkout total calculation.",
    diff: async () => "diff --git a/src/checkout.ts b/src/checkout.ts\n+++ b/src/checkout.ts\n+if (total > 0) { charge(); }\n",
  });
  const adapter = new ChangeAnalysisPortAdapter(vcs);

  const result = await adapter.classify(sha);

  assert.equal(result.intent.type, "feat");
  assert.equal(result.intent.breaking, false);
  assert.equal(result.intent.message, "feat: new checkout flow");
  assert.equal(result.intent.body, "Adds the checkout total calculation.");
  assert.deepEqual(result.intent.changedFiles, ["src/checkout.ts"]);
});

test("classify() surfaces breaking:true for a BREAKING CHANGE commit, matching classifyCommit's own escalation", async () => {
  const sha = Sha.of("bbb1111");
  const vcs = fakeVcsRead({
    message: async () => "feat!: remove legacy endpoint",
    diff: async () => "diff --git a/src/api.ts b/src/api.ts\n+++ b/src/api.ts\n+if (v2) { return newHandler(); }\n",
  });
  const adapter = new ChangeAnalysisPortAdapter(vcs);

  const result = await adapter.classify(sha);

  assert.equal(result.intent.breaking, true);
  assert.equal(result.action, "generate");
});

// ── WS7.1 (full-flow remediation, multi-commit range restoration) ──────────────────────────────

test("classify(sha, {baseSha}) sources the UNION diff via VcsReadPort.diff(sha, {baseSha}) and the range's other messages via otherMessages()", async () => {
  const sha = Sha.of("deadbee1");
  const baseSha = Sha.of("bad00001");
  let diffOpts: unknown;
  let otherMessagesCalled = false;
  const vcs = fakeVcsRead({
    message: async () => "chore: bump deps",
    diff: async (_s, opts) => { diffOpts = opts; return "diff --git a/src/x.ts b/src/x.ts\n+++ b/src/x.ts\n+if (a) return 1;\n"; },
    otherMessages: async (_s, _opts) => { otherMessagesCalled = true; return ["feat: add x"]; },
  });
  const adapter = new ChangeAnalysisPortAdapter(vcs);

  const result = await adapter.classify(sha, { baseSha });

  assert.deepEqual(diffOpts, { baseSha }, "must forward baseSha to VcsReadPort.diff so it fetches the UNION diff");
  assert.equal(otherMessagesCalled, true, "must fetch the range's other commit messages via otherMessages()");
  // MAX-severity: chore (head) + feat (other) → generate wins, matching classifyRange's own contract.
  assert.equal(result.action, "generate");
  assert.equal(result.intent.type, "chore", "intent must stay the HEAD commit's own, even when a range member escalates the action");
});

test("classify(sha) with NO opts.baseSha never calls otherMessages — byte-identical to the single-commit path", async () => {
  const sha = Sha.of("deadbee1");
  let otherMessagesCalled = false;
  const vcs = fakeVcsRead({
    message: async () => "feat: new checkout flow",
    diff: async () => "diff --git a/src/checkout.ts b/src/checkout.ts\n+++ b/src/checkout.ts\n+if (total > 0) { charge(); }\n",
    otherMessages: async () => { otherMessagesCalled = true; return []; },
  });
  const adapter = new ChangeAnalysisPortAdapter(vcs);

  await adapter.classify(sha);

  assert.equal(otherMessagesCalled, false, "otherMessages must never be called when the caller supplies no baseSha");
});

test("classify(sha, {baseSha}) degrades to a single-commit-equivalent range when VcsReadPort has no otherMessages collaborator ([SWAP])", async () => {
  const sha = Sha.of("deadbee1");
  const baseSha = Sha.of("bad00001");
  // fakeVcsRead's default shape omits otherMessages entirely — mirrors a VcsReadPort
  // implementation/test-double that predates WS7.1.
  const vcs = fakeVcsRead({
    message: async () => "chore: bump deps",
    diff: async () => "diff --git a/README.md b/README.md\n+++ b/README.md\n+more prose\n",
  });
  const adapter = new ChangeAnalysisPortAdapter(vcs);

  const result = await adapter.classify(sha, { baseSha });

  assert.equal(result.action, "skip", "absent otherMessages must not throw — degrades to the head commit's own classification");
});
