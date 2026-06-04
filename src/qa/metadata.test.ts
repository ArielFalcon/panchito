import { test } from "node:test";
import assert from "node:assert/strict";
import { validateManifest } from "./metadata";

const valid = {
  id: "checkout/over-10-items",
  objective: "Con >10 ítems, el checkout completa el pago",
  flow: "checkout",
  targets: ["CheckoutService.validateCart"],
  changeRef: { sha: "abc1234", type: "fix" },
};

test("manifest vacío es válido (repo sin tests todavía)", () => {
  assert.equal(validateManifest([]).ok, true);
});

test("entrada completa es válida", () => {
  assert.equal(validateManifest([valid]).ok, true);
});

test("rechaza si no es array", () => {
  assert.equal(validateManifest({}).ok, false);
});

test("exige objective, flow, targets y changeRef", () => {
  const r = validateManifest([{ id: "x" }]);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /objective/);
  assert.match(r.errors.join(" "), /flow/);
  assert.match(r.errors.join(" "), /targets/);
  assert.match(r.errors.join(" "), /changeRef/);
});

test("detecta ids duplicados", () => {
  const r = validateManifest([valid, valid]);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /id duplicado/);
});

test("targets vacío no vale", () => {
  const r = validateManifest([{ ...valid, targets: [] }]);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /targets/);
});
