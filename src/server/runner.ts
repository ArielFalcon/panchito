// The single funnel for starting a run. EVERY trigger — webhook, control API, and
// the CLI — goes through here, so there is exactly ONE queued, recorded,
// API-addressable entity per run. This is what makes "the control API is the single
// contract" actually true: nothing may start a pipeline that bypasses the sequential
// queue (which would run concurrent QA against DEV) or the run history (which would be
// invisible to the TUI/continue/chat). See docs/interactive-layer.md §3.1.

import { JobQueue } from "./queue";
import { loadAppConfig, AppConfig } from "../orchestrator/config-loader";
import { createRecord, updateRecord, addCase, getRecord, appendActivity, listRecords } from "./history";
import { recordIncident } from "./maintainer";
import { testDataNamespace } from "../qa/test-data";
import { RunMode, TestTarget, TriggerSource, QaCase, QaRunResult, engineStatus } from "../types";
import { redactError } from "../util/redact";
import { sleep as sleepWithAbort } from "../util/sleep";
import { isInfraError } from "../errors";
import type { RunEventStore } from "./run-events";
import type { RunEventBody } from "../contract/events";
import { Sha } from "@kernel/sha";
import { selectEngine } from "@contexts/qa-run-orchestration/composition/pipeline-engine-flag";
import type { RunPipelinePort, RunInput, ObserverPort } from "@contexts/qa-run-orchestration/application/ports/index.ts";

type RunStepEvent = Extract<RunEventBody, { type: "step.changed" }>;
type RunStep = RunStepEvent["step"];

