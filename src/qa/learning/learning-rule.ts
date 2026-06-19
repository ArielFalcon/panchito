import type { ErrorClass } from "./taxonomy";

// "pending" is a RETIRED status, kept in the enum only for backward-compat with any rows an older
// build wrote. It was meant as a pre-candidate quarantine for correction-sourced rules, but it was
// inert: pending is excluded from retrieval (history.ts listRulesStmt) and its only exit transition
// (pending → candidate) lives in recordRuleOutcome, which iterates only RETRIEVED rules — so a
// pending rule was never retrieved, never accrued an outcome, and stayed pending forever. The
// distiller now inserts correction-sourced rules directly as "candidate"; the de-poison is the
// "experimental — consider, not proven" framing in renderRulesForPrompt (exercise without authority),
// NOT exclusion from retrieval. No code path inserts "pending" anymore; the nextStatus pending →
// candidate edge below is dead-but-harmless (it self-heals any legacy pending row on first outcome).
export type RuleStatus = "pending" | "candidate" | "active" | "deprecated" | "superseded";
export type Confidence = "low" | "medium" | "high";

export interface LearningRule {
  id: string;
  trigger: string;
  action: string;
  errorClass: ErrorClass;
  // The diff's structural shape this rule applies to (form, api-call, data-list, …), captured at
  // distill time from detectStructuralPatterns. Lets retrieval bias toward rules matching the
  // CURRENT change's shape, not just its error class. null/undefined when the rule is untagged.
  archetype?: string | null;
  confidence: Confidence;
  usageCount: number; // times this rule was retrieved into a prompt
  outcomeCount: number; // times an objective outcome (valueScore) was folded in
  successRate: number | null; // running mean of outcomes in [0,1] (null until first outcome)
  lastVerified: string | null;
  source: string;
  status: RuleStatus;
  at: string;
}

export interface RuleUpsert {
  trigger: string;
  action: string;
  errorClass: ErrorClass;
  archetype?: string | null;
  source: string;
}

// ── Governance: confidence earned from outcomes, asymmetric hysteresis ───────────
// A rule must EARN promotion over several measured outcomes and is slow to be demoted,
// so a single anomalous outcome (a flaky run, an unknown external event) cannot flip a
// trusted rule. Nothing is ever deleted — a demoted rule is "deprecated" and can be
// resurrected if later outcomes recover.
const MIN_OUTCOMES = 3; // measured outcomes required before any status change
const PROMOTE_RATE = 0.6; // running-mean successRate to promote candidate/deprecated → active
const DEMOTE_RATE = 0.3; // running-mean successRate to demote active → deprecated

export function deriveConfidence(outcomeCount: number, successRate: number | null): Confidence {
  if (outcomeCount < MIN_OUTCOMES || successRate === null) return "low";
  if (successRate >= 0.7) return "high";
  if (successRate >= 0.45) return "medium";
  return "low";
}

// Phase 7: coverageCreditConfirmed is the coverage-anchor governance signal.
//   true  → coverage was measured AND confirmed credit (covered lines in the changed diff) — promotion eligible
//   false → coverage was measured but NO credit (covered 0 changed lines) — promotion blocked for this transition
//   null  → coverage not measured / cross-repo / unknown — no gate (promotion proceeds normally)
// This is the non-circular anchor: a rule can only earn `active` when the test that exercised it
// also covered the diff's changed lines, not just made the reviewer happy. Coverage stays
// non-blocking where unmeasurable (null), so the flywheel turns for every app.
function nextStatus(status: RuleStatus, outcomeCount: number, successRate: number, coverageCreditConfirmed: boolean | null = null): RuleStatus {
  // Phase 7: pending → candidate on first outcome. A correction-sourced rule starts as "pending"
  // (excluded from retrieval) and graduates to "candidate" (eligible for retrieval) as soon as
  // one run folds an outcome in. From then on the standard candidate → active promotion logic
  // applies. This ensures at least one real-world measurement precedes generator injection.
  if (status === "pending") return "candidate";
  if (outcomeCount < MIN_OUTCOMES) return status; // not enough evidence to move
  switch (status) {
    case "candidate": {
      if (successRate < PROMOTE_RATE) return "candidate";
      // Phase 7 coverage anchor: when coverage IS measured (non-null), require confirmed credit for
      // promotion. When coverage is unmeasurable (null), allow promotion on verdict signal alone so
      // the flywheel turns for every app, not just those with source-mapped DEV environments.
      if (coverageCreditConfirmed === false) return "candidate"; // measured, no credit — hold
      return "active";
    }
    case "active":
      return successRate < DEMOTE_RATE ? "deprecated" : "active";
    case "deprecated":
      return successRate >= PROMOTE_RATE ? "active" : "deprecated"; // reversible
    default:
      return status; // superseded is terminal (handled by the distiller, not by outcomes)
  }
}

