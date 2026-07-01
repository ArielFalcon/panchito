// Pillar 2 — the confidence-aware selector gate (docs/superpowers/selector-grounding-root-cause-and-design.md).
//
// The bounded safety net: for a family the catalog indexes, a selector ABSENT from the captured DOM is
// caught BEFORE execution (a cheap regeneration) instead of by a 30s runtime timeout — but ONLY inside
// the "confident window" where the catalog is trustworthy. Everywhere else the gate is advisory and the
// runtime executor stays the backstop (the design's Round-3 posture: Pillar 2 is a bounded net, Pillars
// 1+3 carry the hard cases). PURE — composes the spec analysis (selector-check) with the captured
// RouteCatalog (route-catalog); no browser, no I/O, fully unit-testable.
//
// This slice gates the test-id family — Fact #2's preferred, previously-unverifiable tier (getByTestId
// was NON_EXTRACTABLE, so a fabricated test-id was caught only by a 30s timeout). Later slices extend
// the SAME window logic to placeholders / id-name once those indices are captured.

import { confidentWindowEnd, extractTestIdSelectorsWithIndex } from "./selector-check";
import type { RouteCatalog } from "./route-catalog";

export interface CatalogGateResult {
  /** Groundable selectors ABSENT from the catalog inside the confident window on a captured&&settled
   *  route → fabricated. The pipeline regenerates once (no 30s timeout). */
  failClosed: string[];
  /** Groundable selectors that fell inside the confident window — the fail-closed denominator for the
   *  design's "honest coverage" fraction: inWindow / (inWindow + advisory). */
  inWindow: number;
  /** Selectors the gate could NOT confidently verify (post-navigation, or an untrusted catalog). Left
   *  to the runtime backstop, never blocked. */
  advisory: number;
}

// Gate a spec's test-id selectors against the catalog of its INITIAL route (windowRoute). A selector is
// fail-closed ONLY when it is (a) inside the confident window — lexically before the first click/tap or
// the second goto, where the initial-route catalog is still the live DOM — AND (b) on a captured&&settled
// route, the only place absence is conclusive. Every other selector is counted advisory and never
// blocked: the gate can weaken a proxy but must never turn a valid spec invalid (safe direction).
export function catalogGate(specSrc: string, windowRoute: RouteCatalog): CatalogGateResult {
  const trusted = windowRoute.status === "captured" && windowRoute.settled;
  const windowEnd = confidentWindowEnd(specSrc);
  const failClosed: string[] = [];
  let inWindow = 0;
  let advisory = 0;
  for (const { value, index } of extractTestIdSelectorsWithIndex(specSrc)) {
    if (trusted && index < windowEnd) {
      inWindow++;
      if (!windowRoute.testIds.has(value)) failClosed.push(value);
    } else {
      advisory++;
    }
  }
  return { failClosed, inWindow, advisory };
}
