// REST control API for the interactive layer (bin/qa) and any future operator
// surface. It NEVER does git writes directly: it only enqueues runs on the same
// sequential queue the webhook uses, and reads the in-memory run history. Every
// dependency (config, ref resolution, history, queue) is injected via ApiDeps, so
// the routing + validation logic is unit-tested with stubs — no fs or network.

import { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { RUN_MODES, RunMode, TestTarget, RunRecord } from "../types";
import { AppConfig } from "../orchestrator/config-loader";
import { sanitizeText } from "../orchestrator/sanitizer";
import { redactError } from "../util/redact";
import { buildRunContext, buildLearningContext, buildRunChatContext } from "./chat";
import { buildHelpContext } from "./help";
import { json, readBody } from "./helpers";
import { getOpenSessionCount, activityRouter } from "../integrations/opencode-client";
import type { CreateAppInput as AdminCreateAppInput, CreateAppResult, UpdateAppInput as AdminUpdateAppInput } from "./app-admin";
import {
  AgentConfigApplyResultSchema,
  AgentConfigUpdateSchema,
  AgentModelInfo,
  AgentModelsResponseSchema,
  AgentProvider,
  AgentProviderHealthSchema,
  AgentProviderSchema,
  AgentRestartRequestSchema,
  AgentRestartResponseSchema,
  AppViewSchema,
  AskResponseSchema,
  ContinueResultSchema,
  CreateAppInputSchema,
  CreateAppResultSchema,
  CreateRunResultSchema,
  DeleteAppResultSchema,
  PublicAgentConfig,
  PublicAgentConfigSchema,
  QueueStatusSchema,
  RepoListResponseSchema,
  RunRecordSchema,
  IntelligenceViewSchema,
  SignalsViewSchema,
  TrendsViewSchema,
  ReportViewSchema,
  RunReportViewSchema,
  UpdateAppInputSchema,
  VersionInfoSchema,
  LoginRequestSchema,
  LoginResponseSchema,
} from "../contract/commands";
import { RunEventSchema, type RunEvent } from "../contract/events";
import { handshake } from "./version";
import { reportToCsv, trendsToCsv } from "./report-view";
import type { RunEventStore } from "./run-events";
import type { AgentTurnRecord } from "./history";

const TARGETS: TestTarget[] = ["e2e", "code"];

// SSE durable-poll cadence: how often an open run-event stream re-reads the durable store
// for events produced out-of-process and re-checks the record for a terminal state. Small
// enough to feel live, large enough not to hammer SQLite per open connection.
const DEFAULT_SSE_POLL_MS = 1000;

// Outcome of exchanging a GitHub user token for a server session: a minted session on
// success, or a tagged failure the route maps to 401 (bad token) vs 403 (not a collaborator).
export type LoginOutcome =
  | { ok: true; token: string; username: string; expiresAt: string }
  | { ok: false; reason: "identity" | "forbidden" };

export interface ApiDeps {
  queue: { readonly size: number };
  enqueue(app: string, sha: string, target: TestTarget, mode: RunMode, guidance?: string, shadow?: boolean, commits?: number): string;
  loadApp(name: string): AppConfig; // throws if the app is not configured
  listApps(): AppConfig[];
  resolveRef(repo: string, ref: string): Promise<string>;
  getRecord(id: string): RunRecord | undefined;
  listRecords(app: string, limit: number): RunRecord[];
  currentRun(): RunRecord | undefined;
  // Read-only intelligence projection (learning ledger + oracle scorecard + curriculum)
  // for an app. Absent ⇒ the /intelligence route returns 501.
  intelligence?: (app: string) => z.infer<typeof IntelligenceViewSchema>;
  // Read-only fleet-wide integrity readout (ground-truth value-oracle vs. proxy pass-rate).
  // Absent ⇒ the /signals route returns 501.
  signals?: () => z.infer<typeof SignalsViewSchema>;
  // Read-only period-over-period trends + the ad-hoc interestingness-ranked report for an app.
  // Absent ⇒ the /trends and /report routes return 501.
  trends?: (app: string, window?: number) => z.infer<typeof TrendsViewSchema>;
  report?: (app: string, window?: number) => z.infer<typeof ReportViewSchema>;
  // The run-scoped report: the current-execution analysis plus the evolution-as-of-the-run, for the
  // post-run summary view. Outer null ⇒ 404 (no such run); `evolution` null ⇒ not enough history yet.
  reportForRun?: (runId: string, window?: number) => z.infer<typeof RunReportViewSchema> | null;
  ask?: (input: { context: string; question: string; instruction?: string }) => Promise<string>;
  cancelRun?: (id: string) => boolean;
  // Continuation (human-in-the-loop): re-run fixing the parent run's failed cases.
  // `cases` optionally narrows to specific failed case names; omitted → all failed.
  continueRun?: (parentId: string, cases: string[] | undefined, guidance?: string) => string;
  // App onboarding/deletion (F5). Absent ⇒ the corresponding routes return 501.
  createApp?: (input: AdminCreateAppInput) => Promise<CreateAppResult>;
  updateApp?: (input: AdminUpdateAppInput) => Promise<CreateAppResult>;
  deleteApp?: (name: string, purge: boolean) => { removed: string[] };
  listRepos?: (owner: string, page: number) => Promise<{ repos: Array<{ fullName: string; private: boolean; description: string | null }>; hasMore: boolean }>;
  runEvents?: RunEventStore;
  // Phase 0b: returns persisted agent_turns rows for a run (all roles, chronological).
  // Absent ⇒ the /api/runs/:id/turns route returns 501.
  getAgentTurns?: (runId: string) => AgentTurnRecord[];
  // Cadence (ms) of the SSE durable-poll loop in handleRunEvents. Injected so tests can drive
  // the poll fast; production uses DEFAULT_SSE_POLL_MS.
  ssePollMs?: number;
  // Exchange a GitHub user token for a server session (POST /api/auth/login). Absent ⇒ the
  // route returns 501 (GitHub login not configured); the static QA_API_TOKEN still works.
  login?: (githubToken: string) => Promise<LoginOutcome>;
  // The OAuth App client id (public) advertised in the version handshake, so the console can run
  // the device flow without baking it in. Absent ⇒ not advertised (client falls back to its own).
  githubClientId?: string;
  agentRuntime?: {
    getConfig(): PublicAgentConfig | Promise<PublicAgentConfig>;
    applyConfig(input: unknown): { config: PublicAgentConfig; restarted: AgentProvider[]; downgraded?: boolean } | Promise<{ config: PublicAgentConfig; restarted: AgentProvider[]; downgraded?: boolean }>;
    listModels(provider: AgentProvider): AgentModelInfo[] | Promise<AgentModelInfo[]>;
    restart(provider: AgentProvider): Promise<z.infer<typeof AgentProviderHealthSchema>> | z.infer<typeof AgentProviderHealthSchema>;
    hasOpenSessions?(): boolean;
  };
}

function contractJson(res: ServerResponse, status: number, schema: z.ZodTypeAny, body: unknown): void {
  const result = schema.safeParse(body);
  if (!result.success) {
    // Surface the drift loudly (CLAUDE.md invariant) — a silent 500 hides a real
    // schema mismatch between the handler and the contract.
    console.error("[contract] response validation failed:", result.error.issues);
    json(res, 500, { error: "contract response validation failed" });
    return;
  }
  json(res, status, result.data);
}

function sseWrite(res: ServerResponse, event: unknown): void {
  // Guard the write-after-close race: the bus is synchronous, so an event emitted
  // as the socket closes can reach here after the stream already ended.
  if (res.writableEnded) return;
  const result = RunEventSchema.safeParse(event);
  if (!result.success) {
    console.error("[sse] dropped malformed RunEvent:", result.error.issues);
    return;
  }
  const parsed = result.data;
  res.write(`id: ${parsed.seq}\n`);
  res.write(`event: ${parsed.body.type}\n`);
  res.write(`data: ${JSON.stringify(parsed)}\n\n`);
}

function parseLastEventId(req: IncomingMessage): number {
  const raw = req.headers["last-event-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return -1;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : -1;
}

// Returns true when the request matched an /api route (so the caller stops here).
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname.replace(/^\/api\/v1(?=\/|$)/, "/api");

  if (req.method === "POST" && path === "/api/runs") {
    return handleCreateRun(req, res, deps);
  }

  const eventMatch = path.match(/^\/api\/runs\/([^/]+)\/events$/);
  if (req.method === "GET" && eventMatch) {
    return handleRunEvents(req, res, deps, eventMatch[1]!);
  }

  // Phase 0b: per-run agent_turns (all roles, chronological).
  const turnsMatch = path.match(/^\/api\/runs\/([^/]+)\/turns$/);
  if (req.method === "GET" && turnsMatch) {
    return handleRunTurns(res, deps, turnsMatch[1]!);
  }

  const runMatch = path.match(/^\/api\/runs\/([^/]+)$/);
  if (req.method === "GET" && runMatch) {
    return handleGetRun(res, deps, runMatch[1]!);
  }
  if (req.method === "DELETE" && runMatch) {
    return handleCancelRun(res, deps, runMatch[1]!);
  }

  if (req.method === "GET" && path === "/api/runs") {
    return handleListRuns(res, deps, url.searchParams.get("app"), Number(url.searchParams.get("limit")) || 10);
  }

  const appMatch = path.match(/^\/api\/apps\/([^/]+)$/);
  if (req.method === "POST" && path === "/api/apps") {
    return await handleCreateApp(req, res, deps);
  }
  if (req.method === "PUT" && appMatch) {
    return await handleUpdateApp(req, res, deps, appMatch[1]!);
  }
  if (req.method === "DELETE" && appMatch) {
    return handleDeleteApp(res, deps, appMatch[1]!, url.searchParams.get("purge") === "1");
  }
  if (req.method === "GET" && appMatch) {
    return handleGetApp(res, deps, appMatch[1]!);
  }

  const intelMatch = path.match(/^\/api\/apps\/([^/]+)\/intelligence$/);
  if (req.method === "GET" && intelMatch) {
    return handleAppIntelligence(res, deps, intelMatch[1]!);
  }

  const trendsMatch = path.match(/^\/api\/apps\/([^/]+)\/trends$/);
  if (req.method === "GET" && trendsMatch) {
    return handleAppTrends(res, deps, trendsMatch[1]!, parseWindow(url.searchParams.get("window")), url.searchParams.get("format"));
  }

  const reportMatch = path.match(/^\/api\/apps\/([^/]+)\/report$/);
  if (req.method === "GET" && reportMatch) {
    return handleAppReport(res, deps, reportMatch[1]!, parseWindow(url.searchParams.get("window")), url.searchParams.get("format"));
  }

  const runReportMatch = path.match(/^\/api\/runs\/([^/]+)\/report$/);
  if (req.method === "GET" && runReportMatch) {
    return handleRunReport(res, deps, runReportMatch[1]!, parseWindow(url.searchParams.get("window")), url.searchParams.get("format"));
  }

  if (req.method === "GET" && path === "/api/signals") {
    return handleSignals(res, deps);
  }

  if (req.method === "GET" && path === "/api/apps") {
    return handleListApps(res, deps);
  }

  if (req.method === "GET" && path === "/api/repos") {
    return await handleListRepos(res, deps, url.searchParams.get("owner"), Number(url.searchParams.get("page")) || 1);
  }

  if (req.method === "GET" && path === "/api/queue") {
    return handleQueue(res, deps);
  }

  if (req.method === "GET" && path === "/api/health") {
    json(res, 200, { ok: true, openSessions: getOpenSessionCount() });
    return true;
  }

  if (req.method === "GET" && path === "/api/version") {
    contractJson(res, 200, VersionInfoSchema, handshake(url.searchParams.get("client") ?? undefined, deps.githubClientId));
    return true;
  }

  if (req.method === "POST" && path === "/api/auth/login") {
    return await handleLogin(req, res, deps);
  }

  if (req.method === "GET" && path === "/api/agent/config") {
    return await handleGetAgentConfig(res, deps);
  }
  if (req.method === "PUT" && path === "/api/agent/config") {
    return await handlePutAgentConfig(req, res, deps);
  }
  if (req.method === "GET" && path === "/api/agent/models") {
    return await handleAgentModels(res, deps, url.searchParams.get("provider"));
  }
  if (req.method === "POST" && path === "/api/agent/restart") {
    return await handleAgentRestart(req, res, deps);
  }

  const askMatch = path.match(/^\/api\/runs\/([^/]+)\/ask$/);
  if (req.method === "POST" && askMatch) {
    return await handleAsk(req, res, deps, askMatch[1]!);
  }

  const continueMatch = path.match(/^\/api\/runs\/([^/]+)\/continue$/);
  if (req.method === "POST" && continueMatch) {
    return await handleContinue(req, res, deps, continueMatch[1]!);
  }

  if (req.method === "POST" && path === "/api/help") {
    return await handleHelp(req, res, deps);
  }

  return false;
}

async function handleCreateRun(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<boolean> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "invalid JSON" });
    return true;
  }

  const appName = typeof body.app === "string" ? body.app : null;
  if (!appName) {
    json(res, 400, { error: "'app' is required (config/apps/<app>.yaml name)" });
    return true;
  }

  let appConfig: AppConfig;
  try {
    appConfig = deps.loadApp(appName);
  } catch {
    json(res, 404, { error: `app not found: '${appName}'` });
    return true;
  }

  const target: TestTarget =
    typeof body.target === "string" && (TARGETS as string[]).includes(body.target)
      ? (body.target as TestTarget)
      : appConfig.code
        ? "code" // default to code mode for code-mode apps
        : "e2e";
  const mode: RunMode =
    typeof body.mode === "string" && (RUN_MODES as readonly string[]).includes(body.mode) ? (body.mode as RunMode) : "diff";
  const guidance = typeof body.guidance === "string" ? body.guidance.slice(0, 2000) : undefined;
  const shadow = typeof body.shadow === "boolean" ? body.shadow : undefined;
  const commits =
    typeof body.commits === "number" && Number.isInteger(body.commits) && body.commits >= 1 && body.commits <= 20
      ? body.commits
      : undefined;

  let sha: string;
  if (typeof body.sha === "string" && /^[0-9a-f]{7,40}$/i.test(body.sha)) {
    sha = body.sha;
  } else if (typeof body.sha === "string" && body.sha.length > 0) {
    json(res, 400, { error: "'sha' must be 7–40 hex characters" });
    return true;
  } else {
    // Neither a sha nor an explicit ref: default to the app's base branch HEAD. This
    // is the TUI "launch" path (pick target/mode/shadow, no commit) — run the latest
    // of the configured branch. resolveRef uses `git ls-remote`, so no mirror is
    // required yet (works on the very first run).
    const ref = typeof body.ref === "string" && body.ref.length > 0 ? body.ref : (appConfig.baseBranch ?? "main");
    try {
      sha = await deps.resolveRef(appConfig.repo, ref);
    } catch (err) {
      json(res, 400, { error: redactError(err) });
      return true;
    }
  }

  let id: string;
  try {
    id = deps.enqueue(appConfig.name, sha, target, mode, guidance, shadow, commits);
  } catch (err) {
    json(res, 500, { error: `failed to enqueue run: ${err instanceof Error ? err.message : String(err)}` });
    return true;
  }
  if (!id) {
    json(res, 503, { error: "service shutting down" });
    return true;
  }
  contractJson(res, 202, CreateRunResultSchema, { id, app: appConfig.name, sha, target, mode, status: "enqueued" });
  return true;
}

