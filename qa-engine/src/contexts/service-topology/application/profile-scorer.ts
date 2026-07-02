// service-topology/application/profile-scorer.ts
// Deterministic scorer for the profile-generator onboarding tool: runs the REAL resolver over
// an app's mirrors for one candidate BoundaryProfile and measures how much of the extracted
// call-site pattern actually resolves into a link. This is the objective oracle that makes
// profile-generation reliable — it MEASURES against real code, never an LLM judging its own
// (or another LLM's) guess (no circularity, mirrors the change-coverage keystone's role for E2E).
//
// Two failure modes this score is built to DISTINGUISH (see scoreProfile's doc below):
//   1. wrong frontCallSite.receiver  → extracts ZERO call-sites  → coverage === 0
//   2. wrong servicePrefixTemplate/serviceRepoTemplate → extracts call-sites, but they fall into
//      external/unresolved instead of resolving → coverage > 0, links low/zero
import { buildServiceBoundaryResolver } from "../infrastructure/resolver-factory.ts";
import type { BoundaryProfile, RepoRef } from "../domain/index.ts";

/** How much of a candidate BoundaryProfile's extracted call-site pattern actually resolves. */
export interface ProfileScore {
  links: number;
  drift: number;
  external: number;
  unresolved: number;
  /** Total call-sites the pattern extracted, across all four result buckets. */
  coverage: number;
  /** links / coverage, or 0 when coverage === 0 (never NaN). */
  resolutionRatio: number;
  /** links * resolutionRatio — resolved-volume weighted by precision. The PRIMARY ranking key
   *  (see isBetter's doc below): raw `links` alone rewards over-extraction (many call-sites that
   *  mostly land in drift/external/unresolved), so it must be weighed against how precise the
   *  extraction actually is. Exposed (not just computed inline) so the ranking is auditable. */
  resolvedScore: number;
}

const ZERO_SCORE: ProfileScore = Object.freeze({
  links: 0,
  drift: 0,
  external: 0,
  unresolved: 0,
  coverage: 0,
  resolutionRatio: 0,
  resolvedScore: 0,
});

/** Run the resolver for ONE candidate profile over the app's mirrors, return its score.
 *  Fail-open by construction: buildServiceBoundaryResolver + resolveLinks never throw (both are
 *  fail-open by contract — see resolver-factory.ts and application/ports/index.ts), so an
 *  unresolvable app (missing mirrors, malformed profile) degrades to ZERO_SCORE, never a throw. */
export async function scoreProfile(
  profile: BoundaryProfile,
  system: RepoRef[],
  front: RepoRef,
): Promise<ProfileScore> {
  const resolver = buildServiceBoundaryResolver([profile]);
  const result = await resolver.resolveLinks(system, front);

  const links = result.links.length;
  const drift = result.drift.length;
  const external = result.external.length;
  const unresolved = result.unresolved.length;
  const coverage = links + drift + external + unresolved;

  if (coverage === 0) return ZERO_SCORE;

  const resolutionRatio = links / coverage;
  return { links, drift, external, unresolved, coverage, resolutionRatio, resolvedScore: links * resolutionRatio };
}

/** Pick the best candidate: highest resolvedScore (links weighted by precision), tie-break by
 *  resolutionRatio (precision), then by coverage. Relative comparison is deliberate — an app with
 *  little real cross-repo traffic yields few links even under a correct profile, so absolute
 *  thresholds would misjudge it. Comparing candidates against EACH OTHER is what makes the score
 *  meaningful.
 *
 *  When every candidate is ZERO_SCORE (nothing resolves for any of them), the first candidate is
 *  returned — deterministic, but a meaningless "all equally bad" pick; it signals "no candidate
 *  resolves anything", not "candidate 1 is good".
 *
 *  Returns null for an empty candidate list. */
export function selectBestProfile<T extends { score: ProfileScore }>(candidates: readonly T[]): T | null {
  if (candidates.length === 0) return null;

  let best = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    if (isBetter(candidate.score, best.score)) best = candidate;
  }
  return best;
}

/** true when `a` should replace `b` as the current best.
 *
 *  PRIMARY key: resolvedScore (links * resolutionRatio) — raw `links` alone rewards
 *  over-extraction: a wrong servicePrefixTemplate/serviceRepoTemplate can extract MANY call-sites
 *  that mostly fall into drift/external/unresolved, outscoring a correct-but-lower-volume profile
 *  on links alone. Precision (resolutionRatio) must weigh into the comparison, not just break
 *  ties after it.
 *  Tie-break: resolutionRatio (higher wins). A tie beyond that is only reachable when both
 *  candidates resolve zero links (both unusable) — it falls to a deterministic first-wins, NOT a
 *  coverage comparison (see the return at the bottom of this function).
 *
 *  Why resolutionRatio and NOT raw links as the tie-break: resolvedScore = links * resolutionRatio
 *  ties OFTEN on small integers (links:1,coverage:1 and links:2,coverage:4 both resolve to
 *  resolvedScore 1.0). A `links`-based tie-break would then pick the NOISIER of two
 *  equal-resolved-volume candidates — reintroducing, one level down, the exact bug this score was
 *  built to prevent (over-extraction outranking precision). At equal resolved volume, the more
 *  precise candidate (fewer call-sites landing in drift/external/unresolved) must win, so
 *  resolutionRatio — not links — is the tie-break.
 *
 *  Non-finite-defensive: selectBestProfile is exported standalone with no input validation, so a
 *  non-finite resolvedScore (NaN, +Infinity, or -Infinity — not reachable via scoreProfile today,
 *  but possible from a hand-built score) is coerced to -Infinity before comparing via
 *  Number.isFinite — no non-finite value ever wins, and the result is deterministic regardless of
 *  the array position of the poisoned candidate. */
function isBetter(a: ProfileScore, b: ProfileScore): boolean {
  const aResolved = Number.isFinite(a.resolvedScore) ? a.resolvedScore : -Infinity;
  const bResolved = Number.isFinite(b.resolvedScore) ? b.resolvedScore : -Infinity;
  if (aResolved !== bResolved) return aResolved > bResolved;
  if (a.resolutionRatio !== b.resolutionRatio) return a.resolutionRatio > b.resolutionRatio;
  // A tie on BOTH resolvedScore and resolutionRatio algebraically forces links and coverage equal
  // too for any links > 0 (resolvedScore = links * resolutionRatio), so this point is only reached
  // when both candidates resolve ZERO links — both unusable. We do not rank one useless candidate
  // above another: a full tie keeps the current best (deterministic first-wins).
  return false;
}
