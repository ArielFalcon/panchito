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
import { RunMode, TestTarget, TriggerSource, QaCase, QaRunResult, engineStatus } from "../types";
import { activityRouter } from "../integrations/opencode-client";
import { redactError } from "../util/redact";
import { isInfraError } from "../errors";
import { logJson } from "../integrations/logger";
import type { RunEventStore } from "./run-events";
import type { RunEventBody } from "../contract/events";
import { Sha } from "@kernel/sha";
import { selectEngine } from "@contexts/qa-run-orchestration/composition/pipeline-engine-flag";
import type { RunPipelinePort, RunInput, ObserverPort } from "@contexts/qa-run-orchestration/application/ports/index.ts";

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
  baseSha?: string; // PR/push range: when set, diff spans baseSha..sha (range diff)
}

// Side-effecting collaborators, injected so the funnel is unit-testable with stubs.
export interface RunnerDeps {
  pipeline?: PipelineDeps; // defaults to the real deps, built per run
  loadApp?: (name: string) => AppConfig; // defaults to the real config loader
  runEvents?: RunEventStore;
  // PIPELINE_ENGINE dispatch seam (Task E.3, Plan 6). ABSENT by default — this keeps the legacy
  // runPipeline path byte-identical to today (the flag is consulted, but with no factory supplied
  // the runner fails safe to legacy even if PIPELINE_ENGINE=rewritten; see the queue callback
  // below). When present, it is invoked ONLY after selectEngine(process.env) resolves to
  // "rewritten" — building the full RewrittenOrchestratorAdapter wiring (a real
  // qa-engine CompositionConfig: SandboxedBinaryRunner, Stryker/coverage collectors, the real
  // GitHub client, the agent runtime, …) is deliberately NOT this file's job — that heavy
  // assembly belongs to the caller (an operator script per Slice F.2), keeping this hot-path
  // dispatch free of qa-engine's leaf-IO imports.
  //
  // `namespace` (2nd param, judgment-day CRITICAL fix): the runner computes this PER RUN — see
  // enqueueTrackedRun's queue callback below — via testDataNamespace(app.qa.testDataPrefix, sha,
  // runId), the SAME formula legacy runPipeline uses at src/pipeline.ts:1222. Without this the
  // rewritten engine's own namespace/branch would be static, colliding every run of every app on
  // the same live-DEV test-data namespace the moment the flag flips.
  //
  // `run` (3rd param, audit-remediation fix): mode/guidance are PER-RUN values (req.mode/
  // req.guidance below) — the composition root's own CompositionConfig.mode/guidance feed straight
  // into Generation/Review prompt assembly, so these must reflect the actual requested run mode
  // (diff/complete/exhaustive/manual/context), never a hardcoded literal.
  //
  // `observer` (4th param, bug fix): a PER-RUN ObserverPort — see runViaRewrittenEngine's own
  // buildObserver() below for the exact mapping. The runner builds this once per run (it needs
  // record.id + deps.runEvents, neither known to the factory closure itself) and threads it
  // through to whatever CompositionConfig.observer the factory wires into RunQaUseCaseDeps.
  // OPTIONAL: a factory that ignores the 4th argument keeps behaving exactly as before this fix
  // (record.step never advances) — this is what made the bug possible in the first place, so every
  // REAL factory (src/server/rewritten-engine-factory.ts) MUST thread it through.
  engineFactory?: (
    appConfig: AppConfig,
    namespace: string,
    run: { mode: RunMode; guidance?: string },
    observer?: ObserverPort,
  ) => RunPipelinePort;
}

// Bug fix: rewritten-engine runs left their RunRecord/RunEvents frozen — record.step never
// advanced past its initial value and /api/runs/:id/events stayed empty, because nothing ever
// wired RunQaUseCaseDeps.observer (the ObserverPort seam existed but was never consumed on this
// path). This is the runner's own mapping of ObserverPort.onStep -> updateRecord + runEvents.publish,
// built PER RUN (needs record.id + deps.runEvents, neither available to the qa-engine composition
// root) and threaded into engineFactory's 4th argument. Mirrors the legacy runPipeline callback's
// exact semantics (src/pipeline.ts's onStep param, consumed at the queue callback below):
//   - updateRecord(record.id, { step, stepDetail: detail, retrying: step === "retry" })
//   - a "step.changed" RunEvent, EXCEPT this use-case never emits a step outside RunStep's own
//     vocabulary (RunQaUseCase.onStep calls are already RunStep-typed at the port boundary, so no
//     "publish" -> "decide" normalization is needed here — that normalization existed only because
//     the legacy pipeline's own step strings included "publish", which RunStep does not).
function buildRewrittenObserver(runId: string, runEvents: RunEventStore | undefined): ObserverPort {
  return {
    onStep(step: RunStep, detail?: string): void {
      updateRecord(runId, { step, stepDetail: detail, retrying: step === "retry" });
      runEvents?.publish(runId, { type: "step.changed", step, detail });
    },
    onEvent(body: RunEventBody): void {
      runEvents?.publish(runId, body);
    },
  };
}

