// Deterministic progress gate for the fix-loop in pipeline.ts.
//
// Before spending a retry slot, the orchestrator checks whether the previous round
// produced any measurable progress (fail-closed: if in doubt, don't spend).
// Three aggregate signals drive the decision (design §5.3 / D3):
//   (A) failingCount decreased      → the agent fixed at least one test
//   (B) failingNames set changed    → a different test is now failing (distinct pattern)
//   (C) lever2Flips > 0             → Lever-2 flipped at least one selector absent→present
//
// Fail-closed: if NONE of the above holds, stop spending (avoid burning a budget on a
// stuck agent). The regression guard keeps the best round (fewest failures) as the result.
//
// The real-bug branch short-circuits the loop when the selectors all resolve uniquely and
// the failure is a value mismatch (not a locator/timeout problem) — the test is exercising
// the right element but the app returns the wrong data: file an Issue immediately instead of
// burning retries on a genuine code defect.
//
// All functions are pure (no I/O, no side-effects) so they are trivially unit-testable.

// The aggregated state of one fix-loop round, computed from the QaRunResult and the
// Lever-2 selector checks run against the captured failure-point snapshot.
export interface RoundResult {
  // Names of the test cases that failed this round.
  failingNames: Set<string>;
  // Total number of failing test cases (may differ from failingNames.size if a test has
  // multiple entries — kept separate to support sub-case counting if ever needed).
  failingCount: number;
  // Selector names that were absent from the captured snapshot (UNVERIFIABLE group).
  absentSelectors: Set<string>;
  // Number of selectors that flipped from absent → present this round (Lever-2 signal C).
  lever2Flips: number;
}

// The gate decision returned to the pipeline.
export interface GateDecision {
  // True → the retry may proceed; false → stop the loop.
  spend: boolean;
  // Human-readable reason, logged by the pipeline.
  reason: string;
}

