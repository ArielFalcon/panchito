// src/server/onboarding/onboarding-job.test.ts
// TDD (strict): write failing tests first, then implement.
// OnboardingJob is the server-side, in-memory single-job state machine that composes the LLM
// proposer adapter + the REAL OnboardingService (qa-engine) with server-side mirror provisioning,
// a runner-busy guard, an env-guard, and a round-budget timeout with AbortSignal cancellation.
// Design delta §C is the authoritative HOW; spec-delta group E is the WHAT.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ONBOARD_STATE,
  createOnboardingJob,
  type OnboardingJobDeps,
  type OnboardingJobStatus,
} from "./onboarding-job";
import type { ProfileProposerPort } from "@contexts/service-topology/application/ports/index.ts";
import type { BoundaryProfile, HttpBoundaryProfile } from "@contexts/service-topology/domain/index.ts";
import type { OnboardingResult, OnboardingRoundProgress } from "@contexts/service-topology/application/onboarding-service.ts";

const CORRECT_PROFILE: HttpBoundaryProfile = {
  transport: "http",
  frontFiles: "**/*.api.ts",
  frontCallSite: { kind: "receiver-verb-call", receiver: "this.rest" },
  servicePrefixTemplate: "name-{service}-api",
  serviceRepoTemplate: "ms-name-{service}",
  openApiPath: "openapi.yaml",
};

/** A ProfileProposerPort stub with an injectable propose() body — lets each test control the
 *  round-by-round result AND observe the AbortSignal ctx threading without touching the real
 *  LlmProfileProposerAdapter or the agent runtime. */
function stubProposer(propose: ProfileProposerPort["propose"]): ProfileProposerPort {
  return { propose };
}

function alwaysCorrectProposer(): ProfileProposerPort {
  return stubProposer(async () => [CORRECT_PROFILE]);
}

function neverResolvingProposer(signalCapture?: { signal?: AbortSignal }): ProfileProposerPort {
  return stubProposer(() => new Promise<BoundaryProfile[]>(() => {
    // never resolves — the job's own round-budget race must be what ends this.
  }));
}

function noWinnerProposer(): ProfileProposerPort {
  return stubProposer(async () => []);
}

/** A fake "OnboardingService"-shaped object (structurally, not `instanceof`) that drives the
 *  injected onRound observer and returns a deterministic OnboardingResult — job-level tests exist
 *  to prove the JOB's own orchestration (env-guards, mirror phase, mutex, timeout/abort, outcome
 *  mapping), not OnboardingService's real filesystem-backed scoring (already covered exhaustively
 *  in onboarding-service.test.ts). Calls the real proposer.propose() once (so proposer-driven tests
 *  like the AbortSignal thread-through and the never-resolving proposer still exercise it), then
 *  reports either a winning or a no-winner OnboardingResult depending on what the proposer returned.
 *  buildOnboardingServiceFake is the type onboarding-job.ts's OnboardingJobDeps.buildOnboardingService
 *  expects — a real `OnboardingService` instance — so this is intentionally cast at the call site. */
function fakeOnboardingService(winningProfile: BoundaryProfile) {
  return (
    proposer: ProfileProposerPort,
    onRound: (p: OnboardingRoundProgress) => void,
  ): { onboard: (system: unknown[], front: unknown) => Promise<OnboardingResult> } => ({
    onboard: async (system, front) => {
      const proposed = await proposer.propose(system as never, front as never, { priorCandidates: [] });
      const won = proposed.some((p) => p === winningProfile);
      onRound({ round: 1, proposed: proposed.length, scored: proposed.length, bestResolvedScore: won ? 1 : 0 });
      return won
        ? { profile: winningProfile, candidates: [{ profile: winningProfile, score: { links: 1, drift: 0, external: 0, unresolved: 0, coverage: 1, resolutionRatio: 1, resolvedScore: 1 } }], rounds: 1 }
        : { profile: null, candidates: [], rounds: 1 };
    },
  });
}

/** Builds a full OnboardingJobDeps fixture with sane defaults, overridable per test. */
function buildDeps(overrides: Partial<OnboardingJobDeps> = {}): OnboardingJobDeps {
  return {
    isRunnerBusy: () => false,
    ensureMirrorAtBranch: async (repo: string) => `/mirrors/${repo.replaceAll("/", "__")}`,
    hasOpencodeApiKey: () => true,
    hasProposerAgent: async () => true,
    buildProposer: () => alwaysCorrectProposer(),
    buildOnboardingService: fakeOnboardingService(CORRECT_PROFILE) as OnboardingJobDeps["buildOnboardingService"],
    writeConfig: () => {},
    readConfig: () => 'name: "fixture"\nrepo: "org/fixture"\n',
    mirrorTimeoutMs: 5_000,
    jobTimeoutMs: 5_000,
    ...overrides,
  };
}

