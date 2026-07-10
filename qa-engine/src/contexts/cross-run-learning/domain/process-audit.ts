// qa-engine/src/contexts/cross-run-learning/domain/process-audit.ts
// sdd/migration-remediation Slice 5 (P1 process-audit reconnect, D-P1b): a verbatim PORT of
// src/qa/learning/process-audit.ts's `auditProcess`/`applyAudit` — the deterministic core of "the
// maintainer does what a human reviewer does after each run": detect that the ENGINE (not the
// watched app's tests) misbehaved, and route each finding to the RIGHT remediation. Pure,
// deterministic — no LLM, no IO. Ported, not moved: the oracle file (src/qa/learning/process-audit.ts)
// stays in place; its disposition is governed by the migration's deletion batches/deferred register,
// not this slice.
//
// SCOPE NOTE (documented, not silent): legacy's own pipeline.ts wiring additionally ran an LLM
// root-cause diagnosis (qa-reflector, "Layer 2") for `engine-fix` findings BEFORE calling applyAudit,
// populating `ProcessFinding.diagnosis`. Neither the spec nor the design for this slice mention
// porting that diagnosis step — this port carries the `diagnosis` field structurally (so a future
// caller can populate it) but nothing in this context ever sets it. Deferred, not dropped — see the
// apply-progress artifact for this slice's own deviation record.
//
// THE KEY DESIGN (answers "do all findings become a PR?"): NO. A finding's `disposition` decides
// how it is remediated, and only ENGINE-CODE problems become a human-gated PR:
//   - engine-fix   → the orchestrator's own logic is wrong → record an incident → the qa-maintainer
//                    opens a PR for HUMAN review (self-modifying code is never auto-applied).
//   - ledger-heal  → corrupt/noise LEARNING (a candidate rule that costs cycles without ever
//                    helping) → deprecate it autonomously (reversible, audited — it is regenerable
//                    DATA the system owns, not code, so no PR is warranted).
//   - context-heal → a stale/invalid architecture map (DATA) → flag it for rebuild.
//   - observe      → surfaced for visibility; no mutation.
//
// Why deterministic first: most of the engine bugs found by hand are detectable as plain invariants
// over the run telemetry (a recurring errorClass, review churn that never converges, a candidate
// rule used N times with zero attribution) — no LLM, no cost, no risk. An LLM "diagnose the root
// cause" pass (which then feeds the engine-fix path, see the SCOPE NOTE above) layers on top; this
// module is its safe floor.

import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { ErrorClass } from "@contexts/cross-run-learning/application/ports/index.ts";

export type Disposition = "engine-fix" | "ledger-heal" | "context-heal" | "observe";

export interface ProcessFinding {
  kind: string; // machine label, e.g. "recurring-error-class"
  disposition: Disposition;
  severity: "warn" | "error";
  summary: string; // one human line
  evidence: string; // the concrete signal that fired
  ruleIds?: string[]; // ledger-heal: the rules to deprecate
  diagnosis?: string; // engine-fix: an LLM root-cause hypothesis (Layer 2, NOT wired in this slice — see this file's own SCOPE NOTE)
}

// Recurring UI/grounding error classes whose likely cause is a STALE/WRONG architecture map — the
// agent's FE↔BE understanding is off. The cheap, reversible FIRST response is to rebuild the map
// (context-heal), not to open an engine PR.
const MAP_GROUNDED_CLASSES = new Set<ErrorClass>(["E-WRONG-OBJECTIVE", "E-FRAGILE-SELECTOR"]);

// The ONLY recurring classes that point at a genuine ENGINE-CODE defect the maintainer can fix in a
// PR (e.g. the generated specs repeatedly fail the static gate → a seed/template/validate bug, like
// the cleanup.spec.ts gate bug). A recurring E-EXEC-FAIL is NOT here: a test that keeps failing
// against DEV is an app-behavior / learning gap (the ledger may already hold the rule but the oracle
// has not promoted it) — the maintainer cannot fix that, so it routes to `observe`, not a PR.
const ENGINE_DEFECT_CLASSES = new Set<ErrorClass>(["E-STATIC"]);

