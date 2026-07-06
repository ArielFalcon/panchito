// src/server/onboarding/onboarding-job.ts
// In-memory, single-job onboarding runner — the server-side counterpart to scripts/onboard-app.ts
// (Slice 4), driven from the TUI via three new endpoints (src/server/api.ts) instead of argv.
// Design delta §C is the authoritative sequencing; spec-delta group E is the requirement set.
//
// Sequencing (§C, exactly): env-guard (key + qa-proposer agent) -> runner-busy guard ->
// resolvingMirrors (own ONBOARD_MIRROR_TIMEOUT_MS, front + every service repo) -> compose the
// proposer + OnboardingService (onRound observer feeds live status) -> proposing/scoring, wrapped
// in a Promise.race against ONBOARD_JOB_TIMEOUT_MS with an owned AbortController -> done (winner |
// no-profile) | failed. The mutex is released in a finally on every exit path. propose() never
// writes; only confirm() does, and only against a state===done && outcome==="winner" job.
//
// propose()'s mutex decision is SYNCHRONOUS (returns a plain ProposeResult, not a promise, when
// rejecting a concurrent request) so a second caller sees the 409 immediately; on acceptance it
// returns a Promise<ProposeResult> that settles once the round finishes. The HTTP handler (5a.8)
// is the layer that implements the 202 fire-and-forget contract by NOT awaiting that promise.
import type { OnboardingService, OnboardingRoundProgress } from "@contexts/service-topology/application/onboarding-service.ts";
import type { ProfileProposerPort } from "@contexts/service-topology/application/ports/index.ts";
import type { BoundaryProfile, RepoRef } from "@contexts/service-topology/domain/index.ts";
import { serializeBoundary, spliceBoundariesBlock } from "./write-boundaries";
import { redactError } from "../../util/redact";

/** const-object-then-type pattern (typescript SKILL) — never a raw string union. */
export const ONBOARD_STATE = {
  idle: "idle",
  resolvingMirrors: "resolvingMirrors",
  proposing: "proposing",
  scoring: "scoring",
  done: "done",
  failed: "failed",
} as const;

export type OnboardState = (typeof ONBOARD_STATE)[keyof typeof ONBOARD_STATE];

export const ONBOARD_OUTCOME = {
  winner: "winner",
  noProfile: "no-profile",
} as const;

export type OnboardOutcome = (typeof ONBOARD_OUTCOME)[keyof typeof ONBOARD_OUTCOME];

/** The polled status DTO — rides the zod->openapi.json->oapi-codegen contract rail (5a.8) as
 *  OnboardingJobStatusSchema. This TS interface is the job's own internal shape; the zod schema in
 *  src/contract/commands.ts mirrors it field-for-field. */
