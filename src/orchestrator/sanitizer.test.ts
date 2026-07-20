import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeText, containsSecrets, assertNoSecretLeak, SecretLeakError, SECRET_AUDIT, recordAudit, capText, MAX_PROMPT_BODY_CHARS, RedactionPortAdapter } from "./sanitizer";

test("redacts secrets (api key, token)", () => {
  const { text: out } = sanitizeText("const apiKey = sk-abc123XYZ\ntoken: ghs_supersecretvalue");
  assert.match(out, /\[REDACTED\]/);
  assert.doesNotMatch(out, /sk-abc123XYZ/);
});

// WS5.4a — two-tier sanitizer policy: the "issue" mode (default, aggressive) is the Issue-bound
// public surface; "model" mode is the diff→model path, where the SAME api-key-assignment catch-all
// was redacting code shapes that carry no secret at all (a type annotation, a bare call expression).
// Testing the change SITE, not the constant redaction of a real secret (already covered above).
test("model mode: does NOT redact a type annotation shaped like a credential field", () => {
  const { text: out } = sanitizeText("password: string;", "model");
  assert.doesNotMatch(out, /REDACTED/, "a type annotation carries no secret value");
  assert.match(out, /password: string;/);
});

test("model mode: does NOT redact a bare call expression assigned to a credential-named variable", () => {
  const { text: out } = sanitizeText("const token = getToken();", "model");
  assert.doesNotMatch(out, /REDACTED/, "a call expression carries no literal secret value");
  assert.match(out, /getToken\(\)/);
});

test("model mode: STILL redacts a quoted string literal assigned to a credential field", () => {
  const { text: out } = sanitizeText('const password = "hunter2";', "model");
  assert.match(out, /REDACTED/, "a quoted literal is the real secret shape and must still redact");
  assert.doesNotMatch(out, /hunter2/);
});

test("model mode: STILL redacts a high-entropy bare token value", () => {
  const { text: out } = sanitizeText("token = aZ9kP2mQ7xR4tL6vB8nH1cJ3s", "model");
  assert.match(out, /REDACTED/, "a high-entropy bare token is still a real secret shape");
});

test("issue mode (default, unchanged): a type annotation is STILL redacted — aggressive public-surface policy", () => {
  const { text: out } = sanitizeText("password: string;");
  assert.match(out, /REDACTED/, "the default (Issue-bound) mode keeps the aggressive pattern");
});

test("issue mode (explicit): identical to default — aggressive public-surface policy", () => {
  const withDefault = sanitizeText("token = getToken();");
  const withExplicit = sanitizeText("token = getToken();", "issue");
  assert.deepEqual(withExplicit, withDefault);
});

// judgment-day round 3 (FIX F.1, Judge B): the api-key-assignment/generic-credential/env-credential/
// bearer-token patterns all end their value capture in a bare `\S+` — a run of NON-WHITESPACE chars,
// with no boundary at a quote. When the matched value is immediately followed by a closing quote
// that belongs to the SURROUNDING prose (not the secret's own value), `\S+` greedily swallows that
// quote too, and the whole match (quote included) is replaced with "[REDACTED]" — corrupting the
// line by leaving an unbalanced opening quote. Reproduces Judge B's exact probe: a reviewer's
// selectorContradiction line quoting a UI element's accessible name. Kept in lockstep with this
// file's qa-engine twin (sanitize-text.ts) — see sanitize-text-parity.test.ts.
test("BUGFIX: a secret-shaped match immediately followed by a closing quote does not swallow that quote (Judge B's exact probe)", () => {
  const input = "role:name 'button' with name \"Token: refresh\" is NOT in the captured tree";
  const { text: out } = sanitizeText(input, "issue");
  assert.match(out, /\[REDACTED\]/, "the secret-shaped value must still be redacted");
  assert.match(
    out,
    /"\[REDACTED\]" is NOT in the captured tree/,
    `the closing quote around the redacted value must survive — got: ${JSON.stringify(out)}`,
  );
});

test("BUGFIX: generic-credential does not swallow a trailing closing quote either", () => {
  const input = 'the log says "credential: abc123" was rejected';
  const { text: out } = sanitizeText(input, "issue");
  assert.match(out, /\[REDACTED\]/);
  assert.match(out, /"\[REDACTED\]" was rejected/, `got: ${JSON.stringify(out)}`);
});

