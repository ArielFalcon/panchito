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
//
// W2 fix (F3, reviewer-corrections regeneration loop): review()'s new optional trailing
// `enrichment` (ReviewEnrichment, ports/index.ts) maps priorCorrections onto ReviewInput.
// priorCorrections verbatim (mirrors legacy's `previousRoundCorrections` threading, src/
// pipeline.ts:1682) and intent onto ReviewInput.objective the SAME way the legacy derives the
// reviewer's objective when no manual guidance exists (`opts.guidance ?? intent?.message`,
// src/pipeline.ts:1682) — guidance still wins when both are present.
import type { QaCase } from "@kernel/qa-case.ts";
import type { ReviewPort, ReviewEnrichment } from "../../application/ports/index.ts";
import type { AgentRuntimePort } from "@kernel/ports/agent-runtime.port.ts";
import type { PromptRenderingPort, VerdictParserPort } from "@contexts/generation/application/ports/index.ts";
import type { ReviewInput } from "@contexts/generation/application/ports/generation-ports.ts";
import type { RunMode, TestTarget } from "@kernel/run-mode.ts";
import { renderLearnedRulesForReviewer } from "./generation-port.adapter.ts";

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
  // WS2.4 (full-flow remediation, code-mode restoration): ReviewInput.target?: TestTarget already
  // existed on the type and buildReviewerPromptAssembled ALREADY read it (`input.target === "code"
  // ? "tests" : "E2E tests"`, prompts.ts) — this adapter simply never populated the field, so every
  // code-mode review rendered "E2E tests" framing regardless of target. Optional: absent defaults to
  // undefined -> renderReviewer's own "E2E tests" default (unchanged e2e behavior, backward
  // compatible with every pre-existing caller/test that omits it).
  target?: TestTarget;
  // WS6.1 (full-flow remediation, timeouts & operational observability): the reviewer's OWN prompt
  // deadline (composition supplies REVIEWER_TIMEOUT_MS — src/integrations/opencode-client.ts, a
  // purpose-built 6min budget) so a hung reviewer session times out on ITS OWN ceiling instead of
  // silently inheriting the dispatcher's ~25.5min worst-case (the bug this field closes: the adapter
  // previously passed NO timeoutMs into openSession at all). Optional: absent -> openSession opts
  // omit timeoutMs entirely, unchanged behavior for every pre-existing caller/test.
  timeoutMs?: number;
}

export class ReviewPortAdapter implements ReviewPort {
  constructor(
    private readonly deps: ReviewPortRuntime,
    private readonly ctx: ReviewPortStaticContext,
  ) {}

  async review(specDir: string, cases: readonly QaCase[], diff?: string, enrichment?: ReviewEnrichment): Promise<{
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
      // WS2.4 (full-flow remediation, code-mode restoration): threads target so
      // buildReviewerPromptAssembled renders the correct framing ("tests" for code, "E2E tests" for
      // e2e — prompts.ts's own `input.target === "code" ? "tests" : "E2E tests"`).
      ...(this.ctx.target ? { target: this.ctx.target } : {}),
      // W2 fix (F3): priorCorrections verbatim; objective falls back to intent.message ONLY when no
      // manual guidance was already set above — mirrors legacy's `opts.guidance ?? intent?.message`
      // (src/pipeline.ts:1682) exactly (guidance wins, intent is the fallback).
      ...(enrichment?.priorCorrections?.length ? { priorCorrections: [...enrichment.priorCorrections] } : {}),
      ...(!this.ctx.guidance && enrichment?.intent?.message ? { objective: enrichment.intent.message } : {}),
      // W3 F2 (cross-run learning retrieval): mirrors legacy's renderRulesForReviewer(retrievedRules)
      // threading (src/pipeline.ts:1679) — the SAME retrieved structured rules the generator's
      // prompt received, rendered here via the reviewer-specific faithful port (active-only, per
      // renderLearnedRulesForReviewer's own header) so the reviewer judges against the SAME earned
      // app-specific rules.
      ...(enrichment?.learnedRules?.length ? { learnedRules: renderLearnedRulesForReviewer(enrichment.learnedRules) } : {}),
      // Plan 7-R W4 (audit CRITICAL): the reviewer's live-DEV-DOM grounding (ReviewDomGroundingPort,
      // run-qa.use-case.ts) — mirrors legacy's reviewGenerated() domSnapshot threading
      // (src/pipeline.ts:1680). Absent -> omitted; the reviewer defers on unverifiable UI facts
      // (today's behavior, unchanged).
      ...(enrichment?.domSnapshot ? { domSnapshot: enrichment.domSnapshot } : {}),
      // W5 fix (seam-parity FIXME): mirrors the SAME runId threading as GenerationPortAdapter — the
      // reviewer session's own SSE descriptor (opencode-client.ts) needs it too.
      ...(enrichment?.runId ? { runId: enrichment.runId } : {}),
    };
    const assembled = rendering.renderReviewer(reviewInput);

    // WS6.1 (full-flow remediation, timeouts & operational observability): the reviewer's own
    // session runs under a LOUD-but-non-fatal boundary — a thrown failure (most commonly a
    // REVIEWER_TIMEOUT_MS expiry, but any openSession/prompt/dispose fault reads the same way) must
    // be surfaced (logged, per "surface integration errors loudly") WITHOUT crashing the whole run:
    // the run's own execution evidence (already computed by this point — Filter C already passed)
    // must still reach a decision. Mapping to the SAME fail-closed shape the parse-miss branch below
    // already returns (`parsed:false` -> `approved:false`, no regeneration round burned) reuses an
    // EXISTING, already-tested posture rather than inventing a new one — run-qa.use-case.ts's review
    // loop treats `parsed === false` as an immediate, non-actionable rejection (see its own header
    // comment), which is exactly "reviewer unavailable, fail closed, go to Issue with what we have".
    try {
      // W5 fix (seam-parity FIXME, runId/onTurn threading): threads descriptor.runId through to the
      // real AgentDeps.open(). WS6.2 correction (full-flow remediation): this descriptor alone was
      // NOT sufficient for SSE registration — the rewritten composition path (rewritten-engine-
      // factory.ts's runtimeAdapter open() closure) was silently DROPPING opts?.descriptor before
      // ever reaching AgentDeps.open, and nothing called registerRunSession on that path either
      // (withSessionRegistration, opencode-client.ts). Both gaps are now closed at the composition
      // seam (createRewrittenEngineFactory wraps getAgentDeps with withSessionRegistration; the
      // runtimeAdapter closure now forwards descriptor) — this adapter's own contribution is simply
      // supplying a correct descriptor.runId, same as GenerateTestsUseCase's reviewer-session
      // descriptor (generate-tests.use-case.ts). defaultAgentDeps' own agent_turns persistence
      // (defaultOnTurn) reads the SAME descriptor.runId independently of the SSE registration fix.
      const session = await runtime.openSession("reviewer", this.ctx.mirrorDir, {
        descriptor: { runId: enrichment?.runId, role: "qa-reviewer" },
        ...(this.ctx.timeoutMs !== undefined ? { timeoutMs: this.ctx.timeoutMs } : {}),
      });
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
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[qa] reviewer session failed (${reason}) — reviewer unavailable, failing closed without burning a regeneration round.`);
      return {
        approved: false,
        corrections: [],
        rationale: `reviewer unavailable: ${reason}`,
        parsed: false,
      };
    }
  }
}
