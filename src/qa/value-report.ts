// Value reporting — turns the deterministic gate signals a run produced into
// human-readable summaries that answer "what happened, what was the verdict, and what
// real value did this run add?". Two consumers share these pure builders (no I/O, so
// they unit-test in isolation):
//
//   - the pipeline appends `renderValueTag()` to `run.outcome`, which the TUI already
//     renders in its finished-run summary (the value flows to the screen for free), and
//   - the CLI prints `renderRunReport()` after a manual run — otherwise a manual run is
//     silent except for its exit code, which is the operator's main complaint in shadow
//     mode (where there is no PR/Issue artifact to inspect).
//
// The signals themselves are the change-coverage ratio (the value keystone), the value
// oracle's mutant-kill score, and the independent reviewer's verdict + rationale.
//
// Visual language mirrors the Go TUI (client/internal/ui): the same verdict glyphs
// (✓ ✗ ⚠ •), the same semantic colors (pass=green, fail=red, flaky=amber, skipped/infra=dim),
// and "label rule" section headers rather than boxes. Color is OPT-IN (`opts.color`) so the
// pure output stays deterministic for tests and clean when piped; the CLI enables it only on
// an interactive TTY (and honors NO_COLOR).

import type { RunVerdict } from "../types";
import type { ErrorClass } from "./learning/taxonomy";

// The deterministic gate signals a run produced — the raw material for both the compact
// outcome tag and the full CLI report. Mirrors RunOutcome.gateSignals plus the coverage
// policy the run was under (so the report can say signal vs. enforce).
export interface ValueSignals {
  coverageRatio: number | null; // change-coverage ratio 0..1; null when not measured
  coverageMeasured: boolean; // false → bundled deploy / no provider → never shown as a %
  coveragePolicy?: "off" | "signal" | "enforce";
  oraclePolicy?: "off" | "signal"; // the resolved value-oracle policy — so the report can tell
  // "off (enable it)" apart from "enabled but produced no score this run" (e.g. no passing specs).
  valueScore: number | null; // oracle mutant-kill rate 0..1; null when the oracle did not run
  reviewerApproved: boolean | null; // null when review is disabled or was not reached
  reviewerRationale?: string; // the reviewer's one/two-sentence reasoning (approve or reject)
}

const pct = (r: number): string => `${Math.round(r * 100)}%`;

// ── ANSI styling (TUI palette, 256-color) — applied only when `on` is true ──────────────
// Mirrors the Go TUI's semantic colors: pass=green(2), fail=red(1), flaky/warn=amber(3),
// dim/infra=gray(8/244). Kept dependency-free; a no-op when color is off.
const ESC = "\x1b[";
const wrap = (code: string, s: string, on: boolean): string => (on ? `${ESC}${code}m${s}${ESC}0m` : s);
const dim = (s: string, on: boolean): string => wrap("2", s, on);
const bold = (s: string, on: boolean): string => wrap("1", s, on);
const green = (s: string, on: boolean): string => wrap("38;5;42", s, on);
const red = (s: string, on: boolean): string => wrap("38;5;203", s, on);
const amber = (s: string, on: boolean): string => wrap("38;5;215", s, on);
const gray = (s: string, on: boolean): string => wrap("38;5;244", s, on);

// Verdict glyph + colorizer — the SAME glyphs the TUI uses (verdictBadge in live.go).
function verdictStyle(v: RunVerdict): { glyph: string; color: (s: string, on: boolean) => string } {
  switch (v) {
    case "pass":
      return { glyph: "✓", color: green };
    // A `fail` is a real bug FOUND — the engine succeeded and filed an Issue. It is NOT an engine
    // error, so it must read distinctly from the red ✗ used for `invalid` (broken generated tests).
    case "fail":
      return { glyph: "!", color: amber };
    case "invalid":
      return { glyph: "✗", color: red };
    case "skipped":
      return { glyph: "•", color: gray };
    default: // flaky, infra-error
      return { glyph: "⚠", color: amber };
  }
}