test("BUGFIX: env-credential does not swallow a trailing closing quote either", () => {
  const input = 'the config had "GITHUB_TOKEN: abc123" set';
  const { text: out } = sanitizeText(input, "issue");
  assert.match(out, /\[REDACTED\]/);
  assert.match(out, /"\[REDACTED\]" set/, `got: ${JSON.stringify(out)}`);
});

test("BUGFIX: bearer-token does not swallow a trailing closing quote either", () => {
  const input = 'header dump: "Authorization: Bearer abc123xyz" logged';
  const { text: out } = sanitizeText(input, "issue");
  assert.match(out, /\[REDACTED\]/);
  assert.match(out, /"\[REDACTED\]" logged/, `got: ${JSON.stringify(out)}`);
});

// judgment-day round 4 (FIX I, Judge A): round 3's quote-aware value capture
// (`(?:"[^"]*"|'[^']*'|[^\s"']+)`) fixed the round-2 quote-swallow bug but introduced a REAL leak —
// the bare branch now STOPS at the first quote INSIDE the value, leaving the tail unredacted. These
// three cases are Judge A's exact adversarial probes, replayed through the real pipeline. Kept in
// lockstep with this file's qa-engine twin (sanitize-text.ts) — see sanitize-text-parity.test.ts.
test("BUGFIX (round 4): a secret value with an embedded quote does not leak its tail", () => {
  const input = 'token=abc"def';
  const { text: out } = sanitizeText(input, "issue");
  assert.doesNotMatch(out, /def/, `the tail after the embedded quote must not leak — got: ${JSON.stringify(out)}`);
  assert.match(out, /\[REDACTED\]/);
});

test("BUGFIX (round 4): GITHUB_TOKEN with an embedded quote does not leak its tail", () => {
  const input = 'GITHUB_TOKEN=ghp_abc"XYZ123';
  const { text: out } = sanitizeText(input, "issue");
  assert.doesNotMatch(out, /XYZ123/, `the tail after the embedded quote must not leak — got: ${JSON.stringify(out)}`);
  assert.match(out, /\[REDACTED\]/);
});

test("BUGFIX (round 4): a prose keyword false-match does not let a quoted secret with an escaped inner quote ship unredacted", () => {
  const input = 'leaked secret: password="mySecretPass\\"WithQuote" end';
  const { text: out } = sanitizeText(input, "issue");
  assert.doesNotMatch(out, /mySecretPass/, `got: ${JSON.stringify(out)}`);
  assert.doesNotMatch(out, /WithQuote/, `got: ${JSON.stringify(out)}`);
  assert.match(out, /\[REDACTED\]/);
  assert.match(out, / end$/, `the trailing prose after the secret must survive — got: ${JSON.stringify(out)}`);
});

// judgment-day round 3 (FIX F.2, both judges): DOCUMENTED KNOWN LIMITATION, not a bug — `password:
// hunter2` and `Token: refresh` are the SAME "word: value" shape; no regex can distinguish a real
// secret from a secret-shaped UI label (Judge A independently confirmed the over-redact tradeoff is
// correctly reasoned; the safe direction is intentionally kept). This test documents the false
// positive explicitly instead of implying the mechanism can tell them apart.
test("KNOWN LIMITATION: a secret-shaped UI label (\"Token: refresh\") is redacted exactly like a real secret — this mechanism cannot distinguish the two, by design (over-redaction is the safe direction, not a claim of accuracy)", () => {
  const { text: out } = sanitizeText('button label reads "Token: refresh"', "issue");
  assert.match(out, /\[REDACTED\]/, "a secret-shaped label is redacted even though it is not a real secret");
  assert.doesNotMatch(out, /refresh/, "the false positive is real: the non-secret value is gone too");
});

