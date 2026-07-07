import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectForRetrieval, type LearningRule } from "./learning-rule";

function r(over: Partial<LearningRule>): LearningRule {
  return {
    id: "r",
    trigger: "Applies when x changes",
    action: "do y",
    errorClass: "E-FRAGILE-SELECTOR",
    confidence: "medium",
    usageCount: 0,
    outcomeCount: 5,
    oracleOutcomeCount: 5,
    successRate: 0.6,
    lastVerified: null,
    source: "seed",
    status: "active",
    at: "2026-01-01T00:00:00.000Z",
    archetype: null,
    ...over,
  };
}

describe("selectForRetrieval — archetype relevance", () => {
  it("boosts a rule whose archetype matches the current diff's structural pattern", () => {
    const rules = [
      r({ id: "api", archetype: "api-call", successRate: 0.8 }),
      r({ id: "form", archetype: "form", successRate: 0.8 }),
    ];
    const picked = selectForRetrieval(rules, { app: "x", archetypes: ["form"], maxRules: 1 });
    assert.equal(picked[0]?.id, "form", "the form-shaped rule wins when the diff is a form change");
  });

  it("earned success still outranks a mere archetype match (relevance never overrides proof)", () => {
    const rules = [
      r({ id: "proven", archetype: "api-call", successRate: 0.9 }),
      r({ id: "match", archetype: "form", successRate: 0.5 }),
    ];
    const picked = selectForRetrieval(rules, { app: "x", archetypes: ["form"], maxRules: 1 });
    assert.equal(picked[0]?.id, "proven", "a strongly-proven rule beats a low-success archetype match");
  });

  it("no archetypes passed → ranking is unchanged (backward compatible)", () => {
    const rules = [
      r({ id: "a", archetype: "form", successRate: 0.7 }),
      r({ id: "b", archetype: "api-call", successRate: 0.9 }),
    ];
    const picked = selectForRetrieval(rules, { app: "x", maxRules: 2 });
    assert.deepEqual(picked.map((x) => x.id), ["b", "a"], "pure successRate order when no archetype hint");
  });
});
