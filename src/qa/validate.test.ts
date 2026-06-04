import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSpecs, ValidateDeps } from "./validate";

const ok = async () => ({ ok: true, output: "" });

test("ok cuando los cuatro chequeos pasan", async () => {
  const deps: ValidateDeps = { typecheck: ok, lint: ok, listTests: ok, checkManifest: ok };
  const res = await validateSpecs("/dir", deps);
  assert.equal(res.ok, true);
  assert.equal(res.errors.length, 0);
});

test("acumula TODOS los fallos (no corta al primero) con su etiqueta", async () => {
  const deps: ValidateDeps = {
    typecheck: async () => ({ ok: false, output: "TS2322 type error" }),
    lint: ok,
    listTests: async () => ({ ok: false, output: "no spec files found" }),
    checkManifest: ok,
  };
  const res = await validateSpecs("/dir", deps);
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 2);
  assert.match(res.errors[0]!, /\[typecheck\] TS2322/);
  assert.match(res.errors[1]!, /\[list\] no spec files/);
});

test("metadata inválida marca el run como inválido", async () => {
  const deps: ValidateDeps = {
    typecheck: ok,
    lint: ok,
    listTests: ok,
    checkManifest: async () => ({ ok: false, output: "'login': falta 'objective'" }),
  };
  const res = await validateSpecs("/dir", deps);
  assert.equal(res.ok, false);
  assert.match(res.errors[0]!, /\[manifest\].*objective/);
});
