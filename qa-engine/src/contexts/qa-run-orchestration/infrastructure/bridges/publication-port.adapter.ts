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
// PROD-BLOCKER fix: the "pr" route previously called GitHubPrAdapter.openWithAutoMerge() directly —
// no branch was ever created/committed/pushed first (VcsWriteAdapter, the only VcsWritePort
// implementation, was never instantiated anywhere in composition-root.ts before this fix). This
// local structural mirror (duck-typed, NOT importing VcsWritePort or workspace-and-publication's
// concrete adapter — same arch-lint confinement pattern as every other collaborator interface
// above) is the git-write step: stage + commit + push the agent's generated tests to `branch`,
// mirroring the legacy contract (src/integrations/publish.ts's publishChanges: checkout -B -> add
// -> commit -> push, with a skip-if-no-changes short-circuit) BEFORE the PR is opened. `changed:
// false` mirrors that same skip-if-no-changes semantic — publish() must not open a PR when there is
// nothing to publish (a CLAUDE.md-documented behavior: "Honor the agent's no-op decision").
export interface VcsPublishCollaborator {
  publish(input: { mirrorDir: string; branch: string; sha: string }): Promise<{ changed: boolean }>;
}

// sdd/migration-remediation Slice 4 (D-P1a, publication rendering + tested metadata): the PURE
// distilled render functions (workspace-and-publication/domain/render-publication.ts's own
// renderIssue/renderPrBody). This bridge cannot import that module directly — the SAME
// no-vcs-write-in-agent-contexts arch-lint gate the header note above documents denies EVERY
// contexts/* path other than workspace-and-publication (and the composition root, its one declared
// exception) from importing anything under workspace-and-publication, type-only included. LOCAL
// structural mirror, duck-typed, NOT imported — the SAME "the composition root wires the REAL
// instance, this file only knows the shape" pattern as PublishDecisionCollaborator/
// GitHubPrCollaborator/GitHubIssueCollaborator/ShadowLogCollaborator/VcsPublishCollaborator above.
// Replaces this file's OWN pre-Slice-4 local renderBody()/renderAdjudicationSection()/
// renderReviewerNoteSection() (deleted) — those had regressed to embedding `sanitize(logs)`
// VERBATIM, a raw execution-log dump reaching a public Issue body (the spec's own MUST this slice
// closes). REQUIRED (not optional, mirroring `decide`'s own required-ness): rendering the body is
// this adapter's whole job on the "pr"/"issue"/"shadow" routes — there is no safe fallback shape.
export interface PublicationRenderCollaborator {
  issue(input: {
    verdict: RunVerdict;
    cases: readonly QaCase[];
    sha?: string;
    tested?: { flow?: string; objective?: string }[];
    adjudication?: { class: string; confidence: string; reason: string };
    reviewerNote?: string;
  }): string;
  prBody(input: {
    sha?: string;
    isCode: boolean;
    tested?: { flow?: string; objective?: string }[];
    parentRunId?: string;
  }): string;
}

