// test/contexts/qa-run-orchestration/infrastructure/bridges/validation-port.adapter.test.ts
// RED-first (Task E.0): ValidationPortAdapter delegates to test-execution's REAL StaticGateAdapter
// (validateAll — the FULL gate including the zero-assertion guard, WF-02). Maps
// {ok, errors, infra} -> {ok, errors, infra}. THIN — no re-validation logic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ValidationPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/validation-port.adapter.ts";
import { StaticGateAdapter, type StaticGateChecks } from "@contexts/test-execution/infrastructure/static-gate.adapter.ts";
import type { CheckResult, ValidationResult } from "@contexts/test-execution/application/ports/index.ts";

function fakeChecks(validateAllResult: ValidationResult): StaticGateChecks {
  const ok: CheckResult = { ok: true, output: "" };
  return {
    typecheck: async () => ok,
    lint: async () => ok,
    listTests: async () => ok,
    checkManifest: async () => ok,
    validateAll: async () => validateAllResult,
  };
}

test("validate() delegates to StaticGateAdapter.validateAll and returns {ok, errors, infra} verbatim", async () => {
  const gate = new StaticGateAdapter(fakeChecks({ ok: true, errors: [], infra: false }));
  const adapter = new ValidationPortAdapter(gate);

  const result = await adapter.validate("/mirrors/org/app/e2e");

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.infra, false);
});

test("validate() surfaces a failing gate's errors and the infra flag unchanged", async () => {
  const gate = new StaticGateAdapter(fakeChecks({
    ok: false,
    errors: ["tsc: Property 'foo' does not exist"],
    infra: false,
  }));
  const adapter = new ValidationPortAdapter(gate);

  const result = await adapter.validate("/mirrors/org/app/e2e");

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["tsc: Property 'foo' does not exist"]);
  assert.equal(result.infra, false);
});

test("validate() surfaces infra:true when the gate's own failures are all infrastructure", async () => {
  const gate = new StaticGateAdapter(fakeChecks({
    ok: false,
    errors: ["playwright: browser binary missing"],
    infra: true,
  }));
  const adapter = new ValidationPortAdapter(gate);

  const result = await adapter.validate("/mirrors/org/app/e2e");

  assert.equal(result.infra, true);
});