// ── State machine + status DTO (spec E1, E2, E6) ────────────────────────────────

test("ONBOARD_STATE is a const-object, not a raw string union (typescript SKILL convention)", () => {
  assert.deepEqual(Object.values(ONBOARD_STATE).sort(), ["done", "failed", "idle", "proposing", "resolvingMirrors", "scoring"].sort());
});

test("job status starts idle before propose() is ever called", () => {
  const job = createOnboardingJob(buildDeps());
  const status = job.status();
  assert.equal(status.state, ONBOARD_STATE.idle);
});

test("propose(): transitions resolvingMirrors -> proposing/scoring -> done with outcome winner", async () => {
  const job = createOnboardingJob(buildDeps());
  await job.propose({ app: "nname", repo: "ArielFalcon/nname-gateway", services: ["ArielFalcon/ms-name-orders"] });

  const status = job.status();
  assert.equal(status.state, ONBOARD_STATE.done);
  assert.equal(status.outcome, "winner");
  assert.deepEqual(status.resolvedProfile, CORRECT_PROFILE);
});

test("propose(): the mutex-accept decision is synchronous — a caller does not have to await the round to know it was accepted", async () => {
  let resolveProposer!: (profiles: BoundaryProfile[]) => void;
  const slowProposer = stubProposer(() => new Promise<BoundaryProfile[]>((resolve) => { resolveProposer = resolve; }));
  const job = createOnboardingJob(buildDeps({ buildProposer: () => slowProposer }));

  // The 202-fire-and-forget contract (spec E1) lives at the HTTP handler layer (5a.8): the handler
  // calls propose() and responds 202 WITHOUT awaiting its returned promise. Here we only prove the
  // accept/reject decision (job.propose(...).then(...) is not required before the caller can move
  // on) — kickoff's SETTLEMENT is allowed to wait for the round; NOT awaiting it is the point.
  const kickoff = job.propose({ app: "nname", repo: "ArielFalcon/nname-gateway", services: [] });
  assert.ok(kickoff instanceof Promise, "propose() returns a promise the HTTP handler may choose not to await");

  // Let run()'s own awaits (env-guard, mirror provisioning) drain before the proposer is reached.
  await new Promise((r) => setImmediate(r));
  resolveProposer([CORRECT_PROFILE]);
  await kickoff;
  assert.equal(job.status().state, ONBOARD_STATE.done);
});

// ── Mirror phase is distinct and timed separately (spec E1) ────────────────────

test("resolvingMirrors runs BEFORE the round-budget timer starts, calling ensureMirrorAtBranch for front + every service", async () => {
  const calls: string[] = [];
  const deps = buildDeps({
    ensureMirrorAtBranch: async (repo: string) => {
      calls.push(repo);
      return `/mirrors/${repo.replaceAll("/", "__")}`;
    },
  });
  const job = createOnboardingJob(deps);
  await job.propose({ app: "nname", repo: "ArielFalcon/nname-gateway", services: ["ArielFalcon/ms-name-orders", "ArielFalcon/ms-name-billing"] });

  assert.deepEqual(calls.sort(), ["ArielFalcon/ms-name-billing", "ArielFalcon/ms-name-orders", "ArielFalcon/nname-gateway"].sort());
});

test("a slow/hanging mirror provisioning trips ONBOARD_MIRROR_TIMEOUT_MS and lands failed WITHOUT starting the round-budget clock", async () => {
  const deps = buildDeps({
    mirrorTimeoutMs: 20,
    jobTimeoutMs: 10_000,
    ensureMirrorAtBranch: () => new Promise(() => {
      // never resolves
    }),
  });
  const job = createOnboardingJob(deps);
  await job.propose({ app: "nname", repo: "ArielFalcon/nname-gateway", services: [] });

  const status = job.status();
  assert.equal(status.state, ONBOARD_STATE.failed);
  assert.match(status.error ?? "", /resolving mirrors timed out/);
});

// ── One-job mutex (spec E4 case 1) ──────────────────────────────────────────────