export interface OnboardingJobStatus {
  state: OnboardState;
  app?: string;
  round: number;
  ceiling: number;
  candidatesScored: number;
  lastResolvedScore?: number;
  resolvedProfile?: BoundaryProfile;
  outcome?: OnboardOutcome;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ProposeBoundariesRequest {
  app: string;
  repo: string;
  services: string[];
  baseBranch?: string;
}

export type ProposeResult = { ok: true } | { ok: false; error: string };
export type ConfirmResult = { ok: true } | { ok: false; error: string };

/** Every side-effecting collaborator the job needs, injected so the state machine is unit-tested
 *  with fakes (DI shape mirrors AppAdminDeps / maintainer-runtime.ts's MaintainerConfig). */
export interface OnboardingJobDeps {
  /** True when the shared QA run queue is active for this (or any) app — the symmetric mirror-race
   *  guard (design §C): the onboarding job must never provision mirrors while the runner is busy. */
  isRunnerBusy(): boolean;
  /** Provisions (or refreshes) one repo's mirror at its base branch HEAD, returning the mirror dir.
   *  Production: repo-mirror.ts's ensureMirrorAtBranch + MirrorRegistryAdapter composition. */
  ensureMirrorAtBranch(repo: string, baseBranch: string): Promise<string>;
  /** Env-guard part 1: OPENCODE_API_KEY presence. */
  hasOpencodeApiKey(): boolean;
  /** Env-guard part 2: the qa-proposer agent is configured on the target opencode server. */
  hasProposerAgent(): Promise<boolean>;
  /** Composes the LLM proposer adapter for this run, given a ctx carrying the job's own
   *  AbortSignal (threaded through to the adapter's ctx.signal per the session-leak fix). */
  buildProposer(ctx: { app: string; signal: AbortSignal }): ProfileProposerPort;
  /** Composes the REAL OnboardingService (qa-engine, imported, never reimplemented) wired with the
   *  onRound observer that feeds this job's live status. */
  buildOnboardingService(proposer: ProfileProposerPort, onRound: (p: OnboardingRoundProgress) => void): OnboardingService;
  readConfig(path: string): string;
  writeConfig(path: string, content: string): void;
  configPath?(app: string): string;
  mirrorTimeoutMs?: number;
  jobTimeoutMs?: number;
}

const DEFAULT_MIRROR_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_JOB_TIMEOUT_MS = 20 * 60 * 1000;

function defaultConfigPath(app: string): string {
  return `config/apps/${app}.yaml`;
}

/** Rejects with `message` once `ms` elapses (calling `onTimeout` first, so the caller can abort a
 *  controller), racing `promise` — used for BOTH the mirror phase and the round-budget phase, each
 *  with its own independent timeout, per design §C's "own phase, own timer" decision. */
function raceTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(message));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export interface OnboardingJob {
  /** With no argument (or an app matching the current/last job), returns the current job's status
   *  as-is. With an app that DIFFERS from the current job's app, returns a scoped idle response
   *  for the REQUESTED app instead — this process holds exactly one job at a time, and a caller
   *  polling a different app's URL must never see another app's in-flight or completed job (the
   *  per-app REST surface is a facade over one process-wide job; see src/index.ts's composition
   *  wiring for the app-identity thread-through this depends on). */
  status(app?: string): OnboardingJobStatus;
  /** Synchronous rejection ({ok:false}) when a job is already non-terminal (the mutex); otherwise a
   *  Promise<ProposeResult> that settles once the round finishes. The HTTP handler (5a.8) must NOT
   *  await this promise on the response path — that is what makes propose() "fire-and-forget". */
  propose(req: ProposeBoundariesRequest): ProposeResult | Promise<ProposeResult>;
  /** With no argument (or an app matching the current job), behaves exactly as before. With an app
   *  that DIFFERS from the current job's app, rejects WITHOUT performing any write — confirming
   *  against the wrong app's URL must never splice another app's resolved profile into this app's
   *  config. */
  confirm(app?: string): ConfirmResult;
  /** Test/ops seam: resolves once the current (or most recent) propose() round has fully settled. */
  settled(): Promise<void>;
}

/** Builds a fresh in-memory OnboardingJob. One job instance = one mutex; composition-root code
 *  (src/index.ts) constructs exactly one instance and wires it into ApiDeps (5a.8). */
