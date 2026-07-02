import { test } from "node:test";
import assert from "node:assert/strict";
import { CycleBudget } from "@contexts/qa-run-orchestration/domain/cycle-budget.ts";

// Ported invariant from src/pipeline.ts:1072-1073/1573/2195-2199 (MAX_CYCLES + cycleCount).
// CycleBudget.derive() defaults to deriveCycleBackstop(maxRetries) unless an explicit
// iterationBudget override is given (the app.qa.iterationBudget config knob — wins unconditionally,
// mirrors `app.qa.iterationBudget ?? deriveCycleBackstop(...)`).

test("CycleBudget.derive: no override — ceiling comes from deriveCycleBackstop(maxRetries)", () => {
  const budget = CycleBudget.derive({ maxRetries: 2 });
  // deriveCycleBackstop(2) = 24 (see derive-cycle-backstop.test.ts)
  assert.equal(budget.ceiling, 24);
  assert.equal(budget.cycleCount, 0);
});

test("CycleBudget.derive: iterationBudget override wins unconditionally over the derived backstop", () => {
  const budget = CycleBudget.derive({ maxRetries: 2, iterationBudget: 5 });
  assert.equal(budget.ceiling, 5);
});

test("CycleBudget.derive: numObjectives threads through to deriveCycleBackstop", () => {
  const budget = CycleBudget.derive({ maxRetries: 2, numObjectives: 3 });
  // deriveCycleBackstop(2, 3) = 24 + 8 = 32 (see derive-cycle-backstop.test.ts)
  assert.equal(budget.ceiling, 32);
});

test("CycleBudget.tick: increments cycleCount by one per call", () => {
  const budget = CycleBudget.derive({ maxRetries: 0 }); // ceiling=16
  const t1 = budget.tick();
  assert.equal(t1.cycleCount, 1);
  const t2 = t1.tick();
  assert.equal(t2.cycleCount, 2);
  // tick() returns a NEW instance — the original is untouched (immutable VO).
  assert.equal(budget.cycleCount, 0);
});

test("CycleBudget.exhausted: false while cycleCount <= ceiling", () => {
  let budget = CycleBudget.derive({ maxRetries: 0 }); // ceiling=16
  for (let i = 0; i < 16; i++) budget = budget.tick();
  assert.equal(budget.cycleCount, 16);
  assert.equal(budget.exhausted(), false);
});

test("CycleBudget.exhausted: true once cycleCount exceeds the ceiling", () => {
  let budget = CycleBudget.derive({ maxRetries: 0 }); // ceiling=16
  for (let i = 0; i < 17; i++) budget = budget.tick();
  assert.equal(budget.cycleCount, 17);
  assert.equal(budget.exhausted(), true);
});

test("CycleBudget.raiseTo: the Phase-6b bump raises the ceiling when the refined value is higher", () => {
  const budget = CycleBudget.derive({ maxRetries: 2 }); // ceiling=24
  const raised = budget.raiseTo(3); // deriveCycleBackstop(2, 3) = 32 > 24
  assert.equal(raised.ceiling, 32);
});

test("CycleBudget.raiseTo: never LOWERS the ceiling — refined <= current ceiling is a no-op", () => {
  const budget = CycleBudget.derive({ maxRetries: 2, numObjectives: 3 }); // ceiling=32
  const raised = budget.raiseTo(1); // deriveCycleBackstop(2, 1) = 24 < 32 — must not shrink
  assert.equal(raised.ceiling, 32);
});

test("CycleBudget.raiseTo: is a no-op (returns an equal-ceiling instance) when an iterationBudget override is set", () => {
  // Mirrors src/pipeline.ts:2195 — the raise only fires `if (!app.qa.iterationBudget && ...)`.
  const budget = CycleBudget.derive({ maxRetries: 2, iterationBudget: 5 });
  const raised = budget.raiseTo(3);
  assert.equal(raised.ceiling, 5);
});

test("CycleBudget.raiseTo: preserves cycleCount across the raise", () => {
  const budget = CycleBudget.derive({ maxRetries: 2 }).tick().tick();
  const raised = budget.raiseTo(3);
  assert.equal(raised.cycleCount, 2);
});
