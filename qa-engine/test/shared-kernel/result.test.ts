// qa-engine/test/shared-kernel/result.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ok, err, isOk, isErr, map, unwrapOr, type Result } from "@kernel/result.ts";

test("ok carries a value and is recognized by isOk", () => {
  const r: Result<number, string> = ok(42);
  assert.equal(isOk(r), true);
  assert.equal(isErr(r), false);
  if (isOk(r)) assert.equal(r.value, 42);
});

test("err carries an error and is recognized by isErr", () => {
  const r: Result<number, string> = err("boom");
  assert.equal(isErr(r), true);
  if (isErr(r)) assert.equal(r.error, "boom");
});

test("map transforms ok, passes err through untouched", () => {
  assert.deepEqual(map(ok(2), (n) => n * 10), ok(20));
  assert.deepEqual(map(err<number, string>("e"), (n) => n * 10), err("e"));
});

test("unwrapOr returns the value on ok and the fallback on err", () => {
  assert.equal(unwrapOr(ok(7), 0), 7);
  assert.equal(unwrapOr(err<number, string>("e"), 0), 0);
});
