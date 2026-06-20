// The single funnel for starting a run. EVERY trigger — webhook, control API, and
// the CLI — goes through here, so there is exactly ONE queued, recorded,
// API-addressable entity per run. This is what makes "the control API is the single
// contract" actually true: nothing may start a pipeline that bypasses the sequential
// queue (which would run concurrent QA against DEV) or the run history (which would be
// invisible to the TUI/continue/chat). See docs/interactive-layer.md §3.1.

import { JobQueue } from "./queue";
import { runPipeline, defaultPipelineDeps, PipelineDeps } from "../pipeline";
import { loadAppConfig, AppConfig } from "../orchestrator/config-loader";
import { createRecord, updateRecord, addCase, getRecord, appendLog, appendActivity, listRecords } from "./history";
import { recordIncident } from "./maintainer";
import { testDataNamespace } from "../qa/test-data";
import { RunMode, TestTarget, TriggerSource, QaCase, engineStatus } from "../types";
import { activityRouter } from "../integrations/opencode-client";
import { redactError } from "../util/redact";
import { isInfraError } from "../errors";
import { logJson } from "../integrations/logger";
import type { RunEventStore } from "./run-events";
import type { RunEventBody } from "../contract/events";

type RunStepEvent = Extract<RunEventBody, { type: "step.changed" }>;
type RunStep = RunStepEvent["step"];

const RUN_EVENT_STEPS = new Set<RunStep>([
  "gate", "classify", "setup", "generate", "validate", "health", "execute", "coverage", "retry", "decide", "done",
]);

function isRunStep(value: string): value is RunStep {
  return RUN_EVENT_STEPS.has(value as RunStep);
}

// Classify a pipeline log line for the TUI's log tail. Heuristic on content — the
// pipeline logs plain strings, so there is no structured level to read.
function logLevelFor(text: string): "info" | "warn" | "error" {
  if (/✗|\berror\b|\bfailed\b|crash/i.test(text)) return "error";
  if (/⚠|\bwarn(?:ing)?\b|flaky|quarantin/i.test(text)) return "warn";
  return "info";
}

export interface RunRequest {
  app: string;
  sha: string;
  target: TestTarget;
  mode: RunMode;
  guidance?: string;
  shadow?: boolean;
  source?: TriggerSource; // "webhook" (default) | "manual"
  fixCases?: QaCase[]; // continuation: failed cases to fix in the first generation
  parentRunId?: string; // continuation: the run this continues
  triggerRepo?: string; // cross-repo runs: the service repo whose commit originated this run
  previousNamespace?: string; // cleanup: namespace from an interrupted previous run
  commits?: number; // diff mode: how many commits ending at the SHA the diff spans (default 1)
}

// Side-effecting collaborators, injected so the funnel is unit-testable with stubs.
export interface RunnerDeps {
  pipeline?: PipelineDeps; // defaults to the real deps, built per run
  loadApp?: (name: string) => AppConfig; // defaults to the real config loader
  runEvents?: RunEventStore;
}

