// Colocated tests for the model-window catalog (Slice F / Phase 2).
// Covers: catalog lookup with known models, fallback for unknown roles/models,
// the ≈4 chars/token (BYTES_PER_TOKEN) approximation, safety margin application,
// normalizeModelName prefix stripping, and roleWindowBytes with a mock config.

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  BYTES_PER_TOKEN,
  INPUT_PROMPT_SAFETY_MARGIN,
  DEFAULT_WINDOW_TOKENS,
  modelWindowBytes,
  normalizeModelName,
  roleWindowBytes,
} from "./model-window-catalog";

// ── BYTES_PER_TOKEN approximation ────────────────────────────────────────────

test("catalog: BYTES_PER_TOKEN is 4 (the documented ≈4 chars/token approximation)", () => {
  assert.equal(BYTES_PER_TOKEN, 4);
});

test("catalog: INPUT_PROMPT_SAFETY_MARGIN is between 0 and 1 (exclusive)", () => {
  assert.ok(INPUT_PROMPT_SAFETY_MARGIN > 0, "safety margin must be positive");
  assert.ok(INPUT_PROMPT_SAFETY_MARGIN < 1, "safety margin must be < 1 (reserves headroom)");
});

test("catalog: DEFAULT_WINDOW_TOKENS is positive and conservatively set", () => {
  assert.ok(DEFAULT_WINDOW_TOKENS > 0, "default window must be positive");
  assert.ok(DEFAULT_WINDOW_TOKENS <= 64_000, "default window must be conservative (≤ 64K tokens)");
});

// ── modelWindowBytes ─────────────────────────────────────────────────────────

test("catalog: modelWindowBytes applies BYTES_PER_TOKEN and safety margin", () => {
  // For any known model, the result = floor(windowTokens × margin × bytesPerToken).
  // We just test the formula holds for known models by deriving the expected value
  // from the catalog's published window (exposed indirectly via the calculation).
  const bytes = modelWindowBytes("kimi-k2.7-code");
  // The catalog sets 64_000 tokens for kimi-k2.7-code.
  const expected = Math.floor(64_000 * INPUT_PROMPT_SAFETY_MARGIN * BYTES_PER_TOKEN);
  assert.equal(bytes, expected, "kimi-k2.7-code budget must equal floor(64000 × margin × 4)");
  // Must be expressible as bytes, not tokens (i.e. >> 64_000).
  assert.ok(bytes > 64_000, "byte budget must be larger than token count");
});

test("catalog: modelWindowBytes uses DEFAULT_WINDOW_TOKENS for unknown model", () => {
  const bytes = modelWindowBytes("__nonexistent_model__");
  const expected = Math.floor(DEFAULT_WINDOW_TOKENS * INPUT_PROMPT_SAFETY_MARGIN * BYTES_PER_TOKEN);
  assert.equal(bytes, expected, "unknown model must fall back to DEFAULT_WINDOW_TOKENS");
});

test("catalog: modelWindowBytes returns a positive number for all roster models", () => {
  const rosterModels = ["kimi-k2.7-code", "minimax-m3", "deepseek-v4-flash"];
  for (const model of rosterModels) {
    const bytes = modelWindowBytes(model);
    assert.ok(bytes > 0, `${model} budget must be positive`);
  }
});

test("catalog: known models produce differing byte budgets reflecting their relative window sizes", () => {
  // kimi-k2.7-code has 64K tokens; minimax-m3 has 32K.
  const kimiBytes = modelWindowBytes("kimi-k2.7-code");
  const minimaxBytes = modelWindowBytes("minimax-m3");
  assert.ok(
    kimiBytes > minimaxBytes,
    `kimi-k2.7-code (${kimiBytes} bytes) must have a larger budget than minimax-m3 (${minimaxBytes} bytes)`,
  );
});

// ── normalizeModelName ────────────────────────────────────────────────────────