// ── Governance WITHOUT an oracle: the prevention signal ──────────────────────────
// The oracle (mutation / fault-injection) is the strong ground-truth, but it is opt-in and
// not applicable to every app. To make the flywheel turn for ANY app, we derive a weaker,
// CONSERVATIVE signal from the run's own errorClass — available on every run, no oracle needed:
//
//   - The rule's OWN class still occurred (the run was labeled with it) → 0. Strong, precise
//     negative: the rule failed at the exact thing it exists to prevent. This is Goodhart-proof
//     (it never rewards trivial-green tests; it only punishes a rule that demonstrably didn't work).
//   - A CLEAN run (no errorClass) → a weak positive. The rule "held". Capped at the medium band
//     (see PREVENTION_HELD_SCORE) so a proxy-only rule can reach "active/medium" but NEVER "high":
//     high confidence stays reserved for oracle-proven rules.
//   - An UNRELATED failure (some other class), or a noisy class (infra/flaky) → null: no evidence
//     either way, so the rule's statistics are left untouched.
//
// PREVENTION_HELD_SCORE sits exactly on PROMOTE_RATE: a rule that consistently holds is promoted
// over MIN_OUTCOMES runs, but its running mean plateaus at 0.6 → deriveConfidence caps it at
// "medium". Only the oracle's higher scores lift a rule into "high".
export const PREVENTION_HELD_SCORE = 0.6;

export function preventionOutcome(ruleErrorClass: ErrorClass, runErrorClass: ErrorClass | null): number | null {
  if (runErrorClass === "E-INFRA" || runErrorClass === "E-FLAKY") return null; // noisy — teaches nothing
  if (runErrorClass === ruleErrorClass) return 0; // the rule did not prevent its own class
  if (runErrorClass === null) return PREVENTION_HELD_SCORE; // clean run → the rule held (weak positive)
  return null; // an unrelated failure → no evidence about this rule
}

// Fold one objective outcome (a valueScore in [0,1]) into a rule. successRate is a RUNNING
// MEAN over all outcomes — never an overwrite — so confidence is earned from many results.
// Pure: no time, no I/O (the caller stamps lastVerified).
//
// Phase 7: coverageCreditConfirmed gates the candidate → active promotion step when coverage
// is measurable. Pass true when coverage confirmed credit, false when measured but zero credit,
// null (default) when coverage is not applicable/measured (promotion uses verdict signal only).
export function applyOutcome(rule: LearningRule, score: number, coverageCreditConfirmed: boolean | null = null): LearningRule {
  const n = (rule.outcomeCount ?? 0) + 1;
  const prev = rule.successRate;
  const successRate = prev === null || prev === undefined ? score : prev + (score - prev) / n;
  return {
    ...rule,
    outcomeCount: n,
    successRate,
    confidence: deriveConfidence(n, successRate),
    status: nextStatus(rule.status, n, successRate, coverageCreditConfirmed),
  };
}

// Triggers/actions are free-form LLM text, so near-identical rules differ only by casing,
// surrounding whitespace, or trailing punctuation ("Fragile selector" vs "fragile selector.").
// Normalize before keying so those collapse to one rule instead of accumulating as distinct
// candidates — exact byte-equality let the store grow unbounded with semantic duplicates.
function normalizeRuleText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").replace(/[.;,\s]+$/, "").trim();
}

export function ruleKey(rule: { trigger: string; action: string }): string {
  return `${normalizeRuleText(rule.trigger)}::${normalizeRuleText(rule.action)}`;
}

export function deduplicateRules(
  candidates: RuleUpsert[],
  existing: LearningRule[],
): { toInsert: RuleUpsert[]; toSkip: string[] } {
  const existingKeys = new Set(existing.map(ruleKey));
  const toInsert: RuleUpsert[] = [];
  const toSkip: string[] = [];

  for (const c of candidates) {
    const key = ruleKey(c);
    if (existingKeys.has(key)) {
      toSkip.push(key);
    } else {
      existingKeys.add(key); // prevent duplicates within the batch
      toInsert.push(c);
    }
  }

  return { toInsert, toSkip };
}

