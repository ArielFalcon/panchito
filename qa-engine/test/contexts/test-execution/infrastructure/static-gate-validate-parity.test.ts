// test/contexts/test-execution/infrastructure/static-gate-validate-parity.test.ts
// TE-04: real-validateSpecs parity test. The WF-02 zero-assertion gate is otherwise only pinned
// at stub level in static-gate.adapter.test.ts. A Plan-6 wiring that passes a no-op validateAll
// would pass all stub tests. This file exercises the REAL validateSpecs from src/qa/validate.ts
// through a temp flows/ dir so the zero-assertion error actually propagates.
//
// EXCLUDED from tsconfig.json (imports src/ directly — parity-test pattern used across qa-engine).
// Run via: node --import tsx --test test/contexts/test-execution/infrastructure/static-gate-validate-parity.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
// Direct src/ import intentional: this is a parity test, confirming the real validate gate works.
// Relative path from qa-engine/test/contexts/test-execution/infrastructure/ up 5 levels to the root,
// then into src/qa/validate.ts (same pattern as adjudicate-parity.test.ts).
import { validateSpecs, defaultValidateDeps } from "../../../../../src/qa/validate.ts";

test("real validateSpecs: a zero-assertion spec under flows/ produces a [zero-assertions] error", async () => {
  // Create a temp specDir with a flows/ subdir containing one spec that has no expect() call.
  const specDir = mkdtempSync(join(tmpdir(), "qa-engine-te04-"));
  const flowsDir = join(specDir, "flows");
  mkdirSync(flowsDir, { recursive: true });
  writeFileSync(
    join(flowsDir, "empty.spec.ts"),
    // Valid-looking Playwright spec with no assertion — triggers the zero-assertion gate.
    `import { test } from "@playwright/test";\ntest("placeholder", async ({ page }) => {\n  await page.goto("https://example.com");\n});\n`,
  );
  try {
    // Use stubs for the spawned checks (typecheck/lint/listTests/checkManifest) so the test
    // needs no tsc/eslint/playwright binary — only the zero-assertion scan (pure fs reads) runs.
    const stubOk = async () => ({ ok: true, output: "" });
    const result = await validateSpecs(specDir, {
      typecheck: stubOk,
      lint: stubOk,
      listTests: stubOk,
      checkManifest: stubOk,
    });
    assert.equal(result.ok, false, "validateSpecs must fail when a flows/ spec has no assertions");
    assert.equal(result.infra, false, "zero-assertion failure is a code quality issue, not an infra failure");
    const zeroAssertionError = result.errors.find((e) => e.includes("[zero-assertions]"));
    assert.ok(zeroAssertionError !== undefined, "errors must contain a [zero-assertions] entry");
    assert.match(zeroAssertionError, /empty\.spec\.ts/, "error must name the offending spec file");
    assert.match(zeroAssertionError, /no expect\(\) calls/, "error must explain the assertion gap");
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("real validateSpecs: a spec with an expect() call under flows/ is NOT flagged", async () => {
  const specDir = mkdtempSync(join(tmpdir(), "qa-engine-te04-"));
  const flowsDir = join(specDir, "flows");
  mkdirSync(flowsDir, { recursive: true });
  writeFileSync(
    join(flowsDir, "real.spec.ts"),
    `import { test, expect } from "@playwright/test";\ntest("real", async ({ page }) => {\n  await page.goto("https://example.com");\n  await expect(page).toHaveTitle("Example");\n});\n`,
  );
  try {
    const stubOk = async () => ({ ok: true, output: "" });
    const result = await validateSpecs(specDir, {
      typecheck: stubOk,
      lint: stubOk,
      listTests: stubOk,
      checkManifest: stubOk,
    });
    // All stub checks pass and the spec has assertions — result should be fully ok.
    assert.equal(result.ok, true, "validateSpecs must pass when the spec has assertions");
    assert.deepEqual(result.errors, [], "no errors expected when spec has assertions");
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

// Confirm the defaultValidateDeps export is accessible (import smoke test — not invoked since it
// would need real binaries, but the import must resolve to confirm the export exists and is typed).
test("defaultValidateDeps export is accessible (parity guard: export must not disappear)", () => {
  assert.equal(typeof defaultValidateDeps, "object", "defaultValidateDeps must be exported as an object");
  assert.equal(typeof defaultValidateDeps.typecheck, "function", "defaultValidateDeps.typecheck must be a function");
  assert.equal(typeof defaultValidateDeps.lint, "function", "defaultValidateDeps.lint must be a function");
  assert.equal(typeof defaultValidateDeps.listTests, "function", "defaultValidateDeps.listTests must be a function");
  assert.equal(typeof defaultValidateDeps.checkManifest, "function", "defaultValidateDeps.checkManifest must be a function");
});
