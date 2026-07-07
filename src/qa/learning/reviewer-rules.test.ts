import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderRulesForReviewer, type LearningRule } from "./learning-rule";

function r(over: Partial<LearningRule>): LearningRule {
  return {
    id: "r",
    trigger: "Applies when a test selects by CSS class in generated-style apps",
    action: "use getByRole or a stable data-testid",
    errorClass: "E-FRAGILE-SELECTOR",
    confidence: "high",
    usageCount: 0,
    outcomeCount: 5,
    oracleOutcomeCount: 5,
    successRate: 0.8,
    lastVerified: null,
    source: "run-1",
    status: "active",
    at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("renderRulesForReviewer — proven rules as reject-on-sight criteria", () => {
  it("renders ONLY active (proven) rules — never unproven candidates or demoted rules", () => {
    const out = renderRulesForReviewer([
      r({ id: "a", status: "active", trigger: "Applies when the form lacks an invalid-input test" }),
      r({ id: "c", status: "candidate", trigger: "Applies when SPECULATIVE candidate" }),
      r({ id: "d", status: "deprecated", trigger: "Applies when DEPRECATED rule" }),
    ]);
    assert.match(out, /the form lacks an invalid-input test/);
    assert.doesNotMatch(out, /SPECULATIVE candidate/, "candidates are not enforced by the judge");
    assert.doesNotMatch(out, /DEPRECATED rule/, "demoted rules are never enforced");
  });

  it("frames the rules as reject criteria and includes trigger, action, and class", () => {
    const out = renderRulesForReviewer([r({ status: "active" })]);
    assert.match(out, /reject/i, "tells the judge to reject on violation");
    assert.match(out, /use getByRole/); // the action
    assert.match(out, /E-FRAGILE-SELECTOR/); // the class tag
  });

  it("returns empty string when there are no active rules (nothing to enforce)", () => {
    assert.equal(renderRulesForReviewer([]), "");
    assert.equal(renderRulesForReviewer([r({ status: "candidate" }), r({ status: "deprecated" })]), "");
  });
});
