import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handleApi, ApiDeps } from "./api";
import { RunRecord } from "../types";
import { AppViewSchema, CreateRunResultSchema, QueueStatusSchema, RunRecordSchema } from "../contract/commands";
import { RunEventSchema } from "../contract/events";
import { createRunEventStore } from "./run-events";

function mkReq(method: string, url: string, body?: string): any {
  const r: any = Readable.from(body != null ? [body] : []);
  r.method = method;
  r.url = url;
  r.headers = { host: "localhost" };
  return r;
}

function mkRes(): any {
  return {
    status: 0,
    body: "",
    headers: {} as Record<string, string>,
    writes: [] as string[],
    writeHead(s: number) {
      this.status = s;
    },
    setHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v;
    },
    write(chunk: string) {
      this.writes.push(chunk);
      this.body += chunk;
    },
    end(b?: string) {
      this.body = b ?? "";
    },
  };
}

const appConfig: any = {
  name: "demo",
  repo: "org/demo",
  dev: { baseUrl: "https://dev", versionUrl: "https://dev/version" },
  qa: { shadow: true, needsReview: false, testDataPrefix: "qa" },
};

function deps(over: Partial<ApiDeps> = {}): ApiDeps {
  return {
    queue: { size: 2 },
    enqueue: () => "run-xyz",
    loadApp: (n) => {
      if (n === "demo") return appConfig;
      throw new Error("not found");
    },
    listApps: () => [appConfig],
    resolveRef: async () => "f".repeat(40),
    getRecord: () => undefined,
    listRecords: () => [],
    currentRun: () => undefined,
    ...over,
  };
}

const parentRec: RunRecord = {
  id: "p1",
  app: "demo",
  sha: "abc",
  target: "e2e",
  mode: "diff",
  status: "done",
  verdict: "fail",
  cases: [
    { name: "checkout", status: "fail" },
    { name: "login", status: "pass" },
  ],
  logs: [],
  at: "t",
};

