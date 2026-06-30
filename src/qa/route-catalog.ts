// Pillar 2 — the per-route Selector Catalog (docs/superpowers/selector-grounding-root-cause-and-design.md).
//
// The catalog is the single grounding artifact: what the agent transcribes from AND what the
// pre-execution gate verifies emitted selectors against. This module owns the PURE catalog
// construction; the live-DOM capture (dom-snapshot.ts) feeds it the raw per-family material. Building
// it here keeps it deterministic and unit-testable without a browser.
//
// Slice 1: the test-id index — the family that was NON_EXTRACTABLE and so only caught by a 30s runtime
// timeout. Slice 2 (this file): buildRouteCatalog (the pure DTO→catalog adapter) + the status/settled
// confidence fields + degradedRouteWarning (loud, never-silent capture failure). Later slices add
// roles/labels/placeholders/texts/idsNames and the dual gate that consumes the catalog.

import type { RouteSnapshot } from "./dom-snapshot";

/** Single source of truth for the route capture status values. Using a const object ensures runtime
 *  values exist alongside the type, enables autocomplete, and prevents the string-literal / type
 *  divergence hazard of a bare union (TypeScript skill: const-object pattern over direct union). */
export const ROUTE_STATUS = {
  CAPTURED: "captured",
  DEGRADED: "degraded",
} as const;

/** Route capture status: "captured" = render succeeded; "degraded" = errored / timed-out / auth-blocked. */
export type RouteStatus = (typeof ROUTE_STATUS)[keyof typeof ROUTE_STATUS];

/** Per-route catalog of the selectors that provably exist in the captured live DOM, one index per
 *  selector family so every family the agent may emit is checkable. `status`/`settled` gate whether
 *  the fail-closed path may trust it (see the design's "confidence window"). */
export interface RouteCatalog {
  route: string;
  status: RouteStatus; // degraded = capture errored / timed out / auth-blocked
  settled: boolean; // a secondary networkidle settle resolved within budget → catalog is post-hydration
  /** test-id value → occurrence count. Presence answers "does this getByTestId exist?"; count > 1
   *  flags a strict-mode ambiguity that would otherwise surface only at runtime. */
  testIds: Map<string, number>;
}

/** Build the test-id index from the RAW, role-independent capture (every element carrying the
 *  configured testIdAttribute — NOT gated on an ARIA role, so role-less `<div data-cy=x>` count too).
 *  Counts occurrences so presence AND uniqueness are checkable. Blank values are ignored. */
export function buildTestIdIndex(capturedValues: readonly string[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const raw of capturedValues) {
    const value = raw.trim();
    if (!value) continue;
    index.set(value, (index.get(value) ?? 0) + 1);
  }
  return index;
}

/** Pure adapter from the capture DTO (RouteSnapshot) to the gate-facing RouteCatalog. Owns the
 *  confidence policy: a capture `error` ⇒ `degraded` (never trusted); an unconfirmed settle ⇒
 *  `settled:false` (conservative — the fail-closed path may trust ONLY a captured && settled route, so
 *  an unknown must default to advisory, never to a false block). No browser, no I/O — fully testable. */
export function buildRouteCatalog(snapshot: RouteSnapshot): RouteCatalog {
  const degraded = snapshot.error !== undefined;
  return {
    route: snapshot.route,
    status: degraded ? ROUTE_STATUS.DEGRADED : ROUTE_STATUS.CAPTURED,
    settled: !degraded && snapshot.settled === true,
    testIds: degraded ? new Map() : (snapshot.testIds ?? new Map()),
  };
}

/** Loud, single-line warning naming every route whose capture DEGRADED (errored / timed out /
 *  auth-blocked), or undefined when every route captured. This replaces the silent `catch{return []}`
 *  reopen (CLAUDE.md: never swallow a capture failure into an empty result) so a run that grounds
 *  against a partial tree is visible and attributed. Unsettled routes are NOT named here — present-but-
 *  unsettled is expected on SPAs and stays advisory in the catalog, not a per-route console alarm. */
export function degradedRouteWarning(catalogs: readonly RouteCatalog[]): string | undefined {
  const degraded = catalogs.filter((c) => c.status === ROUTE_STATUS.DEGRADED).map((c) => c.route);
  if (degraded.length === 0) return undefined;
  return `[qa] WARNING: DOM capture DEGRADED for ${degraded.length} route(s) [${degraded.join(", ")}] — these routes are NOT grounded; the selector gate treats them as advisory (no fail-closed).`;
}
