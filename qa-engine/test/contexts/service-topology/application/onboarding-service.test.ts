// test/contexts/service-topology/application/onboarding-service.test.ts
// TDD (strict): write failing tests first, then implement.
// OnboardingService drives the deterministic profile-generator onboarding loop: a
// ProfileProposerPort proposes candidate BoundaryProfiles, the REAL scoreProfile/selectBestProfile
// (profile-scorer.ts) judges them against the app's actual mirrors — no LLM circularity, the
// proposer never grades its own guess. This slice is the loop only: no YAML writing (deferred to
// the CLI), no LLM proposer (a future adapter; this test stubs ProfileProposerPort).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { OnboardingService, type OnboardingRoundProgress } from "@contexts/service-topology/application/onboarding-service.ts";
import type { ProfileProposerPort, ProposerFeedback } from "@contexts/service-topology/application/ports/index.ts";
import type { RepoRef, HttpBoundaryProfile, BoundaryProfile } from "@contexts/service-topology/domain/index.ts";

// ---- Fixtures: reuse the SAME pool as profile-scorer.test.ts, so this proves the service
// delegates to the REAL scorer, not a stub. ----

const FIXTURES = join(import.meta.dirname, "../fixtures");
const backendRepo: RepoRef = { repo: "ArielFalcon/ms-name-orders", mirrorDir: join(FIXTURES, "backend") };
const frontendRepo: RepoRef = { repo: "ArielFalcon/name-webapp", mirrorDir: join(FIXTURES, "frontend") };

// The real nname HTTP boundary convention — the correct profile for this fixture pool
// (verbatim from profile-scorer.test.ts's CORRECT_PROFILE: known to score links:2, coverage:5).
const CORRECT_PROFILE: HttpBoundaryProfile = {
  transport: "http",
  frontFiles: "**/*.api.ts",
  frontCallSite: { kind: "receiver-verb-call", receiver: "this.rest" },
  servicePrefixTemplate: "name-{service}-api",
  serviceRepoTemplate: "ms-name-{service}",
  openApiPath: "src/main/resources/openapi/api-definition.yaml",
};

// A profile with a wrong receiver: extracts ZERO call-sites against these fixtures
// (coverage === 0, per profile-scorer.test.ts's "receiver-failure mode" case).
const WRONG_RECEIVER_PROFILE: HttpBoundaryProfile = {
  ...CORRECT_PROFILE,
  frontCallSite: { kind: "receiver-verb-call", receiver: "this.nope" },
};

// ---- Stub proposers ----

/** Always proposes the same fixed list of candidates, every round. Records feedback it received. */
function fixedProposer(profiles: BoundaryProfile[], feedbackLog: (ProposerFeedback | undefined)[]): ProfileProposerPort {
  return {
    async propose(_system, _front, feedback) {
      feedbackLog.push(feedback);
      return profiles;
    },
  };
}

/** Proposes different candidates depending on how many times it has been called (1-indexed rounds). */
function byRoundProposer(byRound: Record<number, BoundaryProfile[]>): ProfileProposerPort {
  let calls = 0;
  return {
    async propose() {
      calls += 1;
      return byRound[calls] ?? [];
    },
  };
}

function alwaysEmptyProposer(): ProfileProposerPort {
  return { async propose() { return []; } };
}

function alwaysThrowsProposer(): ProfileProposerPort {
  return {
    async propose() {
      throw new Error("proposer boom");
    },
  };
}

// ---- Case 1: correct profile resolves on round 1 ----

test("onboard: proposer returns the correct nname profile -> resolves it, resolvedScore > 0, rounds === 1", async () => {
  const service = new OnboardingService(fixedProposer([CORRECT_PROFILE], []), 3);
  const result = await service.onboard([backendRepo], frontendRepo);

  assert.notEqual(result.profile, null);
  assert.deepEqual(result.profile, CORRECT_PROFILE);
  assert.equal(result.rounds, 1);
  assert.ok(result.candidates.length >= 1);
  const winner = result.candidates.find((c) => c.profile === CORRECT_PROFILE);
  assert.ok(winner, "the correct profile must appear in the audit trail");
  assert.ok(winner!.score.resolvedScore > 0, "the correct profile must score resolvedScore > 0 against the real fixtures");
});

// ---- Case 2: only a wrong (zero-coverage) profile every round -> budget exhausts, profile null ----

test("onboard: proposer returns only a wrong-receiver profile every round -> profile null, rounds === ceiling, full audit trail", async () => {
  const ceiling = 3;
  const service = new OnboardingService(fixedProposer([WRONG_RECEIVER_PROFILE], []), ceiling);
  const result = await service.onboard([backendRepo], frontendRepo);

  assert.equal(result.profile, null);
  assert.equal(result.rounds, ceiling);
  assert.equal(result.candidates.length, ceiling, "one scored candidate per round, ceiling rounds attempted");
  for (const c of result.candidates) {
    assert.equal(c.score.resolvedScore, 0, "the wrong-receiver profile must never resolve anything");
  }
});

// ---- Case 3: wrong on round 1, correct on round 2 -> returns correct, rounds === 2 ----

test("onboard: wrong profile on round 1, correct profile on round 2 -> returns the correct one, rounds === 2", async () => {
  const service = new OnboardingService(
    byRoundProposer({ 1: [WRONG_RECEIVER_PROFILE], 2: [CORRECT_PROFILE] }),
    3,
  );
  const result = await service.onboard([backendRepo], frontendRepo);

  assert.notEqual(result.profile, null);
  assert.deepEqual(result.profile, CORRECT_PROFILE);
  assert.equal(result.rounds, 2);
  assert.equal(result.candidates.length, 2, "one candidate scored per round across both rounds");
});

