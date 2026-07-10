// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/learning-port.adapter.ts
// Bridge: LearningPort -> cross-run-learning's REAL LearningRepositoryPort. THIN — no new policy.
// Off-path by contract: fold() delegates to applyOutcome but SWALLOWS any failure (logged, never
// re-thrown) — a learning-store fault must NEVER propagate to the caller and gate publish.
// retrieve() delegates to topRules(app, sha, limit) and projects the full structured rules as the
// RetrievedRule[] the barrel's LearningPort.retrieve() shape expects (W3 F1, dual-judge round: the
// bare-trigger string[] projection previously here starved both prompt renderers of action/
// errorClass/status/confidence). The v1 default (StubLearningRepository) makes this provably a
// no-op — retrieve() genuinely returns [] until a real store is wired.
// WS1.1 (full-flow remediation): the projection now ALSO carries the row's real `id` (the ledger's
// primary key) — it was dropped here previously, which silently starved the run-qa use-case's
// persisted RunOutcome.rulesRetrieved of anything but trigger text, breaking the consumer's by-id
// fold (rewritten-engine-factory.ts's recordOutcome / history.ts's id lookup) with no error, ever.
import type { Sha } from "@kernel/sha.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { LearningPort, RetrievedRule } from "../../application/ports/index.ts";
import type { LearningRepositoryPort, RuleStatus } from "@contexts/cross-run-learning/application/ports/index.ts";
import { renderLearnedRules } from "./generation-port.adapter.ts";

// Bounded so a single run's retrieval never fans out unbounded rule history — mirrors the legacy's
// own listLearningRules(app, limit) call sites, all of which pass a small fixed limit (20-200).
const DEFAULT_RETRIEVE_LIMIT = 20;

// sdd/migration-remediation Slice 7.1 (verify-first spike -> confirmed fix): mirrors legacy's
// src/qa/learning/learning-rule.ts's own DEFAULT_RULES_CHAR_BUDGET exactly (same numeric budget for
// the SAME rendered section — this port's renderLearnedRules is a faithful port of legacy's
// renderRulesForPrompt, so the two budgets bound behaviorally-identical text).
export const DEFAULT_RULES_CHAR_BUDGET = 5000;

// Greedily drop the lowest-ranked (tail) rules — topRules() returns rules already ranked best-first
// (RuleGovernanceService's own contract) — until renderLearnedRules(...) fits maxChars. A faithful
// port of legacy's fitRulesToBudget (src/qa/learning/learning-rule.ts): whole-rule cuts only, pure,
// deterministic (same input -> same fitted set). Measured against THIS bridge's OWN renderLearnedRules
// (not a separate estimate) so the budget matches exactly what the generator prompt will render.
function fitRulesToBudget(rules: readonly RetrievedRule[], maxChars: number): RetrievedRule[] {
  let included = [...rules];
  while (included.length > 0 && renderLearnedRules(included).length > maxChars) {
    included = included.slice(0, -1); // drop the lowest-ranked (last) rule and re-render
  }
  return included;
}

// RetrievedRule.status is narrowed to "active" | "candidate" (the only two statuses
// RuleGovernanceService.topRules ever returns — deprecated/superseded are filtered out before this
// point). A defensive fallback to "candidate" for any other value keeps this a total function
// without widening the port's own narrow union.
function toRetrievedStatus(status: RuleStatus): "active" | "candidate" {
  return status === "active" ? "active" : "candidate";
}

export class LearningPortAdapter implements LearningPort {
  constructor(
    private readonly repo: LearningRepositoryPort,
    private readonly app: string,
    private readonly limit = DEFAULT_RETRIEVE_LIMIT,
    // Injectable so a test can assert the swallow without polluting stderr; defaults to console.error.
    private readonly onFoldError: (err: unknown) => void = (err) => console.error("[LearningPortAdapter] fold failed (off-path, swallowed):", err),
    // judgment-day hardening (FIX 3): injectable so a test can assert the swallow without polluting
    // stderr; defaults to console.warn. See retrieve()'s own doc for why this is isolated.
    private readonly onIncrementUsageError: (err: unknown) => void = (err) => console.warn("[LearningPortAdapter] incrementUsage failed (off-path, swallowed):", err),
    // sdd/migration-remediation Slice 7.1: APPENDED as the LAST constructor param (not inserted
    // earlier in the list) so every existing positional call site (limit, onFoldError,
    // onIncrementUsageError) keeps compiling and behaving identically when it omits this.
    private readonly maxChars = DEFAULT_RULES_CHAR_BUDGET,
  ) {}

  async fold(outcome: RunOutcome): Promise<void> {
    try {
      await this.repo.applyOutcome(outcome);
    } catch (err) {
      // Off-path by contract: never gates publish. Logged, not re-thrown.
      this.onFoldError(err);
    }
  }

  async retrieve(sha: Sha): Promise<RetrievedRule[]> {
    const rules = await this.repo.topRules(this.app, sha, this.limit);
    const projected: RetrievedRule[] = rules.map((r) => ({
      // WS1.1 (full-flow remediation, most critical finding): the real repository row id, previously
      // dropped at this exact projection. Without it, the use-case's persisted
      // RunOutcome.rulesRetrieved had nothing but trigger TEXT to fold by, and the consumer's by-id
      // fold (SELECT ... WHERE id = ?) missed every row silently.
      id: r.id,
      trigger: r.trigger,
      action: r.action,
      errorClass: r.errorClass,
      status: toRetrievedStatus(r.status),
      confidence: r.confidence,
    }));
    // sdd/migration-remediation Slice 7.1 (verify-first spike -> confirmed fix): budget-fit BEFORE
    // recording usage — legacy parity (src/qa/learning/retrieval.ts's own "Budget-fit BEFORE
    // recording usage so usageCount and the retrieved-IDs set reflect exactly what the generator
    // will see — no phantom 'used' rules that were truncated out of the prompt" comment). This
    // closes the confirmed defect: retrieve() previously had no char-budget step at all, only the
    // topRules() count limit — an oversized rule set could reach the generator prompt uncapped.
    const fitted = fitRulesToBudget(projected, this.maxChars);
    // W3 fix (F3a, dual-judge round): mirrors legacy's retrieveRules() — increment usage on
    // EXACTLY the budget-fitted set (the "what the generator will see" set), never the raw
    // untrimmed retrieval. Off-path: never gates the run — a store without incrementUsage wired is
    // a silent no-op (see the port's own optional-method doc).
    //
    // judgment-day hardening (FIX 3): isolated in its own try/catch so a telemetry-write failure
    // can NEVER discard the already-successful topRules() retrieval — the caller must still get its
    // rules even if usage tracking fails. Mirrors fold()'s own documented off-path contract on this
    // SAME port (LearningRepositoryPort): a learning-store fault must never propagate and gate the
    // run. Legacy (src/qa/learning/retrieval.ts's incrementRuleUsage call) has NO such isolation —
    // this is a deliberate hardening over legacy, not a behavior this port is merely preserving,
    // justified by fold()'s own precedent on the identical port.
    if (fitted.length > 0) {
      try {
        await this.repo.incrementUsage?.(fitted.map((r) => r.id));
      } catch (err) {
        this.onIncrementUsageError(err);
      }
    }
    return fitted;
  }
}