// ── sdd/migration-wiring-phase-2 Slice 6a (AMENDMENT 1, mode-aware containsSecrets) ──────────────
// As shipped, containsSecrets() never consulted modelSkip at all — every call behaved like "issue"
// mode, re-flagging text sanitizeText(text,"model") had deliberately left untouched. This is the
// EXACT false positive that would have thrown SecretLeakError on any diff touching ordinary
// auth-shaped code once the Slice 6b guard is wired — this repo's own src/server/auth.ts carries
// these shapes and this repo runs code-mode QA on itself. The regression fixtures below mirror
// auth.ts's real signatures verbatim (function sign(data: string, secret: string): string,
// issueSession(username: string, secret: string, ttlSeconds: number, ...), validateSession(token:
// string, secret: string, now = Date.now())).
test("containsSecrets: model mode does NOT flag auth.ts-shaped type annotations after model-mode redaction (regression, the guard's own safety gate)", () => {
  const authShapes = [
    "function sign(data: string, secret: string): string {",
    "export function issueSession(username: string, secret: string, ttlSeconds: number, now = Date.now()): string {",
    "export function validateSession(token: string, secret: string, now = Date.now()): string | null {",
  ].join("\n");
  const redacted = sanitizeText(authShapes, "model").text;
  assert.equal(
    containsSecrets(redacted, "model"),
    false,
    "a type annotation carries no secret value — model mode must not flag it (this would have thrown SecretLeakError on this repo's own auth.ts)",
  );
});

test("containsSecrets: model mode does NOT flag a bare call expression assigned to a credential-named variable", () => {
  const redacted = sanitizeText("const token = getToken();", "model").text;
  assert.equal(containsSecrets(redacted, "model"), false, "a call expression carries no literal secret value");
});

test("containsSecrets: model mode STILL flags a quoted string literal assigned to a credential field", () => {
  assert.equal(
    containsSecrets('const password = "hunter2";', "model"),
    true,
    "a quoted literal is the real secret shape and model mode must still flag it (never redacted -> guard must fire)",
  );
});

test("containsSecrets: model mode STILL flags a high-entropy bare token value", () => {
  assert.equal(containsSecrets("token = aZ9kP2mQ7xR4tL6vB8nH1cJ3s", "model"), true, "a high-entropy bare token is still a real secret shape");
});

test("containsSecrets: issue mode (default) is byte-identical to pre-AMENDMENT-1 behavior — still flags a type annotation", () => {
  assert.equal(containsSecrets("password: string;"), true, "issue mode (default) must keep the existing aggressive behavior unchanged");
  assert.equal(containsSecrets("password: string;", "issue"), true, "issue mode (explicit) identical to default");
});

test("containsSecrets: issue mode never regresses on a genuine secret (byte-identical existing behavior)", () => {
  assert.equal(containsSecrets("const apiKey = sk-abc123XYZsecretvalue"), true);
});

test("containsSecrets: false-positive tolerance — a git SHA covered by the base64-secret skip predicate never trips, in either mode", () => {
  const sha = "a".repeat(40); // pure-hex run, the base64-secret pattern's own `skip` predicate
  assert.equal(containsSecrets(sha), false, "issue mode must not flag a git SHA");
  assert.equal(containsSecrets(sha, "model"), false, "model mode must not flag a git SHA either");
});

// ── sdd/migration-wiring-phase-2 Slice 6b — the post-redaction fail-loud guard ────────────────────
// assertNoSecretLeak is the shared enforcement primitive both egress boundaries build on (diff→model
// directly; logs→Issue via its own local mirror in publication-port.adapter.ts, which cannot import
// this module — see SecretLeakError's own doc). Testing it directly proves the THROW mechanism
// itself: sanitizeText/containsSecrets already share one pattern table with identical skip/modelSkip
// logic, so a secret genuinely surviving THIS module's own redaction is not constructible today — the
// guard exists as an invariant check against a FUTURE regression (a pattern added to one function but
// not the other), and this is the test that would catch it.
test("assertNoSecretLeak: throws SecretLeakError when the text still contains a detectable secret", () => {
  assert.throws(
    () => assertNoSecretLeak('const apiKey = "sk-live-abc123XYZsecretvalue"', "issue", "diff→model"),
    SecretLeakError,
  );
});