// A compact, ` · `-joined suffix for `run.outcome` carrying ONLY the two numeric value
// signals the outcome string does not already convey (coverage %, oracle %). The reviewer
// verdict is intentionally omitted here — several outcome phrases already state it ("Issue
// filed (reviewer rejected …)"), so repeating it would be redundant. Returns "" when there
// is nothing measured to add, so a skip/regression/infra outcome stays clean. Always plain
// text (it is embedded in an event payload and the TUI applies its own styling).
export function renderValueTag(s: ValueSignals): string {
  const parts: string[] = [];
  if (s.coverageMeasured && s.coverageRatio !== null) parts.push(`change-coverage ${pct(s.coverageRatio)}`);
  if (s.valueScore !== null) parts.push(`value ${pct(s.valueScore)}`);
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

// The plain-English action the pipeline took (or, in shadow mode, WOULD take) for a verdict.
// Deterministic from the verdict + reviewer approval — it mirrors pipeline.ts's decision
// branches so the CLI can frame the report without depending on the (URL-bearing) outcome
// string, which is not carried on the persisted run record.
export function deriveAction(verdict: RunVerdict, reviewerApproved: boolean | null): string {
  switch (verdict) {
    case "pass":
      return reviewerApproved === false
        ? "file an Issue (the reviewer rejected the suite)"
        : "open an auto-merge suite PR with the new tests";
    case "fail":
      return "file an Issue — a real bug was found (the run succeeded)";
    case "invalid":
      return "file an Issue (the generated specs failed the static gate)";
    case "flaky":
      return "quarantine the flaky case (no PR, no Issue)";
    case "infra-error":
      return "treat the run as inconclusive (infrastructure, not a code bug)";
    case "skipped":
      return "skip the commit (no test-worthy change)";
    default:
      return "do nothing";
  }
}

export interface RunReportInput {
  app: string;
  sha: string;
  mode: string;
  target: string;
  shadow: boolean;
  verdict: RunVerdict;
  passed: number;
  failed: number;
  specCount: number;
  specNames?: string[];
  note?: string;
  signals: ValueSignals;
  errorClass: ErrorClass | null;
}

export interface ReportOptions {
  color?: boolean; // ANSI styling — the CLI sets this from isTTY && !NO_COLOR; default off (tests/pipes)
  width?: number; // total width of the rule lines; default 64
}

const verdictGloss: Record<RunVerdict, string> = {
  pass: "green and stable",
  fail: "a real bug was found (engine succeeded → Issue)",
  flaky: "a case only passed on retry (quarantined)",
  invalid: "specs failed the static gate (never executed)",
  "infra-error": "inconclusive — infrastructure fault, not a code bug",
  skipped: "no test-worthy change",
};

// The multi-line block the CLI prints after a manual run. Answers the three questions an
// operator has at the end of a run — especially in shadow mode, where there is no PR/Issue
// to look at: what happened, what the verdict was, and what value the run actually added.
export function renderRunReport(i: RunReportInput, opts: ReportOptions = {}): string {
  const on = opts.color ?? false;
  const width = Math.max(40, opts.width ?? 64);
  const L: string[] = [];

  // A "label rule": `── title ──────────…──  right` — the TUI's section-header motif.
  const rule = (title: string, right = ""): string => {
    const left = `── ${title} `;
    const tail = right ? `  ${dim(right, on)}` : "";
    const fill = Math.max(0, width - left.length - (right ? right.length + 2 : 0));
    return dim(left + "─".repeat(fill), on) + tail;
  };
  // An indented "label  value" row; the label is padded to a fixed column then dimmed (ANSI
  // is zero-width, so padding stays aligned).
  const row = (label: string, value: string): void => {
    L.push("  " + dim(label.padEnd(12), on) + value);
  };

  // Header + verdict line (glyph + colored, bold verdict; dim gloss).
  const vs = verdictStyle(i.verdict);
  L.push(rule("run value report", `${i.app} @ ${i.sha.slice(0, 9)}`));
  const badge = vs.color(`${vs.glyph} ${i.verdict.toUpperCase()}`, on);
  const counts = `${i.passed} passed · ${i.failed} failed`;
  const shadowTag = i.shadow ? "  " + amber("SHADOW", on) + dim(" (preview — no PR/Issue)", on) : "";
  L.push(`  ${bold(badge, on)}   ${dim(verdictGloss[i.verdict] + " · " + counts, on)}${shadowTag}`);

  // What it produced + the action it took / would take.
  if (i.specCount > 0) {
    const names = i.specNames && i.specNames.length > 0 ? dim(" · ", on) + i.specNames.join(", ") : "";
    row("produced", `${i.specCount} ${i.specCount === 1 ? "spec" : "specs"}${names}`);
  } else {
    row("produced", dim("no new specs", on));
  }
  const action = deriveAction(i.verdict, i.signals.reviewerApproved);
  row("action", i.shadow ? `would ${action}` : action);

  // Value signals section.
  L.push(rule("value"));
  const s = i.signals;

  if (s.coverageMeasured && s.coverageRatio !== null) {
    const paint = s.coverageRatio >= 0.7 ? green : amber;
    row("change-cov", `${paint(pct(s.coverageRatio), on)}  ${dim(`${s.coveragePolicy ?? "signal"} · measured against the diff`, on)}`);
  } else {
    row("change-cov", dim("not measured (unknown — never blocks; enable DEV source maps / JaCoCo to activate)", on));
  }

  if (s.valueScore !== null) {
    const paint = s.valueScore >= 0.5 ? green : amber;
    row("oracle", `${paint(pct(s.valueScore), on)} ${dim("mutant-kill (the tests caught injected faults)", on)}`);
  } else if ((s.oraclePolicy ?? "off") === "off") {
    // Genuinely disabled (explicit off, or shadow's default-off) — tell the operator how to enable it.
    row("oracle", dim("off (set valueOracle: signal to earn ground-truth)", on));
  } else {
    // Enabled but produced no score THIS run — not "off". Most often: no baseline-passing specs to
    // score (e.g. an infra-error/zero-spec run), or the app's flows exposed no JSON to fault-inject.
    row("oracle", dim("enabled · no ground-truth this run (no passing specs to score, or not applicable)", on));
  }

  if (s.reviewerApproved === true) {
    row("reviewer", green("approved", on) + (s.reviewerRationale ? dim(" · ", on) + s.reviewerRationale : ""));
  } else if (s.reviewerApproved === false) {
    row("reviewer", red("rejected", on) + (s.reviewerRationale ? dim(" · ", on) + s.reviewerRationale : ""));
  } else {
    row("reviewer", dim("not run (review disabled)", on));
  }

  if (i.errorClass) row("errorClass", amber(i.errorClass, on));
  if (i.note) row("note", dim(i.note, on));

  return L.join("\n");
}
