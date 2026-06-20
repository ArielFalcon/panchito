import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { engineStatus, RUN_ENGINE_STATUSES } from "./types";

// The run STATUS is distinct from the test VERDICT: it answers "did the engine do its job and
// produce a trustworthy result?" — NOT "did every test pass?". A real bug found (verdict `fail`
// → Issue) is a SUCCESS; only a run where the engine itself could not run, or could not produce
// runnable tests, is an error.
describe("engineStatus", () => {
  it("maps pass to success (green suite → PR)", () => {
    assert.equal(engineStatus("pass"), RUN_ENGINE_STATUSES.SUCCESS);
  });

  it("maps fail to success — a real bug found (→ Issue) means the engine did the right thing", () => {
    assert.equal(engineStatus("fail"), RUN_ENGINE_STATUSES.SUCCESS);
  });

  it("maps flaky to success — instability detected and quarantined is a valid engine outcome", () => {
    assert.equal(engineStatus("flaky"), RUN_ENGINE_STATUSES.SUCCESS);
  });

  it("maps skipped to success — nothing test-worthy is a clean no-op", () => {
    assert.equal(engineStatus("skipped"), RUN_ENGINE_STATUSES.SUCCESS);
  });

  it("maps invalid to error — the engine could not produce runnable tests", () => {
    assert.equal(engineStatus("invalid"), RUN_ENGINE_STATUSES.ERROR);
  });

  it("maps infra-error to error — inconclusive infrastructure fault", () => {
    assert.equal(engineStatus("infra-error"), RUN_ENGINE_STATUSES.ERROR);
  });

  it("treats a missing verdict (null/undefined) as error — fail-safe", () => {
    assert.equal(engineStatus(null), RUN_ENGINE_STATUSES.ERROR);
    assert.equal(engineStatus(undefined), RUN_ENGINE_STATUSES.ERROR);
  });
});
