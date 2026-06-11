import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeFaultInjectionScore, runFaultInjectionOracle } from "./fault-injection-e2e";
import type { QaCase } from "../../types";

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
});

describe("runFaultInjectionOracle", () => {
  it("returns null valueScore when required inputs are missing", async () => {
    const r = await runFaultInjectionOracle({ target: "e2e", repoDir: "/x", namespace: "ns" });
    assert.equal(r.valueScore, null);
  });

  it("computes the response-oracle catch-rate from a corrupted re-run", async () => {
    const r = await runFaultInjectionOracle(
      { target: "e2e", repoDir: "/x", e2eDir: "/x/e2e", baseUrl: "http://dev", namespace: "ns", baselineCases: ["a", "b"] },
      {
        runCorrupted: async () => ({
          sha: "ns-fi",
          verdict: "fail",
          passed: false,
          cases: [{ name: "a", status: "fail" }, { name: "b", status: "pass" }],
          logs: "",
        }),
        countInjected: () => 3,
      },
    );
    assert.equal(r.valueScore, 0.5);
    assert.equal(r.killedCount, 1);
    assert.equal(r.mutantCount, 2);
  });

  it("returns null when the corrupted re-run is inconclusive (infra-error)", async () => {
    const r = await runFaultInjectionOracle(
      { target: "e2e", repoDir: "/x", e2eDir: "/x/e2e", baseUrl: "http://dev", namespace: "ns", baselineCases: ["a"] },
      {
        runCorrupted: async () => ({ sha: "ns-fi", verdict: "infra-error", passed: false, cases: [], logs: "" }),
        countInjected: () => 0,
      },
    );
    assert.equal(r.valueScore, null);
  });
});