// Sanitize a RunRecord before it leaves the system: logs, case details and the note can
// carry DEV data or a secret the agent echoed. Same egress invariant the chat/Issue paths
// already honor (CLAUDE.md "Sanitize data leaving the system").
function sanitizeRecord(record: RunRecord): RunRecord {
  return {
    ...record,
    note: record.note ? sanitizeText(record.note).text : record.note,
    logs: record.logs.map((l) => sanitizeText(l).text),
    cases: record.cases.map((c) => {
      // Omit `detail` entirely when absent. A DB-backed record yields detail:null (history stores
      // `c.detail ?? null`), but the contract is z.string().optional() (string|undefined, NOT null),
      // so passing null through here 500s the run-status API. Strip it (and sanitize when present).
      const { detail, ...rest } = c;
      return detail ? { ...rest, detail: sanitizeText(detail).text } : rest;
    }),
    activity: record.activity?.map((a) => ({ ...a, text: sanitizeText(a.text).text })),
  };
}

function handleGetRun(res: ServerResponse, deps: ApiDeps, id: string): boolean {
  const record = deps.getRecord(id);
  if (!record) {
    json(res, 404, { error: `run not found: ${id}` });
    return true;
  }
  contractJson(res, 200, RunRecordSchema, sanitizeRecord(record));
  return true;
}

