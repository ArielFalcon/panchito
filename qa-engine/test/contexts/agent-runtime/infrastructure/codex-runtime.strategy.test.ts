// test/contexts/agent-runtime/infrastructure/codex-runtime.strategy.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CodexRuntimeStrategyAdapter } from "@contexts/agent-runtime/infrastructure/codex-runtime.strategy.ts";

test("provider is codex", () => {
  const adapter = new CodexRuntimeStrategyAdapter(
    { provider: "codex", open: async () => ({ id: "s", prompt: async () => "", dispose: async () => {} }) as never,
      health: async () => ({ provider: "codex", status: "ok", configured: true }), listModels: async () => [] } as never,
    { resolve: () => ({ provider: "codex", model: "m1" }) } as never,
    (role) => role,
  );
  assert.equal(adapter.provider, "codex");
});

test("openSession delegates to the injected strategy.open with the mapped agent+cwd+descriptor", async () => {
  let seen: { agent: string; cwd: string; descriptor?: unknown } | null = null;
  const fakeSession = { id: "s1", prompt: async () => "out", dispose: async () => {} };
  const adapter = new CodexRuntimeStrategyAdapter({
    provider: "codex",
    open: async (agent: string, cwd: string, opts?: { descriptor?: unknown }) => { seen = { agent, cwd, descriptor: opts?.descriptor }; return fakeSession as never; },
    health: async () => ({ provider: "codex", status: "ok", configured: true }),
    listModels: async () => [{ id: "m1" }],
  } as never,
    { resolve: () => ({ provider: "codex", model: "m1" }) } as never,
    (role) => ({ primary: "qa-generator", reviewer: "qa-reviewer", explorer: "qa-explorer" } as Record<string, string>)[role] ?? role,
  );
  const session = await adapter.openSession("reviewer", "/m", { descriptor: { runId: "r2", role: "qa-reviewer" } });
  assert.equal(seen!.cwd, "/m");
  assert.deepEqual(seen!.descriptor, { runId: "r2", role: "qa-reviewer" });
  assert.equal(seen!.agent, "qa-reviewer");
  const out = await session.prompt("hi", { round: 0, isRepair: false });
  assert.equal(out.output, "out");
});

test("openSession forwards the resolved assignment model when the caller omits opts.model", async () => {
  let seenModel: string | undefined;
  const adapter = new CodexRuntimeStrategyAdapter({
    provider: "codex",
    open: async (_agent: string, _cwd: string, opts?: { model?: string }) => { seenModel = opts?.model; return { id: "s", prompt: async () => "", dispose: async () => {} } as never; },
    health: async () => ({ provider: "codex", status: "ok", configured: true }),
    listModels: async () => [],
  } as never,
    { resolve: () => ({ provider: "codex", model: "resolved-codex-model" }) } as never,
    (role) => role,
  );
  await adapter.openSession("primary", "/m");
  // DELEGATION: a gutted impl that ignored the injected resolver would NOT forward this model.
  assert.equal(seenModel, "resolved-codex-model");
});

test("openSession prefers explicit opts.model over the resolved assignment", async () => {
  let seenModel: string | undefined;
  const adapter = new CodexRuntimeStrategyAdapter({
    provider: "codex",
    open: async (_agent: string, _cwd: string, opts?: { model?: string }) => { seenModel = opts?.model; return { id: "s", prompt: async () => "", dispose: async () => {} } as never; },
    health: async () => ({ provider: "codex", status: "ok", configured: true }),
    listModels: async () => [],
  } as never,
    { resolve: () => ({ provider: "codex", model: "resolved-codex-model" }) } as never,
    (role) => role,
  );
  await adapter.openSession("primary", "/m", { model: "explicit-codex-model" });
  // DELEGATION: an explicit model must win over the resolver's model; a gutted impl would forward "resolved-codex-model".
  assert.equal(seenModel, "explicit-codex-model");
});

test("session.prompt forwards the per-call telemetry opts verbatim to the wrapped session", async () => {
  let seenText = "";
  let seenOpts: unknown = undefined;
  const adapter = new CodexRuntimeStrategyAdapter({
    provider: "codex",
    open: async () => ({
      id: "s",
      prompt: async (text: string, o: unknown) => { seenText = text; seenOpts = o; return "wrapped-out"; },
      dispose: async () => {},
    }) as never,
    health: async () => ({ provider: "codex", status: "ok", configured: true }),
    listModels: async () => [],
  } as never,
    { resolve: () => ({ provider: "codex", model: "m1" }) } as never,
    (role) => role,
  );
  const session = await adapter.openSession("primary", "/m");
  const res = await session.prompt("hello", { round: 2, isRepair: true, sectionSizes: { task: 100 } });
  assert.equal(seenText, "hello");
  assert.deepEqual(seenOpts, { round: 2, isRepair: true, sectionSizes: { task: 100 } });
  // The legacy session's string return is adapted to the port's { output } shape.
  assert.equal(res.output, "wrapped-out");
});

test("health/listModels/restart delegate to the wrapped strategy", async () => {
  const calls: string[] = [];
  const adapter = new CodexRuntimeStrategyAdapter({
    provider: "codex",
    open: async () => ({ id: "s", prompt: async () => "", dispose: async () => {} }) as never,
    health: async () => { calls.push("health"); return { provider: "codex", status: "ok", configured: true }; },
    listModels: async () => { calls.push("models"); return []; },
    restart: async () => { calls.push("restart"); return { provider: "codex", status: "ok", configured: true }; },
  } as never,
    { resolve: () => ({ provider: "codex", model: "m1" }) } as never,
    (role) => role,
  );
  await adapter.health(); await adapter.listModels(); await adapter.restart?.();
  assert.deepEqual(calls, ["health", "models", "restart"]);
});

test("restart falls back to health when the wrapped strategy exposes no restart", async () => {
  const calls: string[] = [];
  const adapter = new CodexRuntimeStrategyAdapter({
    provider: "codex",
    open: async () => ({ id: "s", prompt: async () => "", dispose: async () => {} }) as never,
    health: async () => { calls.push("health"); return { provider: "codex", status: "ok", configured: true }; },
    listModels: async () => [],
    // no restart on the wrapped strategy
  } as never,
    { resolve: () => ({ provider: "codex", model: "m1" }) } as never,
    (role) => role,
  );
  const h = await adapter.restart?.({ reason: "rotate" });
  // DELEGATION: with no wrapped restart, the adapter delegates to the wrapped health — not a fabricated value.
  assert.deepEqual(calls, ["health"]);
  assert.equal(h?.status, "ok");
});
