import { test } from "node:test";
import assert from "node:assert/strict";
import { createUsageAccumulator, type UsageSnapshot } from "./usage";

function snap(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    input: 100,
    output: 50,
    reasoning: 20,
    cacheRead: 5,
    cacheWrite: 3,
    cost: 0.001,
    ...over,
  };
}

test("result() returns undefined when no snapshots were added", () => {
  const acc = createUsageAccumulator();
  assert.equal(acc.result(true), undefined);
  assert.equal(acc.result(false), undefined);
});

test("result() returns a RunUsage with complete=true after one add", () => {
  const acc = createUsageAccumulator();
  acc.add(snap());
  const r = acc.result(true);
  assert.ok(r !== undefined);
  assert.equal(r.complete, true);
});

test("result() returns a RunUsage with complete=false when caller passes false", () => {
  const acc = createUsageAccumulator();
  acc.add(snap());
  const r = acc.result(false);
  assert.ok(r !== undefined);
  assert.equal(r.complete, false);
});

test("add() sums two snapshots: every token field is summed", () => {
  const acc = createUsageAccumulator();
  acc.add(snap({ input: 100, output: 50, reasoning: 20, cacheRead: 5, cacheWrite: 3, cost: 0.001 }));
  acc.add(snap({ input: 200, output: 80, reasoning: 30, cacheRead: 10, cacheWrite: 2, cost: 0.002 }));
  const r = acc.result(true);
  assert.ok(r !== undefined);
  assert.equal(r.tokens.input, 300);
  assert.equal(r.tokens.output, 130);
  assert.equal(r.tokens.reasoning, 50);
  assert.equal(r.tokens.cacheRead, 15);
  assert.equal(r.tokens.cacheWrite, 5);
});

test("total = input + output + reasoning (cache fields are excluded)", () => {
  const acc = createUsageAccumulator();
  acc.add(snap({ input: 100, output: 50, reasoning: 20, cacheRead: 999, cacheWrite: 888, cost: 0 }));
  const r = acc.result(true);
  assert.ok(r !== undefined);
  assert.equal(r.tokens.total, 100 + 50 + 20, "total must equal input + output + reasoning, not include cache");
});

test("cost field is present and equals sum of snapshot.cost values when >= 1 snapshot fired", () => {
  const acc = createUsageAccumulator();
  acc.add(snap({ cost: 0.001 }));
  acc.add(snap({ cost: 0.003 }));
  const r = acc.result(true);
  assert.ok(r !== undefined);
  // Floating-point: use approximate comparison
  assert.ok(Math.abs((r.cost ?? 0) - 0.004) < 1e-9, `expected cost ~0.004, got ${r.cost}`);
});

test("cost field is present even when cost=0 in snapshot (SDK supplied it)", () => {
  const acc = createUsageAccumulator();
  acc.add(snap({ cost: 0 }));
  const r = acc.result(true);
  assert.ok(r !== undefined);
  assert.equal(typeof r.cost, "number", "cost must be a number when snapshots were added");
  assert.equal(r.cost, 0);
});

test("0-value snapshot (all fields zero) still makes result() return a defined object", () => {
  const acc = createUsageAccumulator();
  acc.add({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  const r = acc.result(true);
  assert.ok(r !== undefined, "a zero-value snapshot still increments count to 1");
  assert.equal(r.tokens.total, 0);
});

test("accumulator is independent across createUsageAccumulator() calls", () => {
  const a = createUsageAccumulator();
  const b = createUsageAccumulator();
  a.add(snap({ input: 500 }));
  assert.ok(a.result(true) !== undefined);
  assert.equal(b.result(true), undefined, "a second accumulator must not share state");
});
