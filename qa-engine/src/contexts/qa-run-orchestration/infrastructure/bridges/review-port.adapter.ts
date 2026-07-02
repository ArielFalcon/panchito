// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/review-port.adapter.ts
// Bridge: ReviewPort -> generation's reviewer sub-flow. THIN — no new policy.
//
// PLAN DRIFT (recorded per Task E.0's instruction to report a missing/drifted sibling entry point):
// the plan describes this bridge as wrapping "the generation reviewer flow", but there is NO
// standalone reviewer-only export under generation/ — grep confirms `renderReviewer` is called
// from exactly ONE call site: INSIDE GenerateTestsUseCase.generate()'s own conditional review
// branch (fired only when input.needsReview is true), never as an independently-invokable unit.
// RunQaUseCase's own phase ordering, however, needs review as a SEPARATE call fired strictly
// AFTER execute() — the use-case's own comment: "Phase: review (ReviewPort)... run.verdict==='pass'
// && cfg.needsReview" — so this bridge cannot simply forward to GenerateTestsUseCase.generate()
// a second time (that would re-run generation, not review).
//
// This bridge composes the SAME THREE generation-owned primitives GenerateTestsUseCase.generate()
// itself composes for its embedded review branch — AgentRuntimePort.openSession(reviewerRole),
// PromptRenderingPort.renderReviewer, VerdictParserPort.parseReview — running an INDEPENDENT
// reviewer session standalone. This is delegation to the SAME sibling-owned collaborators, not a
// reimplementation of decision logic: the fail-closed mapping applied below (parsed:false is a
// parse MISS, not an actionable rejection — never treated as approved) reads the ReviewJudgment
// fields VERBATIM per their own documented contract (generation/application/ports/index.ts's
// ReviewJudgment comment) — the SAME formula GenerateTestsUseCase.generate() applies internally
// (`reviewJudgment.parsed === false ? false : ...`). The #1 fail-closed invariant.
import type { QaCase } from "@kernel/qa-case.ts";
import type { ReviewPort } from "../../application/ports/index.ts";
import type { AgentRuntimePort } from "@kernel/ports/agent-runtime.port.ts";
import type { PromptRenderingPort, VerdictParserPort } from "@contexts/generation/application/ports/index.ts";
import type { ReviewInput } from "@contexts/generation/application/ports/generation-ports.ts";
import type { RunMode } from "@kernel/run-mode.ts";

export interface ReviewPortRuntime {
  runtime: AgentRuntimePort;
  rendering: PromptRenderingPort;
  verdicts: VerdictParserPort;
}

export interface ReviewPortStaticContext {
  diff: string;
  mirrorDir: string;
  e2eRelDir: string;
  appName: string;
  mode: RunMode;
  baseUrl?: string;
  guidance?: string;
}

export class ReviewPortAdapter implements ReviewPort {
  constructor(
    private readonly deps: ReviewPortRuntime,
    private readonly ctx: ReviewPortStaticContext,
  ) {}

  async review(specDir: string, cases: readonly QaCase[], diff?: string): Promise<{
    approved: boolean;
    corrections: string[];
    rationale?: string;
    blockingCount?: number;
    parsed?: boolean;
  }> {
    const { runtime, rendering, verdicts } = this.deps;

    // Specs under review = the case names carried through by ExecutionPort (this port's own
    // scope note: cases are the ONLY per-spec identity the barrel exposes at this seam).
    const specs = cases.map((c) => c.file ?? c.name);

    const reviewInput: ReviewInput = {
      diff: diff ?? this.ctx.diff, // prefer the dynamic per-run diff (Plan 7.6); fall back to static ctx.diff (operator/tests)
      specs,
      mirrorDir: this.ctx.mirrorDir,
      e2eRelDir: this.ctx.e2eRelDir,
      appName: this.ctx.appName,
      mode: this.ctx.mode,
      ...(this.ctx.baseUrl ? { baseUrl: this.ctx.baseUrl } : {}),
      ...(this.ctx.guidance ? { guidance: this.ctx.guidance } : {}),
    };
    const assembled = rendering.renderReviewer(reviewInput);

    const session = await runtime.openSession("reviewer", this.ctx.mirrorDir);
    let output: string;
    try {
      const out = await session.prompt(assembled.text, { sectionSizes: assembled.sectionSizes });
      output = out.output;
    } finally {
      await session.dispose();
    }

    const judgment = verdicts.parseReview(output);

    // Fail-closed gate, verbatim per ReviewJudgment's own documented contract: a parse miss
    // (parsed:false) is NOT an actionable rejection but is ALSO never a free pass — approved MUST
    // read false regardless of what the (unparseable) judgment's own approved field claims.
    const approved = judgment.parsed === false ? false : judgment.approved;

    return {
      approved,
      corrections: judgment.corrections,
      ...(judgment.rationale !== undefined ? { rationale: judgment.rationale } : {}),
      ...(judgment.blockingCount !== undefined ? { blockingCount: judgment.blockingCount } : {}),
      ...(judgment.parsed !== undefined ? { parsed: judgment.parsed } : {}),
    };
  }
}
