// qa-engine/src/contexts/workspace-and-publication/domain/render-publication.ts
// sdd/migration-remediation Slice 4 (D-P1a, publication rendering + tested metadata).
//
// Renders the GitHub markdown for a run: the Issue body for a failing/invalid/flaky run and the PR
// body for a green publish. The goal is REVIEWER-FACING DOCUMENTATION — a concise, high-level
// account of what was tested, what was found, and what to do — NOT a log dump. Ported from
// src/report/reporter.ts's renderIssue/renderPrBody: the RENDERING VALUE (headline, capped
// failing-cases with a one-line cause each, flaky-quarantine, "What was tested"/"Covers:",
// validation statement, continuation provenance), not a line-by-line copy — this file's own
// verdict/case/tested-item shapes are qa-engine's shared-kernel types, and two sections legacy's
// reporter.ts never had are KEPT here because THIS rewritten engine already earned them before this
// slice (WS3.1 engine-adjudication; Follow-up #28 reviewer-unavailable) — see
// renderAdjudicationSection/renderReviewerNoteSection below. Fixes the regression this slice exists
// for: publication-port.adapter.ts's OLD renderBody() embedded `sanitize(logs)` VERBATIM — a raw
// execution-log dump reaching a public Issue body, which this render never does (raw logs are never
// even an input here — see RenderIssueInput's own doc).
//
// PURE, no sanitizer dependency: every field here is markdown-composed from caller-supplied,
// already-untrusted text. The CALLER (publication-port.adapter.ts) sanitizes the WHOLE composed body
// string returned by renderIssue/renderPrBody before it ever reaches GitHub — a single whole-body
// sanitize pass satisfies "every rendered field passes the injected sanitizer" (the spec's own MUST)
// without threading a sanitize callback through every render helper in this file, and keeps this
// domain file testable with zero collaborators (matches this context's OWN write-confinement.service.ts
// precedent: pure classifiers, effectful wiring lives one layer out).
import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { QaCase } from "@kernel/qa-case.ts";

// A unit of "what was tested": a user flow and its acceptance criterion, as the agent authored them
// in its per-spec metadata. Narrowed from qa-case.ts's fuller SpecMeta (file/targets/sha256 stay
// internal to generation's own manifest reconciliation) — the SAME port-boundary-projection
// discipline qa-run-orchestration's own ports/index.ts documents for RetrievedRule.
export interface TestedItem {
  flow?: string;
  objective?: string;
}

// Flat adjudication label rendered into the Issue body so a human sees WHY the fix-loop stopped
// (app_defect vs. break-needs-human) — WS3.1, a section legacy's reporter.ts never had.
export interface AdjudicationLabel {
  class: string;
  confidence: string;
  reason: string;
}

const MAX_ITEMS = 50; // cap a flood of cases/flows; the rest are summarized as a count
const CAP_NAME = 200;
const CAP_CAUSE = 200; // a failing case's cause is ONE line, not the whole stack
const CAP_FLOW = 120;
const CAP_OBJECTIVE = 300; // an objective is a one-line acceptance criterion

const cap = (v: string, max: number): string =>
  v.length <= max ? v : v.slice(0, max).trimEnd() + ` …(+${v.length - max} chars)`;

// Collapse a multi-line, often-technical detail into a single high-level cause line: prefer the
// line that names the error/assertion, fall back to the first line. Ported verbatim from
// src/report/reporter.ts's oneLineCause.
function oneLineCause(detail: string): string {
  const lines = detail.split("\n").map((l) => l.trim()).filter(Boolean);
  const pick = lines.find((l) => /error|expect|timeout|fail|assert|not found|exceeded/i.test(l)) ?? lines[0] ?? "";
  return cap(pick, CAP_CAUSE);
}

function renderTestedItem(t: TestedItem): string {
  const flow = t.flow ? cap(t.flow, CAP_FLOW) : "";
  const obj = t.objective ? cap(t.objective, CAP_OBJECTIVE) : "";
  if (flow && obj) return `- **${flow}** — ${obj}`;
  if (flow) return `- **${flow}**`;
  if (obj) return `- ${obj}`;
  return "";
}

function renderFailedCase(c: QaCase): string {
  const lines = [`- **${cap(c.name, CAP_NAME)}**${c.detail ? ` — ${oneLineCause(c.detail)}` : ""}`];
  if (c.objective) lines.push(`  - tested: ${cap(c.objective, CAP_OBJECTIVE)}`);
  if (c.reason) lines.push(`  - fix: ${cap(c.reason, CAP_OBJECTIVE)}`);
  return lines.join("\n");
}

function headline(verdict: RunVerdict, failedCount: number, totalCount: number, flakyCount: number): string {
  switch (verdict) {
    case "fail":
      return totalCount
        ? `${failedCount} of ${totalCount} check(s) failed against the live environment`
        : "the tests failed against the live environment";
    case "invalid":
      return "the generated tests could not be validated (static gate)";
    case "flaky":
      return `${flakyCount} test(s) were unstable and were quarantined`;
    default:
      // verdict "pass": used by the reviewer-rejection and change-coverage-gate paths, where the
      // harness was green but the tests still must not land as-is.
      return "the generated tests need changes before they can land";
  }
}

