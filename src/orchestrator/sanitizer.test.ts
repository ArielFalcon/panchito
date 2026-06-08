import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeText, containsSecrets, SECRET_AUDIT, recordAudit } from "./sanitizer";

test("redacts secrets (api key, token)", () => {
  const { text: out } = sanitizeText("const apiKey = sk-abc123XYZ\ntoken: ghs_supersecretvalue");
  assert.match(out, /\[REDACTED_SECRET\]/);
  assert.doesNotMatch(out, /sk-abc123XYZ/);
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

test("redacts email (PII)", () => {
  const { text: out } = sanitizeText("user: ana.perez@company.com created the order");
  assert.match(out, /\[REDACTED_PII\]/);
  assert.doesNotMatch(out, /ana\.perez@company\.com/);
});

test("does not mangle normal code", () => {
  const code = "function sum(a, b) { return a + b; } // version 2";
  assert.equal(sanitizeText(code).text, code);
});

test("detection metadata — no secrets", () => {
  const { text, detection } = sanitizeText("hello world");
  assert.equal(text, "hello world");
  assert.equal(detection.redacted, false);
  assert.deepStrictEqual(detection.patterns, []);
  assert.equal(detection.count, 0);
});

test("detection metadata — with secrets", () => {
  const { text, detection } = sanitizeText("apiKey: sk-abc\ntoken: xyz");
  assert.ok(detection.redacted);
  assert.ok(detection.count >= 2);
  assert.ok(detection.patterns.includes("api-key-assignment"));
});

test("containsSecrets returns true on secret", () => {
  assert.equal(containsSecrets("apiKey: sk-abc123"), true);
});

test("containsSecrets returns false on clean text", () => {
  assert.equal(containsSecrets("function hello() { return 1; }"), false);
});

test("containsSecrets handles empty input", () => {
  assert.equal(containsSecrets(""), false);
});

test("sanitizeText handles empty input", () => {
  const { text, detection } = sanitizeText("");
  assert.equal(text, "");
  assert.equal(detection.redacted, false);
  assert.equal(detection.count, 0);
});

test("SECRET_AUDIT records redactions", () => {
  SECRET_AUDIT.clear();
  const { detection } = sanitizeText("apiKey: sk-123");
  recordAudit("run-1", detection);
  assert.equal(SECRET_AUDIT.get("run-1"), 1);
});

test("SECRET_AUDIT does not record zero redactions", () => {
  SECRET_AUDIT.clear();
  recordAudit("run-2", { redacted: false, patterns: [], count: 0 });
  assert.equal(SECRET_AUDIT.has("run-2"), false);
});

test("redacts Slack webhook URL", () => {
  const { text: out } = sanitizeText("webhook: https://hooks.slack.com/services/T00/B00/xyz123");
  assert.match(out, /\[REDACTED_SECRET\]/);
  assert.doesNotMatch(out, /hooks\.slack\.com/);
});

test("redacts Stripe key", () => {
  const { text: out } = sanitizeText("key: sk_test_fake000000000000000000000000");
  assert.match(out, /\[REDACTED_SECRET\]/);
  assert.doesNotMatch(out, /sk_test_/);
});

test("redacts API key in query string", () => {
  const { text: out } = sanitizeText("GET /?token=abc123&other=val");
  assert.match(out, /\[REDACTED_SECRET\]/);
  assert.doesNotMatch(out, /token=abc123/);
});

test("redacts generic credential", () => {
  const { text: out } = sanitizeText("credential: my-secret-value");
  assert.match(out, /\[REDACTED_SECRET\]/);
  assert.doesNotMatch(out, /my-secret-value/);
});

test("redacts base64 secret", () => {
  const long64 = "dGhpc2lzYXZlcnlsb25nYmFzZTY0c3RyaW5ndGhhdGNvdWxkYmVhc2VjcmV0";
  const { text: out } = sanitizeText(`data: ${long64}`);
  assert.match(out, /\[REDACTED_SECRET\]/);
  assert.doesNotMatch(out, new RegExp(long64));
});

test("preserves data URIs (not redacted as base64)", () => {
  const dataUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const { text: out } = sanitizeText(`before ${dataUri} after`);
  assert.match(out, /data:image\/png;base64,/);
  assert.doesNotMatch(out, /\[REDACTED_SECRET\].*after/);
});

test("redacts AWS access key", () => {
  const { text: out } = sanitizeText("AKIAIOSFODNN7EXAMPLE");
  assert.match(out, /\[REDACTED_SECRET\]/);
  assert.doesNotMatch(out, /AKIA/);
});

test("redacts GitHub token", () => {
  const { text: out } = sanitizeText("token: ghp_abcdefghijklmnopqrstuvwxyz1234567890AB");
  assert.match(out, /\[REDACTED_SECRET\]/);
  assert.doesNotMatch(out, /ghp_/);
});

test("redacts PEM private key", () => {
  const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3...
-----END RSA PRIVATE KEY-----`;
  const { text: out } = sanitizeText(pem);
  assert.match(out, /\[REDACTED_SECRET\]/);
  assert.doesNotMatch(out, /BEGIN RSA PRIVATE KEY/);
});

test("redacts env-var style credentials incl. the system's own DEV_*_PASS", () => {
  for (const secret of ["DEV_TEST_PASS=SuperSecret123!", "DEV_ENV_PASS: hunter2", "GITHUB_TOKEN=ghp_x", "OPENCODE_API_KEY=sk-abc"]) {
    const { text: out, detection } = sanitizeText(secret);
    assert.match(out, /\[REDACTED_SECRET\]/, `should redact: ${secret}`);
    assert.equal(detection.redacted, true);
    assert.equal(containsSecrets(secret), true);
  }
});

test("does NOT redact non-credential UPPER_SNAKE assignments (no false positive)", () => {
  for (const ok of ["MAX_BODY=1000000", "PORT=8080", "LOG_LEVEL=INFO", "DEPLOY_TIMEOUT_MS=600000"]) {
    assert.equal(containsSecrets(ok), false, `should NOT flag: ${ok}`);
  }
});

test("redacts credentials in JSON form (quoted keys with colon)", () => {
  for (const json of [
    `{"password": "hunter2plaintext"}`,
    `{"token": "abc123secretvalue"}`,
    `{"secret": "mysupersecret"}`,
    `{"apiKey": "plainsecret123"}`,
    `"password": "hunter2"`,
  ]) {
    const { detection } = sanitizeText(json);
    assert.equal(detection.redacted, true, `must redact: ${json}`);
  }
});
