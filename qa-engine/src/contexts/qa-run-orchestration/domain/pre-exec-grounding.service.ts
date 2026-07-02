// qa-engine/src/contexts/qa-run-orchestration/domain/pre-exec-grounding.service.ts
// Plan 7-R B5.2 — the pre-execution grounding gate as a domain service: closes parity-allowlist
// entry cb712ccb69d2959b ("RunQaUseCase has no pre-exec ambiguity gate — Slice E port-gap") and
// fixes two audit leaks as declared changes (leaks 3 + 6).
//
// PORT (verbatim composition) of legacy's closures at src/pipeline.ts:1943-2007 —
// capturePreExecSnaps / ambiguityContradictionsFrom / ambiguousSelectorsNow / catalogCorrectionsFrom
// — reassembled as ONE pure function over an already-captured input, since domain/ never imports
// another context (RunQaUseCase, which already imports generation for its GenerationPort bridge,
// owns capturing the live DOM and adapting it into RouteTree[] before calling this service).
//
// INPUT SHAPE: RouteTree is a domain-local, MINIMAL mirror of generation/infrastructure's
// RouteSnapshot/RouteCatalog fields this service actually needs (route, nodes, status, settled,
// testIds) — not imported (hexagonal boundary: qa-run-orchestration/domain must not depend on
// generation/infrastructure). Structurally compatible: any real RouteSnapshot/RouteCatalog value
// the use-case builds via generation's captureRouteTrees + buildRouteCatalog satisfies this shape.
//
// TWO composed sub-gates, sharing the SAME captured routes (one browser launch upstream, no
// snapshot divergence — mirrors legacy's single capturePreExecSnaps call feeding both derivations):
//
//   1. AMBIGUITY check (canonical unscopedMultipleContradictions, B0/B5.1) — strict-mode
//      MULTIPLE-node contradictions, PAIRED PER SPEC to only the routes that spec itself targets
//      (DECLARED FIX, leak 6b — see pairRoutesForSpec below). Feeds BOTH the one-shot repair
//      (corrections[]) and, on a PERSISTING re-check by the caller, the deterministic W2 block.
//
//   2. CATALOG gate (Pillar 2, B1's catalogGate composed here with the confident-window/test-id
//      extractors) — a test-id ABSENT from a captured&&settled route's catalog, inside the
//      confident window, is a fabricated selector. Feeds ONLY the one-shot repair — NEVER the
//      deterministic block (SAFE DIRECTION, load-bearing: a catalog correction can weaken a proxy,
//      never turn a valid spec invalid; only a PERSISTING ambiguity may escalate to a block).
//
// Pure — no browser, no I/O, no pipeline deps. Every export is a standalone function.

import {
  unscopedMultipleContradictions,
  confidentWindowEnd,
  extractTestIdSelectorsWithIndex,
  firstGotoRoute,
} from "./helpers/selector-check.ts";

// Domain-local mirror of generation/infrastructure's RouteSnapshot ∩ RouteCatalog — only the fields
// this service reads. `nodes` mirrors RouteSnapshot.nodes (the "role: name" a11y tree, used by the
// ambiguity check). `status`/`settled`/`testIds` mirror RouteCatalog (the Pillar-2 catalog gate's own
// confidence fields) — all optional, defaulting to the SAME conservative posture buildRouteCatalog
// applies to a degraded/uncaptured route: status "degraded" (untrusted), settled false, testIds
// empty — so a caller that only ever captures `nodes` (ambiguity-only, no catalog work) never needs
// to fabricate catalog fields, and the gate correctly stays advisory-only for it.
export interface RouteTree {
  route: string;
  nodes: string[];
  status?: "captured" | "degraded";
  settled?: boolean;
  testIds?: Map<string, number>;
}

export interface PreExecGroundingInput {
  specSources: string[];
  routes: RouteTree[];
}