export interface PublicationPortCollaborators {
  decide: PublishDecisionCollaborator;
  pr: GitHubPrCollaborator;
  issue: GitHubIssueCollaborator;
  shadowLog: ShadowLogCollaborator;
  // sdd/migration-remediation Slice 4 (D-P1a): see PublicationRenderCollaborator's own doc above.
  render: PublicationRenderCollaborator;
  // WS5.4b (full-flow remediation, fail-closed publication default): CLAUDE.md "Sanitize data
  // leaving the system — execution logs -> Issue... pass through src/orchestrator/sanitizer.ts".
  // REQUIRED (was optional, defaulting to identity) — a default-to-identity sanitizer is a latent
  // fail-open on the system's most public output: a future composition that simply forgets to wire
  // the real sanitizer would silently publish unsanitized Issue/PR bodies with no error anywhere.
  // The constructor now THROWS when this is absent (see PublicationPortAdapter's constructor) so the
  // gap is caught at composition time, not discovered live in a leaked-secret Issue. The composition
  // root (src/server/rewritten-engine-factory.ts, which already imports src/) wires the REAL
  // sanitizeText here; qa-engine/src stays src/-free — the sanitizer is injected, never imported.
  sanitize: (text: string) => string;
  // PROD-BLOCKER fix: OPTIONAL at the type level (unlike sanitize, which the constructor requires
  // unconditionally) but enforced FAIL-CLOSED AT RUNTIME, checked lazily inside the "pr" case
  // (publish()'s own switch) — see that switch case's own comment. Unlike sanitize (applied to every
  // rendered Issue/PR body on every route), vcsWrite is relevant ONLY to the "pr" route; making it
  // required at construction time would force every issue/shadow/noop/quarantine-only test and
  // caller (every OTHER test in this file) to wire a collaborator they never invoke. Absent + "pr"
  // route reached -> publish() throws loudly rather than silently opening a PR against an unpushed
  // branch — the same fail-closed OUTCOME as WS5.4b's sanitize guard, just gated on the route that
  // actually needs it instead of every route.
  vcsWrite?: VcsPublishCollaborator;
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
// sdd/migration-remediation Slice 4 (D-P1a): this file's OWN renderBody()/renderAdjudicationSection()/
// renderReviewerNoteSection() (which embedded `sanitize(logs)` VERBATIM — a raw execution-log dump,
// the exact regression this slice fixes) are REMOVED. The Issue/PR body is now rendered by the
// injected `render` collaborator (PublicationRenderCollaborator above), whose REAL implementation —
// workspace-and-publication/domain/render-publication.ts's renderIssue/renderPrBody — still renders
// the engine-adjudication and reviewer-unavailable sections (WS3.1, Follow-up #28), just one call
// away instead of inlined here. See publish()'s "issue"/"pr"/"shadow" cases below for the call sites.

export class PublicationPortAdapter implements PublicationPort {
  constructor(
    private readonly deps: PublicationPortCollaborators,
    private readonly ctx: PublicationPortStaticContext,
  ) {
    // WS5.4b: fail-closed at construction time — see PublicationPortCollaborators.sanitize's own doc.
    // A runtime object literal can still omit a required TS field (composition roots are not always
    // fully type-checked against every collaborator at the call site, and a `as any`/loose object can
    // slip through) — this explicit guard makes the omission an immediate, loud throw instead of a
    // silent identity pass-through discovered only when a real secret leaks into a public Issue body.
    if (typeof this.deps.sanitize !== "function") {
      throw new Error(
        "PublicationPortAdapter: 'sanitize' is a REQUIRED collaborator (fail-closed publication default, WS5.4b) — " +
          "the composition root must inject the real sanitizeText; refusing to default to identity.",
      );
    }
    // sdd/migration-remediation Slice 4 (D-P1a): the SAME fail-closed posture as sanitize above — a
    // composition that forgets to wire the real render functions must throw loudly at construction
    // time, never silently fall back to a raw-log embed (the regression this slice fixes).
    if (typeof this.deps.render?.issue !== "function" || typeof this.deps.render?.prBody !== "function") {
      throw new Error(
        "PublicationPortAdapter: 'render' is a REQUIRED collaborator (Slice 4, publication rendering) — " +
          "the composition root must inject the real renderIssue/renderPrBody (workspace-and-publication/domain/render-publication.ts); refusing to fall back to a raw-log embed.",
      );
    }
  }

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
    // Follow-up #28 (reviewer-outage observability hardening): the review loop's reviewer-unavailable
    // rationale (ReviewPortAdapter's own fail-closed catch — "reviewer unavailable: <reason>"),
    // threaded by the use-case ONLY for that specific fail-closed exit — never for a genuine reviewer
    // rejection. OPTIONAL, same backward-compat precedent as adjudication above: absent renders no
    // "Reviewer unavailable" section at all.
    reviewerNote?: string;
    // PROD-BLOCKER fix: the REAL per-run mirrorDir (WorkspacePort.prepare()'s own return value) + the
    // run's sha, needed ONLY by the "pr" route's git-write step — see the port's own doc (ports/
    // index.ts) and VcsPublishCollaborator's doc above for the full contract. OPTIONAL, same
    // backward-compat precedent as every other dynamic field on this method.
    mirrorDir?: string;
    sha?: string;
    // sdd/migration-remediation Slice 4 (D-P1a): see PublicationPort.publish()'s own doc
    // (qa-run-orchestration/application/ports/index.ts) for the full contract on all three fields.
    tested?: { flow?: string; objective?: string }[];
    isCode?: boolean;
    parentRunId?: string;
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