// Mirror-race guard (onboarding-hardening, Slice 1) — poll granularity while an onboarding job is
// in flight. Onboarding is minutes-long, so a 5s granularity adds negligible latency and near-zero
// CPU while waiting.
const ONBOARDING_POLL_MS = 5_000;
// Defensive upper bound on the wait, set MODESTLY ABOVE onboarding's own end-to-end ceiling so this
// can only fire if the advisory flag genuinely wedges (onboarding's own timeouts guarantee its
// `busy` mutex is always cleared in a finally — see onboarding-job.ts). Decomposed into named
// per-phase constants (onboarding-auto-index, design §4.1) so the derivation stays auditable as
// the job grows new phases — each summand mirrors a live default in onboarding-job.ts:
//   - ONBOARDING_MIRROR_CEILING_MS: DEFAULT_MIRROR_TIMEOUT_MS (mirror-provisioning phase).
//   - ONBOARDING_JOB_CEILING_MS: DEFAULT_JOB_TIMEOUT_MS (round-budget phase, starts AFTER mirrors).
//   - ONBOARDING_INDEXING_CEILING_MS: the post-confirm advisory-index phase (design §2.6 — the
//     mutex STAYS HELD through indexing, so this guard's wait window must cover it too, or the
//     breakout below could fire mid-index — the exact torn-index race §2.6 exists to prevent).
//     Conservative bound: DEFAULT_INDEX_TIMEOUT_MS (5 min per repo) x 2 repos.
//   - ONBOARDING_WAIT_MARGIN_MS: scheduling jitter + this guard's own poll granularity.
// Sum = 40 min (was 30 min before the indexing phase existed).
export const ONBOARDING_MIRROR_CEILING_MS = 5 * 60 * 1000;
export const ONBOARDING_JOB_CEILING_MS = 20 * 60 * 1000;
export const ONBOARDING_INDEXING_CEILING_MS = 10 * 60 * 1000;
export const ONBOARDING_WAIT_MARGIN_MS = 5 * 60 * 1000;
export const ONBOARDING_WAIT_MAX_MS =
  ONBOARDING_MIRROR_CEILING_MS + ONBOARDING_JOB_CEILING_MS + ONBOARDING_INDEXING_CEILING_MS + ONBOARDING_WAIT_MARGIN_MS;

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
  loadApp?: (name: string) => AppConfig; // defaults to the real config loader
  runEvents?: RunEventStore;
  // The rewritten engine's composition factory (Plan 7.6: the ONLY engine — the legacy runPipeline
  // path was deleted). REQUIRED: with no factory supplied, enqueueTrackedRun's queue callback
  // throws loudly at run time (a missing factory is a boot-time wiring error, never a silent
  // fallback) — see the queue callback below. Building the full RewrittenOrchestratorAdapter wiring
  // (a real qa-engine CompositionConfig: SandboxedBinaryRunner, Stryker/coverage collectors, the
  // real GitHub client, the agent runtime, …) is deliberately NOT this file's job — that heavy
  // assembly belongs to the caller (src/server/rewritten-engine-factory.ts in production; a test
  // double in tests), keeping this hot-path dispatch free of qa-engine's leaf-IO imports.
  //
  // `namespace` (2nd param, judgment-day CRITICAL fix): the runner computes this PER RUN — see
  // enqueueTrackedRun's queue callback below — via testDataNamespace(app.qa.testDataPrefix, sha,
  // runId), the SAME formula the legacy engine used to. Without this the rewritten engine's own
  // namespace/branch would be static, colliding every run of every app on the same live-DEV
  // test-data namespace.
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
  //
  // `previousNamespace` (5th param, audit CRITICAL fix, task #33): the RESOLVED prior-run
  // namespace (enqueueTrackedRun's own local `previousNamespace`, below) — threaded through so the
  // factory can wire it into CompositionConfig.previousNamespace, which composition-root.ts's
  // wireBridges() and RunQaUseCase's own cleanup phase gate on. OPTIONAL: a factory that ignores
  // the 5th argument keeps behaving exactly as before this fix (no orphan-data cleanup on the
  // rewritten engine) — matches every other trailing-optional-arg precedent in this signature
  // (namespace/run/observer above all followed the same additive pattern).
  //
  // REQUIRED (Plan 7.6): every real caller (src/index.ts, src/cli.ts) always supplies this via
  // rewritten-engine-factory.ts. Left optional at the type level ONLY so a caller that truly wants
  // the loud boot-time error (see enqueueTrackedRun below) can still omit it in a test; production
  // code paths must never omit it.
  //
  // `run.triggerRepo` (bug fix — cross-repo composition threading): mirrors the namespace/mode/
  // guidance precedent above — a PER-RUN value (req.triggerRepo below) the queue callback now
  // threads into the `run` object alongside mode/guidance. Previously this seam carried only
  // { mode, guidance }, so the factory (src/server/rewritten-engine-factory.ts) had no way to know a
  // run was cross-repo at all — its vcs/checkout/deploy-gate wiring stayed hardwired to the PRIMARY
  // repo even when req.triggerRepo named a declared service, which crashed a real cross-repo run's
  // `git checkout -f <serviceSha>` inside the primary mirror. OPTIONAL, same additive-seam pattern as
  // guidance: a factory that ignores it keeps behaving exactly as before this fix (same-repo only).
  engineFactory?: (
    appConfig: AppConfig,
    namespace: string,
    run: { mode: RunMode; guidance?: string; triggerRepo?: string },
    observer?: ObserverPort,
    previousNamespace?: string,
  ) => RunPipelinePort;

  // Mirror-race guard (onboarding-hardening, Slice 1): true while an onboarding job (src/server/
  // onboarding/onboarding-job.ts) is provisioning mirrors, so the queue callback below WAITS
  // (bounded poll loop) instead of starting its own mirror work against the same shared working
  // tree. OPTIONAL, defaulting to () => false — same additive-seam precedent as engineFactory's own
  // trailing optional args: a caller (or test) that omits this behaves exactly as before this fix
  // (byte-identical idle path, proven by the existing behavioral suite + the explicit zero-sleep
  // test). Only src/index.ts's real composition supplies it, backed by onboardingJob.isActive().
  isOnboardingActive?: () => boolean;
  // Test/ops seam: override the poll granularity and defensive upper bound (module defaults
  // ONBOARDING_POLL_MS / ONBOARDING_WAIT_MAX_MS above). Production never overrides these.
  onboardingPollMs?: number;
  onboardingWaitMaxMs?: number;
  // Test seam: override the signal-aware sleep the poll loop awaits (module default is the real
  // util/sleep.ts implementation). Production never overrides this.
  sleep?: (ms: number, opts?: { signal?: AbortSignal }) => Promise<void>;
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
// Observer-fault isolation (judgment-day, both judges): updateRecord/runEvents.publish are
// side-effecting writes to the record store / event bus — a transient failure there (e.g. a
// storage hiccup) must never propagate up through ObserverPort.onStep/onEvent and abort an
// otherwise-healthy run. Mirrors the codebase's own advisory-callback pattern (src/index.ts:
// "a bad event must never break..."): catch, log once, never rethrow.
// Terminal status of a case's LIVE announcement, as observed through onEvent — one of the three
// RunEventBody "test.*" terminal types, stripped of the "test." prefix.
type LiveAnnouncedStatus = "passed" | "failed" | "flaky";

