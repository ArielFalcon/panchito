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
import { performSwap, confirmSwapHealthy, rollback, realSwapFs, SWAP_MARKER_FILE } from "./server/self-update";
import { assessChange, assessRate, parseNumstat, readDeployHistory, recordDeploy } from "./server/merge-guard";
import { recordFixFailure, readFixFailures, renderFailureMemory, realMemoryFs } from "./server/maintainer-memory";
import { installHttpDispatcher } from "./util/net";
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
// Persisted ledger of autonomous deploys (timestamps), used by the rate/loop guard. It lives
// on the data volume so it survives the restart a hot-swap triggers (see merge-guard.ts).
const DEPLOY_LEDGER = join(ROOT, "data", "maintainer-deploys.json");
// Persistent memory of fixes that broke the service (rolled back / failed gate / failed CI),
// injected into the next maintainer prompt so the agent does not repeat the same mistake.
const FAILURE_MEMORY = join(ROOT, "data", "maintainer-failures.json");
// Bridge written by boot-guard.mjs when it rolls back a crash-looping swap (the boot-guard can't
// use the app's modules, so it drops the marker here for the app to fold into FAILURE_MEMORY).
const ROLLBACK_BRIDGE = join(ROOT, "data", "last-rollback.json");

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
const eventStreamController = new AbortController();

