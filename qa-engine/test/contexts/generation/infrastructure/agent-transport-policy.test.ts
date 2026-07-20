// qa-engine/test/contexts/generation/infrastructure/agent-transport-policy.test.ts
// Moved from src/integrations/{stall-watchdog-wrapper,session-registration-wrapper,opencode-client}
// .test.ts (migration-tier-4c Slice 2, D-4c-1) — these characterization tests exercise the transport
// POLICY (circuit-breaker gating, fallback retry, stall-watchdog decoration, session registration,
// turn/usage telemetry) that now lives in agent-transport-policy.ts, decoupled from the SDK.
import { test } from "node:test";
import assert from "node:assert/strict";
import { StalledAgentError, isInfraError } from "@kernel/domain-error.ts";
import {
  withStallWatchdog,
  withSessionRegistration,
  notifySessionActivity,
  parseModelRef,
  withTimeout,
  agentErrorToInfra,
  type AgentDeps,
} from "@contexts/generation/infrastructure/agent-transport-policy.ts";
import { createStallWatchdog } from "@contexts/generation/infrastructure/resilience/stall-watchdog.ts";

// ─── withStallWatchdog ───────────────────────────────────────────────────────────────────────────

// Build a minimal fake AgentDeps whose prompt() resolves after a delay we control.
function makeDelayDeps(opts: {
  rejectWith?: unknown;
  sessionId?: string;
}): { deps: AgentDeps } {
  const deps: AgentDeps = {
    open: async (_agent, _cwd, _openOpts) => {
      return {
        id: opts.sessionId ?? "test-session",
        prompt: async (_text) => {
          if (opts.rejectWith !== undefined) throw opts.rejectWith;
          return '{"approved":true,"specs":[]}';
        },
        dispose: async () => {},
      };
    },
  };
  return { deps };
}

