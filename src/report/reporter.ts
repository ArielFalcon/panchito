// Renders the GitHub markdown for a run: the Issue body for a failing/invalid run
// and the PR body for a green publish. The goal is REVIEWER-FACING DOCUMENTATION —
// a concise, high-level account of what was tested, what was found, and what to do —
// NOT a log dump. The narrative is assembled deterministically from what the agent
// already emits (per-spec objective/flow + the reviewer's note/corrections + the commit
// intent + each failing case's one-line cause). Raw run logs are NOT embedded: they are
// noise in a human-facing Issue — the full trace lives in the run artifacts, and the
// structured cause/findings carry the actionable signal.
//
// Everything embedded is re-sanitized defensively: the static-gate "invalid" errors,
// per-case details and the agent's note/objectives are NOT pre-sanitized — and a secret
// the agent embedded in a spec could otherwise reach a public Issue/PR.
//
// github.ts (clampBody) is the final length net under GitHub's 65536-char hard limit.

import { QaRunResult, QaCase } from "../types";
import { sanitizeText } from "../orchestrator/sanitizer";

const s = (v: string | undefined): string => (v ? sanitizeText(v).text : "");

const MAX_ITEMS = 50; // cap a flood of cases/flows; the rest are summarized as a count
const CAP_NAME = 200;
const CAP_CAUSE = 200; // a failing case's cause is ONE line, not the whole stack
const CAP_FLOW = 120;
const CAP_OBJECTIVE = 300; // an objective is a one-line acceptance criterion
const CAP_NOTE_ITEM = 400;
const CAP_MESSAGE = 200;

// A unit of "what was tested": a user flow and its acceptance criterion, as the
// agent authored them in its per-spec metadata.
export interface TestedItem {
  flow?: string;
  objective?: string;
}

// Flat adjudication label threaded into the Issue body so a human can see WHY the
// fix-loop stopped (app_defect vs. break-needs-human). Decoupled from the adjudicator
// module type to avoid a cross-module import dependency in reporter.
export interface AdjudicationLabel {
  class: string;   // AdjudicatorClass value (e.g. "app_defect", "generated_test_defect")
  reason: string;  // human-legible explanation from the adjudicator verdict
}

// Everything the orchestrator hands the renderer beyond the run itself. All optional:
// different failure paths have different context available (a context-map validation
// failure has only a note; a reviewer rejection has the note + what was tested).
export interface IssueContext {
  note?: string; // reviewer corrections / coverage gap / skip reason — the "findings"
  tested?: TestedItem[]; // from the agent's specMetas — the "what was tested"
  intent?: { type: string; message: string; changedFiles?: string[] }; // commit context
  adjudication?: AdjudicationLabel; // adjudicator class + reason — WHY the loop stopped
}

const cap = (v: string, max: number): string =>
  v.length <= max ? v : v.slice(0, max).trimEnd() + ` …(+${v.length - max} chars)`;

// Collapse a multi-line, often-technical detail into a single high-level cause line:
// prefer the line that names the error/assertion, fall back to the first line.
function oneLineCause(detail: string): string {
  const lines = detail.split("\n").map((l) => l.trim()).filter(Boolean);
  const pick = lines.find((l) => /error|expect|timeout|fail|assert|not found|exceeded/i.test(l)) ?? lines[0] ?? "";
  return cap(pick, CAP_CAUSE);
}

function renderTestedItem(t: TestedItem): string {
  const flow = cap(s(t.flow), CAP_FLOW);
  const obj = cap(s(t.objective), CAP_OBJECTIVE);
  if (flow && obj) return `- **${flow}** — ${obj}`;
  if (flow) return `- **${flow}**`;
  if (obj) return `- ${obj}`;
  return "";
}

function renderFailedCase(c: QaCase): string {
  const lines = [`- **${cap(s(c.name), CAP_NAME)}**${c.detail ? ` — ${oneLineCause(s(c.detail))}` : ""}`];
  if (c.objective) lines.push(`  - tested: ${cap(s(c.objective), CAP_OBJECTIVE)}`);
  if (c.reason) lines.push(`  - fix: ${cap(s(c.reason), CAP_OBJECTIVE)}`);
  return lines.join("\n");
}

// The reviewer joins its corrections with "; "; split them back into bullets so the
// findings read as a checklist, not a wall of text.
function renderNote(note: string): string {
  const clean = s(note);
  const items = (clean.includes("; ") ? clean.split("; ") : clean.split("\n"))
    .map((x) => x.trim())
    .filter(Boolean);
  if (items.length > 1) return items.slice(0, MAX_ITEMS).map((i) => `- ${cap(i, CAP_NOTE_ITEM)}`).join("\n");
  return cap(clean, CAP_NOTE_ITEM * 4);
}