test("GET /api/runs/:id sanitizes logs/cases/note before egress", async () => {
  const leaky: RunRecord = {
    id: "r1", app: "demo", sha: "abc", target: "e2e", mode: "diff", status: "done", verdict: "fail",
    cases: [{ name: "x", status: "fail", detail: "boom token: ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
    logs: ["running... token: ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB end"],
    note: "failed; secret ghp_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    at: "t",
  };
  const res = mkRes();
  await handleApi(mkReq("GET", "/api/runs/r1"), res, deps({ getRecord: () => leaky }));
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.body, /ghp_AAAA|ghp_BBBB|ghp_CCCC/, "logs/cases/note must be redacted on egress");
});

test("POST /api/runs with a sha enqueues and returns 202", async () => {
  const res = mkRes();
  const ok = await handleApi(mkReq("POST", "/api/runs", JSON.stringify({ app: "demo", sha: "abc1234", mode: "diff" })), res, deps());
  assert.equal(ok, true);
  assert.equal(res.status, 202);
  assert.match(res.body, /run-xyz/);
});

test("POST /api/v1/runs is served and its response validates against the contract", async () => {
  const res = mkRes();
  const ok = await handleApi(mkReq("POST", "/api/v1/runs", JSON.stringify({ app: "demo", sha: "abc1234", mode: "diff", target: "e2e" })), res, deps());
  assert.equal(ok, true);
  assert.equal(res.status, 202);
  CreateRunResultSchema.parse(JSON.parse(res.body));
});

test("POST /api/runs accepts context mode", async () => {
  let seenMode = "";
  const res = mkRes();
  await handleApi(
    mkReq("POST", "/api/runs", JSON.stringify({ app: "demo", sha: "abc1234", mode: "context" })),
    res,
    deps({ enqueue: (_app, _sha, _target, mode) => { seenMode = mode; return "run-context"; } }),
  );
  assert.equal(res.status, 202);
  assert.equal(seenMode, "context");
});

test("POST /api/runs with a ref resolves it to a sha", async () => {
  let seen = "";
  const res = mkRes();
  await handleApi(
    mkReq("POST", "/api/runs", JSON.stringify({ app: "demo", ref: "main" })),
    res,
    deps({
      resolveRef: async (_repo, ref) => {
        seen = ref;
        return "a".repeat(40);
      },
    }),
  );
  assert.equal(seen, "main");
  assert.equal(res.status, 202);
});

test("POST /api/runs without 'app' → 400", async () => {
  const res = mkRes();
  await handleApi(mkReq("POST", "/api/runs", JSON.stringify({ sha: "abc1234" })), res, deps());
  assert.equal(res.status, 400);
});

test("POST /api/runs for an unknown app → 404", async () => {
  const res = mkRes();
  await handleApi(mkReq("POST", "/api/runs", JSON.stringify({ app: "ghost", sha: "abc1234" })), res, deps());
  assert.equal(res.status, 404);
});

test("POST /api/runs without sha or ref → 400", async () => {
  const res = mkRes();
  await handleApi(mkReq("POST", "/api/runs", JSON.stringify({ app: "demo" })), res, deps());
  assert.equal(res.status, 400);
});

test("a failing resolveRef surfaces a 400 with the reason", async () => {
  const res = mkRes();
  await handleApi(
    mkReq("POST", "/api/runs", JSON.stringify({ app: "demo", ref: "ghost" })),
    res,
    deps({ resolveRef: async () => { throw new Error("cannot resolve ref 'ghost'"); } }),
  );
  assert.equal(res.status, 400);
  assert.match(res.body, /cannot resolve ref 'ghost'/);
});

test("GET /api/runs requires ?app", async () => {
  const res = mkRes();
  await handleApi(mkReq("GET", "/api/runs"), res, deps());
  assert.equal(res.status, 400);
});

test("GET /api/runs/:id → 404 when missing", async () => {
  const res = mkRes();
  const ok = await handleApi(mkReq("GET", "/api/runs/none"), res, deps());
  assert.equal(ok, true);
  assert.equal(res.status, 404);
});

test("GET /api/v1/runs/:id is served and validates RunRecord output", async () => {
  const record: RunRecord = { id: "r1", app: "demo", sha: "abc", target: "e2e", mode: "diff", status: "done", verdict: "pass", cases: [], logs: [], at: "t" };
  const res = mkRes();
  const ok = await handleApi(mkReq("GET", "/api/v1/runs/r1"), res, deps({ getRecord: () => record }));
  assert.equal(ok, true);
  assert.equal(res.status, 200);
  RunRecordSchema.parse(JSON.parse(res.body));
});

test("GET /api/v1/runs/:id/events replays RunEvents after Last-Event-ID as SSE", async () => {
  const record: RunRecord = { id: "r1", app: "demo", sha: "abc", target: "e2e", mode: "diff", status: "running", cases: [], logs: [], at: "t" };
  const events = createRunEventStore({ now: () => 123 });
  events.publish("r1", { type: "run.started", app: "demo", sha: "abc", mode: "diff", target: "e2e" });
  const second = events.publish("r1", { type: "step.changed", step: "execute", detail: "running tests" });
  const res = mkRes();
  const req = mkReq("GET", "/api/v1/runs/r1/events");
  req.headers["last-event-id"] = "0";

  const ok = await handleApi(req, res, deps({ getRecord: () => record, runEvents: events }));

  assert.equal(ok, true);
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.doesNotMatch(res.body, /run.started/);
  assert.match(res.body, /id: 1/);
  assert.match(res.body, /event: step.changed/);
  const data = res.body.match(/^data: (.+)$/m)?.[1];
  assert.ok(data);
  assert.deepEqual(RunEventSchema.parse(JSON.parse(data)), second);
});

test("GET /api/apps lists configured apps", async () => {
  const res = mkRes();
  await handleApi(mkReq("GET", "/api/apps"), res, deps());
  assert.equal(res.status, 200);
  assert.match(res.body, /demo/);
});

test("GET /api/v1/apps validates AppView output against the contract", async () => {
  const res = mkRes();
  await handleApi(mkReq("GET", "/api/v1/apps"), res, deps());
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.map((app: unknown) => AppViewSchema.parse(app).name), ["demo"]);
});

