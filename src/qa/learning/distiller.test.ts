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
