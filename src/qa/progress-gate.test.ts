import { test } from "node:test";
import assert from "node:assert/strict";
import { decideProgress, classifyFailure, bestRound, isLikelyRealBug, type RoundResult, type GateDecision } from "./progress-gate";

// ── helpers ───────────────────────────────────────────────────────────────────

function round(failingNames: string[], absentSelectors: string[] = [], lever2Flips = 0): RoundResult {
  return {
    failingNames: new Set(failingNames),
    failingCount: failingNames.length,
    absentSelectors: new Set(absentSelectors),
    lever2Flips,
  };
}

function roundN(failingCount: number, failingNames: string[], absentSelectors: string[] = [], lever2Flips = 0): RoundResult {
  return {
    failingNames: new Set(failingNames),
    failingCount,
    absentSelectors: new Set(absentSelectors),
    lever2Flips,
  };
}

// ── decideProgress: first retry always allowed ─────────────────────────────

test("decideProgress: first retry (prev=null) always returns spend:true", () => {
  const cur = round(["test A", "test B"]);
  const result = decideProgress(null, cur);
  assert.equal(result.spend, true);
  assert.match(result.reason, /first retry/i);
});

test("decideProgress: first retry with zero failures still allowed", () => {
  const cur = round([]);
  assert.equal(decideProgress(null, cur).spend, true);
});

// ── decideProgress: Signal A — count decreased ─────────────────────────────

test("decideProgress: spend on count decrease (A) — 5 → 3 failures", () => {
  const prev = round(["a", "b", "c", "d", "e"]);
  const cur = round(["a", "b", "c"]);
  const result = decideProgress(prev, cur);
  assert.equal(result.spend, true);
  assert.match(result.reason, /progress \(A\)/i);
});

test("decideProgress: spend on count decrease (A) — 2 → 1 failure", () => {
  const prev = round(["a", "b"]);
  const cur = round(["b"]);
  assert.equal(decideProgress(prev, cur).spend, true);
});

// ── decideProgress: Signal B — failing name SET changed ────────────────────

test("decideProgress: spend when name set changed but count same (B)", () => {
  const prev = round(["test A", "test B"]);
  const cur = round(["test A", "test C"]); // B resolved, C surfaced
  const result = decideProgress(prev, cur);
  assert.equal(result.spend, true);
  assert.match(result.reason, /progress \(B\)/i);
});

test("decideProgress: spend when completely different test fails (B)", () => {
  const prev = round(["test A"]);
  const cur = round(["test B"]);
  assert.equal(decideProgress(prev, cur).spend, true);
});

// ── decideProgress (option c): RE-2 re-exploration downgrades WEAK progress ──
// A retry that merely RESHUFFLED which test fails (signal B, same count) while re-exploring heavily
// (browser navigation it was told to skip on a grounded retry) is thrashing, not progress → stop
// paying for it. A STRONG signal (fewer failures, A) is never downgraded.
test("decideProgress (c): signal-B reshuffle with HEAVY re-exploration is thrashing → stop", () => {
  const prev = round(["test A", "test B"]);
  const cur: RoundResult = { ...round(["test A", "test C"]), reexploreNavigations: 5 };
  const result = decideProgress(prev, cur);
  assert.equal(result.spend, false);
  assert.match(result.reason, /no progress/i);
});

test("decideProgress (c): signal-B reshuffle with LIGHT re-exploration is still progress → spend", () => {
  const prev = round(["test A", "test B"]);
  const cur: RoundResult = { ...round(["test A", "test C"]), reexploreNavigations: 1 };
  assert.equal(decideProgress(prev, cur).spend, true);
});

test("decideProgress (c): signal-A (fewer failures) spends even with heavy re-exploration", () => {
  const prev = round(["a", "b", "c"]);
  const cur: RoundResult = { ...round(["a"]), reexploreNavigations: 9 };
  assert.equal(decideProgress(prev, cur).spend, true);
});

// Calibration boundary: the count is NAVIGATIONS (one per route). The RE-1 anti-blinding escape lets
// a grounded retry visit a couple of genuinely-uncovered routes, so the threshold must sit above
// that — 2 navigations still spends; 3 (≈3 routes re-visited) on a mere reshuffle is thrashing.
test("decideProgress (c): boundary — 2 navigations still spends, 3 stops", () => {
  const prev = round(["test A", "test B"]);
  assert.equal(decideProgress(prev, { ...round(["test A", "test C"]), reexploreNavigations: 2 }).spend, true);
  assert.equal(decideProgress(prev, { ...round(["test A", "test C"]), reexploreNavigations: 3 }).spend, false);
});

