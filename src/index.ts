import { createServer, IncomingMessage } from "node:http";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { writeFileSync, readFileSync, chmodSync, rmSync, unlinkSync } from "node:fs";
import { JobQueue } from "./server/queue";
import { handleWebhook } from "./server/webhook";
import { loadAppConfig, loadAppConfigsByRepo, listAppConfigs } from "./orchestrator/config-loader";
import { handleApi, ApiDeps } from "./server/api";
import { toIntelligenceView } from "./server/intelligence-view";
import { toSignalsView } from "./server/signals-view";
import { createRunEventStore } from "./server/run-events";
import type { RunEvent } from "./contract/events";
import { handleMaintainerApi, recordIncident, getMaintainerStatus, getIncidents } from "./server/maintainer";
import { getRecord, listRecords, currentRun, updateRecord, interruptedRecords, continuationDepth, MAX_CONTINUATION_DEPTH, listLearningRules, loadScorecard, loadCurriculum } from "./server/history";
import { enqueueTrackedRun } from "./server/runner";
import { defaultPipelineDeps } from "./pipeline";
import { pruneMirrors, defaultMirrorPruneDeps } from "./server/mirror-prune";
import { createMaintainerRuntime } from "./server/maintainer-runtime";
import { installHttpDispatcher } from "./util/net";
import { resolveRef, defaultMirrorDeps } from "./integrations/repo-mirror";
import { askAssistant, AgentDeps, getOpenSessionCount } from "./integrations/opencode-client";
import { createAgentRuntimeManager } from "./server/agent-runtime";
import { CodexRuntimeStrategy, OpenCodeRuntimeStrategy } from "./agent-runtime";
import { appendLog, appendActivity, deleteAppHistory, runVerdictCounts, saveRunEvent, loadRunEvents } from "./server/history";
import { type RunMode, type TestTarget } from "./types";
import { github } from "./integrations/github";
import { createApp as adminCreateApp, updateApp as adminUpdateApp, deleteApp as adminDeleteApp, type AppAdminDeps } from "./server/app-admin";
import { writeConfig, configExists } from "./server/onboard";
import { applyEnvVars, defaultEnvStoreFs } from "./server/env-store";
import { logJson } from "./integrations/logger";

const SELF_REPO = process.env.AI_PIPELINE_REPO ?? "ArielFalcon/ai-pipeline";
const ROOT = process.env.AI_PIPELINE_ROOT ?? process.cwd();
const TOKEN_FILE = join(ROOT, "config", ".api_token");
const runEvents = createRunEventStore({
  // Durable backing (OBS-01): the live SSE stream survives a restart (e.g. the maintainer
  // hot-swap's process.exit) and eviction from the in-memory ring.
  persist: (e) => saveRunEvent({ runId: e.runId, seq: e.seq, ts: e.ts, body: e.body }),
  loadPersisted: (runId, afterSeq) =>
    loadRunEvents(runId, afterSeq).map((r) => ({ seq: r.seq, runId: r.runId, ts: r.ts, body: r.body }) as RunEvent),
});
// The maintainer's autonomous merge+hot-swap is OFF by default. Opt-in with
// SELF_MAINTAINER_AUTOMERGE=true (requires branch protection on the self-repo).
const AUTONOMOUS_MAINTAINER = process.env.SELF_MAINTAINER_AUTOMERGE === "true";

const port = Number(process.env.PORT ?? 8080);
const MAX_BODY = 1_000_000;
const secret = process.env.WEBHOOK_SECRET;

// API token: env var wins. If absent, reuse the persisted file so the TUI
// can discover it across restarts. Only generate a new one if neither exists.
let apiToken: string;
if (process.env.QA_API_TOKEN) {
  apiToken = process.env.QA_API_TOKEN;
} else {
  try {
    apiToken = readFileSync(TOKEN_FILE, "utf8").trim();
    if (!apiToken) throw new Error("empty token file");
    chmodSync(TOKEN_FILE, 0o600); // enforce restrictive perms even on a pre-existing file
  } catch {
    apiToken = randomBytes(32).toString("hex");
    writeFileSync(TOKEN_FILE, apiToken, { mode: 0o600 });
    chmodSync(TOKEN_FILE, 0o600);
    console.log(`[qa] auto-generated QA_API_TOKEN → ${TOKEN_FILE}`);
  }
}

