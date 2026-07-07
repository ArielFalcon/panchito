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
  // Shadow fidelity (live-monitoring find): the shadow branch previews the UNDERLYING side effect,
  // so an Issue-shaped suppression must log through openIssue, never openPr. Optional so any
  // pre-existing PR-only stub keeps compiling; absent -> the Issue preview is skipped (the
  // outcome string still names the would-be action).
  openIssue?(repo: string, title: string, body: string): Promise<void>;
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
// WS3.1 (adjudication -> Issue body): renders the FixLoop's own last adjudicator verdict — class,
// confidence, reason — through the SAME sanitizer every other rendered field uses. Low confidence is
// worded as an engine GUESS (a hint for the human, not a firm diagnosis) rather than a flat label,
// since a low-confidence verdict is the adjudicator's own "ambiguous, stopping for human review"
// branch (adjudicate.service.ts) — presenting it with the same confidence as a high-confidence
// app_defect/5xx detection would overstate what the engine actually knows.
function renderAdjudicationSection(
  adjudication: { class: string; confidence: string; reason: string },
  sanitize: (text: string) => string,
): string[] {
  const heading = adjudication.confidence === "low"
    ? "Engine adjudication (low confidence — treat as a hint)"
    : "Engine adjudication";
  return [
    "",
    heading,
    `- Class: ${sanitize(adjudication.class)}`,
    `- Confidence: ${sanitize(adjudication.confidence)}`,
    `- Reason: ${sanitize(adjudication.reason)}`,
  ];
}
function renderBody(
  cases: readonly QaCase[],
  logs: string,
  sanitize: (text: string) => string,
  adjudication: { class: string; confidence: string; reason: string } | undefined,
): string {
  const failing = cases
    .filter((c) => c.status === "fail")
    .map((c) => `- ${sanitize(c.name)}: ${c.detail ? sanitize(c.detail) : ""}`);
  return [
    sanitize(logs),
    ...(failing.length > 0 ? ["", "Failing cases:", ...failing] : []),
    ...(adjudication ? renderAdjudicationSection(adjudication, sanitize) : []),
  ].join("\n");
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
    // WS3.1 (adjudication -> Issue body): the FixLoop's own last adjudicator verdict, threaded by the
    // use-case when one exists. OPTIONAL — absent (every pre-existing caller/stub/test) renders no
    // adjudication section at all, same backward-compat precedent as every other dynamic field above.
    adjudication?: { class: string; confidence: string; reason: string };
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
    const body = renderBody(decision.cases, decision.logs, sanitize, decision.adjudication);
    // F3: Issue creation routes to the triggering repo when supplied; PR creation always targets
    // ctx.repo (the primary repo) — never the trigger repo.
    const issueRepo = decision.issueRepo ?? this.ctx.repo;

    switch (publishDecision.outcome) {
      case "shadow": {
        // Shadow fidelity (live-monitoring find): shadow mode's whole purpose is telling the
        // operator what WOULD have happened — so re-decide with shadow:false to learn the
        // UNDERLYING side effect and log the matching would-be action. Previously this branch
        // unconditionally logged "would open PR" even for a fail run whose real action is an
        // Issue (legacy's issueOrShadow logs the Issue side; publishSuite's shadow logs the PR
        // side — two distinct messages, src/pipeline.ts:3131/3218).
        const underlying = this.deps.decide.decide({
          verdict: decision.verdict,
          reviewerApproved: decision.reviewerApproved ?? this.ctx.reviewerApproved,
          coverageBlocks: decision.coverageBlocks ?? this.ctx.coverageBlocks,
          shadow: false,
          e2eChanged: decision.e2eChanged ?? this.ctx.e2eChanged,
        });
        if (underlying.outcome === "pr") {
          await this.deps.shadowLog.openPr(this.ctx.repo, this.ctx.branch, title, body);
        } else if (underlying.outcome === "issue") {
          await this.deps.shadowLog.openIssue?.(issueRepo, title, body);
        }
        // quarantine/noop suppressed side effects have nothing to preview — the reason says it all.
        return { outcome: `shadow: ${publishDecision.reason} (would: ${underlying.outcome})` };
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
