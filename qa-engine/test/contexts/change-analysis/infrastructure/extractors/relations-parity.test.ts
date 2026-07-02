// Parity test: assert the ported qa-engine extractRelations matches the legacy src/ function
// byte-for-byte. See symbols-parity.test.ts header for the pattern/rationale (Plan 7.3 §2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { extractRelations } from "@contexts/change-analysis/infrastructure/extractors/relations.ts";
import { extractRelations as legacy } from "../../../../../../src/qa/static-signal/relations.ts";

const fixturesDir = join(import.meta.dirname, "../../../../../../src/qa/static-signal/__fixtures__");

test("PARITY: relative TS imports resolve to repo-relative paths, matching legacy", async () => {
  const ported = await extractRelations(["sample.ts"], fixturesDir);
  const expected = await legacy(["sample.ts"], fixturesDir);
  assert.deepEqual(ported, expected);
  // Non-trivial: sample.ts imports OrderService from "./order" — must resolve to order.ts.
  assert.ok(ported.some((e) => e.to === "order.ts"), `expected an edge to order.ts, got ${JSON.stringify(ported)}`);
});

test("PARITY: TypeScript path-alias resolution (C3) matches legacy", async () => {
  const dir = join(fixturesDir, "c3-alias");
  const ported = await extractRelations(["src/consumer.ts"], dir);
  const expected = await legacy(["src/consumer.ts"], dir);
  assert.deepEqual(ported, expected);
});

test("PARITY: Java dotted-import heuristic resolution (C3) matches legacy — both resolved and raw-kept edges", async () => {
  const dir = join(fixturesDir, "c3-java");
  const files = ["src/main/java/com/example/OrderService.java"];
  const ported = await extractRelations(files, dir);
  const expected = await legacy(files, dir);
  assert.deepEqual(ported, expected);
  // Non-trivial: OrderService imports both an existing UserService (resolves) and a NotExists
  // class (stays raw, fail-open) — proves both C3 Java branches are exercised identically.
  assert.ok(ported.some((e) => e.to === "src/main/java/com/example/UserService.java"));
  assert.ok(ported.some((e) => e.to === "com.example.NotExists"));
});
