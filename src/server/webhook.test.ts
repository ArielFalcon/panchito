import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifySignature, parseWebhook, handleWebhook } from "./webhook";

const SECRET = "topsecret";
const SHA = "abc1234"; // a valid 7-char hex commit id
const sign = (body: string) =>
  "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");

test("verifySignature accepts a valid signature and rejects an invalid/missing one", () => {
  const body = `{"repo":"org/app","sha":"${SHA}"}`;
  assert.equal(verifySignature(SECRET, body, sign(body)), true);
  assert.equal(verifySignature(SECRET, body, "sha256=deadbeef"), false);
  assert.equal(verifySignature(SECRET, body, undefined), false);
});

test("parseWebhook understands the simple shape { repo, sha } (mode defaults to diff)", () => {
  assert.deepEqual(parseWebhook({ repo: "org/app", sha: SHA }), {
    repo: "org/app",
    sha: SHA,
    mode: "diff",
    guidance: undefined,
  });
});

test("parseWebhook reads mode and guidance", () => {
  assert.deepEqual(parseWebhook({ repo: "org/app", sha: SHA, mode: "manual", guidance: "test login" }), {
    repo: "org/app",
    sha: SHA,
    mode: "manual",
    guidance: "test login",
  });
  // unknown mode falls back to diff
  assert.equal(parseWebhook({ repo: "a", sha: SHA, mode: "nope" })?.mode, "diff");
  assert.equal(parseWebhook({ repo: "a", sha: SHA, mode: "complete" })?.mode, "complete");
});

test("parseWebhook understands the GitHub push event (mode diff)", () => {
  assert.deepEqual(
    parseWebhook({ repository: { full_name: "org/app" }, after: "deadbeef" }),
    { repo: "org/app", sha: "deadbeef", mode: "diff" },
  );
});

test("parseWebhook rejects a non-hex sha (argument-injection / garbage)", () => {
  assert.equal(parseWebhook({ repo: "org/app", sha: "--output=/x" }), null);
  assert.equal(parseWebhook({ repo: "org/app", sha: "not-a-sha" }), null);
  assert.equal(parseWebhook({ repository: { full_name: "org/app" }, after: "../../evil" }), null);
});

test("parseWebhook returns null when it does not recognize the payload", () => {
  assert.equal(parseWebhook({ foo: 1 }), null);
  assert.equal(parseWebhook("not-an-object"), null);
});

test("handleWebhook: 401 when the signature does not validate", () => {
  const r = handleWebhook(`{"repo":"a","sha":"${SHA}"}`, "sha256=bad", { secret: SECRET });
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
  const body = `{"repo":"org/app","sha":"${SHA}"}`;
  const r = handleWebhook(body, sign(body), { secret: SECRET });
  assert.equal(r.status, 202);
  assert.deepEqual(r.payload, { repo: "org/app", sha: SHA, mode: "diff", guidance: undefined });
});

test("handleWebhook: with no secret configured the CORE does not require a signature (the index.ts fail-closed gate is separate)", () => {
  const r = handleWebhook(`{"repo":"org/app","sha":"${SHA}"}`, undefined, {});
  assert.equal(r.status, 202);
});
