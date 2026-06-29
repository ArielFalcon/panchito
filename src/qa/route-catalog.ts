// Pillar 2 — the per-route Selector Catalog (docs/superpowers/selector-grounding-root-cause-and-design.md).
//
// The catalog is the single grounding artifact: what the agent transcribes from AND what the
// pre-execution gate verifies emitted selectors against. This module owns the PURE catalog
// construction; the live-DOM capture (dom-snapshot.ts) feeds it the raw per-family material. Building
// it here keeps it deterministic and unit-testable without a browser.
//
// Slice 1 (this file): the test-id index — the family that was NON_EXTRACTABLE and so only caught by a
// 30s runtime timeout. Later slices add roles/labels/placeholders/texts/idsNames, the status+settled
// confidence fields, and the dual gate that consumes the catalog.

/** Per-route catalog of the selectors that provably exist in the captured live DOM, one index per
 *  selector family so every family the agent may emit is checkable. `status`/`settled` gate whether
 *  the fail-closed path may trust it (see the design's "confidence window"). */
export interface RouteCatalog {
  route: string;
  status: "captured" | "degraded"; // degraded = capture errored / timed out / auth-blocked
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
