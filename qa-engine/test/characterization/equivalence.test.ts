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

// G2 (Plan 6 addendum): catalogGate* fields are set on every persistOutcome call in pipeline.ts
// (pipeline.ts:1018-1020) but were comparator-blind — a rewrite could silently drop Pillar-2
// catalog-gate telemetry undetected. Wired into behavioralProjection with the same 0-not-undefined
// normalization the design already uses elsewhere (missing/undefined defaults to 0, the semantic
// "gate did not fire" value both sides agree on when neither ran the catalog gate).
test("equivalence: a different catalogGateInWindow is NOT equivalent", () => {
  const a = { ...base, gateSignals: { ...base.gateSignals, catalogGateInWindow: 2 } };
  const b = { ...base, runId: "r2", gateSignals: { ...base.gateSignals, catalogGateInWindow: 5 } };
  assert.equal(runOutcomeEquivalent(a, b).equal, false);
});

test("equivalence: a different catalogGateAdvisory is NOT equivalent", () => {
  const a = { ...base, gateSignals: { ...base.gateSignals, catalogGateAdvisory: 1 } };
  const b = { ...base, runId: "r2", gateSignals: { ...base.gateSignals, catalogGateAdvisory: 3 } };
  assert.equal(runOutcomeEquivalent(a, b).equal, false);
});

test("equivalence: a different catalogGateFailClosed is NOT equivalent", () => {
  const a = { ...base, gateSignals: { ...base.gateSignals, catalogGateFailClosed: 0 } };
  const b = { ...base, runId: "r2", gateSignals: { ...base.gateSignals, catalogGateFailClosed: 4 } };
  assert.equal(runOutcomeEquivalent(a, b).equal, false);
});

test("equivalence: catalogGate* absent on one side and 0 on the other IS equivalent (0-not-undefined normalization)", () => {
  const a = base; // no catalogGate* fields at all (stale golden shape)
  const b = { ...base, runId: "r2", gateSignals: { ...base.gateSignals, catalogGateInWindow: 0, catalogGateAdvisory: 0, catalogGateFailClosed: 0 } };
  assert.equal(runOutcomeEquivalent(a, b).equal, true);
});
