// qa-engine/test/contexts/generation/infrastructure/resilience/stall-watchdog.test.ts
// Moved from src/integrations/stall-watchdog.test.ts (migration-tier-4c Slice 2, D-4c-3). All timing
// is injected — no real clock delays.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createStallWatchdog } from "@contexts/generation/infrastructure/resilience/stall-watchdog.ts";

// ─── deterministic timer helpers ────────────────────────────────────────────

interface FakeTimer {
  /** Call all pending callbacks whose deadline is <= `now` and advance `now`. */
  tick(ms: number): void;
  /** Current virtual time. */
  now(): number;
  /** The injected setTimeout implementation. */
  setTimeout: (cb: () => void, ms: number) => ReturnType<typeof globalThis.setTimeout>;
  /** The injected clearTimeout implementation. */
  clearTimeout: (id: ReturnType<typeof globalThis.setTimeout> | undefined) => void;
}

function makeFakeTimer(): FakeTimer {
  let current = 0;
  const pending: { deadline: number; cb: () => void; id: number }[] = [];
  let nextId = 1;

  const fakeSetTimeout = (cb: () => void, ms: number): ReturnType<typeof globalThis.setTimeout> => {
    const id = nextId++;
    pending.push({ deadline: current + ms, cb, id });
    return id as unknown as ReturnType<typeof globalThis.setTimeout>;
  };

  const fakeClearTimeout = (id: ReturnType<typeof globalThis.setTimeout> | undefined): void => {
    if (id === undefined) return;
    const numId = id as unknown as number;
    const idx = pending.findIndex((p) => p.id === numId);
    if (idx !== -1) pending.splice(idx, 1);
  };

  return {
    now: () => current,
    tick(ms: number) {
      current += ms;
      // Fire all callbacks whose deadline is <= current (in insertion order).
      // Iterate a snapshot because callbacks may reschedule.
      const toFire = pending.filter((p) => p.deadline <= current);
      for (const p of toFire) {
        const idx = pending.indexOf(p);
        if (idx !== -1) pending.splice(idx, 1);
        p.cb();
      }
    },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
  };
}

// ─── tests ───────────────────────────────────────────────────────────────────

test("onStall fires after stallMs of silence", () => {
  const timer = makeFakeTimer();
  const fired: number[] = [];

  const w = createStallWatchdog({
    stallMs: 1000,
    onStall: () => fired.push(timer.now()),
    timers: { setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout },
  });

  w.notify(); // start the watchdog

  timer.tick(999);
  assert.equal(fired.length, 0, "onStall must NOT fire before stallMs elapses");

  timer.tick(1); // now at 1000ms
  assert.equal(fired.length, 1, "onStall must fire exactly once after stallMs");
  assert.equal(fired[0], 1000);

  w.stop();
});

test("notify() resets the stall timer, preventing onStall", () => {
  const timer = makeFakeTimer();
  const fired: number[] = [];

  const w = createStallWatchdog({
    stallMs: 1000,
    onStall: () => fired.push(timer.now()),
    timers: { setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout },
  });

  w.notify();      // arm at t=0
  timer.tick(800); // t=800 — not yet stalled
  w.notify();      // reset: new deadline is t=800+1000=1800
  timer.tick(500); // t=1300 — would have stalled at 1000, but was reset
  assert.equal(fired.length, 0, "onStall must NOT fire when notify() keeps resetting the timer");

  timer.tick(500); // t=1800 — stall deadline reached
  assert.equal(fired.length, 1, "onStall must fire after stallMs of silence following the last notify()");

  w.stop();
});

test("stop() prevents onStall from firing", () => {
  const timer = makeFakeTimer();
  const fired: number[] = [];

  const w = createStallWatchdog({
    stallMs: 1000,
    onStall: () => fired.push(timer.now()),
    timers: { setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout },
  });

  w.notify();
  timer.tick(500);
  w.stop(); // cancel before stall fires
  timer.tick(1000); // would have fired at t=1000
  assert.equal(fired.length, 0, "stop() must prevent onStall from firing");
});

test("onStall fires only once per stall event (not repeatedly)", () => {
  const timer = makeFakeTimer();
  let fireCount = 0;

  const w = createStallWatchdog({
    stallMs: 500,
    onStall: () => { fireCount++; },
    timers: { setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout },
  });

  w.notify();
  timer.tick(500); // stall fires
  timer.tick(500); // additional time — no reschedule after stall
  assert.equal(fireCount, 1, "onStall must fire exactly once and not repeat");

  w.stop();
});

test("notify() before any tick starts the watchdog (start-on-first-use semantics)", () => {
  const timer = makeFakeTimer();
  let fired = false;

  const w = createStallWatchdog({
    stallMs: 200,
    onStall: () => { fired = true; },
    timers: { setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout },
  });

  // Do NOT call notify before ticking — watchdog should NOT fire without being armed
  timer.tick(500);
  assert.equal(fired, false, "watchdog must not fire if notify() was never called");

  w.stop();
});

test("stop() is idempotent (safe to call multiple times)", () => {
  const timer = makeFakeTimer();
  const w = createStallWatchdog({
    stallMs: 500,
    onStall: () => {},
    timers: { setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout },
  });

  w.notify();
  w.stop();
  assert.doesNotThrow(() => w.stop(), "second stop() must not throw");
  assert.doesNotThrow(() => w.stop(), "third stop() must not throw");
});
