import { test } from "node:test";
import assert from "node:assert/strict";
import { PromptBudgetAdapter } from "@contexts/generation/infrastructure/prompt-budget.adapter.ts";

test("budgetForRole delegates to roleWindowBytes with the role (NO hardcoded byte count asserted)", () => {
  let seenRole = "";
  const SENTINEL = 123_456; // an arbitrary marker — proves forwarding, NOT a real model budget
  const adapter = new PromptBudgetAdapter(
    (role) => { seenRole = role; return SENTINEL; },
    (diff) => diff.slice(0, 10),
    (text) => text.slice(0, 10),
  );
  const bytes = adapter.budgetForRole("qa-generator");
  assert.equal(seenRole, "qa-generator");   // DELEGATION: the role was forwarded
  assert.equal(bytes, SENTINEL);             // the result was forwarded verbatim — no 192k/96k literal
});

test("capDiff/capText delegate to the injected cappers", () => {
  const adapter = new PromptBudgetAdapter(() => 0, (d) => `D:${d}`, (t) => `T:${t}`);
  assert.equal(adapter.capDiff("x"), "D:x");
  assert.equal(adapter.capText("y"), "T:y");
});