process.on("SIGTERM", () => {
  console.log("[qa] SIGTERM received — shutting down (new runs rejected)");
  shuttingDown = true;
  eventStreamController.abort();
  // Best-effort: cancel SSE stream. OpenCode sessions are disposed by their
  // own AbortSignals (wired through the queue → pipeline → opencode-client).
  setTimeout(() => {
    console.log("[qa] shutdown timeout — forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
});

process.on("SIGINT", () => {
  console.log("[qa] SIGINT received — shutting down");
  shuttingDown = true;
  eventStreamController.abort();
  process.exit(0);
});

function enqueueApiRun(app: string, sha: string, target: string, mode: RunMode, guidance?: string, shadow?: boolean): string {
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
  return enqueueTrackedRun(queue, { app, sha, target: target as TestTarget, mode, guidance, shadow, source: "webhook", previousNamespace });
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
      // Inject the memory of past failed fixes so the agent does not repeat a change that
      // already broke the service for the same reason.
      const failureMemory = renderFailureMemory(readFixFailures(FAILURE_MEMORY));
      const prompt = [
        "## Incident report",
        "",
        "The following incident(s) were detected in the ai-pipeline system.",
        "Diagnose the root cause in the codebase (you are in the ai-pipeline repo)",
        "and implement a fix. After implementing, summarize what you changed.",
        "",
        ...(failureMemory ? [failureMemory] : []),
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
        "This fix is AUTO-DEPLOYED: it is hot-swapped into the running service, verified",
        "healthy (the canary), and only then merged to main. So it must be NECESSARY, MINIMAL",
        "and SAFE. Hard constraints (a fix that breaks them is blocked and left for a human):",
        "  - Keep it small: at most 15 files / 400 changed lines.",
        "  - Do NOT modify the recovery/build files: boot-guard.mjs, src/server/self-update.ts,",
        "    src/server/merge-guard.ts, any Dockerfile, docker-compose.yml, or .github/ — these",
        "    are the safety net and image build; changing them requires a human.",
        "Output a summary in this format (the `justification` is mandatory — without all three",
        "fields the fix is NOT deployed):",
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

      for (const inc of pending) updateIncident(inc.id, { status: "fixed", prUrl: pr.url });
      console.log(`[maintainer] fix PR opened: ${pr.url}`);

      // The fix is now an OPEN PR. It is auto-deployed only after passing EVERY safety layer
      // below. The deploy is a "canary before promote": the fix is hot-swapped into the
      // RUNNING service first and proven healthy; main is merged only afterwards (in
      // confirmSwapAfterBoot), so main — what a fresh container clones — is never poisoned by
      // an unverified self-fix. Any layer that blocks leaves the PR open for a human.
      const leaveForHuman = (why: string, severity: "warn" | "critical" = "warn") => {
        setMaintainerStatus("idle");
        if (severity === "critical") {
          recordIncident({ source: "health-check", severity, summary: `maintainer fix NOT auto-deployed: ${why}`, detail: pr.url });
        }
        console.warn(`[maintainer] NOT auto-deploying (${why}) — PR left for a human: ${pr.url}`);
      };

      // Layer 1 — a valid necessity/minimality justification is MANDATORY.
      if (!summary.justification) return leaveForHuman("fix lacks a valid justification");
      // Layer 2 — ops kill-switch (default ON). When off, every fix stops at an open PR.
      if (!AUTONOMOUS_MAINTAINER) return leaveForHuman("autonomous deploy disabled (SELF_MAINTAINER_AUTOMERGE=false)");

      // Layer 3 — scope guard: the fix must be minimal and must NOT touch the recovery net or
      // build/topology the canary cannot verify (boot-guard, self-update, merge-guard, …).
      const numstat = await mirrorDeps.git(["diff", "--numstat", "origin/main...HEAD"], maintainerWorkDir);
      const scope = assessChange(parseNumstat(numstat));
      if (!scope.ok) return leaveForHuman(scope.reasons.join("; "), "critical");

      // Layer 4 — rate / loop guard: cap autonomous deploys per window + cooldown, so a fix
      // that doesn't fix cannot loop the system into endless self-modification.
      const rate = assessRate(readDeployHistory(DEPLOY_LEDGER), Date.now());
      if (!rate.ok) return leaveForHuman(rate.reasons.join("; "), "critical");

      // Layer 5 — pre-deploy self-test gate: install + typecheck + tests on the fix branch.
      // A fix that fails its OWN gate is never deployed.
      const { execSync } = await import("node:child_process");
      try {
        execSync("npm install --no-audit --no-fund", { cwd: maintainerWorkDir, stdio: "inherit" });
        execSync("npm run typecheck", { cwd: maintainerWorkDir, stdio: "inherit" });
        execSync("npm test", { cwd: maintainerWorkDir, stdio: "inherit" });
      } catch (gateErr) {
        const detail = gateErr instanceof Error ? gateErr.message : String(gateErr);
        recordIncident({
          source: "health-check",
          severity: "critical",
          summary: "maintainer fix FAILED its pre-deploy self-test gate — NOT deploying",
          detail,
        });
        recordFixFailure(FAILURE_MEMORY, {
          at: new Date().toISOString(),
          reason: "pre-deploy-gate",
          prTitle: summary.prTitle,
          prUrl: pr.url,
          changes: summary.changes,
          rootCause: summary.justification?.rootCause,
          detail: "npm typecheck/test failed on the fix branch",
        });
        return leaveForHuman("failed its pre-deploy self-test gate");
      }

      // All gates green → CANARY DEPLOY. Never kill an in-flight QA run: drain the queue first.
      console.log("[maintainer] all safety gates green — waiting for the queue to drain before canary swap...");
      await queue.drain();

      // Record the deploy in the persisted ledger BEFORE swapping, so the rate guard counts it
      // even though the swap restarts the process (it must survive the restart).
      recordDeploy(DEPLOY_LEDGER, Date.now());

      // Swap the fix-branch code into the running tree (with backup + boot-guard marker) and
      // attach the PR so the post-restart health check PROMOTES it (merges to main) only once
      // the canary is healthy. boot-guard.mjs (never swapped) restores the backup if the new
      // code fails to boot — and because the PR is unmerged at this point, a rollback leaves
      // main pristine, so the service can never reach an unrecoverable state.
      performSwap(process.cwd(), maintainerWorkDir, join(ROOT, "data"), {
        at: new Date().toISOString(),
        prUrl: pr.url,
        promote: { repo: SELF_REPO, prNumber: pr.number, nodeId: pr.nodeId },
        fix: { prTitle: summary.prTitle, changes: summary.changes, rootCause: summary.justification.rootCause },
      });
      execSync("npm install --no-audit --no-fund", { cwd: process.cwd(), stdio: "inherit" });
      console.log("[maintainer] canary swap staged with rollback guard — restarting to verify, then promote.");
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

// After a maintainer canary swap restart, the boot-guard armed a marker. This is the
// PROMOTE-OR-ROLLBACK decision point: if this (the new) code comes up and answers the health
// check, the canary is GOOD → merge the PR to main (promote) and clear the marker + backups.
// If the deep check fails, roll back to the backed-up code immediately and restart — the PR is
// never merged, so main stays known-good. (A hard crash that never reaches here is caught by
// boot-guard.mjs, which rolls back after MAX_BOOT_ATTEMPTS — same end state: main untouched.)
function confirmSwapAfterBoot(): void {
  const dataDir = join(ROOT, "data");
  const marker = realSwapFs.readMarker(join(dataDir, SWAP_MARKER_FILE));
  if (!marker) return;
  console.log(`[maintainer] a canary swap is pending verification (attempt ${marker.attempt}) — checking health...`);
  setTimeout(async () => {
    const healthy = await canaryHealthy();
    if (!healthy) {
      // Functionally broken canary (booted but not serving): roll back to the backup now and
      // restart into it. The PR is unmerged → main is still the last known-good code.
      recordIncident({
        source: "health-check",
        severity: "critical",
        summary: "maintainer canary failed its post-deploy health check — rolling back",
        detail: marker.prUrl,
      });
      recordFixFailure(FAILURE_MEMORY, {
        at: new Date().toISOString(),
        reason: "canary-unhealthy",
        prTitle: marker.fix?.prTitle,
        prUrl: marker.prUrl,
        changes: marker.fix?.changes,
        rootCause: marker.fix?.rootCause,
        detail: "the swapped code booted but did not serve /api/health",
      });
      const rolled = rollback(process.cwd(), dataDir);
      console.error(`[maintainer] canary unhealthy — ${rolled ? "rolled back to previous code" : "NO backup to roll back to"}; PR left unmerged: ${marker.prUrl ?? ""}`);
      if (rolled) {
        try {
          (await import("node:child_process")).execSync("npm install --no-audit --no-fund", { cwd: process.cwd(), stdio: "inherit" });
        } catch {
          /* best effort; boot-guard remains as the backstop */
        }
        process.exit(1); // restart into the restored, known-good code
      }
      return;
    }
    // Canary healthy → clear the rollback marker FIRST, so a slow promotion can never cause the
    // boot-guard to roll back an already-healthy service on a later restart.
    confirmSwapHealthy(process.cwd(), dataDir);
    console.log(`[maintainer] canary verified healthy — cleared rollback marker.${marker.prUrl ? ` (${marker.prUrl})` : ""}`);
    // Then PROMOTE: merge the PR so main adopts the now-proven fix. Promotion is gated by the
    // OUTER GUARD (the required CI check on main) and is best-effort — the running service
    // already has the fix, so a promotion failure never rolls it back, only flags a human.
    if (marker.promote) await promote(marker.promote, marker.prUrl, marker.fix);
  }, 20_000);
}

// Promote a canary-verified fix to main, respecting the OUTER GUARD (the required CI status
// check on main). Preference order:
//   1. GitHub-native auto-merge — GitHub itself merges once the required check passes, so the
//      guard is enforced server-side even if this process's own gates were ever weakened.
//   2. Fallback (no branch protection / auto-merge configured): self-enforce the guard by
//      polling CI and merging only on green. A failed/stuck CI leaves the PR open + an incident.
async function promote(
  p: { repo: string; prNumber: number; nodeId: string },
  prUrl?: string,
  fix?: { prTitle?: string; changes?: string[]; rootCause?: string },
): Promise<void> {
  const ref = prUrl ?? `PR #${p.prNumber}`;
  const noteFailure = (reason: "ci-failed" | "ci-timeout", detail: string) =>
    recordFixFailure(FAILURE_MEMORY, { at: new Date().toISOString(), reason, prTitle: fix?.prTitle, prUrl, changes: fix?.changes, rootCause: fix?.rootCause, detail });
  try {
    await github.enableAutoMerge(p.nodeId);
    console.log(`[maintainer] auto-merge enabled — GitHub will merge ${ref} once the required CI check passes.`);
    return;
  } catch (err) {
    console.warn(`[maintainer] native auto-merge unavailable (${err instanceof Error ? err.message : String(err)}) — falling back to CI-gated merge.`);
  }

  const deadline = Date.now() + 10 * 60 * 1000; // give CI up to 10 minutes
  while (Date.now() < deadline) {
    let status: "pending" | "success" | "failure";
    try {
      status = await github.getChecksStatus(p.repo, p.prNumber);
    } catch (err) {
      console.warn(`[maintainer] could not read CI status for ${ref}: ${err instanceof Error ? err.message : String(err)}`);
      await new Promise((r) => setTimeout(r, 15_000));
      continue;
    }
    if (status === "failure") {
      recordIncident({
        source: "health-check",
        severity: "warn",
        summary: "maintainer canary healthy but its PR FAILED the required CI check — NOT merged to main",
        detail: ref,
      });
      noteFailure("ci-failed", "the required CI check on main went red for this fix");
      console.warn(`[maintainer] CI failed for ${ref} — leaving the PR open (main untouched).`);
      return;
    }
    if (status === "success") {
      try {
        await github.mergePullRequest(p.repo, p.prNumber);
        console.log(`[maintainer] CI green — promoted (merged) ${ref} to main.`);
      } catch (err) {
        recordIncident({
          source: "health-check",
          severity: "warn",
          summary: "maintainer canary healthy and CI green but the merge call failed — merge it manually",
          detail: `${ref} ${err instanceof Error ? err.message : String(err)}`.trim(),
        });
        console.warn(`[maintainer] merge failed for ${ref}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 15_000)); // pending → wait and re-check
  }
  recordIncident({
    source: "health-check",
    severity: "warn",
    summary: "maintainer canary healthy but its PR's CI did not complete in time — merge it manually once green",
    detail: ref,
  });
  noteFailure("ci-timeout", "the required CI check did not complete within the promote window");
  console.warn(`[maintainer] CI did not complete in time for ${ref} — PR left open.`);
}

// Canary health probe: two health checks a few seconds apart must both succeed, so a
// momentary boot blip doesn't pass as healthy. The full test suite already ran in the
// pre-deploy gate; this confirms the code actually boots and serves in the real container.
async function canaryHealthy(): Promise<boolean> {
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`);
      if (!res.ok) return false;
    } catch {
      return false;
    }
    if (i === 0) await new Promise((r) => setTimeout(r, 3_000));
  }
  return true;
}

// If boot-guard.mjs rolled back a crash-looping swap, it left a bridge file (it can't use the
// app's modules). Fold it into the maintainer's failure memory + an incident so the agent learns
// the fix crash-looped, then remove the bridge.
function recoverRollbackRecord(): void {
  const raw = realMemoryFs.read(ROLLBACK_BRIDGE);
  if (!raw) return;
  try {
    const m = JSON.parse(raw) as { prUrl?: string; fix?: { prTitle?: string; changes?: string[]; rootCause?: string } };
    recordFixFailure(FAILURE_MEMORY, {
      at: new Date().toISOString(),
      reason: "boot-crash-loop",
      prTitle: m.fix?.prTitle,
      prUrl: m.prUrl,
      changes: m.fix?.changes,
      rootCause: m.fix?.rootCause,
      detail: "the swapped code failed to boot repeatedly; boot-guard restored the previous code",
    });
    recordIncident({
      source: "health-check",
      severity: "critical",
      summary: "a maintainer fix crash-looped and was rolled back by the boot-guard",
      detail: m.prUrl,
    });
    console.error(`[maintainer] recovered from a boot-guard rollback — recorded to failure memory.${m.prUrl ? ` (${m.prUrl})` : ""}`);
  } catch {
    /* corrupt bridge — ignore */
  }
  realMemoryFs.remove(ROLLBACK_BRIDGE);
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
  // Make global fetch proxy-aware (HTTP(S)_PROXY/NO_PROXY) from boot, before any GitHub API or
  // health call. No-op when no proxy is configured. (A per-run build refines the timeouts.)
  const startupTimeout = Number(process.env.OPENCODE_TIMEOUT_MS) || 900_000;
  installHttpDispatcher(startupTimeout).catch((err) => console.warn(`[qa] HTTP dispatcher setup failed: ${err instanceof Error ? err.message : String(err)}`));
  // Start the SSE event stream from OpenCode so agent activity (tool calls,
  // file edits, streaming text) is routed to RunRecord logs in real time.
  startEventStream(
    (runId, text) => appendLog(runId, text),
    eventStreamController.signal,
  ).catch((err) => console.warn(`[qa] event stream failed: ${err instanceof Error ? err.message : String(err)}`));
  recoverRollbackRecord();
  confirmSwapAfterBoot();
  finalizeInterruptedRuns();
  startHealthPoller();
  recoverMaintainerState();
});
