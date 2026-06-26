// test/contexts/test-execution/infrastructure/static-gate.adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { StaticGateAdapter } from "@contexts/test-execution/infrastructure/static-gate.adapter.ts";
import type { ValidationResult } from "@contexts/test-execution/application/ports/index.ts";

const ok = { ok: true, output: "" };

// Build a full checks stub (including validateAll) for use in all tests.
function makeChecks(overrides: Partial<{
  typecheck: (d: string) => Promise<{ ok: boolean; output: string }>;
  lint: (d: string) => Promise<{ ok: boolean; output: string }>;
  listTests: (d: string) => Promise<{ ok: boolean; output: string }>;
  checkManifest: (d: string) => Promise<{ ok: boolean; output: string }>;
  validateAll: (d: string) => Promise<ValidationResult>;
}> = {}) {
  return {
    typecheck: overrides.typecheck ?? (async () => ok),
    lint: overrides.lint ?? (async () => ok),
    listTests: overrides.listTests ?? (async () => ok),
    checkManifest: overrides.checkManifest ?? (async () => ok),
    validateAll: overrides.validateAll ?? (async () => ({ ok: true, errors: [], infra: false })),
  };
}

test("each method delegates to its injected check and returns its CheckResult", async () => {
  const calls: string[] = [];
  const adapter = new StaticGateAdapter(makeChecks({
    typecheck: async (d) => { calls.push(`tc:${d}`); return ok; },
    lint: async (d) => { calls.push(`lint:${d}`); return ok; },
    listTests: async (d) => { calls.push(`list:${d}`); return ok; },
    checkManifest: async (d) => { calls.push(`mf:${d}`); return ok; },
  }));
  await adapter.typecheck("/m");
  await adapter.lint("/m");
  await adapter.listTests("/m");
  await adapter.checkManifest("/m");
  assert.deepEqual(calls, ["tc:/m", "lint:/m", "list:/m", "mf:/m"]);
});

test("a failing typecheck surfaces ok:false with the output", async () => {
  const adapter = new StaticGateAdapter(makeChecks({
    typecheck: async () => ({ ok: false, output: "TS2345" }),
  }));
  const r = await adapter.typecheck("/m");
  assert.equal(r.ok, false);
  assert.match(r.output, /TS2345/);
});

// validateAll delegation — WF-02 fix: the zero-assertion gate must cross the port boundary.
test("validateAll delegates to the injected fn and returns its ValidationResult", async () => {
  const expected: ValidationResult = { ok: false, errors: ["[zero-assertions] foo.spec.ts: spec has no expect() calls — remove it or add assertions"], infra: false };
  let calledWith: string | undefined;
  const adapter = new StaticGateAdapter(makeChecks({
    validateAll: async (d) => { calledWith = d; return expected; },
  }));
  const result = await adapter.validateAll("/spec-dir");
  assert.equal(calledWith, "/spec-dir", "validateAll must forward specDir to injected fn");
  assert.deepStrictEqual(result, expected, "validateAll must return the injected fn result unchanged");
});

test("validateAll returning ok:true passes through faithfully", async () => {
  const adapter = new StaticGateAdapter(makeChecks({
    validateAll: async () => ({ ok: true, errors: [], infra: false }),
  }));
  const result = await adapter.validateAll("/spec-dir");
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

// Parity: the validateAll injection must be meaningful — a gutted impl that ignores
// the injected fn and just returns ok:true would fail this test. The injected fn
// returns a known non-ok ValidationResult; the adapter must not swallow it.
test("validateAll parity: a gutted impl that ignores the injected fn would fail", async () => {
  const injected: ValidationResult = { ok: false, errors: ["[zero-assertions] bad.spec.ts: spec has no expect() calls — remove it or add assertions"], infra: false };
  const adapter = new StaticGateAdapter(makeChecks({
    validateAll: async () => injected,
  }));
  const result = await adapter.validateAll("/spec-dir");
  // A gutted impl would return { ok: true, errors: [] } — this assertion catches it.
  assert.equal(result.ok, false, "adapter must delegate — not return a hardcoded ok:true");
  assert.ok(result.errors.length > 0, "adapter must surface zero-assertion errors from injected fn");
});
