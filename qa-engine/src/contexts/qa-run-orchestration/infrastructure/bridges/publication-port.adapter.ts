// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/publication-port.adapter.ts
// Bridge: PublicationPort -> the REAL routing + side-effect collaborators. THIN — no new routing
// policy: the injected `decide` collaborator (a REAL PublishDecisionService, wired by the
// composition root — see the security-boundary note below) OWNS the verdict/reviewerApproved/
// coverageBlocks/shadow/e2eChanged -> PublishOutcome mapping VERBATIM; this bridge only dispatches
// the resulting outcome to the matching REAL adapter — one publish(decision) call routes to PR /
// Issue / shadow-log per the decision's own outcome, collapsing the legacy's E2e/Code/Context/Subset
// publish fan-out into a single seam, per the plan's own framing.
//
// SECURITY BOUNDARY (§8 R4 / CLAUDE.md "the agent is read-only... only the deterministic
// orchestrator does git writes" — arch-lint enforced): qa-engine's own
// `no-vcs-write-in-agent-contexts` dependency-cruiser rule denies EVERY contexts/* path other than
// workspace-and-publication from importing ANYTHING under workspace-and-publication (type-only
// included, tsPreCompilationDeps:true) — qa-run-orchestration is NOT exempt. An earlier revision of
// this file imported PublishDecisionService/GitHubPrAdapter/GitHubIssueAdapter/ShadowLogAdapter
// directly and TRIPPED the gate (qa-engine/test/arch/vcs-write-confinement.test.ts). Fixed by
// depending ONLY on LOCAL structural interfaces (duck-typed to the exact methods called) — the SAME
// pattern every other port/bridge in this barrel already uses for its own collaborators. The
// composition root (Task E.1/E.2 — "the ONLY module that imports concrete adapters... it sits
// outside generation/agent-runtime", per the plan's own header) is where the REAL
// PublishDecisionService/GitHubPrAdapter/GitHubIssueAdapter/ShadowLogAdapter instances are
// constructed and passed in; TypeScript's structural typing means they satisfy these local
// interfaces with ZERO import edge into workspace-and-publication from this file.
import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { PublicationPort } from "../../application/ports/index.ts";

// Local structural mirror of workspace-and-publication's PublishContext/PublishDecision
// (domain/publish-decision.service.ts) — duck-typed, NOT imported, per the security-boundary note.
export interface PublishDecisionCollaborator {
  decide(ctx: {
    verdict: RunVerdict;
    reviewerApproved: boolean;
    coverageBlocks: boolean;
    shadow: boolean;
    e2eChanged: boolean;
  }): { outcome: "pr" | "issue" | "shadow" | "quarantine" | "noop"; reason: string };
}
// Local structural mirrors of GitHubPrPort / GitHubIssuePort / ShadowPublicationPort's own publish
// surface (workspace-and-publication/application/ports/index.ts) — duck-typed, NOT imported.
export interface GitHubPrCollaborator {
  openWithAutoMerge(repo: string, branch: string, title: string, body: string): Promise<{ url: string; number: number }>;
}
export interface GitHubIssueCollaborator {
  open(repo: string, title: string, body: string): Promise<{ url: string; number: number }>;
}
export interface ShadowLogCollaborator {
  openPr(repo: string, branch: string, title: string, body: string): Promise<void>;
}

export interface PublicationPortCollaborators {
  decide: PublishDecisionCollaborator;
  pr: GitHubPrCollaborator;
  issue: GitHubIssueCollaborator;
  shadowLog: ShadowLogCollaborator;
  // F4 (audit fix, judgment-day): CLAUDE.md "Sanitize data leaving the system — execution logs ->
  // Issue... pass through src/orchestrator/sanitizer.ts". OPTIONAL — absent defaults to identity
  // (backward-compat for every pre-existing test/composition that never wired one). The composition
  // root (src/server/rewritten-engine-factory.ts, which already imports src/) wires the REAL
  // sanitizeText here; qa-engine/src stays src/-free — the sanitizer is injected, never imported.
  sanitize?: (text: string) => string;
}

