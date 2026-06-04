import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifySignature, parseWebhook, handleWebhook } from "./webhook";

const SECRET = "topsecret";
const sign = (body: string) =>
  "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");

test("verifySignature accepts a valid signature and rejects an invalid/missing one", () => {
  const body = '{"repo":"org/app","sha":"abc"}';
  assert.equal(verifySignature(SECRET, body, sign(body)), true);
  assert.equal(verifySignature(SECRET, body, "sha256=deadbeef"), false);
  assert.equal(verifySignature(SECRET, body, undefined), false);
});

test("parseWebhook understands the simple shape { repo, sha }", () => {
  assert.deepEqual(parseWebhook({ repo: "org/app", sha: "abc" }), {
    repo: "org/app",
    sha: "abc",
  });
});

test("parseWebhook understands the GitHub push event", () => {
  assert.deepEqual(
    parseWebhook({ repository: { full_name: "org/app" }, after: "deadbeef" }),
    { repo: "org/app", sha: "deadbeef" },
  );
});

test("parseWebhook returns null when it does not recognize the payload", () => {
  assert.equal(parseWebhook({ foo: 1 }), null);
  assert.equal(parseWebhook("not-an-object"), null);
});

test("handleWebhook: 401 when the signature does not validate", () => {
  const r = handleWebhook('{"repo":"a","sha":"b"}', "sha256=bad", { secret: SECRET });
  assert.equal(r.status, 401);
  assert.equal(r.payload, undefined);
});

test("handleWebhook: 400 when the body is not JSON", () => {
  assert.equal(handleWebhook("{not-json", undefined, {}).status, 400);
});

test("handleWebhook: 422 when repo/sha is missing", () => {
  assert.equal(handleWebhook('{"foo":1}', undefined, {}).status, 422);
});

test("handleWebhook: 202 + payload with a correct signature", () => {
  const body = '{"repo":"org/app","sha":"abc"}';
  const r = handleWebhook(body, sign(body), { secret: SECRET });
  assert.equal(r.status, 202);
  assert.deepEqual(r.payload, { repo: "org/app", sha: "abc" });
});

test("handleWebhook: with no secret configured it does not require a signature", () => {
  const r = handleWebhook('{"repo":"org/app","sha":"abc"}', undefined, {});
  assert.equal(r.status, 202);
});
