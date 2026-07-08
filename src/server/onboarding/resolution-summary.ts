// Aggregates a resolver result into a human-legible per-edge summary for the wizard result
// screen. One row per (fromRepo -> toRepo, transport) with the count of resolved call-sites —
// the meaningful decomposition of the score's `links`, not the score itself.
import type { ResolveLinksResult } from "@contexts/service-topology/application/ports/index.ts";

export interface BoundaryEdgeSummary {
  fromRepo: string;
  toRepo: string;
  transport: "http" | "event" | "rpc";
  calls: number;
}

export interface ResolutionSummary {
  edges: BoundaryEdgeSummary[];
  unresolved: number;
  external: number;
  /** Count of FE↔BE contract drift entries — frontend calls an endpoint the backend's OpenAPI
   *  does not declare. A contract mismatch worth surfacing, not just a resolution gap. */
  drift: number;
}

export function aggregateResolution(result: ResolveLinksResult): ResolutionSummary {
  const byKey = new Map<string, BoundaryEdgeSummary>();
  for (const link of result.links) {
    const key = `${link.from.repo} ${link.to.repo} ${link.transport}`;
    const existing = byKey.get(key);
    if (existing) existing.calls += 1;
    else byKey.set(key, { fromRepo: link.from.repo, toRepo: link.to.repo, transport: link.transport, calls: 1 });
  }
  return {
    edges: [...byKey.values()],
    unresolved: result.unresolved.length,
    external: result.external.length,
    drift: result.drift.length,
  };
}