test("catalog: normalizeModelName strips the 'opencode-go/' prefix", () => {
  assert.equal(normalizeModelName("opencode-go/kimi-k2.7-code"), "kimi-k2.7-code");
  assert.equal(normalizeModelName("opencode-go/minimax-m3"), "minimax-m3");
  assert.equal(normalizeModelName("opencode-go/deepseek-v4-flash"), "deepseek-v4-flash");
});

test("catalog: normalizeModelName passes through names without the prefix unchanged", () => {
  assert.equal(normalizeModelName("kimi-k2.7-code"), "kimi-k2.7-code");
  assert.equal(normalizeModelName("minimax-m3"), "minimax-m3");
  assert.equal(normalizeModelName("some-other-provider/model"), "some-other-provider/model");
});

// ── roleWindowBytes with mock config ─────────────────────────────────────────

function writeTempConfig(content: object): string {
  const dir = join(tmpdir(), `catalog-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "opencode.json");
  writeFileSync(p, JSON.stringify(content), "utf8");
  return p;
}

test("catalog: roleWindowBytes resolves budget from agents/opencode.json for a known role", () => {
  const cfg = {
    agent: {
      "qa-generator": { model: "opencode-go/kimi-k2.7-code" },
    },
  };
  const cfgPath = writeTempConfig(cfg);
  const bytes = roleWindowBytes("qa-generator", cfgPath);
  const expected = modelWindowBytes("kimi-k2.7-code");
  assert.equal(bytes, expected, "qa-generator budget must match kimi-k2.7-code catalog entry");
});

test("catalog: roleWindowBytes returns fallback for a role absent from config", () => {
  const cfg = { agent: { "qa-generator": { model: "opencode-go/kimi-k2.7-code" } } };
  const cfgPath = writeTempConfig(cfg);
  const bytes = roleWindowBytes("qa-nonexistent-role", cfgPath);
  const fallbackBytes = Math.floor(DEFAULT_WINDOW_TOKENS * INPUT_PROMPT_SAFETY_MARGIN * BYTES_PER_TOKEN);
  assert.equal(bytes, fallbackBytes, "absent role must return the DEFAULT_WINDOW_TOKENS fallback");
});

test("catalog: roleWindowBytes returns fallback when config file does not exist", () => {
  const bytes = roleWindowBytes("qa-generator", "/nonexistent/path/opencode.json");
  const fallbackBytes = Math.floor(DEFAULT_WINDOW_TOKENS * INPUT_PROMPT_SAFETY_MARGIN * BYTES_PER_TOKEN);
  assert.equal(bytes, fallbackBytes, "missing config file must return the DEFAULT_WINDOW_TOKENS fallback");
});

test("catalog: roleWindowBytes returns fallback for role with no model field", () => {
  const cfg = { agent: { "qa-generator": { description: "no model field here" } } };
  const cfgPath = writeTempConfig(cfg);
  const bytes = roleWindowBytes("qa-generator", cfgPath);
  const fallbackBytes = Math.floor(DEFAULT_WINDOW_TOKENS * INPUT_PROMPT_SAFETY_MARGIN * BYTES_PER_TOKEN);
  assert.equal(bytes, fallbackBytes, "role with no model field must return the DEFAULT_WINDOW_TOKENS fallback");
});

test("catalog: roleWindowBytes returns fallback for unparseable config", () => {
  const dir = join(tmpdir(), `catalog-bad-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "opencode.json");
  writeFileSync(p, "{ NOT VALID JSON }", "utf8");
  const bytes = roleWindowBytes("qa-generator", p);
  const fallbackBytes = Math.floor(DEFAULT_WINDOW_TOKENS * INPUT_PROMPT_SAFETY_MARGIN * BYTES_PER_TOKEN);
  assert.equal(bytes, fallbackBytes, "unparseable config must return the DEFAULT_WINDOW_TOKENS fallback");
});

// ── T-P2-4: Codex model catalog entries (AC2.4.1-2) ──────────────────────────
// gpt-5.4 and gpt-5.4-mini must NOT fall through to the 32K default.

