import { test } from "node:test";
import assert from "node:assert/strict";
import { InfraError, AgentUnavailableError, StalledAgentError, isInfraError } from "./errors";

test("InfraError is recognized as infrastructure", () => {
  assert.equal(isInfraError(new InfraError("DEV is unreachable")), true);
});

test("AgentUnavailableError (provider out of credits / auth) is infrastructure, never a code verdict", () => {
  const e = new AgentUnavailableError("OpenCode provider rejected the request (out of credits)");
  assert.equal(isInfraError(e), true); // → infra-error, not invalid/fail
  assert.ok(e instanceof InfraError); // it IS an InfraError subtype
  assert.equal(e.name, "AgentUnavailableError");
  // name fallback path (cross-realm instanceof miss)
  const shaped = new Error("provider error");
  shaped.name = "AgentUnavailableError";
  assert.equal(isInfraError(shaped), true);
});

test("a DeployTimeoutError-shaped error (matched by name) is infrastructure", () => {
  const e = new Error("deploy timed out");
  e.name = "DeployTimeoutError";
  assert.equal(isInfraError(e), true);
});

test("an operator cancel is infrastructure (transient, not a code fault)", () => {
  assert.equal(isInfraError(new Error("run cancelled by operator")), true);
});

test("a generic thrown Error is NOT infrastructure (an unexpected internal error to surface)", () => {
  assert.equal(isInfraError(new Error("GitHub PR error 422: A pull request already exists")), false);
  assert.equal(isInfraError(new Error("OpenCode session.prompt failed: 500")), false);
  assert.equal(isInfraError(new Error("Unexpected token < in JSON")), false);
});

test("non-Error throwables are not infrastructure", () => {
  assert.equal(isInfraError("boom"), false);
  assert.equal(isInfraError(undefined), false);
});

// Moved from src/integrations/stall-watchdog-wrapper.test.ts (migration-tier-4c Slice 2): the
// StalledAgentError-throwing withStallWatchdog wrapper itself migrated to qa-engine's
// agent-transport-policy.ts (using the qa-engine @kernel/domain-error.ts twin of this class), but
// src/errors.ts's OWN StalledAgentError stays here and still needs its classification pinned.

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
