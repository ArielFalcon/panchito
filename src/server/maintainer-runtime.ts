// Auto-maintenance runtime — extracted from index.ts (ARCH-01) so the orchestrator entrypoint is a
// thin composition root and the self-deploy path is, for the first time, isolated and testable.
//
// This is the single most dangerous code in the system: it diagnoses an incident with an agent,
// opens a fix PR, and — when opted in (SELF_MAINTAINER_AUTOMERGE) and every gate in merge-guard.ts
// passes — HOT-SWAPS the fix into the running service (canary), then promotes it to main only after
// the canary proves healthy. The deterministic gate SEQUENCING lives here; the irreversible actions
// (performSwap, github.mergePullRequest, process.exit) are the injected boundaries. See
// docs/self-maintenance.md before touching this.
//
// Behaviour is byte-for-byte identical to the previous in-index.ts implementation; the only changes
// are dependency injection: the closure config (queue, agent deps, the shuttingDown setter, the
// repo identity, the port) arrives via MaintainerConfig, and the side effects (github, the
// self-update swap primitives, exec/exit/health-fetch, the git mirror) via MaintainerSideEffects.

import { join } from "node:path";
import { execSync } from "node:child_process";
import { recordIncident, setMaintainerStatus, getIncidents, updateIncident } from "./maintainer";
import { parseMaintainerSummary } from "./maintainer-summary";
import { assessChange, assessRate, parseNumstat, readDeployHistory, recordDeploy } from "./merge-guard";
import {
  performSwap,
  confirmSwapHealthy,
  rollback,
  realSwapFs,
  SWAP_MARKER_FILE,
  writePendingPromote,
  readPendingPromote,
  clearPendingPromote,
} from "./self-update";
import { recordFixFailure, readFixFailures, renderFailureMemory, realMemoryFs } from "./maintainer-memory";
import { defaultMirrorDeps, authHeaderArgs, type MirrorDeps } from "../integrations/repo-mirror";
import { github } from "../integrations/github";
// migration-tier-4b Slice 1: scrubEnv's prior home (src/qa/code-runner.ts) is deleted this slice —
// re-point to the qa-engine twin (narrow legacy allowlist, unchanged for this consumer).
import { scrubEnv } from "../../qa-engine/src/shared-infrastructure/process-sandbox/scrub-env";
import { logJson } from "../integrations/logger";
import { RedactionPortAdapter } from "../orchestrator/sanitizer";
import type { AgentDeps } from "../integrations/opencode-client";

// sdd/migration-wiring-phase-2 Slice 7b-2: the canonical redaction adapter (env+pattern) for this
// file's incident/session-failure error logging, replacing src/util/redact.ts's redactError.
const redactionPort = new RedactionPortAdapter();

// The closure config the runtime needs from the composition root (index.ts). These are values that
// only the entrypoint owns: the live job queue, the current agent deps, the entrypoint's
// `shuttingDown` flag setter, the self-repo identity, and the HTTP port the canary probes.
export interface MaintainerConfig {
  queue: { drain(): Promise<unknown> };
  getAgentDeps: () => AgentDeps;
  setShuttingDown: (v: boolean) => void;
  root: string;
  selfRepo: string;
  autonomous: boolean; // SELF_MAINTAINER_AUTOMERGE — the ops kill-switch (default off)
  port: number;
}

// The irreversible / hard-to-test boundaries, injected so the gate sequencing above them can be
// unit-tested without actually swapping code, merging PRs, exec-ing npm, or exiting the process.
export interface MaintainerSideEffects {
  github: typeof github;
  performSwap: typeof performSwap;
  confirmSwapHealthy: typeof confirmSwapHealthy;
  rollback: typeof rollback;
  realSwapFs: typeof realSwapFs;
  mirrorDeps: MirrorDeps;
  exec: (command: string, opts: { cwd: string; stdio: "inherit"; env: NodeJS.ProcessEnv }) => void;
  exit: (code: number) => never;
  fetchHealth: (port: number) => Promise<{ ok: boolean }>;
}

