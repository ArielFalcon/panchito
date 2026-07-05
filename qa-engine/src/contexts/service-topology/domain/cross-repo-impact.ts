// qa-engine/src/contexts/service-topology/domain/cross-repo-impact.ts
//
// Slice C (structural-signals-expansion, design §3.2, ADR-C1): the domain-side source the ports
// barrel's port-local CrossRepoImpact/ImpactedLink/MatchTier mirror (qa-run-orchestration/
// application/ports/index.ts) structurally casts against. Never imported by the barrel — the
// adapter (cross-repo-impact-port.adapter.ts) performs the cast, exactly like ServiceLinksPortAdapter
// does for ServiceLink/ContractDrift (ADR-C6).
import type { ServiceLink, ServiceSymbolRef } from "./index.ts";

// Const-object pattern (typescript skill: single source of truth, runtime values, easier
// refactoring) — never a bare union type.
export const MATCH_TIER = {
  CONTRACT_FILE: "contract-file",
  IMPACTED_SYMBOL: "impacted-symbol",
} as const;
export type MatchTier = (typeof MATCH_TIER)[keyof typeof MATCH_TIER];

/** `tier` asserts a LITERAL union value — never a sanitizer-sentinel string; a closed, code-defined
 *  enum rendered verbatim (prompts.ts still runs the rendered line through its own local s() only
 *  because it interpolates alongside sanitized fields — the tier VALUE itself is never
 *  attacker/agent-controlled). */
export interface ImpactedLink {
  link: ServiceLink;
  tier: MatchTier;
}

/** A PROPER SUBSET of the resolved links (the "narrowing") — v1 has one triggering service, no
 *  multi-repo shard multiplexing needed (ADR-C1 rejects the integration doc's §6.4 `shards[]`
 *  shape as unnecessary complexity for this scope). */
export interface CrossRepoImpact {
  impactedLinks: ImpactedLink[];
  serviceImpacted?: ServiceSymbolRef[]; // tier-3 front expansion, deferred (design C.5) — never populated in v1
}
