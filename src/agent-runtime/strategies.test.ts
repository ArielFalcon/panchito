import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenCodeRuntimeStrategy } from "./opencode-strategy";
import { CodexExecTransport, CodexRuntimeStrategy, SupervisorExecTransport, codexExecArgs, codexExecEnv, defaultCodexTransport } from "./codex-strategy";
import { capabilitiesForRole, roleForLegacyAgent } from "./types";
import type { AgentDeps } from "../integrations/opencode-client";

// Capability policy is expressed ONCE, provider-agnostic; each strategy enforces it with its own
// mechanism (OpenCode tools{} map, Codex --sandbox flag). The judge must not be able to write.
test("capabilitiesForRole: the judge / chat / reflector are read-only; authoring roles can write", () => {
  for (const role of ["reviewer", "chat", "reflector"] as const) {
    assert.equal(capabilitiesForRole(role).canWrite, false, `${role} must be read-only`);
  }
  for (const role of ["primary", "worker", "workerCode", "maintainer"] as const) {
    assert.equal(capabilitiesForRole(role).canWrite, true, `${role} must be able to write`);
  }
});

test("codexExecArgs sandboxes read-only roles: the reviewer cannot write the workspace on Codex", () => {
  const reviewer = codexExecArgs({ role: "reviewer", cwd: "/repo" });
  assert.ok(reviewer.includes("read-only"), "reviewer must run --sandbox read-only");
  assert.ok(!reviewer.includes("workspace-write"), "reviewer must NOT get workspace-write");
  const primary = codexExecArgs({ role: "primary", cwd: "/repo", model: "gpt-5.4" });
  assert.ok(primary.includes("workspace-write"), "the author role keeps workspace-write");
  assert.ok(primary.includes("gpt-5.4"));
});

test("SupervisorExecTransport forwards the per-role sandbox so the supervisor can enforce it", async () => {
  const bodies: string[] = [];
  const transport = new SupervisorExecTransport({
    baseUrl: "http://agents:4097",
    env: { CODEX_API_KEY: "codex-key" },
    fetchImpl: async (_url, init) => {
      bodies.push((init?.body as string) ?? "");
      return { ok: true, status: 200, json: async () => ({ message: "ok" }) };
    },
  });
  const session = await transport.start({ role: "reviewer", cwd: "/repo" });
  await session.prompt("review");
  const body = JSON.parse(bodies[0]!) as { sandbox?: string };
  assert.equal(body.sandbox, "read-only");
});

test("roleForLegacyAgent maps qa-reflector to the read-only reflector role", () => {
  assert.equal(roleForLegacyAgent("qa-reflector"), "reflector");
  assert.equal(capabilitiesForRole("reflector").canWrite, false);
});

// ── Fase 1: the read-only blast-radius explorer role (both runtimes) ─────────

test("capabilitiesForRole: the explorer is read-only (it distills the blast radius, never writes)", () => {
  assert.equal(capabilitiesForRole("explorer").canWrite, false);
});

test("roleForLegacyAgent maps qa-explorer to the read-only explorer role", () => {
  assert.equal(roleForLegacyAgent("qa-explorer"), "explorer");
});

test("codexExecArgs sandboxes the explorer read-only on Codex", () => {
  const args = codexExecArgs({ role: "explorer", cwd: "/repo" });
  assert.ok(args.includes("read-only"), "explorer must run --sandbox read-only");
  assert.ok(!args.includes("workspace-write"), "explorer must NOT get workspace-write");
});

test("OpenCodeRuntimeStrategy maps the explorer role to the qa-explorer agent", async () => {
  const calls: string[] = [];
  const deps: AgentDeps = {
    open: async (agent) => {
      calls.push(agent);
      return { id: "s", prompt: async () => "ok", dispose: async () => {} };
    },
  };
  const strategy = new OpenCodeRuntimeStrategy({ env: { OPENCODE_API_KEY: "k" }, depsFactory: async () => deps });
  await strategy.openSession("explorer", "/repo");
  assert.deepEqual(calls, ["qa-explorer"]);
});

test("OpenCodeRuntimeStrategy maps roles to legacy OpenCode agents and forwards model overrides", async () => {
  const calls: Array<{ agent: string; cwd: string; model?: string }> = [];
  const deps: AgentDeps = {
    open: async (agent, cwd, opts) => {
      calls.push({ agent, cwd, model: opts?.model });
      return { id: "s1", prompt: async () => "ok", dispose: async () => {} };
    },
  };
  const strategy = new OpenCodeRuntimeStrategy({
    env: { OPENCODE_API_KEY: "opencode-key" },
    depsFactory: async () => deps,
  });

  const session = await strategy.openSession("reviewer", "/repo", { model: "opencode-go/minimax-m3" });
  assert.equal(await session.prompt("review"), "ok");

  assert.deepEqual(calls, [{ agent: "qa-reviewer", cwd: "/repo", model: "opencode-go/minimax-m3" }]);
});

test("OpenCodeRuntimeStrategy reports needs_config without OPENCODE_API_KEY", async () => {
  const strategy = new OpenCodeRuntimeStrategy({ env: {}, depsFactory: async () => { throw new Error("should not connect"); } });
  assert.deepEqual(await strategy.health(), { provider: "opencode", status: "needs_config", configured: false });
});

