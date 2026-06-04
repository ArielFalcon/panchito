import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSpecs, ValidateDeps } from "./validate";

const ok = async () => ({ ok: true, output: "" });

test("ok cuando los tres chequeos pasan", async () => {
  const deps: ValidateDeps = { typecheck: ok, lint: ok, listTests: ok };
  const res = await validateSpecs("/dir", deps);
  assert.equal(res.ok, true);
  assert.equal(res.errors.length, 0);
});

test("acumula TODOS los fallos (no corta al primero) con su etiqueta", async () => {
  const deps: ValidateDeps = {
    typecheck: async () => ({ ok: false, output: "TS2322 type error" }),
    lint: ok,
    listTests: async () => ({ ok: false, output: "no spec files found" }),
  };
  const res = await validateSpecs("/dir", deps);
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 2);
  assert.match(res.errors[0]!, /\[typecheck\] TS2322/);
  assert.match(res.errors[1]!, /\[list\] no spec files/);
});

test("un único chequeo fallido marca inválido", async () => {
  const deps: ValidateDeps = {
    typecheck: ok,
    lint: async () => ({ ok: false, output: "playwright/no-wait-for-timeout" }),
    listTests: ok,
  };
  const res = await validateSpecs("/dir", deps);
  assert.equal(res.ok, false);
  assert.match(res.errors[0]!, /no-wait-for-timeout/);
});
