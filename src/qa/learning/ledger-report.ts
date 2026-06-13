import type { LearningRule, RuleStatus, Confidence } from "./learning-rule";
import { isWellFormedTrigger } from "./distiller";

// Read-only, human-readable rendering of the learning ledger for audit. The ledger is governed
// state owned by the deterministic orchestrator (the agent never writes it), but until now it was
// only inspectable as opaque SQLite rows. This turns it into prose a reviewer can read and veto in
// one pass. Pure (no I/O): the CLI in ledger-report-cli.ts feeds it the rows.

// Plain-language labels for the auto-labeled taxonomy, so the report never leaks internal E-… codes.
// Kept here rather than in taxonomy.ts to keep this an additive reporting module with no coupling
// back into the governance core.
const ERROR_CLASS_LABEL: Record<string, string> = {
  "E-STATIC": "static-gate failure",
  "E-EXEC-FAIL": "execution failure",
  "E-FLAKY": "flaky test",
  "E-COVERAGE-GAP": "change-coverage gap",
  "E-FALSE-POSITIVE": "false positive (asserts nothing real)",
  "E-WRONG-OBJECTIVE": "wrong objective",
  "E-FRAGILE-SELECTOR": "fragile selector",
  "E-NO-CLEANUP": "missing cleanup",
  "E-REVIEWER-REJECTED": "reviewer-rejected",
  "E-VALUE-SURVIVED": "value gap (oracle survived)",
  "E-INFRA": "infrastructure",
};

function classLabel(errorClass: string): string {
  return ERROR_CLASS_LABEL[errorClass] ?? errorClass;
}

// Confidence → provenance, in words. This encodes the ledger's core trust invariant for the reader:
// 'high' is reserved for oracle-proven rules; the weaker prevention proxy tops out at 'medium'.
// A demoted rule (deprecated/superseded — e.g. a human veto leaves confidence stale) must NOT make
// a present-tense trust claim: it reads in the past tense so the report never contradicts its own
// section header ("proven by the oracle" under a DEPRECATED heading).
function provenance(confidence: Confidence, status: RuleStatus): string {
  const demoted = status === "deprecated" || status === "superseded";
  switch (confidence) {
    case "high":
      return demoted ? "was oracle-proven — no longer trusted" : "proven by the oracle (ground-truth)";
    case "medium":
      return demoted ? "was prevention-held — no longer trusted" : "held across runs (prevention signal)";
    case "low":
      return demoted ? "unproven — demoted" : "unproven — still gathering evidence";
  }
}

function evidence(r: LearningRule): string {
  if (r.successRate === null) return "no outcomes yet";
  const pct = Math.round(r.successRate * 100);
  const runs = r.outcomeCount === 1 ? "1 outcome" : `${r.outcomeCount} outcomes`;
  return `${pct}% success over ${runs}`;
}

function renderRule(r: LearningRule): string {
  const flag = isWellFormedTrigger(r.trigger) ? "" : "   ⚠ trigger needs rephrasing";
  return [
    `• ${r.trigger}${flag}`,
    `    → ${r.action}`,
    `    ${provenance(r.confidence, r.status)} · ${evidence(r)} · ${classLabel(r.errorClass)}`,
  ].join("\n");
}

const SECTIONS: { status: RuleStatus; title: string; blurb: string }[] = [
  { status: "active", title: "ACTIVE", blurb: "proven; injected into agent prompts" },
  { status: "candidate", title: "CANDIDATE", blurb: "still earning trust; explored in bounded slots" },
  { status: "deprecated", title: "DEPRECATED", blurb: "demoted; kept for resurrection if outcomes recover" },
  { status: "superseded", title: "SUPERSEDED", blurb: "replaced by a newer rule; terminal" },
];

export function renderLedgerReport(rules: LearningRule[], opts: { app?: string } = {}): string {
  const header = opts.app ? `# Learning ledger — ${opts.app}` : "# Learning ledger";
  if (rules.length === 0) {
    return `${header}\n\nNo learned rules yet.\n`;
  }

  const out: string[] = [header, ""];
  for (const section of SECTIONS) {
    const inSection = rules
      .filter((r) => r.status === section.status)
      // Most-proven first; newest-first among unproven peers so the order is deterministic
      // regardless of input/DB ordering.
      .sort((a, b) => (b.successRate ?? -1) - (a.successRate ?? -1) || b.at.localeCompare(a.at));
    if (inSection.length === 0) continue;
    out.push(`## ${section.title} (${inSection.length}) — ${section.blurb}`, "");
    for (const r of inSection) out.push(renderRule(r), "");
  }

  // Defensive: if RuleStatus ever gains a member SECTIONS doesn't cover, surface those rules
  // instead of silently dropping them from the audit view.
  const known = new Set(SECTIONS.map((s) => s.status));
  const uncategorized = rules.filter((r) => !known.has(r.status));
  if (uncategorized.length > 0) {
    out.push(`## OTHER (${uncategorized.length})`, "");
    for (const r of uncategorized) out.push(renderRule(r), "");
  }

  return out.join("\n").trimEnd() + "\n";
}
