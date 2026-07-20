import { createServer, IncomingMessage } from "node:http";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { writeFileSync, readFileSync, chmodSync, rmSync, unlinkSync, existsSync } from "node:fs";
import { JobQueue } from "./server/queue";
import { handleWebhook } from "./server/webhook";
import { loadAppConfig, listAppConfigs } from "./orchestrator/config-loader";
// sdd/migration-wiring-phase-2 Slice 1 (D-A): webhook cross-repo routing now resolves through the
// qa-engine app-catalog context (a validated resolution/projection layer over these SAME
// loadAppConfig/listAppConfigs shell loaders — config-loader.ts stays the raw+expandEnv reader,
// unchanged) instead of the legacy loadAppConfigsByRepo direct scan. See resolveWebhookDispatch's
// own header for the byte-identical-output contract this swap preserves.
import { YamlAppConfigAdapter } from "../qa-engine/src/contexts/app-catalog/infrastructure/yaml-app-config.adapter";
import { resolveWebhookDispatch, type WebhookDispatch } from "./server/webhook-routing";
import { handleApi, ApiDeps } from "./server/api";
import { authorizeBearer, issueSession } from "./server/auth";
import { verifyGithubIdentity, authorizeUser } from "./server/github-auth";
import { createFixedWindowLimiter } from "./server/rate-limit";
import { toIntelligenceView } from "./server/intelligence-view";
import { toSignalsView } from "./server/signals-view";
import { toTrendsView } from "./server/trends-view";
import { toReportView } from "./server/report-view";
import { toRunReportView } from "./server/run-report-view";
import { createDurableRunEventStore } from "./server/durable-run-events";
import { serveDashboard } from "./server/static";
import { handleMaintainerApi, recordIncident, getMaintainerStatus, getIncidents } from "./server/maintainer";
import { getRecord, listRecords, currentRun, updateRecord, interruptedRecords, continuationDepth, MAX_CONTINUATION_DEPTH, listLearningRules, loadScorecard, loadCurriculum, listRunOutcomes, getRunOutcome, getAgentTurns, computeTelemetryAnalysis } from "./server/history";
import { enqueueTrackedRun, cancelTrackedRun } from "./server/runner";
import { createRewrittenEngineFactory } from "./server/rewritten-engine-factory";
import { pruneMirrors, defaultMirrorPruneDeps, getDirectorySize } from "./server/mirror-prune";
import { buildArtifactBytesMetrics, type ArtifactSizeCache } from "./server/metrics";
import { createMaintainerRuntime } from "./server/maintainer-runtime";
import { installHttpDispatcher } from "./util/net";
import { resolveRef, defaultMirrorDeps, ensureMirrorAtBranch } from "./integrations/repo-mirror";
import { askAssistant, AgentDeps, getOpenSessionCount, defaultAgentDeps } from "./integrations/opencode-client";
import { createAgentRuntimeManager } from "./server/agent-runtime";
import { CodexRuntimeStrategy, OpenCodeRuntimeStrategy } from "./agent-runtime";
import { appendLog, appendActivity, deleteAppHistory, runVerdictCounts } from "./server/history";
import { type RunMode, type TestTarget } from "./types";
import { github } from "./integrations/github";
import { createApp as adminCreateApp, updateApp as adminUpdateApp, deleteApp as adminDeleteApp, type AppAdminDeps } from "./server/app-admin";
import { writeConfig, configExists } from "./server/onboard";
import { applyEnvVars, defaultEnvStoreFs } from "./server/env-store";
import { logJson } from "./integrations/logger";
import { createOnboardingJob, type RepoIndexOutcome } from "./server/onboarding/onboarding-job";
import { LlmProfileProposerAdapter, PROPOSER_MODEL } from "./server/onboarding/llm-profile-proposer.adapter";
import { OnboardingService } from "@contexts/service-topology/application/onboarding-service";
import { buildServiceBoundaryResolver } from "@contexts/service-topology/infrastructure/resolver-factory";
// Onboarding-auto-index (Slice 1, design §2.3, probe fact #3): the post-confirm advisory-index
// closure spawns index_repository DIRECTLY via CodebaseMemoryClient — NOT the adapter's syncTo
// (that method's contract is incremental changed_files, per its own header). The probe confirmed
// {"repo_path": mirrorDir} alone performs the initial FULL index (project name derived from the
// path server-side, no `project` key needed).
import { CodebaseMemoryClient } from "../qa-engine/src/shared-infrastructure/code-graph/codebase-memory-client";
import { RedactionPortAdapter } from "./orchestrator/sanitizer";

