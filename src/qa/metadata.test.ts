import { test } from "node:test";
import assert from "node:assert/strict";
import { validateManifest } from "./metadata";

const valid = {
  id: "checkout/over-10-items",
  objective: "With >10 items, checkout completes the payment",
  flow: "checkout",
  targets: ["CheckoutService.validateCart"],
  changeRef: { sha: "abc1234", type: "fix" },
};

test("an empty manifest is valid (repo with no tests yet)", () => {
  assert.equal(validateManifest([]).ok, true);
});

test("a complete entry is valid", () => {
  assert.equal(validateManifest([valid]).ok, true);
});

test("rejects a non-array", () => {
  assert.equal(validateManifest({}).ok, false);
});

test("requires objective, flow, targets and changeRef", () => {
  const r = validateManifest([{ id: "x" }]);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /objective/);
  assert.match(r.errors.join(" "), /flow/);
  assert.match(r.errors.join(" "), /targets/);
  assert.match(r.errors.join(" "), /changeRef/);
});

test("detects duplicate ids", () => {
  const r = validateManifest([valid, valid]);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /duplicate id/);
});

test("empty targets is not allowed", () => {
  const r = validateManifest([{ ...valid, targets: [] }]);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /targets/);
});