export function createOnboardingJob(deps: OnboardingJobDeps): OnboardingJob {
  let status: OnboardingJobStatus = { state: ONBOARD_STATE.idle, round: 0, ceiling: 3, candidatesScored: 0 };
  // The mutex flag is tracked independently of `status.state`: the very first status write inside
  // run() moves state OFF "idle" already, but tracking a dedicated boolean (rather than re-deriving
  // "busy" from state) keeps the mutex correct even across the instant between propose() being
  // called and run()'s first `await`.
  let busy = false;
  let inFlight: Promise<void> | null = null;

  function fail(error: string): void {
    status = { ...status, state: ONBOARD_STATE.failed, error, finishedAt: new Date().toISOString() };
  }

  async function run(req: ProposeBoundariesRequest): Promise<void> {
    const mirrorTimeoutMs = deps.mirrorTimeoutMs ?? DEFAULT_MIRROR_TIMEOUT_MS;
    const jobTimeoutMs = deps.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    const startedAt = new Date().toISOString();
    status = { state: ONBOARD_STATE.resolvingMirrors, app: req.app, round: 0, ceiling: 3, candidatesScored: 0, startedAt };

    try {
      // Env-guard (both branches) — BEFORE the runner-busy guard and BEFORE resolvingMirrors, per
      // design §C: a missing key/agent must never burn a mirror provisioning cycle.
      if (!deps.hasOpencodeApiKey()) {
        fail("OPENCODE_API_KEY is not set — the proposer cannot run");
        return;
      }
      const hasAgent = await deps.hasProposerAgent();
      if (!hasAgent) {
        fail("the qa-proposer agent is not configured on the opencode server");
        return;
      }

      // Symmetric mirror-race guard — BEFORE resolvingMirrors (design §C risk 4).
      if (deps.isRunnerBusy()) {
        fail("runner busy, retry later");
        return;
      }

      // resolvingMirrors — its OWN phase, its OWN timeout, BEFORE the round-budget clock starts.
      // Each repo's mirror is provisioned exactly once; front/system RepoRefs are built from the
      // SAME resolved mirror dirs (no duplicate ensureMirrorAtBranch calls).
      const baseBranch = req.baseBranch ?? "main";
      let mirrorTimedOut = false;
      let mirrorDirs: string[];
      try {
        mirrorDirs = await raceTimeout(
          Promise.all([req.repo, ...req.services].map((repo) => deps.ensureMirrorAtBranch(repo, baseBranch))),
          mirrorTimeoutMs,
          () => { mirrorTimedOut = true; },
          "resolving mirrors timed out",
        );
      } catch (err) {
        fail(mirrorTimedOut ? "resolving mirrors timed out" : redactError(err));
        return;
      }

      const [frontMirrorDir, ...serviceMirrorDirs] = mirrorDirs;
      const front: RepoRef = { repo: req.repo, mirrorDir: frontMirrorDir! };
      const system: RepoRef[] = req.services.map((repo, i) => ({ repo, mirrorDir: serviceMirrorDirs[i]! }));

      // proposing/scoring, wrapped in the round-budget race with an owned AbortController. The
      // AbortSignal cancels the PROPOSER leg (deps.buildProposer's ctx.signal, threaded into
      // deps.open/session) — a timeout that lands while a proposer call is in flight actually stops
      // it. A timeout that lands during the SCORING leg does NOT cancel anything: the resolver work
      // already in progress runs to completion unobserved and its result is simply discarded when
      // raceTimeout rejects first. This is an accepted, documented gap (not a session leak fix in
      // that case) tracked separately — the job still fails deterministically either way, it just
      // does not abort scoring work that was already running.
      status = { ...status, state: ONBOARD_STATE.proposing };
      const controller = new AbortController();
      const proposer = deps.buildProposer({ app: req.app, signal: controller.signal });
      const onRound = (p: OnboardingRoundProgress): void => {
        status = {
          ...status,
          state: ONBOARD_STATE.scoring,
          round: p.round,
          candidatesScored: p.scored,
          lastResolvedScore: p.bestResolvedScore,
        };
      };
      const service = deps.buildOnboardingService(proposer, onRound);

      let timedOut = false;
      let result;
      try {
        result = await raceTimeout(
          service.onboard(system, front),
          jobTimeoutMs,
          () => { timedOut = true; controller.abort(); },
          "onboarding timed out",
        );
      } catch (err) {
        fail(timedOut ? "onboarding timed out" : redactError(err));
        return;
      }

      const finishedAt = new Date().toISOString();
      status = result.profile !== null
        ? { ...status, state: ONBOARD_STATE.done, outcome: ONBOARD_OUTCOME.winner, resolvedProfile: result.profile, finishedAt }
        : { ...status, state: ONBOARD_STATE.done, outcome: ONBOARD_OUTCOME.noProfile, finishedAt };
    } catch (err) {
      fail(redactError(err));
    } finally {
      busy = false;
    }
  }

  // True when `app` is provided and differs from the current/last job's app — i.e. the caller is
  // polling or confirming a URL for an app this process is NOT currently (or was never) running an
  // onboarding job for. `status.app` is undefined only at the very first idle state (before any
  // propose() call ever ran), in which case there is nothing to mismatch against.
  function isOtherApp(app: string | undefined): boolean {
    return app !== undefined && status.app !== undefined && app !== status.app;
  }

  return {
    status(app?: string): OnboardingJobStatus {
      if (isOtherApp(app)) {
        // Scoped idle response for the REQUESTED app — never the other app's job data. Same shape
        // as the process's own initial idle state, just labeled with the caller's app.
        return { state: ONBOARD_STATE.idle, app, round: 0, ceiling: 3, candidatesScored: 0 };
      }
      return status;
    },

    propose(req: ProposeBoundariesRequest): ProposeResult | Promise<ProposeResult> {
      if (busy) {
        return { ok: false, error: "an onboarding job is already running" };
      }
      busy = true;
      const promise = run(req).then((): ProposeResult => ({ ok: true }));
      inFlight = promise.then(() => undefined);
      return promise;
    },

    confirm(app?: string): ConfirmResult {
      if (isOtherApp(app)) {
        return { ok: false, error: `no confirmable job for app '${app}' (current job belongs to '${status.app}')` };
      }
      if (status.state !== ONBOARD_STATE.done || status.outcome !== ONBOARD_OUTCOME.winner || !status.resolvedProfile) {
        return { ok: false, error: "no confirmable boundary profile for this app" };
      }
      const resolvedApp = status.app ?? "";
      const path = (deps.configPath ?? defaultConfigPath)(resolvedApp);
      const lines = serializeBoundary(status.resolvedProfile);
      let existing: string;
      try {
        existing = deps.readConfig(path);
      } catch (err) {
        return { ok: false, error: redactError(err) };
      }
      try {
        const spliced = spliceBoundariesBlock(existing, lines);
        deps.writeConfig(path, spliced);
      } catch (err) {
        return { ok: false, error: redactError(err) };
      }
      return { ok: true };
    },

    async settled(): Promise<void> {
      if (inFlight) await inFlight;
    },
  };
}