export function defaultMaintainerSideEffects(): MaintainerSideEffects {
  return {
    github,
    performSwap,
    confirmSwapHealthy,
    rollback,
    realSwapFs,
    mirrorDeps: defaultMirrorDeps,
    exec: (command, opts) => {
      execSync(command, opts);
    },
    exit: (code) => process.exit(code),
    fetchHealth: async (port) => {
      const res = await fetch(`http://localhost:${port}/api/health`);
      return { ok: res.ok };
    },
  };
}

export interface MaintainerRuntime {
  triggerMaintainer: () => Promise<void>;
  confirmSwapAfterBoot: () => void;
  recoverMaintainerState: () => void;
  recoverRollbackRecord: () => void;
}

export function createMaintainerRuntime(cfg: MaintainerConfig, fx: MaintainerSideEffects = defaultMaintainerSideEffects()): MaintainerRuntime {
  // Persisted ledgers live on the data volume so they survive the restart a hot-swap triggers.
  const DEPLOY_LEDGER = join(cfg.root, "data", "maintainer-deploys.json");
  const FAILURE_MEMORY = join(cfg.root, "data", "maintainer-failures.json");
  const ROLLBACK_BRIDGE = join(cfg.root, "data", "last-rollback.json");

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Clone panchito into a persistent working copy (or fetch + reset an existing one to main).
  async function ensureMirrorSelf(dir: string, mdeps: MirrorDeps): Promise<void> {
    const base = process.env.GIT_REMOTE_BASE ?? "https://github.com";
    const url = `${base}/${cfg.selfRepo}.git`;
    if (!mdeps.exists(dir)) {
      await mdeps.git([...authHeaderArgs(), "clone", url, dir]);
    } else {
      await mdeps.git([...authHeaderArgs(), "fetch", "origin"], dir);
      await mdeps.git(["checkout", "-f", "main"], dir);
      await mdeps.git(["reset", "--hard", "origin/main"], dir);
    }
  }

  async function triggerMaintainer(): Promise<void> {
    const pending = getIncidents().filter((i) => i.status === "pending");
    if (pending.length === 0) return;

    setMaintainerStatus("diagnosing");
    const deps = cfg.getAgentDeps();

    // Use the mirrors directory for the working copy (survives restarts as volume)
    const maintainerWorkDir = join(
      process.env.MIRROR_DIR ?? join(process.cwd(), ".mirrors"),
      "panchito-self"
    );

    const branchName = `qa/maintainer-${Date.now().toString(36)}`;

    try {
      // Step 1: Prepare working copy (clone/fetch + create branch)
      const mirrorDeps = fx.mirrorDeps;
      await ensureMirrorSelf(maintainerWorkDir, mirrorDeps);
      await mirrorDeps.git(["checkout", "-B", branchName], maintainerWorkDir);

      // Step 2: Open agent session to diagnose and fix.
      // Phase 0b: thread the role descriptor; runId is intentionally absent — the maintainer is
      // not triggered by a watched-repo run and has no parent runId to associate with.
      const session = await deps.open("qa-maintainer", maintainerWorkDir, {
        descriptor: { role: "qa-maintainer" },
      });
      try {
        // Inject the memory of past failed fixes so the agent does not repeat a change that
        // already broke the service for the same reason.
        const failureMemory = renderFailureMemory(readFixFailures(FAILURE_MEMORY));
        const prompt = [
          "## Incident report",
          "",
          "The following incident(s) were detected in the panchito system.",
          "Diagnose the root cause in the codebase (you are in the panchito repo)",
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
        const name = process.env.GIT_AUTHOR_NAME ?? "panchito";
        const email = process.env.GIT_AUTHOR_EMAIL ?? "panchito@users.noreply.github.com";

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

        const pr = await fx.github.createPullRequest(cfg.selfRepo, {
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
            "⚠️ **Review required before merge.** This PR was auto-generated by the panchito maintainer agent.",
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
        if (!cfg.autonomous) return leaveForHuman("autonomous deploy disabled (SELF_MAINTAINER_AUTOMERGE=false)");

        // Layer 3 — scope guard: the fix must be minimal and must NOT touch the recovery net or
        // build/topology the canary cannot verify (boot-guard, self-update, merge-guard, …).
        // --no-renames so a renamed protected file surfaces as a delete of its (protected) path
        // rather than a single "old => new" entry that would slip past isProtectedPath.
        const numstat = await mirrorDeps.git(["diff", "--numstat", "--no-renames", "origin/main...HEAD"], maintainerWorkDir);
        const scope = assessChange(parseNumstat(numstat));
        if (!scope.ok) return leaveForHuman(scope.reasons.join("; "), "critical");

        // Layer 4 — rate / loop guard: cap autonomous deploys per window + cooldown, so a fix
        // that doesn't fix cannot loop the system into endless self-modification.
        const rate = assessRate(readDeployHistory(DEPLOY_LEDGER), Date.now());
        if (!rate.ok) return leaveForHuman(rate.reasons.join("; "), "critical");

        // Layer 5 — pre-deploy self-test gate: install + typecheck + tests on the fix branch.
        // A fix that fails its OWN gate is never deployed. Run with a scrubbed env so
        // agent-authored code (tests, package.json scripts) cannot access secrets.
        const scrubbed = scrubEnv();
        try {
          fx.exec("npm install --no-audit --no-fund", { cwd: maintainerWorkDir, stdio: "inherit", env: scrubbed });
          fx.exec("npm run typecheck", { cwd: maintainerWorkDir, stdio: "inherit", env: scrubbed });
          fx.exec("npm test", { cwd: maintainerWorkDir, stdio: "inherit", env: scrubbed });
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
        // Stop ACCEPTING new runs BEFORE draining (SELF-07): otherwise a webhook arriving in the
        // window between drain() and process.exit() would start a run that then races performSwap's
        // src/ rewrite (reading a half-swapped tree) or gets SIGKILLed mid-flight on exit.
        cfg.setShuttingDown(true);
        console.log("[maintainer] all safety gates green — no longer accepting runs; waiting for the queue to drain before canary swap...");
        await cfg.queue.drain();

        // Swap the fix-branch code into the running tree (with backup + boot-guard marker) and
        // attach the PR so the post-restart health check PROMOTES it (merges to main) only once
        // the canary is healthy. boot-guard.mjs (never swapped) restores the backup if the new
        // code fails to boot — and because the PR is unmerged at this point, a rollback leaves
        // main pristine, so the service can never reach an unrecoverable state. If performSwap
        // throws (e.g. a bind-mounted src/ in dev → EBUSY), the outer catch leaves the PR for a
        // human and nothing is deployed — it fails safe.
        fx.performSwap(process.cwd(), maintainerWorkDir, join(cfg.root, "data"), {
          at: new Date().toISOString(),
          prUrl: pr.url,
          promote: { repo: cfg.selfRepo, prNumber: pr.number, nodeId: pr.nodeId },
          fix: { prTitle: summary.prTitle, changes: summary.changes, rootCause: summary.justification.rootCause },
        });
        // The swap is staged → count the deploy in the persisted ledger (survives the restart) so
        // the rate guard sees it. Only counted once the swap actually succeeded.
        recordDeploy(DEPLOY_LEDGER, Date.now());
        // Best-effort dep sync for the new code. If it fails we still restart: the swapped code's
        // boot will fail and the boot-guard rolls back — never leave a staged swap unapplied.
        try {
          // Scrub orchestrator secrets: this runs the just-swapped (agent-authored) package.json's
          // install lifecycle, consistent with the scrubbed pre-deploy gate.
          fx.exec("npm install --no-audit --no-fund", { cwd: process.cwd(), stdio: "inherit", env: scrubEnv() });
        } catch (installErr) {
          console.error(`[maintainer] post-swap npm install failed (${redactionPort.redactError(installErr)}) — restarting anyway; boot-guard is the backstop.`);
        }
        console.log("[maintainer] canary swap staged with rollback guard — restarting to verify, then promote.");
        fx.exit(0);

      } finally {
        await session.dispose().catch((err) => {
          console.warn(`[qa] session dispose failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    } catch (err) {
      setMaintainerStatus("idle");
      console.error(`[maintainer] session failed: ${redactionPort.redactError(err)}`);
      // Mark incidents as needing manual attention
      for (const inc of pending) {
        updateIncident(inc.id, { status: "diagnosing" });
      }
    }
  }

  function recoverMaintainerState(): void {
    const diagnosing = getIncidents().filter((i) => i.status === "diagnosing");
    if (diagnosing.length > 0) {
      logJson("info", "maintainer recovering: incidents were mid-diagnosis; re-triggering", { count: diagnosing.length });
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
    const dataDir = join(cfg.root, "data");
    const marker = fx.realSwapFs.readMarker(join(dataDir, SWAP_MARKER_FILE));
    if (!marker) {
      // No swap pending — but a promote may have been mid-poll when a prior boot died (SELF-03):
      // re-drive it so the merge/bookkeeping is not silently lost. Cleared on any terminal outcome.
      const pending = readPendingPromote(dataDir);
      if (pending?.promote) {
        logJson("info", "re-driving a promote interrupted by a restart", { prUrl: pending.prUrl ?? "" });
        void (async () => {
          try {
            await promote(pending.promote, pending.prUrl, pending.fix);
          } finally {
            clearPendingPromote(dataDir);
          }
        })();
      }
      return;
    }
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
        const rolled = fx.rollback(process.cwd(), dataDir);
        logJson("error", "canary unhealthy — rolled back or no backup", { rolled, prUrl: marker.prUrl ?? "" });
        if (rolled) {
          try {
            fx.exec("npm install --no-audit --no-fund", { cwd: process.cwd(), stdio: "inherit", env: scrubEnv() });
          } catch {
            /* best effort; boot-guard remains as the backstop */
          }
          fx.exit(1); // restart into the restored, known-good code
        }
        return;
      }
      // Canary healthy → clear the rollback marker FIRST, so a slow promotion can never cause the
      // boot-guard to roll back an already-healthy service on a later restart.
      fx.confirmSwapHealthy(process.cwd(), dataDir);
      logJson("info", "canary verified healthy — cleared rollback marker", { prUrl: marker.prUrl });
      // Then PROMOTE: merge the PR so main adopts the now-proven fix. Promotion is gated by the
      // OUTER GUARD (the required CI check on main) and is best-effort — the running service
      // already has the fix, so a promotion failure never rolls it back, only flags a human.
      // Record the in-flight promote durably (SELF-03) so a crash during the up-to-10-min poll
      // re-drives it on the next boot instead of dropping it; clear it on any terminal outcome.
      if (marker.promote) {
        writePendingPromote(dataDir, { promote: marker.promote, prUrl: marker.prUrl, fix: marker.fix, at: new Date().toISOString() });
        try {
          await promote(marker.promote, marker.prUrl, marker.fix);
        } finally {
          clearPendingPromote(dataDir);
        }
      }
    }, 20_000);
  }

  // Promote a canary-verified fix to main, respecting the OUTER GUARD (the required CI check on
  // main). It (1) enables GitHub-native auto-merge so the guard is enforced server-side even if
  // this process dies, and (2) ALWAYS observes the outcome by polling — so it merges itself when
  // there is no branch protection, and records a failure into the maintainer memory whenever CI
  // goes red, for BOTH paths. The running service already has the fix, so a promote failure never
  // rolls anything back; it only leaves the PR open and flags a human.
  async function promote(
    p: { repo: string; prNumber: number; nodeId: string },
    prUrl?: string,
    fix?: { prTitle?: string; changes?: string[]; rootCause?: string },
  ): Promise<void> {
    const ref = prUrl ?? `PR #${p.prNumber}`;
    const noteFailure = (reason: "ci-failed" | "ci-timeout", detail: string) =>
      recordFixFailure(FAILURE_MEMORY, { at: new Date().toISOString(), reason, prTitle: fix?.prTitle, prUrl, changes: fix?.changes, rootCause: fix?.rootCause, detail });

    // 1. Prefer GitHub-native auto-merge (server-side enforcement; survives our death). Unavailable
    //    without branch protection — then we self-enforce by polling below.
    let autoMerge = false;
    try {
      await fx.github.enableAutoMerge(p.nodeId);
      autoMerge = true;
      logJson("info", "auto-merge enabled — GitHub will merge once CI passes", { ref });
    } catch (err) {
      logJson("warn", "native auto-merge unavailable — self-enforcing the CI gate", { ref, error: err instanceof Error ? err.message : String(err) });
    }

    // 2. Observe the outcome so we both finish the merge when appropriate and LEARN on CI failure.
    const start = Date.now();
    const deadline = start + 10 * 60 * 1000; // up to 10 min for CI to complete / auto-merge to land
    while (Date.now() < deadline) {
      let s: { merged: boolean; state: string; checks: "pending" | "success" | "failure" | "none" };
      try {
        // Gate the promote decision on the NAMED required check (the job id `ci`, per
        // .github/workflows/ci.yml + setup-branch-protection.sh), not an aggregate of every check —
        // so an unrelated check can neither falsely block nor falsely satisfy the outer guard.
        // Configurable for repos whose required check has a different name.
        const requiredCheck = process.env.SELF_MAINTAINER_CI_CHECK || "ci";
        s = await fx.github.getPrStatus(p.repo, p.prNumber, undefined, requiredCheck);
      } catch (err) {
        logJson("warn", "could not read PR status", { ref, error: err instanceof Error ? err.message : String(err) });
        await sleep(15_000);
        continue;
      }
      if (s.merged) {
        logJson("info", "promoted (merged) to main", { ref });
        return;
      }
      if (s.state === "closed") {
        noteFailure("ci-failed", "the PR was closed without merging");
        logJson("warn", "PR was closed without merging — not promoted", { ref });
        return;
      }
      if (s.checks === "failure") {
        recordIncident({
          source: "health-check",
          severity: "warn",
          summary: "maintainer canary healthy but its PR FAILED the required CI check — NOT merged to main",
          detail: ref,
        });
        noteFailure("ci-failed", "the required CI check on main went red for this fix");
        logJson("warn", "CI failed — leaving the PR open (main untouched)", { ref });
        return;
      }
      if (!autoMerge) {
        // No branch protection + no native auto-merge: the PR must be merged by a human.
        // Self-merging in-process reads check state and merges its own code — a single
        // point of failure that collapses the outer guard. The doc's guarantee that
        // "GitHub itself refuses a bad merge" requires branch protection, which code
        // can't enforce — so we refuse the self-merge fallback entirely.
        recordIncident({
          source: "health-check",
          severity: "warn",
          summary: "maintainer canary healthy but branch protection/auto-merge is not configured — PR left for a human to review and merge",
          detail: ref,
        });
        logJson("warn", "no branch protection — PR left open for human review", { ref });
        return;
      }
      // pending; or (autoMerge waiting for GitHub to land the merge).
      await sleep(15_000);
    }
    recordIncident({
      source: "health-check",
      severity: "warn",
      summary: "maintainer canary healthy but its PR did not merge in time (CI slow/stuck) — finish it manually",
      detail: ref,
    });
    noteFailure("ci-timeout", "the required CI check did not complete (or auto-merge did not land) within the promote window");
    logJson("warn", "promote timed out — PR left open", { ref });
  }

  // Canary health probe: two health checks a few seconds apart must both succeed, so a
  // momentary boot blip doesn't pass as healthy. The full test suite already ran in the
  // pre-deploy gate; this confirms the code actually boots and serves in the real container.
  async function canaryHealthy(): Promise<boolean> {
    for (let i = 0; i < 2; i++) {
      try {
        const res = await fx.fetchHealth(cfg.port);
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

  return { triggerMaintainer, confirmSwapAfterBoot, recoverMaintainerState, recoverRollbackRecord };
}