// A minimal view of a learning rule — only the fields the audit reasons about. DEVIATION from the
// legacy oracle (documented, not silent): legacy's own RuleView.status union additionally carried
// "pending" for backward-compat with pre-rename legacy rows ("nothing writes it anymore" per that
// file's own comment) — kept here verbatim (not narrowed to cross-run-learning's own RuleStatus)
// because this port reads REAL production rows via the factory-injected `rules` read
// (process-audit-port.adapter.ts), which may still contain old "pending" rows from before this
// context existed. Narrowing here would be a silent behavioral risk (a real row failing to
// structurally satisfy this type), not a simplification.
export interface RuleView {
  id: string;
  errorClass: ErrorClass;
  status: "pending" | "candidate" | "active" | "deprecated" | "superseded";
  usageCount: number;
  successRate: number | null;
}

export interface AuditInput {
  outcome: RunOutcome; // the run that just finished
  recent: RunOutcome[]; // the app's recent outcomes, newest first, INCLUDING this one
  rules: RuleView[]; // the app's current learning rules
}

const RECUR_WINDOW = 3; // same errorClass this many runs in a row ⇒ the engine repeats a mistake
const NOISE_USES = 3; // a candidate used this many times with no attribution is dead weight
const CHURN_RETRIES = 2; // review loop regenerated at least this many times…

// Deterministic, pure. Produces the findings; never mutates anything.
export function auditProcess(input: AuditInput): ProcessFinding[] {
  const findings: ProcessFinding[] = [];
  const o = input.outcome;
  const cls = o.errorClass;

  // 1) recurring-error-class. The same non-null errorClass RECUR_WINDOW runs in a row is not bad
  //    luck — the engine keeps making the same mistake. The DISPOSITION depends on the class: a
  //    recurring UI/grounding error is most cheaply fixed by rebuilding the (likely stale)
  //    architecture map (context-heal, autonomous); any other recurring class is a code defect that
  //    a map rebuild cannot fix → engine-fix (maintainer PR). Aggregated by design — one occurrence
  //    is noise, a streak is the signal.
  // Whether the current errorClass is RECURRING (the same class RECUR_WINDOW runs in a row). Reused
  // by both the recurring-error-class finding and the noise-rule heal (which must only fire when the
  // class a candidate rule targets is the one actually still recurring — see below).
  const recurringCls: ErrorClass | null = (() => {
    if (!cls) return null;
    const streak = input.recent.slice(0, RECUR_WINDOW);
    return streak.length >= RECUR_WINDOW && streak.every((r) => r.errorClass === cls) ? cls : null;
  })();

  if (recurringCls) {
    const shas = input.recent.slice(0, RECUR_WINDOW).map((r) => r.sha.slice(0, 7)).join(", ");
    const evidence = `last ${RECUR_WINDOW} outcomes errorClass=${recurringCls} (sha ${shas})`;
    if (MAP_GROUNDED_CLASSES.has(recurringCls)) {
      // UI/grounding mismatch → rebuild the (likely stale) map first, autonomously. No PR.
      findings.push({
        kind: "recurring-ui-mismatch",
        disposition: "context-heal",
        severity: "warn",
        summary: `${recurringCls} ${RECUR_WINDOW} runs in a row — the architecture map is likely stale; rebuilding it before escalating.`,
        evidence,
      });
    } else if (ENGINE_DEFECT_CLASSES.has(recurringCls)) {
      // A genuine ENGINE-CODE defect (e.g. recurring E-STATIC) → incident → maintainer → human PR.
      findings.push({
        kind: "recurring-error-class",
        disposition: "engine-fix",
        severity: "error",
        summary: `The engine produced ${recurringCls} ${RECUR_WINDOW} runs in a row — a repeating engine defect, not bad luck.`,
        evidence,
      });
    } else {
      // Everything else recurring (e.g. E-EXEC-FAIL: tests keep failing against DEV) is an
      // app-behavior / learning gap, NOT an engine-code bug — the maintainer cannot fix it (the
      // remedy is rule promotion via the oracle). Surface it for visibility; do not open a PR.
      findings.push({
        kind: "recurring-test-failure",
        disposition: "observe",
        severity: "warn",
        summary: `${recurringCls} ${RECUR_WINDOW} runs in a row — a recurring app-behavior/learning gap (not an engine defect); needs rule promotion (oracle), not a code PR.`,
        evidence,
      });
    }
  }

  // 2) noise-rule → ledger-heal. A CANDIDATE rule that has been injected NOISE_USES+ times AND is
  //    meant to prevent the very class that is STILL RECURRING (the rule was injected yet its class
  //    recurred RECUR_WINDOW runs in a row) is demonstrably failing at its job — dead weight (often
  //    distilled from a wrong/refuted reviewer correction). Deprecate it: reversible DATA hygiene, no
  //    PR. The recurring-class gate is the EVIDENCE the rule is ineffective: in shadow/oracle-off mode
  //    `successRate` stays null (UNMEASURED) for genuinely-useful rules too, so an unmeasured candidate
  //    is NEVER deprecated on absence-of-success alone — only when its class is proven to still recur.
  const noisy = recurringCls
    ? input.rules.filter(
        (r) => r.status === "candidate" && r.usageCount >= NOISE_USES && r.errorClass === recurringCls,
      )
    : [];
  if (noisy.length > 0) {
    findings.push({
      kind: "noise-rule",
      disposition: "ledger-heal",
      severity: "warn",
      summary: `${noisy.length} candidate rule(s) used ≥${NOISE_USES}× with zero attribution — deprecating as ledger noise.`,
      evidence: noisy.map((r) => `${r.id}(${r.errorClass}, uses=${r.usageCount})`).join(", "),
      ruleIds: noisy.map((r) => r.id),
    });
  }

  // 3) review-churn-no-gain → observe. The review loop regenerated repeatedly and STILL did not
  //    produce a passing/publishable test — the corrections were not worth their cost. Surfaced for
  //    visibility; the data side is handled by the noise-rule heal above.
  if ((o.gateSignals.retries ?? 0) >= CHURN_RETRIES && o.verdict !== "pass") {
    findings.push({
      kind: "review-churn-no-gain",
      disposition: "observe",
      severity: "warn",
      summary: `${o.gateSignals.retries} regeneration round(s) and the run still ended ${o.verdict} — the review cycles did not pay off.`,
      evidence: `retries=${o.gateSignals.retries}, verdict=${o.verdict}, reviewerApproved=${o.gateSignals.reviewerApproved ?? "n/a"}`,
    });
  }

  return findings;
}

