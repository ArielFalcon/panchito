import { test } from "node:test";
import assert from "node:assert/strict";
import { testDataNamespace, isOwnedByRun } from "./test-data";

const SHA = "abc1234567890";

test("namespace usa prefijo + sha corto", () => {
  assert.equal(testDataNamespace("qa-bot", SHA), "qa-bot-abc1234");
});

test("reconoce entidades propias del run", () => {
  const user = `${testDataNamespace("qa-bot", SHA)}-user-1`;
  assert.equal(isOwnedByRun(user, "qa-bot", SHA), true);
});

test("no reclama entidades de otros runs/datos reales", () => {
  assert.equal(isOwnedByRun("cliente-real-42", "qa-bot", SHA), false);
  assert.equal(isOwnedByRun("qa-bot-otsha99-user", "qa-bot", SHA), false);
});
