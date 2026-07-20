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
  createAgentDeps,
  type AgentDeps,
  type RawAgentTransport,
  type AgentTurnEvent,
} from "@contexts/generation/infrastructure/agent-transport-policy.ts";
import { createStallWatchdog } from "@contexts/generation/infrastructure/resilience/stall-watchdog.ts";
import { recordCircuitFailure, resetCircuit } from "@contexts/generation/infrastructure/resilience/circuit-breaker.ts";

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

// ─── createAgentDeps (migration-tier-4d Slice 4, residual ii) ───────────────────────────────────
// Approval/characterization tests: createAgentDeps was already the production transport POLICY
// (the agent's critical path — every generate/review/repair round funnels through it) but had NO
// direct unit test of its own before this slice; every existing test above exercises the DECORATOR
// wrappers (withStallWatchdog/withSessionRegistration) against a hand-built fake AgentDeps, never
// createAgentDeps(raw, collab) itself against a fake RawAgentTransport. These tests characterize the
// 5 behaviors the design named: fallback-model retry on a transient fault, skip-on-abort/infra-error,
// circuit-breaker gating, telemetry assembly, and sanitize-before-emit.

function makeRawTransport(overrides: Partial<RawAgentTransport> = {}): RawAgentTransport {
  return {
    createSession: async (_cwd: string) => ({ id: "sess-default" }),
    promptSession: async () => ({ parts: [{ type: "text", text: "default output" }] }),
    abortSession: async () => {},
    deleteSession: async () => {},
    ...overrides,
  };
}

test("createAgentDeps: open()/prompt()/dispose() delegate to the raw transport and return its text", async () => {
  resetCircuit();
  const raw = makeRawTransport({
    createSession: async () => ({ id: "sess-1" }),
    promptSession: async (args) => {
      assert.equal(args.agent, "qa-generator");
      assert.equal(args.text, "do the thing");
      return { parts: [{ type: "text", text: "hello world" }] };
    },
  });
  const deps = createAgentDeps(raw, { defaultPromptTimeoutMs: 5000, getFallbackModel: () => undefined });
  const session = await deps.open("qa-generator", "/tmp");
  const out = await session.prompt("do the thing");
  assert.equal(out, "hello world");
  await session.dispose();
});

test("createAgentDeps: retries on the fallback model after a transient (non-infra) primary-model fault", async () => {
  resetCircuit();
  let attempt = 0;
  const raw = makeRawTransport({
    createSession: async () => ({ id: "sess-2" }),
    promptSession: async (args) => {
      attempt++;
      if (attempt === 1) {
        assert.equal(args.model, undefined, "the primary attempt must not send a model override");
        throw new Error("ECONNRESET transient network fault");
      }
      assert.deepEqual(args.model, { providerID: "opencode-go", modelID: "fallback-model" }, "the retry must target the resolved fallback model");
      return { parts: [{ type: "text", text: "fallback succeeded" }] };
    },
  });
  const deps = createAgentDeps(raw, {
    defaultPromptTimeoutMs: 5000,
    getFallbackModel: (agent) => (agent === "qa-generator" ? "opencode-go/fallback-model" : undefined),
  });
  const session = await deps.open("qa-generator", "/tmp");
  const out = await session.prompt("do the thing");
  assert.equal(out, "fallback succeeded");
  assert.equal(attempt, 2, "exactly one retry (primary + fallback) must have happened");
});

test("createAgentDeps: an aborted signal skips the fallback retry even when one is configured", async () => {
  resetCircuit();
  let attempts = 0;
  const controller = new AbortController();
  const raw = makeRawTransport({
    createSession: async () => ({ id: "sess-3" }),
    promptSession: async () => {
      attempts++;
      controller.abort(); // the operator cancels while the request is in flight
      throw new Error("operator cancel while in flight");
    },
  });
  const deps = createAgentDeps(raw, {
    defaultPromptTimeoutMs: 5000,
    getFallbackModel: () => "opencode-go/should-never-be-used",
  });
  const session = await deps.open("qa-generator", "/tmp", { signal: controller.signal });
  await assert.rejects(() => session.prompt("do the thing"));
  assert.equal(attempts, 1, "an aborted signal must skip the fallback retry — a cancel must not be defeated by a retry");
});

