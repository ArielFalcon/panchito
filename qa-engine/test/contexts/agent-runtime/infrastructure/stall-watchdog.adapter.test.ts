// test/contexts/agent-runtime/infrastructure/stall-watchdog.adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { StallWatchdogAdapter } from "@contexts/agent-runtime/infrastructure/stall-watchdog.adapter.ts";
import type { AgentSession } from "@contexts/agent-runtime/application/ports/index.ts";

/**
 * Build a fake AgentSession to pass to attach().
 */
function fakeSession(): AgentSession {
  return { prompt: async () => ({ output: "" }), dispose: () => {} };
}

test("attach delegates to the injected watchdog factory and returns a detach fn", () => {
  let factoryCalled = false;
  let watchdogStopped = false;

  const adapter = new StallWatchdogAdapter((_onStall) => {
    factoryCalled = true;
    return { notify: () => {}, stop: () => { watchdogStopped = true; } };
  });

  const detach = adapter.attach(fakeSession(), () => {});

  // DELEGATION: the factory was called — a gutted impl that never invokes it FAILS this.
  assert.equal(factoryCalled, true, "watchdog factory must be called by attach");

  // The returned detach fn must be callable and must stop the watchdog.
  assert.equal(typeof detach, "function", "attach must return a detach fn");
  detach();
  assert.equal(watchdogStopped, true, "detach must stop the watchdog (stop() called)");
});

test("attach calls the injected onStall when the watchdog fires", () => {
  const ref: { onStall: (() => void) | null } = { onStall: null };
  let stallFired = false;

  const adapter = new StallWatchdogAdapter((onStall) => {
    ref.onStall = onStall;
    return { notify: () => {}, stop: () => {} };
  });

  adapter.attach(fakeSession(), () => { stallFired = true; });

  assert.ok(ref.onStall, "factory must receive the onStall callback");
  // Simulate the watchdog firing — ref.onStall is narrowed to non-null by assert.ok above.
  ref.onStall();
  assert.equal(stallFired, true, "onStall must be forwarded to the caller");
});

test("two adapter instances share no watchdog state (per-session isolation)", () => {
  const stops: number[] = [];

  const factory = (_onStall: () => void) => ({
    notify: () => {},
    stop: () => { stops.push(stops.length); },
  });

  const a1 = new StallWatchdogAdapter(factory);
  const a2 = new StallWatchdogAdapter(factory);

  const detach1 = a1.attach(fakeSession(), () => {});
  const detach2 = a2.attach(fakeSession(), () => {});

  detach1();
  // Only the first watchdog should have been stopped; the second is still running.
  assert.equal(stops.length, 1);
  detach2();
  assert.equal(stops.length, 2);
});
