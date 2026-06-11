import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunEventStore } from "./run-events";

test("RunEventStore stamps seq per run and replays after a cursor", () => {
  const store = createRunEventStore({ now: () => 10 });
  const first = store.publish("r1", { type: "step.changed", step: "generate" });
  const second = store.publish("r1", { type: "step.changed", step: "execute" });
  const other = store.publish("r2", { type: "step.changed", step: "setup" });

  assert.equal(first.seq, 0);
  assert.equal(second.seq, 1);
  assert.equal(other.seq, 0);
  assert.deepEqual(store.replay("r1", 0), [second]);
});

test("RunEventStore keeps only the configured replay window", () => {
  const store = createRunEventStore({ maxEventsPerRun: 2, now: () => 10 });
  store.publish("r1", { type: "step.changed", step: "setup" });
  const kept1 = store.publish("r1", { type: "step.changed", step: "generate" });
  const kept2 = store.publish("r1", { type: "step.changed", step: "execute" });

  assert.deepEqual(store.replay("r1"), [kept1, kept2]);
});

test("RunEventStore evicts the oldest run's buffer past the retention cap (no leak)", () => {
  const store = createRunEventStore({ maxRuns: 2, now: () => 10 });
  store.publish("r1", { type: "step.changed", step: "setup" });
  store.publish("r2", { type: "step.changed", step: "setup" });
  store.publish("r3", { type: "step.changed", step: "setup" }); // evicts r1

  assert.deepEqual(store.replay("r1"), []); // dropped
  assert.equal(store.replay("r2").length, 1);
  assert.equal(store.replay("r3").length, 1);
});

test("RunEventStore sanitizes text-bearing event fields before storage", () => {
  const store = createRunEventStore({ now: () => 10 });
  const ev = store.publish("r1", {
    type: "test.failed",
    name: "checkout",
    detail: "boom ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  });

  assert.doesNotMatch(JSON.stringify(ev), /ghp_AAAA/);
  assert.deepEqual(store.replay("r1"), [ev]);
});