// Fail closed on the webhook surface: without a configured secret, signatures cannot
// be verified, so an unauthenticated POST could enqueue runs for any configured repo.
// Reject unsigned webhooks unless explicitly opted in (local dev).
const ALLOW_UNSIGNED_WEBHOOK = process.env.WEBHOOK_ALLOW_UNSIGNED === "true";
if (!secret && !ALLOW_UNSIGNED_WEBHOOK) {
  console.warn(
    "[qa] CRITICAL: WEBHOOK_SECRET is not set — webhook POSTs will be REJECTED. " +
      "Set WEBHOOK_SECRET, or set WEBHOOK_ALLOW_UNSIGNED=true to accept unsigned webhooks (local only).",
  );
}

const queue = new JobQueue((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("[qa] run failed:", e);
  // Incidents are recorded by the runner (with infra-vs-code classification).
  // This handler only fires for truly unhandled rejections that escape the job's
  // own catch — duplicates there would create maintainer noise for infra blips.
});

let shuttingDown = false;
const SHUTDOWN_TIMEOUT_MS = 25_000;
const eventStreamController = new AbortController();
const agentRuntime = createAgentRuntimeManager({
  env: process.env,
  fs: defaultEnvStoreFs(),
  strategies: {
    opencode: new OpenCodeRuntimeStrategy({ env: process.env }),
    codex: new CodexRuntimeStrategy({ env: process.env }),
  },
  hasOpenSessions: () => getOpenSessionCount() > 0,
});

function currentAgentDeps(): AgentDeps {
  return agentRuntime.facade().deps();
}

function currentPipelineDeps() {
  return defaultPipelineDeps({
    agentDepsFactory: async () => currentAgentDeps(),
    hasOpenSessions: () => agentRuntime.hasOpenSessions(),
  });
}

// Auto-maintenance runtime (ARCH-01): the self-deploy path lives in maintainer-runtime.ts; the
// entrypoint only wires it to the values it owns (queue, agent deps, the shuttingDown setter, the
// repo identity, the port). The destructured handles keep the existing call sites unchanged.
const maintainer = createMaintainerRuntime({
  queue,
  getAgentDeps: currentAgentDeps,
  setShuttingDown: (v) => {
    shuttingDown = v;
  },
  root: ROOT,
  selfRepo: SELF_REPO,
  autonomous: AUTONOMOUS_MAINTAINER,
  port,
});
const { triggerMaintainer, confirmSwapAfterBoot, recoverMaintainerState, recoverRollbackRecord } = maintainer;

