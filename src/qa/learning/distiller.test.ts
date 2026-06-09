import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { distillReflection } from "./distiller";
import { upsertLearningRule, recordRuleOutcome, listLearningRules, listAllLearningRules } from "../../server/history";
import type { StructuredReflection } from "../../types";

function reflection(trigger: string, action: string): StructuredReflection {
  return {
    goal: "g",
    decision: "d",
    assumption: "a",
    errorClass: "E-FALSE-POSITIVE",
    gateSignal: "s",
    evidence: "e",
    rootCause: "rc",
    preventiveRule: { trigger, action },
  };
}

describe("distillReflection dedup against ALL rule statuses", () => {
  it("does NOT insert a duplicate when a DEPRECATED rule with the same trigger::action exists", () => {
    const app = "distill-dep-1";
    const trigger = "endpoint flow without a response assert";
    const action = "assert the response body matches the submitted input";

    // Create a rule, promote it to active, then demote it to 'deprecated' via sustained bad outcomes.
    upsertLearningRule({ id: "dep-rule", app, trigger, action, errorClass: "E-FALSE-POSITIVE", source: "seed" });
    for (let i = 0; i < 3; i++) recordRuleOutcome("dep-rule", 0.9); // → active
    for (let i = 0; i < 8; i++) recordRuleOutcome("dep-rule", 0.0); // → deprecated

    const deprecated = listAllLearningRules(app, 50).find((r) => r.id === "dep-rule");
    assert.equal(deprecated?.status, "deprecated", "precondition: the rule is deprecated");
    assert.equal(
      listLearningRules(app, 50).some((r) => r.id === "dep-rule"),
      false,
      "precondition: a deprecated rule is excluded from the retrieval list",
    );

    // The same failure pattern recurs. Dedup MUST see the deprecated rule and skip — not insert a copy.
    const res = distillReflection({ app, runId: "run-9", reflection: reflection(trigger, action) });
    assert.equal(res.inserted, false, "should dedup against the deprecated rule");

    const dupes = listAllLearningRules(app, 50).filter((r) => r.trigger === trigger && r.action === action);
    assert.equal(dupes.length, 1, "no duplicate row should be created");
  });
});

import { correctionToRuleUpsert, distillReviewerCorrections } from "./distiller";

describe("correctionToRuleUpsert", () => {
  it("classifies via the anti-pattern catalog and falls back to E-REVIEWER-REJECTED", () => {
    const fragile = correctionToRuleUpsert({ correction: "uses a fragile selector on the cart row", runId: "run-1" });
    assert.equal(fragile?.errorClass, "E-FRAGILE-SELECTOR");
    assert.equal(fragile?.action, "uses a fragile selector on the cart row");

    const generic = correctionToRuleUpsert({ correction: "the spec misnames the flow", runId: "run-1" });
    assert.equal(generic?.errorClass, "E-REVIEWER-REJECTED");

    assert.equal(correctionToRuleUpsert({ correction: "   ", runId: "run-1" }), null);
  });
});

describe("distillReviewerCorrections", () => {
  it("inserts one candidate per distinct correction and dedupes against ALL statuses", () => {
    // The SQLite DB persists across test runs on disk; suffix the app so re-running the
    // suite never trips the dedup on its own residue from a previous invocation.
    const app = `shop-f4-distill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const first = distillReviewerCorrections({
      app,
      runId: "run-aaaa1111",
      corrections: [
        "no real assertion on the outcome",
        "no real assertion on the outcome",
        "orphaned test data left behind",
      ],
    });
    assert.equal(first.inserted.length, 2);

    // Re-distilling the same corrections must insert nothing (dedup against ALL statuses).
    const second = distillReviewerCorrections({
      app,
      runId: "run-bbbb2222",
      corrections: ["no real assertion on the outcome"],
    });
    assert.equal(second.inserted.length, 0);
  });

  it("returns no inserts when all corrections are whitespace/empty", () => {
    const app = `shop-empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = distillReviewerCorrections({ app, runId: "run-cccc3333", corrections: ["   ", ""] });
    assert.deepEqual(result.inserted, []);
  });
});
