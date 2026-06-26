// test/contexts/agent-runtime/ports/config.port.test.ts
// Task A.4 compile-time guard: ConfigPort, AgentRuntimeConfigView, and AgentConfigValidationView must be
// importable from the agent-runtime ports barrel before any adapter depends on them.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConfigPort, AgentRuntimeConfigView, AgentConfigValidationView } from "@contexts/agent-runtime/application/ports/index.ts";

test("ConfigPort and its read-models are importable from the agent-runtime port barrel (compile-time guard)", () => {
  // tsc is the real assertion; these null bindings verify the types resolved without elision.
  const _port: ConfigPort | null = null;
  const _view: AgentRuntimeConfigView | null = null;
  const _validation: AgentConfigValidationView | null = null;
  assert.equal(_port, null);
  assert.equal(_view, null);
  assert.equal(_validation, null);
});

test("AgentRuntimeConfigView carries mode and assignments array (structural guard)", () => {
  const view: AgentRuntimeConfigView = {
    mode: "dual",
    assignments: [{ role: "primary", provider: "opencode", model: "m1" }],
  };
  assert.equal(view.mode, "dual");
  assert.equal(view.assignments.length, 1);
  assert.equal(view.assignments[0]?.role, "primary");
});

test("AgentConfigValidationView carries valid boolean and errors array", () => {
  const ok: AgentConfigValidationView = { valid: true, errors: [] };
  const err: AgentConfigValidationView = { valid: false, errors: ["missing key"] };
  assert.equal(ok.valid, true);
  assert.equal(err.errors[0], "missing key");
});