export interface PreExecGroundingResult {
  // Corrections for the ONE-SHOT corrective regen channel (ambiguity + catalog, combined — mirrors
  // legacy's `[...preExecAmbiguities, ...preExecCatalogCorrections]`). NEVER a block signal by
  // itself; the caller decides whether/when a re-check escalates to the deterministic W2 block.
  corrections: string[];
  // The ambiguity sub-gate's own contradiction count (mirrors legacy's preExecAmbiguityCatches).
  // Kept separate from catalogGateFailClosed so the caller's W2 re-check can distinguish "an
  // ambiguity was ever caught" (gates whether a re-check is worth running) from catalog telemetry.
  preExecAmbiguityCatches: number;
  // Pillar-2 catalog-gate honest-coverage telemetry (mirrors legacy's catalogGateInWindow/
  // catalogGateAdvisory/catalogGateFailClosed accumulators, src/pipeline.ts:1928-2002).
  catalogGateInWindow: number;
  catalogGateAdvisory: number;
  catalogGateFailClosed: number;
}

// DECLARED FIX (leak 6b, per-spec route pairing): the ambiguity check must stop cross-producting
// ALL specs × ALL captured route trees — a selector is MULTIPLE only within a tree of a route THAT
// SPEC ITSELF TARGETS, never a coincidentally-similar tree from an unrelated spec's route. Pairs via
// the routes a spec's OWN `.goto(...)` calls name (mirrors legacy's catalogCorrectionsFrom pairing,
// src/pipeline.ts:1989-1992, generalized from "first route only" to "every route this spec visits" —
// a flow can goto() more than one route across its steps, and each one is real ground truth for
// THAT spec). A spec with no literal, navigable goto() at all (e.g. it reuses a fixture/POM
// navigation helper the regex can't see) cannot be paired to a specific route — rather than silently
// dropping it from grounding (a false negative that could hide a real ambiguity), it falls back to
// the FULL captured route set, the same "check everything" posture legacy's un-paired cross-product
// gave every spec. This is the ONLY direction this fix can move risk: NARROWING an over-broad
// cross-product for a pairable spec, never WIDENING beyond what an un-pairable spec already got.
function routesForSpec(specSrc: string, routes: readonly RouteTree[]): RouteTree[] {
  const targeted = extractGotoRoutes(specSrc);
  if (targeted.size === 0) return [...routes]; // un-pairable → advisory-safe fallback: check everything
  const paired = routes.filter((r) => targeted.has(r.route));
  // A spec named routes that were never captured (e.g. capture failed/degraded and was dropped
  // upstream) — fall back to the full set rather than silently grounding against nothing, same
  // fail-safe posture as the "no literal goto" branch above.
  return paired.length > 0 ? paired : [...routes];
}

