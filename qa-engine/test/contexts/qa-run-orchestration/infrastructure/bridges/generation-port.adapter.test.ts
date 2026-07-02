// test/contexts/qa-run-orchestration/infrastructure/bridges/generation-port.adapter.test.ts
// RED-first (Task E.0): GenerationPortAdapter must delegate to the REAL GenerateTestsUseCase.generate()
// and map {specs, reviewed, approved, note} -> {specs, approved, note}. specSources is populated from
// a file-read collaborator (file I/O stays OUTSIDE the domain, per fix-loop.aggregate.ts's own
// FixLoopGenerateResult.specSources contract) — absent/empty when the read collaborator is absent.
// reexploreNavigations has NO real sibling counter (confirmed absent under generation/) so this bridge
// omits it — the FixLoop's own documented contract treats absent as 0 (the safe default), never a
// fabricated number.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GenerationPortAdapter, renderLearnedRules, renderLearnedRulesForReviewer } from "@contexts/qa-run-orchestration/infrastructure/bridges/generation-port.adapter.ts";
import { Objective } from "@kernel/objective.ts";
import type { GenerationPorts, GenerationResult } from "@contexts/generation/application/generate-tests.use-case.ts";
import { GenerateTestsUseCase } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { OpencodeRunInput } from "@contexts/generation/application/ports/generation-ports.ts";
import type { RetrievedRule } from "@contexts/qa-run-orchestration/application/ports/index.ts";

function fakeGenerationPorts(overrides: {
  generatorOutput?: string;
  reviewerOutput?: string;
} = {}): GenerationPorts {
  return {
    runtime: {
      openSession: async () => ({
        prompt: async () => ({ output: overrides.generatorOutput ?? "generator-json" }),
        dispose: async () => {},
      }),
    } as unknown as GenerationPorts["runtime"],
    rendering: {
      render: () => "",
      renderMain: () => ({ text: "prompt", sectionSizes: {} }),
      renderWorker: () => ({ text: "", sectionSizes: {} }),
      renderReviewer: () => ({ text: "reviewer-prompt", sectionSizes: {} }),
      renderExplorer: () => "",
      specFileForFlow: (flow: string) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: () => ({ specs: ["flows/checkout.spec.ts"], note: "ok" }),
      parseReview: () => ({ approved: true, corrections: [], parsed: true, valid: true, issues: [] }),
    },
    manifest: {
      read: async () => [],
      reconcile: async (_specDir, entries) => [...entries],
    },
    budget: {
      capDiff: (d: string) => d,
      capText: (t: string) => t,
      budgetForRole: () => 1000,
    },
  };
}

test("generate() delegates to GenerateTestsUseCase and maps GenerationResult onto the port shape", async () => {
  const ports = fakeGenerationPorts();
  const useCase = new GenerateTestsUseCase(ports);
  const adapter = new GenerationPortAdapter(useCase, {
    repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
  });

  const objectives = [Objective.of({ flow: "checkout", objective: "user can checkout", targets: [] })];
  const result = await adapter.generate(objectives, "/mirrors/org/app/e2e");

  assert.deepEqual(result.specs, ["flows/checkout.spec.ts"]);
  assert.equal(result.approved, true);
  assert.equal(result.note, "ok");
});

test("generate() surfaces approved:false with a note when the reviewer rejects (needsReview:true)", async () => {
  const ports = fakeGenerationPorts();
  ports.verdicts.parseReview = () => ({
    approved: false, corrections: ["fix X"], rationale: "missing assertion", parsed: true, valid: true, issues: [],
  });
  const useCase = new GenerateTestsUseCase(ports);
  const adapter = new GenerationPortAdapter(useCase, {
    repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234", needsReview: true, target: "e2e", mode: "diff", diff: "",
  });

  const result = await adapter.generate([], "/mirrors/org/app/e2e");

  assert.equal(result.approved, false);
  assert.equal(result.note, "missing assertion");
});

