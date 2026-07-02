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
import { GenerationPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/generation-port.adapter.ts";
import { Objective } from "@kernel/objective.ts";
import type { GenerationPorts, GenerationResult } from "@contexts/generation/application/generate-tests.use-case.ts";
import { GenerateTestsUseCase } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { OpencodeRunInput } from "@contexts/generation/application/ports/generation-ports.ts";

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
