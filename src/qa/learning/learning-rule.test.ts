import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ruleKey,
  deduplicateRules,
  selectForRetrieval,
  renderRulesForPrompt,
  applyOutcome,
  preventionOutcome,
  PREVENTION_HELD_SCORE,
  fitRulesToBudget,
  DEFAULT_RULES_CHAR_BUDGET,
  type LearningRule,
  type RuleUpsert,
} from "./learning-rule";

function rule(overrides: Partial<LearningRule> = {}): LearningRule {
  return {
    id: "rule-1",
    trigger: "form without validation",
    action: "test invalid input",
    errorClass: "E-FALSE-POSITIVE",
    confidence: "low",
    usageCount: 0,
    outcomeCount: 0,
    oracleOutcomeCount: 0,
    successRate: null,
    lastVerified: null,
    source: "run-1",
    status: "candidate",
    at: new Date().toISOString(),
    ...overrides,
  };
}

describe("ruleKey", () => {
  it("produces stable key from trigger + action", () => {
    assert.equal(ruleKey({ trigger: "a", action: "b" }), "a::b");
  });
  it("normalizes casing, whitespace and trailing punctuation so near-duplicates collide", () => {
    assert.equal(
      ruleKey({ trigger: "Fragile  selector", action: "Scope the locator." }),
      ruleKey({ trigger: "fragile selector", action: "scope the locator" }),
    );
  });
});

describe("preventionOutcome (governance signal without an oracle)", () => {
  it("scores 0 when the run still incurred the rule's own class (the rule failed its purpose)", () => {
    assert.equal(preventionOutcome("E-FRAGILE-SELECTOR", "E-FRAGILE-SELECTOR"), 0);
  });
  it("scores a weak positive (held) on a clean run, capped at medium — never high", () => {
    assert.equal(preventionOutcome("E-FRAGILE-SELECTOR", null), PREVENTION_HELD_SCORE);
    // The held score must stay below the 0.7 "high" threshold so proxy-only rules cap at medium.
    assert.ok(PREVENTION_HELD_SCORE < 0.7, "held score must not reach high confidence");
  });
  it("returns null for an unrelated failure (no evidence about this rule)", () => {
    assert.equal(preventionOutcome("E-FRAGILE-SELECTOR", "E-EXEC-FAIL"), null);
  });
  it("returns null for noisy classes (infra/flaky) even when they match", () => {
    assert.equal(preventionOutcome("E-INFRA", "E-INFRA"), null);
    assert.equal(preventionOutcome("E-FLAKY", "E-FLAKY"), null);
  });
  // WS1.4(b) SUPERSEDES this test's original expectation (status: "active"). Promotion is
  // objective-signal-only: prevention credit alone (however consistent) must never flip a
  // candidate to active — see nextStatus's oracleOutcomeCount gate. successRate/confidence still
  // plateau at medium exactly as before; only the status assertion changes.
  it("a rule that consistently holds via prevention alone plateaus successRate/confidence at medium but does NOT promote (WS1.4(b))", () => {
    let r = rule({ status: "candidate", errorClass: "E-FRAGILE-SELECTOR" });
    for (let i = 0; i < 5; i++) {
      const s = preventionOutcome(r.errorClass, null);
      if (s !== null) r = applyOutcome(r, s); // prevention path — isOracleScore omitted/false
    }
    assert.equal(r.status, "candidate", "WS1.4(b): prevention-only credit must NOT promote — zero oracle evidence was folded in");
    assert.equal(r.confidence, "medium", "proxy-only promotion never reaches high");
    assert.equal(r.oracleOutcomeCount, 0, "no outcome in this loop was oracle-scored");
  });
  it("a rule whose class keeps recurring is demoted out of active", () => {
    let r = rule({ status: "active", successRate: 0.7, outcomeCount: 4, errorClass: "E-FRAGILE-SELECTOR" });
    for (let i = 0; i < 6; i++) {
      const s = preventionOutcome(r.errorClass, "E-FRAGILE-SELECTOR"); // keeps failing
      if (s !== null) r = applyOutcome(r, s);
    }
    assert.equal(r.status, "deprecated", "a rule that never prevents its class loses trust");
  });

  // WS1.4(a) (full-flow remediation, INTERIM promotion-safety gate): a rule with an EMPTY/blank
  // errorClass is unfalsifiable under the prevention path — a real run's errorClass is either a
  // genuine ErrorClass value or null (never ""), so `runErrorClass === ruleErrorClass` can NEVER
  // be true for an empty ruleErrorClass. The rule can therefore only ever hit the `runErrorClass
  // === null` branch (PREVENTION_HELD_SCORE, a free ride to promotion) and can never be scored 0.
  // Empty/blank ruleErrorClass now returns null (no signal) so it can never accrue credit at all.
  it("returns null (no signal) when the rule's own errorClass is empty — unfalsifiable, can never be scored 0, must not collect free held-credit", () => {
    assert.equal(preventionOutcome("" as never, null), null, "empty ruleErrorClass + clean run must yield no signal, not PREVENTION_HELD_SCORE");
    assert.equal(preventionOutcome("" as never, "E-EXEC-FAIL"), null, "empty ruleErrorClass + unrelated failure must yield no signal");
  });
  it("returns null when the rule's own errorClass is blank (whitespace-only) — same unfalsifiable shape as empty", () => {
    assert.equal(preventionOutcome("   " as never, null), null);
  });
});

