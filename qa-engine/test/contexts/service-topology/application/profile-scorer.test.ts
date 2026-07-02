// test/contexts/service-topology/application/profile-scorer.test.ts
// TDD (strict): write failing tests first, then implement.
// Deterministic scorer for the profile-generator onboarding tool: runs the REAL resolver over
// an app's mirrors and measures how much of the extracted call-site pattern actually resolves.
// No LLM circularity — this is the objective oracle a candidate BoundaryProfile is judged against.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { scoreProfile, selectBestProfile, type ProfileScore } from "@contexts/service-topology/application/profile-scorer.ts";
import type { RepoRef, HttpBoundaryProfile } from "@contexts/service-topology/domain/index.ts";

// ---- selectBestProfile: pure, no I/O ----

function withScore<T extends Record<string, unknown>>(extra: T, score: ProfileScore): T & { score: ProfileScore } {
  return { ...extra, score };
}

// Builds a full ProfileScore from links/coverage, computing resolvedScore = links * resolutionRatio
// the same way scoreProfile does — keeps test fixtures honest against the real formula instead of
// hand-picking a resolvedScore that could silently drift from production behavior.
function makeScore(links: number, drift: number, external: number, unresolved: number): ProfileScore {
  const coverage = links + drift + external + unresolved;
  const resolutionRatio = coverage === 0 ? 0 : links / coverage;
  return { links, drift, external, unresolved, coverage, resolutionRatio, resolvedScore: links * resolutionRatio };
}

const ZERO: ProfileScore = { links: 0, drift: 0, external: 0, unresolved: 0, coverage: 0, resolutionRatio: 0, resolvedScore: 0 };

test("selectBestProfile: most-links candidate wins (both at ratio 1, so resolvedScore also orders them)", () => {
  const low = withScore({ id: "low" }, makeScore(1, 0, 0, 0));
  const high = withScore({ id: "high" }, makeScore(5, 0, 0, 0));
  const best = selectBestProfile([low, high]);
  assert.equal(best?.id, "high");
});

test("selectBestProfile: links-tie is broken by resolutionRatio via resolvedScore (higher wins)", () => {
  const lowRatio = withScore({ id: "lowRatio" }, makeScore(2, 0, 0, 8));
  const highRatio = withScore({ id: "highRatio" }, makeScore(2, 0, 0, 2));
  const best = selectBestProfile([lowRatio, highRatio]);
  assert.equal(best?.id, "highRatio");
});

test("selectBestProfile: two zero-link candidates (both unusable) → deterministic first-wins, not the noisier one", () => {
  // links=0 → resolvedScore 0 AND resolutionRatio 0 for both — a full tie. There is no coverage
  // tie-break: we do not rank one useless (zero-resolving) candidate above another. The first wins
  // deterministically; the noisier (higher-coverage) candidate must NOT win.
  const sparse = withScore({ id: "sparse" }, makeScore(0, 2, 1, 2)); // coverage 5
  const noisy = withScore({ id: "noisy" }, makeScore(0, 40, 30, 30)); // coverage 100
  const best = selectBestProfile([sparse, noisy]);
  assert.equal(best?.id, "sparse", "first candidate wins; the noisier one no longer wins on coverage");
});

test("selectBestProfile: empty candidates returns null", () => {
  const best = selectBestProfile([]);
  assert.equal(best, null);
});

test("selectBestProfile: single candidate returns that one", () => {
  const only = withScore({ id: "only" }, ZERO);
  const best = selectBestProfile([only]);
  assert.equal(best?.id, "only");
});

// ---- Fix 2: the adversarial case — links and resolutionRatio DISAGREE ----
// Reproduced by both judges: ranking by raw `links` picks an over-extractive WRONG profile
// (many links buried in drift/noise) over a precise correct one. resolvedScore = links *
// resolutionRatio must win over raw links.

