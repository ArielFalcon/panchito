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

// WS5.5(c): the generator's existing-suite-manifest section renders ONLY filenames — dedup by
// filename alone invites duplicate flows as the suite grows, when the manifest ALREADY has flow/
// objective metadata on disk (e2e/.qa/manifest.json, written by ManifestRepositoryPort.reconcile()
// after every generation). existingSpecFiles is a plain string[] (its shape is pinned by the
// generation-ports-parity AssertNever key-drift gate against the legacy opencode-client.ts mirror,
// which this slice cannot touch) — so the manifest metadata is folded INTO each entry's string
// rather than added as a new field: "path — flow: X, objective: Y" when a manifest entry matches
// that file, plain "path" otherwise (no manifest, or no matching entry — never fabricated).
test("ground(): existingSpecFiles is enriched with flow/objective from e2e/.qa/manifest.json when present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-grounding-manifest-"));
  try {
    writeFileSync(join(dir, "checkout.spec.ts"), "// spec");
    mkdirSync(join(dir, ".qa"), { recursive: true });
    writeFileSync(
      join(dir, ".qa", "manifest.json"),
      JSON.stringify([
        { id: "checkout", file: "checkout.spec.ts", flow: "checkout", objective: "verify the discounted total after cart re-query" },
      ]),
    );
    const adapter = new PreGenerationGroundingPortAdapter(
      { e2eDir: dir },
      { buildContextPack: async () => ({ text: undefined, blastRadiusBytes: 0, domBytes: 0, contractBytes: 0 }) },
    );

    const result = await adapter.ground("/tmp/qa-golden/e2e");

    assert.deepEqual(result.existingSpecFiles, [
      "checkout.spec.ts — flow: checkout, objective: verify the discounted total after cart re-query",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ground(): existingSpecFiles stays a PLAIN filename when no manifest entry matches it (never fabricated)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-grounding-nomanifest-"));
  try {
    writeFileSync(join(dir, "orphan.spec.ts"), "// spec");
    mkdirSync(join(dir, ".qa"), { recursive: true });
    writeFileSync(
      join(dir, ".qa", "manifest.json"),
      JSON.stringify([{ id: "other", file: "unrelated.spec.ts", flow: "other-flow", objective: "unrelated objective" }]),
    );
    const adapter = new PreGenerationGroundingPortAdapter(
      { e2eDir: dir },
      { buildContextPack: async () => ({ text: undefined, blastRadiusBytes: 0, domBytes: 0, contractBytes: 0 }) },
    );

    const result = await adapter.ground("/tmp/qa-golden/e2e");

    assert.deepEqual(result.existingSpecFiles, ["orphan.spec.ts"]);
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

// ── WS5.3: deterministic `routes` feed (option c) — populated from contextMap.routes, no LLM ────
// The pack was structurally empty on every real run because candidateRoutes came ONLY from a brief,
// and the explorer pass (which would produce a brief) is unwired by design in production. This
// adapter is the composition seam that already carries contextMap (the context-mode LLM pass runs
// ONCE and persists context.json; every diff-mode run afterward reuses it deterministically, zero
// LLM cost at runtime) — so it is the correct place to derive buildContextPack's new `routes` input.
test("ground(): routes input is populated deterministically from contextMap.routes (no brief, no LLM)", async () => {
  const capturedInputs: unknown[] = [];
  const adapter = new PreGenerationGroundingPortAdapter(
    {
      e2eDir: "/mirrors/org/app/e2e",
      baseUrl: "https://dev.example.com",
      contextMap: {
        builtAtSha: "abc1234",
        routes: [{ path: "/checkout" }, { path: "/owners" }],
        api: [],
        feBe: [],
      },
    },
    {
      buildContextPack: async (input) => {
        capturedInputs.push(input);
        return { text: "## Context Pack\n\nsome content", blastRadiusBytes: 0, domBytes: 10, contractBytes: 0 };
      },
    },
  );

  await adapter.ground("/tmp/qa-golden/e2e");

  const captured = capturedInputs[0] as { routes?: string[] };
  assert.deepEqual(captured.routes?.sort(), ["/checkout", "/owners"].sort());
});

test("ground(): routes input is absent when contextMap has no routes (never fabricated)", async () => {
  const capturedInputs: unknown[] = [];
  const adapter = new PreGenerationGroundingPortAdapter(
    { e2eDir: "/mirrors/org/app/e2e" },
    {
      buildContextPack: async (input) => {
        capturedInputs.push(input);
        return { text: undefined, blastRadiusBytes: 0, domBytes: 0, contractBytes: 0 };
      },
    },
  );

  await adapter.ground("/tmp/qa-golden/e2e");

  const captured = capturedInputs[0] as { routes?: string[] };
  assert.equal(captured.routes, undefined, "no contextMap -> no routes -> nothing fabricated");
});

// ── sdd/migration-wiring-phase-2 Slice 3 (D-C contextMap read-back): ground(specDir, ...) now reads
// `${specDir}/.qa/context.json` per-run off the REAL mirror (specDir is the FIRST argument, the run's
// actual per-run workspace.specDir — see run-qa.use-case.ts's own call site), instead of relying
// solely on the static ctx.contextMap (which stays permanently absent in production per
// rewritten-engine-factory.ts's own documented gap). A per-run read takes priority over the static
// ctx value when present; a missing/invalid file degrades to the static ctx value (undefined in
// production), matching today's always-absent behavior — never a crash. ──────────────────────────

const VALID_CONTEXT_JSON = {
  builtAtSha: "abc1234",
  routes: [{ path: "/owners" }],
  api: [{ operationId: "getOwners", method: "GET", path: "/api/owners" }],
  feBe: [{ route: "/owners", operationId: "getOwners" }],
};

test("ground(): a committed valid e2e/.qa/context.json on the mirror populates contextMap from the per-run read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-grounding-context-valid-"));
  try {
    mkdirSync(join(dir, ".qa"), { recursive: true });
    writeFileSync(join(dir, ".qa", "context.json"), JSON.stringify(VALID_CONTEXT_JSON));
    const capturedInputs: unknown[] = [];
    const adapter = new PreGenerationGroundingPortAdapter(
      { e2eDir: dir },
      {
        buildContextPack: async (input) => {
          capturedInputs.push(input);
          return { text: undefined, blastRadiusBytes: 0, domBytes: 0, contractBytes: 0 };
        },
      },
    );

    await adapter.ground(dir);

    const captured = capturedInputs[0] as { contextMap?: unknown };
    assert.deepEqual(captured.contextMap, VALID_CONTEXT_JSON);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ground(): a per-run contextMap read overrides a stale static ctx.contextMap when both are present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-grounding-context-override-"));
  try {
    mkdirSync(join(dir, ".qa"), { recursive: true });
    writeFileSync(join(dir, ".qa", "context.json"), JSON.stringify(VALID_CONTEXT_JSON));
    const capturedInputs: unknown[] = [];
    const staleContextMap = { builtAtSha: "stale0000", routes: [], api: [], feBe: [] };
    const adapter = new PreGenerationGroundingPortAdapter(
      { e2eDir: dir, contextMap: staleContextMap },
      {
        buildContextPack: async (input) => {
          capturedInputs.push(input);
          return { text: undefined, blastRadiusBytes: 0, domBytes: 0, contractBytes: 0 };
        },
      },
    );

    await adapter.ground(dir);

    const captured = capturedInputs[0] as { contextMap?: { builtAtSha?: string } };
    assert.equal(captured.contextMap?.builtAtSha, "abc1234", "the real per-run read must win over a static/stale ctx value");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ground(): a missing e2e/.qa/context.json degrades to contextMap absent — identical to today's always-absent behavior, never a crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-grounding-context-missing-"));
  try {
    const capturedInputs: unknown[] = [];
    const adapter = new PreGenerationGroundingPortAdapter(
      { e2eDir: dir },
      {
        buildContextPack: async (input) => {
          capturedInputs.push(input);
          return { text: undefined, blastRadiusBytes: 0, domBytes: 0, contractBytes: 0 };
        },
      },
    );

    const result = await adapter.ground(dir);

    const captured = capturedInputs[0] as { contextMap?: unknown };
    assert.equal(captured.contextMap, undefined);
    assert.equal(result.contextPack, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ground(): an invalid e2e/.qa/context.json (dangling feBe link) degrades to contextMap absent, never throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-grounding-context-invalid-"));
  try {
    mkdirSync(join(dir, ".qa"), { recursive: true });
    writeFileSync(
      join(dir, ".qa", "context.json"),
      JSON.stringify({
        builtAtSha: "abc1234",
        routes: [{ path: "/owners" }],
        api: [],
        feBe: [{ route: "/owners", operationId: "ghost-op-not-declared-in-api" }],
      }),
    );
    const capturedInputs: unknown[] = [];
    const adapter = new PreGenerationGroundingPortAdapter(
      { e2eDir: dir },
      {
        buildContextPack: async (input) => {
          capturedInputs.push(input);
          return { text: undefined, blastRadiusBytes: 0, domBytes: 0, contractBytes: 0 };
        },
      },
    );

    await adapter.ground(dir);

    const captured = capturedInputs[0] as { contextMap?: unknown };
    assert.equal(captured.contextMap, undefined, "a dangling feBe link fails form-validation — degrade, never fabricate a half-valid map");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ground(): malformed JSON in e2e/.qa/context.json degrades to contextMap absent, never throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-grounding-context-malformed-"));
  try {
    mkdirSync(join(dir, ".qa"), { recursive: true });
    writeFileSync(join(dir, ".qa", "context.json"), "{ not valid json");
    const capturedInputs: unknown[] = [];
    const adapter = new PreGenerationGroundingPortAdapter(
      { e2eDir: dir },
      {
        buildContextPack: async (input) => {
          capturedInputs.push(input);
          return { text: undefined, blastRadiusBytes: 0, domBytes: 0, contractBytes: 0 };
        },
      },
    );

    await adapter.ground(dir);

    const captured = capturedInputs[0] as { contextMap?: unknown };
    assert.equal(captured.contextMap, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ground(): an injected loadContextMap collaborator overrides the real disk-read default (existence-level test seam)", async () => {
  const capturedInputs: unknown[] = [];
  const injected = { builtAtSha: "injected-sha", routes: [], api: [], feBe: [] };
  const adapter = new PreGenerationGroundingPortAdapter(
    { e2eDir: "/mirrors/org/app/e2e" },
    {
      loadContextMap: () => injected,
      buildContextPack: async (input) => {
        capturedInputs.push(input);
        return { text: undefined, blastRadiusBytes: 0, domBytes: 0, contractBytes: 0 };
      },
    },
  );

  await adapter.ground("/tmp/qa-golden/e2e");

  const captured = capturedInputs[0] as { contextMap?: { builtAtSha?: string } };
  assert.equal(captured.contextMap?.builtAtSha, "injected-sha");
});

test("ground(): a throwing loadContextMap collaborator is non-fatal — degrades to the static ctx value, never rejects", async () => {
  const capturedInputs: unknown[] = [];
  const adapter = new PreGenerationGroundingPortAdapter(
    { e2eDir: "/mirrors/org/app/e2e" },
    {
      loadContextMap: () => { throw new Error("disk read exploded"); },
      buildContextPack: async (input) => {
        capturedInputs.push(input);
        return { text: undefined, blastRadiusBytes: 0, domBytes: 0, contractBytes: 0 };
      },
    },
  );

  const result = await adapter.ground("/tmp/qa-golden/e2e");

  const captured = capturedInputs[0] as { contextMap?: unknown };
  assert.equal(captured.contextMap, undefined);
  assert.equal(result.contextPack, undefined);
});

// ── WS5.3: [CHANGED] markers from the classified diff ────────────────────────────────────────────
// The adapter's static context is built ONCE at composition time (before any run's diff is known),
// so the diff must be threaded through the ground() CALL itself — the use-case has classificationDiff
// in scope at the grounding call site (see run-qa.use-case.ts). changedElements is derived
// deterministically (DiffParserService.changedElements — pure, no I/O, no LLM) and forwarded to
// buildContextPack's own changedElements input (already wired to captureDomForRoutes's [CHANGED]
// annotation — see context-pack.test.ts's own coverage of that field).
test("ground(): a diff arg derives changedElements and forwards them to buildContextPack", async () => {
  const capturedInputs: unknown[] = [];
  const adapter = new PreGenerationGroundingPortAdapter(
    { e2eDir: "/mirrors/org/app/e2e", baseUrl: "https://dev.example.com" },
    {
      buildContextPack: async (input) => {
        capturedInputs.push(input);
        return { text: undefined, blastRadiusBytes: 0, domBytes: 0, contractBytes: 0 };
      },
    },
  );
  const diff = [
    "diff --git a/src/app/checkout.component.html b/src/app/checkout.component.html",
    "--- a/src/app/checkout.component.html",
    "+++ b/src/app/checkout.component.html",
    "@@ -1,1 +1,2 @@",
    '+<button data-testid="submit-order">Submit order</button>',
  ].join("\n");

  await adapter.ground("/tmp/qa-golden/e2e", undefined, diff);

  const captured = capturedInputs[0] as { changedElements?: Array<{ testId?: string }> };
  assert.ok(captured.changedElements?.some((e) => e.testId === "submit-order"), "the [CHANGED] signal must be derived from the diff and forwarded");
});

test("ground(): an absent diff arg leaves changedElements absent (byte-identical regression guard)", async () => {
  const capturedInputs: unknown[] = [];
  const adapter = new PreGenerationGroundingPortAdapter(
    { e2eDir: "/mirrors/org/app/e2e" },
    {
      buildContextPack: async (input) => {
        capturedInputs.push(input);
        return { text: undefined, blastRadiusBytes: 0, domBytes: 0, contractBytes: 0 };
      },
    },
  );

  await adapter.ground("/tmp/qa-golden/e2e");

  const captured = capturedInputs[0] as { changedElements?: unknown[] };
  assert.equal(captured.changedElements, undefined);
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

// ── ground(): AbortSignal plumbing (judgment-day, FIX 1) ─────────────────────────────────────────

test("ground(): an already-aborted signal skips capture entirely — resolves {} without calling buildContextPack", async () => {
  let called = false;
  const adapter = new PreGenerationGroundingPortAdapter(
    { e2eDir: "/mirrors/org/app/e2e" },
    { buildContextPack: async () => { called = true; return { text: "should not be reached", blastRadiusBytes: 0, domBytes: 0, contractBytes: 0 }; } },
  );
  const controller = new AbortController();
  controller.abort();

  const result = await adapter.ground("/tmp/qa-golden/e2e", controller.signal);

  assert.deepEqual(result, {});
  assert.equal(called, false);
});

test("ground(): an in-flight abort unblocks the caller promptly, even when buildContextPack never resolves", async () => {
  const adapter = new PreGenerationGroundingPortAdapter(
    { e2eDir: "/mirrors/org/app/e2e" },
    { buildContextPack: () => new Promise(() => {}) }, // never resolves — simulates a hung render
  );
  const controller = new AbortController();

  const groundPromise = adapter.ground("/tmp/qa-golden/e2e", controller.signal);
  queueMicrotask(() => controller.abort());
  const result = await groundPromise;

  // The adapter's own contract (never rejects) still holds — abort degrades to an empty result,
  // NOT a throw, so a caller without a signal?.aborted check after this call is not broken.
  assert.equal(result.contextPack, undefined);
});