describe("deduplicateRules", () => {
  it("inserts new candidates when none exist", () => {
    const { toInsert, toSkip } = deduplicateRules(
      [{ trigger: "a", action: "b", errorClass: "E-STATIC", source: "run-1" }],
      [],
    );
    assert.equal(toInsert.length, 1);
    assert.equal(toSkip.length, 0);
  });

  it("skips duplicates against existing rules", () => {
    const existing = [rule({ trigger: "a", action: "b" })];
    const { toInsert, toSkip } = deduplicateRules(
      [{ trigger: "a", action: "b", errorClass: "E-STATIC", source: "run-2" }],
      existing,
    );
    assert.equal(toInsert.length, 0);
    assert.equal(toSkip.length, 1);
  });

  it("deduplicates within the same batch", () => {
    const { toInsert } = deduplicateRules(
      [
        { trigger: "a", action: "b", errorClass: "E-STATIC", source: "run-1" },
        { trigger: "a", action: "b", errorClass: "E-STATIC", source: "run-2" },
      ],
      [],
    );
    assert.equal(toInsert.length, 1);
  });
});

describe("selectForRetrieval", () => {
  it("returns active and candidate rules, scored and sorted", () => {
    const rules = [
      rule({ id: "r1", errorClass: "E-FALSE-POSITIVE", confidence: "high", usageCount: 5, status: "active" }),
      rule({ id: "r2", errorClass: "E-STATIC", confidence: "low", usageCount: 0, status: "active" }),
      rule({ id: "r3", errorClass: "E-FALSE-POSITIVE", confidence: "medium", usageCount: 2, status: "candidate" }),
    ];
    const result = selectForRetrieval(rules, { app: "test", errorClass: "E-FALSE-POSITIVE" });
    assert.equal(result[0]!.id, "r1"); // high confidence + matching errorClass
    assert.ok(result.length >= 2);
  });

  it("excludes deprecated and superseded rules", () => {
    const rules = [
      rule({ id: "r1", status: "deprecated" }),
      rule({ id: "r2", status: "superseded" }),
      rule({ id: "r3", status: "active" }),
    ];
    const result = selectForRetrieval(rules, { app: "test" });
    assert.equal(result.length, 1);
    assert.equal(result[0]!.id, "r3");
  });

  it("respects maxRules", () => {
    const rules = Array.from({ length: 10 }, (_, i) =>
      rule({ id: `r${i}`, status: "active" }),
    );
    const result = selectForRetrieval(rules, { app: "test", maxRules: 3 });
    assert.equal(result.length, 3);
  });

  it("ranks active rules by successRate (the attribution signal)", () => {
    // listed worst-first to prove the ranking is by successRate, not input order.
    const rules = [
      rule({ id: "lo", status: "active", successRate: 0.2, outcomeCount: 5 }),
      rule({ id: "hi", status: "active", successRate: 0.9, outcomeCount: 5 }),
    ];
    const result = selectForRetrieval(rules, { app: "test" });
    assert.equal(result[0]!.id, "hi");
  });

  it("ranks any active rule above any candidate (exploit before explore)", () => {
    const rules = [
      rule({ id: "cand", status: "candidate", successRate: 0.95, outcomeCount: 1 }),
      rule({ id: "act", status: "active", successRate: 0.3, outcomeCount: 5 }),
    ];
    const result = selectForRetrieval(rules, { app: "test" });
    assert.equal(result[0]!.id, "act");
  });
});