// ── decideProgress: Signal C — lever2Flips > 0 ────────────────────────────

test("decideProgress: spend when lever2Flips > 0 (C), same count and names", () => {
  const prev = round(["test A", "test B"], ["button: Submit"], 0);
  const cur = round(["test A", "test B"], [], 1); // selector flipped present
  const result = decideProgress(prev, cur);
  assert.equal(result.spend, true);
  assert.match(result.reason, /progress \(C\)/i);
});

test("decideProgress: spend when multiple selectors flip (C)", () => {
  const prev = round(["a", "b"], ["button: Ok", "textbox: Name"], 0);
  const cur = round(["a", "b"], [], 2);
  assert.equal(decideProgress(prev, cur).spend, true);
});

// ── decideProgress: fail-closed — no progress ─────────────────────────────

test("decideProgress: fail-closed when count same, names same, zero lever2Flips", () => {
  const prev = round(["test A", "test B"]);
  const cur = round(["test A", "test B"]);
  const result = decideProgress(prev, cur);
  assert.equal(result.spend, false);
  assert.match(result.reason, /no progress/i);
});

test("decideProgress: fail-closed even with absent selectors (same round, no flip)", () => {
  const prev = round(["test A"], ["columnheader: Name"], 0);
  const cur = round(["test A"], ["columnheader: Name"], 0); // nothing changed
  const result = decideProgress(prev, cur);
  assert.equal(result.spend, false);
});

// ── decideProgress: regression guard ──────────────────────────────────────

test("decideProgress: regression guard — spend:false when failingCount increases", () => {
  const prev = round(["a", "b", "c"]); // 3 failures
  const cur = round(["a", "b", "c", "d", "e"]); // 5 failures (regression!)
  const result = decideProgress(prev, cur);
  assert.equal(result.spend, false);
  assert.match(result.reason, /regression/i);
});

test("decideProgress: regression guard takes priority over signal B (same set + regression)", () => {
  const prev = round(["a", "b", "c"]); // 3 failures
  // cur has 4 failing (regression) but different names (would be B)
  const cur = roundN(4, ["a", "b", "d", "e"]);
  const result = decideProgress(prev, cur);
  assert.equal(result.spend, false);
  assert.match(result.reason, /regression/i);
});

// ── decideProgress: identical rounds (oscillation / stuck agent) ──────────

test("decideProgress: identical identical rounds → fail-closed (oscillation)", () => {
  const r = round(["flaky A", "flaky B"]);
  // Simulate the loop: round 1 and round 2 produce identical results
  assert.equal(decideProgress(null, r).spend, true);   // first retry allowed
  assert.equal(decideProgress(r, { ...r, failingNames: new Set(r.failingNames) }).spend, false); // second: no progress
});

// ── classifyFailure ────────────────────────────────────────────────────────

test("classifyFailure: value-mismatch from expect assertion", () => {
  assert.equal(classifyFailure("expect(received).toBe(expected)\nExpected: 'hello'\nReceived: 'world'"), "value-mismatch");
});

test("classifyFailure: value-mismatch from toHaveText", () => {
  assert.equal(classifyFailure("expect(locator).toHaveText: Expected 'Foo' but received 'Bar'"), "value-mismatch");
});

test("classifyFailure: value-mismatch from toEqual", () => {
  assert.equal(classifyFailure("Expected value to equal 42 but received 0"), "value-mismatch");
});

// W3: toHaveURL is the motivating Lever-3 case — a failing post-redirect URL assertion (the element
// was right, the app landed on the wrong route). It must classify as value-mismatch so the real-bug
// branch can fire. The first asserts the explicit matcher token alone carries the classification
// (no "Expected…Received" pair present).
test("classifyFailure: value-mismatch from toHaveURL (post-redirect route mismatch)", () => {
  assert.equal(classifyFailure("Error: expect(page).toHaveURL(expected) failed."), "value-mismatch");
  assert.equal(
    classifyFailure("expect(page).toHaveURL(expected) failed\nExpected: \"/owners/5\"\nReceived: \"/owners\""),
    "value-mismatch",
  );
});

