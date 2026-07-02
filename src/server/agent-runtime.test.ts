import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentRuntimeManager } from "./agent-runtime";
import type { EnvStoreFs } from "./env-store";
import type { AgentProvider, AgentRuntimeStrategy } from "../agent-runtime/types";

function memoryFs(initial = ""): EnvStoreFs & { content: string } {
  return {
    content: initial,
    read() { return this.content || null; },
    write(content: string) { this.content = content; },
  };
}

function strategy(
  provider: AgentProvider,
  restarts: AgentProvider[],
  restartOpts?: Partial<Record<AgentProvider, unknown[]>>,
  disposed?: AgentProvider[],
): AgentRuntimeStrategy {
  const models = provider === "opencode"
    ? [
        { id: "opencode-go/deepseek-v4-pro" },
        { id: "opencode-go/minimax-m3" },
        { id: "opencode-go/deepseek-v4-flash" },
      ]
    : [
        { id: "gpt-5.4" },
        { id: "gpt-5.4-mini" },
        { id: "gpt-5.5" },
      ];
  return {
    provider,
    health: async () => ({ provider, status: "healthy", configured: true }),
    listModels: async () => models,
    openSession: async () => {
      throw new Error("not used");
    },
    restart: async (opts) => {
      restarts.push(provider);
      restartOpts?.[provider]?.push(opts);
      return { provider, status: "healthy", configured: true };
    },
    dispose: () => { disposed?.push(provider); },
  };
}

test("agent runtime manager boots single/opencode and reports missing key as needs_config", async () => {
  const restarts: AgentProvider[] = [];
  const manager = createAgentRuntimeManager({
    env: {},
    fs: memoryFs(),
    strategies: { opencode: strategy("opencode", restarts), codex: strategy("codex", restarts) },
  });

  const cfg = await manager.getConfig();

  assert.equal(cfg.mode, "single");
  assert.equal(cfg.singleProvider, "opencode");
  assert.equal(cfg.keys.opencode, false);
  assert.equal(cfg.validation.ok, false);
  assert.equal(cfg.health?.opencode?.status, "needs_config");
});

test("agent runtime manager applies a codex key and restarts only codex", async () => {
  const restarts: AgentProvider[] = [];
  const env: Record<string, string | undefined> = { OPENCODE_API_KEY: "open-key" };
  const fs = memoryFs("OPENCODE_API_KEY=open-key\n");
  const manager = createAgentRuntimeManager({
    env,
    fs,
    strategies: { opencode: strategy("opencode", restarts), codex: strategy("codex", restarts) },
  });

  const result = await manager.applyConfig({ mode: "single", singleProvider: "codex", apiKeys: { codex: "codex-key" } });

  assert.equal(result.config.singleProvider, "codex");
  assert.deepEqual(result.restarted, ["codex"]);
  assert.equal(env.CODEX_API_KEY, "codex-key");
  assert.match(fs.content, /^CODEX_API_KEY=codex-key$/m);
  assert.doesNotMatch(JSON.stringify(result), /codex-key/);
});

test("agent runtime manager disposes the outgoing provider when switching single provider", async () => {
  const restarts: AgentProvider[] = [];
  const disposed: AgentProvider[] = [];
  const manager = createAgentRuntimeManager({
    env: { OPENCODE_API_KEY: "open-key" },
    fs: memoryFs("OPENCODE_API_KEY=open-key\n"),
    strategies: {
      opencode: strategy("opencode", restarts, undefined, disposed),
      codex: strategy("codex", restarts, undefined, disposed),
    },
  });

  await manager.applyConfig({ mode: "single", singleProvider: "codex", apiKeys: { codex: "codex-key" } });

  assert.deepEqual(disposed, ["opencode"]);
  assert.deepEqual(restarts, ["codex"]);
});

