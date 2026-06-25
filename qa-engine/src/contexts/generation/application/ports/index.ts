// qa-engine/src/contexts/generation/application/ports/index.ts
// Generation ports: AgentRuntimePort is consumed FROM the kernel (decouples generation from
// agent-runtime; §5.2). PromptRenderingPort [SWAP] renders domain prompt objects to provider strings;
// DomGroundingPort [SWAP] is e2e-only and degraded to a NullDomGroundingAdapter for code-mode (the
// use-case ALWAYS receives a port, never undefined — absence handled at the adapter, not in branching).
// PromptBudgetPort is the GENERATION-side capDiff/capText concern (separate from kernel RedactionPort).
// Seam-2 (OpencodeRunInput/ReviewInput/ParallelWorkerInput cycle break) is DEFERRED to Plan 5.

import type { Objective } from "@kernel/objective.ts";
import type { QaCase } from "@kernel/qa-case.ts";

export interface ManifestEntry { id: string; file: string; flow: string; objective: string; }
export interface ManifestRepositoryPort {
  read(specDir: string): Promise<ManifestEntry[]>;
  reconcile(specDir: string, entries: readonly ManifestEntry[]): Promise<ManifestEntry[]>;
}

// Free-form LLM text → structured deliverable/judgment. Fail-closed on an unparseable verdict.
export interface GeneratorDeliverable { specs: string[]; note?: string; }
export interface ReviewJudgment { approved: boolean; corrections: string[]; rationale?: string; }
export interface VerdictParserPort {
  parseGenerator(text: string): GeneratorDeliverable;
  parseReview(text: string): ReviewJudgment;
}

export interface PromptSection { heading: string; body: string; }
export interface PromptRenderingPort {
  render(sections: readonly PromptSection[]): string;
}

// e2e: real grounding; code-mode: NullDomGroundingAdapter returns an empty context (§3 hard limit).
export interface DomGrounding { aria: string; routes: string[]; }
export interface DomGroundingPort {
  ground(objective: Objective): Promise<DomGrounding>;
}

// capDiff/capText prompt-budget capping — a generation concern, NOT redaction (§5.3(8)).
export interface PromptBudgetPort {
  capDiff(diff: string): string;
  capText(text: string): string;
}

export interface ContextPackResult { objective: Objective; sections: PromptSection[]; failureCases?: QaCase[]; }