describe("applyOutcome", () => {
  it("sets successRate to the score on the first outcome", () => {
    const r = applyOutcome(rule({ outcomeCount: 0, successRate: null }), 0.8);
    assert.equal(r.successRate, 0.8);
    assert.equal(r.outcomeCount, 1);
    assert.equal(r.status, "candidate"); // not enough outcomes to promote yet
  });

  it("accumulates as a running mean, never an overwrite", () => {
    let r = rule({ outcomeCount: 0, successRate: null });
    r = applyOutcome(r, 1.0);
    r = applyOutcome(r, 0.0);
    r = applyOutcome(r, 0.5);
    assert.equal(r.outcomeCount, 3);
    assert.ok(Math.abs(r.successRate! - 0.5) < 1e-9, `expected ~0.5, got ${r.successRate}`);
  });

  it("promotes a candidate to active after enough good ORACLE-scored outcomes", () => {
    // WS1.4(b): promotion requires at least one oracle-scored outcome — isOracleScore=true here
    // exercises the generic hysteresis/promotion math with the objective-evidence gate satisfied.
    let r = rule({ status: "candidate" });
    r = applyOutcome(r, 0.8, null, true);
    r = applyOutcome(r, 0.8, null, true);
    assert.equal(r.status, "candidate"); // only 2 outcomes
    r = applyOutcome(r, 0.8, null, true);
    assert.equal(r.status, "active"); // 3 outcomes, mean >= promote threshold, oracle evidence present
  });

  it("does NOT promote when the mean stays below the threshold (even with oracle evidence)", () => {
    let r = rule({ status: "candidate" });
    r = applyOutcome(r, 0.5, null, true);
    r = applyOutcome(r, 0.5, null, true);
    r = applyOutcome(r, 0.5, null, true);
    assert.equal(r.status, "candidate");
  });

  // WS1.4(b): the full gate — three good outcomes with NO oracle evidence at all must NOT promote,
  // even though the mean clears PROMOTE_RATE and MIN_OUTCOMES is satisfied.
  it("does NOT promote a candidate on good outcomes alone when none are oracle-scored (WS1.4(b) objective-evidence gate)", () => {
    let r = rule({ status: "candidate" });
    r = applyOutcome(r, 0.8); // isOracleScore defaults to false
    r = applyOutcome(r, 0.8);
    r = applyOutcome(r, 0.8);
    assert.equal(r.status, "candidate", "zero oracle-scored outcomes — promotion must be held regardless of successRate");
    assert.equal(r.oracleOutcomeCount, 0);
  });

  it("demotes an active rule only after SUSTAINED low outcomes (tolerant, not trigger-happy)", () => {
    let r = rule({ status: "active", successRate: 0.8, outcomeCount: 3 });
    r = applyOutcome(r, 0.0);
    r = applyOutcome(r, 0.0);
    r = applyOutcome(r, 0.0);
    assert.equal(r.status, "active"); // a few failures do NOT flip a trusted rule
    for (let i = 0; i < 6; i++) r = applyOutcome(r, 0.0); // but sustained failure does
    assert.equal(r.status, "deprecated");
  });

  it("hysteresis: an active rule in the dead band [0.3,0.6) is NOT demoted", () => {
    let r = rule({ status: "active", successRate: 0.45, outcomeCount: 5 });
    r = applyOutcome(r, 0.45);
    r = applyOutcome(r, 0.45);
    assert.equal(r.status, "active");
  });

  it("is reversible: a deprecated rule recovers to active with good outcomes", () => {
    const r = applyOutcome(rule({ status: "deprecated", successRate: 0.5, outcomeCount: 2 }), 0.9);
    assert.equal(r.status, "active"); // resurrected, nothing was deleted
  });

  it("a single anomalous outcome barely moves a high-confidence rule", () => {
    const r = applyOutcome(rule({ status: "active", successRate: 0.9, outcomeCount: 20 }), 0.0);
    assert.ok(r.successRate! > 0.85, `expected >0.85, got ${r.successRate}`);
    assert.equal(r.status, "active"); // one bad event does not flip it
  });
});

