// qa-engine/src/contexts/generation/infrastructure/route-catalog.ts
// PORT (verbatim) of src/qa/route-catalog.ts — Pillar 2, the per-route Selector Catalog
// (docs/superpowers/selector-grounding-root-cause-and-design.md).
//
// The catalog is the single grounding artifact: what the agent transcribes from AND what the
// pre-execution gate verifies emitted selectors against. This module owns the PURE catalog
// construction; the live-DOM capture (dom-snapshot.ts) feeds it the raw per-family material. Building
// it here keeps it deterministic and unit-testable without a browser.
//
// Circular pair with dom-snapshot.ts (route-catalog imports RouteSnapshot FROM dom-snapshot; dom-
// snapshot imports buildRouteCatalog/buildTestIdIndex/degradedRouteWarning FROM route-catalog) — ported
// TOGETHER, co-located in generation/infrastructure/, same as the legacy src/qa/ pair.
//
// Slice 1: the test-id index — the family that was NON_EXTRACTABLE and so only caught by a 30s runtime
// timeout. Slice 2 (this file): buildRouteCatalog (the pure DTO→catalog adapter) + the status/settled
// confidence fields + degradedRouteWarning (loud, never-silent capture failure). Later slices add
// roles/labels/placeholders/texts/idsNames and the dual gate that consumes the catalog.

import type { RouteSnapshot } from "./dom-snapshot.ts";

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

// Runtime-error signature set (conservative, project-agnostic): NG#### (Angular runtime error codes),
// the Angular zone/ErrorHandler "ERROR Error:" console prefix, "Uncaught" (any framework's browser
// prefix), and "Unhandled Promise rejection". A bare "Error:" is deliberately NOT matched (apps
// routinely console.error("Error: …") for handled/logged errors — a false positive there would be the
// wrong direction). Benign transport noise is excluded.
const FRAMEWORK_ERROR_RE = /\bNG\d+\b|ERROR Error:|Uncaught|Unhandled Promise rejection/;
const BENIGN_NOISE_RE = /Failed to load resource|favicon|net::ERR_/i;

/** True when a route's captured runtime signals contain a genuine app-defect signature: ANY
 *  `pageerror` (an uncaught JS exception), or a `console` entry matching FRAMEWORK_ERROR_RE after
 *  excluding benign transport noise.
 *
 *  IMPORTANT (live-probe fix): this is an ADVISORY signal only — it drives the agent-facing
 *  "possibly broken app; verify live" warning in dom-snapshot.ts and mirrors the FixLoop
 *  adjudicator's runtime-error classification. It DELIBERATELY does NOT feed buildRouteCatalog's
 *  degrade decision: a route that rendered a full DOM stays a trustworthy source of selectors even
 *  when the app logged an error (a missing icon, an optional 401, a third-party warning — the norm in
 *  real SPAs). Grounding trust is structural (empty render / capture error / redirect), not
 *  app-health. Conflating the two disabled the selector gate on essentially every production app. */
export function hasRuntimeErrorSignal(errors: readonly { type: string; text: string }[]): boolean {
  for (const e of errors) {
    if (e.type === "pageerror") return true;
    if (BENIGN_NOISE_RE.test(e.text)) continue;
    if (FRAMEWORK_ERROR_RE.test(e.text)) return true;
  }
  return false;
}

/** True when the settled finalUrl's PATHNAME diverges from the requested route's PATHNAME — the
 *  signature of a redirect (e.g. bounced to a login page). The requested route is PARSED against a
 *  dummy base (never compared as a raw string) so its ?query and #hash — including hash-router paths
 *  like "/#!/owners/new", whose URL pathname is "/" — can never count as a path mismatch; comparing
 *  the raw route string against finalUrl.pathname would falsely degrade every hash-routed or
 *  query-carrying route (a false trust-loss — the wrong safe direction). Trailing slashes are
 *  normalized ("/owners" vs "/owners/" is a server normalization, not a redirect away). `route` is a
 *  relative app path (not a full URL) — no baseUrl parameter is threaded through buildRouteCatalog's
 *  signature (kept narrow per the design). A hash-routed redirect (fragment-only change) is therefore
 *  undetectable here by design: an ambiguous signal must default to trust, never to degrade. */
function isRedirect(route: string, finalUrl: string | undefined): boolean {
  if (!finalUrl) return false;
  let finalPath: string;
  let requestedPath: string;
  try {
    finalPath = new URL(finalUrl).pathname;
    requestedPath = new URL(route, "http://q.invalid").pathname;
  } catch {
    return false; // an unparseable URL is not treated as a redirect signal (safe direction)
  }
  const normalize = (p: string): string => {
    const withSlash = p.startsWith("/") ? p : `/${p}`;
    return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
  };
  return normalize(finalPath) !== normalize(requestedPath);
}

/** Pure adapter from the capture DTO (RouteSnapshot) to the gate-facing RouteCatalog. Owns the
 *  confidence policy: a capture `error` ⇒ `degraded` (never trusted); an unconfirmed settle ⇒
 *  `settled:false` (conservative — the fail-closed path may trust ONLY a captured && settled route, so
 *  an unknown must default to advisory, never to a false block). No browser, no I/O — fully testable.
 *
 *  Fix 2 (audit leak 5): a route is ALSO degraded — SAFE DIRECTION, only removes trust, never blocks
 *  (see catalog-gate.ts) — when its captured runtimeErrors classify as an app defect, its nodes[] came
 *  back empty (likely a broken client-side render), or its finalUrl redirected away from the requested
 *  route (e.g. bounced to a login page). These are ADDITIONAL degrade reasons layered on top of the
 *  existing `error` check; none of them change the `error` path's behavior. */
export function buildRouteCatalog(snapshot: RouteSnapshot): RouteCatalog {
  const captureFailed = snapshot.error !== undefined;
  const emptyRender = !captureFailed && (snapshot.nodes?.length ?? 0) === 0;
  const redirected = !captureFailed && isRedirect(snapshot.route, snapshot.finalUrl);
  // Live-probe root cause (transversal): grounding trust is about whether the DOM STRUCTURALLY
  // rendered — captureFailed / emptyRender / redirect — NOT about whether the app logged a runtime
  // error. A route that renders a full DOM but emits a NON-fatal console/pageerror (a missing
  // FontAwesome icon, a 401 on an optional auth probe, a third-party warning — the norm in real
  // SPAs) is still a trustworthy source of REAL selectors. Degrading it here (as an earlier
  // "runtimeErrors ⇒ degraded" rule did) disabled the selector gate on essentially every
  // production app that logs anything, forcing the agent to author ungrounded selectors — the exact
  // quality collapse this gate exists to prevent. Runtime errors are ADJUDICATION evidence, not a
  // grounding-trust signal, and are handled in their proper places, untouched by this change: the
  // formatted DOM snapshot still warns the AGENT "possibly broken app; verify live"
  // (dom-snapshot.ts), and the FixLoop adjudicator still classifies them as app_defect on a FAILING
  // test (adjudicate.service.ts Rule 2.6). Only the miscategorised grounding-catalog degrade is removed.
  const degraded = captureFailed || emptyRender || redirected;
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
