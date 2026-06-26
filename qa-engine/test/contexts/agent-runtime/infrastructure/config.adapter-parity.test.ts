// PARITY: ConfigAdapter.fromEnv must transform the REAL legacy configFromEnv output into the
// structural view — assignments flattened from a keyed object to a {role,provider,model} array (QA-01).
// Imports from src/ — excluded from qa-engine typecheck; runs via tsx.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigAdapter } from "@contexts/agent-runtime/infrastructure/config.adapter.ts";
import { configFromEnv, validateAgentRuntimeConfig, publicAgentConfig } from "../../../../../src/agent-runtime/config.ts";

const adapter = new ConfigAdapter({
  configFromEnv: (env) => configFromEnv(env),
  validateAgentRuntimeConfig: (cfg, keys) => {
    const v = validateAgentRuntimeConfig(cfg as never, { opencode: !!keys.OPENCODE_API_KEY, codex: !!keys.CODEX_API_KEY });
    return { valid: v.ok, errors: v.errors };
  },
  publicAgentConfig: (cfg) => publicAgentConfig(cfg as never, { opencode: false, codex: false }),
});

test("PARITY: fromEnv flattens the REAL legacy assignments object into a {role,provider,model} array", () => {
  // Single mode (opencode key present) — the real config produces a keyed {primary,reviewer,chat} object.
  const view = adapter.fromEnv({ AGENT_RUNTIME_MODE: "single", OPENCODE_API_KEY: "x" });
  assert.equal(view.mode, "single");
  assert.ok(Array.isArray(view.assignments), "assignments must be an array (blind cast would leak the object)");

  const real = configFromEnv({ AGENT_RUNTIME_MODE: "single", OPENCODE_API_KEY: "x" });
  const expected = Object.entries(real.assignments).map(([role, a]) => ({ role, provider: a.provider, model: a.model }));
  assert.deepEqual(view.assignments, expected);

  // Every view entry carries the three flattened fields, never the nested legacy shape.
  for (const entry of view.assignments) {
    assert.equal(typeof entry.role, "string");
    assert.equal(typeof entry.model, "string");
    assert.ok(entry.provider === "opencode" || entry.provider === "codex");
  }
  assert.deepEqual(view.assignments.map((e) => e.role), ["primary", "reviewer", "chat"]);
});

test("PARITY: dual mode flattens to an array too", () => {
  const view = adapter.fromEnv({ AGENT_RUNTIME_MODE: "dual", OPENCODE_API_KEY: "x", CODEX_API_KEY: "y" });
  assert.equal(view.mode, "dual");
  const real = configFromEnv({ AGENT_RUNTIME_MODE: "dual", OPENCODE_API_KEY: "x", CODEX_API_KEY: "y" });
  const expected = Object.entries(real.assignments).map(([role, a]) => ({ role, provider: a.provider, model: a.model }));
  assert.deepEqual(view.assignments, expected);
});