// WS3.1 (adjudication -> Issue body, ported from publication-port.adapter.ts's own
// renderAdjudicationSection — that adapter no longer renders directly, it calls this instead). A
// low-confidence verdict is worded as an engine GUESS (a hint), not a firm diagnosis, since a
// low-confidence verdict is the adjudicator's own "ambiguous, stopping for human review" branch.
function renderAdjudicationSection(a: AdjudicationLabel): string {
  const heading = a.confidence === "low"
    ? "Engine adjudication (low confidence — treat as a hint)"
    : "Engine adjudication";
  return [heading, `- Class: ${a.class}`, `- Confidence: ${a.confidence}`, `- Reason: ${a.reason}`].join("\n");
}

// Follow-up #28 (reviewer-outage observability hardening, ported from publication-port.adapter.ts's
// own renderReviewerNoteSection). Threaded ONLY for the reviewer-unavailable fail-closed exit, never
// a genuine reviewer rejection (corrections are already that signal) — the caller's own contract.
function renderReviewerNoteSection(note: string): string {
  return ["Reviewer unavailable", note].join("\n");
}

// Deliberately carries NO raw logs field — the spec's own MUST ("neither MUST embed raw/full
// execution logs") is enforced structurally here: there is nothing in this shape to embed even by
// mistake. The full trace/logs live in the run artifacts (see the static footer below).
export interface RenderIssueInput {
  verdict: RunVerdict;
  cases: readonly QaCase[];
  sha?: string;
  tested?: TestedItem[];
  adjudication?: AdjudicationLabel;
  reviewerNote?: string;
}

export function renderIssue(input: RenderIssueInput): string {
  const failed = input.cases.filter((c) => c.status === "fail");
  const flaky = input.cases.filter((c) => c.status === "flaky");
  const shownFailed = failed.slice(0, MAX_ITEMS);
  const omittedFailed = failed.length - shownFailed.length;

  // Blocks are joined with a blank line, so each renders as its own markdown section.
  const blocks: string[] = [`## QA — ${headline(input.verdict, failed.length, input.cases.length, flaky.length)}`];

  blocks.push(input.sha ? `**SHA:** \`${input.sha}\` · **Verdict:** ${input.verdict}` : `**Verdict:** ${input.verdict}`);

  const tested = (input.tested ?? []).filter((t) => t.flow || t.objective).slice(0, MAX_ITEMS);
  if (tested.length) {
    blocks.push(`### What was tested\n${tested.map(renderTestedItem).filter(Boolean).join("\n")}`);
  }

  if (shownFailed.length) {
    const omitted = omittedFailed > 0 ? `\n\n_…and ${omittedFailed} more failed case(s) omitted._` : "";
    blocks.push(`### Failing cases\n${shownFailed.map(renderFailedCase).join("\n")}${omitted}`);
  }

  if (flaky.length) {
    blocks.push(`### Flaky (quarantined)\n${flaky.slice(0, MAX_ITEMS).map((c) => `- ⚠️ ${cap(c.name, CAP_NAME)}`).join("\n")}`);
  }

  // WS3.1 + Follow-up #28: both kept from the pre-Slice-4 adapter, unchanged trigger condition
  // (present -> render; absent -> omit entirely) — see this file's own header.
  if (input.adjudication) {
    blocks.push(renderAdjudicationSection(input.adjudication));
  }
  if (input.reviewerNote && input.reviewerNote.trim()) {
    blocks.push(renderReviewerNoteSection(input.reviewerNote));
  }

  const head = blocks.join("\n\n");
  // The full trace/logs live in the run artifacts — the Issue stays human-readable, never a dump.
  const footer = "\n\n_Full trace + logs in the run artifacts (trace on-first-retry)._";
  return `${head}${footer}`;
}

// The PR body for a green publish: documents what the new/updated suite covers and how it was
// validated — high-level, no logs. `tested` comes from the agent's own specMetas (see
// GenerationPort.generate()'s own doc, qa-run-orchestration/application/ports/index.ts); absent it,
// a one-line statement still documents the change (spec's own negative scenario).
export interface RenderPrBodyInput {
  sha?: string;
  isCode: boolean;
  tested?: TestedItem[];
  parentRunId?: string;
}

export function renderPrBody(input: RenderPrBodyInput): string {
  const what = input.isCode ? "Source-code tests" : "E2E tests";
  const shaText = input.sha ? ` for \`${input.sha}\`` : "";
  const blocks: string[] = ["## What this PR adds", `${what} generated/updated by panchito${shaText}.`];

  const covered = (input.tested ?? []).filter((t) => t.flow || t.objective).slice(0, MAX_ITEMS);
  if (covered.length) {
    blocks.push(`**Covers:**\n${covered.map(renderTestedItem).filter(Boolean).join("\n")}`);
  }

  blocks.push(
    input.isCode
      ? "**Validation:** the repo's own test suite passed (exit code 0) and the change was approved by the independent reviewer."
      : "**Validation:** harness green (typecheck + lint + stable run against the live DEV) and approved by the independent reviewer.",
  );

  if (input.parentRunId) blocks.push(`> ⛓️ Continuation of ${input.parentRunId}`);

  return blocks.join("\n\n");
}
