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
  setRuntimeRoleModels,
} from "@contexts/generation/infrastructure/prompt-builders/model-window-catalog.ts";

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

// ── D-4c-6 (migration-tier-4c Slice 5b): the split-brain fix ─────────────────────────────────
//
// BEFORE this fix: roleWindowBytes read agents/opencode.json EXCLUSIVELY for every role — even
// though the ACTUAL runtime model a role executes under is decided by AgentRuntimeConfig.assignments
// (src/agent-runtime/config.ts), which is env/dual-mode aware (AGENT_RUNTIME_MODE=dual,
// AGENT_REVIEWER_PROVIDER=codex, AGENT_REVIEWER_MODEL=gpt-5.5, etc.). In dual mode the reviewer can
// run on a COMPLETELY DIFFERENT provider/model than opencode.json declares (opencode.json only
// configures the OpenCode runtime's own roster) — so the prompt budget was computed against the
// WRONG model's context window whenever dual mode (or an env override) was active. Two independent
// sources of truth for "what model does this role run" = a split-brain.
//
// AFTER this fix: for the three VISIBLE roles with their own AgentRuntimeConfig assignment
// (qa-generator→primary, qa-reviewer→reviewer, qa-assistant→chat), roleWindowBytes resolves the
// model from the INJECTED runtime assignment FIRST (via setRuntimeRoleModels, wired by the shell from
// configFromEnv() at composition time) — opencode.json is consulted only as a disagreement check
// (warn, not override). Non-visible roles (qa-worker, qa-worker-code, qa-explorer, qa-maintainer,
// qa-reflector — none of which has its own AgentRuntimeConfig assignment; assignmentForRole aliases
// them to `primary`, which would be WRONG here since opencode.json genuinely assigns them a cheaper,
// different model) keep the pre-existing opencode.json-only resolution, UNCHANGED.

test("D-4c-6 BEFORE/AFTER: without the injected runtime assignment (not wired), roleWindowBytes falls back to opencode.json-only resolution — pre-fix behavior preserved", () => {
  setRuntimeRoleModels(undefined);
  const cfg = { agent: { "qa-reviewer": { model: "opencode-go/minimax-m3" } } };
  const cfgPath = writeTempConfig(cfg);
  assert.equal(roleWindowBytes("qa-reviewer", cfgPath), modelWindowBytes("minimax-m3"));
});

test("D-4c-6 AFTER (dual-mode reviewer): qa-reviewer resolves via the injected AgentRuntimeConfig.assignments.reviewer model, NOT opencode.json — closes the split-brain", () => {
  // Simulates dual mode: opencode.json still declares the OpenCode-only roster (minimax-m3), but the
  // REAL runtime assignment (what config.ts's configFromEnv() resolved, env/dual-mode aware) routed
  // the reviewer to gpt-5.5 (a Codex model, 128K window) — a completely different provider/model.
  const cfg = { agent: { "qa-reviewer": { model: "opencode-go/minimax-m3" } } };
  const cfgPath = writeTempConfig(cfg);
  setRuntimeRoleModels({ primary: "opencode-go/deepseek-v4-pro", reviewer: "gpt-5.5", chat: "opencode-go/deepseek-v4-flash" });
  try {
    const bytes = roleWindowBytes("qa-reviewer", cfgPath);
    assert.equal(bytes, modelWindowBytes("gpt-5.5"), "must resolve gpt-5.5's window (128K), not minimax-m3's (32K)");
    assert.notEqual(bytes, modelWindowBytes("minimax-m3"), "must NOT use opencode.json's declared model when a runtime assignment is injected");
  } finally {
    setRuntimeRoleModels(undefined);
  }
});

test("D-4c-6 AFTER (env-override): a different injected primary model changes qa-generator's budget accordingly", () => {
  const cfgPath = writeTempConfig({ agent: { "qa-generator": { model: "opencode-go/deepseek-v4-pro" } } });
  setRuntimeRoleModels({ primary: "gpt-5.4", reviewer: "gpt-5.5", chat: "gpt-5.4-mini" });
  try {
    assert.equal(roleWindowBytes("qa-generator", cfgPath), modelWindowBytes("gpt-5.4"));
  } finally {
    setRuntimeRoleModels(undefined);
  }
});

test("D-4c-6 AFTER: qa-assistant (chat role) resolves via the injected assignments.chat model", () => {
  const cfgPath = writeTempConfig({ agent: { "qa-assistant": { model: "opencode-go/deepseek-v4-flash" } } });
  setRuntimeRoleModels({ primary: "opencode-go/deepseek-v4-pro", reviewer: "opencode-go/minimax-m3", chat: "gpt-5.4-mini" });
  try {
    assert.equal(roleWindowBytes("qa-assistant", cfgPath), modelWindowBytes("gpt-5.4-mini"));
  } finally {
    setRuntimeRoleModels(undefined);
  }
});

test("D-4c-6 AFTER: non-visible worker roles (qa-worker) keep the opencode.json-only fallback even when a runtime assignment IS injected — never hijacked by assignments.primary", () => {
  // qa-worker has no AgentRuntimeConfig assignment of its own (assignmentForRole aliases it to
  // `primary`, which is WRONG for budget purposes — opencode.json genuinely assigns a cheaper,
  // different model to workers). The fix must NOT resolve qa-worker via the injected primary model.
  const cfgPath = writeTempConfig({ agent: { "qa-worker": { model: "opencode-go/deepseek-v4-flash" } } });
  setRuntimeRoleModels({ primary: "gpt-5.4", reviewer: "gpt-5.5", chat: "gpt-5.4-mini" });
  try {
    const bytes = roleWindowBytes("qa-worker", cfgPath);
    assert.equal(bytes, modelWindowBytes("deepseek-v4-flash"), "qa-worker must still resolve from opencode.json, not the injected primary model");
    assert.notEqual(bytes, modelWindowBytes("gpt-5.4"), "qa-worker must NOT be hijacked by assignments.primary");
  } finally {
    setRuntimeRoleModels(undefined);
  }
});

test("D-4c-6 AFTER: cross-source disagreement warns once (console.warn) without throwing, and the runtime assignment still wins", () => {
  const cfgPath = writeTempConfig({ agent: { "qa-reviewer": { model: "opencode-go/minimax-m3" } } });
  setRuntimeRoleModels({ primary: "opencode-go/deepseek-v4-pro", reviewer: "gpt-5.5", chat: "opencode-go/deepseek-v4-flash" });
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  try {
    const bytes = roleWindowBytes("qa-reviewer-disagreement-probe", cfgPath);
    void bytes; // role absent from cfg entirely — exercises the ordinary fallback warn, not the disagreement path
    const bytes2 = roleWindowBytes("qa-reviewer", cfgPath);
    assert.equal(bytes2, modelWindowBytes("gpt-5.5"));
    assert.ok(
      warnings.some((w) => /disagree|does not match|configures/i.test(w)),
      `expected a cross-source disagreement warning; got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    console.warn = originalWarn;
    setRuntimeRoleModels(undefined);
  }
});
