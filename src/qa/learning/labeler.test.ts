import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { labelRunOutcome, type LabelerInput } from "./labeler";

function baseInput(overrides: Partial<LabelerInput> = {}): LabelerInput {
  return {
    runId: "run-abc1234-abc123",
    app: "test-app",
    sha: "abc1234567890",
    mode: "diff",
    target: "e2e",
    verdict: "pass",
    staticOk: true,
    coverageRatio: null,
    minCoverageRatio: 0.7,
    reviewerCorrections: [],
    flaky: false,
    retries: 0,
    ...overrides,
  };
}

describe("labelRunOutcome", () => {
  it("healthy green pass → null errorClass, all gate signals populated", () => {
    const outcome = labelRunOutcome(baseInput());
    assert.equal(outcome.errorClass, null);
    assert.equal(outcome.gateSignals.static, true);
    assert.equal(outcome.gateSignals.coverageRatio, null);
    assert.equal(outcome.gateSignals.valueScore, null);
    assert.equal(outcome.gateSignals.flaky, false);
    assert.equal(outcome.gateSignals.retries, 0);
    assert.deepEqual(outcome.gateSignals.reviewerCorrections, []);
    assert.deepEqual(outcome.rulesRetrieved, []);
    assert.equal(outcome.verdict, "pass");
  });

  it("invalid verdict → E-STATIC", () => {
    const outcome = labelRunOutcome(baseInput({ verdict: "invalid", staticOk: false }));
    assert.equal(outcome.errorClass, "E-STATIC");
  });

  it("fail verdict → E-EXEC-FAIL", () => {
    const outcome = labelRunOutcome(baseInput({ verdict: "fail" }));
    assert.equal(outcome.errorClass, "E-EXEC-FAIL");
  });

  it("flaky verdict → E-FLAKY", () => {
    const outcome = labelRunOutcome(baseInput({ verdict: "flaky", flaky: true }));
    assert.equal(outcome.errorClass, "E-FLAKY");
  });

  it("infra-error → E-INFRA", () => {
    const outcome = labelRunOutcome(baseInput({ verdict: "infra-error" }));
    assert.equal(outcome.errorClass, "E-INFRA");
  });

  it("pass with coverage gap → E-COVERAGE-GAP", () => {
    const outcome = labelRunOutcome(baseInput({ verdict: "pass", coverageRatio: 0.35, minCoverageRatio: 0.7 }));
    assert.equal(outcome.errorClass, "E-COVERAGE-GAP");
  });

  it("reviewer corrections override coverage gap → reviewer class wins", () => {
    const outcome = labelRunOutcome(baseInput({
      verdict: "pass",
      coverageRatio: 0.35,
      minCoverageRatio: 0.7,
      reviewerCorrections: ["test clicks without asserting anything — false positive"],
    }));
    assert.equal(outcome.errorClass, "E-FALSE-POSITIVE");
  });

  it("E-INFRA always wins even if reviewer has corrections", () => {
    const outcome = labelRunOutcome(baseInput({
      verdict: "infra-error",
      reviewerCorrections: ["fragile selector"],
    }));
    assert.equal(outcome.errorClass, "E-INFRA");
  });

  it("E-STATIC always wins over reviewer corrections", () => {
    const outcome = labelRunOutcome(baseInput({
      verdict: "invalid",
      staticOk: false,
      reviewerCorrections: ["test is not tied to the commit"],
    }));
    assert.equal(outcome.errorClass, "E-STATIC");
  });

  it("skipped → null errorClass", () => {
    const outcome = labelRunOutcome(baseInput({ verdict: "skipped" }));
    assert.equal(outcome.errorClass, null);
  });

  it("pass with low valueScore → E-VALUE-SURVIVED", () => {
    const outcome = labelRunOutcome(baseInput({ verdict: "pass", coverageRatio: 0.85, valueScore: 0.3 }));
    assert.equal(outcome.errorClass, "E-VALUE-SURVIVED");
  });

  it("pass with high valueScore → null (healthy green)", () => {
    const outcome = labelRunOutcome(baseInput({ verdict: "pass", coverageRatio: 0.85, valueScore: 0.9 }));
    assert.equal(outcome.errorClass, null);
  });

  it("pass with null valueScore → null (unmeasured, no E-VALUE-SURVIVED)", () => {
    const outcome = labelRunOutcome(baseInput({ verdict: "pass", coverageRatio: 0.85, valueScore: null }));
    assert.equal(outcome.errorClass, null);
  });

  it("E-VALUE-SURVIVED loses to reviewer corrections", () => {
    const outcome = labelRunOutcome(baseInput({
      verdict: "pass", coverageRatio: 0.85, valueScore: 0.3,
      reviewerCorrections: ["test clicks without asserting anything — false positive"],
    }));
    assert.equal(outcome.errorClass, "E-FALSE-POSITIVE");
  });

  it("tracks retries and flaky", () => {
    const outcome = labelRunOutcome(baseInput({ retries: 3, flaky: true }));
    assert.equal(outcome.gateSignals.retries, 3);
    assert.equal(outcome.gateSignals.flaky, true);
  });

  it("records coverageRatio from gate signal", () => {
    const outcome = labelRunOutcome(baseInput({ coverageRatio: 0.82 }));
    assert.equal(outcome.gateSignals.coverageRatio, 0.82);
  });

  it("includes timestamp", () => {
    const outcome = labelRunOutcome(baseInput());
    assert.ok(outcome.at);
    assert.ok(new Date(outcome.at).getTime() > 0);
  });

  it("propagates run metadata fields", () => {
    const outcome = labelRunOutcome(baseInput({
      runId: "custom-id",
      app: "portfolio",
      sha: "def5678",
      mode: "complete",
      target: "code",
    }));
    assert.equal(outcome.runId, "custom-id");
    assert.equal(outcome.app, "portfolio");
    assert.equal(outcome.sha, "def5678");
    assert.equal(outcome.mode, "complete");
    assert.equal(outcome.target, "code");
  });
});