test("generate() populates specSources from an injected file-read collaborator (absent by default)", async () => {
  const ports = fakeGenerationPorts();
  const useCase = new GenerateTestsUseCase(ports);
  const readSpecSource = async (path: string): Promise<string> => `// source of ${path}`;
  const adapter = new GenerationPortAdapter(
    useCase,
    { repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e", namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "" },
    { readSpecSource },
  );

  const result = await adapter.generate([], "/mirrors/org/app/e2e");

  assert.deepEqual(result.specSources, ["// source of /mirrors/org/app/e2e/flows/checkout.spec.ts"]);
});

test("generate() omits specSources when no readSpecSource collaborator is injected", async () => {
  const ports = fakeGenerationPorts();
  const useCase = new GenerateTestsUseCase(ports);
  const adapter = new GenerationPortAdapter(useCase, {
    repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
  });

  const result = await adapter.generate([], "/mirrors/org/app/e2e");

  assert.equal(result.specSources, undefined);
});

// ── Plan 7.2 — leaf-signal forwarding (closes engram #916): GenerateTestsUseCase.generate()
// already forwards opts?.signal into runtime.openSession(role, mirrorDir, { signal }) for BOTH the
// generator and reviewer sessions (Plan 7.1 territory, untouched here) — this adapter is the ONLY
// missing link. It must declare + forward the signal into GenerateTestsUseCase.generate(input,
// opts), or the queue's AbortSignal is silently dropped before it ever reaches the agent session.

test("generate() forwards an AbortSignal into GenerateTestsUseCase.generate()'s GenerateOpts", async () => {
  const controller = new AbortController();
  const capturedSignals: (AbortSignal | undefined)[] = [];
  const ports = fakeGenerationPorts();
  ports.runtime.openSession = async (_role, _mirrorDir, opts) => {
    capturedSignals.push(opts?.signal);
    return {
      prompt: async () => ({ output: "generator-json" }),
      dispose: async () => {},
    };
  };
  const useCase = new GenerateTestsUseCase(ports);
  const adapter = new GenerationPortAdapter(useCase, {
    repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
  });

  await adapter.generate([], "/mirrors/org/app/e2e", controller.signal);

  assert.ok(capturedSignals.length > 0, "openSession must have been called at least once");
  for (const captured of capturedSignals) {
    assert.equal(captured, controller.signal, "the SAME AbortSignal instance passed to generate() must reach GenerateTestsUseCase's own opts.signal, not be dropped at the bridge");
  }
});

test("generate() with no signal at all behaves exactly as before (no third-arg regression)", async () => {
  const ports = fakeGenerationPorts();
  const useCase = new GenerateTestsUseCase(ports);
  const adapter = new GenerationPortAdapter(useCase, {
    repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
  });

  const result = await adapter.generate([], "/mirrors/org/app/e2e");

  assert.deepEqual(result.specs, ["flows/checkout.spec.ts"]);
  assert.equal(result.approved, true);
});

// ── "Dynamic diff" fix (engram #936): the real production engineFactory constructs this adapter
// BEFORE the run/checkout, so the STATIC ctx.diff supplied at composition time is always "". This
// bridge must accept the run's ACTUAL diff as a fourth generate() argument and PREFER it over the
// static ctx.diff — falling back to ctx.diff only when the caller omits the argument (keeps the
// F.2 operator, which pre-computes ctx.diff before building CompositionConfig, working unchanged).

test("generate() PREFERS a dynamic diff argument over the static ctx.diff supplied at construction time", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "STALE-STATIC-DIFF",
    });

    await adapter.generate([], "/mirrors/org/app/e2e", undefined, "REAL-DYNAMIC-DIFF");

    assert.equal(capturedInput?.diff, "REAL-DYNAMIC-DIFF", "a diff argument passed to generate() must win over the static ctx.diff, matching the run's actual commit diff");
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

test("generate() FALLS BACK to the static ctx.diff when no dynamic diff argument is supplied (preserves the F.2 operator's own pre-computed-diff path)", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "OPERATOR-PRECOMPUTED-DIFF",
    });

    await adapter.generate([], "/mirrors/org/app/e2e");

    assert.equal(capturedInput?.diff, "OPERATOR-PRECOMPUTED-DIFF", "omitting the diff argument must fall back to ctx.diff unchanged — the operator's own pre-computed-diff composition must keep working");
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

// ── W2 fix (F1, generation regen/enrichment context): the adapter's new optional 5th `enrichment`
// argument must map EVERY field 1:1 onto OpencodeRunInput — absent fields stay absent, present
// fields flow through unchanged (never re-derived, never dropped).

