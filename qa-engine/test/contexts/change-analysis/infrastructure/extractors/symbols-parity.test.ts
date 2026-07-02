// Parity test: assert the ported qa-engine extractSymbols matches the legacy src/ function
// byte-for-byte. This file imports from src/ (outside qa-engine rootDir) and is excluded from
// qa-engine typecheck (see qa-engine/tsconfig.json exclude list) — identical pattern to
// commit-classification-parity.test.ts. Runs via tsx at runtime; the strangler guard keeping the
// port honest until Plan 7 cutover deletes the legacy original (Plan 7.3 §2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { extractSymbols } from "@contexts/change-analysis/infrastructure/extractors/symbols.ts";
import { extractSymbols as legacy } from "../../../../../../src/qa/static-signal/symbols.ts";

const fixturesDir = join(import.meta.dirname, "../../../../../../src/qa/static-signal/__fixtures__");

test("PARITY: TS functions/classes/methods/interfaces match legacy byte-for-byte", async () => {
  const ported = await extractSymbols(["sample.ts"], fixturesDir);
  const expected = await legacy(["sample.ts"], fixturesDir);
  assert.deepEqual(ported, expected);
  // Non-trivial: the fixture has 5 symbols (pay, validateCard, Cart, PaymentService, process, refund).
  assert.ok(ported.length >= 5, `expected several TS symbols, got ${ported.length}`);
});

test("PARITY: Java methods match legacy byte-for-byte", async () => {
  const ported = await extractSymbols(["Sample.java"], fixturesDir);
  const expected = await legacy(["Sample.java"], fixturesDir);
  assert.deepEqual(ported, expected);
  assert.ok(ported.some((s) => s.kind === "method"), "expected at least one Java method");
});

test("PARITY: unsupported languages degrade to [] identically", async () => {
  const ported = await extractSymbols(["x.go"], fixturesDir);
  const expected = await legacy(["x.go"], fixturesDir);
  assert.deepEqual(ported, expected);
  assert.deepEqual(ported, []);
});
