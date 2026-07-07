import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { upsertLearningRule, listLearningRules, recordRuleOutcome } from "../../server/history";
import { retrieveRules } from "./retrieval";

describe("retrieveRules: usage incremented only on the budget-fitted set (real-DB integration)", () => {
  it("does not increment usage for rules dropped by fitRulesToBudget", () => {
    // Unique app name per run so repeated test invocations never collide on DB state.
    const app = `retrieval-budget-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const big = "z".repeat(700); // 8 × (700 + ~80 header) ≈ 6240 >> 5000-char budget, forces a drop

    // Seed 8 active rules with 400-char actions. 8 × ~400 chars >> the 5000-char budget,
    // so fitRulesToBudget must drop tail rules before incrementing usage.
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const id = `rule-budget-${app}-${i}`;
      ids.push(id);
      upsertLearningRule({
        id,
        app,
        trigger: `Applies when the diff adds a form (case ${i})`,
        action: `${big}-variant-${i}`,
        errorClass: "E-FALSE-POSITIVE",
        source: "test",
      });
      // Fold in 3 good ORACLE-scored outcomes to promote each rule to active so they are all
      // equally ranked and the budget alone determines which are dropped. WS1.4(b): isOracleScore
      // must be true or these would all stay candidate instead of being promoted.
      for (let j = 0; j < 3; j++) recordRuleOutcome(id, 0.9, null, true);
    }

    const out = retrieveRules({ app, maxRules: 8 });

    // The fitted set must be smaller than 8 (budget exceeded with 400-char actions × 8).
    assert.ok(out.rules.length < 8, `expected fewer than 8 rules, got ${out.rules.length}`);

    // Only the fitted (returned) rules should have usageCount > 0. Re-read all rules from DB
    // and verify: fitted IDs have usage, dropped IDs do not.
    const allAfter = listLearningRules(app, 50);
    const fittedIds = new Set(out.rules.map((r) => r.id));
    for (const r of allAfter) {
      if (fittedIds.has(r.id)) {
        assert.ok(r.usageCount > 0, `fitted rule ${r.id} must have usageCount > 0`);
      } else {
        assert.equal(r.usageCount, 0, `dropped rule ${r.id} must still have usageCount === 0`);
      }
    }

    // out.rules matches out.promptSection: no phantom rules rendered beyond the returned set.
    for (const r of out.rules) {
      assert.ok(
        out.promptSection.includes(r.action),
        `rendered section must include action of fitted rule ${r.id}`,
      );
    }
  });
});
