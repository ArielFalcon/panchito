import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildReflectionPrompt } from "./reflector";

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