function handleRunEvents(req: IncomingMessage, res: ServerResponse, deps: ApiDeps, id: string): boolean {
  if (!deps.runEvents) {
    json(res, 501, { error: "run event stream is not available" });
    return true;
  }
  const record = deps.getRecord(id);
  if (!record) {
    json(res, 404, { error: `run not found: ${id}` });
    return true;
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.writeHead(200);

  const runEvents = deps.runEvents; // narrowed past the 501 guard; stable for the closures below

  // Track the high-water seq streamed so the durable poll never re-sends an event the live
  // bus already delivered (and vice-versa).
  let lastSentSeq = parseLastEventId(req);
  const send = (event: RunEvent): void => {
    sseWrite(res, event);
    if (event.seq > lastSentSeq) lastSentSeq = event.seq;
  };

  for (const event of runEvents.replay(id, lastSentSeq)) send(event);

  // A terminated run emits nothing more: replay, then close so the client stops
  // waiting on a stream that will never produce another event.
  if (record.status === "done") {
    res.end();
    return true;
  }

  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: () => void = () => {};
  const finish = (): void => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    unsubscribe();
    if (!res.writableEnded) res.end();
  };

  // Live tail for a run executing IN THIS process: the in-process bus delivers each publish.
  unsubscribe = runEvents.subscribe(id, (event) => {
    send(event);
    // run.verdict is terminal — close the stream once the run finishes so the
    // connection (and its bus listener) is not held open indefinitely.
    if (event.body.type === "run.verdict") finish();
  });

  // Durable poll — the robustness net. The bus above only sees SAME-PROCESS publishes, so a
  // run produced by another process (e.g. the CLI's own queue) would otherwise stream nothing
  // and never close. Each tick (a) flushes events persisted since lastSentSeq — surfacing an
  // out-of-process run's progress through the shared store — then (b) ends the stream once the
  // record is terminal, so a missed/absent run.verdict can never leave the connection hanging.
  const pollMs = deps.ssePollMs ?? DEFAULT_SSE_POLL_MS;
  timer = setInterval(() => {
    if (closed) return;
    for (const event of runEvents.replay(id, lastSentSeq)) send(event);
    // Close only on an EXPLICIT terminal record. getRecord is durable (SQLite), so a missing
    // record mid-stream is anomalous — treating it as terminal could drop a healthy stream, so
    // we don't; the run record reaching "done" is the single close trigger here.
    if (deps.getRecord(id)?.status === "done") finish();
  }, pollMs);
  timer.unref?.();

  // Client disconnect → tear everything down. The write-after-close race is also guarded
  // centrally in sseWrite (writableEnded), so a late event is a no-op.
  req.on("close", () => finish());
  return true;
}

