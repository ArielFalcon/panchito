// service-topology/application/ports/index.ts
// The primary domain port for cross-service boundary resolution.
// Fail-open discipline: resolveLinks NEVER throws; any error degrades to an empty result.
// The composite adapter enforces per-resolver isolation and timeout.
import type {
  RepoRef, ServiceLink, ContractDrift, ExternalCall, UnresolvedCall, BoundaryProfile,
} from "../../domain/index.ts";
import type { ProfileScore } from "../profile-scorer.ts";

/** Structured outcome from a single resolver run. */
export interface ResolveLinksResult {
  /** Deterministic cross-repo links: front call-site → backend contract operationId. */
  links: ServiceLink[];
  /** FE↔BE contract drift: front calls an endpoint the contract does NOT declare. */
  drift: ContractDrift[];
  /** Calls to services outside the indexed repo set. */
  external: ExternalCall[];
  /** Call-sites whose path argument cannot be statically resolved. */
  unresolved: UnresolvedCall[];
}

/** Cross-service boundary resolution port. Each adapter is a transport strategy (OpenAPI, gRPC, events). */
export interface ServiceBoundaryResolverPort {
  /**
   * Resolve cross-service links for the given system (backend repos) and frontend repo.
   * NEVER throws: any error degrades to an empty ResolveLinksResult.
   */
  resolveLinks(system: RepoRef[], front: RepoRef): Promise<ResolveLinksResult>;
}

/** Reads and validates an app's declared boundary conventions from config (Invariant #1:
 *  every app-specific pattern comes from config, never a literal in the engine core).
 *  NEVER throws: a missing/malformed config degrades to an empty array (fail-open). */
export interface BoundaryProfileProviderPort {
  forApp(appName: string): Promise<BoundaryProfile[]>;
}

/** Prior candidates + their scores from earlier onboarding rounds, so a proposer can refine its
 *  next guess (a future LLM adapter reads this; the deterministic first-slice stub ignores it). */
export interface ProposerFeedback {
  readonly priorCandidates: ReadonlyArray<{ profile: BoundaryProfile; score: ProfileScore }>;
}

/** Proposes candidate BoundaryProfiles for an app during onboarding (profile-generator tool).
 *  NEVER throws: any error degrades to an empty array (fail-open) — a proposer failure must never
 *  crash the onboarding loop, only cost it a round (mirrors the resolver ports' fail-open discipline). */
export interface ProfileProposerPort {
  propose(system: RepoRef[], front: RepoRef, feedback?: ProposerFeedback): Promise<BoundaryProfile[]>;
}
