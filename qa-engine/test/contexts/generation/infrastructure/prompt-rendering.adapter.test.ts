// test/contexts/generation/infrastructure/prompt-rendering.adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PromptRenderingAdapter, type PromptBuilders } from "@contexts/generation/infrastructure/prompt-rendering.adapter.ts";
import type { ParallelWorkerInput, ReviewInput, OpencodeRunInput } from "@contexts/generation/application/ports/generation-ports.ts";

// Minimal fake builders — typed against the real PromptBuilders interface so a field mismatch
// is caught at compile time; the "as never" casts on the input shapes keep the stubs concise.
// NOTE: the specFileForFlow default here uses "flows/" (the real path) so the delegation test
// below can assert the real output rather than an invented "e2e/" string.
function makeBuilders(overrides: Partial<PromptBuilders>): PromptBuilders {
  return {
    buildWorkerPromptAssembled: (_w: ParallelWorkerInput) => ({ text: "", sectionSizes: {} }),
    buildReviewerPromptAssembled: (_i: ReviewInput) => ({ text: "", sectionSizes: {} }),
    buildExplorerPrompt: (_i: OpencodeRunInput) => "",
    specFileForFlow: (flow: string) => `flows/${flow}.spec.ts`,
    ...overrides,
  };
}

test("renderWorker delegates to buildWorkerPromptAssembled and returns its assembled text", () => {
  let seen: unknown = null;
  const adapter = new PromptRenderingAdapter(makeBuilders({
    buildWorkerPromptAssembled: (w) => { seen = w; return { text: "WORKER", sectionSizes: { task: 7 } }; },
  }));
  const out = adapter.renderWorker({ flow: "login" } as never);
  assert.ok(seen, "the builder must be called — a gutted impl FAILS this");
  assert.equal(out.text, "WORKER");
  assert.deepEqual(out.sectionSizes, { task: 7 }); // sectionSizes forwarded for telemetry (not dropped)
});

test("renderReviewer delegates to buildReviewerPromptAssembled and returns assembled text + sectionSizes", () => {
  let seen: unknown = null;
  const adapter = new PromptRenderingAdapter(makeBuilders({
    buildReviewerPromptAssembled: (i) => { seen = i; return { text: "REVIEWER", sectionSizes: { specs: 42 } }; },
  }));
  const out = adapter.renderReviewer({ diff: "x", specs: ["a.spec.ts"] } as never);
  assert.ok(seen, "the reviewer builder must be called — a gutted impl FAILS this");
  assert.equal(out.text, "REVIEWER");
  assert.deepEqual(out.sectionSizes, { specs: 42 });
});

test("renderExplorer delegates to buildExplorerPrompt and returns its string", () => {
  let seen: unknown = null;
  const adapter = new PromptRenderingAdapter(makeBuilders({
    buildExplorerPrompt: (i) => { seen = i; return "EXPLORER"; },
  }));
  const out = adapter.renderExplorer({ repo: "o/a" } as never);
  assert.ok(seen, "buildExplorerPrompt must be called — a gutted impl FAILS this");
  assert.equal(out, "EXPLORER");
});

test("specFileForFlow delegates to the injected builder — delegation captured and path forwarded", () => {
  // The real specFileForFlow (src/integrations/prompts.ts:specFileForFlow) returns "flows/<safe>.spec.ts",
  // NOT "e2e/". A gutted impl that hardcodes "e2e/checkout.spec.ts" FAILS both assertions below:
  // (1) the seen flag is false if the builder was never called, and
  // (2) the output must match what the injected builder returns, not an invented path.
  let seen = false;
  const adapter = new PromptRenderingAdapter(makeBuilders({
    specFileForFlow: (flow: string) => { seen = true; return `flows/${flow}.spec.ts`; },
  }));
  const result = adapter.specFileForFlow("checkout");
  assert.ok(seen, "the injected specFileForFlow builder must be called — a gutted impl FAILS this");
  assert.equal(result, "flows/checkout.spec.ts",
    "output must match the builder's 'flows/' prefix — a hardcoded 'e2e/' impl FAILS this");
});