test("GET /api/queue reports pending count and the running id", async () => {
  const running: RunRecord = { id: "r1", app: "demo", sha: "abc", target: "e2e", mode: "diff", status: "running", cases: [], logs: [], at: "t" };
  const res = mkRes();
  await handleApi(mkReq("GET", "/api/queue"), res, deps({ currentRun: () => running }));
  assert.equal(res.status, 200);
  assert.match(res.body, /"pending":2/);
  assert.match(res.body, /"id":"r1"/);
});

test("GET /api/v1/queue validates QueueStatus output against the contract", async () => {
  const running: RunRecord = { id: "r1", app: "demo", sha: "abc", target: "e2e", mode: "diff", status: "running", cases: [], logs: [], at: "t" };
  const res = mkRes();
  await handleApi(mkReq("GET", "/api/v1/queue"), res, deps({ currentRun: () => running }));
  assert.equal(res.status, 200);
  QueueStatusSchema.parse(JSON.parse(res.body));
});

test("GET /api/health → 200", async () => {
  const res = mkRes();
  await handleApi(mkReq("GET", "/api/health"), res, deps());
  assert.equal(res.status, 200);
});

test("POST /api/runs/:id/ask returns the assistant answer", async () => {
  const res = mkRes();
  const ask = async (input: { context: string; question: string }) => {
    assert.match(input.context, /Verdict: fail/);
    assert.equal(input.question, "why?");
    return "the checkout timed out";
  };
  const ok = await handleApi(
    mkReq("POST", "/api/runs/p1/ask", JSON.stringify({ question: "why?" })),
    res,
    deps({ getRecord: () => parentRec, ask }),
  );
  assert.equal(ok, true);
  assert.equal(res.status, 200);
  assert.match(res.body, /the checkout timed out/);
});

test("POST /api/runs/:id/ask for a missing run → 404", async () => {
  const res = mkRes();
  const ok = await handleApi(mkReq("POST", "/api/runs/none/ask", JSON.stringify({ question: "why?" })), res, deps());
  assert.equal(ok, true);
  assert.equal(res.status, 404);
});

test("POST /api/runs/:id/ask without 'question' → 400", async () => {
  const res = mkRes();
  const ask = async () => "unreachable";
  const ok = await handleApi(
    mkReq("POST", "/api/runs/p1/ask", JSON.stringify({})),
    res,
    deps({ getRecord: () => parentRec, ask }),
  );
  assert.equal(ok, true);
  assert.equal(res.status, 400);
});

test("POST /api/runs/:id/ask when ask is not wired → 501", async () => {
  const res = mkRes();
  const ok = await handleApi(
    mkReq("POST", "/api/runs/p1/ask", JSON.stringify({ question: "why?" })),
    res,
    deps({ getRecord: () => parentRec, ask: undefined }),
  );
  assert.equal(ok, true);
  assert.equal(res.status, 501);
});

test("POST /api/runs/:id/ask with assistant failure → 502", async () => {
  const res = mkRes();
  const ask = async () => { throw new Error("model unavailable"); };
  const ok = await handleApi(
    mkReq("POST", "/api/runs/p1/ask", JSON.stringify({ question: "why?" })),
    res,
    deps({ getRecord: () => parentRec, ask }),
  );
  assert.equal(ok, true);
  assert.equal(res.status, 502);
  assert.match(res.body, /model unavailable/);
});

test("an unmatched route returns false (left for the webhook/404 path)", async () => {
  const res = mkRes();
  const ok = await handleApi(mkReq("GET", "/nope"), res, deps());
  assert.equal(ok, false);
});

