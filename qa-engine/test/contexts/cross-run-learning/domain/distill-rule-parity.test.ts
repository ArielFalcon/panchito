// qa-engine/test/contexts/cross-run-learning/domain/distill-rule-parity.test.ts
// PARITY: the ported distillation logic must match legacy src/qa/learning/distiller.ts +
// src/qa/learning/learning-rule.ts byte-for-byte behavior (normalizeTrigger canonicalization,
// isWellFormedTrigger, ruleKey, the 400-char field caps, and the ALL-statuses dedup decision)
// until the legacy modules are deleted. Imports from src/ (outside qa-engine rootDir) — excluded
// from qa-engine typecheck (see qa-engine/tsconfig.json), runs via tsx at runtime, typechecked
// only under qa-engine/tsconfig.parity.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTrigger,
  isWellFormedTrigger,
  ruleKey,
  capRuleFields,
  decideDistill,
  detectArchetype,
  correctionToErrorClass,
  RULE_FIELD_MAX,
  TRIGGER_PREFIX,
} from "@contexts/cross-run-learning/domain/distill-rule.ts";
import {
  normalizeTrigger as legacyNormalizeTrigger,
  isWellFormedTrigger as legacyIsWellFormedTrigger,
  correctionToRuleUpsert as legacyCorrectionToRuleUpsert,
} from "../../../../../src/qa/learning/distiller.ts";
import { ruleKey as legacyRuleKey, deduplicateRules as legacyDeduplicateRules } from "../../../../../src/qa/learning/learning-rule.ts";
import type { LearningRule as LegacyLearningRule, RuleUpsert as LegacyRuleUpsert } from "../../../../../src/qa/learning/learning-rule.ts";
import type { LearningRule } from "@contexts/cross-run-learning/application/ports/index.ts";
import { detectStructuralPatterns as legacyDetectStructuralPatterns } from "../../../../../src/qa/learning/structural-pattern.ts";