const SELF_REPO = process.env.PANCHITO_REPO ?? "ArielFalcon/panchito";
const ROOT = process.env.PANCHITO_ROOT ?? process.cwd();
const TOKEN_FILE = join(ROOT, "config", ".api_token");
// sdd/migration-wiring-phase-2 Slice 1 (D-A): constructed ONCE, injected with the SAME shell
// loaders config-loader.ts's own callers use (no root override needed — both loaders default to
// this file's identical process.env.PANCHITO_ROOT ?? process.cwd() computation independently).
const appCatalog = new YamlAppConfigAdapter({ load: loadAppConfig, list: listAppConfigs });
// sdd/migration-wiring-phase-2 Slice 7b-2: the canonical redaction adapter (env+pattern) for this
// file's error-message responses, replacing src/util/redact.ts's redactError.
const redactionPort = new RedactionPortAdapter();
// Durable backing (OBS-01) lives in createDurableRunEventStore, shared with the CLI so every
// trigger persists events identically: the live SSE stream survives a restart (e.g. the
// maintainer hot-swap's process.exit) and eviction from the in-memory ring.
const runEvents = createDurableRunEventStore();
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

// Session signing secret for GitHub-user logins. Reuses QA_API_TOKEN by default (one secret
// to manage), or a dedicated AUTH_SIGNING_KEY when an operator wants to rotate sessions
// independently of the machine token. Sessions live AUTH_SESSION_TTL_SECONDS (default 24h).
const signingSecret = process.env.AUTH_SIGNING_KEY ?? apiToken;
const AUTH_SESSION_TTL_SECONDS = Number(process.env.AUTH_SESSION_TTL_SECONDS ?? 24 * 60 * 60);

// Per-IP throttle for the public login endpoint (20 attempts / minute), guarding against a
// flood that would amplify into GitHub API calls from this server's address.
const loginLimiter = createFixedWindowLimiter({ limit: 20, windowMs: 60_000 });