test("classifyFailure: value-mismatch from toHaveCount", () => {
  assert.equal(classifyFailure("Error: expect(locator).toHaveCount(expected) failed."), "value-mismatch");
});

test("classifyFailure: value-mismatch from toHaveAttribute", () => {
  assert.equal(classifyFailure("Error: expect(locator).toHaveAttribute(expected) failed."), "value-mismatch");
});

test("classifyFailure: timeout from Playwright timed out message", () => {
  assert.equal(classifyFailure("Timeout 30000ms exceeded.\n  at waitForSelector"), "timeout");
});

test("classifyFailure: timeout from page.waitForLoadState", () => {
  assert.equal(classifyFailure("page.waitForLoadState timed out after 30000ms"), "timeout");
});

test("classifyFailure: locator from strict mode violation", () => {
  assert.equal(classifyFailure("strict mode violation: getByRole('button', { name: 'Submit' }) resolved to 3 elements"), "locator");
});

test("classifyFailure: locator from not found error", () => {
  assert.equal(classifyFailure("locator.click: element not found\n  waiting for getByRole('textbox', { name: 'Email' })"), "locator");
});

test("classifyFailure: locator from resolved to N elements", () => {
  assert.equal(classifyFailure("locator resolved to 2 elements"), "locator");
});

test("classifyFailure: other for empty string", () => {
  assert.equal(classifyFailure(""), "other");
});

test("classifyFailure: other for unknown error string", () => {
  assert.equal(classifyFailure("ECONNRESET"), "other");
});

// C4: a `expect(locator).toBeVisible()` failure is a LOCATOR problem, NOT a value mismatch — even
// though `toBeVisible` contains the `.toBe` substring the value-mismatch matcher keys on. Locator is
// now checked FIRST so this realistic Playwright 1.60 message classifies correctly (otherwise the
// real-bug "app defect" branch misfires and files a spurious Issue).
test("classifyFailure: toBeVisible 'element(s) not found' is a locator failure, not value-mismatch", () => {
  const detail =
    "Error: expect(locator).toBeVisible() failed\n\n" +
    "Locator: getByRole('columnheader', { name: 'Name' })\n" +
    "Expected: visible\n" +
    "Received: <element(s) not found>\n" +
    "Call log:\n  - waiting for getByRole('columnheader', { name: 'Name' })";
  assert.equal(classifyFailure(detail), "locator");
});

test("classifyFailure: toBeVisible … not visible is a locator failure", () => {
  assert.equal(
    classifyFailure("expect(locator).toBeVisible() failed\nExpected: visible\nReceived: not visible"),
    "locator",
  );
});

test("classifyFailure: 'resolved to 0 elements' is a locator failure", () => {
  assert.equal(classifyFailure("locator.click: Error: locator resolved to 0 elements"), "locator");
});

test("classifyFailure: 'waiting for locator' is a locator failure", () => {
  assert.equal(classifyFailure("Timeout: waiting for locator('#missing') to be attached"), "locator");
});

// ── C2: REAL PW 1.60 assertion-matcher messages classify on the MATCHER, not the echoed lines ──
// A real toHaveText/toHaveURL/… failure message embeds a `Locator:  getByRole(...)` echo AND a
// `Timeout:  Nms` trailer. Classifying the locator/timeout regex first mislabelled a genuine VALUE
// defect as locator/timeout → isLikelyRealBug (needs ALL failures value-mismatch) never fired for the
// exact assertion-defect class it targets. The matcher signature must win.

test("classifyFailure C2: real toHaveText failure (echoed Locator + Timeout trailer) is value-mismatch", () => {
  // Verbatim shape of a PW 1.60 toHaveText assertion failure.
  const detail = [
    "Error: expect(locator).toHaveText(expected) failed",
    "",
    "Locator:  getByRole('heading')",
    "Expected string: \"Find Owners\"",
    "Received string: \"Owners\"",
    "Timeout:  5000ms",
    "Call log:",
    "  - Expect \"toHaveText\" with timeout 5000ms",
    "  - waiting for getByRole('heading')",
  ].join("\n");
  assert.equal(classifyFailure(detail), "value-mismatch");
});

