// qa-engine/src/contexts/generation/infrastructure/prompt-rendering.adapter.ts
// WRAP of the STABLE src/integrations/prompts.ts builders behind PromptRenderingPort. Every builder is
// injected so the adapter test needs none of them. The adapter forwards the typed input and returns the
// assembled { text, sectionSizes } — sectionSizes flows on so the telemetry funnel (AgentTurnEvent) keeps
// the per-section byte map. Delegates — does NOT reimplement any prompt string.
import type { PromptRenderingPort } from "../application/ports/index.ts";
import type { OpencodeRunInput, ReviewInput, ParallelWorkerInput } from "../application/ports/generation-ports.ts";

export interface PromptBuilders {
  buildWorkerPromptAssembled(w: ParallelWorkerInput): { text: string; sectionSizes: Record<string, number> };
  buildReviewerPromptAssembled(input: ReviewInput): { text: string; sectionSizes: Record<string, number> };
  buildExplorerPrompt(input: OpencodeRunInput): string;
  specFileForFlow(flow: string): string;
  // The remaining stable builders (buildFollowupPrompt, buildContextTask, reviewObjective,
  // renderArchitectureContext, renderReviewSpecs, renderExecutionResult) are added the same way as the
  // generation use-case needs them; each is a thin forward.
}

export class PromptRenderingAdapter implements PromptRenderingPort {
  constructor(private readonly b: PromptBuilders) {}

  renderWorker(w: ParallelWorkerInput): { text: string; sectionSizes: Record<string, number> } {
    return this.b.buildWorkerPromptAssembled(w);
  }

  renderReviewer(input: ReviewInput): { text: string; sectionSizes: Record<string, number> } {
    return this.b.buildReviewerPromptAssembled(input);
  }

  renderExplorer(input: OpencodeRunInput): string {
    return this.b.buildExplorerPrompt(input);
  }

  specFileForFlow(flow: string): string {
    return this.b.specFileForFlow(flow);
  }

  // PromptRenderingPort generic render (section-based assembly) — the base seam from Plan-2.
  // The named methods above are the concrete builder forwards the use-case consumes.
  render(sections: readonly { heading: string; body: string }[]): string {
    return sections.map((s) => `# ${s.heading}\n\n${s.body}`).join("\n\n");
  }
}
