import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultAgentRuntimeConfig,
  configFromEnv,
  validateAgentRuntimeConfig,
  publicAgentConfig,
} from "./config";

test("defaultAgentRuntimeConfig prefers single/opencode when OPENCODE_API_KEY exists", () => {
  const cfg = defaultAgentRuntimeConfig({ OPENCODE_API_KEY: "opencode-go-key", CODEX_API_KEY: "codex-key" });
  assert.equal(cfg.mode, "single");
  assert.equal(cfg.singleProvider, "opencode");
  assert.equal(cfg.assignments.primary.provider, "opencode");
});

test("defaultAgentRuntimeConfig falls back to single/codex when only CODEX_API_KEY exists", () => {
  const cfg = defaultAgentRuntimeConfig({ CODEX_API_KEY: "codex-key" });
  assert.equal(cfg.mode, "single");
  assert.equal(cfg.singleProvider, "codex");
  assert.equal(cfg.assignments.primary.provider, "codex");
});

test("single mode only requires the selected provider key", () => {
  const cfg = defaultAgentRuntimeConfig({ CODEX_API_KEY: "codex-key" });
  const result = validateAgentRuntimeConfig(cfg, { codex: true, opencode: false });
  assert.equal(result.ok, true);
});

test("dual mode requires both provider keys and at least two visible providers", () => {
  const cfg = {
    ...defaultAgentRuntimeConfig({ OPENCODE_API_KEY: "opencode-go-key", CODEX_API_KEY: "codex-key" }),
    mode: "dual" as const,
    assignments: {
      primary: { provider: "opencode" as const, model: "opencode-go/deepseek-v4-pro" },
      reviewer: { provider: "codex" as const, model: "gpt-5.4" },
      chat: { provider: "codex" as const, model: "gpt-5.4-mini" },
    },
  };
  assert.equal(validateAgentRuntimeConfig(cfg, { opencode: true, codex: true }).ok, true);
  assert.match(validateAgentRuntimeConfig(cfg, { opencode: true, codex: false }).errors.join("\n"), /CODEX_API_KEY/);
});

test("dual mode: reviewer defaults to the primary's COMPLEMENT, not a hardcoded codex (CFG-04)", () => {
  const keys = { OPENCODE_API_KEY: "ok", CODEX_API_KEY: "ck" };
  // primary=codex with no explicit reviewer provider → reviewer must be opencode (independent
  // judgment), NOT codex again (the old hardcoded fallback collapsed both roles onto codex).
  const codexPrimary = configFromEnv({ ...keys, AGENT_RUNTIME_MODE: "dual", AGENT_SINGLE_PROVIDER: "codex" });
  assert.equal(codexPrimary.assignments.primary.provider, "codex");
  assert.equal(codexPrimary.assignments.reviewer.provider, "opencode");
  // symmetric case still holds: primary=opencode → reviewer defaults to codex
  const opencodePrimary = configFromEnv({ ...keys, AGENT_RUNTIME_MODE: "dual", AGENT_SINGLE_PROVIDER: "opencode" });
  assert.equal(opencodePrimary.assignments.reviewer.provider, "codex");
  // an explicit reviewer provider always wins over the complement default
  const explicit = configFromEnv({ ...keys, AGENT_RUNTIME_MODE: "dual", AGENT_SINGLE_PROVIDER: "codex", AGENT_REVIEWER_PROVIDER: "codex" });
  assert.equal(explicit.assignments.reviewer.provider, "codex");
});

test("dual mode with one provider asks for single-mode downgrade confirmation", () => {
  const cfg = {
    ...defaultAgentRuntimeConfig({ OPENCODE_API_KEY: "opencode-go-key" }),
    mode: "dual" as const,
    assignments: {
      primary: { provider: "opencode" as const, model: "opencode-go/deepseek-v4-pro" },
      reviewer: { provider: "opencode" as const, model: "opencode-go/minimax-m3" },
      chat: { provider: "opencode" as const, model: "opencode-go/deepseek-v4-flash" },
    },
  };
  const result = validateAgentRuntimeConfig(cfg, { opencode: true, codex: true });
  assert.equal(result.ok, false);
  assert.equal(result.requiresSingleDowngradeConfirmation, true);
  assert.equal(result.downgradeProvider, "opencode");
});