test("classifyFailure C2: real toHaveURL failure with a Timeout trailer is value-mismatch", () => {
  const detail = [
    "Error: expect(page).toHaveURL(expected) failed",
    "",
    "Expected string: \"http://localhost:8080/owners/5\"",
    "Received string: \"http://localhost:8080/owners\"",
    "Timeout:  5000ms",
  ].join("\n");
  assert.equal(classifyFailure(detail), "value-mismatch");
});

test("classifyFailure C2: real toHaveCount failure (echoed Locator) is value-mismatch", () => {
  const detail = [
    "Error: expect(locator).toHaveCount(expected) failed",
    "",
    "Locator:  getByRole('row')",
    "Expected:  3",
    "Received:  2",
    "Timeout:  5000ms",
  ].join("\n");
  assert.equal(classifyFailure(detail), "value-mismatch");
});

test("classifyFailure C2: a GENUINE toBeVisible timeout stays locator (not value-mismatch)", () => {
  // toBeVisible is a PRESENCE matcher: its `Expected: visible / Received: <not found>` pair AND its
  // Timeout trailer must NOT be read as a value mismatch. It stays a locator/timeout fault (unchanged).
  const detail = [
    "Error: expect(locator).toBeVisible() failed",
    "",
    "Locator:  getByRole('columnheader', { name: 'Name' })",
    "Expected: visible",
    "Received: <element(s) not found>",
    "Timeout:  5000ms",
    "Call log:",
    "  - waiting for getByRole('columnheader', { name: 'Name' })",
  ].join("\n");
  assert.equal(classifyFailure(detail), "locator");
});

// W3: a toBeVisible PRESENCE failure whose call-log/echo INCIDENTALLY contains a `.toHaveText(` (or
// `.toHaveCount(`) token must NOT be misclassified value-mismatch by the whole-string value-matcher
// test — otherwise a present-but-hidden element can push a run to "all value-mismatch" → a spurious
// real-bug Issue. The presence matcher wins; it stays locator/timeout.
test("classifyFailure W3: toBeVisible timeout with an incidental .toHaveText( echo stays locator/timeout", () => {
  const detail = [
    "Error: expect(locator).toBeVisible() failed",
    "",
    "Locator:  getByRole('row', { name: 'Bob' })",
    "Expected: visible",
    "Received: <element(s) not found>",
    "Timeout:  5000ms",
    "Call log:",
    "  - waiting for getByRole('row', { name: 'Bob' })",
    "  - note: a sibling step used expect(locator).toHaveText('Bob') earlier", // incidental value token
  ].join("\n");
  const cls = classifyFailure(detail);
  assert.notEqual(cls, "value-mismatch", "a presence failure must not flip to value-mismatch on an echoed value token");
  assert.ok(cls === "locator" || cls === "timeout", `expected locator/timeout, got ${cls}`);
});

// W3 (real-bug guard): such a presence failure must keep isLikelyRealBug FALSE even with unique
// selectors — it is a hidden/absent element, not an app value defect.
test("isLikelyRealBug W3: a toBeVisible failure with an incidental .toHaveText( echo is NOT a real bug", () => {
  const details = [
    "Error: expect(locator).toBeVisible() failed\nLocator: getByRole('row')\nReceived: <element(s) not found>\nTimeout: 5000ms\n  - earlier: expect(locator).toHaveText('x')",
  ];
  assert.equal(isLikelyRealBug(true, details), false);
});

test("classifyFailure C2: a toBeAttached timeout with no value pair stays timeout/locator", () => {
  // No Expected/Received value pair, just a presence-matcher timeout → must NOT be value-mismatch.
  const detail = [
    "Error: expect(locator).toBeAttached() failed",
    "",
    "Locator:  getByRole('button', { name: 'Save' })",
    "Timeout:  5000ms",
  ].join("\n");
  const cls = classifyFailure(detail);
  assert.ok(cls === "locator" || cls === "timeout", `expected locator/timeout for a toBeAttached timeout, got ${cls}`);
  assert.notEqual(cls, "value-mismatch");
});