describe("renderRulesForPrompt", () => {
  it("returns empty string for no rules", () => {
    assert.equal(renderRulesForPrompt([]), "");
  });

  it("renders rules with trigger and action", () => {
    const rules = [rule({ errorClass: "E-FALSE-POSITIVE", confidence: "high", trigger: "click without assert", action: "assert outcome" })];
    const output = renderRulesForPrompt(rules);
    assert.match(output, /E-FALSE-POSITIVE/);
    assert.match(output, /click without assert/);
    assert.match(output, /assert outcome/);
  });
});

// ── Phase 7: de-poison learning ──────────────────────────────────────────────
// P15: renderRulesForPrompt must frame candidate (unproven) rules as "experimental — consider",
// not as authoritative instructions. Active (proven) rules keep their authority framing.
// The exploration floor (candidates appear in the prompt) is preserved.
//
// P16: coverage-anchored promotion: applyOutcome with coverageCreditConfirmed=false must
// block candidate → active promotion even when successRate >= PROMOTE_RATE.

describe("Phase 7 (a): renderRulesForPrompt — candidate rules framed experimental, active rules keep authority", () => {
  it("active rules appear under the 'Proven rules' heading with apply-them framing", () => {
    const activeRule = rule({ status: "active", trigger: "active trigger", action: "active action" });
    const output = renderRulesForPrompt([activeRule]);
    assert.match(output, /Proven rules from past QA runs/i, "active rules must use the proven/authoritative heading");
    assert.match(output, /Apply them when/i, "active framing must say 'apply'");
    assert.match(output, /active trigger/);
    assert.match(output, /active action/);
    assert.doesNotMatch(output, /experimental/i, "active rules must NOT be labelled experimental");
  });

  it("candidate rules appear under the 'Experimental rules' heading with consider framing", () => {
    const candidateRule = rule({ status: "candidate", trigger: "cand trigger", action: "cand action" });
    const output = renderRulesForPrompt([candidateRule]);
    assert.match(output, /Experimental rules/i, "candidate rules must use the experimental heading");
    assert.match(output, /consider/i, "candidate framing must say 'consider', not 'apply'");
    assert.match(output, /cand trigger/);
    assert.match(output, /cand action/);
    assert.doesNotMatch(output, /Proven rules/i, "no proven heading when only candidates are present");
  });

  it("mixed active + candidate: both sections appear, active before candidate", () => {
    const active1 = rule({ id: "a1", status: "active", trigger: "proven trigger", action: "proven action" });
    const cand1 = rule({ id: "c1", status: "candidate", trigger: "cand trigger", action: "cand action" });
    const output = renderRulesForPrompt([active1, cand1]);
    assert.match(output, /Proven rules/i);
    assert.match(output, /Experimental rules/i);
    const provenIdx = output.indexOf("Proven rules");
    const expIdx = output.indexOf("Experimental rules");
    assert.ok(provenIdx < expIdx, "proven section must appear before experimental section");
  });

  it("pending rules are excluded from renderRulesForPrompt (not injected into generator)", () => {
    const pendingRule = rule({ status: "pending" as import("./learning-rule").RuleStatus, trigger: "pend trigger", action: "pend action" });
    const output = renderRulesForPrompt([pendingRule]);
    assert.equal(output, "", "pending rules must produce no output (not injected)");
  });

  it("empty rules list produces empty output (exploration floor still holds via selectForRetrieval)", () => {
    assert.equal(renderRulesForPrompt([]), "");
  });
});

