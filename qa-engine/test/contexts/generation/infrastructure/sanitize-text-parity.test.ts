// Parity test: assert the ported qa-engine sanitizeText matches the legacy src/orchestrator/
// sanitizer.ts sanitizeText byte-for-byte. This file imports from src/ (outside qa-engine rootDir)
// and is excluded from qa-engine typecheck (see qa-engine/tsconfig.json exclude list) — identical
// pattern to route-catalog-parity.test.ts / dom-snapshot-parity.test.ts (Plan 7.4a). Runs via tsx
// at runtime; the strangler guard keeping the port honest until Plan 7 cutover deletes the legacy
// original (Plan 7.4b).
import { test } from "node:test";
import assert from "node:assert/strict";

import { sanitizeText as ported } from "@contexts/generation/infrastructure/sanitize-text.ts";
import { sanitizeText as legacy } from "../../../../../src/orchestrator/sanitizer.ts";

test("PARITY: redacts a mixed secret + PII + private-IP line identically", () => {
  const input = "apiKey=sk-abc123XYZ host=10.0.3.14 email leaker@example.com token: ghs_supersecretvalue";
  assert.deepEqual(ported(input), legacy(input));
});

test("PARITY: DB connection string — password redacted, host preserved, identically", () => {
  const input = "DATABASE_URL=postgres://admin:s3cr3tP4ss@db.internal:5432/app";
  assert.deepEqual(ported(input), legacy(input));
});

test("PARITY: JWT redaction matches legacy", () => {
  const jwt = "eyJhbGciOi.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4";
  const input = `Authorization: Bearer ${jwt}`;
  assert.deepEqual(ported(input), legacy(input));
});

test("PARITY: data URI base64 preserved identically (no false-positive secret redaction)", () => {
  const input = `<img src="data:image/png;base64,${"A".repeat(200)}">`;
  assert.deepEqual(ported(input), legacy(input));
});

test("PARITY: credential-free URL passes through unchanged, identically", () => {
  const input = "fetch('https://api.example.com/v1/users?page=2')";
  assert.deepEqual(ported(input), legacy(input));
});

test("PARITY: empty string handled identically", () => {
  assert.deepEqual(ported(""), legacy(""));
});

test("PARITY: git SHA (pure hex) is not mistaken for a base64 secret, identically", () => {
  const input = `commit a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 landed`;
  assert.deepEqual(ported(input), legacy(input));
});

// WS5.4a — extend byte-parity to the "model" mode (both twins must apply the SAME narrowed
// api-key-assignment pattern; the two-tier policy exists as a mode flag on ONE shared pattern
// set, not a divergence between the ported and legacy modules).
test("PARITY: model mode — type annotation NOT redacted, identically in both twins", () => {
  const input = "password: string;";
  assert.deepEqual(ported(input, "model"), legacy(input, "model"));
});

test("PARITY: model mode — bare call expression NOT redacted, identically in both twins", () => {
  const input = "const token = getToken();";
  assert.deepEqual(ported(input, "model"), legacy(input, "model"));
});

test("PARITY: model mode — quoted literal STILL redacted, identically in both twins", () => {
  const input = 'const password = "hunter2";';
  assert.deepEqual(ported(input, "model"), legacy(input, "model"));
});

test("PARITY: issue mode (default) unchanged, identically in both twins", () => {
  const input = "password: string; token = getToken();";
  assert.deepEqual(ported(input), legacy(input));
  assert.deepEqual(ported(input, "issue"), legacy(input, "issue"));
});