// The set of repos a GitHub user must be able to push to in order to log in: every watched
// app's primary repo plus its service repos. A collaborator on any one earns a session.
function watchedRepos(): string[] {
  const repos = new Set<string>();
  for (const app of listAppConfigs()) {
    repos.add(app.repo);
    for (const svc of app.services ?? []) repos.add(svc.repo);
  }
  return [...repos];
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

// Plan 7.6 (cutover finale) — the rewritten engine is the ONLY engine; RunnerDeps.engineFactory
// (src/server/runner.ts) is now REQUIRED on every enqueueTrackedRun call below. Reuses THIS
// process's real agentRuntime (currentAgentDeps) instead of building a second
// AgentRuntimeManager, matching every other collaborator this file already owns (github,
// deploy-gate, repo-mirror, execute/code-runner).
const engineFactory = createRewrittenEngineFactory({ getAgentDeps: currentAgentDeps });

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

function enqueueApiRun(app: string, sha: string, target: string, mode: RunMode, guidance?: string, shadow?: boolean, commits?: number, triggerRepo?: string, baseSha?: string): string {
  if (shuttingDown) {
    console.warn(`[qa] rejecting run ${app}@${sha} — shutting down`);
    return "";
  }
  // Orphan-data cleanup is reconstructed inside enqueueTrackedRun (the single funnel), so
  // every trigger gets it — not just this webhook path.
  // isOnboardingActive (onboarding-hardening, Slice 1): the mirror-race guard's real wiring —
  // onboardingJob.isActive() reads the job's own busy mutex, so the runner defers mirror work
  // while onboarding is provisioning mirrors against the same shared working tree.
  return enqueueTrackedRun(queue, { app, sha, target: target as TestTarget, mode, guidance, shadow, commits, source: "webhook", triggerRepo, baseSha }, { runEvents, engineFactory, isOnboardingActive: () => onboardingJob.isActive() });
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

// Module-level cache for the artifact-bytes scan (TTL: 60 s). A fresh scan on every
// scrape would block the response for large mirrors; this amortises the cost and ensures
// a scan error never crashes the metrics endpoint.
const artifactSizeCache: { current: ArtifactSizeCache | null } = { current: null };
const ARTIFACT_SIZE_TTL_MS = 60_000;

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
  // Artifact size gauge: best-effort, TTL-cached. A scan error yields 0 for that app;
  // the gauge block is omitted entirely when no apps are configured.
  const artifactBlock = buildArtifactBytesMetrics(
    {
      listAppConfigs,
      mirrorRoot: () => process.env.MIRROR_DIR ?? join(ROOT, ".mirrors"),
      getDirectorySize,
    },
    artifactSizeCache,
    ARTIFACT_SIZE_TTL_MS,
    Date.now(),
  );
  if (artifactBlock) lines.push(artifactBlock);
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
    recordIncident({
      source: "health-check",
      severity: "warn",
      summary: `run ${r.id} (${r.app}@${r.sha.slice(0, 7)}) was interrupted by process restart`,
      detail: `Previous status: ${r.status}, step: ${r.step ?? "unknown"}`,
    });
    console.log(`[qa]   finalized ${r.id} (${r.app}@${r.sha.slice(0, 7)}) as infra-error`);
  }
  console.log(`[qa] recovery complete — ${zombies.length} run(s) marked as infra-error`);
}