// Maps a RunRequest + record id into the strangler seam's RunInput and drives the injected
// RunPipelinePort, surfacing its RunOutcome as a QaRunResult so the rest of the queue callback
// (RunEvents publish, updateRecord, logging) is UNCHANGED regardless of which engine ran.
//
// Mapping gap (documented, not fabricated): RunOutcome carries gateSignals (coverage/value/
// reviewer signals) but no per-case QaCase[] and no PR/Issue "outcome" string at this port
// boundary — those stay `[]`/`""`/undefined here rather than invented. Full per-case + outcome
// fidelity is the shadow-comparison harness's job (Slice F.1), not this dispatch seam.
//
// CLAUDE.md invariant ("surface integration errors loudly — never swallow errors into an empty
// result"): outcome.note IS forwarded — previously dropped here entirely, which is exactly why a
// live infra-error terminal from the rewritten engine surfaced with NO note, NO log, NO cases
// (undiagnosable without live-container instrumentation). RunQaUseCase's infra-error-shaped
// terminals now carry a diagnostic note end-to-end; this is the seam that used to discard it
// before it ever reached updateRecord's `note: run.note || undefined` below.
//
// Cancellation (Plan 7.1, engram #913): the queue callback's AbortSignal IS threaded into
// port.run(input, signal) — RunPipelinePort.run now accepts an optional signal (widened at the
// port), and RunQaUseCase checks signal?.aborted at every phase boundary, so a cancelled rewritten
// run actually stops instead of resolving late and overwriting the record cancelTrackedRun already
// finalized.
async function runViaRewrittenEngine(port: RunPipelinePort, req: RunRequest, runId: string, signal: AbortSignal): Promise<QaRunResult> {
  const input: RunInput = {
    app: req.app,
    sha: Sha.of(req.sha),
    source: req.source ?? "webhook",
    mode: req.mode,
    target: req.target,
    runId,
    ...(req.guidance ? { guidance: req.guidance } : {}),
    ...(req.triggerRepo ? { triggerRepo: req.triggerRepo } : {}),
  };
  const outcome = await port.run(input, signal);
  return {
    sha: outcome.sha,
    verdict: outcome.verdict,
    passed: outcome.verdict === "pass",
    cases: [],
    logs: "",
    ...(outcome.note !== undefined ? { note: outcome.note } : {}),
  };
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
      // PIPELINE_ENGINE dispatch (Task E.3): the ONLY place src/ consults the flag. Absent/"legacy"
      // (or "rewritten" with no engineFactory supplied — fail-safe) takes the EXACT legacy branch
      // below, byte-identical to before this task. "rewritten" WITH a supplied engineFactory routes
      // through RunPipelinePort instead — runPipeline is NEVER called on that branch.
      const engine = selectEngine(process.env);
      // CRITICAL fix (judgment-day): compute the PER-RUN namespace exactly like legacy runPipeline
      // does at src/pipeline.ts:1222 — testDataNamespace(prefix, sha, runId) — and pass it into the
      // rewritten engineFactory. `appConfig` is already loaded above (no double-load); `record.id`
      // is this run's id, matching legacy's `opts.runId`. Without this, the rewritten engine's own
      // branch/namespace collided across every run of every app (a static literal).
      const runNamespace = testDataNamespace(appConfig.qa.testDataPrefix, req.sha, record.id);
      // Bug fix: built PER RUN (needs record.id + deps.runEvents) and threaded into engineFactory's
      // 4th argument, so the rewritten engine's RunQaUseCase.onStep() calls reach the SAME
      // updateRecord + RunEvents.publish machinery the legacy branch's own onStep callback (below)
      // already uses — this is what makes the TUI/API render the rewritten path's progress live
      // instead of staying frozen until the final verdict.
      const observer = buildRewrittenObserver(record.id, deps.runEvents);
      const run: QaRunResult =
        engine === "rewritten" && deps.engineFactory
          ? await runViaRewrittenEngine(
              // Audit fix (judgment-day): thread the REQUESTED mode/guidance into the rewritten
              // engineFactory — mirrors the namespace precedent immediately above. Previously the
              // factory hardcoded mode:"diff" internally, silently mis-prompting every non-diff run.
              deps.engineFactory(appConfig, runNamespace, { mode: req.mode, ...(req.guidance ? { guidance: req.guidance } : {}) }, observer),
              req,
              record.id,
              signal,
            )
          : await runPipeline(
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
              { mode: req.mode, target: req.target, guidance: req.guidance, fixCases: req.fixCases, parentRunId: req.parentRunId, triggerRepo: req.triggerRepo, previousNamespace, runId: record.id, commits: req.commits, baseSha: req.baseSha },
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
      // Plan 7.1 (engram #913): guard the happy-path finalize against a race with cancelTrackedRun.
      // A cancelled record is ALREADY "done" (cancelTrackedRun finalizes synchronously the moment it
      // aborts the queue's signal — see cancelTrackedRun below). If run.run()'s own promise resolves
      // late (e.g. a port that observed the abort but its own async boundary didn't propagate it
      // fast enough), this stale resolution must NOT overwrite the already-finalized cancelled
      // record with whatever verdict it happened to produce. A NO-OP on a normal run (status is
      // "running" here until this very finalize) — it only fires when cancelTrackedRun already
      // finalized the record. The catch branch below carries the SYMMETRIC guard for the crash path
      // (an unrelated error racing a cancel), so BOTH exit paths are protected.
      if (getRecord(record.id)?.status === "done") {
        console.log(`[qa] discarding stale late resolution for ${req.app}@${req.sha} — record already finalized (cancelled)`);
        return;
      }
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
      // Plan 7.1 (engram #913): SYMMETRIC guard to the happy-path one above. If the run was already
      // finalized as cancelled (status "done"), an UNRELATED error that threw in the async gap
      // between checkSignal() checkpoints AFTER an operator cancel must NOT overwrite the accurate
      // "cancelled by operator" record with a misleading crash note — NOR fire the spurious
      // maintainer-eligible incident (recordIncident below) for what was only a cancel race. (The
      // cancel throw itself converges harmlessly via isInfraError; this guards the unrelated-crash
      // case that does not.)
      if (getRecord(record.id)?.status === "done") {
        console.log(`[qa] discarding post-cancel crash for ${req.app}@${req.sha} — record already finalized`);
        return;
      }
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
