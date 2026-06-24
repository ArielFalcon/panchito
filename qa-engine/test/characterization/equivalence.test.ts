import { test } from "node:test";
import assert from "node:assert/strict";
import { runOutcomeEquivalent, type ComparableOutcome } from "./equivalence.ts";

const base: ComparableOutcome = {
  runId: "r1",
  app: "demo",
  sha: "abc",
  mode: "diff",
  target: "e2e",
  verdict: "pass",
  errorClass: null,
  gateSignals: {
    static: true,
    coverageRatio: 0.8,
    valueScore: null,
    reviewerCorrections: [],
    reviewerApproved: true,
    flaky: false,
    retries: 0,
  },
  at: "2026-06-24T00:00:00.000Z",
};

test("equivalence: identical-except-runId/at outcomes are equivalent", () => {
  const other = { ...base, runId: "r2", at: "2026-06-25T12:00:00.000Z" };
  assert.equal(runOutcomeEquivalent(base, other).equal, true);
});

test("equivalence: a different verdict is NOT equivalent", () => {
  const other = { ...base, runId: "r2", at: "later", verdict: "fail" as const };
  const r = runOutcomeEquivalent(base, other);
  assert.equal(r.equal, false);
  assert.match(r.diff ?? "", /verdict/);
});

test("equivalence: a different coverageRatio is NOT equivalent", () => {
  const other = { ...base, gateSignals: { ...base.gateSignals, coverageRatio: 0.5 } };
  assert.equal(runOutcomeEquivalent(base, other).equal, false);
});

test("equivalence: reviewerRationale text is ignored (not behavioral)", () => {
  const a = { ...base, gateSignals: { ...base.gateSignals, reviewerRationale: "looks good" } };
  const b = { ...base, runId: "r2", gateSignals: { ...base.gateSignals, reviewerRationale: "approved, solid" } };
  assert.equal(runOutcomeEquivalent(a, b).equal, true);
});
