import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildReflectionPrompt, parseStructuredReflection } from "./reflector";

const VALID_REFLECTION = {
  goal: "the diff added a form but the run tested only page load",
  decision: "asserted the heading is visible",
  assumption: "a visible page means the behavior works",
  errorClass: "E-FRAGILE-SELECTOR",
  gateSignal: "execution: 2 of 6 failed",
  evidence: "expect(locator).toBeVisible() on a static element",
  rootCause: "no behavioral assertion was generated",
  preventiveRule: { trigger: "Applies when the diff adds a form", action: "submit invalid input and assert the validation error" },
};

describe("buildReflectionPrompt", () => {
  it("instructs the model to phrase the trigger as an 'Applies when …' condition", () => {
    const prompt = buildReflectionPrompt({
      errorClass: "E-FRAGILE-SELECTOR",
      gateSignals: {
        static: true,
        coverageRatio: null,
        valueScore: null,
        reviewerCorrections: [],
        flaky: false,
        retries: 0,
      },
      verdict: "fail",
      sha: "abc123",
      mode: "diff",
    });
    // Target the instruction line specifically — not the JSON template, which also contains the phrase —
    // so a regression in the imperative phrasing can't be masked by the example.
    assert.match(prompt, /Start with "Applies when/);
    assert.match(prompt, /E-FRAGILE-SELECTOR/);
  });
});

describe("parseStructuredReflection", () => {
  it("extracts a reflection wrapped in a ```json fence (the reflectAndDistill failure case)", () => {
    // The qa-reflector is told 'no markdown' but does not always comply; a raw JSON.parse on this
    // throws "Unexpected token '`'". The robust extractor must recover the object instead.
    const raw = "```json\n" + JSON.stringify(VALID_REFLECTION) + "\n```";
    const r = parseStructuredReflection(raw);
    assert.ok(r, "must recover the reflection from a fenced block");
    assert.equal(r!.errorClass, "E-FRAGILE-SELECTOR");
    assert.equal(r!.preventiveRule.trigger, VALID_REFLECTION.preventiveRule.trigger);
  });

  it("parses a bare JSON object", () => {
    assert.ok(parseStructuredReflection(JSON.stringify(VALID_REFLECTION)));
  });

  it("recovers the object when the model adds prose around it", () => {
    const raw = "Here is the reflection you asked for:\n" + JSON.stringify(VALID_REFLECTION) + "\nLet me know if you need more.";
    assert.ok(parseStructuredReflection(raw));
  });

  it("returns null when a required field is missing (no half-built reflection)", () => {
    const { rootCause: _omit, ...partial } = VALID_REFLECTION;
    assert.equal(parseStructuredReflection(JSON.stringify(partial)), null);
  });

  it("returns null (never throws) on non-JSON or truncated output", () => {
    assert.equal(parseStructuredReflection("not json at all"), null);
    assert.equal(parseStructuredReflection("```json\n{ \"goal\": \"truncated"), null);
  });
});
