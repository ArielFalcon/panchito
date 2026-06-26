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

// ── WRAP-3 forwarding: symbols / needsUi / brief ─────────────────────────────
// These assertions give the tests teeth: a gutted adapter that maps only flow/objective
// returns undefined/false for all three and FAILS every check below.

test("WRAP-3: parse forwards symbols from parsePlan — a gutted impl returning [] FAILS this", () => {
  const adapter = new PlanParserAdapter((_text) => [
    { flow: "payment", objective: "user pays", symbols: ["PaymentService.charge", "CartStore.total"], needsUi: true },
  ]);
  const views = adapter.parse("");
  assert.deepEqual(views[0]?.symbols, ["PaymentService.charge", "CartStore.total"],
    "symbols must be forwarded from the parsed objective; a gutted adapter returning [] FAILS this");
});

test("WRAP-3: parse forwards needsUi=true — a gutted impl hardcoding false FAILS this", () => {
  const adapter = new PlanParserAdapter((_text) => [
    { flow: "search", objective: "user searches products", symbols: [], needsUi: true },
  ]);
  const views = adapter.parse("");
  assert.equal(views[0]?.needsUi, true,
    "needsUi must be forwarded; a gutted adapter hardcoding false FAILS this");
});

test("WRAP-3: parse forwards needsUi=false for code-only objectives — a gutted impl hardcoding true FAILS this", () => {
  const adapter = new PlanParserAdapter((_text) => [
    { flow: "data-transform", objective: "validates input schema", symbols: ["validate"], needsUi: false },
  ]);
  const views = adapter.parse("");
  assert.equal(views[0]?.needsUi, false,
    "needsUi=false must be forwarded; a gutted adapter hardcoding true FAILS this");
});

test("WRAP-3: parse forwards brief when present — a gutted impl omitting it leaves brief undefined FAILS this", () => {
  const brief = {
    builtForSha: "abc123",
    objective: "payment flow",
    blastRadius: [{ symbol: "PaymentService.charge", file: "src/payment.ts", role: "processes payment" }],
  };
  const adapter = new PlanParserAdapter((_text) => [
    { flow: "payment", objective: "user pays", symbols: ["PaymentService.charge"], needsUi: true, brief },
  ]);
  const views = adapter.parse("");
  assert.deepEqual(views[0]?.brief, brief,
    "brief must be forwarded when present; a gutted adapter omitting it FAILS this");
});

test("WRAP-3: parse omits brief when not present — no spurious undefined key added", () => {
  const adapter = new PlanParserAdapter((_text) => [
    { flow: "login", objective: "user logs in", symbols: ["AuthService"], needsUi: true },
  ]);
  const views = adapter.parse("");
  assert.equal(views[0]?.brief, undefined, "brief must be absent when the parsed objective has none");
});
