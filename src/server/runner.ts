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
import { RunMode, TestTarget, TriggerSource, QaCase } from "../types";
import { activityRouter } from "../integrations/opencode-client";

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
}

// Side-effecting collaborators, injected so the funnel is unit-testable with stubs.
export interface RunnerDeps {
  pipeline?: PipelineDeps; // defaults to the real deps, built per run
  loadApp?: (name: string) => AppConfig; // defaults to the real config loader
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
      // Runtime shadow override from the TUI/API takes precedence over the YAML config.
      if (req.shadow !== undefined) {
        appConfig.qa.shadow = req.shadow;
      }
      const pipeline = deps.pipeline ?? defaultPipelineDeps();
      const run = await runPipeline(
        appConfig,
        req.sha,
        {
          ...pipeline,
          // Pipe every log message into the RunRecord so the chat assistant and
          // TUI have real-time context on what the pipeline is doing.
          log: (msg: string) => {
            console.log(msg);
            appendLog(record.id, msg);
          },
          // During generation, emit a heartbeat every 15s so the TUI and chat
          // have live feedback while the agent is working (blocking prompt call).
          generate: async (input, signal) => {
            const onProgress = (msg: string) => {
              console.log(msg);
              appendLog(record.id, msg);
            };
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
            });
          },
        },
        req.source ?? "webhook",
        { mode: req.mode, target: req.target, guidance: req.guidance, fixCases: req.fixCases, parentRunId: req.parentRunId, triggerRepo: req.triggerRepo, previousNamespace, runId: record.id },
        (step, detail) => updateRecord(record.id, { step, stepDetail: detail, retrying: step === "retry" }),
        // A test finished → persist the case (live bar/history) AND mark its activity
        // todo completed so it stops being the "running" focus.
        (c) => { addCase(record.id, c); appendActivity(record.id, { kind: "todo", text: c.name, status: "completed" }); },
        (specs) => updateRecord(record.id, { specs }),
        signal,
        // A test started → it becomes the in-progress focus card during execute.
        (title) => appendActivity(record.id, { kind: "todo", text: title, status: "in_progress" }),
      );
      updateRecord(record.id, {
        status: "done",
        verdict: run.verdict,
        step: "done",
        retrying: false,
        note: run.note || undefined,
        passed: run.cases.filter((x) => x.status === "pass").length,
        failed: run.cases.filter((x) => x.status === "fail").length,
      });
      console.log(`[qa] run finished ${req.app}@${req.sha}: verdict=${run.verdict}`);
    } catch (err) {
      // A crash MUST finalize the record (status=done) — otherwise it stays
      // "running" forever and `qa run --watch` hangs waiting for a verdict.
      const msg = err instanceof Error ? err.message : String(err);
      updateRecord(record.id, { status: "done", step: "done", verdict: "infra-error", note: msg });
      console.error(`[qa] run crashed ${req.app}@${req.sha}: ${msg}`);

      // Infrastructure errors (DEV deploy timeout, operator cancel, network) are
      // transient conditions — they must NOT create maintainer-eligible incidents
      // that could trigger an autonomous self-modification for a non-code fault.
      const isInfra =
        (err instanceof Error && err.name === "DeployTimeoutError") ||
        (msg.includes("run cancelled by operator"));
      if (!isInfra) {
        recordIncident({ source: "qa-generator", severity: "error", summary: `pipeline crash for ${req.app}: ${msg}` });
      }
    }
  });

  return record.id;
}