// liveAnnounced (dedup + convergence, judgment-day CRITICAL fix): the use-case streams
// test.started/passed/failed/flaky LIVE through onEvent (ExecutionOpts.onCase), while
// runViaRewrittenEngine's post-hoc loop still walks outcome.cases for the record-store writes
// (addCase carries the FULL QaCase evidence the live event body cannot). A naive Set-based dedup
// (recording only THAT a name was announced) suppressed the terminal event unconditionally once any
// live event fired for that name — but Playwright fires onTestEnd PER ATTEMPT
// (config/e2e/playwright.config.ts retries:2), so a flaky test live-announces test.failed then
// test.passed within ONE execute(); the final report classifies it correctly as "flaky"
// (src/qa/playwright-report.ts), yet the Set dedup silently suppressed the correcting test.flaky
// terminal event — the stream diverged from the record store's own truth.
//
// Map<string, LiveAnnouncedStatus> tracks the LAST announced terminal status per case name instead.
// recordCase's own record-store write (addCase/appendActivity) ALWAYS runs regardless. The terminal
// event publish is skipped only when the name was announced live AND its final status matches what
// was last announced; otherwise (never announced, e.g. code-mode — or DIVERGENT, e.g. the flaky
// case above) recordCase publishes the correcting terminal event. Net effect: exactly one publish
// in the common case, and the stream always converges to the store's own final truth.
function buildRewrittenObserver(runId: string, runEvents: RunEventStore | undefined, liveAnnounced?: Map<string, LiveAnnouncedStatus>): ObserverPort {
  return {
    onStep(step: RunStep, detail?: string): void {
      try {
        updateRecord(runId, { step, stepDetail: detail, retrying: step === "retry" });
        runEvents?.publish(runId, { type: "step.changed", step, detail });
      } catch (err) {
        console.error("[qa] observer onStep failed (non-fatal, run continues):", err);
      }
    },
    onEvent(body: RunEventBody): void {
      try {
        if (
          liveAnnounced &&
          (body.type === "test.passed" || body.type === "test.failed" || body.type === "test.flaky") &&
          typeof (body as { name?: unknown }).name === "string"
        ) {
          const status = body.type.slice("test.".length) as LiveAnnouncedStatus;
          liveAnnounced.set((body as { name: string }).name, status);
        }
        runEvents?.publish(runId, body);
      } catch (err) {
        console.error("[qa] observer onEvent failed (non-fatal, run continues):", err);
      }
    },
  };
}

// Maps a final QaCase.status ("pass"|"fail"|"flaky") into the LiveAnnouncedStatus vocabulary
// ("passed"|"failed"|"flaky") so recordCase can compare the store's own truth against what was last
// announced live.
function finalStatusAsAnnounced(status: QaCase["status"]): LiveAnnouncedStatus {
  return status === "pass" ? "passed" : status === "fail" ? "failed" : "flaky";
}