test("starting a second propose while a job is non-terminal returns a 409-shaped rejection; mutex released in finally", async () => {
  // Round 1 (the "first" propose below) is held open until resolveFirstRound fires; every
  // SUBSEQUENT round (the "third" propose, after the mutex releases) resolves immediately — proves
  // the mutex release without making the assertion itself wait out a timeout.
  let resolveFirstRound!: (profiles: BoundaryProfile[]) => void;
  let calls = 0;
  const proposer = stubProposer(() => {
    calls += 1;
    if (calls === 1) return new Promise<BoundaryProfile[]>((resolve) => { resolveFirstRound = resolve; });
    return Promise.resolve([CORRECT_PROFILE]);
  });
  const job = createOnboardingJob(buildDeps({ buildProposer: () => proposer }));

  const first = job.propose({ app: "nname", repo: "ArielFalcon/nname-gateway", services: [] });
  await new Promise((r) => setImmediate(r)); // let the first propose reach a non-terminal state

  const second = job.propose({ app: "nname", repo: "ArielFalcon/nname-gateway", services: [] });
  assert.ok(!(second instanceof Promise), "the mutex rejection is synchronous, not a promise");
  assert.equal(second.ok, false);
  if (!second.ok) assert.match(second.error, /an onboarding job is already running/);

  resolveFirstRound([CORRECT_PROFILE]);
  await first;

  // Mutex released: a THIRD propose after the first finished must be accepted (a Promise, not a
  // synchronous rejection — proves `busy` was cleared in run()'s finally).
  const third = job.propose({ app: "nname", repo: "ArielFalcon/nname-gateway", services: [] });
  assert.ok(third instanceof Promise, "the mutex must be released after the first run's finally");
  const thirdResult = await third;
  assert.equal(thirdResult.ok, true);
  await job.settled();
});

// ── Runner-busy fail-fast guard fires BEFORE resolvingMirrors (spec E4 case 2) ──

test("runner-busy guard fires before resolvingMirrors: job fails fast and ensureMirrorAtBranch is NEVER called", async () => {
  let mirrorCalls = 0;
  const deps = buildDeps({
    isRunnerBusy: () => true,
    ensureMirrorAtBranch: async (repo: string) => {
      mirrorCalls += 1;
      return `/mirrors/${repo}`;
    },
  });
  const job = createOnboardingJob(deps);
  await job.propose({ app: "nname", repo: "ArielFalcon/nname-gateway", services: [] });

  assert.equal(mirrorCalls, 0, "ensureMirrorAtBranch must never be called when the runner is busy");
  const status = job.status();
  assert.equal(status.state, ONBOARD_STATE.failed);
  assert.match(status.error ?? "", /runner busy, retry later/);
});

// ── Env-guard short-circuit, both branches (spec E5) ────────────────────────────

test("missing OPENCODE_API_KEY short-circuits to failed BEFORE resolvingMirrors starts", async () => {
  let mirrorCalls = 0;
  const deps = buildDeps({
    hasOpencodeApiKey: () => false,
    ensureMirrorAtBranch: async (repo: string) => {
      mirrorCalls += 1;
      return `/mirrors/${repo}`;
    },
  });
  const job = createOnboardingJob(deps);
  await job.propose({ app: "nname", repo: "ArielFalcon/nname-gateway", services: [] });

  assert.equal(mirrorCalls, 0, "ensureMirrorAtBranch must never be called with no OPENCODE_API_KEY");
  const status = job.status();
  assert.equal(status.state, ONBOARD_STATE.failed);
  assert.match(status.error ?? "", /OPENCODE_API_KEY/);
});

test("missing qa-proposer agent on the target server short-circuits to a distinct actionable failed", async () => {
  const deps = buildDeps({ hasProposerAgent: async () => false });
  const job = createOnboardingJob(deps);
  await job.propose({ app: "nname", repo: "ArielFalcon/nname-gateway", services: [] });

  const status = job.status();
  assert.equal(status.state, ONBOARD_STATE.failed);
  assert.match(status.error ?? "", /qa-proposer agent/);
});

// ── Round-budget timeout + AbortSignal cancellation (session-leak fix, spec E5) ─

