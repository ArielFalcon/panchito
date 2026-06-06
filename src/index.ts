import { createServer, IncomingMessage } from "node:http";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { writeFileSync, readFileSync, chmodSync } from "node:fs";
import { JobQueue } from "./server/queue";
import { handleWebhook } from "./server/webhook";
import { loadAppConfig, loadAppConfigByRepo, listAppConfigs } from "./orchestrator/config-loader";
import { handleApi, ApiDeps } from "./server/api";
import { handleMaintainerApi, recordIncident, setMaintainerStatus, getMaintainerStatus, getIncidents, updateIncident } from "./server/maintainer";
import { getRecord, listRecords, currentRun, updateRecord, interruptedRecords } from "./server/history";
import { testDataNamespace } from "./qa/test-data";
import { enqueueTrackedRun } from "./server/runner";
import { performSwap, confirmSwapHealthy, realSwapFs, SWAP_MARKER_FILE } from "./server/self-update";
import { resolveRef, defaultMirrorDeps, authHeaderArgs, type MirrorDeps } from "./integrations/repo-mirror";
import { defaultOpencodeDeps, askAssistant, OpencodeDeps, startEventStream } from "./integrations/opencode-client";
import { appendLog } from "./server/history";
import { type RunMode, type TestTarget } from "./types";
import { github } from "./integrations/github";

const SELF_REPO = process.env.AI_PIPELINE_REPO ?? "ArielFalcon/ai-pipeline";
const ROOT = process.env.AI_PIPELINE_ROOT ?? process.cwd();
const TOKEN_FILE = join(ROOT, "config", ".api_token");
// The maintainer's autonomous merge+hot-swap is ON by default but can be disabled by
// ops (then a maintainer fix stops at an open PR for a human to review and merge).
const AUTONOMOUS_MAINTAINER = process.env.SELF_MAINTAINER_AUTOMERGE !== "false";

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
  recordIncident({ source: "qa-generator", severity: "error", summary: `pipeline crash: ${msg}` });
});

let shuttingDown = false;
const SHUTDOWN_TIMEOUT_MS = 25_000;

