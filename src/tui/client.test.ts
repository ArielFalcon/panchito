import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, QaApiError } from "./client";

// Build a stub `fetch` that returns a fixed status/body and captures the last call.
function stubFetch(status: number, body: string, captured?: { url?: string; init?: RequestInit }): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    if (captured) {
      captured.url = url;
      captured.init = init;
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    };
  }) as unknown as typeof fetch;
}

test("createRun POSTs the body and returns the parsed result", async () => {
  const cap: { url?: string; init?: RequestInit } = {};
  const client = createClient({ host: "localhost:9", fetchImpl: stubFetch(202, JSON.stringify({ id: "run-1", app: "demo", sha: "abc", mode: "diff", status: "enqueued" }), cap) });
  const res = await client.createRun({ app: "demo", target: "e2e", mode: "diff", ref: "main" });
  assert.equal(res.id, "run-1");
  assert.equal(cap.url, "http://localhost:9/api/runs");
  assert.equal(cap.init?.method, "POST");
  assert.match(String(cap.init?.body), /"app":"demo"/);
});

test("a configured token is sent as a Bearer header", async () => {
  const cap: { url?: string; init?: RequestInit } = {};
  const client = createClient({ host: "h", token: "s3cr3t", fetchImpl: stubFetch(200, "[]", cap) });
  await client.listApps();
  assert.equal((cap.init?.headers as Record<string, string>)["authorization"], "Bearer s3cr3t");
});

test("an HTTP error surfaces the server's {error} message", async () => {
  const client = createClient({ host: "h", fetchImpl: stubFetch(404, JSON.stringify({ error: "run not found: x" })) });
  await assert.rejects(() => client.getRun("x"), (e) => e instanceof QaApiError && /run not found/.test(e.message) && e.status === 404);
});

test("401 gives an actionable token hint", async () => {
  const client = createClient({ host: "h", fetchImpl: stubFetch(401, JSON.stringify({ error: "unauthorized" })) });
  await assert.rejects(() => client.getQueue(), (e) => e instanceof QaApiError && /QA_API_TOKEN/.test(e.message));
});

test("a connection failure is reported distinctly from an HTTP error", async () => {
  const failing = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const client = createClient({ host: "localhost:59999", fetchImpl: failing });
  await assert.rejects(() => client.getQueue(), (e) => e instanceof QaApiError && /cannot reach localhost:59999/.test(e.message) && e.status === undefined);
});

test("validateRepo POSTs /api/apps with validateOnly", async () => {
  const cap: { url?: string; init?: RequestInit } = {};
  const client = createClient({
    host: "h:1",
    fetchImpl: stubFetch(200, JSON.stringify({ ok: true, repoInfo: { fullName: "o/r", defaultBranch: "main", private: false, name: "r", description: null } }), cap),
  });
  const r = await client.validateRepo("o/r");
  assert.equal(cap.url, "http://h:1/api/apps");
  assert.equal(cap.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(cap.init?.body)), { repo: "o/r", validateOnly: true });
  assert.equal(r.repoInfo?.defaultBranch, "main");
});

test("createApp POSTs the full input to /api/apps", async () => {
  const cap: { url?: string; init?: RequestInit } = {};
  const client = createClient({
    host: "h:1",
    fetchImpl: stubFetch(201, JSON.stringify({ ok: true, name: "shop", path: "/x/shop.yaml" }), cap),
  });
  const r = await client.createApp({ repo: "org/shop-front", name: "shop", target: "e2e" });
  assert.equal(cap.url, "http://h:1/api/apps");
  assert.equal(cap.init?.method, "POST");
  assert.match(String(cap.init?.body), /"name":"shop"/);
  assert.equal(r.name, "shop");
});

test("deleteApp DELETEs with the purge flag", async () => {
  const cap: { url?: string; init?: RequestInit } = {};
  const client = createClient({
    host: "h:1",
    fetchImpl: stubFetch(200, JSON.stringify({ removed: ["config:shop"] }), cap),
  });
  const r = await client.deleteApp("shop", true);
  assert.equal(cap.url, "http://h:1/api/apps/shop?purge=1");
  assert.equal(cap.init?.method, "DELETE");
  assert.deepEqual(r.removed, ["config:shop"]);
});

test("deleteApp without purge omits the query string", async () => {
  const cap: { url?: string; init?: RequestInit } = {};
  const client = createClient({
    host: "h:1",
    fetchImpl: stubFetch(200, JSON.stringify({ removed: ["config:shop"] }), cap),
  });
  await client.deleteApp("shop", false);
  assert.equal(cap.url, "http://h:1/api/apps/shop");
});

