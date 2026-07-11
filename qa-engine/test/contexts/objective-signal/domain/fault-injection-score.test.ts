// test/contexts/objective-signal/domain/fault-injection-score.test.ts
// Unit tests moved/adapted from src/qa/learning/fault-injection-e2e.test.ts's scoring cases
// (migration-tier-1-2, Slice 2) — the pure computeFaultInjectionScore/isFlowBreak half now lives
// in objective-signal/domain/fault-injection-score.ts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeFaultInjectionScore, isFlowBreak, FLOW_BREAK } from "@contexts/objective-signal/domain/fault-injection-score.ts";
import type { QaCase } from "@kernel/qa-case.ts";

describe("computeFaultInjectionScore", () => {
  it("counts baseline-passing specs that flipped to fail under corruption (caught it)", () => {
    const baseline = ["a", "b", "c", "d"];
    const corrupted: QaCase[] = [
      { name: "a", status: "fail" }, // strong oracle: noticed the wrong data
      { name: "b", status: "pass" }, // weak oracle: stayed green
      { name: "c", status: "fail" },
      { name: "d", status: "pass" },
    ];
    const r = computeFaultInjectionScore(baseline, corrupted);
    assert.equal(r.killed, 2);
    assert.equal(r.total, 4);
    assert.equal(r.valueScore, 0.5);
  });

  it("treats a spec that went flaky under corruption as having noticed", () => {
    const r = computeFaultInjectionScore(["a"], [{ name: "a", status: "flaky" }]);
    assert.equal(r.valueScore, 1);
  });

  it("returns null when there were no baseline-passing specs", () => {
    const r = computeFaultInjectionScore([], [{ name: "a", status: "fail" }]);
    assert.equal(r.valueScore, null);
  });

  it("a baseline spec absent from the corrupted run did not flip", () => {
    const r = computeFaultInjectionScore(["a", "b"], [{ name: "a", status: "fail" }]);
    assert.equal(r.killed, 1);
    assert.equal(r.valueScore, 0.5);
  });

  it("a failure caused by the corruption BREAKING the flow (navigation/network) is NOT a kill", () => {
    const corrupted: QaCase[] = [
      { name: "a", status: "fail", detail: "expect(locator).toHaveText: Expected '10' Received '-10'" }, // assertion caught it
      { name: "b", status: "fail", detail: "page.goto: net::ERR_CONNECTION_REFUSED at /orders/-1" }, // flow broke
    ];
    const r = computeFaultInjectionScore(["a", "b"], corrupted);
    assert.equal(r.killed, 1); // only the assertion-based catch counts
    assert.equal(r.total, 2);
    assert.equal(r.valueScore, 0.5);
  });
});

describe("isFlowBreak / FLOW_BREAK", () => {
  it("matches a navigation/network flow-break signature", () => {
    assert.equal(isFlowBreak({ name: "a", status: "fail", detail: "page.goto: net::ERR_CONNECTION_REFUSED" }), true);
  });

  it("does not match a plain assertion timeout", () => {
    assert.equal(isFlowBreak({ name: "a", status: "fail", detail: "expect(locator).toBeVisible timed out" }), false);
  });

  it("checks both detail and reason fields", () => {
    assert.equal(isFlowBreak({ name: "a", status: "fail", reason: "ECONNREFUSED" }), true);
  });

  it("FLOW_BREAK is exported for direct inspection", () => {
    assert.ok(FLOW_BREAK instanceof RegExp);
  });
});