test("assertNoSecretLeak: the thrown error names the boundary (greppable, never a generic message)", () => {
  try {
    assertNoSecretLeak('const apiKey = "sk-live-abc123XYZsecretvalue"', "issue", "diff→model");
    assert.fail("expected assertNoSecretLeak to throw");
  } catch (err) {
    assert.ok(err instanceof SecretLeakError);
    assert.match((err as Error).message, /diff→model/);
  }
});

test("assertNoSecretLeak: does NOT throw when the text is already clean (fully redacted diffs/logs pass through)", () => {
  assert.doesNotThrow(() => assertNoSecretLeak(sanitizeText("const apiKey = sk-abc123XYZsecretvalue", "model").text, "model", "diff→model"));
});

test("assertNoSecretLeak: does NOT throw on an auth.ts-shaped diff in model mode (the guard's own false-positive gate)", () => {
  const redacted = sanitizeText("password: string;\ntoken: string;", "model").text;
  assert.doesNotThrow(() => assertNoSecretLeak(redacted, "model", "diff→model"));
});

test("capText passes short prose through unchanged", () => {
  assert.equal(capText("a short commit body", MAX_PROMPT_BODY_CHARS), "a short commit body");
});

test("capText caps long prose with a visible truncation marker and keeps the head", () => {
  const long = "x".repeat(5000);
  const out = capText(long, 4000);
  assert.ok(out.length < long.length, "capped output is shorter than the input");
  assert.match(out, /body truncated/);
  assert.ok(out.startsWith("x".repeat(4000)), "the first maxChars are preserved");
});

test("redacts a bare LLM provider key (sk-...) with no adjacent keyword", () => {
  const key = "sk-proj-abcDEF0123456789ghijKLMNopqrstuvWX";
  const { text: out } = sanitizeText(`const k = "${key}"; // committed by mistake`);
  assert.doesNotMatch(out, /sk-proj-/);
  assert.match(out, /\[REDACTED\]/);
});

test("redacts a bare Slack token (xoxb-...)", () => {
  const { text: out } = sanitizeText("notify('xoxb-1234567890-ABCDEFghijkl')");
  assert.doesNotMatch(out, /xoxb-1234567890/);
  assert.match(out, /\[REDACTED\]/);
});

