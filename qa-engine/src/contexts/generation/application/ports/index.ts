// qa-engine/src/contexts/generation/application/ports/index.ts
// Generation ports: AgentRuntimePort is consumed FROM the kernel (decouples generation from
// agent-runtime; §5.2). PromptRenderingPort [SWAP] renders domain prompt objects to provider strings;
// DomGroundingPort [SWAP] is e2e-only and degraded to a NullDomGroundingAdapter for code-mode (the
// use-case ALWAYS receives a port, never undefined — absence handled at the adapter, not in branching).
// PromptBudgetPort is the GENERATION-side capDiff/capText concern (separate from kernel RedactionPort).
// Seam-2 canonical input types live in generation-ports.ts (OpencodeRunInput/ReviewInput/ParallelWorkerInput).

import type { Objective } from "@kernel/objective.ts";
import type { QaCase, SpecMeta } from "@kernel/qa-case.ts";
// Seam-2 canonical input types and supporting authoring-context types from generation-ports.ts.
// Imported here for use in PromptRenderingPort (GEN-06) and PlanObjectiveView (WRAP-3).
import type { OpencodeRunInput, ReviewInput, ParallelWorkerInput, ExplorationBrief } from "./generation-ports.ts";

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
// valid + issues are REQUIRED (not optional) to match the legacy ReviewerVerdict (verdict-validate.ts:73-75)
// which always populates both — the adapter's LegacyReviewer shape declares them required for the same reason.
export interface ReviewJudgment {
  approved: boolean;
  corrections: string[];
  rationale?: string;
  blockingCount?: number;
  parsed?: boolean;
  valid: boolean;      // reviewer JSON satisfied the typed contract (FALSE => one bounded repair, not rejection)
  issues: string[];    // schema problems, fed verbatim to repairInstruction("reviewer", issues); empty when valid
}
export interface VerdictParserPort {
  parseGenerator(text: string): GeneratorDeliverable;
  parseReview(text: string): ReviewJudgment;
}

export interface PromptSection { heading: string; body: string; }
// PromptRenderingPort exposes both the section-based generic seam (render) AND the concrete builder
// forwards the adapter implements (renderMain/renderWorker/renderReviewer/renderExplorer/specFileForFlow).
// Phase B codes against this port, not the concrete PromptRenderingAdapter, so all methods
// must appear here to avoid forcing Phase B onto the concrete type.
// OpencodeRunInput/ReviewInput/ParallelWorkerInput imported at the top of this file (Seam-2).
export interface PromptRenderingPort {
  render(sections: readonly PromptSection[]): string;
  // Main single-agent generation prompt (wraps buildPromptAssembled). Used by GenerateTestsUseCase
  // for the primary generator session (runOpencode path). The assembled result carries sectionSizes
  // for per-turn telemetry, mirroring the legacy buildPromptAssembled call in runOpencode:724.
  renderMain(input: OpencodeRunInput): { text: string; sectionSizes: Record<string, number> };
  renderWorker(w: ParallelWorkerInput): { text: string; sectionSizes: Record<string, number> };
  renderReviewer(input: ReviewInput): { text: string; sectionSizes: Record<string, number> };
  renderExplorer(input: OpencodeRunInput): string;
  specFileForFlow(flow: string): string;
}

// e2e: real grounding; code-mode: NullDomGroundingAdapter returns an empty context (§3 hard limit).
export interface DomGrounding { aria: string; routes: string[]; }
export interface DomGroundingPort {
  ground(objective: Objective): Promise<DomGrounding>;
}

// capDiff/capText prompt-budget capping — a generation concern, NOT redaction (§5.3(8)).
// budgetForRole resolves the per-role byte budget (model → window → bytes) from the catalog;
// the adapter FORWARDS roleWindowBytes(role) — the port carries no threshold, the catalog owns it.
export interface PromptBudgetPort {
  capDiff(diff: string): string;
  capText(text: string): string;
  budgetForRole(role: string): number;
}

export interface ContextPackResult { objective: Objective; sections: PromptSection[]; failureCases?: QaCase[]; }

// PlanObjectiveView carries the fields the legacy PlanObjective (opencode-client.ts:1022-1027) exposes
// AND that ParallelWorkerInput construction (opencode-client.ts:1438-1443) consumes at fan-out.
// symbols/needsUi/brief were absent from the original view, forcing Phase B to narrow-cast back to
// the legacy type. They are added here so the port is self-sufficient for fan-out.
export interface PlanObjectiveView {
  flow: string;
  objective: string;
  reason?: string;
  symbols: string[];     // code symbols the spec should exercise (serena blast radius)
  needsUi: boolean;      // selects qa-worker (UI) vs qa-worker-code (code-only) at fan-out
  brief?: ExplorationBrief; // distilled blast radius so the worker need not re-explore (optional → back-compat)
}
export interface PlanParserPort { parse(text: string): PlanObjectiveView[]; }