export function selectForRetrieval(
  rules: LearningRule[],
  opts: {
    app: string;
    errorClass?: ErrorClass | null;
    archetypes?: string[]; // the current diff's structural shapes (form, api-call, …) — biases relevance
    maxRules?: number;
  },
): LearningRule[] {
  // Only proven (active) or still-exploring (candidate) rules are eligible; deprecated and
  // superseded rules are never injected (and the retired "pending" status, which nothing writes
  // anymore, is excluded too). Correction-sourced rules now enter as CANDIDATES, so they ARE
  // retrieved — the de-poison is the "experimental — consider" framing in renderRulesForPrompt
  // (exercise without authority), not exclusion from retrieval. Ranking: ACTIVE rules first (exploit
  // what has earned its place), then by successRate (the attribution signal), then relevance
  // to this run's errorClass AND the diff's structural shape. Candidates fill the remaining
  // slots as a bounded exploration tail so they can accumulate the outcomes that earn — or
  // deny — promotion.
  const eligible = rules.filter((r) => r.status === "active" || r.status === "candidate");

  const score = (r: LearningRule): number => {
    let s = 0;
    if (r.status === "active") s += 100; // exploit before explore
    s += (r.successRate ?? 0) * 10; // earned-from-outcomes signal
    if (opts.errorClass && r.errorClass === opts.errorClass) s += 3; // relevance to the recent failure class
    // Relevance to the current change's shape. Additive with the errorClass term and weighted
    // below the successRate signal, so a strongly-proven rule is never displaced by a mere
    // shape match — relevance breaks ties, it does not override earned proof.
    if (opts.archetypes?.length && r.archetype && opts.archetypes.includes(r.archetype)) s += 3;
    return s;
  };

  const scored = eligible.map((r) => ({ rule: r, score: score(r) }));
  scored.sort((a, b) => b.score - a.score);

  const limit = opts.maxRules ?? 8;
  const picked = scored.slice(0, limit).map((s) => s.rule);

  // Exploration floor: once `limit` ACTIVE rules exist, the +100 exploit bonus would shut
  // candidates out of retrieval forever — they could never accumulate the outcomes that
  // earn (or deny) promotion, and the injected set would ossify. Reserve the last slots
  // for the NEWEST candidates not already selected, so rule turnover never stalls.
  if (eligible.length > limit) {
    const pickedIds = new Set(picked.map((r) => r.id));
    const freshCandidates = eligible
      .filter((r) => r.status === "candidate" && !pickedIds.has(r.id))
      .sort((a, b) => b.at.localeCompare(a.at));
    const slots = Math.min(EXPLORATION_SLOTS, freshCandidates.length);
    if (slots > 0) picked.splice(limit - slots, slots, ...freshCandidates.slice(0, slots));
  }
  return picked;
}

// How many retrieval slots are reserved for unproven candidates when actives saturate the cap.
export const EXPLORATION_SLOTS = 2;

// Phase 7: split active (proven) rules from candidate (unproven) rules in the generator prompt so
// the generator is NOT instructed to blindly apply speculative rules before they have earned trust
// from measured outcomes. The candidate EXPLORATION FLOOR is preserved — candidates still appear in
// the prompt so the generator EXERCISES them, which is how they accumulate the outcomes that earn
// (or deny) promotion. Only the framing changes: active rules carry authority; candidate rules are
// framed as "experimental — consider", making clear they are hypotheses, not proven prescriptions.
// This strips the authority framing that caused Goodhart drift (generator optimizing speculative rules
// rather than real test quality) without killing the promotion flywheel.
export function renderRulesForPrompt(rules: LearningRule[]): string {
  if (rules.length === 0) return "";

  const active = rules.filter((r) => r.status === "active");
  const candidates = rules.filter((r) => r.status === "candidate");

  const lines: string[] = [];

  if (active.length > 0) {
    lines.push("## Proven rules from past QA runs");
    lines.push("These rules were earned from real failures and validated by measured outcomes. Apply them when they match the current change.");
    lines.push("");
    for (const r of active) {
      lines.push(`### Rule (${r.errorClass}, confidence=${r.confidence})`);
      lines.push(`- Trigger: ${r.trigger}`);
      lines.push(`- Action: ${r.action}`);
      lines.push("");
    }
  }

  if (candidates.length > 0) {
    lines.push("## Experimental rules (unproven — consider, not prescriptive)");
    lines.push("These are hypotheses from recent runs that have not yet been validated by enough measured outcomes. Consider them when clearly applicable, but do not let them override your judgment.");
    lines.push("");
    for (const r of candidates) {
      lines.push(`### Experimental rule (${r.errorClass})`);
      lines.push(`- Trigger: ${r.trigger}`);
      lines.push(`- Consider: ${r.action}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

// Render the PROVEN learned rules as additional reject-on-sight criteria for the INDEPENDENT
// reviewer. Only `active` rules are enforced: unproven candidates exist for the generator to
// explore, never for the judge to gate on — rejecting tests over speculative rules would be a
// false-positive gate. This arms the judge with app-specific knowledge earned from real failures
// without leaking the generator's reasoning (the rules are objective, governed ledger state).
export function renderRulesForReviewer(rules: LearningRule[]): string {
  const proven = rules.filter((r) => r.status === "active");
  if (proven.length === 0) return "";

  const lines = [
    "## App-specific reject-on-sight rules (earned from past runs on this app)",
    "Each was learned from a real failure and proven by the value oracle or sustained prevention.",
    "Treat them as an extension of the anti-pattern catalog: if a spec violates one, REJECT.",
    "",
  ];
  for (const r of proven) {
    lines.push(`- ${r.trigger} → ${r.action} (${r.errorClass})`);
  }
  return lines.join("\n");
}
