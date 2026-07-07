// test/contexts/qa-run-orchestration/infrastructure/bridges/validation-port.adapter.test.ts
// RED-first (Task E.0): ValidationPortAdapter delegates to test-execution's REAL StaticGateAdapter
// (validateAll — the FULL gate including the zero-assertion guard, WF-02) for the e2e target. Maps
// {ok, errors, infra} -> {ok, errors, infra}. THIN — no re-validation logic.
//
// WS2.2 (full-flow remediation, code-mode restoration): the adapter is now TARGET-DISPATCHED — the
// SAME {e2e, code} + {target} collaborator/context pattern ExecutionPortAdapter/SetupPortAdapter
// already establish. The code branch delegates to CodeValidationStrategy (the compile-feedback gate
// ported from src/qa/code-validate.ts, never wired here before this fix — the code target
// previously had NO pre-execution feedback at all, an execution-only Filter C).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ValidationPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/validation-port.adapter.ts";
import { StaticGateAdapter, type StaticGateChecks } from "@contexts/test-execution/infrastructure/static-gate.adapter.ts";
import { CodeValidationStrategy } from "@contexts/test-execution/infrastructure/code-validation.strategy.ts";
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

function e2eOnlyAdapter(validateAllResult: ValidationResult): ValidationPortAdapter {
  const e2e = new StaticGateAdapter(fakeChecks(validateAllResult));
  const code = new CodeValidationStrategy(async () => { throw new Error("must not be called for target 'e2e'"); });
  return new ValidationPortAdapter({ e2e, code }, { target: "e2e" });
}

test("validate() delegates to StaticGateAdapter.validateAll and returns {ok, errors, infra} verbatim (e2e target)", async () => {
  const adapter = e2eOnlyAdapter({ ok: true, errors: [], infra: false });

  const result = await adapter.validate("/mirrors/org/app/e2e");

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.infra, false);
});

test("validate() surfaces a failing gate's errors and the infra flag unchanged (e2e target)", async () => {
  const adapter = e2eOnlyAdapter({
    ok: false,
    errors: ["tsc: Property 'foo' does not exist"],
    infra: false,
  });

  const result = await adapter.validate("/mirrors/org/app/e2e");

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["tsc: Property 'foo' does not exist"]);
  assert.equal(result.infra, false);
});

test("validate() surfaces infra:true when the gate's own failures are all infrastructure (e2e target)", async () => {
  const adapter = e2eOnlyAdapter({
    ok: false,
    errors: ["playwright: browser binary missing"],
    infra: true,
  });

  const result = await adapter.validate("/mirrors/org/app/e2e");

  assert.equal(result.infra, true);
});

// ── code target — dispatches to CodeValidationStrategy instead of StaticGateAdapter ──────────────

function codeOnlyAdapter(codeResult: ValidationResult, capture?: (dir: string, changedFiles?: string[]) => void): ValidationPortAdapter {
  const e2e = new StaticGateAdapter(fakeChecks({ ok: true, errors: [], infra: false }));
  // Cast: production wiring always passes a real StaticGateAdapter for e2e — never called on this path.
  const throwingE2e = { validateAll: async () => { throw new Error("must not be called for target 'code'"); } } as unknown as StaticGateAdapter;
  void e2e;
  const code = new CodeValidationStrategy(async (dir, opts) => {
    capture?.(dir, opts.changedFiles);
    return codeResult;
  });
  return new ValidationPortAdapter({ e2e: throwingE2e, code }, { target: "code" });
}

test("validate() dispatches to CodeValidationStrategy for the code target — never StaticGateAdapter", async () => {
  const adapter = codeOnlyAdapter({ ok: true, errors: [], infra: false });

  const result = await adapter.validate("/mirrors/org/code-app");

  assert.equal(result.ok, true);
});

test("validate() surfaces a code-target compile error as ok:false, infra:false", async () => {
  const adapter = codeOnlyAdapter({ ok: false, errors: ["[compile] cannot find symbol"], infra: false });

  const result = await adapter.validate("/mirrors/org/code-app");

  assert.equal(result.ok, false);
  assert.equal(result.infra, false);
  assert.deepEqual(result.errors, ["[compile] cannot find symbol"]);
});

test("validate() surfaces a code-target broken toolchain as infra:true", async () => {
  const adapter = codeOnlyAdapter({ ok: false, errors: ["[compile] JAVA_HOME is not set"], infra: true });

  const result = await adapter.validate("/mirrors/org/code-app");

  assert.equal(result.infra, true);
});

test("validate() threads changedFiles through to the code strategy", async () => {
  let captured: string[] | undefined;
  const adapter = codeOnlyAdapter({ ok: true, errors: [], infra: false }, (_dir, changedFiles) => { captured = changedFiles; });

  await adapter.validate("/mirrors/org/code-app", ["src/orders.ts"]);

  assert.deepEqual(captured, ["src/orders.ts"]);
});
