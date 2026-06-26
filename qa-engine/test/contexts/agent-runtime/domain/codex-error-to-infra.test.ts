import { test } from "node:test";
import assert from "node:assert/strict";
import { codexErrorToInfra } from "@contexts/agent-runtime/domain/codex-error-to-infra.ts";

test("classifies a timeout error as infra (AgentUnavailableError)", () => {
  const r = codexErrorToInfra(new Error("Codex prompt timed out after 30000ms"));
  assert.ok(r, "a timeout error must be infra, not a code failure");
});

test("classifies an auth/credits error as infra", () => {
  const r = codexErrorToInfra(new Error("401 unauthorized"));
  assert.ok(r, "an auth error must be infra, not a code failure");
});

test("classifies an abort/SIGTERM error as infra", () => {
  const r = codexErrorToInfra(new Error("process was aborted"));
  assert.ok(r, "an abort error must be infra, not a code failure");
});

test("a genuine non-infra error returns null (the run must surface it)", () => {
  const r = codexErrorToInfra(new Error("the model produced no JSON verdict"));
  assert.equal(r, null);
});

test("a non-Error value returns null (no instanceof match)", () => {
  assert.equal(codexErrorToInfra(null), null);
  assert.equal(codexErrorToInfra("a string error"), null);
  assert.equal(codexErrorToInfra({ code: "ETIMEDOUT" }), null);
});
