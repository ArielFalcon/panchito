import { test } from "node:test";
import assert from "node:assert/strict";
import { createFixedWindowLimiter } from "./rate-limit";

test("allows up to the limit within a window, then blocks", () => {
  const rl = createFixedWindowLimiter({ limit: 3, windowMs: 1000 });
  const now = 1_000_000;
  assert.equal(rl.allow("ip-a", now), true);
  assert.equal(rl.allow("ip-a", now + 10), true);
  assert.equal(rl.allow("ip-a", now + 20), true);
  assert.equal(rl.allow("ip-a", now + 30), false); // 4th in-window request blocked
});

test("the window resets after windowMs elapses", () => {
  const rl = createFixedWindowLimiter({ limit: 1, windowMs: 1000 });
  const now = 1_000_000;
  assert.equal(rl.allow("ip-a", now), true);
  assert.equal(rl.allow("ip-a", now + 500), false);
  assert.equal(rl.allow("ip-a", now + 1001), true); // fresh window
});

test("limits are tracked independently per key", () => {
  const rl = createFixedWindowLimiter({ limit: 1, windowMs: 1000 });
  const now = 1_000_000;
  assert.equal(rl.allow("ip-a", now), true);
  assert.equal(rl.allow("ip-b", now), true); // a different client is unaffected
  assert.equal(rl.allow("ip-a", now), false);
});

test("an empty key (unknown remote address) is still limited, not bypassed", () => {
  const rl = createFixedWindowLimiter({ limit: 1, windowMs: 1000 });
  const now = 1_000_000;
  assert.equal(rl.allow("", now), true);
  assert.equal(rl.allow("", now), false);
});