// Phase 0b: returns the persisted agent_turns rows for a run as a JSON array (all roles,
// chronological). Mirrors the existing run-scoped endpoints' shape and error handling.
function handleRunTurns(res: ServerResponse, deps: ApiDeps, id: string): boolean {
  if (!deps.getAgentTurns) {
    json(res, 501, { error: "agent turns are not available" });
    return true;
  }
  const record = deps.getRecord(id);
  if (!record) {
    json(res, 404, { error: `run not found: ${id}` });
    return true;
  }
  json(res, 200, deps.getAgentTurns(id));
  return true;
}

function handleCancelRun(res: ServerResponse, deps: ApiDeps, id: string): boolean {
  if (!deps.cancelRun) {
    json(res, 501, { error: "cancel is not available" });
    return true;
  }

  const record = deps.getRecord(id);
  if (!record) {
    json(res, 404, { error: `run not found: ${id}` });
    return true;
  }

  if (record.status !== "running" && record.status !== "enqueued") {
    json(res, 409, { error: `run ${id} is not running (status: ${record.status})` });
    return true;
  }

  const cancelled = deps.cancelRun(id);
  if (cancelled) {
    json(res, 200, { id, status: "cancelled" });
  } else if (deps.getRecord(id)?.status === "done") {
    // cancelRun returned false but finalized the record: it was either still enqueued (pulled
    // from the queue before it could start) or a stale "running" record the live queue no longer
    // held (finalized so the operator's stop clears it). Either way it is no longer active.
    json(res, 200, { id, status: "cancelled", message: "run was not actively executing — finalized and removed from the queue" });
  } else {
    // Running per the (stale) record, but it is no longer the run holding the queue —
    // it already finished or a successor is now executing. Do NOT report it cancelled.
    json(res, 409, { id, status: "running", message: "run is no longer the active run (it finished or a successor is now running)" });
  }
  return true;
}

