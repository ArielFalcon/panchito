// test/contexts/qa-run-orchestration/infrastructure/bridges/pre-generation-grounding-port.adapter.test.ts
// Plan 7-R W4 (audit CRITICAL): PreGenerationGroundingPortAdapter wraps the REAL buildContextPack
// (generation/infrastructure/context-pack.ts, already-ported) + a filesystem enumeration of the
// suite's existing spec files (a faithful port of legacy's globSpecs closure, src/pipeline.ts:1852-
// 1866). Existence-level: buildContextPack is injected as a fake here (no real Playwright/browser) —
// context-pack.ts's own test suite already covers its internal behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PreGenerationGroundingPortAdapter,
  enumerateExistingSpecFiles,
} from "@contexts/qa-run-orchestration/infrastructure/bridges/pre-generation-grounding-port.adapter.ts";

// ── enumerateExistingSpecFiles: a faithful port of legacy's globSpecs (pure fs, real tmpdir) ────

test("enumerateExistingSpecFiles: finds *.spec.ts files recursively, relative to the given dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-grounding-"));
  try {
    mkdirSync(join(dir, "flows"), { recursive: true });
    writeFileSync(join(dir, "flows", "checkout.spec.ts"), "// spec");
    writeFileSync(join(dir, "home.spec.ts"), "// spec");
    writeFileSync(join(dir, "helper.ts"), "// not a spec");

    const found = enumerateExistingSpecFiles(dir).sort();

    assert.deepEqual(found, ["flows/checkout.spec.ts", "home.spec.ts"].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enumerateExistingSpecFiles: a missing directory yields [] (graceful, never throws)", () => {
  const found = enumerateExistingSpecFiles("/nonexistent/path/for/sure/qa-grounding-test");
  assert.deepEqual(found, []);
});

test("enumerateExistingSpecFiles: an empty directory yields []", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-grounding-empty-"));
  try {
    assert.deepEqual(enumerateExistingSpecFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── PreGenerationGroundingPortAdapter.ground() ───────────────────────────────────────────────────

test("ground(): existingSpecFiles is populated from the real filesystem enumeration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-grounding-adapter-"));
  try {
    writeFileSync(join(dir, "existing.spec.ts"), "// spec");
    const adapter = new PreGenerationGroundingPortAdapter(
      { e2eDir: dir },
      { buildContextPack: async () => ({ text: undefined, blastRadiusBytes: 0, domBytes: 0, contractBytes: 0 }) },
    );

    const result = await adapter.ground("/tmp/qa-golden/e2e");

    assert.deepEqual(result.existingSpecFiles, ["existing.spec.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ground(): an empty e2eDir omits existingSpecFiles entirely (never a fabricated empty marker)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-grounding-empty2-"));
  try {
    const adapter = new PreGenerationGroundingPortAdapter(
      { e2eDir: dir },
      { buildContextPack: async () => ({ text: undefined, blastRadiusBytes: 0, domBytes: 0, contractBytes: 0 }) },
    );

    const result = await adapter.ground("/tmp/qa-golden/e2e");

    assert.equal(result.existingSpecFiles, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ground(): contextPack is populated from the injected buildContextPack result", async () => {
  const capturedInputs: unknown[] = [];
  const adapter = new PreGenerationGroundingPortAdapter(
    { e2eDir: "/mirrors/org/app/e2e", baseUrl: "https://dev.example.com", testIdAttribute: "data-cy" },
    {
      buildContextPack: async (input) => {
        capturedInputs.push(input);
        return { text: "## Context Pack\n\nsome content", blastRadiusBytes: 0, domBytes: 10, contractBytes: 0 };
      },
    },
  );

  const result = await adapter.ground("/tmp/qa-golden/e2e");

  assert.equal(result.contextPack, "## Context Pack\n\nsome content");
  assert.equal(capturedInputs.length, 1);
  assert.equal((capturedInputs[0] as { baseUrl?: string }).baseUrl, "https://dev.example.com");
  assert.equal((capturedInputs[0] as { testIdAttribute?: string }).testIdAttribute, "data-cy");
});

test("ground(): buildContextPack returning an empty pack (text: undefined) omits contextPack", async () => {
  const adapter = new PreGenerationGroundingPortAdapter(
    { e2eDir: "/mirrors/org/app/e2e" },
    { buildContextPack: async () => ({ text: undefined, blastRadiusBytes: 0, domBytes: 0, contractBytes: 0 }) },
  );

  const result = await adapter.ground("/tmp/qa-golden/e2e");

  assert.equal(result.contextPack, undefined);
});

test("ground(): a buildContextPack throw is non-fatal — ground() resolves with contextPack absent, never rejects", async () => {
  const adapter = new PreGenerationGroundingPortAdapter(
    { e2eDir: "/mirrors/org/app/e2e" },
    { buildContextPack: async () => { throw new Error("Playwright render crashed"); } },
  );

  const result = await adapter.ground("/tmp/qa-golden/e2e");

  assert.equal(result.contextPack, undefined);
});

test("ground(): existingSpecFiles enumeration failure is non-fatal — contextPack is still built", async () => {
  // e2eDir points at a path that cannot be read as a directory at all (a file, not a dir) — the
  // enumeration's own try/catch degrades to [] without throwing, and the pack build still runs.
  const dir = mkdtempSync(join(tmpdir(), "qa-grounding-file-"));
  const filePath = join(dir, "not-a-dir");
  writeFileSync(filePath, "not a directory");
  try {
    const adapter = new PreGenerationGroundingPortAdapter(
      { e2eDir: filePath },
      { buildContextPack: async () => ({ text: "## Context Pack\n\nok", blastRadiusBytes: 0, domBytes: 0, contractBytes: 0 }) },
    );

    const result = await adapter.ground("/tmp/qa-golden/e2e");

    assert.equal(result.existingSpecFiles, undefined);
    assert.equal(result.contextPack, "## Context Pack\n\nok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ground(): both existingSpecFiles enumeration and context-pack build failing resolves an EMPTY GroundingResult, never throws", async () => {
  const adapter = new PreGenerationGroundingPortAdapter(
    { e2eDir: "/nonexistent/path/for/sure/qa-grounding-test" },
    { buildContextPack: async () => { throw new Error("boom"); } },
  );

  const result = await adapter.ground("/tmp/qa-golden/e2e");

  assert.deepEqual(result, {});
});
