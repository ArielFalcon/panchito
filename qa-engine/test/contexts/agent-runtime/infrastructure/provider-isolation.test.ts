// test/contexts/agent-runtime/infrastructure/provider-isolation.test.ts
// Per-provider isolation invariant: restarting the Codex adapter must not perturb the OpenCode adapter
// (no shared breaker/global). Each adapter wraps an INDEPENDENT legacy strategy — verify they don't alias.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenCodeRuntimeStrategyAdapter } from "@contexts/agent-runtime/infrastructure/opencode-runtime.strategy.ts";
import { CodexRuntimeStrategyAdapter } from "@contexts/agent-runtime/infrastructure/codex-runtime.strategy.ts";

test("restarting the codex adapter does not touch the opencode adapter's wrapped strategy", async () => {
  const opencodeCalls: string[] = [];
  const codexCalls: string[] = [];

  // Two INDEPENDENT legacy strategies — separate fakes, no shared mutable state between them.
  const opencodeLegacy = {
    provider: "opencode" as const,
    open: async () => ({ id: "oc", prompt: async () => "", dispose: async () => {} }) as never,
    health: async () => { opencodeCalls.push("health"); return { provider: "opencode", status: "ok", configured: true }; },
    listModels: async () => [],
    restart: async () => { opencodeCalls.push("restart"); return { provider: "opencode", status: "ok", configured: true }; },
  } as never;
  const codexLegacy = {
    provider: "codex" as const,
    open: async () => ({ id: "cx", prompt: async () => "", dispose: async () => {} }) as never,
    health: async () => { codexCalls.push("health"); return { provider: "codex", status: "ok", configured: true }; },
    listModels: async () => [],
    restart: async () => { codexCalls.push("restart"); return { provider: "codex", status: "ok", configured: true }; },
  } as never;

  const opencode = new OpenCodeRuntimeStrategyAdapter(opencodeLegacy, { resolve: () => ({ provider: "opencode", model: "m1" }) } as never, (r) => r);
  const codex = new CodexRuntimeStrategyAdapter(codexLegacy, { resolve: () => ({ provider: "codex", model: "m1" }) } as never, (r) => r);

  // Restart ONLY the codex adapter.
  await codex.restart?.({ reason: "codex outage" });

  // The codex restart must have hit ONLY the codex legacy strategy.
  assert.deepEqual(codexCalls, ["restart"]);
  // ISOLATION: the opencode adapter's wrapped strategy was never touched — no shared breaker/global aliasing.
  assert.deepEqual(opencodeCalls, []);

  // And the opencode adapter is still independently healthy after the codex restart.
  const h = await opencode.health();
  assert.equal(h.status, "ok");
  assert.deepEqual(opencodeCalls, ["health"]);
  assert.deepEqual(codexCalls, ["restart"]); // still untouched by the opencode health call
});
