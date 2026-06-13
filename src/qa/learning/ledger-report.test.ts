import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderLedgerReport } from "./ledger-report";
import type { LearningRule } from "./learning-rule";

function rule(overrides: Partial<LearningRule> = {}): LearningRule {
  return {
    id: "r",
    trigger: "Applies when the diff adds a form with no invalid-input test",
    action: "submit invalid data and assert the visible error message",
    errorClass: "E-FALSE-POSITIVE",
    confidence: "low",
    usageCount: 0,
    outcomeCount: 0,
    successRate: null,
    lastVerified: null,
    source: "run-1",
    status: "candidate",
    at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("renderLedgerReport — human-readable audit view", () => {
  it("renders a friendly empty state", () => {
    const out = renderLedgerReport([], { app: "portfolio" });
    assert.match(out, /portfolio/);
    assert.match(out, /No learned rules yet/);
  });

  it("renders an active rule as prose: trigger, action, oracle provenance, and evidence", () => {
    const out = renderLedgerReport([
      rule({ status: "active", confidence: "high", successRate: 0.87, outcomeCount: 12, errorClass: "E-FRAGILE-SELECTOR" }),
    ]);
    assert.match(out, /Applies when the diff adds a form/); // the trigger reads as prose
    assert.match(out, /submit invalid data and assert/); // the action
    assert.match(out, /proven by the oracle/); // high confidence → ground-truth, in words
    assert.match(out, /87% success over 12 outcomes/); // evidence
    assert.match(out, /fragile selector/); // human label, not the E-… code
  });

  it("describes a medium rule as a prevention-signal hold and an unproven candidate plainly", () => {
    const medium = renderLedgerReport([rule({ status: "active", confidence: "medium", successRate: 0.6, outcomeCount: 5 })]);
    assert.match(medium, /prevention signal/);
    const cand = renderLedgerReport([rule({ status: "candidate", confidence: "low" })]);
    assert.match(cand, /unproven/);
    assert.match(cand, /no outcomes yet/);
  });

  it("groups by status with ACTIVE before CANDIDATE before DEPRECATED", () => {
    const out = renderLedgerReport([
      rule({ id: "c", status: "candidate" }),
      rule({ id: "a", status: "active", confidence: "high", successRate: 0.9, outcomeCount: 4 }),
      rule({ id: "d", status: "deprecated", successRate: 0.1, outcomeCount: 9 }),
    ]);
    assert.ok(out.indexOf("ACTIVE") < out.indexOf("CANDIDATE"), "active section first");
    assert.ok(out.indexOf("CANDIDATE") < out.indexOf("DEPRECATED"), "deprecated last");
    assert.match(out, /DEPRECATED/);
  });

  it("flags a malformed (non-canonical) trigger so a human can fix it", () => {
    const out = renderLedgerReport([rule({ status: "active", trigger: "the diff adds X", confidence: "medium", successRate: 0.6, outcomeCount: 3 })]);
    assert.match(out, /needs rephrasing/);
  });

  it("a demoted rule with stale high confidence does NOT claim present-tense oracle proof", () => {
    // Reachable via a human veto: deprecating an active+high rule leaves confidence stale.
    const out = renderLedgerReport([rule({ status: "deprecated", confidence: "high", successRate: 0.9, outcomeCount: 10 })]);
    assert.doesNotMatch(out, /proven by the oracle/, "no present-tense trust claim under DEPRECATED");
    assert.match(out, /no longer trusted/);
  });

  it("renders an unknown/future error-class code verbatim instead of crashing", () => {
    const out = renderLedgerReport([rule({ errorClass: "E-FUTURE-CODE" as unknown as LearningRule["errorClass"] })]);
    assert.match(out, /E-FUTURE-CODE/);
  });

  it("uses singular 'outcome' for a single outcome", () => {
    const out = renderLedgerReport([rule({ status: "active", confidence: "low", successRate: 0.5, outcomeCount: 1 })]);
    assert.match(out, /over 1 outcome\b/);
    assert.doesNotMatch(out, /1 outcomes/);
  });
});