// A request is authorized if it carries EITHER the static machine token (CI/automation) OR a
// valid user-session JWT minted by POST /api/auth/login. authorizeBearer does the constant-time
// static compare and the signature/expiry check; both paths are unit-tested in auth.test.ts.
function authorized(req: IncomingMessage): boolean {
  const header = req.headers["authorization"];
  return authorizeBearer(typeof header === "string" ? header : undefined, apiToken, signingSecret) !== null;
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

// Build the period-over-period TrendsView for an app from one outcomes read. The trends and report
// deps both route through this so the read logic — and the `100` window literal — live in one place
// instead of being duplicated at each site; each call performs its own read (trends and report are
// separate HTTP requests, so there is no cross-request reuse).
const buildTrends = (app: string, window?: number) =>
  toTrendsView({ app, outcomes: listRunOutcomes(app, 100), records: listRecords(app, 100), now: new Date().toISOString(), window });

// Slice 5a: server-side boundary-profile onboarding job (design delta §C). ONE in-memory job for
// the whole process — independent of the QA run queue (its own mutex), gated by a runner-busy
// fail-fast guard so it never provisions mirrors while a QA run is active against the same mirrors
// (the symmetric mirror-clobber risk, design §C).
function opencodeConfigPath(): string {
  return process.env.OPENCODE_CONFIG ?? join(ROOT, "agents", "opencode.json");
}

// Env-guard part 2 (design §C, spec E5): the qa-proposer agent must be DECLARED on the target
// opencode config before a session is ever opened — a missing agent otherwise yields an opaque
// UnknownError deep inside session.prompt (engram #1075). A static config read is a cheap,
// deterministic pre-flight; the adapter's own fail-open catch remains the runtime backstop for
// anything this check cannot see (e.g. the server process not actually running the declared agent).
async function hasProposerAgentConfigured(): Promise<boolean> {
  try {
    const path = opencodeConfigPath();
    if (!existsSync(path)) return false;
    const raw = JSON.parse(readFileSync(path, "utf8")) as { agent?: Record<string, unknown> };
    return Boolean(raw.agent?.["qa-proposer"]);
  } catch {
    return false;
  }
}

// Onboarding-auto-index (Slice 1, design §2.3, §1). The SAME CodebaseMemoryClient construction
// rewritten-engine-factory.ts uses (default runner) — this closure is process-wide (composed once
// at boot), not per-run, since the onboarding job itself is process-wide (design §1). Fail-open by
// construction: {code:null} degrades map to a `failed` outcome, never a throw past this function —
// runIndexing()'s own per-repo wrapper is a second, defensive layer on top of this one.
const onboardingIndexClient = new CodebaseMemoryClient();

// The client's own spawn timeout defaults to 60s — far below a first-time FULL index of a large
// repo. Without an explicit override here, the job's per-repo indexTimeoutMs budget (5 min,
// onboarding-job.ts DEFAULT_INDEX_TIMEOUT_MS) is a dead ceiling: the inner spawn gives up first
// and a healthy slow index reads as failed. Kept a hair under the job budget so the SPAWN dies
// (and reports its stderr) before the outer race masks it.
const ONBOARDING_INDEX_SPAWN_TIMEOUT_MS = 4.5 * 60 * 1000;

async function indexRepoForOnboarding(repo: string, mirrorDir: string): Promise<RepoIndexOutcome> {
  try {
    // Probe fact #3: {"repo_path": mirrorDir} ALONE performs the initial FULL index — no
    // `changed_files` walk needed, no `project` key needed (server derives it from the path).
    const jsonArg = JSON.stringify({ repo_path: mirrorDir });
    const res = await onboardingIndexClient.cli("index_repository", jsonArg, mirrorDir, ONBOARDING_INDEX_SPAWN_TIMEOUT_MS);
    if (res.code === null) {
      return { repo, status: "failed", error: res.stderr || "codebase-memory-mcp unavailable" };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(res.stdout);
    } catch (e) {
      return { repo, status: "failed", error: e instanceof Error ? e.message : String(e) };
    }
    // The live CLI (v0.8.1, probe + smoke verified) reports `nodes`; `node_count` is kept as a
    // fallback for older/newer response shapes. Requiring the wrong single name marked every
    // SUCCESSFUL live index as failed while the .db landed fine.
    const shape = typeof payload === "object" && payload !== null ? (payload as { nodes?: unknown; node_count?: unknown }) : {};
    const rawNodeCount = shape.nodes ?? shape.node_count;
    const nodeCount = typeof rawNodeCount === "number" && Number.isFinite(rawNodeCount) ? rawNodeCount : undefined;
    if (nodeCount === undefined) {
      return { repo, status: "failed", error: "index_repository response missing nodes/node_count" };
    }
    return { repo, status: "ok", nodeCount };
  } catch (err) {
    return { repo, status: "failed", error: redactionPort.redactError(err) };
  }
}

const onboardingJob = createOnboardingJob({
  isRunnerBusy: () => {
    const running = currentRun();
    return queue.size > 0 || (running !== undefined && running.status === "running");
  },
  ensureMirrorAtBranch: (repo, baseBranch) =>
    ensureMirrorAtBranch(repo, baseBranch, defaultMirrorDeps),
  hasOpencodeApiKey: () => Boolean(process.env.OPENCODE_API_KEY),
  hasProposerAgent: () => hasProposerAgentConfigured(),
  buildProposer: (ctx) => new LlmProfileProposerAdapter(defaultAgentDeps, PROPOSER_MODEL, ctx),
  buildOnboardingService: (proposer, onRound) => new OnboardingService(proposer, 3, onRound),
  resolveLinks: (profile, system, front) => buildServiceBoundaryResolver([profile]).resolveLinks(system, front),
  readConfig: (path) => readFileSync(path, "utf8"),
  writeConfig: (path, content) => writeFileSync(path, content, "utf8"),
  configPath: (app) => join(ROOT, "config", "apps", `${app}.yaml`),
  indexRepo: (repo, mirrorDir) => indexRepoForOnboarding(repo, mirrorDir),
});

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
  // Slice 5a: boundary-profile onboarding job — one process-wide job (createOnboardingJob's own
  // mutex), independent of the QA run queue. `repo`/`services` default to the app's OWN config
  // when the request body omits them (design §C).
  boundaries: {
    propose: (name, input) => {
      let app;
      try {
        app = loadAppConfig(name);
      } catch {
        return { ok: false, error: `app not found: '${name}'` };
      }
      const repo = input.repo ?? app.repo;
      const services = input.services ?? app.services?.map((s) => s.repo) ?? [];
      return onboardingJob.propose({ app: name, repo, services, baseBranch: app.baseBranch });
    },
    status: (name) => onboardingJob.status(name),
    confirm: (name) => onboardingJob.confirm(name),
  },
  // Phase 0b: expose agent_turns for the /api/runs/:id/turns endpoint.
  getAgentTurns: (runId) => getAgentTurns(runId),
  // Phase 8: holistic telemetry analysis for /api/apps/:app/telemetry.
  telemetryAnalysis: (app, windowDays) => computeTelemetryAnalysis(app, windowDays),
  resolveRef: (repo, ref) => resolveRef(repo, ref, defaultMirrorDeps),
  getRecord,
  listRecords,
  currentRun,
  intelligence: (app) => toIntelligenceView(app, listLearningRules(app), loadScorecard(app), loadCurriculum(app)),
  signals: () => toSignalsView(listAppConfigs().map((a) => ({ scorecard: loadScorecard(a.name), runs: listRecords(a.name, 50), outcomes: listRunOutcomes(a.name, 50) }))),
  // Each handler builds its own TrendsView via buildTrends (one SQLite read per request); report
  // then feeds that view to toReportView. buildTrends is the single home for the read + the 100
  // window literal — it does NOT dedup across the (separate) trends and report requests.
  trends: (app, window) => buildTrends(app, window),
  report: (app, window) => toReportView(buildTrends(app, window), { weights: loadAppConfig(app).qa.reports?.weights }),
  // The run-scoped report: TWO analyses for the post-run summary view. `current` is the
  // self-describing report about the run that just finished (its verdict, case mix, this run's
  // change-coverage/value/duration). `evolution` is the period-over-period report of the same app
  // as it stood at this run (outcomes/records up to the run's timestamp), so a recent execution can
  // open the trends exactly as they were then — null until there is a prior run to compare against.
  // Outer null ⇒ 404 (no such run).
  reportForRun: (runId, window) => {
    const rec = getRecord(runId);
    if (!rec) return null;
    let weights: Record<string, number> | undefined;
    let minRatio: number | undefined;
    try {
      const cfg = loadAppConfig(rec.app);
      weights = cfg.qa.reports?.weights;
      minRatio = cfg.qa.changeCoverage?.minRatio;
    } catch {
      // app config gone but the run survives — still produce its report from defaults
    }
    const current = toRunReportView({ record: rec, outcome: getRunOutcome(runId) ?? null, minRatio, weights });
    const outcomes = listRunOutcomes(rec.app, 200).filter((o) => o.at <= rec.at);
    const records = listRecords(rec.app, 200).filter((r) => r.at <= rec.at);
    const evolution =
      outcomes.length >= 2
        ? toReportView(toTrendsView({ app: rec.app, outcomes, records, now: rec.at, window }), { weights })
        : null;
    return { current, evolution };
  },
  ask: async (input) => askAssistant(input, currentAgentDeps(), ASSISTANT_CWD),
  // Advertise the OAuth App client id (public) in the version handshake so the console can run
  // the device flow without baking it in — configure GitHub login once, here on the server.
  githubClientId: process.env.GITHUB_OAUTH_CLIENT_ID,
  // GitHub-user login: verify the token's identity, confirm push access to a watched repo,
  // then mint a session. Failures are tagged so the route returns 401 (bad token) vs 403
  // (authenticated but not a collaborator). The static QA_API_TOKEN remains the machine path.
  login: async (githubToken) => {
    const username = await verifyGithubIdentity(githubToken);
    if (!username) return { ok: false, reason: "identity" };
    if (!(await authorizeUser(githubToken, watchedRepos()))) return { ok: false, reason: "forbidden" };
    const now = Date.now();
    const token = issueSession(username, signingSecret, AUTH_SESSION_TTL_SECONDS, now);
    return { ok: true, token, username, expiresAt: new Date(now + AUTH_SESSION_TTL_SECONDS * 1000).toISOString() };
  },
  agentRuntime,
  // Cancel through the single funnel (runner.ts): aborts a live run we hold, and ALSO finalizes
  // an enqueued or stale "running" record so the operator's stop always clears the run — never
  // leaving a zombie stuck at "0%" answering 409 to every stop press. queue.cancel(id) inside it
  // protects an innocent successor (it aborts only when the id matches the active run).
  cancelRun: (id) => cancelTrackedRun(queue, id),
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
      // webhook path above.
    }, { runEvents, engineFactory, isOnboardingActive: () => onboardingJob.isActive() });
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
    // Public (pre-auth) surface: liveness, the version handshake, and login. Login MUST be
    // public — it is how a client with no token yet obtains one (it presents a GitHub token,
    // not the API credential). None of these expose secrets.
    const isLogin = req.method === "POST" && apiPath === "/api/auth/login";
    const isPublic =
      (req.method === "GET" && (apiPath === "/api/health" || apiPath === "/api/version")) || isLogin;
    if (!isPublic && !authorized(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    // Throttle the public login endpoint per client IP: it is unauthenticated and each attempt
    // fans out to the GitHub API, so an unbounded flood would amplify into GitHub traffic from
    // this server's address. Over-limit attempts get 429 before any GitHub call is made.
    if (isLogin && !loginLimiter.allow(req.socket.remoteAddress ?? "")) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
      res.end(JSON.stringify({ error: "too many login attempts — try again in a minute" }));
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

  // The web dashboard (a static SPA build) is served same-origin at /app, so it shares the
  // orchestrator's origin and the operator's credentials (no CORS). Until web/dist exists this
  // no-ops to a placeholder. The /api surface above stays Bearer-protected.
  if (req.method === "GET" && (path === "/app" || path.startsWith("/app/"))) {
    if (await serveDashboard(req, res, { distDir: join(ROOT, "web", "dist") })) return;
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
    req.on("end", async () => {
      if (aborted) return;
      const sig = typeof req.headers["x-hub-signature-256"] === "string" ? req.headers["x-hub-signature-256"] : undefined;
      const result = handleWebhook(body, sig, { secret });
      if (result.payload) {
        if (shuttingDown) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "shutting down" }));
          return;
        }
        const { repo, sha, mode, guidance, baseSha } = result.payload;
        // sdd/migration-wiring-phase-2 Slice 1 (D-A): routed through the app-catalog context's
        // resolveByRepo (byte-identical to the legacy loadAppConfigsByRepo-driven dispatch it
        // replaces — see webhook-routing.ts's own test for the pinned equivalence).
        //
        // judgment-day fix: this await had NO error boundary — a throw here (e.g. a catalog-level
        // fault the per-config isolation below does not cover) became an unhandled rejection inside
        // this "end" listener: res never ends, GitHub's webhook delivery hangs to its own timeout,
        // and no run is ever enqueued. Mirrors the adjacent per-dispatch enqueueApiRun try/catch
        // immediately below (log + 500 + return), one call earlier.
        let dispatch: WebhookDispatch[];
        try {
          dispatch = await resolveWebhookDispatch(appCatalog, repo, { mode, guidance, baseSha });
        } catch (err) {
          logJson("error", "webhook dispatch resolution failed", { error: err instanceof Error ? err.message : String(err), repo, sha });
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "internal error — could not resolve webhook dispatch" }));
          return;
        }
        if (dispatch.length === 0) logJson("warn", "no config/apps entry for repo; event ignored", { repo });
        for (const d of dispatch) {
          try {
            enqueueApiRun(d.app, sha, d.target, d.mode, d.guidance, undefined, undefined, d.triggerRepo, d.baseSha);
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
  logJson("info", `panchito listening on :${port}${apiToken ? " (API auth on)" : ""}`);
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