describe("Phase 7 (b): pending rules excluded from selectForRetrieval (not injected before first outcome)", () => {
  it("pending rules are NOT in the eligible set for retrieval", () => {
    const pendingRule = rule({ id: "pend-1", status: "pending" as import("./learning-rule").RuleStatus });
    const selected = selectForRetrieval([pendingRule], { app: "test-app" });
    assert.equal(selected.length, 0, "pending rules must not be selected for retrieval");
  });

  it("candidate and active rules ARE in the eligible set", () => {
    const candidateRule = rule({ id: "cand-1", status: "candidate" });
    const activeRule = rule({ id: "act-1", status: "active", successRate: 0.8, outcomeCount: 5 });
    const selected = selectForRetrieval([candidateRule, activeRule], { app: "test-app" });
    assert.equal(selected.length, 2, "both candidate and active rules must be retrievable");
  });
});

describe("Phase 7 (c): pending → candidate transition on first outcome (applyOutcome)", () => {
  it("a pending rule becomes candidate on the first outcome (any score)", () => {
    const pendingRule = rule({ status: "pending" as import("./learning-rule").RuleStatus, outcomeCount: 0, successRate: null });
    const updated = applyOutcome(pendingRule, 0.9);
    assert.equal(updated.status, "candidate", "first outcome on a pending rule must promote it to candidate");
  });

  it("a pending → candidate transition requires further outcomes before active promotion", () => {
    // WS1.4(b): isOracleScore=true isolates the pending/MIN_OUTCOMES dimension this test targets —
    // the objective-evidence gate is satisfied throughout, so promotion is governed purely by
    // outcomeCount/successRate, exactly this test's original intent.
    let r = rule({ status: "pending" as import("./learning-rule").RuleStatus, outcomeCount: 0, successRate: null });
    r = applyOutcome(r, 0.9, null, true); // pending → candidate
    assert.equal(r.status, "candidate", "after one outcome: candidate");
    // Not yet enough outcomes (MIN_OUTCOMES=3): stays candidate
    r = applyOutcome(r, 0.9, null, true);
    assert.equal(r.status, "candidate", "two outcomes: still candidate (not enough for promotion)");
    r = applyOutcome(r, 0.9, null, true);
    assert.equal(r.status, "active", "three outcomes above PROMOTE_RATE, all oracle-scored: promoted to active");
  });
});