test("selectBestProfile: precise-but-sparse (links:2, ratio:1.0 -> resolvedScore 2.0) beats over-extractive (links:3, ratio:0.03 -> resolvedScore ~0.09)", () => {
  const precise = withScore({ id: "precise" }, makeScore(2, 0, 0, 0)); // coverage 2, ratio 1.0, resolvedScore 2.0
  const overExtractive = withScore({ id: "overExtractive" }, makeScore(3, 97, 0, 0)); // coverage 100, ratio 0.03, resolvedScore ~0.09
  const best = selectBestProfile([precise, overExtractive]);
  assert.equal(best?.id, "precise", "raw links (3 > 2) must NOT win — precision (resolvedScore) must win");
});

test("selectBestProfile: nname-shape correct profile (links:10, ratio~0.37 -> resolvedScore~3.7) beats precise-but-sparse (links:2, ratio:1.0 -> resolvedScore 2.0) — positive-path check, not adversarial (both orderings agree)", () => {
  // links=10, coverage=27 -> resolutionRatio ~0.370, resolvedScore ~3.70
  const nnameCorrect = withScore({ id: "nnameCorrect" }, makeScore(10, 12, 3, 2));
  const sparse = withScore({ id: "sparse" }, makeScore(2, 0, 0, 0)); // resolvedScore 2.0
  const best = selectBestProfile([nnameCorrect, sparse]);
  assert.equal(best?.id, "nnameCorrect", "resolvedScore ~3.7 must beat resolvedScore 2.0");
});

// ---- Fix 1 (Round 2, CRITICAL): the tie-break must prefer PRECISION, not raw links ----
// Round 1's bug was raw `links` outranking precision on the PRIMARY key. Round 2 found the same
// bug re-opened one level down, in the tie-break: resolvedScore = links^2/coverage ties OFTEN on
// small integers (links:1,cov:1 == links:2,cov:4 == 1.0), and a `links` tie-break then picks the
// NOISIER candidate. This test is genuinely adversarial: perfect1 and noisy2of4 tie on
// resolvedScore (both 1.0) but disagree on both links (1 vs 2) and resolutionRatio (1.0 vs 0.5).
// Under the OLD tie-break (links desc) this picks noisy2of4 — RED. Under the NEW tie-break
// (resolutionRatio desc) this picks perfect1 — GREEN.
test("selectBestProfile: at equal resolvedScore, the tie-break prefers resolutionRatio (precision) over raw links — perfect1 (links:1,cov:1,ratio:1.0) beats noisy2of4 (links:2,cov:4,ratio:0.5), both resolvedScore 1.0", () => {
  const perfect1 = withScore({ id: "perfect1" }, makeScore(1, 0, 0, 0)); // coverage 1, ratio 1.0, resolvedScore 1.0
  const noisy2of4 = withScore({ id: "noisy2of4" }, makeScore(2, 0, 0, 2)); // coverage 4, ratio 0.5, resolvedScore 1.0
  assert.equal(perfect1.score.resolvedScore, noisy2of4.score.resolvedScore, "fixture sanity: both must tie on resolvedScore for this test to be genuinely adversarial");
  assert.notEqual(perfect1.score.resolutionRatio, noisy2of4.score.resolutionRatio, "fixture sanity: ratios must differ, or the tie-break has nothing to discriminate");

  const best = selectBestProfile([perfect1, noisy2of4]);
  assert.equal(best?.id, "perfect1", "at equal resolvedScore, the more-precise candidate (higher resolutionRatio) must win — raw links must NOT decide the tie");
});

