// qa-engine/test/shared-infrastructure/code-graph/stub-code-graph.adapter.test.ts
// Behavioral test for the Phase 1 inert stub: every method MUST resolve to an ok(...) Result with
// the documented empty/zero shape, ignoring all arguments, never throwing/rejecting. Traces to spec
// sdd/codegraph-port-skeleton/spec scenarios A1-A8 (topic id 940).
// Import depth: from qa-engine/test/shared-infrastructure/code-graph/ → qa-engine/src/ is 3 levels
// up (../../../), matching process-kill.test.ts's sibling precedent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { StubCodeGraphAdapter } from "../../../src/shared-infrastructure/code-graph/stub-code-graph.adapter.ts";
import { isOk } from "@kernel/result.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";
import type { LocalSymbolRef } from "@kernel/code/index.ts";

test("syncTo with no opts resolves to an inert zero-node ok result (A1)", async () => {
  const adapter = new StubCodeGraphAdapter();
  const result = await adapter.syncTo("/mirrors/org/repo", ["src/a.ts", "src/b.ts"]);
  assert.equal(isOk(result), true);
  assert.deepEqual(result, { ok: true, value: { nodeCount: 0 } });
});

test("syncTo with { semantic: true } resolves to the same inert shape (A2)", async () => {
  const adapter = new StubCodeGraphAdapter();
  const result = await adapter.syncTo("/mirrors/org/repo", [], { semantic: true });
  assert.equal(isOk(result), true);
  assert.deepEqual(result, { ok: true, value: { nodeCount: 0 } });
});

test("impactedSymbols resolves to an empty ok array (A3)", async () => {
  const adapter = new StubCodeGraphAdapter();
  const changed = BlastRadius.of(Sha.of("abc123d"), ["src/foo.ts"]);
  const result = await adapter.impactedSymbols("/mirrors/org/repo", changed, { depth: 3 });
  assert.equal(isOk(result), true);
  assert.deepEqual(result, { ok: true, value: [] });
});

test("coChangeCoupling resolves to an empty ok array (A4)", async () => {
  const adapter = new StubCodeGraphAdapter();
  const result = await adapter.coChangeCoupling("/mirrors/org/repo", ["src/a.ts", "src/b.ts"]);
  assert.equal(isOk(result), true);
  assert.deepEqual(result, { ok: true, value: [] });
});

test("callersOf resolves to an empty ok array with positional depth and no opts (A5)", async () => {
  const adapter = new StubCodeGraphAdapter();
  const symbol: LocalSymbolRef = { file: "src/foo.ts", symbol: "doThing" };
  const result = await adapter.callersOf("/mirrors/org/repo", symbol, 3);
  assert.equal(isOk(result), true);
  assert.deepEqual(result, { ok: true, value: [] });
});

test("existingCoverage resolves to an empty ok array, not an error (A6, locks R9)", async () => {
  const adapter = new StubCodeGraphAdapter();
  const changed = BlastRadius.of(Sha.of("abc123d"), ["src/foo.ts"]);
  const result = await adapter.existingCoverage("/mirrors/org/repo", changed);
  assert.equal(isOk(result), true);
  assert.deepEqual(result, { ok: true, value: [] });
});

test("structurallyRelated resolves to an empty ok array with and without minJaccard (A7)", async () => {
  const adapter = new StubCodeGraphAdapter();
  const symbols: LocalSymbolRef[] = [{ file: "src/foo.ts", symbol: "doThing" }];

  const withoutFloor = await adapter.structurallyRelated("/mirrors/org/repo", symbols);
  assert.equal(isOk(withoutFloor), true);
  assert.deepEqual(withoutFloor, { ok: true, value: [] });

  const withFloor = await adapter.structurallyRelated("/mirrors/org/repo", symbols, 0.8);
  assert.equal(isOk(withFloor), true);
  assert.deepEqual(withFloor, { ok: true, value: [] });
});

test("no method throws or rejects across all six call shapes (A8)", async () => {
  const adapter = new StubCodeGraphAdapter();
  const changed = BlastRadius.of(Sha.of("abc123d"), ["src/foo.ts"]);
  const symbol: LocalSymbolRef = { file: "src/foo.ts", symbol: "doThing" };
  const symbols: LocalSymbolRef[] = [symbol];

  await assert.doesNotReject(() => adapter.syncTo("/mirrors/org/repo", ["src/a.ts"]));
  await assert.doesNotReject(() => adapter.impactedSymbols("/mirrors/org/repo", changed, { depth: 3 }));
  await assert.doesNotReject(() => adapter.coChangeCoupling("/mirrors/org/repo", ["src/a.ts"]));
  await assert.doesNotReject(() => adapter.callersOf("/mirrors/org/repo", symbol, 3));
  await assert.doesNotReject(() => adapter.existingCoverage("/mirrors/org/repo", changed));
  await assert.doesNotReject(() => adapter.structurallyRelated("/mirrors/org/repo", symbols, 0.8));
});
