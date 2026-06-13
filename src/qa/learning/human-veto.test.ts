import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { upsertLearningRule, listAllLearningRules, listLearningRules, recordRuleOutcome, setRuleStatusByHuman } from "../../server/history";

// The SQLite DB persists across runs; suffix the app so repeated suite runs never collide.
function uniqueApp(): string {
  return `veto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("human veto / restore (setRuleStatusByHuman)", () => {
  it("vetoing forces a rule to deprecated; restoring returns it to active", () => {
    const app = uniqueApp();
    const id = `${app}-r`;
    upsertLearningRule({ id, app, trigger: "Applies when x changes", action: "do y", errorClass: "E-FRAGILE-SELECTOR", source: "run-1" });

    assert.equal(setRuleStatusByHuman(id, "deprecated"), true, "veto reports success");
    assert.equal(listAllLearningRules(app, 10).find((x) => x.id === id)?.status, "deprecated");

    assert.equal(setRuleStatusByHuman(id, "active"), true, "restore reports success");
    assert.equal(listAllLearningRules(app, 10).find((x) => x.id === id)?.status, "active");
  });

  it("returns false for an unknown rule id (no silent success)", () => {
    assert.equal(setRuleStatusByHuman(`${uniqueApp()}-missing`, "deprecated"), false);
  });

  it("a vetoed rule vanishes from the retrieval list — so it is never re-injected (the veto sticks)", () => {
    const app = uniqueApp();
    const id = `${app}-r`;
    upsertLearningRule({ id, app, trigger: "Applies when x changes", action: "do y", errorClass: "E-FRAGILE-SELECTOR", source: "run-1" });
    for (let i = 0; i < 3; i++) recordRuleOutcome(id, 1); // earn promotion → active → retrievable
    assert.ok(listLearningRules(app, 10).some((r) => r.id === id), "precondition: an active rule is in the retrieval list");

    setRuleStatusByHuman(id, "deprecated");
    assert.equal(listLearningRules(app, 10).some((r) => r.id === id), false, "vetoed → excluded from retrieval → no new outcomes → cannot auto-resurrect");
  });
});