test("getApp GETs /api/apps/:name", async () => {
  const cap: { url?: string; init?: RequestInit } = {};
  const client = createClient({
    host: "h:1",
    fetchImpl: stubFetch(200, JSON.stringify({ name: "shop", repo: "org/shop", baseUrl: "https://dev", versionUrl: "", code: false, shadow: true, needsReview: true, testDataPrefix: "qa", services: [] }), cap),
  });
  const r = await client.getApp("shop");
  assert.equal(cap.url, "http://h:1/api/apps/shop");
  assert.equal(cap.init?.method, "GET");
  assert.equal(r.name, "shop");
});

test("updateApp PUTs to /api/apps/:name", async () => {
  const cap: { url?: string; init?: RequestInit } = {};
  const client = createClient({
    host: "h:1",
    fetchImpl: stubFetch(200, JSON.stringify({ ok: true, name: "shop" }), cap),
  });
  const r = await client.updateApp("shop", { baseUrl: "https://new.dev.io" });
  assert.equal(cap.url, "http://h:1/api/apps/shop");
  assert.equal(cap.init?.method, "PUT");
  assert.equal(r.name, "shop");
});

test("getAgentConfig GETs /api/agent/config", async () => {
  const cap: { url?: string; init?: RequestInit } = {};
  const body = {
    mode: "single",
    singleProvider: "opencode",
    assignments: {
      primary: { provider: "opencode", model: "opencode-go/deepseek-v4-pro" },
      reviewer: { provider: "opencode", model: "opencode-go/minimax-m3" },
      chat: { provider: "opencode", model: "opencode-go/deepseek-v4-flash" },
    },
    keys: { opencode: true, codex: false },
    validation: { ok: true, errors: [] },
  };
  const client = createClient({ host: "h:1", fetchImpl: stubFetch(200, JSON.stringify(body), cap) });
  const r = await client.getAgentConfig();
  assert.equal(cap.url, "http://h:1/api/agent/config");
  assert.equal(cap.init?.method, "GET");
  assert.equal(r.singleProvider, "opencode");
});

test("updateAgentConfig PUTs sanitized runtime updates", async () => {
  const cap: { url?: string; init?: RequestInit } = {};
  const body = {
    config: {
      mode: "single",
      singleProvider: "codex",
      assignments: {
        primary: { provider: "codex", model: "gpt-5.4" },
        reviewer: { provider: "codex", model: "gpt-5.4" },
        chat: { provider: "codex", model: "gpt-5.4-mini" },
      },
      keys: { opencode: true, codex: true },
      validation: { ok: true, errors: [] },
    },
    restarted: ["codex"],
  };
  const client = createClient({ host: "h:1", fetchImpl: stubFetch(200, JSON.stringify(body), cap) });
  const r = await client.updateAgentConfig({ mode: "single", singleProvider: "codex", apiKeys: { codex: "sk-test" } });
  assert.equal(cap.url, "http://h:1/api/agent/config");
  assert.equal(cap.init?.method, "PUT");
  assert.deepEqual(JSON.parse(String(cap.init?.body)).apiKeys, { codex: "sk-test" });
  assert.deepEqual(r.restarted, ["codex"]);
});

test("listAgentModels GETs provider query", async () => {
  const cap: { url?: string; init?: RequestInit } = {};
  const client = createClient({ host: "h:1", fetchImpl: stubFetch(200, JSON.stringify({ provider: "codex", models: [{ id: "gpt-5.4" }] }), cap) });
  const r = await client.listAgentModels("codex");
  assert.equal(cap.url, "http://h:1/api/agent/models?provider=codex");
  assert.equal(r.models[0]?.id, "gpt-5.4");
});

test("restartAgentProvider POSTs one provider", async () => {
  const cap: { url?: string; init?: RequestInit } = {};
  const client = createClient({ host: "h:1", fetchImpl: stubFetch(200, JSON.stringify({ health: { provider: "opencode", status: "healthy", configured: true } }), cap) });
  const r = await client.restartAgentProvider("opencode");
  assert.equal(cap.url, "http://h:1/api/agent/restart");
  assert.deepEqual(JSON.parse(String(cap.init?.body)), { provider: "opencode" });
  assert.ok(r.health);
  assert.equal(r.health.status, "healthy");
});