// Maps a RunRequest + record id into the strangler seam's RunInput and drives the injected
// RunPipelinePort, surfacing its RunOutcome as a QaRunResult so the rest of the queue callback
// (RunEvents publish, updateRecord, logging) is UNCHANGED regardless of which engine ran.
//
// W3 F3 (HIGH, audit-verified cutover blocker): outcome.cases/outcome.logs ARE now forwarded —
// RunOutcome was widened (qa-engine/src/shared-kernel/run-outcome.ts) with optional cases/logs
// fields precisely so this boundary has real data to map, closing the gap that left every passing
// rewritten-engine run showing passed=0/failed=0 with an empty case list (confirmed in both live
// validation runs — see this fn's own W3 F3 history). Each case is threaded through the SAME
// addCase/appendActivity/RunEvents flow the legacy queue callback's own onCase callback uses
// (runner.ts's `(c) => { addCase(...); appendActivity(...); deps.runEvents?.publish(...) }`, below
// in enqueueTrackedRun) — a single shared helper (recordCase) keeps both engines' per-case
// bookkeeping byte-identical. PR/Issue "outcome" string mapping (run.outcome) remains a documented
// gap — RunOutcome carries no such field at this port boundary; deliberately left undefined rather
// than invented (updateRecord's own note:run.note fallback already surfaces the publish outcome via
// RunQaResult.note -> RunOutcome.note, so this is not a total loss of information, only the
// dedicated `outcome` field the legacy branch's own report() return additionally provides).
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
//
// Security fix (judgment-day, WARNING real): mirrors legacy runPipeline's own triggerRepo guard
// (src/pipeline.ts:1008-1013) — `throw new Error(`trigger repo ${x} is not a declared service of
// app ${y}`)` when req.triggerRepo is set but does not match app.repo or any app.services[].repo.
// Since F3 (commit 643818c) routes real GitHub Issues to decision.issueRepo (which defaults to
// input.triggerRepo), an unvalidated webhook-supplied triggerRepo could file Issues in an
// arbitrary repo — the legacy branch (runPipeline, below) was always protected by this same
// check; only the rewritten branch bypassed it (RunQaUseCase has no app.services knowledge). Same
// error shape/message as legacy so the enclosing try/catch's isInfraError(err) classifies it
// identically (a plain Error → verdict "infra-error", noted "unexpected internal error").
function assertTriggerRepoDeclared(appConfig: AppConfig, triggerRepo: string | undefined): void {
  if (!triggerRepo || triggerRepo === appConfig.repo) return;
  const declared = appConfig.services?.some((s) => s.repo === triggerRepo);
  if (!declared) {
    throw new Error(`trigger repo ${triggerRepo} is not a declared service of app ${appConfig.name}`);
  }
}

// W3 F3 + F4: records one finished case into the SAME store the legacy engine's onCase callback
// writes to (history.addCase — passed/failed counts are RECOMPUTED from the cases table, per
// addCase's own "single source of truth" doc) and publishes the matching RunEvent, mirroring the
// legacy queue callback's own onCase closure exactly (kind:"todo" activity + test.passed/
// test.failed/test.flaky). Shared by runViaRewrittenEngine (this file) so both engines' per-case
// side effects are byte-identical, not two independently-drifting implementations.
//
// Dedup + convergence (judgment-day CRITICAL fix, see buildRewrittenObserver's own liveAnnounced
// doc): the record-store write above ALWAYS runs. The terminal event publish is skipped ONLY when
// the case was announced live AND its last-announced status matches the final QaCase.status —
// otherwise (never announced, e.g. code-mode; or DIVERGENT, e.g. a flaky test whose live attempts
// announced failed then passed but the final report says flaky) this publishes the correcting
// terminal event, so the stream always converges to the store's own final truth.
function recordCase(runId: string, c: QaCase, runEvents: RunEventStore | undefined, liveAnnounced?: Map<string, LiveAnnouncedStatus>): void {
  addCase(runId, c);
  appendActivity(runId, { kind: "todo", text: c.name, status: "completed" });
  const lastAnnounced = liveAnnounced?.get(c.name);
  if (lastAnnounced !== undefined && lastAnnounced === finalStatusAsAnnounced(c.status)) return;
  runEvents?.publish(runId, c.status === "pass"
    ? { type: "test.passed", name: c.name, durationMs: c.durationMs ?? 0 }
    : c.status === "fail"
      ? { type: "test.failed", name: c.name, detail: c.detail, ...(c.durationMs !== undefined ? { durationMs: c.durationMs } : {}) }
      : { type: "test.flaky", name: c.name, attempts: 2 });
}