// Every literal route a spec's `.goto(...)` calls name, normalized with a leading slash — the
// per-spec pairing key. A sibling of firstGotoRoute (selector-check.ts), widened from "first only" to
// "every literal goto" because a spec's flow can legitimately visit more than one route and each is
// real ground truth for ITS OWN ambiguity check (unlike the single-route catalog-gate confident
// window, which is deliberately first-goto-only — see firstGotoRoute's own header). Un-navigable
// routes (interpolated `${…}` or an absolute URL) are skipped, same as firstGotoRoute.
function extractGotoRoutes(specSrc: string): Set<string> {
  const out = new Set<string>();
  const re = /\.goto\(\s*["'`]([^"'`]+)["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(specSrc)) !== null) {
    const raw = m[1]!.trim();
    if (!raw || raw.includes("${") || /^https?:\/\//i.test(raw)) continue;
    out.add(raw.startsWith("/") ? raw : `/${raw}`);
  }
  return out;
}

// The ambiguity sub-gate: strict-mode MULTIPLE contradictions, PER SPEC, paired only to the routes
// that spec targets (leak 6b fix, above). Mirrors legacy's ambiguityContradictionsFrom, generalized
// from "all specs against the full route set" to per-spec pairing.
function ambiguityContradictions(specSources: readonly string[], routes: readonly RouteTree[]): string[] {
  const all: string[] = [];
  for (const specSrc of specSources) {
    const paired = routesForSpec(specSrc, routes);
    const trees = paired.map((r) => r.nodes).filter((n) => n.length > 0);
    all.push(...unscopedMultipleContradictions([specSrc], trees, "pre-write"));
  }
  return [...new Set(all)];
}

// The catalog sub-gate (Pillar 2, B1): for each spec, gate its test-id selectors against the
// captured catalog of its FIRST LITERAL goto route (the confident-window route — consistent with
// confidentWindowEnd, which is itself scoped to the first-goto window, never a later route in the
// flow). Mirrors legacy's catalogCorrectionsFrom (src/pipeline.ts:1981-2007) verbatim in structure;
// the actual gate arithmetic (confident window + absence check) is inlined here rather than
// importing generation/infrastructure's catalogGate (hexagonal boundary — domain/ composes ONLY
// canonical domain helpers, never another context's infrastructure).
function catalogCorrections(
  specSources: readonly string[],
  routes: readonly RouteTree[],
): { corrections: string[]; inWindow: number; advisory: number } {
  // Skip the per-spec work entirely when no spec emits a real (non-comment) getByTestId — mirrors
  // legacy's own early-out (src/pipeline.ts:1983).
  if (!specSources.some((s) => extractTestIdSelectorsWithIndex(s).length > 0)) {
    return { corrections: [], inWindow: 0, advisory: 0 };
  }
  const byRoute = new Map(routes.map((r) => [r.route, r]));
  const corrections: string[] = [];
  let inWindow = 0;
  let advisory = 0;
  for (const specSrc of specSources) {
    const firstRoute = firstGotoRoute(specSrc); // the FIRST LITERAL goto — consistent with confidentWindowEnd
    if (firstRoute === undefined) continue; // un-navigable / no first goto → no window route → advisory
    const windowRoute = byRoute.get(firstRoute);
    if (windowRoute === undefined) continue; // route not captured → advisory
    // SAFE DIRECTION: the fail-closed path may trust ONLY a captured && settled route — an unknown
    // (degraded, or unsettled) defaults to advisory, never a false block (mirrors catalog-gate.ts's
    // own `trusted = status === "captured" && settled`).
    const trusted = (windowRoute.status ?? "degraded") === "captured" && windowRoute.settled === true;
    const windowEnd = confidentWindowEnd(specSrc);
    const testIds = windowRoute.testIds ?? new Map<string, number>();
    for (const { value, index } of extractTestIdSelectorsWithIndex(specSrc)) {
      if (trusted && index < windowEnd) {
        inWindow++;
        if (!testIds.has(value)) {
          corrections.push(
            `getByTestId('${value}') is NOT in the captured DOM of route '${firstRoute}' — this test-id does not exist on the page. Use only a test-id present in the grounded DOM snapshot, or a role/label selector; never invent a test-id.`,
          );
        }
      } else {
        advisory++;
      }
    }
  }
  return { corrections, inWindow, advisory };
}

// The full one-shot pre-execution grounding check: composes the ambiguity sub-gate (leak 6b's
// per-spec pairing) and the catalog sub-gate (Pillar 2) over the SAME captured routes, and returns
// their COMBINED corrections for the one-shot corrective regen — mirrors legacy's
// `[...preExecAmbiguities, ...preExecCatalogCorrections]` (src/pipeline.ts:2179). The caller
// (RunQaUseCase) is responsible for: (a) capturing routes via a port before the first call: (b)
// feeding `corrections` into ONE corrective regen; (c) re-invoking this service (or just the
// ambiguity half — see ambiguityOnly below) against the re-captured, possibly-rewritten specs to
// decide whether a PERSISTING ambiguity should escalate to the deterministic W2 block (this
// function itself never blocks anything — it only measures).
export function checkPreExecGrounding(input: PreExecGroundingInput): PreExecGroundingResult {
  const { specSources, routes } = input;
  const ambiguities = ambiguityContradictions(specSources, routes);
  const catalog = catalogCorrections(specSources, routes);
  return {
    corrections: [...ambiguities, ...catalog.corrections],
    preExecAmbiguityCatches: ambiguities.length,
    catalogGateInWindow: catalog.inWindow,
    catalogGateAdvisory: catalog.advisory,
    catalogGateFailClosed: catalog.corrections.length,
  };
}

// The W2 re-check: ambiguity contradictions ONLY (never the catalog gate — SAFE DIRECTION, load-
// bearing: a catalog correction can only feed the one-shot repair, NEVER the deterministic block).
// Mirrors legacy's ambiguousSelectorsNow (src/pipeline.ts:1968-1971), which re-derives from a FRESH
// capture of the (possibly-rewritten) on-disk specs after the one-shot corrective regen — the
// caller is responsible for that fresh capture; this function just re-runs the pure ambiguity half
// with leak 6b's per-spec pairing, over whatever routes the caller passes.
export function checkPersistingAmbiguity(input: PreExecGroundingInput): string[] {
  return ambiguityContradictions(input.specSources, input.routes);
}
