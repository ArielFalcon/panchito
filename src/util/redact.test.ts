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

test("redacts a configured secret value verbatim regardless of surrounding format", () => {
  const env = { CODEX_API_KEY: "sk-codexSECRETvalue123", OPENCODE_API_KEY: "oc-LIVE-key-998877" };
  const out = redactSecrets("provider rejected key sk-codexSECRETvalue123 and oc-LIVE-key-998877", env);
  assert.doesNotMatch(out, /sk-codexSECRETvalue123/);
  assert.doesNotMatch(out, /oc-LIVE-key-998877/);
});

test("redacts raw API-key/secret assignments and known token shapes", () => {
  const out = redactSecrets("OPENCODE_API_KEY=oc_live_abcdef123456 set; pat github_pat_ABCdef0123456789", {});
  assert.doesNotMatch(out, /oc_live_abcdef123456/);
  assert.doesNotMatch(out, /github_pat_ABCdef0123456789/);
});

test("redactError accepts an injected env for secret values", () => {
  const out = redactError(new Error("codex exec exited 1: bad CODEX key superSecretCodex42"), { CODEX_API_KEY: "superSecretCodex42" });
  assert.doesNotMatch(out, /superSecretCodex42/);
});