function handleListRuns(res: ServerResponse, deps: ApiDeps, app: string | null | undefined, limit: number): boolean {
  if (!app) {
    json(res, 400, { error: "?app=<name> query parameter is required" });
    return true;
  }
  contractJson(res, 200, z.array(RunRecordSchema), deps.listRecords(app, limit).map(sanitizeRecord));
  return true;
}

function appView(app: AppConfig): { name: string; repo: string; baseUrl: string; versionUrl: string; code: boolean; shadow: boolean; needsReview: boolean; testDataPrefix: string; services: Array<{ repo: string; openapi?: string; versionUrl?: string }> } {
  // Code-mode apps have no dev environment (and no baseUrl).
  return {
    name: app.name,
    repo: app.repo,
    baseUrl: app.dev?.baseUrl ?? "",
    versionUrl: app.dev?.versionUrl ?? "",
    code: app.code ?? false,
    shadow: app.qa.shadow ?? false,
    needsReview: app.qa.needsReview,
    testDataPrefix: app.qa.testDataPrefix,
    services: (app.services ?? []).map((s) => ({
      repo: s.repo,
      openapi: typeof s.openapi === "string" ? s.openapi : s.openapi?.[0],
      versionUrl: s.versionUrl,
    })),
  };
}

function handleGetApp(res: ServerResponse, deps: ApiDeps, name: string): boolean {
  try {
    contractJson(res, 200, AppViewSchema, appView(deps.loadApp(name)));
  } catch {
    json(res, 404, { error: `app not found: '${name}'` });
  }
  return true;
}

function handleAppIntelligence(res: ServerResponse, deps: ApiDeps, name: string): boolean {
  if (!deps.intelligence) {
    json(res, 501, { error: "intelligence is not available" });
    return true;
  }
  try {
    deps.loadApp(name); // 404 when the app isn't configured
  } catch {
    json(res, 404, { error: `app not found: '${name}'` });
    return true;
  }
  contractJson(res, 200, IntelligenceViewSchema, deps.intelligence(name));
  return true;
}

function handleSignals(res: ServerResponse, deps: ApiDeps): boolean {
  if (!deps.signals) {
    json(res, 501, { error: "signals is not available" });
    return true;
  }
  contractJson(res, 200, SignalsViewSchema, deps.signals());
  return true;
}

// A client-supplied trends window (?window=N), clamped to [1,50] — listRunOutcomes caps the read at
// 100 rows, so the current + previous windows (window*2) must stay within it. Invalid/absent →
// undefined (the view falls back to its default of 20).
function parseWindow(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return Math.min(n, 50);
}

function handleAppTrends(
  res: ServerResponse,
  deps: ApiDeps,
  name: string,
  window?: number,
  format?: string | null,
): boolean {
  if (!deps.trends) {
    json(res, 501, { error: "trends is not available" });
    return true;
  }
  try {
    deps.loadApp(name); // 404 when the app isn't configured
  } catch {
    json(res, 404, { error: `app not found: '${name}'` });
    return true;
  }
  const trends = deps.trends(name, window);
  if (format === "csv") {
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
    res.end(trendsToCsv(trends));
    return true;
  }
  contractJson(res, 200, TrendsViewSchema, trends);
  return true;
}

function handleAppReport(
  res: ServerResponse,
  deps: ApiDeps,
  name: string,
  window?: number,
  format?: string | null,
): boolean {
  if (!deps.report) {
    json(res, 501, { error: "report is not available" });
    return true;
  }
  try {
    deps.loadApp(name);
  } catch {
    json(res, 404, { error: `app not found: '${name}'` });
    return true;
  }
  const report = deps.report(name, window);
  // ?format=csv → a spreadsheet-friendly flat table (one row per insight); default stays the
  // contract-validated JSON ReportView.
  if (format === "csv") {
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
    res.end(reportToCsv(report));
    return true;
  }
  contractJson(res, 200, ReportViewSchema, report);
  return true;
}

