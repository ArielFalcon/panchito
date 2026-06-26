// test/contexts/agent-runtime/infrastructure/agent-facade.adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentFacadeAdapter } from "@contexts/agent-runtime/infrastructure/agent-facade.adapter.ts";

test("getStatus delegates to the wrapped DUAL facade and forwards BOTH providers (mode not collapsed)", async () => {
  let called = false;
  const adapter = new AgentFacadeAdapter({
    getStatus: async () => { called = true; return { mode: "dual", providers: [
      { provider: "opencode", status: "ok", configured: true }, { provider: "codex", status: "ok", configured: true }] }; },
    listModels: async () => [],
  } as never);
  const s = await adapter.getStatus();
  assert.equal(called, true);
  assert.equal(s.mode, "dual");                    // DELEGATION: the wrapped facade's mode, not a literal
  assert.equal(s.providers.length, 2);             // dual is NOT collapsed to one provider
});

test("getStatus forwards SINGLE-mode facade verbatim (mode===single, providers.length===1)", async () => {
  let called = false;
  const adapter = new AgentFacadeAdapter({
    getStatus: async () => {
      called = true;
      return { mode: "single", providers: [
        { provider: "opencode", status: "ok", configured: true }] };
    },
    listModels: async () => [],
  } as never);
  const s = await adapter.getStatus();
  assert.equal(called, true);
  assert.equal(s.mode, "single");        // a gutted impl returning {mode:'dual'} would FAIL here
  assert.equal(s.providers.length, 1);  // single-mode is NOT promoted to two providers
});

test("startEventStream delegates to the wrapped facade (the dual SSE multiplex survives)", async () => {
  const calls: string[] = [];
  const adapter = new AgentFacadeAdapter({
    getStatus: async () => ({ mode: "single", providers: [] }),
    listModels: async () => [],
    startEventStream: async () => { calls.push("stream"); },
  } as never);
  await adapter.startEventStream?.(() => {});
  assert.deepEqual(calls, ["stream"]);             // a wrapper that dropped the optional stream would FAIL
});
