import { test } from "node:test";
import assert from "node:assert/strict";
import { InfraError, AgentUnavailableError, isInfraError } from "./errors";

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
