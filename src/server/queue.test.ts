import { test } from "node:test";
import assert from "node:assert/strict";
import { JobQueue } from "./queue";

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("processes one at a time (no overlap) and in order", async () => {
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

  assert.deepEqual(order, ["a", "b", "c"]); // order preserved
  assert.equal(maxConcurrent, 1); // never two at once
});

test("a failing job does not stop the following ones", async () => {
  const errors: unknown[] = [];
  const q = new JobQueue((e) => errors.push(e));
  const done: string[] = [];

  q.enqueue(async (_signal) => {
    throw new Error("boom");
  });
  q.enqueue(async (_signal) => {
    done.push("next");
  });
  await q.drain();

  assert.equal(errors.length, 1);
  assert.deepEqual(done, ["next"]);
});

test("size reflects pending work and returns to 0 after draining", async () => {
  const q = new JobQueue();
  q.enqueue(async (_signal) => await tick(5));
  q.enqueue(async (_signal) => await tick(5));
  assert.equal(q.size, 2);
  await q.drain();
  assert.equal(q.size, 0);
});

test("cancel aborts the currently-running job via AbortSignal", async () => {
  const q = new JobQueue();
  let aborted = false;

  q.enqueue(async (signal) => {
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      }, { once: true });
      // Never resolve naturally
    });
  });

  // Give the job time to start
  await tick(5);
  assert.equal(aborted, false);
  assert.equal(q.cancel(), true);
  await tick(5);
  assert.equal(aborted, true);
});

test("cancel returns false when no job is running", () => {
  const q = new JobQueue();
  assert.equal(q.cancel(), false);
});
