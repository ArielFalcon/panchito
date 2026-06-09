import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ruleKey,
  deduplicateRules,
  selectForRetrieval,
  renderRulesForPrompt,
  applyOutcome,
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
    outcomeCount: 0,
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

  it("ranks active rules by successRate (the attribution signal)", () => {
    // listed worst-first to prove the ranking is by successRate, not input order.
    const rules = [
      rule({ id: "lo", status: "active", successRate: 0.2, outcomeCount: 5 }),
      rule({ id: "hi", status: "active", successRate: 0.9, outcomeCount: 5 }),
    ];
    const result = selectForRetrieval(rules, { app: "test" });
    assert.equal(result[0]!.id, "hi");
  });

  it("ranks any active rule above any candidate (exploit before explore)", () => {
    const rules = [
      rule({ id: "cand", status: "candidate", successRate: 0.95, outcomeCount: 1 }),
      rule({ id: "act", status: "active", successRate: 0.3, outcomeCount: 5 }),
    ];
    const result = selectForRetrieval(rules, { app: "test" });
    assert.equal(result[0]!.id, "act");
  });
});

describe("applyOutcome", () => {
  it("sets successRate to the score on the first outcome", () => {
    const r = applyOutcome(rule({ outcomeCount: 0, successRate: null }), 0.8);
    assert.equal(r.successRate, 0.8);
    assert.equal(r.outcomeCount, 1);
    assert.equal(r.status, "candidate"); // not enough outcomes to promote yet
  });

  it("accumulates as a running mean, never an overwrite", () => {
    let r = rule({ outcomeCount: 0, successRate: null });
    r = applyOutcome(r, 1.0);
    r = applyOutcome(r, 0.0);
    r = applyOutcome(r, 0.5);
    assert.equal(r.outcomeCount, 3);
    assert.ok(Math.abs(r.successRate! - 0.5) < 1e-9, `expected ~0.5, got ${r.successRate}`);
  });

  it("promotes a candidate to active after enough good outcomes", () => {
    let r = rule({ status: "candidate" });
    r = applyOutcome(r, 0.8);
    r = applyOutcome(r, 0.8);
    assert.equal(r.status, "candidate"); // only 2 outcomes
    r = applyOutcome(r, 0.8);
    assert.equal(r.status, "active"); // 3 outcomes, mean >= promote threshold
  });

  it("does NOT promote when the mean stays below the threshold", () => {
    let r = rule({ status: "candidate" });
    r = applyOutcome(r, 0.5);
    r = applyOutcome(r, 0.5);
    r = applyOutcome(r, 0.5);
    assert.equal(r.status, "candidate");
  });

  it("demotes an active rule only after SUSTAINED low outcomes (tolerant, not trigger-happy)", () => {
    let r = rule({ status: "active", successRate: 0.8, outcomeCount: 3 });
    r = applyOutcome(r, 0.0);
    r = applyOutcome(r, 0.0);
    r = applyOutcome(r, 0.0);
    assert.equal(r.status, "active"); // a few failures do NOT flip a trusted rule
    for (let i = 0; i < 6; i++) r = applyOutcome(r, 0.0); // but sustained failure does
    assert.equal(r.status, "deprecated");
  });

  it("hysteresis: an active rule in the dead band [0.3,0.6) is NOT demoted", () => {
    let r = rule({ status: "active", successRate: 0.45, outcomeCount: 5 });
    r = applyOutcome(r, 0.45);
    r = applyOutcome(r, 0.45);
    assert.equal(r.status, "active");
  });

  it("is reversible: a deprecated rule recovers to active with good outcomes", () => {
    const r = applyOutcome(rule({ status: "deprecated", successRate: 0.5, outcomeCount: 2 }), 0.9);
    assert.equal(r.status, "active"); // resurrected, nothing was deleted
  });

  it("a single anomalous outcome barely moves a high-confidence rule", () => {
    const r = applyOutcome(rule({ status: "active", successRate: 0.9, outcomeCount: 20 }), 0.0);
    assert.ok(r.successRate! > 0.85, `expected >0.85, got ${r.successRate}`);
    assert.equal(r.status, "active"); // one bad event does not flip it
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