test("publicAgentConfig never exposes API key values", () => {
  const cfg = defaultAgentRuntimeConfig({ OPENCODE_API_KEY: "opencode-go-secret", CODEX_API_KEY: "codex-secret" });
  const pub = publicAgentConfig(cfg, { opencode: true, codex: true });
  const body = JSON.stringify(pub);
  assert.doesNotMatch(body, /opencode-go-secret|codex-secret/);
  assert.deepEqual(pub.keys, { opencode: true, codex: true });
});

// Audit C4b (2): validateAgentRuntimeConfig never enforced reviewer.model !== primary.model at
// runtime — the DEFAULT_MODELS guard in model-config.test.ts only protects the compiled-in
// defaults; an env override (AGENT_PRIMARY_MODEL / AGENT_REVIEWER_MODEL) can still collapse both
// roles onto the same model and validation would report ok:true, silently defeating the
// independent-judgment guarantee (the reviewer would grade the generator's own homework).

test("single mode: the default config still validates ok (reviewer != primary by default)", () => {
  const cfg = defaultAgentRuntimeConfig({ OPENCODE_API_KEY: "opencode-go-key" });
  const result = validateAgentRuntimeConfig(cfg, { opencode: true, codex: false });
  assert.equal(result.ok, true, `default single-mode config must validate ok; errors: ${result.errors.join("; ")}`);
});

test("dual mode: the default config still validates ok (reviewer != primary by default)", () => {
  const keys = { OPENCODE_API_KEY: "ok", CODEX_API_KEY: "ck" };
  const cfg = configFromEnv({ ...keys, AGENT_RUNTIME_MODE: "dual" });
  const result = validateAgentRuntimeConfig(cfg, { opencode: true, codex: true });
  assert.equal(result.ok, true, `default dual-mode config must validate ok; errors: ${result.errors.join("; ")}`);
});

test("single mode: reviewer.model === primary.model fails validation, naming both role/model pairs (CFG-05)", () => {
  const cfg = {
    ...defaultAgentRuntimeConfig({ OPENCODE_API_KEY: "opencode-go-key" }),
    assignments: {
      primary: { provider: "opencode" as const, model: "opencode-go/deepseek-v4-pro" },
      reviewer: { provider: "opencode" as const, model: "opencode-go/deepseek-v4-pro" },
      chat: { provider: "opencode" as const, model: "opencode-go/deepseek-v4-flash" },
    },
  };
  const result = validateAgentRuntimeConfig(cfg, { opencode: true, codex: false });
  assert.equal(result.ok, false, "reviewer.model === primary.model must fail validation in single mode");
  const joined = result.errors.join("\n");
  assert.match(joined, /primary/i, "the error must name the primary role/model");
  assert.match(joined, /reviewer/i, "the error must name the reviewer role/model");
  assert.match(joined, /opencode-go\/deepseek-v4-pro/, "the error must name the colliding model");
});

test("dual mode: reviewer.model === primary.model fails validation, naming both role/model pairs (CFG-05)", () => {
  const cfg = {
    ...defaultAgentRuntimeConfig({ OPENCODE_API_KEY: "opencode-go-key", CODEX_API_KEY: "codex-key" }),
    mode: "dual" as const,
    assignments: {
      primary: { provider: "opencode" as const, model: "opencode-go/deepseek-v4-pro" },
      reviewer: { provider: "codex" as const, model: "opencode-go/deepseek-v4-pro" },
      chat: { provider: "codex" as const, model: "gpt-5.4-mini" },
    },
  };
  const result = validateAgentRuntimeConfig(cfg, { opencode: true, codex: true });
  assert.equal(result.ok, false, "reviewer.model === primary.model must fail validation in dual mode too");
  const joined = result.errors.join("\n");
  assert.match(joined, /primary/i, "the error must name the primary role/model");
  assert.match(joined, /reviewer/i, "the error must name the reviewer role/model");
  assert.match(joined, /opencode-go\/deepseek-v4-pro/, "the error must name the colliding model");
});
