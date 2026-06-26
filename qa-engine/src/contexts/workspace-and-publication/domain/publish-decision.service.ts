// src/contexts/workspace-and-publication/domain/publish-decision.service.ts
// The pure decide step (CLAUDE.md §9): given the verdict + reviewer approval + coverage-block +
// shadow + whether e2e/ changed, decide the outcome. No I/O — the adapters act on the outcome.
// Shadow mode replaces every side effect with a log line, so it short-circuits to "shadow".
import type { RunVerdict } from "@kernel/run-verdict.ts";

export type PublishOutcome = "pr" | "issue" | "shadow" | "quarantine" | "noop";
export interface PublishContext {
  verdict: RunVerdict;
  reviewerApproved: boolean;
  coverageBlocks: boolean;
  shadow: boolean;
  e2eChanged: boolean;
}
export interface PublishDecision { outcome: PublishOutcome; reason: string; }

export class PublishDecisionService {
  decide(ctx: PublishContext): PublishDecision {
    if (ctx.shadow) return { outcome: "shadow", reason: "shadow mode — side effects replaced with logs" };
    switch (ctx.verdict) {
      case "pass":
        if (!ctx.reviewerApproved) return { outcome: "issue", reason: "green but reviewer rejected" };
        if (ctx.coverageBlocks) return { outcome: "issue", reason: "green but change-coverage enforce-blocks the PR" };
        if (!ctx.e2eChanged) return { outcome: "noop", reason: "green with no e2e/ changes — nothing to publish" };
        return { outcome: "pr", reason: "green, approved, covered — open PR with auto-merge" };
      case "flaky":
        return { outcome: "quarantine", reason: "flaky — quarantine, no PR" };
      case "infra-error":
        return { outcome: "noop", reason: "infra-error — DEV down, not a code bug; no side effect" };
      case "skipped":
        return { outcome: "noop", reason: "skipped — no work to publish" };
      case "fail":
      case "invalid":
      default:
        return { outcome: "issue", reason: `${ctx.verdict} — open an Issue` };
    }
  }
}