test("withStallWatchdog wraps AgentDeps and returns a valid AgentDeps", async () => {
  const { deps: base } = makeDelayDeps({});
  const wrapped = withStallWatchdog(base, { stallMs: 5000 });

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
  let stallCb: (() => void) | undefined;

  const fakeWatchdogFactory = (onStall: () => void) => {
    stallCb = onStall;
    return createStallWatchdog({
      stallMs: 99999, // won't fire naturally
      onStall,
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
  void resolvePrompt;
});

test("withStallWatchdog: stall path unregisters the session notifier (no registry leak)", async () => {
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

test("withStallWatchdog: a self-timed session (Codex exec) skips the watchdog entirely (CP-01)", async () => {
  let watchdogCreated = false;
  const base: AgentDeps = {
    open: async () => ({
      id: "codex-session",
      prompt: async () => "codex result",
      dispose: async () => {},
      selfTimed: true,
    }),
  };
  const wrapped = withStallWatchdog(base, {
    stallMs: 99999,
    watchdogFactory: () => { watchdogCreated = true; return { notify: () => {}, stop: () => {} }; },
  });

  const session = await wrapped.open("qa-generator", "/tmp");
  assert.equal(watchdogCreated, false, "the watchdog must NOT be created for a self-timed session");
  assert.equal(session.selfTimed, true, "the self-timed marker is preserved on the returned session");
  assert.equal(await session.prompt("hello"), "codex result");
  await session.dispose();
});

test("withStallWatchdog: a normal (non-self-timed) session IS still wrapped (CP-01 complement)", async () => {
  let watchdogCreated = false;
  const base: AgentDeps = {
    open: async () => ({ id: "opencode-session", prompt: async () => "ok", dispose: async () => {} }),
  };
  const wrapped = withStallWatchdog(base, {
    stallMs: 99999,
    watchdogFactory: () => { watchdogCreated = true; return { notify: () => {}, stop: () => {} }; },
  });
  await wrapped.open("qa-generator", "/tmp");
  assert.equal(watchdogCreated, true, "a normal session must still be wrapped by the watchdog");
});

// ─── withSessionRegistration ─────────────────────────────────────────────────────────────────────
// `collaborators` is REQUIRED (unlike the legacy shell version, which defaulted to the real
// registerRunSession/unregisterRunSession): qa-engine cannot reach those shell functions on its own,
// so the composition root (src/server/rewritten-engine-factory.ts) must inject them explicitly.

function fakeBaseDeps(sessionId = "sess-1"): { deps: AgentDeps; disposed: boolean[] } {
  const disposed: boolean[] = [];
  const deps: AgentDeps = {
    open: async (_agent, _cwd, _opts) => ({
      id: sessionId,
      prompt: async (_text: string) => "output",
      dispose: async () => {
        disposed.push(true);
      },
    }),
  };
  return { deps, disposed };
}

test("withSessionRegistration returns a valid AgentDeps (structural)", async () => {
  const { deps: base } = fakeBaseDeps();
  const wrapped = withSessionRegistration(base, { register: () => {}, unregister: () => {} });
  assert.equal(typeof wrapped.open, "function");
  const session = await wrapped.open("qa-reviewer", "/mirrors/org/app", {
    descriptor: { runId: "run-42", role: "qa-reviewer" },
  });
  assert.equal(typeof session.prompt, "function");
  assert.equal(typeof session.dispose, "function");
  await session.dispose();
});

test("withSessionRegistration calls register with the session id, descriptor.runId, and cwd when a runId is present", async () => {
  const { deps: base } = fakeBaseDeps("sess-99");
  const calls: Array<{ sessionId: string; runId: string; directory: string }> = [];
  const wrapped = withSessionRegistration(base, {
    register: (sessionId, runId, directory) => calls.push({ sessionId, runId, directory }),
    unregister: () => {},
  });

  await wrapped.open("qa-reviewer", "/mirrors/org/app", {
    descriptor: { runId: "run-42", role: "qa-reviewer" },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { sessionId: "sess-99", runId: "run-42", directory: "/mirrors/org/app" });
});

test("withSessionRegistration does NOT register when descriptor.runId is absent (no fabricated run identity)", async () => {
  const { deps: base } = fakeBaseDeps();
  let registerCalls = 0;
  const wrapped = withSessionRegistration(base, {
    register: () => { registerCalls++; },
    unregister: () => {},
  });

  await wrapped.open("qa-generator", "/mirrors/org/app");
  await wrapped.open("qa-generator", "/mirrors/org/app", { descriptor: { role: "qa-generator" } });

  assert.equal(registerCalls, 0, "no descriptor.runId means no run context — must not register a session under a fabricated identity");
});

test("withSessionRegistration unregisters the session on dispose", async () => {
  const { deps: base } = fakeBaseDeps("sess-77");
  const unregistered: string[] = [];
  const wrapped = withSessionRegistration(base, {
    register: () => {},
    unregister: (sessionId) => unregistered.push(sessionId),
  });

  const session = await wrapped.open("qa-reviewer", "/mirrors/org/app", {
    descriptor: { runId: "run-1", role: "qa-reviewer" },
  });
  assert.equal(unregistered.length, 0, "must not unregister before dispose");
  await session.dispose();
  assert.deepEqual(unregistered, ["sess-77"]);
});

test("withSessionRegistration does NOT unregister on dispose when the session was never registered (no runId)", async () => {
  const { deps: base } = fakeBaseDeps("sess-55");
  let unregisterCalls = 0;
  const wrapped = withSessionRegistration(base, {
    register: () => {},
    unregister: () => { unregisterCalls++; },
  });

  const session = await wrapped.open("qa-generator", "/mirrors/org/app");
  await session.dispose();

  assert.equal(unregisterCalls, 0);
});

test("withSessionRegistration forwards prompt()/session identity unchanged (thin wrapper — no behavior mutation)", async () => {
  const { deps: base } = fakeBaseDeps("sess-passthrough");
  const wrapped = withSessionRegistration(base, { register: () => {}, unregister: () => {} });

  const session = await wrapped.open("qa-generator", "/mirrors/org/app");
  assert.equal(session.id, "sess-passthrough");
  const out = await session.prompt("hello");
  assert.equal(out, "output");
});

// ─── parseModelRef / withTimeout / agentErrorToInfra ────────────────────────────────────────────

test("parseModelRef splits provider/model and rejects malformed refs", () => {
  // The fallback model override must reach the SDK as {providerID, modelID}, not a raw string. A
  // model id can itself contain slashes — only the FIRST splits.
  assert.deepEqual(parseModelRef("opencode-go/deepseek-v4-pro"), { providerID: "opencode-go", modelID: "deepseek-v4-pro" });
  assert.deepEqual(parseModelRef("a/b/c"), { providerID: "a", modelID: "b/c" });
  // Unparseable → undefined so the override is skipped, never sent malformed.
  assert.equal(parseModelRef("noslash"), undefined);
  assert.equal(parseModelRef("/leading"), undefined);
  assert.equal(parseModelRef("trailing/"), undefined);
});

test("withTimeout resolves if the promise arrives in time", async () => {
  const v = await withTimeout(Promise.resolve("ok"), 1000, "x");
  assert.equal(v, "ok");
});

test("withTimeout rejects when the deadline elapses", async () => {
  const slow = new Promise((r) => setTimeout(() => r("late"), 50));
  await assert.rejects(() => withTimeout(slow, 5, "agent"), /timed out after 5ms/);
});

test("agentErrorToInfra classifies an embedded provider fault as infrastructure with an actionable message", () => {
  // ROOT-CAUSE: a provider fault is embedded in res.data.info.error (NOT res.error). It must throw a
  // typed InfraError so the run is `infra-error`, never a code verdict that blames the tests.
  const auth = agentErrorToInfra({ name: "ProviderAuthError", data: { providerID: "opencode-go", message: "insufficient credits" } });
  assert.equal(isInfraError(auth), true);
  assert.match(auth.message, /out of credits|OPENCODE_API_KEY/i);
  assert.match(auth.message, /insufficient credits/);
  assert.match(auth.message, /not a test failure/i);

  const rate = agentErrorToInfra({ name: "APIError", data: { message: "Too Many Requests", statusCode: 429 } });
  assert.equal(isInfraError(rate), true);
  assert.match(rate.message, /429|rate-limited/i);

  // An unknown/future variant still classifies as infra, never a code verdict.
  const unknown = agentErrorToInfra({ name: "UnknownError", data: { message: "boom" } });
  assert.equal(isInfraError(unknown), true);
  assert.match(unknown.message, /not a test failure/i);
});