function handleRunReport(
  res: ServerResponse,
  deps: ApiDeps,
  runId: string,
  window?: number,
  format?: string | null,
): boolean {
  if (!deps.reportForRun) {
    json(res, 501, { error: "report is not available" });
    return true;
  }
  const report = deps.reportForRun(runId, window);
  if (!report) {
    json(res, 404, { error: `run not found: '${runId}'` });
    return true;
  }
  // CSV exports the run's OWN facts (the current-execution report); the evolution half belongs to a
  // chart, not a flat table, and the app-level /report?format=csv already exports the trend table.
  if (format === "csv") {
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
    res.end(reportToCsv(report.current));
    return true;
  }
  contractJson(res, 200, RunReportViewSchema, report);
  return true;
}

function handleListApps(res: ServerResponse, deps: ApiDeps): boolean {
  const apps: Array<{ name: string; repo: string; baseUrl: string; shadow: boolean }> = [];
  for (const app of deps.listApps()) {
    try {
      apps.push(appView(app));
    } catch {
      // A single malformed config should not hide every other app.
    }
  }
  contractJson(res, 200, z.array(AppViewSchema), apps);
  return true;
}

function handleQueue(res: ServerResponse, deps: ApiDeps): boolean {
  const running = deps.currentRun();
  contractJson(res, 200, QueueStatusSchema, {
    pending: deps.queue.size,
    running: running ? { id: running.id, app: running.app } : null,
  });
  return true;
}

async function handleGetAgentConfig(res: ServerResponse, deps: ApiDeps): Promise<boolean> {
  if (!deps.agentRuntime) {
    json(res, 501, { error: "agent runtime configuration is not available" });
    return true;
  }
  try {
    contractJson(res, 200, PublicAgentConfigSchema, await deps.agentRuntime.getConfig());
  } catch (err) {
    json(res, 502, { error: `agent runtime failed: ${redactError(err)}` });
  }
  return true;
}

async function handlePutAgentConfig(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<boolean> {
  if (!deps.agentRuntime) {
    json(res, 501, { error: "agent runtime configuration is not available" });
    return true;
  }
  if (isAgentRuntimeBusy(deps)) {
    json(res, 409, { error: "agent runtime cannot be changed while a run or agent session is active" });
    return true;
  }

  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "invalid JSON" });
    return true;
  }
  const parsed = AgentConfigUpdateSchema.safeParse(body);
  if (!parsed.success) {
    json(res, 400, { error: "invalid agent runtime config", issues: parsed.error.issues });
    return true;
  }

  try {
    const result = await deps.agentRuntime.applyConfig(parsed.data);
    contractJson(res, 200, AgentConfigApplyResultSchema, result);
  } catch (err) {
    const message = redactError(err);
    json(res, runtimeStatusFromErrorMessage(message), { error: message });
  }
  return true;
}

async function handleAgentModels(res: ServerResponse, deps: ApiDeps, rawProvider: string | null): Promise<boolean> {
  if (!deps.agentRuntime) {
    json(res, 501, { error: "agent runtime configuration is not available" });
    return true;
  }
  const provider = AgentProviderSchema.safeParse(rawProvider);
  if (!provider.success) {
    json(res, 400, { error: "?provider=opencode|codex is required" });
    return true;
  }
  try {
    const models = await deps.agentRuntime.listModels(provider.data);
    contractJson(res, 200, AgentModelsResponseSchema, { provider: provider.data, models });
  } catch (err) {
    json(res, 502, { error: `failed to list agent models: ${redactError(err)}` });
  }
  return true;
}

async function handleAgentRestart(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<boolean> {
  if (!deps.agentRuntime) {
    json(res, 501, { error: "agent runtime configuration is not available" });
    return true;
  }
  if (isAgentRuntimeBusy(deps)) {
    json(res, 409, { error: "agent runtime cannot be restarted while a run or agent session is active" });
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "invalid JSON" });
    return true;
  }
  const parsed = AgentRestartRequestSchema.safeParse(body);
  if (!parsed.success) {
    json(res, 400, { error: "invalid restart request", issues: parsed.error.issues });
    return true;
  }
  try {
    const health = await deps.agentRuntime.restart(parsed.data.provider);
    contractJson(res, 200, AgentRestartResponseSchema, { health });
  } catch (err) {
    json(res, 502, { error: `failed to restart agent provider: ${redactError(err)}` });
  }
  return true;
}

function isAgentRuntimeBusy(deps: ApiDeps): boolean {
  const run = deps.currentRun();
  return run?.status === "running" || run?.status === "enqueued" || deps.agentRuntime?.hasOpenSessions?.() === true;
}

function runtimeStatusFromErrorMessage(message: string): number {
  if (message.includes("confirmSingleDowngrade") || message.includes("active") || message.includes("session")) return 409;
  if (message.includes("model") || message.includes("API_KEY") || message.includes("required") || message.includes("invalid")) return 422;
  return 502;
}

