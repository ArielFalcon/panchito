import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handleApi, ApiDeps } from "./api";
import { toTrendsView } from "./trends-view";
import { toReportView } from "./report-view";
import { RunRecord, RunOutcome } from "../types";
import {
  AgentConfigApplyResultSchema,
  AgentModelsResponseSchema,
  AgentRestartResponseSchema,
  AppViewSchema,
  CreateAppResultSchema,
  CreateRunResultSchema,
  DeleteAppResultSchema,
  PublicAgentConfigSchema,
  QueueStatusSchema,
  RepoListResponseSchema,
  RunRecordSchema,
} from "../contract/commands";
import { RunEventSchema, RunEvent } from "../contract/events";
import { createRunEventStore, RunEventStore } from "./run-events";

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

test("GET /api/v1/version returns the handshake and judges client compatibility", async () => {
  const ok = await handleApi(mkReq("GET", "/api/v1/version?client=0.0.1"), mkRes(), deps());
  assert.equal(ok, true);

  const res = mkRes();
  await handleApi(mkReq("GET", "/api/v1/version?client=0.1.0"), res, deps());
  assert.equal(res.status, 200);
  const info = JSON.parse(res.body);
  assert.equal(info.serverVersion, "0.1.0");
  assert.equal(info.apiVersion, "v1");
  assert.equal(info.compatible, true);
  assert.ok(Array.isArray(info.capabilities) && info.capabilities.includes("agent-runtime"));

  const old = mkRes();
  await handleApi(mkReq("GET", "/api/v1/version?client=0.0.1"), old, deps());
  assert.equal(JSON.parse(old.body).compatible, false);
});

test("GET /api/version advertises the configured GitHub OAuth client id (and omits it otherwise)", async () => {
  const withId = mkRes();
  await handleApi(mkReq("GET", "/api/version"), withId, deps({ githubClientId: "Ov23cid" }));
  assert.equal(JSON.parse(withId.body).githubClientId, "Ov23cid");

  const without = mkRes();
  await handleApi(mkReq("GET", "/api/version"), without, deps());
  assert.equal(JSON.parse(without.body).githubClientId, undefined);
});

test("GET /api/signals returns the fleet integrity view, or 501 when not wired", async () => {
  const notWired = mkRes();
  await handleApi(mkReq("GET", "/api/v1/signals"), notWired, deps());
  assert.equal(notWired.status, 501);

  const res = mkRes();
  await handleApi(mkReq("GET", "/api/v1/signals"), res, deps({
    signals: () => ({
      valueOracle: { measured: true, avgScore: 0.8, measuredRuns: 10, totalRuns: 20 },
      reviewer: { passRate: 0.5, runs: 4 },
      coverage: { measured: false, avgRatio: null, measuredRuns: 0, totalRuns: 0 },
    }),
  }));
  assert.equal(res.status, 200);
  const view = JSON.parse(res.body);
  assert.equal(view.valueOracle.avgScore, 0.8);
  assert.equal(view.coverage.measured, false);
});

test("GET /api/apps/:name/trends and /api/apps/:name/report return 501 when not wired", async () => {
  const t = mkRes();
  await handleApi(mkReq("GET", "/api/v1/apps/demo/trends"), t, deps());
  assert.equal(t.status, 501);
  const r = mkRes();
  await handleApi(mkReq("GET", "/api/v1/apps/demo/report"), r, deps());
  assert.equal(r.status, 501);
});