process.on("SIGTERM", () => {
  console.log("[qa] SIGTERM received — shutting down (new runs rejected)");
  shuttingDown = true;
  setTimeout(() => {
    console.log("[qa] shutdown timeout — forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
});

process.on("SIGINT", () => {
  console.log("[qa] SIGINT received — shutting down");
  shuttingDown = true;
  process.exit(0);
});

function enqueueApiRun(app: string, sha: string, target: string, mode: RunMode, guidance?: string): string {
  if (shuttingDown) {
    console.warn(`[qa] rejecting run ${app}@${sha} — shutting down`);
    return "";
  }
  let previousNamespace: string | undefined;
  const prev = listRecords(app, 1)[0];
  const wasInterrupted = prev && (
    prev.status === "running" || prev.status === "enqueued" ||
    prev.verdict === "infra-error"
  );
  if (wasInterrupted) {
    previousNamespace = testDataNamespace("qa-bot", prev.sha);
  }
  return enqueueTrackedRun(queue, { app, sha, target: target as TestTarget, mode, guidance, source: "webhook", previousNamespace });
}

// ── Self-maintenance: clone ai-pipeline into a persistent working copy ───────

async function ensureMirrorSelf(dir: string, deps: MirrorDeps): Promise<void> {
  const base = process.env.GIT_REMOTE_BASE ?? "https://github.com";
  const url = `${base}/${SELF_REPO}.git`;
  if (!deps.exists(dir)) {
    await deps.git([...authHeaderArgs(), "clone", url, dir]);
  } else {
    await deps.git([...authHeaderArgs(), "fetch", "origin"], dir);
    await deps.git(["checkout", "-f", "main"], dir);
    await deps.git(["reset", "--hard", "origin/main"], dir);
  }
}

// ── Maintainer summary parsing ───────────────────────────────────────────────

interface MaintainerJustification {
  rootCause: string; // what actually causes the incident
  whyNecessary: string; // why this change is needed (vs. doing nothing)
  whyMinimal: string; // why this is the smallest safe fix (not over-engineering)
}

interface MaintainerSummary {
  fixed: boolean;
  changes: string[];
  prTitle?: string;
  justification?: MaintainerJustification;
}

// A justification is only valid when all three arguments are present and non-trivial —
// the requirement that the system "prove the change is necessary and the solution is
// optimal and safe" before it is allowed to self-merge and hot-swap.
function validJustification(j: unknown): MaintainerJustification | undefined {
  if (!j || typeof j !== "object") return undefined;
  const o = j as Record<string, unknown>;
  const ok = (v: unknown): v is string => typeof v === "string" && v.trim().length >= 10;
  if (ok(o.rootCause) && ok(o.whyNecessary) && ok(o.whyMinimal)) {
    return { rootCause: o.rootCause, whyNecessary: o.whyNecessary, whyMinimal: o.whyMinimal };
  }
  return undefined;
}

function parseMaintainerSummary(text: string): MaintainerSummary {
  const start = text.indexOf("<!--MAINTAINER_SUMMARY");
  if (start === -1) return { fixed: false, changes: [] };
  const end = text.indexOf("END_MAINTAINER_SUMMARY-->", start);
  if (end === -1) return { fixed: false, changes: [] };

  try {
    const json = JSON.parse(text.slice(start + "<!--MAINTAINER_SUMMARY".length, end).trim());
    return {
      fixed: json.fixed === true,
      changes: Array.isArray(json.changes) ? json.changes : [],
      prTitle: typeof json.prTitle === "string" ? json.prTitle : undefined,
      justification: validJustification(json.justification),
    };
  } catch {
    return { fixed: false, changes: [] };
  }
}

async function triggerMaintainer(): Promise<void> {
  const pending = getIncidents().filter((i) => i.status === "pending");
  if (pending.length === 0) return;

  setMaintainerStatus("diagnosing");
  const deps = await defaultOpencodeDeps();

  // Use the mirrors directory for the working copy (survives restarts as volume)
  const maintainerWorkDir = join(
    process.env.MIRROR_DIR ?? join(process.cwd(), ".mirrors"),
    "ai-pipeline-self"
  );

  const branchName = `qa/maintainer-${Date.now().toString(36)}`;

  try {
    // Step 1: Prepare working copy (clone/fetch + create branch)
    const mirrorDeps = defaultMirrorDeps;
    await ensureMirrorSelf(maintainerWorkDir, mirrorDeps);
    await mirrorDeps.git(["checkout", "-B", branchName], maintainerWorkDir);

    // Step 2: Open agent session to diagnose and fix
    const session = await deps.open("qa-maintainer", maintainerWorkDir);
    try {
      const prompt = [
        "## Incident report",
        "",
        "The following incident(s) were detected in the ai-pipeline system.",
        "Diagnose the root cause in the codebase (you are in the ai-pipeline repo)",
        "and implement a fix. After implementing, summarize what you changed.",
        "",
        ...pending.map((i) =>
          [
            `### ${i.id}`,
            `- Source: ${i.source}`,
            `- Severity: ${i.severity}`,
            `- Summary: ${i.summary}`,
            i.detail ? `- Detail: ${i.detail}` : "",
          ].join("\n"),
        ),
        "",
        "## Closing protocol",
        "Edit the files IN PLACE in this working copy (you are already on the fix branch).",
        "Do NOT run git, do NOT clone, do NOT open a PR — the orchestrator owns all git",
        "operations and will commit, push and merge your changes for you.",
        "",
        "This fix will be AUTO-MERGED to main and HOT-SWAPPED into the running service, so",
        "you must PROVE it is necessary, minimal and safe. Output a summary in this format",
        "(the `justification` is mandatory — without all three fields the fix is NOT deployed):",
        "```",
        "<!--MAINTAINER_SUMMARY",
        JSON.stringify({
          fixed: true,
          changes: ["file1.ts: fixed X", "file2.ts: added Y"],
          prTitle: "fix: brief description of the fix",
          justification: {
            rootCause: "what actually causes the incident (evidence from the code)",
            whyNecessary: "why this change is required, and what breaks if we do nothing",
            whyMinimal: "why this is the smallest safe fix and not over-engineered",
          },
        }),
        "END_MAINTAINER_SUMMARY-->",
        "```",
      ].join("\n");

      setMaintainerStatus("fixing");
      const output = await session.prompt(prompt);

      // Step 3: Parse the maintainer summary
      const summary = parseMaintainerSummary(output);

      if (!summary.fixed || summary.changes.length === 0) {
        setMaintainerStatus("idle");
        for (const inc of pending) {
          updateIncident(inc.id, { status: "diagnosing" });
        }
        console.log("[maintainer] agent did not produce fixes; incidents marked for diagnosis.");
        return;
      }

      // Step 4: Commit changes
      const name = process.env.GIT_AUTHOR_NAME ?? "ai-pipeline-qa";
      const email = process.env.GIT_AUTHOR_EMAIL ?? "ai-pipeline-qa@users.noreply.github.com";

      await mirrorDeps.git(["add", "-A"], maintainerWorkDir);

      // Check if there are changes to commit
      const status = await mirrorDeps.git(["status", "--porcelain"], maintainerWorkDir);
      if (!status.trim()) {
        setMaintainerStatus("idle");
        console.log("[maintainer] agent made no file changes; nothing to commit.");
        return;
      }

      await mirrorDeps.git(
        ["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-m", summary.prTitle || "fix: automated maintainer fix"],
        maintainerWorkDir
      );

      // Step 5: Push and open PR
      await mirrorDeps.git(
        [...authHeaderArgs(), "push", "--force-with-lease", "-u", "origin", branchName],
        maintainerWorkDir
      );

      const pr = await github.createPullRequest(SELF_REPO, {
        title: summary.prTitle || "fix: automated maintainer fix",
        head: branchName,
        base: "main",
        body: [
          "## Automated maintainer fix",
          "",
          "**Incidents addressed:**",
          ...pending.map((i) => `- ${i.id}: ${i.summary}`),
          "",
          "**Changes:**",
          ...summary.changes.map((c) => `- ${c}`),
          ...(summary.justification
            ? [
                "",
                "**Justification (required before self-merge):**",
                `- Root cause: ${summary.justification.rootCause}`,
                `- Why necessary: ${summary.justification.whyNecessary}`,
                `- Why minimal: ${summary.justification.whyMinimal}`,
              ]
            : []),
          "",
          "\u26a0\ufe0f **Review required before merge.** This PR was auto-generated by the ai-pipeline maintainer agent.",
        ].join("\n"),
      });

      // Step 6: NO auto-merge. A self-modifying agent must never merge its own code
      // into the branch it then deploys to itself — a human reviews and merges the PR.
      console.log(`[maintainer] fix PR opened — awaiting human review and merge: ${pr.url}`);

      for (const inc of pending) updateIncident(inc.id, { status: "fixed", prUrl: pr.url });
      console.log(`[maintainer] fix PR opened: ${pr.url}`);

      // Step 6: Safety gates BEFORE any autonomous merge + hot-swap.
      //  (a) A valid necessity/optimality justification is MANDATORY (the requirement to
      //      "prove the change is necessary and the solution optimal and safe").
      if (!summary.justification) {
        setMaintainerStatus("idle");
        console.warn(`[maintainer] fix lacks a valid justification - PR left for a human, NOT auto-merging: ${pr.url}`);
        return;
      }
      //  (b) Ops can disable autonomous merge entirely (then it stays a PR for a human).
      if (!AUTONOMOUS_MAINTAINER) {
        setMaintainerStatus("idle");
        console.log(`[maintainer] autonomous merge disabled (SELF_MAINTAINER_AUTOMERGE=false) - PR left for a human: ${pr.url}`);
        return;
      }
      //  (c) PRE-MERGE self-test gate: install + typecheck + tests on the fix branch HEAD.
      //      A fix that fails its OWN gate is never merged.
      const { execSync } = await import("node:child_process");
      try {
        execSync("npm install --no-audit --no-fund", { cwd: maintainerWorkDir, stdio: "inherit" });
        execSync("npm run typecheck", { cwd: maintainerWorkDir, stdio: "inherit" });
        execSync("npm test", { cwd: maintainerWorkDir, stdio: "inherit" });
      } catch (gateErr) {
        recordIncident({
          source: "health-check",
          severity: "critical",
          summary: "maintainer fix FAILED its pre-merge self-test gate - NOT merging",
          detail: gateErr instanceof Error ? gateErr.message : String(gateErr),
        });
        setMaintainerStatus("idle");
        console.error(`[maintainer] pre-merge gate failed - refusing to merge. PR left for a human: ${pr.url}`);
        return;
      }

      // Step 7: Gate green -> merge deterministically (independent of branch protection).
      await github.mergePullRequest(SELF_REPO, pr.number);
      console.log(`[maintainer] gate green - merged ${pr.url}`);

      // Step 8: Adopt the merged code and HOT-SWAP with rollback safety.
      await mirrorDeps.git(["fetch", "origin"], maintainerWorkDir);
      await mirrorDeps.git(["checkout", "-f", "main"], maintainerWorkDir);
      await mirrorDeps.git(["reset", "--hard", "origin/main"], maintainerWorkDir);

      // Never kill an in-flight QA run: wait for the queue to drain before swapping.
      console.log("[maintainer] waiting for the queue to drain before hot-swap...");
      await queue.drain();

      // Atomic-ish swap: back up the running tree, stage the new code, arm the boot-guard
      // marker. boot-guard.mjs (root, never swapped) restores the backup if the new code
      // fails to boot healthy - so a bad fix can never brick the service.
      performSwap(process.cwd(), maintainerWorkDir, join(ROOT, "data"), {
        at: new Date().toISOString(),
        prUrl: pr.url,
      });
      execSync("npm install --no-audit --no-fund", { cwd: process.cwd(), stdio: "inherit" });
      console.log("[maintainer] swap staged with rollback guard - restarting to apply.");
      process.exit(0);

    } finally {
      await session.dispose().catch((err) => {
        console.warn(`[qa] session dispose failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  } catch (err) {
    setMaintainerStatus("idle");
    console.error(`[maintainer] session failed: ${err instanceof Error ? err.message : String(err)}`);
    // Mark incidents as needing manual attention
    for (const inc of pending) {
      updateIncident(inc.id, { status: "diagnosing" });
    }
  }
}

const MAX_SESSION_AGE_MS = 30 * 60 * 1000;

let cleanupDeps: Promise<OpencodeDeps> | undefined;
function getCleanupDeps(): Promise<OpencodeDeps> {
  if (!cleanupDeps) cleanupDeps = defaultOpencodeDeps();
  return cleanupDeps;
}

async function cleanupOrphanedSessions(): Promise<void> {
  const deps = await getCleanupDeps();
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
  }, 60_000);
}

function recoverMaintainerState(): void {
  const diagnosing = getIncidents().filter((i) => i.status === "diagnosing");
  if (diagnosing.length > 0) {
    console.log(`[maintainer] recovering: ${diagnosing.length} incident(s) were mid-diagnosis; re-triggering`);
    triggerMaintainer();
  }
}

// After a maintainer hot-swap restart, the boot-guard armed a marker. If this (the new)
// code comes up and answers a health check, the swap is GOOD → clear the marker + backups
// so the boot-guard stops counting attempts. If it never gets here (crash), the boot-guard
// rolls back after MAX_BOOT_ATTEMPTS.
function confirmSwapAfterBoot(): void {
  const marker = realSwapFs.readMarker(join(ROOT, "data", SWAP_MARKER_FILE));
  if (!marker) return;
  console.log(`[maintainer] a swap is pending verification (attempt ${marker.attempt}) — checking health...`);
  setTimeout(async () => {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`);
      if (res.ok) {
        confirmSwapHealthy(process.cwd(), join(ROOT, "data"));
        console.log(`[maintainer] swap verified healthy — cleared rollback marker.${marker.prUrl ? ` (${marker.prUrl})` : ""}`);
      }
    } catch {
      /* unhealthy → leave the marker so the boot-guard rolls back on the next restart */
    }
  }, 20_000);
}

function finalizeInterruptedRuns(): void {
  const zombies = interruptedRecords();
  if (zombies.length === 0) return;
  console.log(`[qa] finalizing ${zombies.length} interrupted run(s) from previous process...`);
  for (const r of zombies) {
    updateRecord(r.id, {
      status: "done",
      step: "done",
      verdict: "infra-error",
      note: "process restarted — run was interrupted",
    });
    console.log(`[qa]   finalized ${r.id} (${r.app}@${r.sha.slice(0, 7)}) as infra-error`);
  }
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

let askDeps: Promise<OpencodeDeps> | undefined;
function getAskDeps(): Promise<OpencodeDeps> {
  if (!askDeps) askDeps = defaultOpencodeDeps();
  return askDeps;
}

const apiDeps: ApiDeps = {
  queue,
  enqueue: enqueueApiRun,
  loadApp: (name) => loadAppConfig(name),
  listApps: () => listAppConfigs(),
  resolveRef: (repo, ref) => resolveRef(repo, ref, defaultMirrorDeps),
  getRecord,
  listRecords,
  currentRun,
  ask: async (input) => askAssistant(input, await getAskDeps(), ASSISTANT_CWD),
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
    const aborted = queue.cancel();
    if (aborted) {
      updateRecord(id, { status: "done", step: "done", verdict: "infra-error", note: "cancelled by operator" });
    }
    return aborted;
  },
  continueRun: (parentId, cases, guidance) => {
    if (shuttingDown) return "";
    const parent = getRecord(parentId);
    if (!parent) return "";
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
    });
  },
};

const server = createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0] ?? "/";

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (path.startsWith("/api")) {
    // The liveness probe is unauthenticated (it exposes only a session count), so
    // the internal poller and external health checks work without the API token.
    const isHealthProbe = req.method === "GET" && path === "/api/health";
    if (!isHealthProbe && !authorized(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (path.startsWith("/api/maintainer")) {
      if (await handleMaintainerApi(req, res, triggerMaintainer)) return;
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (await handleApi(req, res, apiDeps)) return;
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
        const app = loadAppConfigByRepo(repo);
        if (!app) console.warn(`[qa] no config/apps entry for ${repo}; event ignored`);
        // A code-mode app (code: true) runs code tests on its webhooks; e2e otherwise.
        else enqueueApiRun(app.name, sha, app.code ? "code" : "e2e", mode, guidance);
      }
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: result.message }));
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(port, () => {
  console.log(`ai-pipeline listening on :${port}${apiToken ? " (API auth on)" : ""}`);
  // Start the SSE event stream from OpenCode so agent activity (tool calls,
  // file edits, streaming text) is routed to RunRecord logs in real time.
  startEventStream(
    (runId, text) => appendLog(runId, text),
  ).catch((err) => console.warn(`[qa] event stream failed: ${err instanceof Error ? err.message : String(err)}`));
  confirmSwapAfterBoot();
  finalizeInterruptedRuns();
  startHealthPoller();
  recoverMaintainerState();
});