test("createAgentDeps: an infra-class provider fault skips the fallback retry (same key, pointless to re-spend)", async () => {
  resetCircuit();
  let attempts = 0;
  const raw = makeRawTransport({
    createSession: async () => ({ id: "sess-4" }),
    promptSession: async () => {
      attempts++;
      return {
        agentError: { name: "ProviderAuthError", data: { providerID: "opencode-go", message: "out of credits" } },
        parts: [],
      };
    },
  });
  const deps = createAgentDeps(raw, {
    defaultPromptTimeoutMs: 5000,
    getFallbackModel: () => "opencode-go/should-never-be-used",
  });
  const session = await deps.open("qa-generator", "/tmp");
  await assert.rejects(
    () => session.prompt("do the thing"),
    (err: unknown) => isInfraError(err),
    "an embedded provider fault must surface as a typed InfraError",
  );
  assert.equal(attempts, 1, "an infra-class fault (out-of-credits/auth) must skip the fallback retry entirely");
});

test("createAgentDeps: circuit-breaker gating — an OPEN circuit rejects prompt() before the raw transport is ever called, and resetCircuit() restores normal operation", async () => {
  resetCircuit();
  let promptCalls = 0;
  const raw = makeRawTransport({
    createSession: async () => ({ id: "sess-5" }),
    promptSession: async () => {
      promptCalls++;
      return { parts: [{ type: "text", text: "ok" }] };
    },
  });
  const deps = createAgentDeps(raw, { defaultPromptTimeoutMs: 5000, getFallbackModel: () => undefined });

  // Force the circuit OPEN via the module's own threshold (5 consecutive recorded failures).
  for (let i = 0; i < 5; i++) recordCircuitFailure();

  const openSession = await deps.open("qa-generator", "/tmp");
  // NOTE: checkCircuit() rejects SYNCHRONOUSLY (it throws before any Promise is constructed), unlike
  // every other failure path in createAgentDeps (which fails through an async raw.promptSession call
  // and so settles as a genuine Promise rejection). node:assert's assert.rejects does NOT convert a
  // synchronous throw from its callback into a caught rejection (verified: it re-throws uncaught) —
  // only `await`/try-catch handles both cases uniformly. Every real production caller already awaits
  // session.prompt() inside an async function or a `new Promise` executor, both of which DO normalize
  // a synchronous throw into a rejection, so this is a test-authoring gotcha, not a production bug.
  let openCircuitError: unknown;
  try {
    await openSession.prompt("do the thing");
  } catch (err) {
    openCircuitError = err;
  }
  assert.ok(openCircuitError instanceof Error, "the OPEN circuit must reject the prompt");
  assert.match((openCircuitError as Error).message, /circuit breaker is OPEN/);
  assert.equal(promptCalls, 0, "checkCircuit() must reject BEFORE the raw transport's promptSession is ever invoked");

  resetCircuit();
  const closedSession = await deps.open("qa-generator", "/tmp");
  const out = await closedSession.prompt("do the thing");
  assert.equal(out, "ok", "after resetCircuit() a normal prompt succeeds again");
  assert.equal(promptCalls, 1, "the raw transport is only reached once the circuit is closed");
});