test("selectBestProfile: at equal resolvedScore, resolutionRatio tie-break holds at a different scale too — {links:4,cov:4,ratio:1.0} beats {links:20,cov:100,ratio:0.2}, both resolvedScore 4.0", () => {
  const precise4of4 = withScore({ id: "precise4of4" }, makeScore(4, 0, 0, 0)); // coverage 4, ratio 1.0, resolvedScore 4.0
  const noisy20of100 = withScore({ id: "noisy20of100" }, makeScore(20, 0, 0, 80)); // coverage 100, ratio 0.2, resolvedScore 4.0
  assert.equal(precise4of4.score.resolvedScore, noisy20of100.score.resolvedScore, "fixture sanity: both must tie on resolvedScore");

  const best = selectBestProfile([precise4of4, noisy20of100]);
  assert.equal(best?.id, "precise4of4", "the noisier, over-extractive candidate must not win a resolvedScore tie via raw links");
});

// ---- Fix 3: all-zero candidates — deterministic first-pick, documented as meaningless ----

test("selectBestProfile: when every candidate is ZERO_SCORE, returns the first one deterministically", () => {
  const zeroA = withScore({ id: "zeroA" }, ZERO);
  const zeroB = withScore({ id: "zeroB" }, ZERO);
  const zeroC = withScore({ id: "zeroC" }, ZERO);
  const best = selectBestProfile([zeroA, zeroB, zeroC]);
  assert.equal(best?.id, "zeroA", "all-zero scores are equally bad — pick must be the first candidate, deterministically");
});

// ---- Fix 4: ZERO_SCORE aliasing — the shared singleton must be frozen ----

test("scoreProfile: a zero-coverage score is frozen (ZERO_SCORE singleton must not be mutable by callers)", async () => {
  const missingBackend: RepoRef = { repo: "org/nonexistent", mirrorDir: "/nonexistent/path" };
  const missingFront: RepoRef = { repo: "org/nonexistent-front", mirrorDir: "/nonexistent/front" };
  const score = await scoreProfile(CORRECT_PROFILE, [missingBackend], missingFront);
  assert.equal(Object.isFrozen(score), true, "ZERO_SCORE must be frozen so it cannot be mutated by reference");
  assert.throws(() => {
    score.links = 999;
  }, "mutating a frozen object must throw in strict mode");
});

// ---- Fix 5: NaN defensiveness — a NaN-poisoned candidate must never win, order-independent ----

test("selectBestProfile: a NaN-poisoned resolvedScore never wins, regardless of its position in the array", () => {
  const poisoned = withScore({ id: "poisoned" }, { links: 0, drift: 0, external: 0, unresolved: 0, coverage: 0, resolutionRatio: 0, resolvedScore: NaN });
  const healthy = withScore({ id: "healthy" }, makeScore(1, 0, 0, 0));

  const firstPosition = selectBestProfile([poisoned, healthy]);
  const secondPosition = selectBestProfile([healthy, poisoned]);

  assert.equal(firstPosition?.id, "healthy", "NaN candidate first in array must still lose");
  assert.equal(secondPosition?.id, "healthy", "NaN candidate second in array must still lose");
});

// ---- Fix 2 (Round 2): a hand-built +Infinity resolvedScore must never win, order-independent ----
// The old guard only special-cased NaN (Number.isNaN(x) ? -Infinity : x), which left a hand-built
// resolvedScore: Infinity free to win the comparison (Infinity > any finite score). The fix
// coerces ANY non-finite value (NaN, +Infinity, -Infinity) to -Infinity via Number.isFinite.

test("selectBestProfile: a hand-built +Infinity resolvedScore never wins, regardless of its position in the array", () => {
  const poisoned = withScore({ id: "poisoned" }, { links: 999, drift: 0, external: 0, unresolved: 0, coverage: 999, resolutionRatio: 1, resolvedScore: Infinity });
  const healthy = withScore({ id: "healthy" }, makeScore(1, 0, 0, 0));

  const firstPosition = selectBestProfile([poisoned, healthy]);
  const secondPosition = selectBestProfile([healthy, poisoned]);

  assert.equal(firstPosition?.id, "healthy", "+Infinity candidate first in array must still lose");
  assert.equal(secondPosition?.id, "healthy", "+Infinity candidate second in array must still lose");
});

