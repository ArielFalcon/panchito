// The single funnel for starting a run. EVERY trigger — webhook, control API, and
// the CLI — goes through here, so there is exactly ONE queued, recorded,
// API-addressable entity per run. This is what makes "the control API is the single
// contract" actually true: nothing may start a pipeline that bypasses the sequential
// queue (which would run concurrent QA against DEV) or the run history (which would be
// invisible to the TUI/continue/chat). See docs/interactive-layer.md §3.1.

import { JobQueue } from "./queue";
import { runPipeline, defaultPipelineDeps, PipelineDeps } from "../pipeline";
import { loadAppConfig, AppConfig } from "../orchestrator/config-loader";
import { createRecord, updateRecord, addCase, getRecord, appendLog } from "./history";
import { recordIncident } from "./maintainer";
import { RunMode, TestTarget, TriggerSource, QaCase } from "../types";

export interface RunRequest {
  app: string;
  sha: string;
  target: TestTarget;
  mode: RunMode;
  guidance?: string;
  source?: TriggerSource; // "webhook" (default) | "manual"
  fixCases?: QaCase[]; // continuation: failed cases to fix in the first generation
  parentRunId?: string; // continuation: the run this continues
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
  const record = createRecord({ app: req.app, sha: req.sha, target: req.target, mode: req.mode, parentRunId: req.parentRunId });
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
      const run = await runPipeline(
        appConfig,
        req.sha,
        {
          ...(deps.pipeline ?? defaultPipelineDeps()),
          // Pipe every log message into the RunRecord so the chat assistant and
          // TUI have real-time context on what the pipeline is doing.
          log: (msg: string) => {
            console.log(msg);
            appendLog(record.id, msg);
          },
        },
        req.source ?? "webhook",
        { mode: req.mode, target: req.target, guidance: req.guidance, fixCases: req.fixCases, parentRunId: req.parentRunId, previousNamespace: req.previousNamespace },
        (step, detail) => updateRecord(record.id, { step, stepDetail: detail, retrying: step === "retry" }),
        (c) => addCase(record.id, c),
        (specs) => updateRecord(record.id, { specs }),
        signal,
      );
      updateRecord(record.id, {
        status: "done",
        verdict: run.verdict,
        step: "done",
        retrying: false,
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
      recordIncident({ source: "qa-generator", severity: "error", summary: `pipeline crash for ${req.app}: ${msg}` });
    }
  });

  return record.id;
}