// Creates the tracked RunRecord and enqueues the pipeline on the shared queue.
// Returns the record id immediately (the run executes asynchronously, one at a time).
export function enqueueTrackedRun(queue: JobQueue, req: RunRequest, deps: RunnerDeps = {}): string {
  const loadApp = deps.loadApp ?? loadAppConfig;

  // Orphan-data cleanup runs through the SINGLE funnel so EVERY trigger (webhook, CLI,
  // continuation) cleans an interrupted prior run's DEV data — not only the webhook. The
  // prior run's exact namespace is reconstructed from its record (same prefix/sha/runId).
  let previousNamespace = req.previousNamespace;
  if (previousNamespace === undefined) {
    try {
      const prev = listRecords(req.app, 1)[0];
      const wasInterrupted = prev && (prev.status === "running" || prev.status === "enqueued" || prev.verdict === "infra-error");
      if (wasInterrupted) {
        previousNamespace = testDataNamespace(loadApp(req.app).qa.testDataPrefix, prev.sha, prev.id);
      }
    } catch {
      /* best-effort: skip cleanup if the prior record/config is unavailable */
    }
  }

  const record = createRecord({ app: req.app, sha: req.sha, target: req.target, mode: req.mode, parentRunId: req.parentRunId, triggerRepo: req.triggerRepo });
  console.log(`[qa] enqueued ${req.app}@${req.sha} mode=${req.mode}${req.parentRunId ? ` (continue of ${req.parentRunId})` : ""} (queue: ${queue.size + 1})`);

  queue.enqueue(async (signal) => {
    try {
      // If the run was cancelled while still enqueued, the record is already finalized
      // (status "done"). Skip it — do NOT resurrect a cancelled run into execution.
      if (getRecord(record.id)?.status === "done") {
        console.log(`[qa] skipping ${req.app}@${req.sha} — cancelled before it started`);
        return;
      }
      updateRecord(record.id, { status: "running" });
      const appConfig = loadApp(req.app);
      deps.runEvents?.publish(record.id, { type: "run.started", app: req.app, sha: req.sha, mode: req.mode, target: req.target });
      // Runtime shadow override from the TUI/API takes precedence over the YAML config.
      if (req.shadow !== undefined) {
        appConfig.qa.shadow = req.shadow;
      }
      const pipeline = deps.pipeline ?? defaultPipelineDeps();
      // Pipe every pipeline log line into THREE sinks: the console, the RunRecord (the
      // chat assistant's context) and — the missing link — a `log.line` event per line so
      // the TUI surfaces real-time progress instead of the user having to ask the chat.
      // Multi-line blobs (e.g. test-runner stdout) are split so each renders as its own row.
      const emitLog = (msg: string) => {
        console.log(msg); // human-readable plain line for local/stdout visibility
        // Structured, runId-correlated copy into the SHIPPED JSON stream (OBS-03): the per-run
        // verdict reasoning was previously console-only / SQLite-blob-only and absent from the
        // log stream an operator scrapes. file-only (mirrorToConsole=false) so console isn't doubled.
        logJson(logLevelFor(msg), msg, { runId: record.id, app: req.app, sha: req.sha }, false);
        appendLog(record.id, msg);
        for (const raw of String(msg).split("\n")) {
          const text = raw.replace(/\s+$/, "");
          if (text) deps.runEvents?.publish(record.id, { type: "log.line", level: logLevelFor(text), text });
        }
      };
      const run = await runPipeline(
        appConfig,
        req.sha,
        {
          ...pipeline,
          log: emitLog,
          // During generation, emit a heartbeat every 15s so the TUI and chat
          // have live feedback while the agent is working (blocking prompt call).
          // FORWARD onUsage (4th arg): the runner keeps its OWN progress callback for live
          // heartbeats, but must pass the usage sink through or the generator's token spend is
          // never captured in the webhook path (only the reviewer's would be).
          generate: async (input, signal, _onProgress, onUsage) => {
            const onProgress = emitLog;
            return pipeline.generate({ ...input, runId: record.id }, signal, (msg) => {
              // Enrich heartbeat messages with live agent context.
              const m = msg.match(/agent is working... \((\d+)s elapsed\)/);
              if (m) {
                const ctx = activityRouter.contextForRun(record.id);
                const parts = [`agent active (${m[1]}s)`];
                if (ctx) parts.push(`— ${ctx}`);
                onProgress(`[qa] ${parts.join(" ")}`);
                return;
              }
              onProgress(msg);
            }, onUsage);
          },
        },
        req.source ?? "webhook",
        { mode: req.mode, target: req.target, guidance: req.guidance, fixCases: req.fixCases, parentRunId: req.parentRunId, triggerRepo: req.triggerRepo, previousNamespace, runId: record.id, commits: req.commits },
        (step, detail) => {
          updateRecord(record.id, { step, stepDetail: detail, retrying: step === "retry" });
          const normalized = step === "publish" ? "decide" : step;
          if (isRunStep(normalized)) {
            deps.runEvents?.publish(record.id, { type: "step.changed", step: normalized, detail });
          }
        },
        // A test finished → persist the case (live bar/history) AND mark its activity
        // todo completed so it stops being the "running" focus.
        (c) => {
          addCase(record.id, c);
          appendActivity(record.id, { kind: "todo", text: c.name, status: "completed" });
          deps.runEvents?.publish(record.id, c.status === "pass"
            ? { type: "test.passed", name: c.name, durationMs: c.durationMs ?? 0 }
            : c.status === "fail"
              ? { type: "test.failed", name: c.name, detail: c.detail, ...(c.durationMs !== undefined ? { durationMs: c.durationMs } : {}) }
              : { type: "test.flaky", name: c.name, attempts: 2 });
        },
        (specs) => updateRecord(record.id, { specs }),
        signal,
        // A test started → it becomes the in-progress focus card during execute.
        (title) => {
          appendActivity(record.id, { kind: "todo", text: title, status: "in_progress" });
          deps.runEvents?.publish(record.id, { type: "test.started", name: title });
        },
        // The independent reviewer's verdict → the live ReviewerCard (reasons are the
        // actionable corrections on a rejection).
        (approved, reasons) => {
          deps.runEvents?.publish(record.id, { type: "reviewer.verdict", approved, reasons });
        },
        // Change-coverage result → the live coverage component (the value keystone).
        (changedLines, coveredLines) => {
          deps.runEvents?.publish(record.id, { type: "coverage.computed", changedLines, coveredLines });
        },
        // Each test the runner discovered up front → the live "next" preview.
        (name, file) => {
          deps.runEvents?.publish(record.id, { type: "test.discovered", name, ...(file ? { file } : {}) });
        },
      );
      deps.runEvents?.publish(record.id, {
        type: "run.verdict",
        verdict: run.verdict,
        engineStatus: engineStatus(run.verdict),
        passed: run.cases.filter((x) => x.status === "pass").length,
        failed: run.cases.filter((x) => x.status === "fail").length,
        // What the run PRODUCED (PR/Issue URL + merged state, or the reason note) — so the
        // TUI summary shows the real outcome, not a generic guess.
        ...(run.outcome || run.note ? { outcome: run.outcome ?? run.note } : {}),
      });
      updateRecord(record.id, {
        status: "done",
        verdict: run.verdict,
        step: "done",
        retrying: false,
        note: run.note || undefined,
        // passed/failed are NOT written here: addCase() is the single source of truth — it dedups
        // by name and recomputes both columns from the cases table on every streamed case (A18).
        // Writing them again from the in-memory run.cases gave two writers for one derived value
        // that could silently disagree with the table they are supposed to summarize.
      });
      console.log(`[qa] run finished ${req.app}@${req.sha}: verdict=${run.verdict}`);
    } catch (err) {
      // A crash MUST finalize the record (status=done) — otherwise it stays
      // "running" forever and `qa run --watch` hangs waiting for a verdict.
      const msg = redactError(err);
      // Classify by TYPE, not by substring. Genuine INFRASTRUCTURE (DeployTimeout, operator
      // cancel, anything wrapped in InfraError) is a transient, non-code condition. Anything else
      // thrown out of the pipeline (an OpenCode 500, a rejected git push, a JSON.parse that threw,
      // an open circuit breaker) is an UNEXPECTED INTERNAL ERROR — still inconclusive, but a defect
      // to surface, NOT silently laundered into a benign "infrastructure, ignore".
      const infra = isInfraError(err);
      const note = infra ? msg : `unexpected internal error (not infrastructure — investigate): ${msg}`;
      updateRecord(record.id, { status: "done", step: "done", verdict: "infra-error", note });
      deps.runEvents?.publish(record.id, { type: "agent.error", detail: note });
      deps.runEvents?.publish(record.id, { type: "run.verdict", verdict: "infra-error", engineStatus: engineStatus("infra-error") });
      console.error(`[qa] run ${infra ? "infra-error" : "CRASHED (internal error)"} ${req.app}@${req.sha}: ${msg}`);

      // Only a genuine infrastructure condition is exempt from a maintainer-eligible incident
      // (it must not trigger an autonomous self-modification for a non-code fault). An unexpected
      // internal error DOES record an incident so the failure is visible and not swallowed.
      if (!infra) {
        recordIncident({ source: "qa-generator", severity: "error", summary: `pipeline crash for ${req.app}: ${msg}` });
      }
    }
  }, record.id);

  return record.id;
}