describe("Phase 7 (d): coverage-anchored promotion governance", () => {
  it("candidate rule is promoted when coverage credit is confirmed (coverageCreditConfirmed=true)", () => {
    // Build a candidate rule at the promotion threshold. WS1.4(b): isOracleScore=true isolates the
    // coverage dimension this test targets from the separate oracle-evidence gate.
    let r = rule({ status: "candidate", outcomeCount: 0, successRate: null });
    for (let i = 0; i < 3; i++) r = applyOutcome(r, 0.7, true, true); // confirmed credit + oracle-scored, each time
    assert.equal(r.status, "active", "promotion must proceed when coverage credit is confirmed and oracle evidence exists");
  });

  it("candidate rule is NOT promoted when coverage is measured but no credit (coverageCreditConfirmed=false)", () => {
    let r = rule({ status: "candidate", outcomeCount: 0, successRate: null });
    // Apply enough outcomes at the promotion rate (oracle-scored) — but with no coverage credit.
    for (let i = 0; i < 5; i++) r = applyOutcome(r, 0.7, false, true);
    assert.equal(r.status, "candidate", "promotion must be blocked when coverage measured zero credit, even with oracle evidence");
  });

  it("candidate rule IS promoted when coverage is unmeasurable (coverageCreditConfirmed=null) — non-blocking", () => {
    let r = rule({ status: "candidate", outcomeCount: 0, successRate: null });
    for (let i = 0; i < 3; i++) r = applyOutcome(r, 0.7, null, true); // null = unmeasured; oracle-scored
    assert.equal(r.status, "active", "promotion must proceed when coverage is not measurable (flywheel turns for all apps)");
  });

  it("demotion (active → deprecated) is NOT gated on coverage credit", () => {
    // Start an active rule with a modest successRate and fold in enough bad outcomes (score=0)
    // to push the running mean below DEMOTE_RATE (0.3). 20 bad outcomes from successRate=0.8
    // bring the mean well below 0.3. coverageCreditConfirmed=false must not block demotion.
    let r = rule({ status: "active", outcomeCount: 3, successRate: 0.8 });
    for (let i = 0; i < 20; i++) r = applyOutcome(r, 0.0, false); // bad outcomes + no coverage credit
    assert.equal(r.status, "deprecated", "demotion must happen regardless of coverage credit");
  });

  // WS1.4(b): the coverage gate and the oracle-evidence gate are INDEPENDENT — confirmed coverage
  // credit alone does not substitute for oracle evidence.
  it("candidate rule is NOT promoted on confirmed coverage credit alone, without any oracle-scored outcome (WS1.4(b))", () => {
    let r = rule({ status: "candidate", outcomeCount: 0, successRate: null });
    for (let i = 0; i < 3; i++) r = applyOutcome(r, 0.7, true); // confirmed credit, but isOracleScore omitted (false)
    assert.equal(r.status, "candidate", "coverage credit confirmed is necessary but not sufficient — oracle evidence is a SEPARATE requirement");
    assert.equal(r.oracleOutcomeCount, 0);
  });
});

// ── Task 2: fitRulesToBudget ──────────────────────────────────────────────────

function mkRule(id: string, action: string, status: "active" | "candidate" = "active"): LearningRule {
  return {
    id,
    trigger: "Applies when the diff adds a form",
    action,
    errorClass: "E-FALSE-POSITIVE",
    confidence: "medium",
    usageCount: 0,
    outcomeCount: 3,
    oracleOutcomeCount: 3,
    successRate: 0.6,
    lastVerified: null,
    source: "test",
    status,
    at: "2026-01-01T00:00:00.000Z",
  };
}

describe("fitRulesToBudget", () => {
  it("returns all rules when they fit within the budget", () => {
    const rules = [mkRule("a", "x"), mkRule("b", "y")];
    const out = fitRulesToBudget(rules, DEFAULT_RULES_CHAR_BUDGET);
    assert.equal(out.included.length, 2);
    assert.ok(out.rendered.length <= DEFAULT_RULES_CHAR_BUDGET);
  });

  it("drops lowest-ranked rules from the tail to fit the budget", () => {
    const big = "z".repeat(400);
    const rules = [mkRule("a", big), mkRule("b", big), mkRule("c", big)];
    const out = fitRulesToBudget(rules, 900);
    // The fitted set never exceeds the budget and is a HEAD-prefix of the input ranking.
    assert.ok(out.rendered.length <= 900);
    assert.deepEqual(
      out.included.map((r) => r.id),
      rules.slice(0, out.included.length).map((r) => r.id),
    );
    assert.ok(out.included.length < 3);
  });

  it("renders only the included rules (no phantom rule IDs)", () => {
    // Use distinct action strings so we can test which rules appear in rendered output.
    const rules = [
      mkRule("a", "z".repeat(400) + "-action-a"),
      mkRule("b", "z".repeat(400) + "-action-b"),
      mkRule("c", "z".repeat(400) + "-action-c"),
    ];
    const out = fitRulesToBudget(rules, 900);
    for (const r of rules) {
      const present = out.rendered.includes(r.action);
      assert.equal(present, out.included.some((i) => i.id === r.id));
    }
  });
});

