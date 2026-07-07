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

// WS5.4a — two-tier sanitizer policy twin (see src/orchestrator/sanitizer.test.ts's own header for
// the full rationale): "issue" (default) keeps the aggressive pattern; "model" narrows the
// api-key-assignment catch-all to quoted literals / high-entropy bare tokens only.
test("model mode: does NOT redact a type annotation shaped like a credential field", () => {
  const { text: out } = sanitizeText("password: string;", "model");
  assert.doesNotMatch(out, /REDACTED_SECRET/, "a type annotation carries no secret value");
  assert.match(out, /password: string;/);
});

test("model mode: does NOT redact a bare call expression assigned to a credential-named variable", () => {
  const { text: out } = sanitizeText("const token = getToken();", "model");
  assert.doesNotMatch(out, /REDACTED_SECRET/, "a call expression carries no literal secret value");
  assert.match(out, /getToken\(\)/);
});

test("model mode: STILL redacts a quoted string literal assigned to a credential field", () => {
  const { text: out } = sanitizeText('const password = "hunter2";', "model");
  assert.match(out, /REDACTED_SECRET/, "a quoted literal is the real secret shape and must still redact");
  assert.doesNotMatch(out, /hunter2/);
});

test("model mode: STILL redacts a high-entropy bare token value", () => {
  const { text: out } = sanitizeText("token = aZ9kP2mQ7xR4tL6vB8nH1cJ3s", "model");
  assert.match(out, /REDACTED_SECRET/, "a high-entropy bare token is still a real secret shape");
});

test("issue mode (default, unchanged): a type annotation is STILL redacted — aggressive public-surface policy", () => {
  const { text: out } = sanitizeText("password: string;");
  assert.match(out, /REDACTED_SECRET/, "the default (Issue-bound) mode keeps the aggressive pattern");
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

test("does NOT redact deep repo file paths as base64 secrets — a >=40-char run of letters+slashes IS a real Java package path (redacting it mangled diffs and the blast-radius signal into '[REDACTED_SECRET].java')", () => {
  const path = "src/main/java/es/name/restaurants/application/service/impl/CourseApplicationServiceImpl.java";
  const { text: out } = sanitizeText(`+++ b/${path}\n- \`createNewCourse\` (${path})`);
  assert.match(out, /CourseApplicationServiceImpl\.java/);
  assert.doesNotMatch(out, /\[REDACTED_SECRET\]/);
});

test("still redacts genuine long base64 secrets (with +/= chars, or with no path-shaped slashes)", () => {
  const withPlusEquals = "QWxhZGRpbjpvcGVuIHNlc2FtZQ+abcDEF0123456789ZZ==";
  const flatNoSlashes = "AbC0123456789dEfGhIjKlMnOpQrStUvWxYz0123456789AA";
  const { text: out } = sanitizeText(`${withPlusEquals}\n${flatNoSlashes}`);
  assert.doesNotMatch(out, /QWxhZGRpbjpvcGVu/);
  assert.doesNotMatch(out, /AbC0123456789dEf/);
  assert.match(out, /\[REDACTED_SECRET\]/);
});

test("does NOT redact long Java identifiers or paths with >30-char segments (both are code, not base64)", () => {
  const identifier = "populateCoursesDescriptionMultilingualUseCase";
  const longSegPath = "src/main/java/es/name/restaurants/application/service/template/CourseSearcherAlgorithmTemplate.java";
  const { text: out } = sanitizeText(`- \`${identifier}\` (${longSegPath})`);
  assert.match(out, /populateCoursesDescriptionMultilingualUseCase/);
  assert.match(out, /CourseSearcherAlgorithmTemplate\.java/);
  assert.doesNotMatch(out, /\[REDACTED_SECRET\]/);
});

// JD FIX 2 (twin of src/orchestrator/sanitizer.test.ts — keep in lockstep): isPathLikeRun's
// no-slash escape was ANY pure-letter run — too loose. Tighten to a real identifier shape
// (camelCase/PascalCase with a case transition) capped at 64 chars.
test("JD-FIX2: a camelCase identifier (45 chars, no digits) still survives — escape stays intact", () => {
  const identifier = "populateCoursesDescriptionMultilingualUseCase";
  assert.equal(identifier.length, 45);
  const { text: out } = sanitizeText(`- \`${identifier}\``);
  assert.match(out, /populateCoursesDescriptionMultilingualUseCase/);
  assert.doesNotMatch(out, /\[REDACTED_SECRET\]/);
});

test("JD-FIX2: a 45-char ALL-LOWERCASE alpha run (no case transition) IS redacted, not code-shaped", () => {
  const blob = "qwertyuiopasdfghjklzxcvbnmqwertyuiopasdfghjkl";
  assert.equal(blob.length, 45);
  const { text: out } = sanitizeText(`token blob: ${blob}`);
  assert.doesNotMatch(out, new RegExp(blob));
  assert.match(out, /\[REDACTED_SECRET\]/);
});

test("JD-FIX2: a 70-char camelCase-shaped run (>64 chars) IS redacted — length cap wins over shape", () => {
  const blob = "aB".repeat(35); // 70 chars, alternating case, no digits
  assert.equal(blob.length, 70);
  const { text: out } = sanitizeText(`value=${blob}`);
  assert.doesNotMatch(out, new RegExp(blob));
  assert.match(out, /\[REDACTED_SECRET\]/);
});

test("JD-R2: a PERFECT 2-char case-alternation blob (the deterministic adversarial shape) IS redacted — the identifier escape requires at least one word-segment >= 3 chars", () => {
  const alternating = "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOp"; // 42 chars, every segment exactly 2
  const { text: out } = sanitizeText(alternating);
  assert.doesNotMatch(out, /AbCdEfGhIjKl/);
  assert.match(out, /\[REDACTED_SECRET\]/);
  // and the real identifier (segments populate/Courses/... >= 3) still survives:
  const identifier = "populateCoursesDescriptionMultilingualUseCase";
  assert.equal(sanitizeText(identifier).text, identifier);
});
