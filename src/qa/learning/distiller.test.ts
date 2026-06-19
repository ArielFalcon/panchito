import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { distillReflection } from "./distiller";
import { upsertLearningRule, recordRuleOutcome, listLearningRules, listAllLearningRules } from "../../server/history";
import type { StructuredReflection } from "../../types";

function reflection(trigger: string, action: string): StructuredReflection {
  return {
    goal: "g",
    decision: "d",
    assumption: "a",
    errorClass: "E-FALSE-POSITIVE",
    gateSignal: "s",
    evidence: "e",
    rootCause: "rc",
    preventiveRule: { trigger, action },
  };
}

describe("distillReflection dedup against ALL rule statuses", () => {
  it("does NOT insert a duplicate when a DEPRECATED rule with the same trigger::action exists", () => {
    const app = "distill-dep-1";
    // Canonical "Applies when …" form: distilled candidates are normalized to this shape, so the
    // seeded rule must share it for dedup (which keys on the normalized trigger) to recognize the match.
    const trigger = "Applies when endpoint flow without a response assert";
    const action = "assert the response body matches the submitted input";

    // Create a rule, promote it to active, then demote it to 'deprecated' via sustained bad outcomes.
    upsertLearningRule({ id: "dep-rule", app, trigger, action, errorClass: "E-FALSE-POSITIVE", source: "seed" });
    for (let i = 0; i < 3; i++) recordRuleOutcome("dep-rule", 0.9); // → active
    for (let i = 0; i < 8; i++) recordRuleOutcome("dep-rule", 0.0); // → deprecated

    const deprecated = listAllLearningRules(app, 50).find((r) => r.id === "dep-rule");
    assert.equal(deprecated?.status, "deprecated", "precondition: the rule is deprecated");
    assert.equal(
      listLearningRules(app, 50).some((r) => r.id === "dep-rule"),
      false,
      "precondition: a deprecated rule is excluded from the retrieval list",
    );

    // The same failure pattern recurs. Dedup MUST see the deprecated rule and skip — not insert a copy.
    const res = distillReflection({ app, runId: "run-9", reflection: reflection(trigger, action) });
    assert.equal(res.inserted, false, "should dedup against the deprecated rule");

    const dupes = listAllLearningRules(app, 50).filter((r) => r.trigger === trigger && r.action === action);
    assert.equal(dupes.length, 1, "no duplicate row should be created");
  });
});

import { correctionToRuleUpsert, distillReviewerCorrections } from "./distiller";

describe("correctionToRuleUpsert", () => {
  it("classifies via the anti-pattern catalog and falls back to E-REVIEWER-REJECTED", () => {
    const fragile = correctionToRuleUpsert({ correction: "uses a fragile selector on the cart row", runId: "run-1" });
    assert.equal(fragile?.errorClass, "E-FRAGILE-SELECTOR");
    assert.equal(fragile?.action, "uses a fragile selector on the cart row");

    const generic = correctionToRuleUpsert({ correction: "the spec misnames the flow", runId: "run-1" });
    assert.equal(generic?.errorClass, "E-REVIEWER-REJECTED");

    assert.equal(correctionToRuleUpsert({ correction: "   ", runId: "run-1" }), null);
  });
});

import { normalizeTrigger, isWellFormedTrigger, reflectionToRuleUpsert } from "./distiller";

describe("normalizeTrigger — canonical 'Applies when …' form", () => {
  it("prefixes bare prose and decapitalizes an ordinary leading word", () => {
    assert.equal(normalizeTrigger("the diff adds a form"), "Applies when the diff adds a form");
    assert.equal(normalizeTrigger("The diff adds a form"), "Applies when the diff adds a form");
  });

  it("preserves acronyms and code identifiers in the leading position", () => {
    assert.equal(normalizeTrigger("API returns 500 on submit"), "Applies when API returns 500 on submit");
    assert.equal(normalizeTrigger("getByRole misses the dialog"), "Applies when getByRole misses the dialog");
    // TitleCase class names (internal capital) must be preserved — only single Title-case words decapitalize.
    assert.equal(normalizeTrigger("FormData is sent without encoding"), "Applies when FormData is sent without encoding");
  });

  it("is idempotent and normalizes prefix casing + whitespace", () => {
    assert.equal(normalizeTrigger("Applies when the diff adds a form"), "Applies when the diff adds a form");
    assert.equal(normalizeTrigger("applies WHEN the diff changes"), "Applies when the diff changes");
    assert.equal(normalizeTrigger("  the   diff   changes  "), "Applies when the diff changes");
  });

  it("returns empty for empty or prefix-only input", () => {
    assert.equal(normalizeTrigger(""), "");
    assert.equal(normalizeTrigger("   "), "");
    assert.equal(normalizeTrigger("Applies when"), "");
    assert.equal(normalizeTrigger("applies when   "), "");
  });
});

describe("isWellFormedTrigger", () => {
  it("accepts a prefixed trigger with a body and rejects everything else", () => {
    assert.equal(isWellFormedTrigger("Applies when the diff adds X"), true);
    assert.equal(isWellFormedTrigger("the diff adds X"), false);
    assert.equal(isWellFormedTrigger(""), false);
    assert.equal(isWellFormedTrigger("Applies when"), false);
  });
});

describe("distilled candidates carry a canonical trigger", () => {
  it("reflectionToRuleUpsert normalizes the trigger to 'Applies when …'", () => {
    const up = reflectionToRuleUpsert({
      app: "x",
      runId: "run-canon-1",
      reflection: reflection("the diff adds a form with no invalid-input test", "submit invalid data and assert the error"),
    });
    assert.equal(up.trigger, "Applies when the diff adds a form with no invalid-input test");
    assert.equal(isWellFormedTrigger(up.trigger), true);
  });

  it("correctionToRuleUpsert produces a canonical trigger", () => {
    const up = correctionToRuleUpsert({ correction: "uses a fragile selector on the cart row", runId: "run-canon-2" });
    assert.equal(isWellFormedTrigger(up!.trigger), true);
  });
});