test("agent runtime manager passes current runtime env to provider restarts", async () => {
  const restarts: AgentProvider[] = [];
  const restartOpts: Record<AgentProvider, unknown[]> = { opencode: [], codex: [] };
  const env: Record<string, string | undefined> = { OPENCODE_API_KEY: "open-key" };
  const manager = createAgentRuntimeManager({
    env,
    fs: memoryFs("OPENCODE_API_KEY=open-key\n"),
    strategies: {
      opencode: strategy("opencode", restarts, restartOpts),
      codex: strategy("codex", restarts, restartOpts),
    },
  });

  await manager.applyConfig({ mode: "single", singleProvider: "codex", apiKeys: { codex: "codex-key" } });

  const opts = restartOpts.codex[0] as { env?: Record<string, string>; apiKey?: string };
  assert.equal(opts.apiKey, "codex-key");
  assert.equal(opts.env?.AGENT_RUNTIME_MODE, "single");
  assert.equal(opts.env?.AGENT_SINGLE_PROVIDER, "codex");
  assert.equal(opts.env?.AGENT_PRIMARY_PROVIDER, "codex");
  assert.equal(opts.env?.AGENT_PRIMARY_MODEL, "gpt-5.4");
});

test("agent runtime manager requires confirmation before downgrading dual with one provider", async () => {
  const restarts: AgentProvider[] = [];
  const manager = createAgentRuntimeManager({
    env: { OPENCODE_API_KEY: "open-key", CODEX_API_KEY: "codex-key" },
    fs: memoryFs(),
    strategies: { opencode: strategy("opencode", restarts), codex: strategy("codex", restarts) },
  });

  await assert.rejects(
    manager.applyConfig({
      mode: "dual",
      assignments: {
        primary: { provider: "codex", model: "gpt-5.4" },
        reviewer: { provider: "codex", model: "gpt-5.4" },
        chat: { provider: "codex", model: "gpt-5.4-mini" },
      },
    }),
    /confirmSingleDowngrade/,
  );
});

test("agent runtime manager downgrades confirmed single-provider dual config to single", async () => {
  const restarts: AgentProvider[] = [];
  const manager = createAgentRuntimeManager({
    env: { OPENCODE_API_KEY: "open-key", CODEX_API_KEY: "codex-key" },
    fs: memoryFs(),
    strategies: { opencode: strategy("opencode", restarts), codex: strategy("codex", restarts) },
  });

  const result = await manager.applyConfig({
    mode: "dual",
    confirmSingleDowngrade: true,
    assignments: {
      // primary and reviewer must be DIFFERENT models — see Audit C4b (2): identical models here
      // would trip the reviewer!=primary runtime guard and this test isn't exercising that guard.
      primary: { provider: "codex", model: "gpt-5.4" },
      reviewer: { provider: "codex", model: "gpt-5.5" },
      chat: { provider: "codex", model: "gpt-5.4-mini" },
    },
  });

  assert.equal(result.config.mode, "single");
  assert.equal(result.config.singleProvider, "codex");
  assert.equal(result.downgraded, true);
});

test("agent runtime manager rejects missing model instead of silently falling back", async () => {
  const restarts: AgentProvider[] = [];
  const manager = createAgentRuntimeManager({
    env: { OPENCODE_API_KEY: "open-key" },
    fs: memoryFs(),
    strategies: { opencode: strategy("opencode", restarts), codex: strategy("codex", restarts) },
  });

  await assert.rejects(
    manager.applyConfig({ assignments: { primary: { provider: "opencode", model: "" } } }),
    /primary model is required/,
  );
});

test("agent runtime manager rejects a configured model that is not listed by its provider", async () => {
  const restarts: AgentProvider[] = [];
  const manager = createAgentRuntimeManager({
    env: { OPENCODE_API_KEY: "open-key" },
    fs: memoryFs(),
    strategies: { opencode: strategy("opencode", restarts), codex: strategy("codex", restarts) },
  });

  await assert.rejects(
    manager.applyConfig({
      assignments: {
        primary: { provider: "opencode", model: "opencode-go/not-a-real-model" },
      },
    }),
    /primary model 'opencode-go\/not-a-real-model' is not available for opencode/,
  );
  assert.deepEqual(restarts, []);
});