test("DELETE /api/runs/:id cancels a running run", async () => {
  const running: RunRecord = { id: "r1", app: "demo", sha: "abc", target: "e2e", mode: "diff", status: "running", cases: [], logs: [], at: "t" };
  const res = mkRes();
  const ok = await handleApi(
    mkReq("DELETE", "/api/runs/r1"),
    res,
    deps({ getRecord: () => running, cancelRun: () => true }),
  );
  assert.equal(ok, true);
  assert.equal(res.status, 200);
  assert.match(res.body, /cancelled/);
});

test("DELETE /api/runs/:id for a missing run → 404", async () => {
  const res = mkRes();
  const ok = await handleApi(
    mkReq("DELETE", "/api/runs/none"),
    res,
    deps({ cancelRun: () => false }),
  );
  assert.equal(ok, true);
  assert.equal(res.status, 404);
});

test("DELETE /api/runs/:id when cancel is not wired → 501", async () => {
  const running: RunRecord = { id: "r1", app: "demo", sha: "abc", target: "e2e", mode: "diff", status: "running", cases: [], logs: [], at: "t" };
  const res = mkRes();
  const ok = await handleApi(
    mkReq("DELETE", "/api/runs/r1"),
    res,
    deps({ getRecord: () => running, cancelRun: undefined }),
  );
  assert.equal(ok, true);
  assert.equal(res.status, 501);
});

test("DELETE /api/runs/:id for a non-running run → 409", async () => {
  const done: RunRecord = { id: "r1", app: "demo", sha: "abc", target: "e2e", mode: "diff", status: "done", verdict: "pass", cases: [], logs: [], at: "t" };
  const res = mkRes();
  const ok = await handleApi(
    mkReq("DELETE", "/api/runs/r1"),
    res,
    deps({ getRecord: () => done, cancelRun: () => false }),
  );
  assert.equal(ok, true);
  assert.equal(res.status, 409);
});

test("POST /api/runs/:id/continue enqueues a continuation of the failed cases → 202", async () => {
  let received: { parent: string; cases?: string[] } | null = null;
  const res = mkRes();
  const ok = await handleApi(
    mkReq("POST", "/api/runs/p1/continue", JSON.stringify({ cases: ["checkout"], guidance: "fix the selector" })),
    res,
    deps({
      getRecord: () => parentRec,
      continueRun: (parent, cases) => {
        received = { parent, cases };
        return "run-cont";
      },
    }),
  );
  assert.equal(ok, true);
  assert.equal(res.status, 202);
  assert.match(res.body, /run-cont/);
  assert.deepEqual(received, { parent: "p1", cases: ["checkout"] });
});

test("POST /api/runs/:id/continue with a non-failed case → 409", async () => {
  const res = mkRes();
  await handleApi(
    mkReq("POST", "/api/runs/p1/continue", JSON.stringify({ cases: ["login"] })), // login passed
    res,
    deps({ getRecord: () => parentRec, continueRun: () => "x" }),
  );
  assert.equal(res.status, 409);
});

test("POST /api/runs/:id/continue when continue is unavailable → 501", async () => {
  const res = mkRes();
  await handleApi(
    mkReq("POST", "/api/runs/p1/continue", "{}"),
    res,
    deps({ getRecord: () => parentRec, continueRun: undefined }),
  );
  assert.equal(res.status, 501);
});

test("POST /api/runs/:id/continue on a run with no failures → 409", async () => {
  const green: RunRecord = { ...parentRec, cases: [{ name: "login", status: "pass" }] };
  const res = mkRes();
  await handleApi(
    mkReq("POST", "/api/runs/p1/continue", "{}"),
    res,
    deps({ getRecord: () => green, continueRun: () => "x" }),
  );
  assert.equal(res.status, 409);
});

test("POST /api/apps delegates to createApp and 201s on success", async () => {
  const res = mkRes();
  const ok = await handleApi(
    mkReq("POST", "/api/apps", JSON.stringify({ repo: "org/shop-front", name: "shop" })),
    res,
    deps({ createApp: async (input) => ({ ok: true, name: input.name, path: "/x/shop.yaml", envApplied: ["K"] }) }),
  );
  assert.equal(ok, true);
  assert.equal(res.status, 201);
  const body = JSON.parse(res.body);
  assert.equal(body.name, "shop");
});