async function runViaRewrittenEngine(
  port: RunPipelinePort,
  req: RunRequest,
  runId: string,
  signal: AbortSignal,
  appConfig: AppConfig,
  runEvents: RunEventStore | undefined,
  liveAnnounced?: Map<string, LiveAnnouncedStatus>,
  // Audit CRITICAL (task #33): the RESOLVED previousNamespace — mirrors the legacy branch's own
  // `previousNamespace` field on runPipeline's RunOptions (below). NOT req.previousNamespace
  // directly: enqueueTrackedRun's own local `previousNamespace` (its own doc, below) already
  // reconciles req.previousNamespace with the reconstructed-from-history fallback — this param is
  // that RESOLVED value, threaded through by the queue callback that already computed it.
  previousNamespace?: string,
): Promise<QaRunResult> {
  assertTriggerRepoDeclared(appConfig, req.triggerRepo);
  const input: RunInput = {
    app: req.app,
    sha: Sha.of(req.sha),
    source: req.source ?? "webhook",
    mode: req.mode,
    target: req.target,
    runId,
    ...(req.guidance ? { guidance: req.guidance } : {}),
    ...(req.triggerRepo ? { triggerRepo: req.triggerRepo } : {}),
    ...(previousNamespace ? { previousNamespace } : {}),
  };
  const outcome = await port.run(input, signal);
  // W3 F3: thread the real per-case results into history.addCase (the single source of truth for
  // passed/failed — see recordCase's own doc) BEFORE returning, so the queue callback's own
  // `run.cases.filter(...)` (run.verdict event) and updateRecord read a populated case list, not
  // the previous permanent [].
  const cases = outcome.cases ?? [];
  for (const c of cases) {
    recordCase(runId, c, runEvents, liveAnnounced);
  }
  // W3 F4: reviewer.verdict — derivable from the already-returned RunOutcome without widening any
  // port. Mirrors the legacy queue callback's own reviewer.verdict publish closure.
  //
  // coverage.computed is DELIBERATELY NOT emitted here: RunEventBody's coverage.computed carries
  // raw changedLines/coveredLines counts, but ObjectiveSignalPort.measure()'s own contract (ports/
  // index.ts) surfaces only a ratio, never raw line counts — there is no real count to report at
  // this boundary, and synthesizing one (e.g. a fixed changedLines with coveredLines derived from
  // the ratio) would be a fabricated absolute figure neither engine ever measured, violating
  // CLAUDE.md's "never fabricate" invariant. Flagged as a gap: closing it needs
  // ObjectiveSignalPort.measure() widened to return real counts (or the assembled ChangeCoverage
  // read-model threaded through), which is a port-shape change out of this package's scope (per the
  // mission's own "do NOT widen ExecutionPort/ports beyond what's available" boundary).
  if (outcome.gateSignals.reviewerApproved !== undefined) {
    runEvents?.publish(runId, {
      type: "reviewer.verdict",
      approved: outcome.gateSignals.reviewerApproved,
      reasons: outcome.gateSignals.reviewerCorrections,
    });
  }
  return {
    sha: outcome.sha,
    verdict: outcome.verdict,
    passed: outcome.verdict === "pass",
    cases,
    logs: outcome.logs ?? "",
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

      // Marked "running" BEFORE the mirror-race poll loop below (not after it): the queue slot is
      // genuinely held from this point on, and cancelTrackedRun's abort branch is gated on
      // record.status === "running" — moving this earlier is what makes cancellation during the
      // poll wait actually reach queue.cancel()/this callback's own AbortSignal, instead of falling
      // into the "still enqueued" finalize-without-abort branch.
      updateRecord(record.id, { status: "running" });

      // Mirror-race guard (onboarding-hardening, Slice 1): defer mirror work while an onboarding
      // job is in flight. NO-OP on the idle path (the overwhelming common case — onboarding is
      // rare) because the `while` condition is false on first evaluation and the loop body never
      // runs, so `sleep` is never called. Holding the queue's single slot while polling means later
      // enqueued runs wait behind this one — the EXISTING sequential-queue property, unchanged; the
      // wait is bounded and FIFO order is preserved.
      const isOnboardingActive = deps.isOnboardingActive ?? (() => false);
      const onboardingPollMs = deps.onboardingPollMs ?? ONBOARDING_POLL_MS;
      const onboardingWaitMaxMs = deps.onboardingWaitMaxMs ?? ONBOARDING_WAIT_MAX_MS;
      const waitForOnboarding = deps.sleep ?? sleepWithAbort;
      const waitStart = Date.now();
      let parkLogged = false;
      while (isOnboardingActive()) {
        // Park visibility: without this line an operator sees status "running" with no progress
        // and no run.started event for up to the wait ceiling — say WHY, once.
        if (!parkLogged) {
          parkLogged = true;
          console.log(`[qa] run parked: onboarding job active — waiting before mirror work (${req.app}@${req.sha})`);
        }
        if (signal.aborted) break; // an operator cancel during the wait — handled below
        if (Date.now() - waitStart > onboardingWaitMaxMs) {
          console.warn(
            `[qa] onboarding still active after ${onboardingWaitMaxMs}ms — proceeding anyway to avoid starving the QA pipeline (${req.app}@${req.sha})`,
          );
          break;
        }
        await waitForOnboarding(onboardingPollMs, { signal });
      }
      if (signal.aborted) {
        // cancelTrackedRun already finalized the record (status "done", verdict "infra-error") the
        // moment it aborted this signal — this is a NO-OP guard, not a second finalize.
        console.log(`[qa] skipping ${req.app}@${req.sha} — cancelled while waiting for onboarding to clear`);
        return;
      }

      const appConfig = loadApp(req.app);
      deps.runEvents?.publish(record.id, { type: "run.started", app: req.app, sha: req.sha, mode: req.mode, target: req.target });
      // Runtime shadow override from the TUI/API takes precedence over the YAML config.
      if (req.shadow !== undefined) {
        appConfig.qa.shadow = req.shadow;
      }
      // Plan 7.6 (cutover finale): the legacy runPipeline path is DELETED — the rewritten engine is
      // the ONLY engine. selectEngine(process.env) is still consulted so a stale
      // PIPELINE_ENGINE=legacy setting surfaces its deprecation warning (pipeline-engine-flag.ts);
      // its return value no longer branches this dispatch. engineFactory is now REQUIRED — a
      // missing factory is a boot-time wiring defect, surfaced loudly rather than silently falling
      // back to a deleted code path.
      selectEngine(process.env);
      if (!deps.engineFactory) {
        throw new Error(
          "enqueueTrackedRun: RunnerDeps.engineFactory is required (Plan 7.6 — the legacy pipeline was removed). " +
            "Wire src/server/rewritten-engine-factory.ts's createRewrittenEngineFactory(...) at the caller.",
        );
      }
      // CRITICAL fix (judgment-day): compute the PER-RUN namespace — testDataNamespace(prefix, sha,
      // runId) — and pass it into the rewritten engineFactory. `appConfig` is already loaded above
      // (no double-load); `record.id` is this run's id. Without this, the rewritten engine's own
      // branch/namespace collided across every run of every app (a static literal).
      const runNamespace = testDataNamespace(appConfig.qa.testDataPrefix, req.sha, record.id);
      // Bug fix: built PER RUN (needs record.id + deps.runEvents) and threaded into engineFactory's
      // 4th argument, so the rewritten engine's RunQaUseCase.onStep() calls reach the SAME
      // updateRecord + RunEvents.publish machinery — this is what makes the TUI/API render the
      // rewritten path's progress live instead of staying frozen until the final verdict.
      // liveAnnounced: shared between the observer (live test.* announcements from the use-case's
      // ExecutionOpts.onCase streaming) and runViaRewrittenEngine's post-hoc recordCase loop, so a
      // case's terminal event publishes exactly once in the common case — and the correcting event
      // still publishes on divergence (see buildRewrittenObserver's own dedup + convergence note).
      const liveAnnounced = new Map<string, LiveAnnouncedStatus>();
      const observer = buildRewrittenObserver(record.id, deps.runEvents, liveAnnounced);
      const run: QaRunResult = await runViaRewrittenEngine(
        // Audit fix (judgment-day): thread the REQUESTED mode/guidance into the rewritten
        // engineFactory. Previously the factory hardcoded mode:"diff" internally, silently
        // mis-prompting every non-diff run.
        // Bug fix (cross-repo composition threading): ALSO thread req.triggerRepo — previously this
        // seam carried only mode/guidance, so the factory's vcs/checkout/deploy-gate wiring never
        // learned a run was cross-repo and stayed hardwired to the PRIMARY repo (see
        // rewritten-engine-factory.ts's own header for the crash this caused). Same conditional-spread
        // style as guidance: absent on an ordinary run, never fabricated.
        deps.engineFactory(
          appConfig,
          runNamespace,
          { mode: req.mode, ...(req.guidance ? { guidance: req.guidance } : {}), ...(req.triggerRepo ? { triggerRepo: req.triggerRepo } : {}) },
          observer,
          previousNamespace,
        ),
        req,
        record.id,
        signal,
        appConfig,
        deps.runEvents,
        liveAnnounced,
        // Audit CRITICAL (task #33): the SAME resolved previousNamespace — threads the CleanupPort
        // gate.
        previousNamespace,
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