test("classifyFailure C2: toHaveAttribute / toHaveClass / toHaveValue are value-mismatch", () => {
  assert.equal(classifyFailure("Error: expect(locator).toHaveAttribute(expected) failed\nLocator: getByRole('link')\nTimeout: 5000ms"), "value-mismatch");
  assert.equal(classifyFailure("Error: expect(locator).toHaveClass(expected) failed\nExpected: \"active\"\nReceived: \"\""), "value-mismatch");
  assert.equal(classifyFailure("Error: expect(locator).toHaveValue(expected) failed\nLocator: getByLabel('Email')\nTimeout: 5000ms"), "value-mismatch");
});

// ── bestRound ──────────────────────────────────────────────────────────────

test("bestRound: selects round with fewest failures", () => {
  const r1 = { failingCount: 5, marker: "r1" };
  const r2 = { failingCount: 3, marker: "r2" };
  const r3 = { failingCount: 7, marker: "r3" };
  const best = bestRound([r1, r2, r3]);
  assert.equal(best?.marker, "r2");
});

test("bestRound: returns last when tied (prefer the later round)", () => {
  const r1 = { failingCount: 3, marker: "r1" };
  const r2 = { failingCount: 3, marker: "r2" };
  const best = bestRound([r1, r2]);
  // Tied: the reduce uses <=, so the last one with the same count wins.
  assert.equal(best?.marker, "r2");
});

test("bestRound: returns undefined for empty list", () => {
  assert.equal(bestRound([]), undefined);
});

test("bestRound: single round is always best", () => {
  const r = { failingCount: 10, marker: "r" };
  assert.deepEqual(bestRound([r]), r);
});

// ── isLikelyRealBug ────────────────────────────────────────────────────────

test("isLikelyRealBug: true when all selectors unique + all value-mismatch failures", () => {
  const details = [
    "expect(received).toBe(expected)\nExpected: 'Alice'\nReceived: 'Bob'",
    "Expected value to equal 42",
  ];
  assert.equal(isLikelyRealBug(true, details), true);
});

test("isLikelyRealBug: false when selectors are NOT all unique", () => {
  const details = ["expect(received).toEqual(expected)"];
  assert.equal(isLikelyRealBug(false, details), false);
});

test("isLikelyRealBug: false when any failure is a timeout (not a real app bug)", () => {
  const details = [
    "expect(received).toBe(expected)",
    "Timeout 30000ms exceeded", // one timeout → not a real bug
  ];
  assert.equal(isLikelyRealBug(true, details), false);
});

test("isLikelyRealBug: false when any failure is a locator error", () => {
  const details = [
    "expect(received).toBe(expected)",
    "strict mode violation", // one locator error
  ];
  assert.equal(isLikelyRealBug(true, details), false);
});

test("isLikelyRealBug: false when failureDetails is empty", () => {
  assert.equal(isLikelyRealBug(true, []), false);
});

// C2 cross-check: the real-bug branch (isLikelyRealBug) must now FIRE for the assertion-defect class
// it targets — real toHaveText/toHaveURL messages with the echoed Locator + Timeout trailer. Before
// C2 these classified as locator/timeout and isLikelyRealBug returned false even with unique selectors.
test("isLikelyRealBug C2: real toHaveText/toHaveURL assertion failures (with echoes) count as value-mismatch", () => {
  const details = [
    "Error: expect(locator).toHaveText(expected) failed\n\nLocator:  getByRole('heading')\nExpected string: \"Find Owners\"\nReceived string: \"Owners\"\nTimeout:  5000ms",
    "Error: expect(page).toHaveURL(expected) failed\n\nExpected string: \"/owners/5\"\nReceived string: \"/owners\"\nTimeout:  5000ms",
  ];
  assert.equal(isLikelyRealBug(true, details), true);
});

// ── regression guard integration: bestRound used when regression detected ──

test("regression scenario: bestRound selects round 1 when round 2 is worse", () => {
  // Simulate: round1 = 3 failures, round2 = 5 failures (regression)
  const round1Result = { failingCount: 3, round: 1 };
  const round2Result = { failingCount: 5, round: 2 };
  const prev = roundN(3, ["a", "b", "c"]);
  const cur = roundN(5, ["a", "b", "c", "d", "e"]);
  const decision = decideProgress(prev, cur);
  assert.equal(decision.spend, false);
  // The caller should keep bestRound([round1Result, round2Result])
  const kept = bestRound([round1Result, round2Result]);
  assert.equal(kept?.round, 1);
});