export interface PublicationPortStaticContext {
  repo: string;
  branch: string;
  reviewerApproved: boolean;
  coverageBlocks: boolean;
  shadow: boolean;
  e2eChanged: boolean;
}

// FIX 5 (judgment-day W3, theoretical): sanitize is applied for symmetry with renderBody below.
// `verdict` is a closed RunVerdict enum (never free-text today), so this is not exploitable yet —
// but interpolating it unsanitized while every other rendered field IS sanitized is a foot-gun the
// moment RunVerdict's closed-ness changes; cheap to close now.
function renderTitle(verdict: RunVerdict, sanitize: (text: string) => string): string {
  return `qa-bot: ${sanitize(verdict)} run`;
}
function renderBody(cases: readonly QaCase[], logs: string, sanitize: (text: string) => string): string {
  const failing = cases
    .filter((c) => c.status === "fail")
    .map((c) => `- ${sanitize(c.name)}: ${c.detail ? sanitize(c.detail) : ""}`);
  return [sanitize(logs), ...(failing.length > 0 ? ["", "Failing cases:", ...failing] : [])].join("\n");
}

export class PublicationPortAdapter implements PublicationPort {
  constructor(
    private readonly deps: PublicationPortCollaborators,
    private readonly ctx: PublicationPortStaticContext,
  ) {}

  async publish(decision: {
    verdict: RunVerdict;
    cases: readonly QaCase[];
    logs: string;
    reviewerApproved?: boolean;
    coverageBlocks?: boolean;
    e2eChanged?: boolean;
    // F3 (CRITICAL, cross-repo Issue routing): mirrors legacy's `issueRepo = triggerService ?
    // triggerService.repo : app.repo` (src/pipeline.ts:1021) — a deploy-event run triggered by a
    // service repo must file its Issue in the TRIGGERING repo, never the primary. OPTIONAL: absent
    // (every ordinary monorepo run) falls back to ctx.repo, exactly like every other dynamic field
    // on this port (the established backward-compat precedent above). PR creation ALWAYS uses
    // ctx.repo — the suite PR targets the primary repo regardless of which repo triggered the run.
    issueRepo?: string;
  }): Promise<{ outcome: string }> {
    // Audit fix (judgment-day): prefer the REAL per-run decision value when the caller supplies
    // one; fall back to the static composition-time ctx only when absent (backward-compat for
    // pre-existing callers that only ever passed {verdict, cases, logs} — see the port's own doc).
    const publishDecision = this.deps.decide.decide({
      verdict: decision.verdict,
      reviewerApproved: decision.reviewerApproved ?? this.ctx.reviewerApproved,
      coverageBlocks: decision.coverageBlocks ?? this.ctx.coverageBlocks,
      shadow: this.ctx.shadow,
      e2eChanged: decision.e2eChanged ?? this.ctx.e2eChanged,
    });

    // F4 (CRITICAL security invariant): identity when no sanitizer was wired (backward-compat) —
    // the REAL sanitizeText is injected by the composition root (src/server/rewritten-engine-factory.ts).
    const sanitize = this.deps.sanitize ?? ((text: string) => text);
    const title = renderTitle(decision.verdict, sanitize);
    const body = renderBody(decision.cases, decision.logs, sanitize);
    // F3: Issue creation routes to the triggering repo when supplied; PR creation always targets
    // ctx.repo (the primary repo) — never the trigger repo.
    const issueRepo = decision.issueRepo ?? this.ctx.repo;

    switch (publishDecision.outcome) {
      case "shadow": {
        await this.deps.shadowLog.openPr(this.ctx.repo, this.ctx.branch, title, body);
        return { outcome: `shadow: ${publishDecision.reason}` };
      }
      case "pr": {
        const pr = await this.deps.pr.openWithAutoMerge(this.ctx.repo, this.ctx.branch, title, body);
        return { outcome: `pr: ${pr.url}` };
      }
      case "issue": {
        const issue = await this.deps.issue.open(issueRepo, title, body);
        return { outcome: `issue: ${issue.url}` };
      }
      case "quarantine":
        return { outcome: `quarantine: ${publishDecision.reason}` };
      case "noop":
      default:
        return { outcome: `noop: ${publishDecision.reason}` };
    }
  }
}