test("redacts the password in a DB connection string but keeps the host", () => {
  const { text: out } = sanitizeText("DATABASE_URL=postgres://admin:s3cr3tP4ss@db.internal:5432/app");
  assert.doesNotMatch(out, /s3cr3tP4ss/);
  assert.match(out, /\[REDACTED\]/);
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

test("redacts email (PII)", () => {
  const { text: out } = sanitizeText("user: ana.perez@company.com created the order");
  assert.match(out, /\[REDACTED\]/);
  assert.doesNotMatch(out, /ana\.perez@company\.com/);
});

test("does not mangle npm/yarn lockfile integrity hashes (sha512-<base64>)", () => {
  const line = '"integrity": "sha512-Vd1njGZNqVKbpZ3HsKv2DiQGfx7Yz3mXk0pq9rStUvWxYzAbCdEfGh=="';
  const { text } = sanitizeText(line);
  assert.match(text, /sha512-Vd1njGZNqVKbpZ3HsKv2DiQGfx7Yz3mXk0pq9rStUvWxYzAbCdEfGh==/);
  assert.doesNotMatch(text, /REDACTED/);
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

test("containsSecrets is stable across repeated calls (no global-regex lastIndex flip)", () => {
  const s = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789";
  // A shared /g regex's lastIndex would make repeated .test() alternate true/false and
  // silently miss the secret every other call. The detector must be deterministic.
  for (let i = 0; i < 6; i++) assert.equal(containsSecrets(s), true, `call ${i} flipped`);
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
  assert.match(out, /\[REDACTED\]/);
  assert.doesNotMatch(out, /hooks\.slack\.com/);
});

test("redacts Stripe key", () => {
  const { text: out } = sanitizeText("key: sk_test_fake000000000000000000000000");
  assert.match(out, /\[REDACTED\]/);
  assert.doesNotMatch(out, /sk_test_/);
});

test("redacts API key in query string", () => {
  const { text: out } = sanitizeText("GET /?token=abc123&other=val");
  assert.match(out, /\[REDACTED\]/);
  assert.doesNotMatch(out, /token=abc123/);
});

test("redacts generic credential", () => {
  const { text: out } = sanitizeText("credential: my-secret-value");
  assert.match(out, /\[REDACTED\]/);
  assert.doesNotMatch(out, /my-secret-value/);
});

test("redacts base64 secret", () => {
  const long64 = "dGhpc2lzYXZlcnlsb25nYmFzZTY0c3RyaW5ndGhhdGNvdWxkYmVhc2VjcmV0";
  const { text: out } = sanitizeText(`data: ${long64}`);
  assert.match(out, /\[REDACTED\]/);
  assert.doesNotMatch(out, new RegExp(long64));
});

test("does NOT redact a git SHA / hex digest as a base64 secret", () => {
  // A 40-char lowercase hex commit SHA matched the base64 pattern and became "[REDACT"
  // in the run header. Hex runs are commit ids / lockfile digests, not secrets.
  const sha = "9f6edf0a1b2c3d4e5f60718293a4b5c6d7e8f901";
  const { text: out, detection } = sanitizeText(`sha ${sha} done`);
  assert.match(out, new RegExp(sha), "the SHA must survive sanitization");
  assert.doesNotMatch(out, /\[REDACTED\]/);
  assert.equal(detection.redacted, false);
  assert.equal(containsSecrets(sha), false);
  // A 64-char hex digest (sha256) is likewise not a secret.
  const sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  assert.doesNotMatch(sanitizeText(sha256).text, /\[REDACTED\]/);
});

test("preserves data URIs (not redacted as base64)", () => {
  const dataUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const { text: out } = sanitizeText(`before ${dataUri} after`);
  assert.match(out, /data:image\/png;base64,/);
  assert.doesNotMatch(out, /\[REDACTED\].*after/);
});

test("redacts AWS access key", () => {
  const { text: out } = sanitizeText("AKIAIOSFODNN7EXAMPLE");
  assert.match(out, /\[REDACTED\]/);
  assert.doesNotMatch(out, /AKIA/);
});

test("redacts GitHub token", () => {
  const { text: out } = sanitizeText("token: ghp_abcdefghijklmnopqrstuvwxyz1234567890AB");
  assert.match(out, /\[REDACTED\]/);
  assert.doesNotMatch(out, /ghp_/);
});

test("redacts PEM private key", () => {
  const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3...
-----END RSA PRIVATE KEY-----`;
  const { text: out } = sanitizeText(pem);
  assert.match(out, /\[REDACTED\]/);
  assert.doesNotMatch(out, /BEGIN RSA PRIVATE KEY/);
});

test("redacts env-var style credentials incl. the system's own DEV_*_PASS", () => {
  for (const secret of ["DEV_TEST_PASS=SuperSecret123!", "DEV_ENV_PASS: hunter2", "GITHUB_TOKEN=ghp_x", "OPENCODE_API_KEY=sk-abc"]) {
    const { text: out, detection } = sanitizeText(secret);
    assert.match(out, /\[REDACTED\]/, `should redact: ${secret}`);
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

// Slice G's capDiff relevance-ordering tests were DELETED here (migration-tier-4d Slice 4,
// residual iii) — capDiff itself was deleted from this module (zero remaining production callers;
// the real, wired capper lives in qa-engine's prompt-cap.ts with its own independent test suite,
// qa-engine/test/contexts/generation/infrastructure/prompt-cap.test.ts).

test("does NOT redact deep repo file paths as base64 secrets — a >=40-char run of letters+slashes IS a real Java package path (redacting it mangled diffs sent to the model into '[REDACTED].java')", () => {
  const path = "src/main/java/es/name/restaurants/application/service/impl/CourseApplicationServiceImpl.java";
  const { text: out } = sanitizeText(`+++ b/${path}\n- \`createNewCourse\` (${path})`);
  assert.match(out, /CourseApplicationServiceImpl\.java/);
  assert.doesNotMatch(out, /\[REDACTED\]/);
});

test("still redacts genuine long base64 secrets (with +/= chars, or with no path-shaped slashes)", () => {
  const withPlusEquals = "QWxhZGRpbjpvcGVuIHNlc2FtZQ+abcDEF0123456789ZZ==";
  const flatNoSlashes = "AbC0123456789dEfGhIjKlMnOpQrStUvWxYz0123456789AA";
  const { text: out } = sanitizeText(`${withPlusEquals}\n${flatNoSlashes}`);
  assert.doesNotMatch(out, /QWxhZGRpbjpvcGVu/);
  assert.doesNotMatch(out, /AbC0123456789dEf/);
  assert.match(out, /\[REDACTED\]/);
});

test("does NOT redact long Java identifiers or paths with >30-char segments (both are code, not base64)", () => {
  const identifier = "populateCoursesDescriptionMultilingualUseCase";
  const longSegPath = "src/main/java/es/name/restaurants/application/service/template/CourseSearcherAlgorithmTemplate.java";
  const { text: out } = sanitizeText(`- \`${identifier}\` (${longSegPath})`);
  assert.match(out, /populateCoursesDescriptionMultilingualUseCase/);
  assert.match(out, /CourseSearcherAlgorithmTemplate\.java/);
  assert.doesNotMatch(out, /\[REDACTED\]/);
});

// JD FIX 2: isPathLikeRun's no-slash escape was ANY pure-letter run — too loose, it let an
// attacker-shaped 40+ char alpha blob (no digits, no slashes) escape redaction entirely. Tighten
// to a REAL identifier shape (camelCase/PascalCase with a case transition) capped at 64 chars.
test("JD-FIX2: a camelCase identifier (45 chars, no digits) still survives — escape stays intact", () => {
  const identifier = "populateCoursesDescriptionMultilingualUseCase";
  assert.equal(identifier.length, 45);
  const { text: out } = sanitizeText(`- \`${identifier}\``);
  assert.match(out, /populateCoursesDescriptionMultilingualUseCase/);
  assert.doesNotMatch(out, /\[REDACTED\]/);
});

test("JD-FIX2: a 45-char ALL-LOWERCASE alpha run (no case transition) IS redacted, not code-shaped", () => {
  const blob = "qwertyuiopasdfghjklzxcvbnmqwertyuiopasdfghjkl";
  assert.equal(blob.length, 45);
  const { text: out } = sanitizeText(`token blob: ${blob}`);
  assert.doesNotMatch(out, new RegExp(blob));
  assert.match(out, /\[REDACTED\]/);
});

test("JD-FIX2: a 70-char camelCase-shaped run (>64 chars) IS redacted — length cap wins over shape", () => {
  const blob = "aB".repeat(35); // 70 chars, alternating case, no digits
  assert.equal(blob.length, 70);
  const { text: out } = sanitizeText(`value=${blob}`);
  assert.doesNotMatch(out, new RegExp(blob));
  assert.match(out, /\[REDACTED\]/);
});

test("JD-R2: a PERFECT 2-char case-alternation blob (the deterministic adversarial shape) IS redacted — the identifier escape requires at least one word-segment >= 3 chars", () => {
  const alternating = "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOp"; // 42 chars, every segment exactly 2
  const { text: out } = sanitizeText(alternating);
  assert.doesNotMatch(out, /AbCdEfGhIjKl/);
  assert.match(out, /\[REDACTED\]/);
  // and the real identifier (segments populate/Courses/... >= 3) still survives:
  const identifier = "populateCoursesDescriptionMultilingualUseCase";
  assert.equal(sanitizeText(identifier).text, identifier);
});

// sdd/migration-wiring-phase-2 Slice 7a (D-D a, env-value GAIN): RedactionPortAdapter must detect a
// secret VALUE present verbatim in text, driven by env VAR NAME heuristics (parity with
// src/util/redact.ts's secretValues/redactSecrets — the oracle this slice ports), even when no
// NAMED_SECRET_PATTERNS entry recognizes the value's shape. Fixtures below are values pattern-based
// sanitizeText alone genuinely misses (verified live: "oc-LIVE-key-998877" matches no
// NAMED_SECRET_PATTERNS entry at all; "superSecretCodex42" is a 19-char bare token, one short of the
// llm-api-key pattern's 20-char minimum) — the exact gap 7a closes, not a redundant assertion.
test("RedactionPortAdapter.redact detects an env-value secret patterns alone would miss (no NAMED_SECRET_PATTERNS match)", () => {
  const env = { OPENCODE_API_KEY: "oc-LIVE-key-998877" };
  const adapter = new RedactionPortAdapter(env);
  // Baseline: pattern-only sanitizeText genuinely misses this shape (proves the fixture is real).
  assert.match(sanitizeText("provider rejected key oc-LIVE-key-998877").text, /oc-LIVE-key-998877/);
  const out = adapter.redact("provider rejected key oc-LIVE-key-998877");
  assert.doesNotMatch(out, /oc-LIVE-key-998877/);
  assert.match(out, /\[REDACTED\]/);
});

test("RedactionPortAdapter.redact detects a second env-value gap fixture (bare token below the llm-api-key pattern's length floor)", () => {
  const env = { CODEX_API_KEY: "superSecretCodex42" };
  const adapter = new RedactionPortAdapter(env);
  assert.match(sanitizeText("codex exec exited 1: bad CODEX key superSecretCodex42").text, /superSecretCodex42/);
  const out = adapter.redact("codex exec exited 1: bad CODEX key superSecretCodex42");
  assert.doesNotMatch(out, /superSecretCodex42/);
  assert.match(out, /\[REDACTED\]/);
});

test("RedactionPortAdapter.redact applies env-value AND pattern-based detection together (both mechanisms coexist, no class lost)", () => {
  const env = { OPENCODE_API_KEY: "oc-LIVE-key-998877" };
  const adapter = new RedactionPortAdapter(env);
  const out = adapter.redact("env leak oc-LIVE-key-998877 alongside a pattern hit token=ghs_supersecretvalue");
  assert.doesNotMatch(out, /oc-LIVE-key-998877/);
  assert.doesNotMatch(out, /ghs_supersecretvalue/);
  assert.match(out, /\[REDACTED\]/);
});

test("RedactionPortAdapter.redact ignores env values shorter than the 6-char floor (parity with redact.ts's MIN_SECRET_LEN)", () => {
  const env = { SHORT_TOKEN: "abcde" }; // 5 chars, below the floor
  const adapter = new RedactionPortAdapter(env);
  const out = adapter.redact("value is abcde here");
  assert.match(out, /abcde/); // untouched — too short to treat as a real secret value
});

test("RedactionPortAdapter.redact ignores env vars whose NAME does not look like a secret (no false positive)", () => {
  const env = { APP_NAME: "not-a-secret-value" };
  const adapter = new RedactionPortAdapter(env);
  const out = adapter.redact("app is called not-a-secret-value");
  assert.match(out, /not-a-secret-value/);
});

test("RedactionPortAdapter() with no injected env defaults to process.env (real shell consumers stay covered)", () => {
  const key = "PANCHITO_TEST_ENV_ADAPTER_TOKEN";
  const value = "processEnvDefaultSecretABC123";
  process.env[key] = value;
  try {
    const adapter = new RedactionPortAdapter();
    const out = adapter.redact(`leaked ${value} in output`);
    assert.doesNotMatch(out, new RegExp(value));
  } finally {
    delete process.env[key];
  }
});

test("RedactionPortAdapter.redactText is a shell-consumer alias for redact (env+pattern)", () => {
  const env = { OPENCODE_API_KEY: "oc-LIVE-key-998877" };
  const adapter = new RedactionPortAdapter(env);
  const out = adapter.redactText("leak oc-LIVE-key-998877 here");
  assert.doesNotMatch(out, /oc-LIVE-key-998877/);
  assert.match(out, /\[REDACTED\]/);
});

test("RedactionPortAdapter.redactError unwraps an Error instance through env+pattern redaction", () => {
  const env = { CODEX_API_KEY: "superSecretCodex42" };
  const adapter = new RedactionPortAdapter(env);
  const out = adapter.redactError(new Error("codex exec exited 1: bad CODEX key superSecretCodex42"));
  assert.doesNotMatch(out, /superSecretCodex42/);
  assert.match(out, /\[REDACTED\]/);
});

test("RedactionPortAdapter.redactError stringifies a non-Error thrown value", () => {
  const adapter = new RedactionPortAdapter({});
  const out = adapter.redactError("plain string failure");
  assert.equal(out, "plain string failure");
});
