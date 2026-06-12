import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { AgentRuntimeSettings } from "./AgentRuntimeSettings";
import type { PublicAgentConfig, QaClient } from "../client";

const config: PublicAgentConfig = {
  mode: "single",
  singleProvider: "opencode",
  assignments: {
    primary: { provider: "opencode", model: "opencode-go/deepseek-v4-pro" },
    reviewer: { provider: "opencode", model: "opencode-go/qwen3.7-max" },
    chat: { provider: "opencode", model: "opencode-go/deepseek-v4-flash" },
  },
  keys: { opencode: true, codex: false },
  validation: { ok: true, errors: [] },
  health: { opencode: { provider: "opencode", status: "healthy", configured: true } },
};

function client(): QaClient {
  return {
    getAgentConfig: async () => config,
    listAgentModels: async (provider: "opencode" | "codex") => ({
      provider,
      models: provider === "opencode"
        ? [{ id: "opencode-go/deepseek-v4-pro" }, { id: "opencode-go/qwen3.7-max" }]
        : [{ id: "gpt-5.4" }],
    }),
    updateAgentConfig: async () => ({ config, restarted: [] }),
    restartAgentProvider: async (provider: "opencode" | "codex") => ({ health: { provider, status: "healthy", configured: true } }),
  } as unknown as QaClient;
}

test("AgentRuntimeSettings renders current mode, roles, and actions", async () => {
  const { lastFrame, unmount } = render(<AgentRuntimeSettings client={client()} onBack={() => {}} />);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const f = lastFrame() ?? "";
  assert.match(f, /Agent Runtime/);
  assert.match(f, /Mode: single\/opencode/);
  assert.match(f, /Primary/);
  assert.match(f, /Set Codex API key/);
  unmount();
});
