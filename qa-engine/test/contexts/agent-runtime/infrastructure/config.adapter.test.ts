// test/contexts/agent-runtime/infrastructure/config.adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigAdapter } from "@contexts/agent-runtime/infrastructure/config.adapter.ts";

test("fromEnv delegates to the injected configFromEnv and maps the view", () => {
  let seenEnv: Record<string, string | undefined> | undefined;
  const adapter = new ConfigAdapter({
    // Legacy shape: assignments is a KEYED OBJECT ({primary,reviewer,chat}: {provider,model}).
    configFromEnv: (env) => { seenEnv = env; return {
      mode: "dual",
      assignments: {
        primary: { provider: "opencode", model: "m1" },
        reviewer: { provider: "codex", model: "m2" },
        chat: { provider: "opencode", model: "m3" },
      },
    } as never; },
    validateAgentRuntimeConfig: () => ({ valid: true, errors: [] }) as never,
    publicAgentConfig: (c) => c as never,
  });
  const view = adapter.fromEnv({ AGENT_MODE: "dual" });
  // DELEGATION assertion: the injected fn received the env (a gutted impl that returns a literal FAILS).
  assert.deepEqual(seenEnv, { AGENT_MODE: "dual" });
  assert.equal(view.mode, "dual");
  // SHAPE assertion: the view exposes assignments as an ARRAY of {role,provider,model} — a blind cast
  // (return legacy as View) leaks the keyed object through and FAILS here (QA-01).
  assert.ok(Array.isArray(view.assignments), "assignments must be an array on the view");
  assert.deepEqual(view.assignments, [
    { role: "primary", provider: "opencode", model: "m1" },
    { role: "reviewer", provider: "codex", model: "m2" },
    { role: "chat", provider: "opencode", model: "m3" },
  ]);
});

test("validate delegates to the injected validator and surfaces errors", () => {
  let called = false;
  const adapter = new ConfigAdapter({
    configFromEnv: () => ({ mode: "single", assignments: {} }) as never,
    validateAgentRuntimeConfig: () => { called = true; return { valid: false, errors: ["missing key"] } as never; },
    publicAgentConfig: (c) => c as never,
  });
  const r = adapter.validate({ mode: "single", assignments: [] }, { OPENCODE_API_KEY: false });
  assert.equal(called, true);
  assert.equal(r.valid, false);
  assert.deepEqual(r.errors, ["missing key"]);
});