async function handleAsk(req: IncomingMessage, res: ServerResponse, deps: ApiDeps, id: string): Promise<boolean> {
  const record = deps.getRecord(id);
  if (!record) {
    json(res, 404, { error: `run not found: ${id}` });
    return true;
  }

  if (!deps.ask) {
    json(res, 501, { error: "ask is not available" });
    return true;
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "invalid JSON" });
    return true;
  }

  let question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) {
    json(res, 400, { error: "'question' is required" });
    return true;
  }
  // Truncate to prevent context window exhaustion
  const MAX_QUESTION_LEN = 4000;
  if (question.length > MAX_QUESTION_LEN) {
    question = question.substring(0, MAX_QUESTION_LEN) + " [truncated]";
  }

  const historyLines: string[] = [];
  if (Array.isArray(body.history)) {
    for (const entry of body.history) {
      if (typeof entry === "object" && entry !== null && "role" in entry && "text" in entry) {
        historyLines.push(`${entry.role === "q" ? "Operator" : "Assistant"}: ${String((entry as { text: unknown }).text)}`);
      }
    }
  }

  try {
    // Load app config so the assistant knows what repo is being tested and where.
    let appInfo: { repo: string; baseUrl?: string } | undefined;
    try {
      const cfg = deps.loadApp(record.app);
      appInfo = { repo: cfg.repo, baseUrl: cfg.dev?.baseUrl };
    } catch { /* app not configured — proceed without */ }

    // Context is bounded (cases + logs capped) and sanitized on ingress (secrets redacted).
    const activityCtx = activityRouter.contextForRun(record.id);
    const learningCtx = buildLearningContext(record.app);
    const runCtx = buildRunContext(record, undefined, appInfo, activityCtx || undefined, learningCtx || undefined);
    const productCtx = buildRunChatContext();
    const historyCtx = historyLines.length > 0 ? `\n\nRecent conversation:\n${historyLines.slice(-6).join("\n")}` : "";
    const answer = await deps.ask({ context: `${productCtx}\n\n---\n\n${runCtx}${historyCtx}`, question });
    // Sanitize on egress (logs→chat is a new egress path).
    contractJson(res, 200, AskResponseSchema, { answer: sanitizeText(answer).text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, 502, { error: `assistant failed: ${msg}` });
  }
  return true;
}

async function handleHelp(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<boolean> {
  if (!deps.ask) {
    json(res, 501, { error: "help chat is not available (ask not wired)" });
    return true;
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "invalid JSON" });
    return true;
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) {
    json(res, 400, { error: "'question' is required" });
    return true;
  }

  const historyLines: string[] = [];
  if (Array.isArray(body.history)) {
    for (const entry of body.history) {
      if (typeof entry === "object" && entry !== null && "role" in entry && "text" in entry) {
        const role = String((entry as { role: unknown }).role);
        const text = String((entry as { text: unknown }).text);
        historyLines.push(`${role}: ${text}`);
      }
    }
  }

  const productContext = buildHelpContext();
  let fullContext = productContext;
  if (historyLines.length > 0) {
    fullContext += `\n\n## Recent conversation\n${historyLines.slice(-10).join("\n")}`;
  }

  try {
    const answer = await deps.ask({
      context: fullContext,
      question,
      instruction:
        "You are a helpful assistant answering questions about panchito (the TUI for ai-pipeline). " +
        "Use ONLY the context below. " +
        "TERMINAL-FRIENDLY FORMATTING (this renders in a TUI via Ink <Text>): " +
        "allowed: blank lines, indentation, capitalized headers (RESUMEN, USO), " +
        "plain text lists with '-', '───' separators between topics. " +
        "forbidden: **bold**, `code`, # headings, code fences, emojis, HTML. " +
        "Respond in the SAME language as the question. Be concise. " +
        "If the context lacks the answer, say so and suggest what to ask instead.",
    });
    contractJson(res, 200, AskResponseSchema, { answer: sanitizeText(answer).text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, 502, { error: `assistant failed: ${msg}` });
  }
  return true;
}

// Exchange a GitHub user token (obtained by the client via the OAuth device flow) for a
// short-lived server session. The deps.login closure does the GitHub verification + repo
// authorization + session minting; this handler is pure validation + status mapping:
// 400 malformed, 401 bad/unknown GitHub token, 403 authenticated-but-not-a-collaborator.
async function handleLogin(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<boolean> {
  if (!deps.login) {
    json(res, 501, { error: "GitHub login is not configured on this server" });
    return true;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "invalid JSON" });
    return true;
  }

  const parsed = LoginRequestSchema.safeParse(raw);
  if (!parsed.success) {
    json(res, 400, { error: "'githubToken' is required" });
    return true;
  }

  try {
    const outcome = await deps.login(parsed.data.githubToken);
    if (outcome.ok) {
      contractJson(res, 200, LoginResponseSchema, {
        token: outcome.token,
        username: outcome.username,
        expiresAt: outcome.expiresAt,
      });
    } else if (outcome.reason === "forbidden") {
      json(res, 403, { error: "this GitHub account cannot push to any watched repo" });
    } else {
      json(res, 401, { error: "the GitHub token was rejected" });
    }
  } catch (err) {
    // A GitHub API outage is infra, not a credential problem — surface it loudly, don't
    // masquerade it as a 401 (which would send the operator chasing a non-existent token bug).
    const msg = err instanceof Error ? err.message : String(err);
    json(res, 502, { error: `GitHub login failed: ${msg}` });
  }
  return true;
}