function makeLegacyRule(overrides: Partial<LegacyLearningRule> = {}): LegacyLearningRule {
  return {
    id: "lr-1",
    trigger: "Applies when a fragile selector is used",
    action: "use getByRole",
    errorClass: "E-FRAGILE-SELECTOR",
    archetype: null,
    confidence: "low",
    usageCount: 0,
    outcomeCount: 0,
    oracleOutcomeCount: 0,
    successRate: null,
    lastVerified: null,
    source: "distiller",
    status: "candidate",
    at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makePortRule(overrides: Partial<LearningRule> = {}): LearningRule {
  return {
    id: "lr-1",
    trigger: "Applies when a fragile selector is used",
    action: "use getByRole",
    errorClass: "E-FRAGILE-SELECTOR",
    archetype: null,
    confidence: "low",
    usageCount: 0,
    outcomeCount: 0,
    oracleOutcomeCount: 0,
    successRate: null,
    lastVerified: null,
    source: "distiller",
    status: "candidate",
    at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("PARITY: TRIGGER_PREFIX constant matches legacy's canonical prefix", () => {
  assert.equal(TRIGGER_PREFIX, "Applies when ");
});

test("PARITY: RULE_FIELD_MAX constant matches legacy's 400-char cap", () => {
  assert.equal(RULE_FIELD_MAX, 400);
});

test("PARITY: normalizeTrigger matches legacy across representative + edge inputs", () => {
  const samples = [
    "the diff adds a form",
    "The diff adds a form",
    "API returns 500 on submit",
    "getByRole misses the dialog",
    "FormData is sent without encoding",
    "Applies when the diff adds a form",
    "applies WHEN the diff changes",
    "  the   diff   changes  ",
    "",
    "   ",
    "Applies when",
    "applies when   ",
    // Unicode / whitespace edges the legacy handles.
    "  café  déjà-vu   naïve  ",
    "Ünïcode leading word stays as-is",
    "\t\ttabbed\nwhitespace\r\ncollapses",
    "Applies WHEN   already-prefixed with odd   spacing",
    "a".repeat(500), // long-text edge
  ];
  for (const s of samples) {
    assert.equal(normalizeTrigger(s), legacyNormalizeTrigger(s), JSON.stringify(s));
  }
});

test("PARITY: isWellFormedTrigger matches legacy across representative inputs", () => {
  const samples = ["Applies when the diff adds X", "the diff adds X", "", "Applies when", "Applies when   "];
  for (const s of samples) {
    assert.equal(isWellFormedTrigger(s), legacyIsWellFormedTrigger(s), JSON.stringify(s));
  }
});

test("PARITY: ruleKey matches legacy across casing/whitespace/punctuation/unicode variants", () => {
  const samples: Array<{ trigger: string; action: string }> = [
    { trigger: "Fragile selector", action: "use getByRole" },
    { trigger: "fragile selector.", action: "use getByRole." },
    { trigger: "  Fragile   Selector  ", action: "  use   getByRole  " },
    { trigger: "FRAGILE SELECTOR;;;", action: "USE GETBYROLE,,," },
    { trigger: "café naïve", action: "déjà vu" },
    { trigger: "a".repeat(500), action: "b".repeat(500) },
  ];
  for (const s of samples) {
    assert.equal(ruleKey(s), legacyRuleKey(s), JSON.stringify(s));
  }
});

test("PARITY: capRuleFields caps trigger BEFORE the prefix is applied, matching legacy's reflectionToRuleUpsert ordering", () => {
  const longTrigger = "x".repeat(500);
  const longAction = "y".repeat(500);
  const capped = capRuleFields({ trigger: longTrigger, action: longAction });

  // Mirror legacy's own composition: normalizeTrigger(raw.slice(0, RULE_FIELD_MAX - TRIGGER_PREFIX.length))
  const legacyTrigger = legacyNormalizeTrigger(longTrigger.slice(0, RULE_FIELD_MAX - TRIGGER_PREFIX.length));
  const legacyAction = longAction.slice(0, RULE_FIELD_MAX);

  assert.equal(capped.trigger, legacyTrigger);
  assert.equal(capped.action, legacyAction);
  assert.ok(capped.trigger.length <= RULE_FIELD_MAX);
  assert.ok(capped.action.length <= RULE_FIELD_MAX);
});

test("PARITY: decideDistill dedup matches legacy deduplicateRules — save-as-new for a novel rule", () => {
  const candidate = { trigger: "Applies when a new pattern appears", action: "do the new thing" };
  const existing = [makePortRule({ id: "other", trigger: "Applies when something else", action: "do something else" })];
  const legacyExisting = [makeLegacyRule({ id: "other", trigger: "Applies when something else", action: "do something else" })];

  const ported = decideDistill(candidate, existing);
  const legacy = legacyDeduplicateRules([candidate as LegacyRuleUpsert], legacyExisting);

  assert.equal(ported.decision, "save");
  assert.equal(legacy.toInsert.length, 1);
  assert.equal(legacy.toSkip.length, 0);
});

test("PARITY: decideDistill dedup matches legacy — skip-duplicate against ANY status incl. deprecated/superseded", () => {
  const trigger = "Applies when endpoint flow lacks a response assert";
  const action = "assert the response body matches the submitted input";
  const candidate = { trigger, action };

  for (const status of ["active", "candidate", "deprecated", "superseded"] as const) {
    const existing = [makePortRule({ id: `id-${status}`, trigger, action, status })];
    const legacyExisting = [makeLegacyRule({ id: `id-${status}`, trigger, action, status })];

    const ported = decideDistill(candidate, existing);
    const legacy = legacyDeduplicateRules([candidate as LegacyRuleUpsert], legacyExisting);

    assert.equal(ported.decision, "skip-duplicate", `status=${status}`);
    assert.equal(legacy.toInsert.length, 0, `status=${status}`);
    assert.equal(legacy.toSkip.length, 1, `status=${status}`);
    if (ported.decision === "skip-duplicate") {
      assert.equal(ported.match.id, `id-${status}`);
    }
  }
});

test("PARITY: decideDistill key matches legacy ruleKey for the same candidate", () => {
  const candidate = { trigger: "Fragile Selector.", action: "USE getByRole  " };
  const ported = decideDistill(candidate, []);
  assert.equal(ported.key, legacyRuleKey(candidate));
});

// ── WS1.5 (full-flow remediation): archetype detection — the diff's structural shape
// (form/api-call/stateful-cache/auth-flow/data-list/generic), the SAME detectStructuralPatterns
// legacy declares (src/qa/learning/structural-pattern.ts) but NEVER wires into a distilled
// LearningRule.archetype at any production call site (verified: distillReflection/
// distillReviewerCorrections have zero production callers even in legacy). detectArchetype ports
// the SAME detection logic and picks the FIRST matched pattern's kind — a single, non-fabricated
// archetype tag for the reflector's rule, closing the "archetype always null" gap without
// conflating it with errorClass (a different, unrelated taxonomy — see rule-governance.service.ts's
// own header on why archetype/errorClass are independent relevance signals). ─────────────────────

test("PARITY: detectArchetype's underlying pattern detection matches legacy detectStructuralPatterns across representative diffs", () => {
  const samples: Array<{ diff: string; files: string[] }> = [
    { diff: "+<form onSubmit={handleSubmit}>\n+  <input required />", files: ["Login.tsx"] },
    { diff: "+const res = await fetch('/api/orders', { method: 'POST', body: JSON.stringify(payload) });", files: ["orders.ts"] },
    { diff: "+localStorage.setItem('cache', data);\n+function invalidate() {}", files: ["cache.ts"] },
    { diff: "+await login(username, password);\n+const token = session.jwt;", files: ["auth.ts"] },
    { diff: "+function renderList(items) { return items.filter(...).map(...); }\n+// pagination + empty state", files: ["list.ts"] },
    { diff: "+const x = 1 + 1;", files: ["math.ts"] },
  ];
  for (const s of samples) {
    const legacyKinds = legacyDetectStructuralPatterns(s.diff, s.files).map((p) => p.kind);
    const archetype = detectArchetype(s.diff, s.files);
    assert.equal(archetype, legacyKinds[0] ?? null, JSON.stringify(s));
  }
});

test("detectArchetype returns null for an absent/empty diff — never fabricates a shape for a non-diff-mode run", () => {
  assert.equal(detectArchetype(undefined, []), null);
  assert.equal(detectArchetype("", []), null);
});

test("PARITY: correctionToErrorClass matches legacy correctionToRuleUpsert's errorClass derivation, including the E-REVIEWER-REJECTED fallback", () => {
  const samples = [
    "[false-positive] asserts nothing",
    "[wrong-objective] tests the wrong flow",
    "[fragile-selector] uses nth-child",
    "[no-cleanup] leaves orphaned data",
    "[other] no recognizable anti-pattern",
    "no tag at all, and no keyword match either",
    "contains the phrase false positive in prose",
  ];
  for (const text of samples) {
    const ported = correctionToErrorClass(text);
    const legacy = legacyCorrectionToRuleUpsert({ correction: text, runId: "r1" });
    assert.equal(ported, legacy?.errorClass, JSON.stringify(text));
  }
});
