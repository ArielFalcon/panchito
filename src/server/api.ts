// REST control API for the interactive layer (bin/qa) and any future operator
// surface. It NEVER does git writes directly: it only enqueues runs on the same
// sequential queue the webhook uses, and reads the in-memory run history. Every
// dependency (config, ref resolution, history, queue) is injected via ApiDeps, so
// the routing + validation logic is unit-tested with stubs — no fs or network.

import { IncomingMessage, ServerResponse } from "node:http";
import { RunMode, TestTarget, RunRecord } from "../types";
import { AppConfig } from "../orchestrator/config-loader";
import { sanitizeText } from "../orchestrator/sanitizer";
import { buildRunContext } from "./chat";
import { buildHelpContext } from "./help";
import { json, readBody } from "./helpers";
import { getOpenSessionCount, activityRouter } from "../integrations/opencode-client";

const MODES: RunMode[] = ["diff", "complete", "exhaustive", "manual"];
const TARGETS: TestTarget[] = ["e2e", "code"];

export interface ApiDeps {
  queue: { readonly size: number };
  enqueue(app: string, sha: string, target: TestTarget, mode: RunMode, guidance?: string, shadow?: boolean): string;
  loadApp(name: string): AppConfig; // throws if the app is not configured
  listApps(): AppConfig[];
  resolveRef(repo: string, ref: string): Promise<string>;
  getRecord(id: string): RunRecord | undefined;
  listRecords(app: string, limit: number): RunRecord[];
  currentRun(): RunRecord | undefined;
  ask?: (input: { context: string; question: string; instruction?: string }) => Promise<string>;
  cancelRun?: (id: string) => boolean;
  // Continuation (human-in-the-loop): re-run fixing the parent run's failed cases.
  // `cases` optionally narrows to specific failed case names; omitted → all failed.
  continueRun?: (parentId: string, cases: string[] | undefined, guidance?: string) => string;
}

// Returns true when the request matched an /api route (so the caller stops here).
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (req.method === "POST" && path === "/api/runs") {
    return handleCreateRun(req, res, deps);
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
  if (req.method === "GET" && appMatch) {
    return handleGetApp(res, deps, appMatch[1]!);
  }

  if (req.method === "GET" && path === "/api/apps") {
    return handleListApps(res, deps);
  }

  if (req.method === "GET" && path === "/api/queue") {
    return handleQueue(res, deps);
  }

  if (req.method === "GET" && path === "/api/health") {
    json(res, 200, { ok: true, openSessions: getOpenSessionCount() });
    return true;
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
    typeof body.mode === "string" && (MODES as string[]).includes(body.mode) ? (body.mode as RunMode) : "diff";
  const guidance = typeof body.guidance === "string" ? body.guidance : undefined;
  const shadow = typeof body.shadow === "boolean" ? body.shadow : undefined;

  let sha: string;
  if (typeof body.sha === "string" && /^[0-9a-f]{7,40}$/i.test(body.sha)) {
    sha = body.sha;
  } else if (typeof body.sha === "string" && body.sha.length > 0) {
    json(res, 400, { error: "'sha' must be 7–40 hex characters" });
    return true;
  } else if (typeof body.ref === "string") {
    try {
      sha = await deps.resolveRef(appConfig.repo, body.ref);
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }
  } else {
    json(res, 400, { error: "either 'sha' or 'ref' is required" });
    return true;
  }

  let id: string;
  try {
    id = deps.enqueue(appConfig.name, sha, target, mode, guidance, shadow);
  } catch (err) {
    json(res, 500, { error: `failed to enqueue run: ${err instanceof Error ? err.message : String(err)}` });
    return true;
  }
  json(res, 202, { id, app: appConfig.name, sha, target, mode, status: "enqueued" });
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
    cases: record.cases.map((c) => (c.detail ? { ...c, detail: sanitizeText(c.detail).text } : c)),
  };
}

function handleGetRun(res: ServerResponse, deps: ApiDeps, id: string): boolean {
  const record = deps.getRecord(id);
  if (!record) {
    json(res, 404, { error: `run not found: ${id}` });
    return true;
  }
  json(res, 200, sanitizeRecord(record));
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
  } else {
    json(res, 200, { id, status: "enqueued", message: "run was enqueued, not running — removed from queue" });
  }
  return true;
}

function handleListRuns(res: ServerResponse, deps: ApiDeps, app: string | null | undefined, limit: number): boolean {
  if (!app) {
    json(res, 400, { error: "?app=<name> query parameter is required" });
    return true;
  }
  json(res, 200, deps.listRecords(app, limit).map(sanitizeRecord));
  return true;
}

function appView(app: AppConfig): { name: string; repo: string; baseUrl: string; code: boolean; shadow: boolean } {
  // Code-mode apps have no dev environment (and no baseUrl).
  return {
    name: app.name,
    repo: app.repo,
    baseUrl: app.dev?.baseUrl ?? "",
    code: app.code ?? false,
    shadow: app.qa.shadow ?? false,
  };
}

function handleGetApp(res: ServerResponse, deps: ApiDeps, name: string): boolean {
  try {
    json(res, 200, appView(deps.loadApp(name)));
  } catch {
    json(res, 404, { error: `app not found: '${name}'` });
  }
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
  json(res, 200, apps);
  return true;
}

function handleQueue(res: ServerResponse, deps: ApiDeps): boolean {
  const running = deps.currentRun();
  json(res, 200, {
    pending: deps.queue.size,
    running: running ? { id: running.id, app: running.app } : null,
  });
  return true;
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

  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) {
    json(res, 400, { error: "'question' is required" });
    return true;
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
    const context = buildRunContext(record, undefined, appInfo, activityCtx || undefined);
    const answer = await deps.ask({ context, question });
    // Sanitize on egress (logs→chat is a new egress path).
    json(res, 200, { answer: sanitizeText(answer).text });
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
        "Use ONLY the context below. Be concise and friendly. If the context does not contain " +
        "the answer, say so and suggest what the user could ask instead.",
    });
    json(res, 200, { answer: sanitizeText(answer).text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, 502, { error: `assistant failed: ${msg}` });
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
      guidance = typeof body.guidance === "string" ? body.guidance : undefined;
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
  json(res, 202, { id, parentRunId: parentId, app: parent.app, sha: parent.sha, status: "enqueued" });
  return true;
}