    // F4 / WS5.4b (CRITICAL security invariant): sanitize is now a REQUIRED collaborator (the
    // constructor already threw if it were absent) — the REAL sanitizeText is injected by the
    // composition root (src/server/rewritten-engine-factory.ts).
    const sanitize = this.deps.sanitize;
    const title = renderTitle(decision.verdict, sanitize);
    // sdd/migration-remediation Slice 4 (D-P1a): the Issue and PR bodies are now DISTINCT, distilled
    // renders (the spec's own MUST) instead of one shared renderBody() — built lazily per route
    // below (a route that never opens either never pays for rendering it). `decision.logs` is
    // deliberately NEVER read here: render-publication.ts's RenderIssueInput carries no logs field
    // at all, so a raw log dump cannot reach either body even by accident (the regression this slice
    // fixes — the OLD renderBody() embedded `sanitize(logs)` verbatim). Each composed body is
    // sanitized ONCE, as a whole string, satisfying "every rendered field passes the injected
    // sanitizer" without threading sanitize through the pure render functions themselves (see
    // render-publication.ts's own header for the full rationale).
    const issueBody = (): string =>
      sanitize(
        this.deps.render.issue({
          verdict: decision.verdict,
          cases: decision.cases,
          ...(decision.sha ? { sha: decision.sha } : {}),
          ...(decision.tested?.length ? { tested: decision.tested } : {}),
          ...(decision.adjudication ? { adjudication: decision.adjudication } : {}),
          ...(decision.reviewerNote ? { reviewerNote: decision.reviewerNote } : {}),
        }),
      );
    const prBodyText = (): string =>
      sanitize(
        this.deps.render.prBody({
          ...(decision.sha ? { sha: decision.sha } : {}),
          isCode: decision.isCode ?? false,
          ...(decision.tested?.length ? { tested: decision.tested } : {}),
          ...(decision.parentRunId ? { parentRunId: decision.parentRunId } : {}),
        }),
      );
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
          await this.deps.shadowLog.openPr(this.ctx.repo, this.ctx.branch, title, prBodyText());
        } else if (underlying.outcome === "issue") {
          await this.deps.shadowLog.openIssue?.(issueRepo, title, issueBody());
        }
        // quarantine/noop suppressed side effects have nothing to preview — the reason says it all.
        return { outcome: `shadow: ${publishDecision.reason} (would: ${underlying.outcome})` };
      }
      case "pr": {
        // PROD-BLOCKER fix: stage/commit/push the agent's generated tests to this.ctx.branch BEFORE
        // opening the PR — mirroring the legacy contract exactly (src/integrations/publish.ts's
        // publishChanges: checkout -B -> add -> commit -> push -> THEN createPullRequest). Fail-closed
        // (WS5.4b pattern, but scoped to this route — see PublicationPortCollaborators.vcsWrite's own
        // doc for why this is checked here rather than in the constructor): a composition that wires
        // the "pr" route but forgets vcsWrite must throw loudly, never silently call
        // pr.openWithAutoMerge against a branch nothing ever pushed.
        if (!this.deps.vcsWrite) {
          throw new Error(
            "PublicationPortAdapter: 'vcsWrite' is a REQUIRED collaborator for the 'pr' route (PROD-BLOCKER fix — " +
              "the agent's generated tests must be staged/committed/pushed before the PR is opened) — " +
              "the composition root must inject the real git-write collaborator; refusing to open a PR against an unpushed branch.",
          );
        }
        // mirrorDir/sha are per-run dynamic values threaded by the use-case (RunQaUseCase reads them
        // from WorkspacePort.prepare()'s own return value and input.sha) — see the port's own doc for
        // why they are optional at the type level (backward-compat) but required in practice for a
        // real "pr" route to do anything meaningful. An absent mirrorDir/sha here is the SAME class of
        // composition defect as an absent vcsWrite collaborator — fail loudly rather than push to "".
        if (!decision.mirrorDir || !decision.sha) {
          throw new Error(
            "PublicationPortAdapter: the 'pr' route requires decision.mirrorDir and decision.sha (the per-run values " +
              "RunQaUseCase threads from WorkspacePort.prepare()/input.sha) — refusing to stage/commit/push with no mirror to operate on.",
          );
        }
        const written = await this.deps.vcsWrite.publish({
          mirrorDir: decision.mirrorDir,
          branch: this.ctx.branch,
          sha: decision.sha,
        });
        // Skip-if-no-changes (legacy parity, CLAUDE.md "Honor the agent's no-op decision"): nothing
        // to publish -> no PR, ever. Mirrors publishChanges' own `if (!status.trim()) return null`
        // short-circuit exactly — the PublishDecisionService already routed here believing e2eChanged
        // was true, but the REAL git diff is the ground truth this adapter can observe directly.
        if (!written.changed) {
          return { outcome: "noop: vcsWrite reported no changes to publish — the suite already covers the change, no PR opened" };
        }
        const pr = await this.deps.pr.openWithAutoMerge(this.ctx.repo, this.ctx.branch, title, prBodyText());
        return { outcome: `pr: ${pr.url}` };
      }
      case "issue": {
        const issue = await this.deps.issue.open(issueRepo, title, issueBody());
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