// ---- scoreProfile: integration against the real fixtures ----
// Reuses the SAME fixtures as openapi-http-resolver.adapter.test.ts and resolver-factory.test.ts
// (test/contexts/service-topology/fixtures/{backend,frontend}) so this proves scoreProfile
// delegates to the real resolver-factory pipeline, not a stub.

const FIXTURES = join(import.meta.dirname, "../fixtures");
const backendRepo: RepoRef = { repo: "ArielFalcon/ms-name-orders", mirrorDir: join(FIXTURES, "backend") };
const frontendRepo: RepoRef = { repo: "ArielFalcon/name-webapp", mirrorDir: join(FIXTURES, "frontend") };

// The real nname HTTP boundary convention — the correct profile for this fixture pool.
const CORRECT_PROFILE: HttpBoundaryProfile = {
  transport: "http",
  frontFiles: "**/*.api.ts",
  frontCallSite: { kind: "receiver-verb-call", receiver: "this.rest" },
  servicePrefixTemplate: "name-{service}-api",
  serviceRepoTemplate: "ms-name-{service}",
  openApiPath: "src/main/resources/openapi/api-definition.yaml",
};

test("scoreProfile: the correct profile yields links > 0 and a coverage matching the known fixture", async () => {
  const score = await scoreProfile(CORRECT_PROFILE, [backendRepo], frontendRepo);
  // Known fixture shape (openapi-http-resolver.adapter.test.ts): 2 links (listOrders, getOrderById),
  // 1 drift (POST /orders), 1 external (name-unknown-api), 1 unresolved (dynamic id) = coverage 5.
  assert.equal(score.links, 2);
  assert.equal(score.drift, 1);
  assert.equal(score.external, 1);
  assert.equal(score.unresolved, 1);
  assert.equal(score.coverage, 5);
  assert.equal(score.resolutionRatio, 2 / 5);
  assert.equal(score.resolvedScore, 2 * (2 / 5), "resolvedScore = links * resolutionRatio");
});

test("scoreProfile: a profile with a WRONG receiver extracts zero call-sites (coverage === 0) — the receiver-failure mode", async () => {
  const wrongReceiver: HttpBoundaryProfile = {
    ...CORRECT_PROFILE,
    frontCallSite: { kind: "receiver-verb-call", receiver: "this.nope" },
  };
  const score = await scoreProfile(wrongReceiver, [backendRepo], frontendRepo);
  assert.equal(score.coverage, 0, "wrong receiver must match nothing in the front egress files");
  assert.equal(score.links, 0);
  assert.equal(score.resolutionRatio, 0, "resolutionRatio must be 0 (not NaN) when coverage is 0");
});

test("scoreProfile: a profile with the right receiver but a WRONG servicePrefixTemplate extracts call-sites but they do not resolve (coverage > 0, fewer/zero links) — the prefix-failure mode", async () => {
  const wrongPrefix: HttpBoundaryProfile = {
    ...CORRECT_PROFILE,
    servicePrefixTemplate: "wrong-{service}-prefix",
  };
  const score = await scoreProfile(wrongPrefix, [backendRepo], frontendRepo);
  assert.ok(score.coverage > 0, "the receiver still matches — call-sites are extracted");
  assert.ok(score.links < 2, "the wrong prefix must not resolve as many links as the correct profile");
});

test("scoreProfile: fail-open — an unresolvable app (missing mirrors) yields an all-zero score with resolutionRatio 0, never throws", async () => {
  const missingBackend: RepoRef = { repo: "org/nonexistent", mirrorDir: "/nonexistent/path" };
  const missingFront: RepoRef = { repo: "org/nonexistent-front", mirrorDir: "/nonexistent/front" };
  const score = await scoreProfile(CORRECT_PROFILE, [missingBackend], missingFront);
  assert.deepEqual(score, { links: 0, drift: 0, external: 0, unresolved: 0, coverage: 0, resolutionRatio: 0, resolvedScore: 0 });
});