test("generate() maps enrichment.reviewCorrections/fixCases/selectorContradictions/domSnapshot/coverageGap/intent onto OpencodeRunInput", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
    });

    await adapter.generate([], "/mirrors/org/app/e2e", undefined, "the-diff", {
      reviewCorrections: ["fix the assertion"],
      fixCases: [{ name: "login", status: "fail", detail: "timed out" }],
      selectorContradictions: ["role:button is NOT in the tree"],
      domSnapshot: "- button \"Submit\"",
      coverageGap: "src/x.ts:12-15 not exercised",
      intent: { type: "feat", breaking: false, message: "add checkout", changedFiles: ["src/x.ts"] },
    });

    assert.deepEqual(capturedInput?.reviewCorrections, ["fix the assertion"]);
    assert.deepEqual(capturedInput?.fixCases, [{ name: "login", status: "fail", detail: "timed out" }]);
    assert.deepEqual(capturedInput?.selectorContradictions, ["role:button is NOT in the tree"]);
    assert.equal(capturedInput?.domSnapshot, "- button \"Submit\"");
    assert.equal(capturedInput?.coverageGap, "src/x.ts:12-15 not exercised");
    assert.deepEqual(capturedInput?.intent, { type: "feat", breaking: false, message: "add checkout", changedFiles: ["src/x.ts"] });
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

// ── Plan 7-R W4 (audit CRITICAL): enrichment.contextPack/existingSpecFiles (PreGenerationGroundingPort,
// run-qa.use-case.ts) must map 1:1 onto OpencodeRunInput — the SAME fields buildPromptAssembled
// already renders sections for (contextPack's "VOLATILE context-pack section" / existingSpecFiles'
// "existing-suite-manifest" section, generation-ports.ts).

test("generate() maps enrichment.contextPack/existingSpecFiles onto OpencodeRunInput", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
    });

    await adapter.generate([], "/mirrors/org/app/e2e", undefined, "the-diff", {
      contextPack: "## Context Pack\n\nblast radius...",
      existingSpecFiles: ["flows/checkout.spec.ts", "home.spec.ts"],
    });

    assert.equal(capturedInput?.contextPack, "## Context Pack\n\nblast radius...");
    assert.deepEqual(capturedInput?.existingSpecFiles, ["flows/checkout.spec.ts", "home.spec.ts"]);
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

test("generate() with absent enrichment.contextPack/existingSpecFiles omits both from OpencodeRunInput (never fabricated)", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
    });

    await adapter.generate([], "/mirrors/org/app/e2e", undefined, "the-diff", {});

    assert.equal(capturedInput?.contextPack, undefined);
    assert.equal(capturedInput?.existingSpecFiles, undefined);
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

// ── Manifest-enrichment fix: enrichment.sha must reach OpencodeRunInput.sha so
// GenerateTestsUseCase can stamp ManifestEntry.changeRef.sha (previously hardcoded to "" here,
// which made every manifest entry fail the real schema's changeRef.sha non-empty check).

test("generate() maps enrichment.sha onto OpencodeRunInput.sha", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
    });

    await adapter.generate([], "/mirrors/org/app/e2e", undefined, "the-diff", { sha: "abc1234def" });

    assert.equal(capturedInput?.sha, "abc1234def");
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

test("generate() with no enrichment.sha falls back to empty string (today's behavior, until run-qa.use-case.ts threads it)", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
    });

    await adapter.generate([], "/mirrors/org/app/e2e");

    assert.equal(capturedInput?.sha, "");
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

test("generate() with no enrichment argument omits every enrichment field from OpencodeRunInput (unchanged prompt)", async () => {
  const ports = fakeGenerationPorts();
  let capturedInput: OpencodeRunInput | undefined;
  const originalGenerate = GenerateTestsUseCase.prototype.generate;
  GenerateTestsUseCase.prototype.generate = async function (input: OpencodeRunInput, opts) {
    capturedInput = input;
    return originalGenerate.call(this, input, opts);
  };
  try {
    const useCase = new GenerateTestsUseCase(ports);
    const adapter = new GenerationPortAdapter(useCase, {
      repo: "org/app", appName: "app", mirrorDir: "/mirrors/org/app", e2eRelDir: "e2e",
      namespace: "qa-bot-abc1234", needsReview: false, target: "e2e", mode: "diff", diff: "",
    });

    await adapter.generate([], "/mirrors/org/app/e2e");

    assert.equal(capturedInput?.reviewCorrections, undefined);
    assert.equal(capturedInput?.fixCases, undefined);
    assert.equal(capturedInput?.selectorContradictions, undefined);
    assert.equal(capturedInput?.domSnapshot, undefined);
    assert.equal(capturedInput?.coverageGap, undefined);
    assert.equal(capturedInput?.intent, undefined);
  } finally {
    GenerateTestsUseCase.prototype.generate = originalGenerate;
  }
});

