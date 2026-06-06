import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handleApi, ApiDeps } from "./api";
import { RunRecord } from "../types";

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
    writeHead(s: number) {
      this.status = s;
    },
    end(b?: string) {
      this.body = b ?? "";
    },
  };
}

const appConfig: any = { name: "demo", repo: "org/demo", dev: { baseUrl: "https://dev" }, qa: { shadow: true } };

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

test("POST /api/runs with a sha enqueues and returns 202", async () => {
  const res = mkRes();
  const ok = await handleApi(mkReq("POST", "/api/runs", JSON.stringify({ app: "demo", sha: "abc1234", mode: "diff" })), res, deps());
  assert.equal(ok, true);
  assert.equal(res.status, 202);
  assert.match(res.body, /run-xyz/);
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

test("GET /api/apps lists configured apps", async () => {
  const res = mkRes();
  await handleApi(mkReq("GET", "/api/apps"), res, deps());
  assert.equal(res.status, 200);
  assert.match(res.body, /demo/);
});

test("GET /api/queue reports pending count and the running id", async () => {
  const running: RunRecord = { id: "r1", app: "demo", sha: "abc", target: "e2e", mode: "diff", status: "running", cases: [], logs: [], at: "t" };
  const res = mkRes();
  await handleApi(mkReq("GET", "/api/queue"), res, deps({ currentRun: () => running }));
  assert.equal(res.status, 200);
  assert.match(res.body, /"pending":2/);
  assert.match(res.body, /"id":"r1"/);
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
