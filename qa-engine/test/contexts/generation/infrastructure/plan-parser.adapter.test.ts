// test/contexts/generation/infrastructure/plan-parser.adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PlanParserAdapter } from "@contexts/generation/infrastructure/plan-parser.adapter.ts";

test("parse delegates to parsePlan and maps PlanObjective to PlanObjectiveView", () => {
  let seenText = "";
  const adapter = new PlanParserAdapter(
    (text) => {
      seenText = text;
      return [
        { flow: "login", objective: "user can log in", symbols: ["AuthService"], needsUi: true },
        { flow: "checkout", objective: "user completes checkout", symbols: ["CheckoutComponent"], needsUi: true },
      ];
    },
  );
  const views = adapter.parse("planner output text");
  // DELEGATION: injected fn received the text (a gutted impl that ignores it FAILS this)
  assert.equal(seenText, "planner output text");
  assert.equal(views.length, 2);
  assert.equal(views[0]?.flow, "login");
  assert.equal(views[0]?.objective, "user can log in");
  assert.equal(views[1]?.flow, "checkout");
  assert.equal(views[1]?.objective, "user completes checkout");
});

test("parse returns empty array when parsePlan finds no objectives", () => {
  const adapter = new PlanParserAdapter(() => []);
  const views = adapter.parse("no JSON here");
  assert.deepEqual(views, []);
});

test("parse preserves flow/objective mapping faithfully (no field dropped or invented)", () => {
  let called = false;
  const adapter = new PlanParserAdapter((text) => {
    called = true;
    void text;
    return [{ flow: "auth-flow", objective: "check login", symbols: [], needsUi: false }];
  });
  const views = adapter.parse("some text");
  assert.equal(called, true); // DELEGATION: a gutted impl that returns a literal FAILS this
  assert.equal(views[0]?.flow, "auth-flow");
  assert.equal(views[0]?.objective, "check login");
});