test("GET /api/apps/:name/trends and /report return 200 and pass contractJson egress validation", async () => {
  const outcome = (verdict: RunOutcome["verdict"], coverageRatio: number | null): RunOutcome => ({
    runId: "r",
    app: "demo",
    sha: "s",
    mode: "diff",
    target: "e2e",
    verdict,
    errorClass: null,
    gateSignals: { static: true, coverageRatio, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
    rulesRetrieved: [],
    at: "2026-01-01T00:00:00Z",
  });
  const outcomes = [outcome("pass", 0.8), outcome("fail", 0.4)];
  const trends = (app: string) => toTrendsView({ app, outcomes, now: "2026-06-14T00:00:00Z" });

  const t = mkRes();
  await handleApi(
    mkReq("GET", "/api/v1/apps/demo/trends"),
    t,
    deps({ trends }),
  );
  assert.equal(t.status, 200);
  assert.equal(JSON.parse(t.body).app, "demo");

  const r = mkRes();
  await handleApi(
    mkReq("GET", "/api/v1/apps/demo/report"),
    r,
    deps({ trends, report: (app) => toReportView(trends(app)) }),
  );
  assert.equal(r.status, 200);
  const report = JSON.parse(r.body);
  assert.equal(report.app, "demo");
  assert.ok(Array.isArray(report.insights));
});

test("GET /report?format=csv returns CSV and ?window= is threaded to the dep", async () => {
  const outcome = (verdict: RunOutcome["verdict"], coverageRatio: number | null): RunOutcome => ({
    runId: "r", app: "demo", sha: "s", mode: "diff", target: "e2e", verdict, errorClass: null,
    gateSignals: { static: true, coverageRatio, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
    rulesRetrieved: [], at: "2026-01-01T00:00:00Z",
  });
  const outcomes = [outcome("pass", 0.8), outcome("fail", 0.4)];
  let seenWindow: number | undefined;
  const trends = (app: string, window?: number) => {
    seenWindow = window;
    return toTrendsView({ app, outcomes, now: "2026-06-14T00:00:00Z", window });
  };
  const r = mkRes();
  await handleApi(
    mkReq("GET", "/api/v1/apps/demo/report?format=csv&window=5"),
    r,
    deps({ trends, report: (app, window) => toReportView(trends(app, window)) }),
  );
  assert.equal(r.status, 200);
  assert.match(r.body, /^id,title,intent,chart,value,unit,delta,multiplier,direction,goodWhen,score/);
  assert.equal(seenWindow, 5); // ?window= reached the dep through the report path
});

test("GET /runs/:id/report returns {current, evolution}; CSV exports current; 404 when unknown", async () => {
  const rep = toReportView(toTrendsView({ app: "demo", outcomes: [], now: "2026-06-14T00:00:00Z" }));
  const runReport = { current: rep, evolution: null };

  const ok = mkRes();
  await handleApi(mkReq("GET", "/api/v1/runs/r1/report"), ok, deps({ reportForRun: () => runReport }));
  assert.equal(ok.status, 200);
  const body = JSON.parse(ok.body);
  assert.equal(body.current.app, "demo"); // the current-execution analysis
  assert.equal(body.evolution, null); // no history yet ⇒ evolution withheld

  // CSV exports the run's OWN facts (the current report's insight table).
  const csv = mkRes();
  await handleApi(mkReq("GET", "/api/v1/runs/r1/report?format=csv"), csv, deps({ reportForRun: () => runReport }));
  assert.equal(csv.status, 200);
  assert.match(csv.body, /^id,title,intent,chart,value/);

  const missing = mkRes();
  await handleApi(mkReq("GET", "/api/v1/runs/nope/report"), missing, deps({ reportForRun: () => null }));
  assert.equal(missing.status, 404);
});

test("GET /trends?format=csv returns a flat CSV", async () => {
  const trends = (app: string) => toTrendsView({ app, outcomes: [], now: "2026-06-14T00:00:00Z" });
  const r = mkRes();
  await handleApi(mkReq("GET", "/api/v1/apps/demo/trends?format=csv"), r, deps({ trends }));
  assert.equal(r.status, 200);
  assert.match(r.body, /^metric,current,previous/);
});

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

test("GET /api/runs/:id: a null/absent case detail does not 500 the contract (egress omits it)", async () => {
  // history stores a detail-less case as detail:null; the contract is z.string().optional() (no null),
  // so the egress must OMIT it — else the run-status API 500s and the CLI/TUI loses sight of the run.
  const record = {
    id: "r1", app: "demo", sha: "abc", target: "e2e", mode: "exhaustive", status: "running", verdict: "pass",
    cases: [{ name: "owners › list", status: "pass", detail: null }, { name: "vets › table", status: "fail", detail: "boom" }],
    logs: [], at: "t",
  } as unknown as RunRecord;
  const res = mkRes();
  await handleApi(mkReq("GET", "/api/runs/r1"), res, deps({ getRecord: () => record }));
  assert.equal(res.status, 200, "a null-detail case must not 500 the contract");
  assert.doesNotMatch(res.body, /"detail":\s*null/, "null detail must be omitted, not serialized");
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

test("POST /api/runs without sha or ref defaults to the app base branch (TUI launch)", async () => {
  let seen = "";
  const res = mkRes();
  await handleApi(
    mkReq("POST", "/api/runs", JSON.stringify({ app: "demo" })),
    res,
    deps({
      resolveRef: async (_repo, ref) => {
        seen = ref;
        return "b".repeat(40);
      },
    }),
  );
  assert.equal(seen, "main"); // appConfig has no baseBranch → defaults to "main"
  assert.equal(res.status, 202);
});

test("POST /api/runs honors a configured baseBranch when no sha/ref is given", async () => {
  let seen = "";
  const res = mkRes();
  await handleApi(
    mkReq("POST", "/api/runs", JSON.stringify({ app: "demo" })),
    res,
    deps({
      loadApp: () => ({ ...appConfig, baseBranch: "develop" }),
      resolveRef: async (_repo, ref) => {
        seen = ref;
        return "c".repeat(40);
      },
    }),
  );
  assert.equal(seen, "develop");
  assert.equal(res.status, 202);
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

const publicAgentConfig = {
  mode: "single" as const,
  singleProvider: "opencode" as const,
  assignments: {
    primary: { provider: "opencode" as const, model: "opencode-go/deepseek-v4-pro" },
    reviewer: { provider: "opencode" as const, model: "opencode-go/minimax-m3" },
    chat: { provider: "opencode" as const, model: "opencode-go/deepseek-v4-flash" },
  },
  keys: { opencode: true, codex: false },
  validation: { ok: true, errors: [] },
  health: {
    opencode: { provider: "opencode" as const, status: "healthy" as const, configured: true },
  },
};

test("GET /api/agent/config returns sanitized runtime config", async () => {
  const res = mkRes();
  const ok = await handleApi(mkReq("GET", "/api/agent/config"), res, deps({
    agentRuntime: {
      getConfig: async () => publicAgentConfig,
      applyConfig: async () => ({ config: publicAgentConfig, restarted: [] }),
      listModels: async () => [],
      restart: async () => ({ provider: "opencode", status: "healthy", configured: true }),
    },
  }));
  assert.equal(ok, true);
  assert.equal(res.status, 200);
  PublicAgentConfigSchema.parse(JSON.parse(res.body));
  assert.doesNotMatch(res.body, /sk-|opencode-secret|codex-secret/);
});

test("GET /api/agent/models returns models for one provider", async () => {
  const res = mkRes();
  await handleApi(mkReq("GET", "/api/agent/models?provider=codex"), res, deps({
    agentRuntime: {
      getConfig: async () => publicAgentConfig,
      applyConfig: async () => ({ config: publicAgentConfig, restarted: [] }),
      listModels: async (provider) => [{ id: "gpt-5.4", label: "GPT-5.4", provider }],
      restart: async () => ({ provider: "codex", status: "healthy", configured: true }),
    },
  }));
  assert.equal(res.status, 200);
  assert.deepEqual(AgentModelsResponseSchema.parse(JSON.parse(res.body)).models.map((m) => m.id), ["gpt-5.4"]);
});

test("PUT /api/agent/config applies runtime config without echoing api keys", async () => {
  const res = mkRes();
  let seen: unknown;
  await handleApi(
    mkReq("PUT", "/api/agent/config", JSON.stringify({ mode: "single", singleProvider: "codex", apiKeys: { codex: "sk-codex-secret" } })),
    res,
    deps({
      agentRuntime: {
        getConfig: async () => publicAgentConfig,
        applyConfig: async (input) => {
          seen = input;
          return { config: { ...publicAgentConfig, singleProvider: "codex", keys: { opencode: true, codex: true } }, restarted: ["codex"] };
        },
        listModels: async () => [],
        restart: async () => ({ provider: "codex", status: "healthy", configured: true }),
      },
    }),
  );
  assert.equal(res.status, 200);
  assert.equal((seen as any).apiKeys.codex, "sk-codex-secret");
  AgentConfigApplyResultSchema.parse(JSON.parse(res.body));
  assert.doesNotMatch(res.body, /sk-codex-secret/);
});

test("PUT /api/agent/config blocks while a run is active", async () => {
  const res = mkRes();
  let applied = false;
  const running: RunRecord = { id: "r1", app: "demo", sha: "abc", target: "e2e", mode: "diff", status: "running", cases: [], logs: [], at: "t" };
  await handleApi(
    mkReq("PUT", "/api/agent/config", JSON.stringify({ mode: "single", singleProvider: "codex" })),
    res,
    deps({
      currentRun: () => running,
      agentRuntime: {
        getConfig: async () => publicAgentConfig,
        applyConfig: async () => {
          applied = true;
          return { config: publicAgentConfig, restarted: [] };
        },
        listModels: async () => [],
        restart: async () => ({ provider: "codex", status: "healthy", configured: true }),
      },
    }),
  );
  assert.equal(res.status, 409);
  assert.equal(applied, false);
});

test("POST /api/agent/restart restarts one provider", async () => {
  const res = mkRes();
  await handleApi(mkReq("POST", "/api/agent/restart", JSON.stringify({ provider: "opencode" })), res, deps({
    agentRuntime: {
      getConfig: async () => publicAgentConfig,
      applyConfig: async () => ({ config: publicAgentConfig, restarted: [] }),
      listModels: async () => [],
      restart: async (provider) => ({ provider, status: "healthy", configured: true }),
    },
  }));
  assert.equal(res.status, 200);
  assert.equal(AgentRestartResponseSchema.parse(JSON.parse(res.body)).health.provider, "opencode");
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
  CreateAppResultSchema.parse(body);
  assert.equal(body.name, "shop");
});

test("GET /api/v1/apps/:name validates AppView output against the contract", async () => {
  const res = mkRes();
  await handleApi(mkReq("GET", "/api/v1/apps/demo"), res, deps());
  assert.equal(res.status, 200);
  assert.equal(AppViewSchema.parse(JSON.parse(res.body)).name, "demo");
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

test("app onboarding error responses redact credentials from thrown errors", async () => {
  const res = mkRes();
  await handleApi(
    mkReq("POST", "/api/apps", JSON.stringify({ repo: "org/x" })),
    res,
    deps({ createApp: async () => { throw new Error("upstream failed: Authorization: Bearer secret-token"); } }),
  );

  assert.equal(res.status, 500);
  assert.doesNotMatch(res.body, /secret-token/);
  assert.match(res.body, /\[REDACTED_CREDENTIAL\]/);
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
  DeleteAppResultSchema.parse(JSON.parse(res.body));
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
  CreateAppResultSchema.parse(JSON.parse(res.body));
});

test("GET /api/v1/repos validates repo list output against the contract", async () => {
  const res = mkRes();
  await handleApi(
    mkReq("GET", "/api/v1/repos?owner=org&page=2"),
    res,
    deps({ listRepos: async (owner, page) => ({
      repos: [{ fullName: `${owner}/shop`, private: false, description: `page ${page}` }],
      hasMore: false,
    }) }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(RepoListResponseSchema.parse(JSON.parse(res.body)).repos.map((r) => r.fullName), ["org/shop"]);
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

// ── POST /api/auth/login (GitHub session exchange) ────────────────────────────
test("POST /api/auth/login exchanges a GitHub token for a session", async () => {
  const res = mkRes();
  const ok = await handleApi(
    mkReq("POST", "/api/v1/auth/login", JSON.stringify({ githubToken: "gho_x" })),
    res,
    deps({ login: async () => ({ ok: true, token: "sess.jwt.sig", username: "alice", expiresAt: "2026-06-15T00:00:00Z" }) }),
  );
  assert.equal(ok, true);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.token, "sess.jwt.sig");
  assert.equal(body.username, "alice");
  assert.equal(body.expiresAt, "2026-06-15T00:00:00Z");
});

test("POST /api/auth/login maps a rejected GitHub token to 401", async () => {
  const res = mkRes();
  await handleApi(
    mkReq("POST", "/api/auth/login", JSON.stringify({ githubToken: "bad" })),
    res,
    deps({ login: async () => ({ ok: false, reason: "identity" }) }),
  );
  assert.equal(res.status, 401);
});

test("POST /api/auth/login maps a non-collaborator to 403", async () => {
  const res = mkRes();
  await handleApi(
    mkReq("POST", "/api/auth/login", JSON.stringify({ githubToken: "gho_x" })),
    res,
    deps({ login: async () => ({ ok: false, reason: "forbidden" }) }),
  );
  assert.equal(res.status, 403);
});

test("POST /api/auth/login without a githubToken is 400", async () => {
  const res = mkRes();
  await handleApi(
    mkReq("POST", "/api/auth/login", JSON.stringify({})),
    res,
    deps({ login: async () => ({ ok: true, token: "x", username: "y", expiresAt: "z" }) }),
  );
  assert.equal(res.status, 400);
});

test("POST /api/auth/login without the dep wired returns 501", async () => {
  const res = mkRes();
  await handleApi(mkReq("POST", "/api/auth/login", JSON.stringify({ githubToken: "gho_x" })), res, deps({}));
  assert.equal(res.status, 501);
});

// ── SSE stream robustness (OBS): the stream must never hang, and must surface events
// produced by ANOTHER process whose publishes never reach this server's in-process bus. ──

async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met within " + timeoutMs + "ms");
    await new Promise((r) => setTimeout(r, 4));
  }
}

// A store whose live subscription NEVER fires — models a run executing in a different
// process (the event bus is in-process, so this server's subscribe() can't see it).
function outOfProcessStore(persisted: RunEvent[]): RunEventStore {
  return {
    publish: () => { throw new Error("publish is not used in this test"); },
    replay: (_id, after = -1) => persisted.filter((e) => e.seq > after),
    subscribe: () => () => {},
  };
}

test("the SSE stream ends when the run goes terminal even without a run.verdict event (out-of-process)", async () => {
  let status: "running" | "done" = "running";
  const record = (): RunRecord => ({ id: "r1", app: "demo", sha: "abc", target: "e2e", mode: "diff", status, cases: [], logs: [], at: "t" });
  const req = mkReq("GET", "/api/v1/runs/r1/events");
  const res = mkRes();
  let ended = false;
  const origEnd = res.end.bind(res);
  res.end = (b?: string) => { ended = true; res.writableEnded = true; origEnd(b); };

  await handleApi(req, res, deps({ getRecord: () => record(), runEvents: outOfProcessStore([]), ssePollMs: 5 }));
  assert.equal(ended, false); // still running → the stream stays open

  status = "done"; // the run is finalized by the other process in the shared record store
  await waitUntil(() => ended, 400);
  assert.equal(ended, true);
});

test("the SSE poll flushes events persisted by another process (the in-process bus never fired)", async () => {
  const persisted: RunEvent[] = [];
  const record: RunRecord = { id: "r1", app: "demo", sha: "abc", target: "e2e", mode: "diff", status: "running", cases: [], logs: [], at: "t" };
  const req = mkReq("GET", "/api/v1/runs/r1/events");
  const res = mkRes();

  await handleApi(req, res, deps({ getRecord: () => record, runEvents: outOfProcessStore(persisted), ssePollMs: 5 }));

  // Another process persists an event AFTER we connected; only the durable poll can surface it.
  persisted.push({ seq: 0, runId: "r1", ts: 1, body: { type: "step.changed", step: "execute" } } as RunEvent);
  await waitUntil(() => res.writes.join("").includes("step.changed"), 400);
  assert.match(res.writes.join(""), /event: step.changed/);
  req.emit("close"); // stop the poll
});

// Phase 0b: GET /api/runs/:id/turns — per-run agent_turns endpoint.
// Spec scenario: "Per-role cache trends retrievable".

test("phase-0b: GET /api/runs/:id/turns returns 501 when getAgentTurns is not wired", async () => {
  const record: RunRecord = { id: "r1", app: "demo", sha: "abc", target: "e2e", mode: "diff", status: "done", cases: [], logs: [], at: "t" };
  const res = mkRes();
  await handleApi(mkReq("GET", "/api/v1/runs/r1/turns"), res, deps({ getRecord: () => record }));
  assert.equal(res.status, 501);
  assert.match(res.body, /not available/i);
});

test("phase-0b: GET /api/runs/:id/turns returns 404 when the run is not found", async () => {
  const res = mkRes();
  await handleApi(
    mkReq("GET", "/api/v1/runs/missing-run/turns"),
    res,
    deps({ getAgentTurns: () => [], getRecord: () => undefined }),
  );
  assert.equal(res.status, 404);
  assert.match(res.body, /not found/i);
});

test("phase-0b: GET /api/runs/:id/turns returns the saved turns for the run as a JSON array", async () => {
  const record: RunRecord = { id: "r1", app: "demo", sha: "abc", target: "e2e", mode: "diff", status: "done", cases: [], logs: [], at: "t" };
  const stubTurns = [
    {
      runId: "r1", sessionId: "s1", role: "qa-generator", round: 0, isRepair: false,
      ts: "2026-06-16T00:00:00.000Z", objective: "feat: add login",
      promptText: "generate tests", outputText: "tests done",
      promptBytes: 14, tokensInput: 100, tokensOutput: 50,
      tokensReasoning: 0, tokensCacheRead: 20, tokensCacheWrite: 5, cost: 0.001,
    },
    {
      runId: "r1", sessionId: "s2", role: "qa-reviewer", round: 0, isRepair: false,
      ts: "2026-06-16T00:01:00.000Z", objective: "feat: add login",
      promptText: "review tests", outputText: '{"approved":true,"corrections":[],"rationale":"ok"}',
      promptBytes: 12, tokensInput: 80, tokensOutput: 30,
      tokensReasoning: null, tokensCacheRead: 10, tokensCacheWrite: 3, cost: 0.0008,
    },
  ];
  const res = mkRes();
  await handleApi(
    mkReq("GET", "/api/v1/runs/r1/turns"),
    res,
    deps({ getRecord: () => record, getAgentTurns: () => stubTurns as any }),
  );
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body), "response must be a JSON array");
  assert.equal(body.length, 2, "both turns must be returned");
  assert.equal(body[0].role, "qa-generator");
  assert.equal(body[1].role, "qa-reviewer");
  // Phase 0b keystone: the reviewer turn must carry a non-null run_id
  assert.equal(body[1].runId, "r1", "reviewer turn must have the parent run's runId");
});

test("phase-0b: GET /api/runs/:id/turns returns an empty array when no turns exist for the run", async () => {
  const record: RunRecord = { id: "r1", app: "demo", sha: "abc", target: "e2e", mode: "diff", status: "done", cases: [], logs: [], at: "t" };
  const res = mkRes();
  await handleApi(
    mkReq("GET", "/api/v1/runs/r1/turns"),
    res,
    deps({ getRecord: () => record, getAgentTurns: () => [] }),
  );
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body, []);
});