test("POST /api/apps maps a validation failure to 422", async () => {
  const res = mkRes();
  await handleApi(
    mkReq("POST", "/api/apps", JSON.stringify({ repo: "org/x" })),
    res,
    deps({ createApp: async () => ({ ok: false, errors: ["bad url"] }) }),
  );
  assert.equal(res.status, 422);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.errors, ["bad url"]);
});

test("POST /api/apps without the dep returns 501", async () => {
  const res = mkRes();
  await handleApi(mkReq("POST", "/api/apps", JSON.stringify({ repo: "org/x" })), res, deps({}));
  assert.equal(res.status, 501);
});

test("POST /api/apps with dryRun or validateOnly returns 200 (not 201)", async () => {
  const dry = mkRes();
  await handleApi(
    mkReq("POST", "/api/apps", JSON.stringify({ repo: "org/x", dryRun: true })),
    dry,
    deps({ createApp: async () => ({ ok: true, yaml: "name: x" }) }),
  );
  assert.equal(dry.status, 200);

  const va = mkRes();
  await handleApi(
    mkReq("POST", "/api/apps", JSON.stringify({ repo: "org/x", validateOnly: true })),
    va,
    deps({ createApp: async () => ({ ok: true, repoInfo: { name: "x", fullName: "org/x", private: false, defaultBranch: "main", description: null } }) }),
  );
  assert.equal(va.status, 200);
});

test("DELETE /api/apps/:name passes purge and 200s", async () => {
  let got: { name: string; purge: boolean } | undefined;
  const res = mkRes();
  await handleApi(
    mkReq("DELETE", "/api/apps/shop?purge=1"),
    res,
    deps({ deleteApp: (name, purge) => { got = { name, purge }; return { removed: [`config:${name}`] }; } }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(got, { name: "shop", purge: true });
});

test("DELETE /api/apps/:name without purge passes purge=false", async () => {
  let got: { name: string; purge: boolean } | undefined;
  const res = mkRes();
  await handleApi(
    mkReq("DELETE", "/api/apps/shop"),
    res,
    deps({ deleteApp: (name, purge) => { got = { name, purge }; return { removed: [`config:${name}`] }; } }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(got, { name: "shop", purge: false });
});

test("DELETE /api/apps/:name on a missing app returns 404", async () => {
  const res = mkRes();
  await handleApi(
    mkReq("DELETE", "/api/apps/shop"),
    res,
    deps({ deleteApp: () => { throw new Error("config/apps/shop.yaml not found — is the app onboarded?"); } }),
  );
  assert.equal(res.status, 404);
});

test("DELETE /api/apps/:name without the dep returns 501", async () => {
  const res = mkRes();
  await handleApi(mkReq("DELETE", "/api/apps/shop"), res, deps({}));
  assert.equal(res.status, 501);
});

test("PUT /api/apps/:name delegates to updateApp and 200s", async () => {
  let got: { name: string; body: unknown } | undefined;
  const res = mkRes();
  await handleApi(
    mkReq("PUT", "/api/apps/shop", JSON.stringify({ baseUrl: "https://new.dev.io" })),
    res,
    deps({
      updateApp: async (input) => {
        got = { name: input.name, body: input };
        return { ok: true, name: "shop" };
      },
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(got?.name, "shop");
});

test("PUT /api/apps/:name maps validation failure to 422", async () => {
  const res = mkRes();
  await handleApi(
    mkReq("PUT", "/api/apps/shop", JSON.stringify({ baseUrl: "bad" })),
    res,
    deps({
      updateApp: async () => ({ ok: false, errors: ["bad url"] }),
    }),
  );
  assert.equal(res.status, 422);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.errors, ["bad url"]);
});

test("PUT /api/apps/:name without the dep returns 501", async () => {
  const res = mkRes();
  await handleApi(mkReq("PUT", "/api/apps/shop", JSON.stringify({ baseUrl: "https://x" })), res, deps({}));
  assert.equal(res.status, 501);
});