// Continuation: re-run the parent's FAILED cases with optional human guidance. The
// data model (parentRunId/fixCases) and pipeline support this; this is the HTTP entry
// the TUI's `continue` command calls.
async function handleContinue(req: IncomingMessage, res: ServerResponse, deps: ApiDeps, parentId: string): Promise<boolean> {
  const parent = deps.getRecord(parentId);
  if (!parent) {
    json(res, 404, { error: `run not found: ${parentId}` });
    return true;
  }
  if (!deps.continueRun) {
    json(res, 501, { error: "continue is not available" });
    return true;
  }
  if (parent.status !== "done") {
    json(res, 409, { error: `run ${parentId} is not finished yet (status: ${parent.status})` });
    return true;
  }
  const failedNames = new Set(parent.cases.filter((c) => c.status === "fail").map((c) => c.name));
  if (failedNames.size === 0) {
    json(res, 409, { error: `run ${parentId} has no failed cases to continue` });
    return true;
  }

  // Optional body: { cases?: string[], guidance?: string }.
  let cases: string[] | undefined;
  let guidance: string | undefined;
  try {
    const raw = await readBody(req);
    if (raw.trim()) {
      const body = JSON.parse(raw) as Record<string, unknown>;
      guidance = typeof body.guidance === "string" ? body.guidance.slice(0, 2000) : undefined;
      if (Array.isArray(body.cases)) cases = body.cases.filter((c): c is string => typeof c === "string");
    }
  } catch {
    json(res, 400, { error: "invalid JSON" });
    return true;
  }

  // If specific cases were requested, they must name actual failed cases of the parent
  // (otherwise the continuation would have nothing to fix).
  if (cases && cases.length > 0) {
    const unknown = cases.filter((c) => !failedNames.has(c));
    if (unknown.length > 0) {
      json(res, 409, { error: `not failed cases of ${parentId}: ${unknown.join(", ")}` });
      return true;
    }
  }

  const id = deps.continueRun(parentId, cases, guidance);
  if (!id) {
    json(res, 503, { error: "service shutting down" });
    return true;
  }
  contractJson(res, 202, ContinueResultSchema, { id, parentRunId: parentId, app: parent.app, sha: parent.sha, status: "enqueued" });
  return true;
}

async function handleCreateApp(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<boolean> {
  if (!deps.createApp) {
    json(res, 501, { error: "app onboarding is not available" });
    return true;
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "invalid JSON" });
    return true;
  }
  const parsed = CreateAppInputSchema.safeParse(body);
  if (!parsed.success) {
    json(res, 400, { error: "invalid app create input", issues: parsed.error.issues });
    return true;
  }
  if (!parsed.data.repo.includes("/")) {
    json(res, 400, { error: "'repo' is required in 'org/name' form" });
    return true;
  }
  try {
    const result = await deps.createApp(parsed.data as AdminCreateAppInput);
    if (!result.ok) {
      json(res, 422, { errors: result.errors ?? ["invalid app config"] });
      return true;
    }
    // env VALUES never travel back; CreateAppResult only carries the key names.
    contractJson(res, parsed.data.dryRun || parsed.data.validateOnly ? 200 : 201, CreateAppResultSchema, result);
  } catch (err) {
    json(res, 500, { error: redactError(err) });
  }
  return true;
}

async function handleUpdateApp(req: IncomingMessage, res: ServerResponse, deps: ApiDeps, name: string): Promise<boolean> {
  if (!deps.updateApp) {
    json(res, 501, { error: "app update is not available" });
    return true;
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "invalid JSON" });
    return true;
  }
  const parsed = UpdateAppInputSchema.safeParse(body);
  if (!parsed.success) {
    json(res, 400, { error: "invalid app update input", issues: parsed.error.issues });
    return true;
  }
  try {
    const result = await deps.updateApp({ ...parsed.data, name } as AdminUpdateAppInput);
    if (!result.ok) {
      json(res, 422, { errors: result.errors ?? ["invalid app config"] });
      return true;
    }
    contractJson(res, 200, CreateAppResultSchema, result);
  } catch (err) {
    json(res, 500, { error: redactError(err) });
  }
  return true;
}

function handleDeleteApp(res: ServerResponse, deps: ApiDeps, name: string, purge: boolean): boolean {
  if (!deps.deleteApp) {
    json(res, 501, { error: "app deletion is not available" });
    return true;
  }
  try {
    contractJson(res, 200, DeleteAppResultSchema, deps.deleteApp(name, purge));
  } catch (err) {
    const msg = redactError(err);
    json(res, msg.includes("not found") ? 404 : 500, { error: msg });
  }
  return true;
}

async function handleListRepos(res: ServerResponse, deps: ApiDeps, owner: string | null, page: number): Promise<boolean> {
  if (!owner) {
    json(res, 400, { error: "'owner' query parameter is required (e.g. /api/repos?owner=arielyumn)" });
    return true;
  }
  if (!deps.listRepos) {
    json(res, 501, { error: "repo listing is not available" });
    return true;
  }
  try {
    const result = await deps.listRepos(owner, page);
    contractJson(res, 200, RepoListResponseSchema, result);
  } catch (err) {
    const msg = redactError(err);
    const status = msg.includes("not found") || msg.includes("no repos found") ? 404
      : msg.includes("token") || msg.includes("GITHUB_TOKEN") ? 401
      : 500;
    json(res, status, { error: msg });
  }
  return true;
}