test("CodexRuntimeStrategy wraps a headless transport as an AgentRuntimeSession", async () => {
  const prompts: string[] = [];
  let disposed = false;
  const strategy = new CodexRuntimeStrategy({
    env: { CODEX_API_KEY: "codex-key" },
    transport: {
      start: async (input) => {
        assert.equal(input.role, "primary");
        assert.equal(input.cwd, "/repo");
        assert.equal(input.model, "gpt-5.4");
        return {
          id: "codex-1",
          prompt: async (text) => {
            prompts.push(text);
            return "codex-ok";
          },
          dispose: async () => { disposed = true; },
        };
      },
      health: async () => ({ provider: "codex", status: "healthy", configured: true }),
      listModels: async () => [{ id: "gpt-5.4" }],
    },
  });

  const session = await strategy.openSession("primary", "/repo", { model: "gpt-5.4" });
  assert.equal(await session.prompt("write tests"), "codex-ok");
  await session.dispose();

  assert.match(prompts[0]!, /Agent role: primary/);
  assert.match(prompts[0]!, /write tests/);
  assert.equal(disposed, true);
});

test("defaultCodexTransport runs Codex over the supervisor when one is configured, else locally", () => {
  assert.ok(defaultCodexTransport({ AGENT_SUPERVISOR_URL: "http://agents:4097" }) instanceof SupervisorExecTransport);
  assert.ok(defaultCodexTransport({}) instanceof CodexExecTransport);
});

test("SupervisorExecTransport posts a prompt to /codex/exec and returns the final message", async () => {
  const calls: Array<{ url: string; init?: { method?: string; body?: string } }> = [];
  const transport = new SupervisorExecTransport({
    baseUrl: "http://agents:4097/",
    env: { CODEX_API_KEY: "codex-key" },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ message: "codex-ok" }) };
    },
  });

  const session = await transport.start({ role: "primary", cwd: "/repo", model: "gpt-5.4" });
  assert.equal(await session.prompt("write tests"), "codex-ok");

  assert.equal(calls[0]!.url, "http://agents:4097/codex/exec");
  assert.equal(calls[0]!.init?.method, "POST");
  const body = JSON.parse(calls[0]!.init!.body!) as { cwd: string; prompt: string; model: string };
  assert.equal(body.cwd, "/repo");
  assert.equal(body.model, "gpt-5.4");
  assert.match(body.prompt, /write tests/);
});

test("SupervisorExecTransport surfaces a supervisor exec failure instead of swallowing it", async () => {
  const transport = new SupervisorExecTransport({
    baseUrl: "http://agents:4097",
    env: { CODEX_API_KEY: "codex-key" },
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: "codex exec exited 1" }) }),
  });
  const session = await transport.start({ role: "primary", cwd: "/repo" });
  await assert.rejects(session.prompt("x"), /codex exec via supervisor failed \(400\): codex exec exited 1/);
});

test("SupervisorExecTransport reports needs_config without a Codex key and reads /providers otherwise", async () => {
  const noKey = new SupervisorExecTransport({ baseUrl: "http://agents:4097", env: {}, fetchImpl: async () => { throw new Error("should not call"); } });
  assert.deepEqual(await noKey.health(), { provider: "codex", status: "needs_config", configured: false });

  const supervised = new SupervisorExecTransport({
    baseUrl: "http://agents:4097",
    env: { CODEX_API_KEY: "codex-key" },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ providers: { codex: { provider: "codex", status: "healthy", configured: true } } }) }),
  });
  assert.deepEqual(await supervised.health(), { provider: "codex", status: "healthy", configured: true });
});

test("codexExecEnv passes only Codex/runtime-safe env vars to the headless agent", () => {
  const env = codexExecEnv({
    PATH: "/bin",
    HOME: "/home/panchito",
    GITHUB_TOKEN: "ghp_secret",
    WEBHOOK_SECRET: "webhook-secret",
    QA_API_TOKEN: "qa-secret",
    OPENCODE_API_KEY: "opencode-secret",
    CODEX_API_KEY: "codex-secret",
    OPENAI_API_KEY: "openai-secret",
    DEV_TEST_USER: "tester",
    DEV_TEST_PASS: "dev-pass",
    AGENT_PROMPT_DIR: "/prompts",
    AGENT_RUNTIME_MODE: "single",
    HTTPS_PROXY: "http://proxy",
  });

  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/home/panchito");
  assert.equal(env.CODEX_API_KEY, "codex-secret");
  assert.equal(env.OPENAI_API_KEY, "openai-secret");
  assert.equal(env.DEV_TEST_USER, "tester");
  assert.equal(env.DEV_TEST_PASS, "dev-pass");
  assert.equal(env.AGENT_PROMPT_DIR, "/prompts");
  assert.equal(env.HTTPS_PROXY, "http://proxy");
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.WEBHOOK_SECRET, undefined);
  assert.equal(env.QA_API_TOKEN, undefined);
  assert.equal(env.OPENCODE_API_KEY, undefined);
});