// Cancels a tracked run on the shared queue, the counterpart to enqueueTrackedRun. Returns true
// ONLY when a LIVE run was aborted (its in-flight turn interrupted via the queue's AbortSignal).
//
// The subtle case this exists for: a record can read "running"/"enqueued" while the in-memory
// queue does NOT actually hold it — a zombie left by a process restart or crash race, or an
// operator view that lagged a queue advance. The old path returned without finalizing such a
// record, so the cancel endpoint answered 409 and the stuck run never cleared (it sat at "0%"
// forever, deaf to every stop press). Here we ALWAYS finalize a cancellable record:
//   - live run we hold        → abort its turn + finalize, return true
//   - enqueued (not started)  → finalize so the queued job skips itself,       return false
//   - stale "running" zombie  → finalize so the operator's stop clears it,      return false
// queue.cancel(id) is what protects an innocent successor: it aborts ONLY when `id` is the run
// currently holding the queue, so finalizing a stale record never touches the run that is
// actually executing against DEV. The boolean return + the now-terminal record together let
// handleCancelRun answer 200 vs 409 accurately.
export function cancelTrackedRun(queue: JobQueue, id: string): boolean {
  const record = getRecord(id);
  if (!record) return false;
  if (record.status !== "running" && record.status !== "enqueued") return false;

  // Abort the live job first — succeeds only when this id is the one holding the queue.
  if (record.status === "running" && queue.cancel(id)) {
    updateRecord(id, { status: "done", step: "done", verdict: "infra-error", note: "cancelled by operator" });
    return true;
  }

  // Not the live job: still enqueued (never started), or a "running" record the queue no longer
  // holds. Finalize it either way so it stops being the active run; the successor is untouched.
  const note = record.status === "enqueued"
    ? "cancelled by operator"
    : "cancelled by operator (run was no longer active)";
  updateRecord(id, { status: "done", step: "done", verdict: "infra-error", note });
  return false;
}