// The ROUTER: applies each finding via its disposition. Injected so it is unit-testable and the
// real side effects (deprecate a rule, record an incident) stay behind a boundary. Returns a record
// of what it did, for the audit log.
export interface AuditRouterDeps {
  log: (line: string) => void;
  deprecateRule: (ruleId: string, reason: string) => void; // ledger-heal: reversible (status → deprecated)
  recordEngineIncident: (finding: ProcessFinding) => void; // engine-fix: → qa-maintainer → human-gated PR
  invalidateContext: (reason: string) => boolean; // context-heal: force a map rebuild; true if it acted
}

export interface AppliedAudit {
  deprecatedRules: string[];
  incidentsRecorded: number;
  contextInvalidated: number;
  observed: number;
}

// Applies each finding via its disposition — the CODE-vs-DATA boundary made concrete. Only
// engine-fix becomes a (human-gated) PR; the DATA dispositions self-heal autonomously and
// reversibly. Returns what it did, for the audit log.
export function applyAudit(findings: ProcessFinding[], deps: AuditRouterDeps): AppliedAudit {
  const applied: AppliedAudit = { deprecatedRules: [], incidentsRecorded: 0, contextInvalidated: 0, observed: 0 };
  for (const f of findings) {
    switch (f.disposition) {
      case "ledger-heal":
        for (const id of f.ruleIds ?? []) {
          deps.deprecateRule(id, `process-audit/${f.kind}: ${f.summary}`);
          applied.deprecatedRules.push(id);
        }
        deps.log(`[audit] ledger-heal (${f.kind}): deprecated ${f.ruleIds?.length ?? 0} rule(s) — ${f.evidence}`);
        break;
      case "engine-fix":
        deps.recordEngineIncident(f);
        applied.incidentsRecorded++;
        deps.log(`[audit] engine-fix (${f.kind}): recorded an incident for the maintainer (human-gated PR) — ${f.summary}`);
        break;
      case "context-heal": {
        const acted = deps.invalidateContext(`process-audit/${f.kind}: ${f.summary}`);
        if (acted) applied.contextInvalidated++;
        deps.log(`[audit] context-heal (${f.kind}): ${acted ? "invalidated the architecture map — it rebuilds next run" : "no map to invalidate"} — ${f.evidence}`);
        break;
      }
      case "observe":
        applied.observed++;
        deps.log(`[audit] observe (${f.kind}): ${f.summary}`);
        break;
    }
  }
  return applied;
}
