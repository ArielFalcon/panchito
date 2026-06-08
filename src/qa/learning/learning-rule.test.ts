import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ruleKey,
  deduplicateRules,
  selectForRetrieval,
  renderRulesForPrompt,
  type LearningRule,
  type RuleUpsert,
} from "./learning-rule";

function rule(overrides: Partial<LearningRule> = {}): LearningRule {
  return {
    id: "rule-1",
    trigger: "form without validation",
    action: "test invalid input",
    errorClass: "E-FALSE-POSITIVE",
    confidence: "low",
    usageCount: 0,
    successRate: null,
    lastVerified: null,
    source: "run-1",
    status: "candidate",
    at: new Date().toISOString(),
    ...overrides,
  };
}

describe("ruleKey", () => {
  it("produces stable key from trigger + action", () => {
    assert.equal(ruleKey({ trigger: "a", action: "b" }), "a::b");
  });
});

describe("deduplicateRules", () => {
  it("inserts new candidates when none exist", () => {
    const { toInsert, toSkip } = deduplicateRules(
      [{ trigger: "a", action: "b", errorClass: "E-STATIC", source: "run-1" }],
      [],
    );
    assert.equal(toInsert.length, 1);
    assert.equal(toSkip.length, 0);
  });

  it("skips duplicates against existing rules", () => {
    const existing = [rule({ trigger: "a", action: "b" })];
    const { toInsert, toSkip } = deduplicateRules(
      [{ trigger: "a", action: "b", errorClass: "E-STATIC", source: "run-2" }],
      existing,
    );
    assert.equal(toInsert.length, 0);
    assert.equal(toSkip.length, 1);
  });

  it("deduplicates within the same batch", () => {
    const { toInsert } = deduplicateRules(
      [
        { trigger: "a", action: "b", errorClass: "E-STATIC", source: "run-1" },
        { trigger: "a", action: "b", errorClass: "E-STATIC", source: "run-2" },
      ],
      [],
    );
    assert.equal(toInsert.length, 1);
  });
});

describe("selectForRetrieval", () => {
  it("returns active and candidate rules, scored and sorted", () => {
    const rules = [
      rule({ id: "r1", errorClass: "E-FALSE-POSITIVE", confidence: "high", usageCount: 5, status: "active" }),
      rule({ id: "r2", errorClass: "E-STATIC", confidence: "low", usageCount: 0, status: "active" }),
      rule({ id: "r3", errorClass: "E-FALSE-POSITIVE", confidence: "medium", usageCount: 2, status: "candidate" }),
    ];
    const result = selectForRetrieval(rules, { app: "test", errorClass: "E-FALSE-POSITIVE" });
    assert.equal(result[0]!.id, "r1"); // high confidence + matching errorClass
    assert.ok(result.length >= 2);
  });

  it("excludes deprecated and superseded rules", () => {
    const rules = [
      rule({ id: "r1", status: "deprecated" }),
      rule({ id: "r2", status: "superseded" }),
      rule({ id: "r3", status: "active" }),
    ];
    const result = selectForRetrieval(rules, { app: "test" });
    assert.equal(result.length, 1);
    assert.equal(result[0]!.id, "r3");
  });

  it("respects maxRules", () => {
    const rules = Array.from({ length: 10 }, (_, i) =>
      rule({ id: `r${i}`, status: "active" }),
    );
    const result = selectForRetrieval(rules, { app: "test", maxRules: 3 });
    assert.equal(result.length, 3);
  });
});

describe("renderRulesForPrompt", () => {
  it("returns empty string for no rules", () => {
    assert.equal(renderRulesForPrompt([]), "");
  });

  it("renders rules with trigger and action", () => {
    const rules = [rule({ errorClass: "E-FALSE-POSITIVE", confidence: "high", trigger: "click without assert", action: "assert outcome" })];
    const output = renderRulesForPrompt(rules);
    assert.match(output, /E-FALSE-POSITIVE/);
    assert.match(output, /click without assert/);
    assert.match(output, /assert outcome/);
  });
});