// ── Task 3: selectForRetrieval determinism ────────────────────────────────────

describe("selectForRetrieval determinism", () => {
  it("breaks score ties deterministically by id (same result regardless of input order)", () => {
    const mk = (id: string): LearningRule => ({
      id,
      trigger: "Applies when x",
      action: "do y",
      errorClass: "E-FALSE-POSITIVE",
      confidence: "medium",
      usageCount: 0,
      outcomeCount: 3,
      oracleOutcomeCount: 3,
      successRate: 0.6,
      lastVerified: null,
      source: "test",
      status: "active",
      at: "2026-01-01T00:00:00.000Z",
    });
    const forward = selectForRetrieval([mk("c"), mk("a"), mk("b")], { app: "d", maxRules: 2 });
    const reversed = selectForRetrieval([mk("b"), mk("a"), mk("c")], { app: "d", maxRules: 2 });
    assert.deepEqual(
      forward.map((r) => r.id),
      reversed.map((r) => r.id),
    );
  });

  it("never grows the result beyond maxRules when the exploration floor fires", () => {
    const active = (id: string): LearningRule => ({
      id,
      trigger: "t",
      action: "a",
      errorClass: "E-FALSE-POSITIVE",
      confidence: "high",
      usageCount: 0,
      outcomeCount: 3,
      oracleOutcomeCount: 3,
      successRate: 0.9,
      lastVerified: null,
      source: "t",
      status: "active",
      at: "2026-01-01T00:00:00.000Z",
    });
    const candidate = (id: string): LearningRule => ({
      ...active(id),
      status: "candidate",
      successRate: 0.1,
      confidence: "low",
    });
    // 2 active + 3 candidates, limit 4: exploration floor must REPLACE, not append.
    const out = selectForRetrieval(
      [active("a1"), active("a2"), candidate("c1"), candidate("c2"), candidate("c3")],
      { app: "d", maxRules: 4 },
    );
    assert.equal(out.length, 4);
  });
});

import { attributableRules } from "./learning-rule";

describe("attributableRules — context-directed attribution filter", () => {
  function mkRule(id: string, archetype: string | null): LearningRule {
    return {
      id, trigger: "t", action: "a", errorClass: "E-FALSE-POSITIVE", archetype,
      confidence: "medium", usageCount: 0, outcomeCount: 3, oracleOutcomeCount: 3, successRate: 0.6,
      lastVerified: null, source: "t", status: "active", at: "2026-01-01T00:00:00.000Z",
    };
  }

  it("keeps rules whose archetype matches the diff shapes, and untagged rules (fail-open per rule)", () => {
    const rules = [mkRule("form", "form"), mkRule("api", "api-call"), mkRule("untagged", null)];
    const kept = attributableRules(rules, { diffArchetypes: ["form"] });
    // "form" matches; "api-call" is tagged but does not match → dropped; "untagged" has no signal → kept.
    assert.deepEqual(kept.map((r) => r.id), ["form", "untagged"]);
  });

  it("keeps everything when no diff archetypes are known (fail-open)", () => {
    const rules = [mkRule("a", "form"), mkRule("b", "api-call")];
    assert.deepEqual(attributableRules(rules, { diffArchetypes: [] }).map((r) => r.id), ["a", "b"]);
  });

  it("drops tagged non-matching rules but keeps untagged ones", () => {
    const rules = [mkRule("x", "form"), mkRule("y", null)];
    const kept = attributableRules(rules, { diffArchetypes: ["data-list"] });
    // "x" is tagged "form" and does not match "data-list" → dropped; "y" is untagged → kept.
    assert.deepEqual(kept.map((r) => r.id), ["y"]);
  });

  it("handles multiple matching archetypes", () => {
    const rules = [mkRule("form", "form"), mkRule("api", "api-call"), mkRule("nav", "navigation")];
    const kept = attributableRules(rules, { diffArchetypes: ["form", "navigation"] });
    assert.deepEqual(kept.map((r) => r.id), ["form", "nav"]);
  });
});