process.on("SIGTERM", () => {
  console.log("[qa] SIGTERM received — cancelling in-flight run and draining");
  shuttingDown = true;
  eventStreamController.abort();

  // Cancel the in-flight job: abort its signal so the pipeline's checkSignal()
  // unwinds deterministically, letting teardown/cleanup run before exit.
  queue.cancel();

  // Drain: wait for the cancelled job's finally block. If it takes too long,
  // force-exit so the orchestrator doesn't hang the host process indefinitely.
  const drainTimer = setTimeout(() => {
    console.log("[qa] shutdown timeout — forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  queue.drain().finally(() => {
    clearTimeout(drainTimer);
    console.log("[qa] drained — exiting");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("[qa] SIGINT received — cancelling in-flight run and draining");
  shuttingDown = true;
  eventStreamController.abort();
  queue.cancel();
  const drainTimer = setTimeout(() => {
    console.log("[qa] shutdown timeout — forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  queue.drain().finally(() => {
    clearTimeout(drainTimer);
    console.log("[qa] drained — exiting");
    process.exit(0);
  });
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error("[qa] unhandled rejection:", reason instanceof Error ? reason.stack ?? msg : msg);
  recordIncident({ source: "qa-generator", severity: "error", summary: `unhandled rejection: ${msg}` });
});

function enqueueApiRun(app: string, sha: string, target: string, mode: RunMode, guidance?: string, shadow?: boolean, commits?: number, triggerRepo?: string): string {
  if (shuttingDown) {
    console.warn(`[qa] rejecting run ${app}@${sha} — shutting down`);
    return "";
  }
  // Orphan-data cleanup is reconstructed inside enqueueTrackedRun (the single funnel), so
  // every trigger gets it — not just this webhook path.
  return enqueueTrackedRun(queue, { app, sha, target: target as TestTarget, mode, guidance, shadow, commits, source: "webhook", triggerRepo }, { runEvents, pipeline: currentPipelineDeps() });
}

// Orphan-session sweep threshold. Must always exceed the longest possible agent
// turn: when an operator raises OPENCODE_TIMEOUT_MS above 30 min, a live session
// would otherwise be deleted mid-prompt. The 5-min buffer covers dispose/teardown.
const MAX_SESSION_AGE_MS = Math.max(
  30 * 60 * 1000,
  (Number(process.env.OPENCODE_TIMEOUT_MS) || 0) + 5 * 60 * 1000,
);

async function cleanupOrphanedSessions(): Promise<void> {
  const deps = currentAgentDeps();
  if (!deps.cleanupOrphans) return;
  try {
    const cleaned = await deps.cleanupOrphans(MAX_SESSION_AGE_MS);
    if (cleaned > 0) {
      recordIncident({ source: "health-check", severity: "warn", summary: `cleaned up ${cleaned} orphaned OpenCode session(s)` });
    }
  } catch (err) {
    console.warn(`[qa] orphan session cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function generatePrometheusMetrics(queue: JobQueue, openSessions: number): string {
  const lines: string[] = [];
  lines.push(`# HELP panchito_queue_depth Current depth of the job queue`);
  lines.push(`# TYPE panchito_queue_depth gauge`);
  lines.push(`panchito_queue_depth ${queue.size}`);
  lines.push(`# HELP panchito_open_sessions Number of open OpenCode sessions`);
  lines.push(`# TYPE panchito_open_sessions gauge`);
  lines.push(`panchito_open_sessions ${openSessions}`);
  // Completed runs by verdict (OBS-05) — the metric an operator alerts on (fail/invalid/
  // infra-error rate shift). Sourced from the durable runs table, never a wrong-when-restarted
  // in-memory counter. Always emit the known verdict labels so a 0 is explicit (no missing series).
  let counts: Record<string, number> = {};
  try {
    counts = runVerdictCounts();
  } catch (err) {
    console.warn(`[qa] metrics: verdict counts unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  lines.push(`# HELP panchito_runs_total Completed runs by verdict`);
  lines.push(`# TYPE panchito_runs_total counter`);
  for (const verdict of ["pass", "fail", "flaky", "invalid", "infra-error", "skipped"]) {
    lines.push(`panchito_runs_total{verdict="${verdict}"} ${counts[verdict] ?? 0}`);
  }
  return lines.join("\n");
}

let backupTick = 0;
let pruneTick = 0;
const PRUNE_INTERVAL_TICKS = 360; // 6 hours (360 × 60 s)

function startHealthPoller(): void {
  let fails = 0;
  let lastQueueWarn = 0;
  setInterval(async () => {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`);
      if (!res.ok) throw new Error(`health probe returned ${res.status}`);
      fails = 0;
    } catch {
      fails++;
      if (fails === 3) {
        recordIncident({ source: "health-check", severity: "critical", summary: "orchestrator health check failing (3 consecutive failures)" });
      }
      if (fails === 10) {
        recordIncident({ source: "health-check", severity: "critical", summary: "orchestrator health check failing (10 consecutive failures — likely crashed)" });
      }
    }
    await cleanupOrphanedSessions();
    const depth = queue.size;
    if (depth > 10 && lastQueueWarn <= 10) {
      recordIncident({ source: "health-check", severity: "warn", summary: `queue depth is ${depth} (possible stuck job)` });
    }
    lastQueueWarn = depth;

    const pending = getIncidents().filter((i) => i.status === "pending");
    if (pending.length > 0 && getMaintainerStatus() === "idle") {
      triggerMaintainer();
    }

    // SQLite backup every 24h (1440 ticks at 60s intervals)
    backupTick++;
    if (backupTick >= 1440) {
      backupTick = 0;
      const { backupDatabase } = await import("./server/history");
      const r = await backupDatabase();
      if (r.backedUp) {
        logJson("info", "SQLite backup created", { path: r.path });
      } else if (r.error) {
        logJson("warn", "SQLite backup failed", { error: r.error });
      }
    }

    // Mirror prune every 6h (360 ticks at 60s intervals)
    pruneTick++;
    if (pruneTick >= PRUNE_INTERVAL_TICKS) {
      pruneTick = 0;
      pruneMirrors(defaultMirrorPruneDeps(() => queue.current));
    }
  }, 60_000);
}

function finalizeInterruptedRuns(): void {
  const zombies = interruptedRecords();
  if (zombies.length === 0) {
    console.log("[qa] no interrupted runs from previous process — queue is clean");
    return;
  }
  console.log(`[qa] recovering ${zombies.length} interrupted run(s) from previous process...`);
  for (const r of zombies) {
    updateRecord(r.id, {
      status: "done",
      step: "done",
      verdict: "infra-error",
      note: "process restarted — run was interrupted",
    });
    console.log(`[qa]   finalized ${r.id} (${r.app}@${r.sha.slice(0, 7)}) as infra-error`);
  }
  console.log(`[qa] recovery complete — ${zombies.length} run(s) marked as infra-error`);
}

function authorized(req: IncomingMessage): boolean {
  if (!apiToken) return false;
  const header = req.headers["authorization"];
  if (typeof header !== "string") return false;
  const expected = `Bearer ${apiToken}`;
  // Constant-time comparison (avoid leaking the token via response timing).
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const ASSISTANT_CWD = "/tmp";

// Server-side app onboarding/deletion deps (F5): the orchestrator owns the GitHub
// token, the config dir and the mirror cache, so the TUI never touches them directly.
const appAdminDeps: AppAdminDeps = {
  getRepoInfo: (repo) => github.getRepo(repo),
  configExists: (name) => configExists(name, ROOT),
  writeConfig: (name, yaml) => writeConfig(name, yaml, ROOT),
  deleteConfig: (name) => unlinkSync(join(ROOT, "config", "apps", `${name}.yaml`)),
  deleteMirror: (repo) => rmSync(join(process.env.MIRROR_DIR ?? join(ROOT, ".mirrors"), repo.replaceAll("/", "__")), { recursive: true, force: true }),
  deleteHistory: (app) => deleteAppHistory(app),
  applyEnv: (vars) => applyEnvVars(vars, { fs: defaultEnvStoreFs(), env: process.env }),
  loadApp: (name) => loadAppConfig(name),
  env: process.env,
};

const apiDeps: ApiDeps = {
  queue,
  enqueue: enqueueApiRun,
  loadApp: (name) => loadAppConfig(name),
  listApps: () => listAppConfigs(),
  createApp: (input) => adminCreateApp(input, appAdminDeps),
  updateApp: (input) => adminUpdateApp(input, appAdminDeps),
  deleteApp: (name, purge) => adminDeleteApp(name, purge, appAdminDeps),
  listRepos: (owner, page) => github.listRepos(owner, page),
  runEvents,
  resolveRef: (repo, ref) => resolveRef(repo, ref, defaultMirrorDeps),
  getRecord,
  listRecords,
  currentRun,
  intelligence: (app) => toIntelligenceView(app, listLearningRules(app), loadScorecard(app), loadCurriculum(app)),
  signals: () => toSignalsView(listAppConfigs().map((a) => ({ scorecard: loadScorecard(a.name), runs: listRecords(a.name, 50) }))),
  ask: async (input) => askAssistant(input, currentAgentDeps(), ASSISTANT_CWD),
  agentRuntime,
  cancelRun: (id) => {
    const record = getRecord(id);
    if (!record) return false;
    if (record.status === "enqueued") {
      // Mark it cancelled. The queued job re-checks this before running (runner.ts)
      // and skips, so a cancelled-while-enqueued run does NOT execute later.
      updateRecord(id, { status: "done", step: "done", verdict: "infra-error", note: "cancelled by operator" });
      return false;
    }
    if (record.status !== "running") return false;
    // Abort ONLY when `id` is the run currently holding the queue controller. Passing the
    // id (not a bare cancel()) means a stale cancel — issued from a view where this record
    // still reads "running" while it has actually finished and a successor is now executing —
    // returns false instead of killing the innocent successor's live QA against DEV.
    const aborted = queue.cancel(id);
    if (aborted) {
      updateRecord(id, { status: "done", step: "done", verdict: "infra-error", note: "cancelled by operator" });
    }
    return aborted;
  },
  continueRun: (parentId, cases, guidance) => {
    if (shuttingDown) return "";
    const parent = getRecord(parentId);
    if (!parent) return "";
    // Cap the continuation chain: an operator can chain continue→continue→continue
    // indefinitely, each carrying fresh guidance to nudge the suite toward green.
    // After MAX_CONTINUATION_DEPTH rounds, refuse — the suite needs a fresh run.
    const depth = continuationDepth(parent);
    if (depth >= MAX_CONTINUATION_DEPTH) {
      console.warn(`[qa] rejecting continuation of ${parentId}: depth ${depth} >= ${MAX_CONTINUATION_DEPTH} (max)`);
      return "";
    }
    let failed = parent.cases.filter((c) => c.status === "fail");
    if (cases && cases.length > 0) {
      const want = new Set(cases);
      failed = failed.filter((c) => want.has(c.name));
    }
    return enqueueTrackedRun(queue, {
      app: parent.app,
      sha: parent.sha,
      target: parent.target,
      mode: parent.mode,
      guidance,
      fixCases: failed,
      parentRunId: parentId,
      source: "manual",
      // Honor the active agent runtime (Codex/dual) on continuations, exactly like the
      // webhook path above — otherwise the runner falls back to static OpenCode deps.
    }, { runEvents, pipeline: currentPipelineDeps() });
  },
};

const server = createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  const traceId = req.headers["x-trace-id"] as string | undefined;
  const startTime = Date.now();

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (path.startsWith("/api")) {
    // The liveness probe (session count only) and the version/capability handshake
    // are unauthenticated: the internal poller and external checks need the former,
    // and the connect screen needs the latter BEFORE auth so a stale binary can be
    // told to update even with a wrong token. Neither exposes secrets.
    const apiPath = path.replace(/^\/api\/v1(?=\/|$)/, "/api");
    const isPublic = req.method === "GET" && (apiPath === "/api/health" || apiPath === "/api/version");
    if (!isPublic && !authorized(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (path === "/api/metrics") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(generatePrometheusMetrics(queue, getOpenSessionCount()));
      return;
    }
    if (path.startsWith("/api/maintainer")) {
      if (await handleMaintainerApi(req, res, triggerMaintainer)) return;
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (await handleApi(req, res, apiDeps)) {
      logJson("info", `API request`, { traceId, path, duration: Date.now() - startTime });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  if (req.method === "POST") {
    // Fail closed: no webhook secret configured and not explicitly opted in → reject.
    if (!secret && !ALLOW_UNSIGNED_WEBHOOK) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "webhook secret not configured (set WEBHOOK_SECRET or WEBHOOK_ALLOW_UNSIGNED=true)" }));
      return;
    }
    let body = "";
    let aborted = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        aborted = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "payload too large" }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (aborted) return;
      const sig = typeof req.headers["x-hub-signature-256"] === "string" ? req.headers["x-hub-signature-256"] : undefined;
      const result = handleWebhook(body, sig, { secret });
      if (result.payload) {
        if (shuttingDown) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "shutting down" }));
          return;
        }
        const { repo, sha, mode, guidance } = result.payload;
        const matches = loadAppConfigsByRepo(repo);
        if (matches.length === 0) logJson("warn", "no config/apps entry for repo; event ignored", { repo });
        for (const m of matches) {
          try {
            if (m.role === "primary") {
              enqueueApiRun(m.app.name, sha, m.app.code ? "code" : "e2e", mode, guidance);
            } else {
              enqueueApiRun(m.app.name, sha, "e2e", "diff", guidance, undefined, undefined, repo);
            }
          } catch (err) {
            logJson("error", "webhook enqueue failed", { error: err instanceof Error ? err.message : String(err), repo, sha });
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ message: "internal error — run could not be enqueued" }));
            return;
          }
        }
      }
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: result.message }));
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

// Finalize zombie runs from a previous process BEFORE accepting traffic: a webhook
// landing during boot creates a legitimate `enqueued` record that a late sweep would
// wrongly finalize as infra-error.
finalizeInterruptedRuns();

server.listen(port, () => {
  logJson("info", `ai-pipeline listening on :${port}${apiToken ? " (API auth on)" : ""}`);
  // Make global fetch proxy-aware (HTTP(S)_PROXY/NO_PROXY) from boot, before any GitHub API or
  // health call. No-op when no proxy is configured. (A per-run build refines the timeouts.)
  const startupTimeout = Number(process.env.OPENCODE_TIMEOUT_MS) || 900_000;
  installHttpDispatcher(startupTimeout).catch((err) => logJson("warn", "HTTP dispatcher setup failed", { error: err instanceof Error ? err.message : String(err) }));
  // Start the SSE event stream from OpenCode so agent activity (tool calls,
  // file edits, streaming text) is routed to RunRecord logs in real time.
  agentRuntime.facade().startEventStream?.(
    (a) => {
      // Structured event → the live TUI panel; display line → the human log feed.
      appendActivity(a.runId, { kind: a.kind, text: a.text, status: a.status });
      appendLog(a.runId, a.display);
    },
    eventStreamController.signal,
    (runId, body) => {
      // Rich live activity (agent.activity/plan.updated/...) onto the RunEvent SSE
      // stream. Advisory: a bad event must never break the reconnect loop.
      try { runEvents.publish(runId, body); } catch { /* advisory */ }
    },
  )?.catch((err) => logJson("warn", "event stream reconnect loop failed", { error: err instanceof Error ? err.message : String(err) }));
  recoverRollbackRecord();
  confirmSwapAfterBoot();
  startHealthPoller();
  recoverMaintainerState();
});

// NOTE: SIGTERM/SIGINT are handled by the single pair of handlers registered near the
// top of this file (they cancel the in-flight run via queue.cancel(), drain, then exit).
// The database is closed via process.on("exit") in history.ts. There is intentionally no
// second shutdown path here — two handlers for one signal raced (two drain timers, two
// exits) and made `docker stop` behavior non-deterministic.
