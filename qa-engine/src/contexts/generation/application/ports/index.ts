// qa-engine/src/contexts/generation/application/ports/index.ts
// Generation ports: AgentRuntimePort is consumed FROM the kernel (decouples generation from
// agent-runtime; §5.2). PromptRenderingPort [SWAP] renders domain prompt objects to provider strings;
// DomGroundingPort [SWAP] is e2e-only and degraded to a NullDomGroundingAdapter for code-mode (the
// use-case ALWAYS receives a port, never undefined — absence handled at the adapter, not in branching).
// PromptBudgetPort is the GENERATION-side capDiff/capText concern (separate from kernel RedactionPort).
// Seam-2 canonical input types live in generation-ports.ts (OpencodeRunInput/ReviewInput/ParallelWorkerInput).

import type { Objective } from "@kernel/objective.ts";
import type { QaCase, SpecMeta } from "@kernel/qa-case.ts";

export interface ManifestEntry { id: string; file: string; flow: string; objective: string; }
export interface ManifestRepositoryPort {
  read(specDir: string): Promise<ManifestEntry[]>;
  reconcile(specDir: string, entries: readonly ManifestEntry[]): Promise<ManifestEntry[]>;
}

// Free-form LLM text → structured deliverable/judgment. Fail-closed on an unparseable verdict.
// parsed is FALSE only on a parse miss (no verdict JSON emitted), NOT a deliberate no-op — the Phase-B
// use-case branches on !parsed (opencode-client.ts:748) to distinguish a parse miss from a real rejection
// (the #1 fail-closed invariant). specMetas carries the agent's per-spec metadata that drives the
// deterministic, disk-reconciled manifest upsert ("disk over the agent's word", opencode-client.ts:764).
// Both are carried from the legacy parseVerdict so the wrap drops no behavior.
export interface GeneratorDeliverable { specs: string[]; note?: string; parsed?: boolean; specMetas?: SpecMeta[]; }
// ReviewJudgment is the authoritative publish gate. blockingCount distinguishes blocking corrections
// (must regenerate) from advisory ones (may approve); parsed is FALSE only on a parse miss (no verdict
// JSON), NOT a real rejection — the caller uses it to re-prompt once instead of burning a fix round.
// valid + issues are the BOUNDED-REPAIR signal: valid is FALSE when the reviewer JSON failed the typed
// contract (schema miss, not a real rejection) and issues carries the schema problems — the use-case
// (B.3) fires ONE repairInstruction("reviewer", issues) re-prompt before giving up (opencode-client.ts:979-983).
// All four are carried from the legacy ReviewerVerdict so the wrap drops no behavior.
export interface ReviewJudgment {
  approved: boolean;
  corrections: string[];
  rationale?: string;
  blockingCount?: number;
  parsed?: boolean;
  valid?: boolean;     // reviewer JSON satisfied the typed contract (FALSE => one bounded repair, not rejection)
  issues?: string[];   // schema problems, fed verbatim to repairInstruction("reviewer", issues)
}
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

export interface PlanObjectiveView { flow: string; objective: string; reason?: string; }
export interface PlanParserPort { parse(text: string): PlanObjectiveView[]; }