// ── W3 F2 (dual-judge round): renderLearnedRules is a FAITHFUL, byte-comparable port of legacy's
// renderRulesForPrompt (src/qa/learning/learning-rule.ts:237-270) — same section headers, same
// framing sentences, same proven/experimental split, same per-rule field layout. ──────────────────

const activeRule: RetrievedRule = {
  trigger: "selector absent", action: "use role+name", errorClass: "E-EXEC-FAIL",
  status: "active", confidence: "high",
};
const candidateRule: RetrievedRule = {
  trigger: "flaky wait", action: "use expect.poll", errorClass: "E-FLAKY",
  status: "candidate", confidence: "low",
};

test("renderLearnedRules: active-only rule set matches legacy's renderRulesForPrompt byte-for-byte", () => {
  const rendered = renderLearnedRules([activeRule]);

  assert.equal(
    rendered,
    [
      "## Proven rules from past QA runs",
      "These rules were earned from real failures and validated by measured outcomes. Apply them when they match the current change.",
      "",
      "### Rule (E-EXEC-FAIL, confidence=high)",
      "- Trigger: selector absent",
      "- Action: use role+name",
      "",
    ].join("\n"),
  );
});

test("renderLearnedRules: candidate-only rule set uses the experimental framing, not the proven one", () => {
  const rendered = renderLearnedRules([candidateRule]);

  assert.equal(
    rendered,
    [
      "## Experimental rules (unproven — consider, not prescriptive)",
      "These are hypotheses from recent runs that have not yet been validated by enough measured outcomes. Consider them when clearly applicable, but do not let them override your judgment.",
      "",
      "### Experimental rule (E-FLAKY)",
      "- Trigger: flaky wait",
      "- Consider: use expect.poll",
      "",
    ].join("\n"),
  );
});

test("renderLearnedRules: mixed active+candidate renders BOTH sections, proven first, byte-for-byte", () => {
  const rendered = renderLearnedRules([activeRule, candidateRule]);

  assert.equal(
    rendered,
    [
      "## Proven rules from past QA runs",
      "These rules were earned from real failures and validated by measured outcomes. Apply them when they match the current change.",
      "",
      "### Rule (E-EXEC-FAIL, confidence=high)",
      "- Trigger: selector absent",
      "- Action: use role+name",
      "",
      "## Experimental rules (unproven — consider, not prescriptive)",
      "These are hypotheses from recent runs that have not yet been validated by enough measured outcomes. Consider them when clearly applicable, but do not let them override your judgment.",
      "",
      "### Experimental rule (E-FLAKY)",
      "- Trigger: flaky wait",
      "- Consider: use expect.poll",
      "",
    ].join("\n"),
  );
});

test("renderLearnedRules: empty input renders the empty string (matches legacy's early return)", () => {
  assert.equal(renderLearnedRules([]), "");
});

// ── W3 F2 (dual-judge round): renderLearnedRulesForReviewer is a FAITHFUL, byte-comparable port of
// legacy's renderRulesForReviewer (src/qa/learning/learning-rule.ts:299-313) — active-only (never
// candidates), the 2 framing sentences verbatim, and the `- trigger → action (errorClass)` line
// format. ────────────────────────────────────────────────────────────────────────────────────────

test("renderLearnedRulesForReviewer: active rule matches legacy's renderRulesForReviewer byte-for-byte", () => {
  const rendered = renderLearnedRulesForReviewer([activeRule]);

  assert.equal(
    rendered,
    [
      "## App-specific reject-on-sight rules (earned from past runs on this app)",
      "Each was learned from a real failure and proven by the value oracle or sustained prevention.",
      "Treat them as an extension of the anti-pattern catalog: if a spec violates one, REJECT.",
      "",
      "- selector absent → use role+name (E-EXEC-FAIL)",
    ].join("\n"),
  );
});

test("renderLearnedRulesForReviewer: candidate-only input renders '' — unproven rules never gate the reviewer", () => {
  assert.equal(renderLearnedRulesForReviewer([candidateRule]), "");
});

test("renderLearnedRulesForReviewer: a mixed set renders ONLY the active rule's line", () => {
  const rendered = renderLearnedRulesForReviewer([activeRule, candidateRule]);

  assert.ok(rendered.includes("- selector absent → use role+name (E-EXEC-FAIL)"));
  assert.ok(!rendered.includes("flaky wait"), "candidate rules must never appear in the reviewer's reject-on-sight list");
});

test("renderLearnedRulesForReviewer: empty input renders the empty string", () => {
  assert.equal(renderLearnedRulesForReviewer([]), "");
});
