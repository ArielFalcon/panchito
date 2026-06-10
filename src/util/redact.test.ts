import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, redactError } from "./redact";

test("redacts git x-access-token URL", () => {
  const s = "Command failed: git ls-remote https://x-access-token:ghp_abcDEF123@github.com/owner/repo.git main";
  const out = redactSecrets(s);
  assert.match(out, /\[REDACTED_CREDENTIAL\]/);
  assert.doesNotMatch(out, /ghp_abcDEF123/);
});

test("redacts http.extraHeader config form", () => {
  const s = "fatal: ... -c url.https://x-access-token:secret_TOKEN@github.com/.insteadOf=https://github.com/ ...";
  const out = redactSecrets(s);
  assert.doesNotMatch(out, /secret_TOKEN/);
});

test("redacts Authorization Bearer header", () => {
  const out = redactSecrets("Authorization: Bearer abc.def.ghi");
  assert.doesNotMatch(out, /abc\.def\.ghi/);
});

test("redactError unwraps Error instance", () => {
  const out = redactError(new Error("https://x-access-token:tok@github.com fail"));
  assert.doesNotMatch(out, /tok@github/);
});