test("createAgentDeps: telemetry assembly — onTurn receives a fully-populated AgentTurnEvent for a run with a runId", async () => {
  resetCircuit();
  const raw = makeRawTransport({
    createSession: async () => ({ id: "sess-6" }),
    promptSession: async () => ({
      parts: [{ type: "text", text: "assembled output" }],
      tokens: { input: 100, output: 50, reasoning: 10, cacheRead: 5, cacheWrite: 2 },
      cost: 0.0123,
    }),
  });
  const deps = createAgentDeps(raw, { defaultPromptTimeoutMs: 5000, getFallbackModel: () => undefined });
  const turns: AgentTurnEvent[] = [];
  const session = await deps.open("qa-generator", "/tmp", {
    descriptor: { runId: "run-77", role: "qa-generator", objective: "write specs" },
    onTurn: (t) => turns.push(t),
  });
  const out = await session.prompt("do the thing", { round: 3, isRepair: true, sectionSizes: { diff: 1200 } });
  assert.equal(out, "assembled output");
  assert.equal(turns.length, 1);
  const t = turns[0]!;
  assert.equal(t.runId, "run-77");
  assert.equal(t.role, "qa-generator");
  assert.equal(t.objective, "write specs");
  assert.equal(t.round, 3);
  assert.equal(t.isRepair, true);
  assert.deepEqual(t.sectionSizes, { diff: 1200 });
  assert.equal(t.tokensInput, 100);
  assert.equal(t.tokensOutput, 50);
  assert.equal(t.tokensReasoning, 10);
  assert.equal(t.tokensCacheRead, 5);
  assert.equal(t.tokensCacheWrite, 2);
  assert.equal(t.cost, 0.0123);
  assert.equal(t.outputText, "assembled output");
});

test("createAgentDeps: sanitize-before-emit — a leaked secret is redacted in the emitted turn event, but prompt() still resolves with the RAW text for the caller to parse", async () => {
  resetCircuit();
  const leaky = "here is the key sk-abcdefghijklmnopqrstuvwxyz1234 — do not print this";
  const raw = makeRawTransport({
    createSession: async () => ({ id: "sess-7" }),
    promptSession: async () => ({ parts: [{ type: "text", text: leaky }] }),
  });
  const deps = createAgentDeps(raw, { defaultPromptTimeoutMs: 5000, getFallbackModel: () => undefined });
  const turns: AgentTurnEvent[] = [];
  const session = await deps.open("qa-generator", "/tmp", {
    descriptor: { runId: "run-88" },
    onTurn: (t) => turns.push(t),
  });
  const out = await session.prompt("do the thing");
  assert.equal(out, leaky, "the caller-facing return value stays RAW so downstream JSON/verdict parsing is never corrupted by redaction");
  assert.equal(turns.length, 1);
  assert.doesNotMatch(turns[0]!.outputText, /sk-abcdefghijklmnopqrstuvwxyz1234/, "the emitted telemetry event must never carry the raw secret");
  assert.match(turns[0]!.outputText, /\[REDACTED\]/, "the secret must be replaced with the canonical redaction marker before it reaches storage/logging");
});

test("createAgentDeps: the default turn sink calls collab.persistTurn when a runId is present and the caller supplies no onTurn override", async () => {
  resetCircuit();
  const raw = makeRawTransport({
    createSession: async () => ({ id: "sess-8" }),
    promptSession: async () => ({ parts: [{ type: "text", text: "persisted output" }] }),
  });
  const persisted: AgentTurnEvent[] = [];
  const deps = createAgentDeps(raw, {
    defaultPromptTimeoutMs: 5000,
    getFallbackModel: () => undefined,
    persistTurn: (t) => persisted.push(t),
  });
  const session = await deps.open("qa-generator", "/tmp", { descriptor: { runId: "run-99" } });
  await session.prompt("do the thing");
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]!.runId, "run-99");
  assert.equal(persisted[0]!.outputText, "persisted output");
});

test("createAgentDeps: no turn sink fires when the caller supplies neither a runId nor an onTurn override (no fabricated telemetry)", async () => {
  resetCircuit();
  const raw = makeRawTransport({
    createSession: async () => ({ id: "sess-9" }),
    promptSession: async () => ({ parts: [{ type: "text", text: "no telemetry" }] }),
  });
  let persistCalls = 0;
  const deps = createAgentDeps(raw, {
    defaultPromptTimeoutMs: 5000,
    getFallbackModel: () => undefined,
    persistTurn: () => { persistCalls++; },
  });
  const session = await deps.open("qa-generator", "/tmp");
  const out = await session.prompt("do the thing");
  assert.equal(out, "no telemetry");
  assert.equal(persistCalls, 0, "no runId and no onTurn override means no telemetry sink fires at all");
});