function headline(run: QaRunResult, failedCount: number, flakyCount: number): string {
  switch (run.verdict) {
    case "fail": {
      const total = run.cases.length;
      return total
        ? `${failedCount} of ${total} check(s) failed against the live environment`
        : "the tests failed against the live environment";
    }
    case "invalid":
      return "the generated tests could not be validated (static gate)";
    case "flaky":
      return `${flakyCount} test(s) were unstable and were quarantined`;
    default:
      // verdict "pass": used by the reviewer-rejection and change-coverage-gate paths,
      // where the harness was green but the tests still must not land as-is.
      return "the generated tests need changes before they can land";
  }
}

export function renderIssue(run: QaRunResult, ctx: IssueContext = {}): string {
  const failed = run.cases.filter((c) => c.status === "fail");
  const flaky = run.cases.filter((c) => c.status === "flaky");
  const shownFailed = failed.slice(0, MAX_ITEMS);
  const omittedFailed = failed.length - shownFailed.length;

  // Blocks are joined with a blank line, so each renders as its own markdown section.
  const blocks: string[] = [`## QA — ${headline(run, failed.length, flaky.length)}`];

  const meta: string[] = [];
  if (ctx.intent) {
    const n = ctx.intent.changedFiles?.length ?? 0;
    const files = n ? ` (${n} file${n === 1 ? "" : "s"})` : "";
    meta.push(`**Change:** \`${s(ctx.intent.type)}\` — ${cap(s(ctx.intent.message), CAP_MESSAGE)}${files}`);
  }
  meta.push(`**SHA:** \`${s(run.sha)}\` · **Verdict:** ${run.verdict}`);
  if (ctx.adjudication) {
    meta.push(`**Adjudicator:** \`${s(ctx.adjudication.class)}\` — ${s(ctx.adjudication.reason)}`);
  }
  blocks.push(meta.join("\n"));

  const tested = (ctx.tested ?? []).filter((t) => t.flow || t.objective).slice(0, MAX_ITEMS);
  if (tested.length) {
    blocks.push(`### What was tested\n${tested.map(renderTestedItem).filter(Boolean).join("\n")}`);
  }

  if (shownFailed.length) {
    const omitted = omittedFailed > 0 ? `\n\n_…and ${omittedFailed} more failed case(s) omitted._` : "";
    blocks.push(`### Failing cases\n${shownFailed.map(renderFailedCase).join("\n")}${omitted}`);
  }

  if (flaky.length) {
    blocks.push(
      `### Flaky (quarantined)\n${flaky.slice(0, MAX_ITEMS).map((c) => `- ⚠️ ${cap(s(c.name), CAP_NAME)}`).join("\n")}`,
    );
  }

  if (ctx.note && ctx.note.trim()) {
    blocks.push(`### Findings\n${renderNote(ctx.note)}`);
  }

  const head = blocks.join("\n\n");
  // The full trace/logs live in the run artifacts — the Issue stays human-readable.
  const footer = "\n\n_Full trace + logs in the run artifacts (trace on-first-retry)._";

  return `${head}${footer}`;
}

// The PR body for a green publish: documents what the new/updated suite covers and
// how it was validated — high-level, no logs. `tested` comes from the agent's
// specMetas; absent it, a one-line statement still documents the change.
export interface PrBodyInput {
  sha: string;
  isCode: boolean;
  tested?: TestedItem[];
  parentRunId?: string;
}

export function renderPrBody(input: PrBodyInput): string {
  const what = input.isCode ? "Source-code tests" : "E2E tests";
  const blocks: string[] = [
    "## What this PR adds",
    `${what} generated/updated by ai-pipeline for \`${s(input.sha)}\`.`,
  ];

  const covered = (input.tested ?? []).filter((t) => t.flow || t.objective).slice(0, MAX_ITEMS);
  if (covered.length) {
    blocks.push(`**Covers:**\n${covered.map(renderTestedItem).filter(Boolean).join("\n")}`);
  }

  blocks.push(
    input.isCode
      ? "**Validation:** the repo's own test suite passed (exit code 0) and the change was approved by the independent reviewer."
      : "**Validation:** harness green (typecheck + lint + stable run against the live DEV) and approved by the independent reviewer.",
  );

  if (input.parentRunId) blocks.push(`> ⛓️ Continuation of ${s(input.parentRunId)}`);

  return blocks.join("\n\n");
}