// ---- Case 4: proposer returns [] every round -> fail-open, profile null, no crash ----

test("onboard: proposer returns [] every round -> fail-open, profile null, no crash", async () => {
  const service = new OnboardingService(alwaysEmptyProposer(), 3);
  const result = await service.onboard([backendRepo], frontendRepo);

  assert.equal(result.profile, null);
  assert.equal(result.rounds, 3);
  assert.equal(result.candidates.length, 0, "nothing was ever proposed, so nothing was ever scored");
});

// ---- Case 5: proposer throws -> fail-open, treated as an empty round, no crash ----

test("onboard: proposer throws every round -> fail-open, treated as empty, no crash", async () => {
  const service = new OnboardingService(alwaysThrowsProposer(), 3);
  const result = await service.onboard([backendRepo], frontendRepo);

  assert.equal(result.profile, null);
  assert.equal(result.rounds, 3);
  assert.equal(result.candidates.length, 0, "a throwing round contributes no candidates");
});

// ---- Case 6: audit trail accumulates every scored candidate across ALL rounds ----

test("onboard: audit trail accumulates all scored candidates across rounds, not just the last round", async () => {
  const service = new OnboardingService(
    byRoundProposer({
      1: [WRONG_RECEIVER_PROFILE],
      2: [WRONG_RECEIVER_PROFILE],
      3: [WRONG_RECEIVER_PROFILE],
    }),
    3,
  );
  const result = await service.onboard([backendRepo], frontendRepo);

  assert.equal(result.candidates.length, 3, "3 rounds x 1 candidate each = 3 accumulated audit entries");
  assert.equal(result.profile, null);
});

// ---- Feedback wiring: the proposer receives the accumulated candidates-so-far as feedback ----

test("onboard: passes accumulated candidates as feedback to the proposer on subsequent rounds", async () => {
  const feedbackLog: (ProposerFeedback | undefined)[] = [];
  const service = new OnboardingService(fixedProposer([WRONG_RECEIVER_PROFILE], feedbackLog), 2);
  await service.onboard([backendRepo], frontendRepo);

  assert.equal(feedbackLog.length, 2, "proposer is called once per round up to the ceiling");
  assert.equal(feedbackLog[0]?.priorCandidates.length, 0, "round 1 has no prior candidates yet");
  assert.equal(feedbackLog[1]?.priorCandidates.length, 1, "round 2 receives round 1's scored candidate as feedback");
});

// ---- onRound observer (Slice 5a, design delta §B) — optional, backwards-compatible seam ----

// Case 7: constructing WITHOUT the optional 3rd ctor arg behaves byte-identical to today. This is
// the regression guard: every existing test above passes only (proposer, ceiling) and must keep
// behaving exactly as it did before onRound existed.
test("onboard: constructing without onRound behaves byte-identical to today (regression guard)", async () => {
  const service = new OnboardingService(fixedProposer([CORRECT_PROFILE], []), 3);
  const result = await service.onboard([backendRepo], frontendRepo);

  assert.notEqual(result.profile, null);
  assert.deepEqual(result.profile, CORRECT_PROFILE);
  assert.equal(result.rounds, 1);
});

// Case 8: onRound fires once per round, AFTER selectBestProfile, with the correct progress shape.
test("onboard: onRound fires once per round with round/proposed/scored/bestResolvedScore", async () => {
  const progress: OnboardingRoundProgress[] = [];
  const service = new OnboardingService(
    byRoundProposer({ 1: [WRONG_RECEIVER_PROFILE], 2: [CORRECT_PROFILE] }),
    3,
    (p) => progress.push(p),
  );
  const result = await service.onboard([backendRepo], frontendRepo);

  assert.deepEqual(result.profile, CORRECT_PROFILE);
  assert.equal(progress.length, 2, "onRound fires once per round actually run (2, since round 2 resolves)");
  assert.deepEqual(progress[0], { round: 1, proposed: 1, scored: 1, bestResolvedScore: 0 });
  assert.equal(progress[1]?.round, 2);
  assert.equal(progress[1]?.proposed, 1);
  assert.equal(progress[1]?.scored, 2, "scored accumulates across rounds (round 1's candidate + round 2's)");
  assert.ok(progress[1] !== undefined && progress[1].bestResolvedScore > 0, "round 2's bestResolvedScore reflects the winning candidate");
});

// Case 9: a THROWING onRound callback does not crash onboard() — the round completes normally and
// the loop still advances (proves the try { this.onRound?.(...) } catch {} wrap).
test("onboard: a throwing onRound callback does not crash onboard() — the round completes and the loop advances", async () => {
  let calls = 0;
  const throwingOnRound = (): void => {
    calls += 1;
    throw new Error("onRound boom");
  };
  const service = new OnboardingService(
    byRoundProposer({ 1: [WRONG_RECEIVER_PROFILE], 2: [CORRECT_PROFILE] }),
    3,
    throwingOnRound,
  );
  const result = await service.onboard([backendRepo], frontendRepo);

  assert.equal(calls, 2, "onRound was invoked both rounds despite throwing every time");
  assert.deepEqual(result.profile, CORRECT_PROFILE, "the loop completed normally and resolved the winner");
  assert.equal(result.rounds, 2);
});
