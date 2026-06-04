import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitize, sanitizeText } from "./sanitizer";

test("redacta secretos (api key, token)", () => {
  const out = sanitizeText("const apiKey = sk-abc123XYZ\ntoken: ghs_supersecretvalue");
  assert.match(out, /\[REDACTED_SECRET\]/);
  assert.doesNotMatch(out, /sk-abc123XYZ/);
});

test("redacta JWT", () => {
  const jwt = "eyJhbGciOi.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4";
  const out = sanitizeText(`Authorization: Bearer ${jwt}`);
  assert.doesNotMatch(out, /eyJhbGciOi/);
});

test("redacta IPs privadas", () => {
  const out = sanitizeText("host=10.0.3.14 y 192.168.1.1 y 172.16.5.5");
  assert.doesNotMatch(out, /10\.0\.3\.14/);
  assert.doesNotMatch(out, /192\.168\.1\.1/);
  assert.doesNotMatch(out, /172\.16\.5\.5/);
});

test("redacta email (PII)", () => {
  const out = sanitizeText("usuario: ana.perez@empresa.com creó la orden");
  assert.match(out, /\[REDACTED_PII\]/);
  assert.doesNotMatch(out, /ana\.perez@empresa\.com/);
});

test("no destroza código normal", () => {
  const code = "function suma(a, b) { return a + b; } // version 2";
  assert.equal(sanitizeText(code), code);
});

test("sanitize() limpia el diff del contexto", () => {
  const ctx = sanitize({
    source: "manual",
    task: "t",
    diff: "password=hunter2",
  });
  assert.doesNotMatch(ctx.diff ?? "", /hunter2/);
});

test("sanitize() sin diff es no-op", () => {
  const ctx = { source: "manual" as const, task: "t" };
  assert.deepEqual(sanitize(ctx), ctx);
});
