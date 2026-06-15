import { test } from "node:test";
import assert from "node:assert/strict";
import { delegateRun } from "./run-delegate";

type Call = { method: string; url: string; body?: Record<string, unknown>; auth?: string };

test("delegateRun POSTs the run to the service, polls to completion, and returns the verdict", async () => {
  const calls: Call[] = [];
  let polls = 0;
  const fetchStub = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
    });
    if (method === "POST") {
      return new Response(JSON.stringify({ id: "run-1", app: "demo", sha: "abc", target: "e2e", mode: "exhaustive", status: "enqueued" }), { status: 202 });
    }
    polls++;
    const done = polls >= 2;
    return new Response(
      JSON.stringify({
        id: "run-1", app: "demo", sha: "abc", target: "e2e", mode: "exhaustive",
        status: done ? "done" : "running", step: done ? "done" : "generate",
        verdict: done ? "pass" : undefined, passed: done ? 3 : 0, failed: 0, cases: [], logs: [], at: "t",
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const seen: string[] = [];
  const result = await delegateRun(
    { app: "demo", sha: "abc", target: "e2e", mode: "exhaustive" },
    { fetch: fetchStub, baseUrl: "http://localhost:8080", token: "secret", pollMs: 1, onUpdate: (r) => seen.push(r.status) },
  );

  assert.equal(result.id, "run-1");
  assert.equal(result.status, "done");
  assert.equal(result.verdict, "pass");
  assert.equal(result.passed, 3);

  const post = calls.find((c) => c.method === "POST");
  assert.ok(post, "must POST to create the run");
  assert.equal(post!.url, "http://localhost:8080/api/v1/runs");
  assert.equal(post!.auth, "Bearer secret");
  assert.equal(post!.body!.app, "demo");
  assert.equal(post!.body!.mode, "exhaustive");
  assert.ok(seen.includes("done"), "progress updates must reach onUpdate");
});

test("delegateRun surfaces a service rejection (non-2xx create) as a clear error", async () => {
  const fetchStub = (async () =>
    new Response(JSON.stringify({ error: "app not found: 'ghost'" }), { status: 404 })) as unknown as typeof fetch;

  await assert.rejects(
    () => delegateRun({ app: "ghost", sha: "abc", target: "e2e", mode: "diff" }, { fetch: fetchStub, baseUrl: "http://x", pollMs: 1 }),
    /app not found: 'ghost'/,
  );
});

test("delegateRun throws on an auth rejection during polling instead of looping forever", async () => {
  let first = true;
  const fetchStub = (async (_url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "POST") {
      return new Response(JSON.stringify({ id: "run-1" }), { status: 202 });
    }
    first = false;
    return new Response("forbidden", { status: 403 });
  }) as unknown as typeof fetch;

  await assert.rejects(
    () => delegateRun({ app: "demo", sha: "abc", target: "e2e", mode: "diff" }, { fetch: fetchStub, baseUrl: "http://x", pollMs: 1 }),
    /token|401|403/i,
  );
  assert.equal(first, false);
});

test("delegateRun tolerates a transient network error during polling and keeps waiting", async () => {
  let poll = 0;
  const fetchStub = (async (_url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "POST") {
      return new Response(JSON.stringify({ id: "run-1" }), { status: 202 });
    }
    poll++;
    if (poll === 1) throw new Error("ECONNRESET"); // a transient blip mid-run must not abort the wait
    return new Response(JSON.stringify({ id: "run-1", status: "done", verdict: "pass", passed: 1, failed: 0 }), { status: 200 });
  }) as unknown as typeof fetch;

  const result = await delegateRun(
    { app: "demo", sha: "abc", target: "e2e", mode: "diff" },
    { fetch: fetchStub, baseUrl: "http://x", pollMs: 1 },
  );

  assert.equal(result.verdict, "pass");
  assert.ok(poll >= 2, "the poll must have retried after the transient error");
});
