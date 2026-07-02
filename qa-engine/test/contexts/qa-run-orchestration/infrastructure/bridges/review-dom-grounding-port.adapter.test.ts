// test/contexts/qa-run-orchestration/infrastructure/bridges/review-dom-grounding-port.adapter.test.ts
// Plan 7-R W4 (audit CRITICAL): ReviewDomGroundingPortAdapter wraps the REAL captureDom
// (generation/infrastructure/dom-snapshot.ts, already-ported), mirroring legacy's reviewGenerated()
// captureDom call exactly (src/pipeline.ts:1643-1651). Existence-level: captureDom is injected as a
// fake here (no real Playwright/browser) — dom-snapshot.ts's own test suite already covers its
// internal render/format behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewDomGroundingPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/review-dom-grounding-port.adapter.ts";

test("capture(): reads each spec's on-disk content and forwards it to captureDom", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-review-dom-"));
  try {
    mkdirSync(join(dir, "flows"), { recursive: true });
    writeFileSync(join(dir, "flows", "checkout.spec.ts"), `await page.goto("/checkout");`);

    const capturedInputs: unknown[] = [];
    const adapter = new ReviewDomGroundingPortAdapter(
      { e2eDir: "/mirrors/org/app/e2e", baseUrl: "https://dev.example.com", testIdAttribute: "data-cy" },
      {
        captureDom: async (input) => {
          capturedInputs.push(input);
          return "route /checkout:\n  heading: Checkout";
        },
      },
    );

    const result = await adapter.capture(dir, ["flows/checkout.spec.ts"]);

    assert.equal(result, "route /checkout:\n  heading: Checkout");
    assert.equal(capturedInputs.length, 1);
    const input = capturedInputs[0] as { specContents: string[]; baseUrl: string; testIdAttribute?: string };
    assert.deepEqual(input.specContents, [`await page.goto("/checkout");`]);
    assert.equal(input.baseUrl, "https://dev.example.com");
    assert.equal(input.testIdAttribute, "data-cy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capture(): an unreadable spec file contributes an empty string, never throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-review-dom-missing-"));
  try {
    const capturedInputs: unknown[] = [];
    const adapter = new ReviewDomGroundingPortAdapter(
      { e2eDir: "/mirrors/org/app/e2e", baseUrl: "https://dev.example.com" },
      {
        captureDom: async (input) => {
          capturedInputs.push(input);
          return undefined;
        },
      },
    );

    const result = await adapter.capture(dir, ["missing.spec.ts"]);

    assert.equal(result, undefined);
    const input = capturedInputs[0] as { specContents: string[] };
    assert.deepEqual(input.specContents, [""]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capture(): absent baseUrl short-circuits to undefined without calling captureDom", async () => {
  let called = false;
  const adapter = new ReviewDomGroundingPortAdapter(
    { e2eDir: "/mirrors/org/app/e2e" },
    { captureDom: async () => { called = true; return "should not be reached"; } },
  );

  const result = await adapter.capture("/tmp/qa-golden/e2e", ["a.spec.ts"]);

  assert.equal(result, undefined);
  assert.equal(called, false);
});

test("capture(): an empty specs list short-circuits to undefined without calling captureDom", async () => {
  let called = false;
  const adapter = new ReviewDomGroundingPortAdapter(
    { e2eDir: "/mirrors/org/app/e2e", baseUrl: "https://dev.example.com" },
    { captureDom: async () => { called = true; return "should not be reached"; } },
  );

  const result = await adapter.capture("/tmp/qa-golden/e2e", []);

  assert.equal(result, undefined);
  assert.equal(called, false);
});

test("capture(): a captureDom throw is non-fatal — resolves undefined, never rejects (mirrors legacy's .catch(() => undefined))", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-review-dom-throw-"));
  try {
    writeFileSync(join(dir, "a.spec.ts"), `await page.goto("/x");`);
    const adapter = new ReviewDomGroundingPortAdapter(
      { e2eDir: "/mirrors/org/app/e2e", baseUrl: "https://dev.example.com" },
      { captureDom: async () => { throw new Error("Playwright render crashed"); } },
    );

    const result = await adapter.capture(dir, ["a.spec.ts"]);

    assert.equal(result, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── capture(): AbortSignal plumbing (judgment-day, FIX 1) ────────────────────────────────────────

test("capture(): an already-aborted signal skips the capture entirely — resolves undefined without calling captureDom", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-review-dom-abort-precheck-"));
  try {
    writeFileSync(join(dir, "a.spec.ts"), `await page.goto("/x");`);
    let called = false;
    const adapter = new ReviewDomGroundingPortAdapter(
      { e2eDir: "/mirrors/org/app/e2e", baseUrl: "https://dev.example.com" },
      { captureDom: async () => { called = true; return "should not be reached"; } },
    );
    const controller = new AbortController();
    controller.abort();

    const result = await adapter.capture(dir, ["a.spec.ts"], controller.signal);

    assert.equal(result, undefined);
    assert.equal(called, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capture(): an in-flight abort unblocks the caller promptly, even when captureDom never resolves", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-review-dom-abort-inflight-"));
  try {
    writeFileSync(join(dir, "a.spec.ts"), `await page.goto("/x");`);
    const adapter = new ReviewDomGroundingPortAdapter(
      { e2eDir: "/mirrors/org/app/e2e", baseUrl: "https://dev.example.com" },
      { captureDom: () => new Promise(() => {}) }, // never resolves — simulates a hung render
    );
    const controller = new AbortController();

    const capturePromise = adapter.capture(dir, ["a.spec.ts"], controller.signal);
    queueMicrotask(() => controller.abort());
    const result = await capturePromise;

    // The adapter's own contract (never rejects) still holds — abort degrades to undefined, NOT a
    // throw, so a caller without a signal?.aborted check after this call is not broken.
    assert.equal(result, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