// A VALUE assertion matcher (the element is right; the app returned the wrong data). These are the
// matchers whose failure is a value oracle — toHaveURL/Count/Text/Value/Attribute/Class/JSProperty/CSS
// and the generic toBe/toEqual/toContain/toMatch family. `toHave…` is matched without requiring a
// trailing `(` because real PW messages render it both as `.toHaveText(expected) failed` AND, in
// older/compact forms, `.toHaveText: Expected …` — and no PRESENCE matcher shares the `toHave` prefix.
// The `toBe` family IS `(`-anchored: `\.toBe\(` matches `expect(x).toBe(y)` but NOT `toBeVisible(` /
// `toBeAttached(` (presence matchers — those are locator/timeout problems, never value mismatches).
const VALUE_MATCHER_RE =
  /\.toHave(?:Text|URL|Count|Values?|Attribute|Class|JSProperty|CSS|Title|Id|Role|Accessible(?:Name|Description))\b|\.toContainText\b|\.(?:toEqual|toStrictEqual|toMatchObject|toMatch|toContain|toBeCloseTo|toBeGreaterThan(?:OrEqual)?|toBeLessThan(?:OrEqual)?|toBe)\(/i;

// PRESENCE matchers: the assertion is about whether an element exists/visible/attached, NOT about a
// value. Their failure ("not found" / "not visible" / a timeout) is a LOCATOR/TIMEOUT problem. They
// ALSO emit an `Expected: visible` / `Received: <element(s) not found>` pair — so when a presence
// matcher is present we must NOT let that pair be read as a value mismatch.
const PRESENCE_MATCHER_RE =
  /\.toBe(?:Visible|Hidden|Attached|Detached|Enabled|Disabled|Checked|Unchecked|Focused|Editable|InViewport|Empty)\b/i;

// An `Expected:` / `Received:` diff pair (incl. `Expected string:` / `Received string:`, and the
// `Expected pattern:` form toHaveText emits). On its own (no explicit matcher token) this is a value
// diff — but ONLY when no presence matcher is in the message (toBeVisible emits the same pair).
const EXPECTED_RECEIVED_RE =
  /Expected(?:\s+(?:string|pattern|array|value|substring))?\s*:[\s\S]*Received(?:\s+(?:string|object|value|array))?\s*:/i;

// Classifies a failure detail string into a high-level failure category.
//
// The regex patterns are aligned with the PLAYWRIGHT_INFRA_RE family in execute.ts:103
// (they are distinct scopes: infra vs assertion/locator/timeout). Never throws.
export function classifyFailure(detail: string): "value-mismatch" | "timeout" | "locator" | "other" {
  if (!detail) return "other";

  // ASSERTION-MATCHER signature FIRST (C2). A real PW 1.60 `toHaveText`/`toHaveURL`/`toHaveCount`/…
  // failure message echoes a `Locator:  getByRole(...)` line AND a `Timeout:  Nms` trailer — both of
  // which the locator/timeout regexes below would otherwise match, mis-labelling a genuine VALUE
  // defect as `locator`/`timeout` and starving the real-bug branch (which fires only when EVERY
  // failure is value-mismatch). So a VALUE matcher is authoritative and short-circuits here, before
  // the echoed locator/timeout lines can override it.
  //
  // W3: but a PRESENCE matcher (toBeVisible/toBeAttached/…) is the REAL assertion for a present-but-
  // hidden element, and its multi-line message (call log / error echo) can INCIDENTALLY contain a
  // `.toHaveText(`/`.toHaveCount(` token from an unrelated echoed line. A whole-string VALUE_MATCHER_RE
  // test over the full message would then wrongly flip it to value-mismatch, which can push a run to
  // "all value-mismatch" → a spurious real-bug Issue for an element that merely isn't visible. So when
  // a presence matcher is present, the value-matcher token does NOT win — fall through to the
  // locator/timeout logic below (where toBeVisible correctly classifies as locator/timeout).
  if (!PRESENCE_MATCHER_RE.test(detail) && VALUE_MATCHER_RE.test(detail)) return "value-mismatch";
  // A bare Expected/Received diff with NO presence matcher present is also a value mismatch (a
  // toBe/toEqual whose token the regex above missed still produces this pair). Guarded by the
  // presence check so toBeVisible's `Expected: visible / Received: <not found>` stays a locator fault.
  if (!PRESENCE_MATCHER_RE.test(detail) && EXPECTED_RECEIVED_RE.test(detail)) return "value-mismatch";

  // Locator / selector failure: the element was not found or the selector was ambiguous. Reached only
  // when NO value-assertion signature was present above. A `expect(locator).toBeVisible()` failure
  // ("element(s) not found") is a LOCATOR problem; `not found` / `element(s) not found` /
  // `toBeVisible … not visible|found` / `resolved to 0 elements` / `waiting for locator` are all
  // locator signatures. (page.accessibility was removed in PW 1.60 — dropped.)
  if (
    /strict mode violation|locator\.(?:click|fill|check|hover|press|select|tap)|element\(s\)? not found|not found|resolved to \d+ elements|waiting for (?:locator|selector)|waiting for .* to be visible/i.test(detail) ||
    /getBy(?:Role|Text|Label|TestId|Placeholder|AltText|Title)|no element|element not found/i.test(detail) ||
    /toBeVisible[\s\S]*?not (?:visible|found)|Target.*closed/i.test(detail)
  ) {
    return "locator";
  }

  // Timeout: the locator resolved but the element/network condition was not met in time.
  if (
    /timed? ?out|exceeded.*timeout|page\.waitFor|locator\.wait|networkidle/i.test(detail) ||
    /Timeout \d+ms exceeded/i.test(detail)
  ) {
    return "timeout";
  }

  // Legacy value-mismatch fallback: free-text assertion phrasing with no matcher token and no
  // Expected/Received colon pair (e.g. "Expected value to equal 42 but received 0"). Checked LAST so a
  // locator/timeout message that incidentally contains "to be" (e.g. "...to be attached") is not
  // misclassified — those were already routed above.
  if (/to equal|value mismatch|assertion.*fail/i.test(detail)) {
    return "value-mismatch";
  }

  return "other";
}

// Selects the best round from a list (fewest failures; ties go to the later round so
// the most recent rewrite is preferred when scores are equal).
export function bestRound<T extends { failingCount: number }>(rounds: T[]): T | undefined {
  if (rounds.length === 0) return undefined;
  return rounds.reduce((best, cur) => (cur.failingCount <= best.failingCount ? cur : best));
}

// Core gate function. Called at the top of each fix-loop iteration with the previous
// round's result (`prev`) and the current round's result (`cur`).
//
// `prev === null` on the FIRST retry: always allow (the first round is the baseline
// we measure progress FROM — we need at least two rounds to compare).
//
// The caller is responsible for the hard cap (MAX_RETRIES in the loop header). This
// function only decides whether progress justifies spending the next slot.
export function decideProgress(prev: RoundResult | null, cur: RoundResult): GateDecision {
  // First retry: always allowed (no prior round to compare against).
  if (prev === null) {
    return { spend: true, reason: "first retry — baseline established" };
  }

  // Regression guard: if the current round has MORE failures than the previous, stop.
  // The caller keeps the best round's result (fewest failures) as the decision input.
  if (cur.failingCount > prev.failingCount) {
    return { spend: false, reason: "regression — failing count increased; keeping best round" };
  }

  // Signal A: failing count decreased → clear progress.
  if (cur.failingCount < prev.failingCount) {
    return { spend: true, reason: `progress (A): failing count ${prev.failingCount} → ${cur.failingCount}` };
  }

  // Signal B: failing names set changed (a failure resolved, a different one surfaced).
  if (!setsEqual(cur.failingNames, prev.failingNames)) {
    return { spend: true, reason: "progress (B): failing test set changed" };
  }

  // Signal C: Lever-2 flipped at least one selector from absent → present.
  if (cur.lever2Flips > 0) {
    return { spend: true, reason: `progress (C): ${cur.lever2Flips} selector(s) flipped absent→present` };
  }

  // Fail-closed: no signal holds → stop spending.
  return { spend: false, reason: "no progress — agent ignored ground truth; stopping loop" };
}

// Whether the real-bug branch should fire: all proposed selectors resolve uniquely and
// the failure is a value mismatch (the test exercises the right element but the app
// returns wrong data). The loop should stop and file an Issue rather than burning retries.
//
// `allSelectorsUnique`  — true when every proposed selector in the last generated spec
//                          resolved to exactly one node in the captured snapshot.
// `failureDetails`      — the `detail` strings of all failing cases in the last round.
export function isLikelyRealBug(allSelectorsUnique: boolean, failureDetails: string[]): boolean {
  if (!allSelectorsUnique) return false;
  if (failureDetails.length === 0) return false;
  // Every failure must be a value mismatch (no timeout, no locator error).
  return failureDetails.every((d) => classifyFailure(d) === "value-mismatch");
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}
