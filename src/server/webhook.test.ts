import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifySignature, parseWebhook, handleWebhook } from "./webhook";

const SECRET = "topsecret";
const sign = (body: string) =>
  "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");

test("verifySignature acepta firma válida y rechaza inválida/ausente", () => {
  const body = '{"repo":"org/app","sha":"abc"}';
  assert.equal(verifySignature(SECRET, body, sign(body)), true);
  assert.equal(verifySignature(SECRET, body, "sha256=deadbeef"), false);
  assert.equal(verifySignature(SECRET, body, undefined), false);
});

test("parseWebhook entiende la forma simple { repo, sha }", () => {
  assert.deepEqual(parseWebhook({ repo: "org/app", sha: "abc" }), {
    repo: "org/app",
    sha: "abc",
  });
});

test("parseWebhook entiende el evento push de GitHub", () => {
  assert.deepEqual(
    parseWebhook({ repository: { full_name: "org/app" }, after: "deadbeef" }),
    { repo: "org/app", sha: "deadbeef" },
  );
});

test("parseWebhook devuelve null si no reconoce el payload", () => {
  assert.equal(parseWebhook({ foo: 1 }), null);
  assert.equal(parseWebhook("no-objeto"), null);
});

test("handleWebhook: 401 si la firma no valida", () => {
  const r = handleWebhook('{"repo":"a","sha":"b"}', "sha256=bad", { secret: SECRET });
  assert.equal(r.status, 401);
  assert.equal(r.payload, undefined);
});

test("handleWebhook: 400 si el body no es JSON", () => {
  assert.equal(handleWebhook("{no-json", undefined, {}).status, 400);
});

test("handleWebhook: 422 si falta repo/sha", () => {
  assert.equal(handleWebhook('{"foo":1}', undefined, {}).status, 422);
});

test("handleWebhook: 202 + payload con firma correcta", () => {
  const body = '{"repo":"org/app","sha":"abc"}';
  const r = handleWebhook(body, sign(body), { secret: SECRET });
  assert.equal(r.status, 202);
  assert.deepEqual(r.payload, { repo: "org/app", sha: "abc" });
});

test("handleWebhook: sin secret configurado no exige firma", () => {
  const r = handleWebhook('{"repo":"org/app","sha":"abc"}', undefined, {});
  assert.equal(r.status, 202);
});
