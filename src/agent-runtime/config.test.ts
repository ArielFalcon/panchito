import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultAgentRuntimeConfig,
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

test("dual mode with one provider asks for single-mode downgrade confirmation", () => {
  const cfg = {
    ...defaultAgentRuntimeConfig({ OPENCODE_API_KEY: "opencode-go-key" }),
    mode: "dual" as const,
    assignments: {
      primary: { provider: "opencode" as const, model: "opencode-go/deepseek-v4-pro" },
      reviewer: { provider: "opencode" as const, model: "opencode-go/qwen3.7-max" },
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
