// Behavioral test for sanitize-text.ts — ported subset of src/orchestrator/sanitizer.test.ts
// scoped to sanitizeText ONLY (capDiff/capText already have a real, ported home in prompt-cap.ts;
// containsSecrets/SECRET_AUDIT/recordAudit are diagnostic-only and not consumed by context-pack.ts,
// so they are out of scope for this narrow port — see sanitize-text.ts header for the full rationale).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeText } from "@contexts/generation/infrastructure/sanitize-text.ts";

test("redacts secrets (api key, token)", () => {
  const { text: out } = sanitizeText("const apiKey = sk-abc123XYZ\ntoken: ghs_supersecretvalue");
  assert.match(out, /\[REDACTED_SECRET\]/);
  assert.doesNotMatch(out, /sk-abc123XYZ/);
});

test("redacts a bare LLM provider key (sk-...) with no adjacent keyword", () => {
  const key = "sk-proj-abcDEF0123456789ghijKLMNopqrstuvWX";
  const { text: out } = sanitizeText(`const k = "${key}"; // committed by mistake`);
  assert.doesNotMatch(out, /sk-proj-/);
  assert.match(out, /\[REDACTED_SECRET\]/);
});

test("redacts a bare Slack token (xoxb-...)", () => {
  const { text: out } = sanitizeText("notify('xoxb-1234567890-ABCDEFghijkl')");
  assert.doesNotMatch(out, /xoxb-1234567890/);
  assert.match(out, /\[REDACTED_SECRET\]/);
});

test("redacts the password in a DB connection string but keeps the host", () => {
  const { text: out } = sanitizeText("DATABASE_URL=postgres://admin:s3cr3tP4ss@db.internal:5432/app");
  assert.doesNotMatch(out, /s3cr3tP4ss/);
  assert.match(out, /\[REDACTED_SECRET\]/);
  assert.match(out, /db\.internal/); // host left readable
});

test("does not mangle a credential-free URL (no user:pass@)", () => {
  const code = "fetch('https://api.example.com/v1/users?page=2')";
  assert.equal(sanitizeText(code).text, code);
});

test("redacts JWT", () => {
  const jwt = "eyJhbGciOi.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4";
  const { text: out } = sanitizeText(`Authorization: Bearer ${jwt}`);
  assert.doesNotMatch(out, /eyJhbGciOi/);
});

test("redacts private IPs", () => {
  const { text: out } = sanitizeText("host=10.0.3.14 and 192.168.1.1 and 172.16.5.5");
  assert.doesNotMatch(out, /10\.0\.3\.14/);
  assert.doesNotMatch(out, /192\.168\.1\.1/);
  assert.doesNotMatch(out, /172\.16\.5\.5/);
});

test("empty input returns empty output with no redaction", () => {
  const result = sanitizeText("");
  assert.equal(result.text, "");
  assert.equal(result.detection.redacted, false);
  assert.deepEqual(result.detection.patterns, []);
  assert.equal(result.detection.count, 0);
});

test("redacts email as PII", () => {
  const { text: out } = sanitizeText("contact us at leaker@example.com for details");
  assert.doesNotMatch(out, /leaker@example\.com/);
  assert.match(out, /\[REDACTED_PII\]/);
});

test("preserves a data URI base64 payload (not treated as a leaked secret)", () => {
  const dataUri = "data:image/png;base64," + "A".repeat(200);
  const { text: out } = sanitizeText(`<img src="${dataUri}">`);
  assert.match(out, /data:image\/png;base64,/);
});
