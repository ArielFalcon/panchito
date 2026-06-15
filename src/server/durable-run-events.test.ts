import { test } from "node:test";
import assert from "node:assert/strict";
import { createDurableRunEventStore } from "./durable-run-events";

type Row = { runId: string; seq: number; ts: number; body: unknown };

test("createDurableRunEventStore persists every published event to the durable backing", () => {
  const durable: Row[] = [];
  const store = createDurableRunEventStore({
    saveRunEvent: (e) => durable.push(e),
    loadRunEvents: () => [],
  });

  const ev = store.publish("r1", { type: "run.started", app: "a", sha: "s", mode: "diff", target: "e2e" });

  assert.equal(durable.length, 1);
  assert.equal(durable[0]!.runId, "r1");
  assert.equal(durable[0]!.seq, ev.seq);
});

test("a fresh store replays events from the SHARED durable backing (the cross-process / restart case)", () => {
  const durable: Row[] = [];
  const writer = createDurableRunEventStore({ saveRunEvent: (e) => durable.push(e), loadRunEvents: () => [] });
  writer.publish("r1", { type: "run.started", app: "a", sha: "s", mode: "diff", target: "e2e" });
  writer.publish("r1", { type: "step.changed", step: "execute" });

  // A SECOND store instance — modelling the orchestrator process reading a run produced by the
  // CLI's own process: its in-memory buffer is empty, so replay must backfill from the durable
  // store. This is exactly what makes an out-of-process run observable.
  const reader = createDurableRunEventStore({
    saveRunEvent: () => {},
    loadRunEvents: (runId, afterSeq) => durable.filter((r) => r.runId === runId && r.seq > afterSeq),
  });

  const replayed = reader.replay("r1", -1);
  assert.equal(replayed.length, 2);
  assert.equal(replayed[0]!.body.type, "run.started");
  assert.equal(replayed[1]!.body.type, "step.changed");
});
