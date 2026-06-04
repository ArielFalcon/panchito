import { test } from "node:test";
import assert from "node:assert/strict";
import { JobQueue } from "./queue";

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("procesa de a uno (sin solapamiento) y en orden", async () => {
  const q = new JobQueue();
  const order: string[] = [];
  let running = 0;
  let maxConcurrent = 0;

  const job = (id: string, ms: number) => async () => {
    running++;
    maxConcurrent = Math.max(maxConcurrent, running);
    await tick(ms);
    order.push(id);
    running--;
  };

  q.enqueue(job("a", 20));
  q.enqueue(job("b", 5));
  q.enqueue(job("c", 1));
  await q.drain();

  assert.deepEqual(order, ["a", "b", "c"]); // orden preservado
  assert.equal(maxConcurrent, 1); // nunca dos a la vez
});

test("un job que falla no detiene los siguientes", async () => {
  const errors: unknown[] = [];
  const q = new JobQueue((e) => errors.push(e));
  const done: string[] = [];

  q.enqueue(async () => {
    throw new Error("boom");
  });
  q.enqueue(async () => {
    done.push("siguiente");
  });
  await q.drain();

  assert.equal(errors.length, 1);
  assert.deepEqual(done, ["siguiente"]);
});

test("size refleja lo pendiente y vuelve a 0 al drenar", async () => {
  const q = new JobQueue();
  q.enqueue(async () => await tick(5));
  q.enqueue(async () => await tick(5));
  assert.equal(q.size, 2);
  await q.drain();
  assert.equal(q.size, 0);
});
