// test/contexts/workspace-and-publication/domain/publish-decision.service.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PublishDecisionService } from "@contexts/workspace-and-publication/domain/publish-decision.service.ts";

const svc = new PublishDecisionService();
const base = { reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true };

test("green + approved + not blocked + changes → pr", () => {
  assert.equal(svc.decide({ ...base, verdict: "pass" }).outcome, "pr");
});
test("green + approved but no e2e changes → noop", () => {
  assert.equal(svc.decide({ ...base, verdict: "pass", e2eChanged: false }).outcome, "noop");
});
test("green but reviewer rejected → issue", () => {
  assert.equal(svc.decide({ ...base, verdict: "pass", reviewerApproved: false }).outcome, "issue");
});
test("green but coverage enforce-blocks → issue (PR held)", () => {
  assert.equal(svc.decide({ ...base, verdict: "pass", coverageBlocks: true }).outcome, "issue");
});
test("fail or invalid → issue", () => {
  assert.equal(svc.decide({ ...base, verdict: "fail" }).outcome, "issue");
  assert.equal(svc.decide({ ...base, verdict: "invalid" }).outcome, "issue");
});
test("flaky → quarantine", () => {
  assert.equal(svc.decide({ ...base, verdict: "flaky" }).outcome, "quarantine");
});
test("infra-error → noop (no side effect; not a code bug)", () => {
  assert.equal(svc.decide({ ...base, verdict: "infra-error" }).outcome, "noop");
});
test("shadow mode overrides every side-effecting outcome to shadow", () => {
  assert.equal(svc.decide({ ...base, verdict: "pass", shadow: true }).outcome, "shadow");
  assert.equal(svc.decide({ ...base, verdict: "fail", shadow: true }).outcome, "shadow");
});
// FIX 13a: skipped must be a noop (the agent approved with zero specs — a clean exit,
// not an error; opening an issue for a skipped run would be a false positive).
test("skipped → noop (agent approved zero specs — clean exit, not an error)", () => {
  assert.equal(svc.decide({ ...base, verdict: "skipped" }).outcome, "noop");
});
// FIX 13a note: `infra-error` handling is deliberately kept minimal here (→ noop).
// The full infra-error notification flow (alert channel, retry logic) is audited at
// Plan-6 wiring where the full pipeline context is available. Do NOT add infra-error
// side effects to PublishDecisionService before that audit.