test("catalog: gpt-5.4 has a dedicated catalog entry and does NOT fall back to DEFAULT (AC2.4.1)", () => {
  const bytes = modelWindowBytes("gpt-5.4");
  const fallbackBytes = Math.floor(DEFAULT_WINDOW_TOKENS * INPUT_PROMPT_SAFETY_MARGIN * BYTES_PER_TOKEN);
  assert.notEqual(
    bytes,
    fallbackBytes,
    `gpt-5.4 must have a dedicated catalog entry, not the 32K default. Got ${bytes} bytes (default would be ${fallbackBytes})`,
  );
  // Must be materially larger than the default (it's a large frontier model).
  assert.ok(
    bytes > fallbackBytes,
    `gpt-5.4 context window must exceed the 32K fallback. Got: ${bytes} bytes`,
  );
});

test("catalog: gpt-5.4-mini has a dedicated catalog entry and does NOT fall back to DEFAULT (AC2.4.1)", () => {
  const bytes = modelWindowBytes("gpt-5.4-mini");
  const fallbackBytes = Math.floor(DEFAULT_WINDOW_TOKENS * INPUT_PROMPT_SAFETY_MARGIN * BYTES_PER_TOKEN);
  assert.notEqual(
    bytes,
    fallbackBytes,
    `gpt-5.4-mini must have a dedicated catalog entry, not the 32K default. Got ${bytes} bytes (default would be ${fallbackBytes})`,
  );
  assert.ok(
    bytes > fallbackBytes,
    `gpt-5.4-mini context window must exceed the 32K fallback. Got: ${bytes} bytes`,
  );
});

test("catalog: unknown model id still falls back to DEFAULT_WINDOW_TOKENS (AC2.4.2 regression)", () => {
  // The codex entries must not break the existing fallback contract for unknown models.
  const unknownBytes = modelWindowBytes("__unknown_codex_model__");
  const fallbackBytes = Math.floor(DEFAULT_WINDOW_TOKENS * INPUT_PROMPT_SAFETY_MARGIN * BYTES_PER_TOKEN);
  assert.equal(
    unknownBytes,
    fallbackBytes,
    "unknown model must still fall back to DEFAULT_WINDOW_TOKENS",
  );
});

test("catalog: roleWindowBytes resolves correctly for all roster roles via a full config mock", () => {
  const cfg = {
    agent: {
      "qa-generator":   { model: "opencode-go/kimi-k2.7-code" },
      "qa-maintainer":  { model: "opencode-go/kimi-k2.7-code" },
      "qa-reviewer":    { model: "opencode-go/minimax-m3" },
      "qa-worker":      { model: "opencode-go/deepseek-v4-flash" },
      "qa-worker-code": { model: "opencode-go/deepseek-v4-flash" },
      "qa-explorer":    { model: "opencode-go/deepseek-v4-flash" },
      "qa-reflector":   { model: "opencode-go/deepseek-v4-flash" },
      "qa-assistant":   { model: "opencode-go/deepseek-v4-flash" },
    },
  };
  const cfgPath = writeTempConfig(cfg);

  // Generator uses kimi-k2.7-code → same budget as that model.
  assert.equal(roleWindowBytes("qa-generator", cfgPath), modelWindowBytes("kimi-k2.7-code"));
  // Reviewer uses minimax-m3 → smaller budget.
  assert.equal(roleWindowBytes("qa-reviewer", cfgPath), modelWindowBytes("minimax-m3"));
  // Workers use deepseek-v4-flash → smallest budget.
  assert.equal(roleWindowBytes("qa-worker", cfgPath), modelWindowBytes("deepseek-v4-flash"));
  // Reviewer budget must be < generator budget (different window sizes).
  assert.ok(
    roleWindowBytes("qa-reviewer", cfgPath) <= roleWindowBytes("qa-generator", cfgPath),
    "reviewer budget must not exceed generator budget",
  );
});
