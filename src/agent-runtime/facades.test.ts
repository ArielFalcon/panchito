import { test } from "node:test";
import assert from "node:assert/strict";
import { SingleAgentFacade, DualAgentFacade } from "./facades";
import type { AgentRuntimeStrategy, AgentRole } from "./types";

function strategy(provider: "opencode" | "codex", calls: AgentRole[]): AgentRuntimeStrategy {
  return {
    provider,
    async health() {
      return { provider, status: "healthy", configured: true };
    },
    async listModels() {
      return provider === "opencode"
        ? [{ id: "opencode-go/deepseek-v4-pro", label: "OpenCode Pro" }]
        : [{ id: "gpt-5.4", label: "GPT 5.4" }];
    },
    async openSession(role) {
      calls.push(role);
      return {
        id: `${provider}-${role}`,
        async prompt() {
          return `{"approved":true,"specs":[]}`;
        },
        async dispose() {},
      };
    },
  };
}

test("SingleAgentFacade routes every legacy agent role through one strategy", async () => {
  const calls: AgentRole[] = [];
  const facade = new SingleAgentFacade(strategy("opencode", calls), {
    mode: "single",
    singleProvider: "opencode",
    assignments: {
      primary: { provider: "opencode", model: "opencode-go/deepseek-v4-pro" },
      reviewer: { provider: "opencode", model: "opencode-go/qwen3.7-max" },
      chat: { provider: "opencode", model: "opencode-go/deepseek-v4-flash" },
    },
  });
  const deps = facade.deps();
  const session = await deps.open("qa-reviewer", "/tmp/repo");
  await session.dispose();
  assert.deepEqual(calls, ["reviewer"]);
});

test("DualAgentFacade routes roles to their assigned provider strategies", async () => {
  const openCalls: AgentRole[] = [];
  const codexCalls: AgentRole[] = [];
  const facade = new DualAgentFacade(
    { opencode: strategy("opencode", openCalls), codex: strategy("codex", codexCalls) },
    {
      mode: "dual",
      singleProvider: "opencode",
      assignments: {
        primary: { provider: "opencode", model: "opencode-go/deepseek-v4-pro" },
        reviewer: { provider: "codex", model: "gpt-5.4" },
        chat: { provider: "codex", model: "gpt-5.4-mini" },
      },
    },
  );
  const deps = facade.deps();
  await (await deps.open("qa-generator", "/tmp/repo")).dispose();
  await (await deps.open("qa-reviewer", "/tmp/repo")).dispose();
  await (await deps.open("qa-assistant", "/tmp/repo")).dispose();
  assert.deepEqual(openCalls, ["primary"]);
  assert.deepEqual(codexCalls, ["reviewer", "chat"]);
});
