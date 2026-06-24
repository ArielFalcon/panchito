// TDD tests for:
//   1. StalledAgentError classification (errors.ts)
//   2. withStallWatchdog wrapper (opencode-client.ts)
// Written FIRST (RED) before implementation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { StalledAgentError, AgentUnavailableError, isInfraError } from "../errors";
import { withStallWatchdog, notifySessionActivity } from "./opencode-client";
import type { AgentDeps } from "./opencode-client";
import { createStallWatchdog } from "./stall-watchdog";

// ─── StalledAgentError classification tests ───────────────────────────────────

test("StalledAgentError is an InfraError subtype (stall is an engine-resilience event, not a code fault)", () => {
  const e = new StalledAgentError("agent stalled after 120000ms");
  assert.equal(isInfraError(e), true, "StalledAgentError must be classified as infra-error");
  assert.equal(e.name, "StalledAgentError");
  assert.match(e.message, /stalled/);
});

test("StalledAgentError name-fallback path (cross-realm instanceof miss) is recognized by isInfraError", () => {
  const shaped = new Error("stall event");
  shaped.name = "StalledAgentError";
  assert.equal(isInfraError(shaped), true, "name-based fallback must classify StalledAgentError as infra");
});

test("StalledAgentError is distinct from AgentUnavailableError (different operator action required)", () => {
  const stall = new StalledAgentError("stall");
  assert.notEqual(stall.name, "AgentUnavailableError");
  assert.notEqual(stall.name, "InfraError");
  assert.equal(stall.name, "StalledAgentError");
  // But it still satisfies the InfraError base through the inheritance chain
  assert.equal(isInfraError(stall), true);
});

// ─── withStallWatchdog wrapper tests ─────────────────────────────────────────

// Build a minimal fake AgentDeps whose prompt() resolves after a delay we control.
function makeDelayDeps(opts: {
  resolveAfterNotifies?: number; // how many times the caller must call notify before resolve
  rejectWith?: unknown;
  sessionId?: string;
}): { deps: AgentDeps; notifyCount: () => number } {
  let _notifyCount = 0;

  const deps: AgentDeps = {
    open: async (_agent, _cwd, _openOpts) => {
      return {
        id: opts.sessionId ?? "test-session",
        prompt: async (_text) => {
          // Simulate: return after `resolveAfterNotifies` count-ups. In real tests
          // this is called synchronously; we return immediately for simplicity.
          if (opts.rejectWith !== undefined) throw opts.rejectWith;
          return '{"approved":true,"specs":[]}';
        },
        dispose: async () => {},
      };
    },
  };

  return { deps, notifyCount: () => _notifyCount };
}

test("withStallWatchdog wraps AgentDeps and returns a valid AgentDeps", async () => {
  const { deps: base } = makeDelayDeps({});
  const wrapped = withStallWatchdog(base, {
    stallMs: 5000,
    // Use a no-op onStall for this structural test
  });

  // Should be a valid AgentDeps
  assert.equal(typeof wrapped.open, "function");

  const session = await wrapped.open("qa-generator", "/tmp");
  assert.equal(typeof session.prompt, "function");
  assert.equal(typeof session.dispose, "function");
  await session.dispose();
});

test("withStallWatchdog: prompt() succeeds normally when no stall occurs", async () => {
  const { deps: base } = makeDelayDeps({});
  const wrapped = withStallWatchdog(base, { stallMs: 5000 });

  const session = await wrapped.open("qa-generator", "/tmp");
  const result = await session.prompt("hello");
  assert.equal(result, '{"approved":true,"specs":[]}');
  await session.dispose();
});

test("withStallWatchdog: stall triggers StalledAgentError rejection via injected watchdog", async () => {
  // Build a fake watchdog that we can trigger manually
  let stallCb: (() => void) | undefined;

  const fakeWatchdogFactory = (onStall: () => void) => {
    stallCb = onStall;
    return createStallWatchdog({
      stallMs: 99999, // won't fire naturally
      onStall,
      // Use the real timer but we won't wait — we'll trigger manually
    });
  };

  // A base deps whose prompt() never resolves (simulates a hung agent)
  let resolvePrompt!: (v: string) => void;
  const base: AgentDeps = {
    open: async () => ({
      id: "hung-session",
      prompt: (_text) => new Promise<string>((res) => { resolvePrompt = res; }),
      dispose: async () => {},
    }),
  };

  const wrapped = withStallWatchdog(base, {
    stallMs: 99999,
    watchdogFactory: fakeWatchdogFactory,
  });

  const session = await wrapped.open("qa-generator", "/tmp");
  const promptPromise = session.prompt("hello");

  // Manually trigger the stall callback (simulates stallMs elapsed without notify)
  assert.ok(stallCb !== undefined, "stall callback must be registered during open()");
  (stallCb as () => void)();

  await assert.rejects(
    () => promptPromise,
    (err: unknown) => {
      assert.ok(err instanceof StalledAgentError, `expected StalledAgentError, got ${(err as Error)?.name}`);
      return true;
    },
    "prompt() must reject with StalledAgentError when the watchdog fires",
  );

  await session.dispose();
});

test("withStallWatchdog: stall path unregisters the session notifier (no registry leak)", async () => {
  // A stall must clean up the session→notify registry itself, not rely on the caller's
  // finally reaching wrapped.dispose() (a caller that swallows the rejection would leak it).
  let notifyCount = 0;
  let stallCb: (() => void) | undefined;
  const fakeWatchdog = { notify: () => { notifyCount++; }, stop: () => {} };

  const base: AgentDeps = {
    open: async () => ({
      id: "leak-test-session",
      prompt: () => new Promise<string>(() => {}), // never resolves (hung agent)
      dispose: async () => {},
    }),
  };

  const wrapped = withStallWatchdog(base, {
    stallMs: 99999,
    watchdogFactory: (onStall) => { stallCb = onStall; return fakeWatchdog; },
  });

  const session = await wrapped.open("qa-generator", "/tmp");
  const promptPromise = session.prompt("hello").catch(() => {}); // swallow the stall rejection

  // An SSE event for this session reaches the registered notifier.
  notifySessionActivity("leak-test-session");
  const beforeStall = notifyCount;
  assert.ok(beforeStall >= 1, "the session notifier must be registered and invoked on activity");

  // Stall fires → the stall path must unregister the notifier.
  assert.ok(stallCb !== undefined, "stall callback must be registered during open()");
  (stallCb as () => void)();
  await promptPromise;

  // A further event must NOT reach the now-removed notifier.
  notifySessionActivity("leak-test-session");
  assert.equal(notifyCount, beforeStall, "after a stall the session notifier must be unregistered (no registry leak)");

  await session.dispose();
});

test("withStallWatchdog: dispose() stops the watchdog (no leak after session ends)", async () => {
  let stopCalled = false;
  const fakeWatchdog = {
    notify: () => {},
    stop: () => { stopCalled = true; },
  };

  const base: AgentDeps = {
    open: async () => ({
      id: "dispose-test",
      prompt: async () => '{"approved":true,"specs":[]}',
      dispose: async () => {},
    }),
  };

  const wrapped = withStallWatchdog(base, {
    stallMs: 5000,
    watchdogFactory: (_onStall) => fakeWatchdog,
  });

  const session = await wrapped.open("qa-generator", "/tmp");
  await session.dispose();

  assert.equal(stopCalled, true, "dispose() must stop the watchdog to prevent leaks");
});