test("a proposer that never resolves trips ONBOARD_JOB_TIMEOUT_MS -> failed, AND the AbortController's signal reached the proposer ctx", async () => {
  let capturedSignal: AbortSignal | undefined;
  const job = createOnboardingJob(buildDeps({
    jobTimeoutMs: 20,
    buildProposer: (ctx) => {
      capturedSignal = ctx.signal;
      return neverResolvingProposer();
    },
  }));
  await job.propose({ app: "nname", repo: "ArielFalcon/nname-gateway", services: [] });

  const status = job.status();
  assert.equal(status.state, ONBOARD_STATE.failed);
  assert.match(status.error ?? "", /onboarding timed out/);
  assert.ok(capturedSignal, "buildProposer must receive a signal in ctx");
  assert.equal(capturedSignal?.aborted, true, "the AbortController must have fired on timeout");
});

// ── No-winner outcome (spec E8) ──────────────────────────────────────────────────

test("a budget-exhausted no-winner run lands done with outcome no-profile and resolvedProfile absent", async () => {
  const job = createOnboardingJob(buildDeps({ buildProposer: () => noWinnerProposer() }));
  await job.propose({ app: "nname", repo: "ArielFalcon/nname-gateway", services: [] });

  const status = job.status();
  assert.equal(status.state, ONBOARD_STATE.done);
  assert.equal(status.outcome, "no-profile");
  assert.equal(status.resolvedProfile, undefined);
});

// ── Confirm against non-winner (spec E3, E8) ────────────────────────────────────

test("confirm against a non-winner (no-profile) job is rejected; no write attempted", async () => {
  let writeCalls = 0;
  const job = createOnboardingJob(buildDeps({
    buildProposer: () => noWinnerProposer(),
    writeConfig: () => { writeCalls += 1; },
  }));
  await job.propose({ app: "nname", repo: "ArielFalcon/nname-gateway", services: [] });

  const result = job.confirm();
  assert.equal(result.ok, false);
  assert.equal(writeCalls, 0, "writeConfig must never be called against a non-winner");
});

test("confirm against a still-idle job (never proposed) is rejected; no write attempted", () => {
  let writeCalls = 0;
  const job = createOnboardingJob(buildDeps({ writeConfig: () => { writeCalls += 1; } }));

  const result = job.confirm();
  assert.equal(result.ok, false);
  assert.equal(writeCalls, 0);
});

test("confirm against a failed job is rejected; no write attempted", async () => {
  let writeCalls = 0;
  const job = createOnboardingJob(buildDeps({
    isRunnerBusy: () => true,
    writeConfig: () => { writeCalls += 1; },
  }));
  await job.propose({ app: "nname", repo: "ArielFalcon/nname-gateway", services: [] });

  const result = job.confirm();
  assert.equal(result.ok, false);
  assert.equal(writeCalls, 0);
});

// ── Confirm against a winner (spec E3, E7) — reuses the Slice 4 splice verbatim ──

test("confirm against a winner writes the config via the injected writeConfig with a spliced boundaries: block", async () => {
  let written: { path: string; content: string } | undefined;
  const job = createOnboardingJob(buildDeps({
    readConfig: () => 'name: "nname"\nrepo: "org/nname"\n',
    writeConfig: (path, content) => { written = { path, content }; },
  }));
  await job.propose({ app: "nname", repo: "ArielFalcon/nname-gateway", services: [] });

  const result = job.confirm();
  assert.equal(result.ok, true);
  assert.ok(written, "writeConfig must be called on confirm against a winner");
  assert.ok(written!.content.includes("boundaries:"));
  assert.ok(written!.content.includes("name-{service}-api"));
});

// ── Propose is read-only end-to-end (spec E3, E-MUST) ───────────────────────────

test("propose() never calls writeConfig at any point in the propose->poll lifecycle", async () => {
  let writeCalls = 0;
  const job = createOnboardingJob(buildDeps({ writeConfig: () => { writeCalls += 1; } }));
  await job.propose({ app: "nname", repo: "ArielFalcon/nname-gateway", services: [] });

  assert.equal(writeCalls, 0, "propose must never write — only an explicit confirm() does");
});

// ── Status DTO round-trip (spec E6) ─────────────────────────────────────────────

test("status() returns an OnboardingJobStatus-shaped object for every state, including outcome once terminal", async () => {
  const job = createOnboardingJob(buildDeps());
  const idleStatus: OnboardingJobStatus = job.status();
  assert.equal(idleStatus.state, "idle");

  await job.propose({ app: "nname", repo: "ArielFalcon/nname-gateway", services: [] });
  const doneStatus: OnboardingJobStatus = job.status();
  assert.equal(doneStatus.state, "done");
  assert.equal(doneStatus.outcome, "winner");
  assert.ok(doneStatus.startedAt);
  assert.ok(doneStatus.finishedAt);
});