describe("distilled candidates carry the run's structural archetype", () => {
  it("reflectionToRuleUpsert threads the archetype onto the candidate", () => {
    const up = reflectionToRuleUpsert({
      app: "x",
      runId: "run-arch-1",
      archetype: "form",
      reflection: reflection("the diff adds a form", "submit invalid data and assert the error"),
    });
    assert.equal(up.archetype, "form");
  });

  it("correctionToRuleUpsert threads the archetype onto the candidate", () => {
    const up = correctionToRuleUpsert({ correction: "uses a fragile selector on the cart row", runId: "run-arch-2", archetype: "data-list" });
    assert.equal(up?.archetype, "data-list");
  });

  it("distillReflection persists the archetype end-to-end (DB round-trip)", () => {
    const app = `arch-rt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = distillReflection({ app, runId: "run-rt-1", archetype: "form", reflection: reflection("the diff adds a form", "assert the error") });
    assert.equal(res.inserted, true);
    const stored = listAllLearningRules(app, 10).find((r) => r.id === res.ruleId);
    assert.equal(stored?.archetype, "form", "archetype survives the upsert → read-back");
  });
});

describe("distillReviewerCorrections", () => {
  it("inserts one candidate per distinct correction and dedupes against ALL statuses", () => {
    // The SQLite DB persists across test runs on disk; suffix the app so re-running the
    // suite never trips the dedup on its own residue from a previous invocation.
    const app = `shop-f4-distill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const first = distillReviewerCorrections({
      app,
      runId: "run-aaaa1111",
      corrections: [
        "no real assertion on the outcome",
        "no real assertion on the outcome",
        "orphaned test data left behind",
      ],
    });
    assert.equal(first.inserted.length, 2);

    // Re-distilling the same corrections must insert nothing (dedup against ALL statuses).
    const second = distillReviewerCorrections({
      app,
      runId: "run-bbbb2222",
      corrections: ["no real assertion on the outcome"],
    });
    assert.equal(second.inserted.length, 0);
  });

  it("returns no inserts when all corrections are whitespace/empty", () => {
    const app = `shop-empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = distillReviewerCorrections({ app, runId: "run-cccc3333", corrections: ["   ", ""] });
    assert.deepEqual(result.inserted, []);
  });
});

// ── FIX 1a: distillReviewerCorrections inserts RETRIEVABLE candidates (de-poisoned by framing) ──
// Corrections must enter the DB as "candidate" — RETRIEVABLE — not the inert retired "pending"
// status. The de-poison is the "experimental — consider, not proven" framing in renderRulesForPrompt
// (exercise without authority), NOT exclusion from retrieval. These tests assert the END-TO-END
// EFFECT: a distilled correction-rule is actually selectable AND renders under the experimental header.

import { selectForRetrieval, renderRulesForPrompt } from "./learning-rule";

describe("FIX 1a: distilled correction-rules are RETRIEVABLE candidates rendered as experimental", () => {
  it("inserts as 'candidate' (not the retired 'pending') so the rule is on the promotion flywheel", () => {
    const app = `fix1a-cand-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = distillReviewerCorrections({
      app,
      runId: "run-fix1a-cand",
      corrections: ["uses a fragile selector on the submit button"],
    });
    assert.equal(result.inserted.length, 1, "one correction should produce one inserted rule");

    const inserted = listAllLearningRules(app, 50).find((r) => r.id === result.inserted[0]);
    assert.ok(inserted, "inserted rule must be retrievable via listAllLearningRules");
    assert.equal(inserted.status, "candidate", "correction-sourced rule must enter as 'candidate', not 'pending'");
  });

  it("EFFECT: the distilled rule is actually returned by the retrieval path (listLearningRules + selectForRetrieval)", () => {
    const app = `fix1a-retr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = distillReviewerCorrections({
      app,
      runId: "run-fix1a-retr",
      corrections: ["no real assertion on the outcome"],
    });
    const ruleId = result.inserted[0];
    assert.ok(ruleId, "a rule must have been inserted");

    // The retrieval list (the generator-injection path) MUST now include it (pending excluded it before).
    const retrievable = listLearningRules(app, 50);
    assert.ok(
      retrievable.some((r) => r.id === ruleId),
      "the distilled correction-rule must appear in the retrieval list (it was permanently dead as 'pending')",
    );
    // And the ranking selector must actually pick it (not just be eligible).
    const selected = selectForRetrieval(retrievable, { app });
    assert.ok(
      selected.some((r) => r.id === ruleId),
      "selectForRetrieval must return the candidate so the generator EXERCISES it",
    );
  });

  it("EFFECT: the candidate renders under the 'Experimental rules' header, NOT the proven/authoritative one", () => {
    const app = `fix1a-render-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = distillReviewerCorrections({
      app,
      runId: "run-fix1a-render",
      corrections: ["[fragile-selector] login.spec.ts: nth-child locator on the nav"],
    });
    const ruleId = result.inserted[0]!;
    const rendered = renderRulesForPrompt(listLearningRules(app, 50).filter((r) => r.id === ruleId));
    assert.match(rendered, /## Experimental rules \(unproven/, "must render under the experimental (de-poisoned) header");
    assert.doesNotMatch(rendered, /## Proven rules/, "an unpromoted correction-rule must NOT carry proven-rule authority");
  });
});
