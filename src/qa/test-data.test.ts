import { test } from "node:test";
import assert from "node:assert/strict";
import { testDataNamespace, shortSha } from "./test-data";

const SHA = "abc1234567890";

test("namespace usa prefijo + sha corto", () => {
  assert.equal(testDataNamespace("qa-bot", SHA), "qa-bot-abc1234");
});

test("shortSha recorta a 7", () => {
  assert.equal(shortSha(SHA), "abc1234");
});
