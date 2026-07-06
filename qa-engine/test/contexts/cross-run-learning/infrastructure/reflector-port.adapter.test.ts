// qa-engine/test/contexts/cross-run-learning/infrastructure/reflector-port.adapter.test.ts
// RED-first (reflector-rewire, Phase 2, task 2.2): ReflectorPortAdapter opens a "reflector"
// session over AgentRuntimePort, prompts for a StructuredReflection, and on a valid parse calls
// LearningRepositoryPort.save (candidate/low, ADR-3) + the injected backfill (ADR-2). Every
// failure mode (runtime throw, timeout, malformed/incomplete JSON) is caught inline — never
// re-thrown — mirroring LearningPortAdapter.fold()'s own documented off-path contract on the
// SAME port family. The session is ALWAYS disposed, even when prompt() itself throws.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ReflectorPortAdapter, REFLECT_TIMEOUT_MS } from "@contexts/cross-run-learning/infrastructure/reflector-port.adapter.ts";
import type { LearningRepositoryPort, LearningRule, ReflectionInput, StructuredReflection } from "@contexts/cross-run-learning/application/ports/index.ts";
import type { AgentRuntimePort, AgentSession } from "@kernel/ports/agent-runtime.port.ts";

const baseInput: ReflectionInput = {
  runId: "run-1",
  app: "app",
  sha: "abc1234",
  mode: "diff",
  verdict: "fail",
  errorClass: "E-EXEC-FAIL",
  gateSignals: { static: true, coverageRatio: 0.4, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
};

const validReflectionJson = JSON.stringify({
  goal: "verify the login form",
  decision: "used a css selector",
  assumption: "the selector would stay stable",
  errorClass: "E-EXEC-FAIL",
  gateSignal: "static gate: FAIL",
  evidence: "locator('.btn-submit') not found",
  rootCause: "css class renamed by a refactor",
  preventiveRule: { trigger: "Applies when a form submit button lacks a stable selector", action: "use getByRole('button', { name: ... })" },
});

function fakeRuntime(opts: {
  prompt?: (text: string) => Promise<{ output: string }>;
  onOpen?: (role: string, cwd: string, sessOpts?: unknown) => void;
  onDispose?: () => void;
  openThrows?: Error;
}): AgentRuntimePort {
  return {
    async openSession(role, cwd, sessOpts) {
      opts.onOpen?.(role, cwd, sessOpts);
      if (opts.openThrows) throw opts.openThrows;
      const session: AgentSession = {
        prompt: opts.prompt ?? (async () => ({ output: validReflectionJson })),
        dispose: async () => { opts.onDispose?.(); },
      };
      return session;
    },
  };
}

function fakeRepo(onSave?: (rule: LearningRule) => void): LearningRepositoryPort {
  return {
    save: async (rule) => { onSave?.(rule); },
    topRules: async () => [],
    applyOutcome: async () => {},
  };
}

test("reflect() opens a 'reflector' session, saves a candidate/low rule, and backfills on valid JSON", async () => {
  let openedRole: string | undefined;
  let openedCwd: string | undefined;
  let savedRule: LearningRule | undefined;
  let backfilled: { runId: string; refl: StructuredReflection } | undefined;

  const runtime = fakeRuntime({ onOpen: (role, cwd) => { openedRole = role; openedCwd = cwd; } });
  const repo = fakeRepo((rule) => { savedRule = rule; });

  const adapter = new ReflectorPortAdapter({
    runtime,
    repo,
    backfill: (runId, refl) => { backfilled = { runId, refl: refl as StructuredReflection }; },
    cwd: "/mirror/app",
    app: "app",
  });

  await adapter.reflect(baseInput);

  assert.equal(openedRole, "reflector");
  assert.equal(openedCwd, "/mirror/app");
  assert.ok(savedRule, "expected LearningRepositoryPort.save to be called");
  assert.equal(savedRule?.status, "candidate");
  assert.equal(savedRule?.confidence, "low");
  assert.ok(backfilled, "expected backfill to be called");
  assert.equal(backfilled?.runId, "run-1");
  assert.equal(backfilled?.refl.rootCause, "css class renamed by a refactor");
});

test("reflect() never threads initialStatus — structural ADR-3 pin", async () => {
  let savedRule: LearningRule | undefined;
  const runtime = fakeRuntime({});
  const repo = fakeRepo((rule) => { savedRule = rule; });
  const adapter = new ReflectorPortAdapter({ runtime, repo, backfill: () => {}, cwd: "/mirror/app", app: "app" });

  await adapter.reflect(baseInput);

  assert.ok(savedRule);
  assert.equal(Object.prototype.hasOwnProperty.call(savedRule, "initialStatus"), false);
});

test("reflect() with invalid/incomplete JSON: no save, no backfill, does not throw", async () => {
  let saveCalled = false;
  let backfillCalled = false;
  const runtime = fakeRuntime({ prompt: async () => ({ output: "not json at all, sorry" }) });
  const repo = fakeRepo(() => { saveCalled = true; });
  const adapter = new ReflectorPortAdapter({
    runtime, repo, backfill: () => { backfillCalled = true; }, cwd: "/mirror/app", app: "app",
  });

  await assert.doesNotReject(() => adapter.reflect(baseInput));

  assert.equal(saveCalled, false);
  assert.equal(backfillCalled, false);
});

test("reflect() with incomplete JSON (missing preventiveRule fields): no save, no backfill", async () => {
  let saveCalled = false;
  const incomplete = JSON.stringify({ goal: "g", decision: "d", assumption: "a", errorClass: "E-X", gateSignal: "s", evidence: "e", rootCause: "r" });
  const runtime = fakeRuntime({ prompt: async () => ({ output: incomplete }) });
  const repo = fakeRepo(() => { saveCalled = true; });
  const adapter = new ReflectorPortAdapter({ runtime, repo, backfill: () => {}, cwd: "/mirror/app", app: "app" });

  await assert.doesNotReject(() => adapter.reflect(baseInput));

  assert.equal(saveCalled, false);
});

test("reflect() swallows a runtime openSession() throw — no save, no throw escapes, onReflectError called", async () => {
  let caught: unknown;
  let saveCalled = false;
  const boom = new Error("agent runtime unreachable");
  const runtime = fakeRuntime({ openThrows: boom });
  const repo = fakeRepo(() => { saveCalled = true; });
  const adapter = new ReflectorPortAdapter({
    runtime, repo, backfill: () => {}, cwd: "/mirror/app", app: "app",
    onReflectError: (e) => { caught = e; },
  });

  await assert.doesNotReject(() => adapter.reflect(baseInput));

  assert.equal(saveCalled, false);
  assert.equal(caught, boom);
});

test("reflect() swallows a session.prompt() rejection — no save, session still disposed (finally)", async () => {
  let disposed = false;
  let caught: unknown;
  const boom = new Error("prompt timed out mid-stream");
  const runtime = fakeRuntime({
    prompt: async () => { throw boom; },
    onDispose: () => { disposed = true; },
  });
  const repo = fakeRepo();
  const adapter = new ReflectorPortAdapter({
    runtime, repo, backfill: () => {}, cwd: "/mirror/app", app: "app",
    onReflectError: (e) => { caught = e; },
  });

  await assert.doesNotReject(() => adapter.reflect(baseInput));

  assert.equal(disposed, true, "dispose() must run in finally even when prompt() throws");
  assert.equal(caught, boom);
});

test("reflect() disposes the session on the success path too", async () => {
  let disposed = false;
  const runtime = fakeRuntime({ onDispose: () => { disposed = true; } });
  const repo = fakeRepo();
  const adapter = new ReflectorPortAdapter({ runtime, repo, backfill: () => {}, cwd: "/mirror/app", app: "app" });

  await adapter.reflect(baseInput);

  assert.equal(disposed, true);
});

test("reflect() treats a timeout (openSession opts.timeoutMs) as caught — no save, no throw", async () => {
  // The adapter must pass a bounded timeoutMs to openSession; simulate the runtime enforcing it
  // by having the session's prompt() never resolve within a fake caller-side wait, then reject
  // with a timeout-shaped error the same way a real timeout-enforcing runtime would.
  let observedTimeoutMs: number | undefined;
  const runtime: AgentRuntimePort = {
    async openSession(_role, _cwd, opts) {
      observedTimeoutMs = opts?.timeoutMs;
      return {
        prompt: async () => { throw new Error("timed out after " + opts?.timeoutMs + "ms"); },
        dispose: async () => {},
      };
    },
  };
  let saveCalled = false;
  const repo = fakeRepo(() => { saveCalled = true; });
  const adapter = new ReflectorPortAdapter({ runtime, repo, backfill: () => {}, cwd: "/mirror/app", app: "app" });

  await assert.doesNotReject(() => adapter.reflect(baseInput));

  assert.equal(observedTimeoutMs, REFLECT_TIMEOUT_MS);
  assert.equal(saveCalled, false);
});

test("reflect() forwards a custom timeoutMs override to openSession", async () => {
  let observedTimeoutMs: number | undefined;
  const runtime: AgentRuntimePort = {
    async openSession(_role, _cwd, opts) {
      observedTimeoutMs = opts?.timeoutMs;
      return { prompt: async () => ({ output: validReflectionJson }), dispose: async () => {} };
    },
  };
  const repo = fakeRepo();
  const adapter = new ReflectorPortAdapter({
    runtime, repo, backfill: () => {}, cwd: "/mirror/app", app: "app", timeoutMs: 15_000,
  });

  await adapter.reflect(baseInput);

  assert.equal(observedTimeoutMs, 15_000);
});

test("REFLECT_TIMEOUT_MS defaults to 60000", () => {
  assert.equal(REFLECT_TIMEOUT_MS, 60_000);
});
