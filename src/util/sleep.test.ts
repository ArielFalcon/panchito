import { test } from "node:test";
import assert from "node:assert/strict";
import { sleep } from "./sleep";

test("sleep resolves after roughly the given ms with no signal", async () => {
  const start = Date.now();
  await sleep(20);
  assert.ok(Date.now() - start >= 15, "should wait at least close to the requested duration");
});

test("sleep resolves promptly when the signal aborts mid-wait (not after the full ms)", async () => {
  const controller = new AbortController();
  const start = Date.now();
  const p = sleep(10_000, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await p;
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1_000, `abort should short-circuit the wait, elapsed=${elapsed}ms`);
});

test("sleep resolves immediately when the signal is already aborted before the call", async () => {
  const controller = new AbortController();
  controller.abort();
  const start = Date.now();
  await sleep(10_000, { signal: controller.signal });
  assert.ok(Date.now() - start < 100, "an already-aborted signal must never start the timer");
});
