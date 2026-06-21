import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { extractSymbols } from "./symbols";

test("extractSymbols finds TS functions with signatures", async () => {
  const syms = await extractSymbols(["sample.ts"], join(import.meta.dirname, "__fixtures__"));
  const pay = syms.find((s) => s.name === "pay");
  assert.ok(pay);
  assert.equal(pay!.kind, "function");
  assert.match(pay!.signature, /pay/);
});

test("extractSymbols finds TS classes", async () => {
  const syms = await extractSymbols(["sample.ts"], join(import.meta.dirname, "__fixtures__"));
  const service = syms.find((s) => s.name === "PaymentService");
  assert.ok(service);
  assert.equal(service!.kind, "class");
});

test("extractSymbols finds TS methods", async () => {
  const syms = await extractSymbols(["sample.ts"], join(import.meta.dirname, "__fixtures__"));
  assert.ok(syms.some((s) => s.kind === "method" && s.name === "process"));
});

test("extractSymbols finds Java methods", async () => {
  const syms = await extractSymbols(["Sample.java"], join(import.meta.dirname, "__fixtures__"));
  assert.ok(syms.some((s) => s.kind === "method"));
});

test("extractSymbols finds TS interfaces", async () => {
  const syms = await extractSymbols(["sample.ts"], join(import.meta.dirname, "__fixtures__"));
  assert.ok(syms.some((s) => s.kind === "interface"));
});

test("extractSymbols skips unsupported languages", async () => {
  const syms = await extractSymbols(["x.go"], join(import.meta.dirname, "__fixtures__"));
  assert.deepEqual(syms, []);
});
