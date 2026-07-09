// service-topology/application/onboarding-service.ts
// The deterministic loop for the profile-generator onboarding tool: NO LLM. A ProfileProposerPort
// proposes candidate BoundaryProfiles; the REAL scoreProfile/selectBestProfile (profile-scorer.ts)
// judge each candidate against the app's actual mirrors — the objective oracle, so the proposer
// never grades its own guess (mirrors the change-coverage keystone's role for E2E; see
// profile-scorer.ts's own header). This is the loop only: no YAML is written here (deferred to the
// CLI) and no LLM proposer exists yet (a future adapter behind ProfileProposerPort; this slice is
// exercised by a stub).
//
// OnboardingBudget is a TRIVIAL LOCAL value object, deliberately NOT the qa-run-orchestration
// context's CycleBudget: importing it would be a cross-context import, which this context (like
// every bounded context in qa-engine) does not do. The two budgets also differ in shape on purpose
// — CycleBudget's exhausted() is `cycleCount > ceiling` (checked after an unconditional first
// tick that models "cycle 0 has already run"); OnboardingBudget's exhausted() is `count >= ceiling`
// (checked BEFORE proposing, so "ceiling" reads literally as "at most this many rounds").
import { scoreProfile, selectBestProfile, type ProfileScore } from "./profile-scorer.ts";
import type { ProfileProposerPort, ProposerFeedback } from "./ports/index.ts";
import type { BoundaryProfile, RepoRef } from "../domain/index.ts";

/** Trivial round-ceiling counter for the onboarding loop. Local to this context by design (see
 *  this file's header) — NOT qa-run-orchestration's CycleBudget. */
export class OnboardingBudget {
  private count = 0;

  constructor(private readonly ceiling: number) {}

  exhausted(): boolean {
    return this.count >= this.ceiling;
  }

  tick(): void {
    this.count += 1;
  }
}

/** One scored candidate in the onboarding audit trail. */
export interface ScoredCandidate {
  profile: BoundaryProfile;
  score: ProfileScore;
}

export interface OnboardingResult {
  /** The winning profile, or null if none resolved anything within the round budget. */
  profile: BoundaryProfile | null;
  /** Every candidate scored across every round — the full audit trail, in round order. */
  candidates: ReadonlyArray<ScoredCandidate>;
  /** How many rounds actually ran (<= the constructor's ceiling). */
  rounds: number;
}

/** Per-round progress snapshot, emitted (optionally) after each round's scoring completes — the
 *  seam a server-side onboarding job (src/server/onboarding/onboarding-job.ts) maps into its own
 *  in-memory status for live TUI polling. Local to this context: no transport concerns leak in. */
export interface OnboardingRoundProgress {
  round: number;
  proposed: number;
  scored: number;
  bestResolvedScore: number;
}

/** Drives the deterministic onboarding loop. Fail-open by construction: a proposer that returns
 *  an empty array OR throws costs the loop one round, never a crash (mirrors ProfileProposerPort's
 *  own fail-open contract). */
export class OnboardingService {
  constructor(
    private readonly proposer: ProfileProposerPort,
    private readonly ceiling = 3,
    // Optional, backwards-compatible: every existing caller (the CLI, every test predating this
    // seam) passes nothing and behaves byte-identically. Wrapped in try/catch at the call-site
    // below so a throwing observer never crashes onboard() — it only costs the observer its own
    // notification, never the round itself.
    private readonly onRound?: (p: OnboardingRoundProgress) => void,
  ) {}

  async onboard(system: RepoRef[], front: RepoRef): Promise<OnboardingResult> {
    const budget = new OnboardingBudget(this.ceiling);
    const candidates: ScoredCandidate[] = [];
    let rounds = 0;

    while (!budget.exhausted()) {
      rounds += 1;
      budget.tick();

      const feedback: ProposerFeedback = { priorCandidates: candidates.slice() };
      const proposed = await this.proposeSafely(system, front, feedback);

      for (const profile of proposed) {
        const score = await scoreProfile(profile, system, front);
        candidates.push({ profile, score });
      }

      const best = selectBestProfile(candidates);
      try {
        this.onRound?.({
          round: rounds,
          proposed: proposed.length,
          scored: candidates.length,
          bestResolvedScore: best?.score.resolvedScore ?? 0,
        });
      } catch {
        // A throwing observer must never crash the onboarding loop — see ctor doc.
      }

      if (best !== null && best.score.resolvedScore > 0) {
        return { profile: best.profile, candidates, rounds };
      }
    }

    return { profile: null, candidates, rounds };
  }

  /** Fail-open wrapper: a throwing proposer is treated as "no candidates this round". */
  private async proposeSafely(system: RepoRef[], front: RepoRef, feedback: ProposerFeedback): Promise<BoundaryProfile[]> {
    try {
      return await this.proposer.propose(system, front, feedback);
    } catch {
      // Structural safety net only: the production LLM adapter honors the port's own fail-open
      // contract and never throws here, so this fires only if a FUTURE proposer breaks that
      // contract — it is NOT the diagnostic point (that lives in the adapter's catch, the sole
      // site where the real error object and app/model context are still in scope).
      return [];
    }
  }
}
