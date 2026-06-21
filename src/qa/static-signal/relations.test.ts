import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { extractRelations } from "./relations";

test("extractRelations links a changed file to its imported changed file", async () => {
  const edges = await extractRelations(["sample.ts", "order.ts"], join(import.meta.dirname, "__fixtures__"));
  assert.ok(edges.some((e) => e.from.endsWith("sample.ts") && e.to.endsWith("order.ts")));
});

test("extractRelations keeps unresolved imports as module specifiers", async () => {
  const edges = await extractRelations(["sample.ts"], join(import.meta.dirname, "__fixtures__"));
  assert.ok(edges.every((e) => typeof e.to === "string"));
});
