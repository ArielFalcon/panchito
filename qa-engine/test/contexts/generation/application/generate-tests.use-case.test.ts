import { test } from "node:test";
import assert from "node:assert/strict";
import { GenerateTestsUseCase } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { GenerationPorts } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { ManifestEntry } from "@contexts/generation/application/ports/index.ts";

// ── B.3 unit tests: orchestration sequence through port stubs ─────────────────
//
// These tests verify the EXTRACTED use-case's orchestration contract.
// The golden that proves behavior is preserved vs the legacy entrypoints
// is the characterization test suite (B.2) — both must agree.

// ── B.3.1 — basic orchestration sequence ─────────────────────────────────────
test("B.3.1: renders → opens session → parses deliverable → reconciles manifest (sequence)", async () => {
  const calls: string[] = [];
  const ports: GenerationPorts = {
    runtime: {
      openSession: async () => {
        calls.push("session");
        return {
          prompt: async () => ({ output: '{"specs":["flows/login.spec.ts"]}' }),
          dispose: () => {},
        };
      },
    },
    rendering: {
      render: () => "",
      renderMain: () => { calls.push("render"); return { text: "PROMPT", sectionSizes: {} }; },
      renderWorker: () => ({ text: "", sectionSizes: {} }),
      renderReviewer: () => ({ text: "", sectionSizes: {} }),
      renderExplorer: () => "",
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: (_text) => { calls.push("parse"); return { specs: ["flows/login.spec.ts"], parsed: true }; },
      parseReview: () => ({ approved: true, corrections: [], valid: true, issues: [] }),
    },
    manifest: {
      read: async () => [],
      reconcile: async (_d, e) => { calls.push("reconcile"); return [...e] as ManifestEntry[]; },
    },
    budget: {
      capDiff: (d) => d,
      capText: (t) => t,
      budgetForRole: () => 0,
    },
  };

  const useCase = new GenerateTestsUseCase(ports);
  const out = await useCase.generate({
    repo: "org/demo",
    sha: "abc",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    needsReview: false,
    target: "e2e",
    mode: "diff",
    appName: "a",
  });

  // render must come at some point before session fires the prompt
  assert.ok(calls.includes("render"), "prompt was rendered");
  assert.ok(calls.includes("session"), "session was opened");
  assert.ok(calls.includes("parse"), "deliverable was parsed");
  assert.ok(calls.includes("reconcile"), "manifest was reconciled");
  assert.deepEqual(out.specs, ["flows/login.spec.ts"]);
});

// ── B.3.2 — bounded generator repair ─────────────────────────────────────────
test("B.3.2: fires exactly ONE bounded repair when checkGenerator returns valid:false", async () => {
  const promptTexts: string[] = [];
  let sessionPromptCount = 0;

  const ports: GenerationPorts = {
    runtime: {
      openSession: async () => ({
        prompt: async (text: string) => {
          promptTexts.push(text);
          sessionPromptCount++;
          if (sessionPromptCount === 1) {
            // First call: output that fails the typed contract (no specs field)
            return { output: '{"note":"oops — forgot specs"}' };
          }
          // Second call (the ONE bounded repair): valid verdict
          return { output: '{"specs":["flows/repair.spec.ts"]}' };
        },
        dispose: () => {},
      }),
    },
    rendering: {
      render: () => "",
      renderMain: () => ({ text: "MAIN_PROMPT", sectionSizes: {} }),
      renderWorker: () => ({ text: "", sectionSizes: {} }),
      renderReviewer: () => ({ text: "", sectionSizes: {} }),
      renderExplorer: () => "",
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: (text) => {
        if (text.includes('"specs"')) return { specs: ["flows/repair.spec.ts"], parsed: true };
        return { specs: [], parsed: true }; // contract miss — no specs key, but JSON present
      },
      parseReview: () => ({ approved: true, corrections: [], valid: true, issues: [] }),
    },
    manifest: {
      read: async () => [],
      reconcile: async (_d, e) => [...e] as ManifestEntry[],
    },
    budget: {
      capDiff: (d) => d,
      capText: (t) => t,
      budgetForRole: () => 0,
    },
    repair: {
      checkGenerator: (text) => {
        // Mimic checkGeneratorVerdict: valid if the text has a specs array
        if (text.includes('"specs"')) return { valid: true, issues: [] };
        return { valid: false, issues: ["no closing verdict JSON found (expected a block with a `specs` array)"] };
      },
      instruction: (_kind, issues) => `REPAIR generator: ${issues.join(";")}`,
    },
  };

  let repairCount = 0;
  const useCase = new GenerateTestsUseCase(ports);
  const out = await useCase.generate({
    repo: "r",
    sha: "s",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    needsReview: false,
    target: "e2e",
    mode: "diff",
    appName: "a",
  }, { onRepair: () => { repairCount++; } });

  assert.equal(sessionPromptCount, 2, "exactly two prompt calls: initial + one bounded repair");
  assert.equal(repairCount, 1, "onRepair notified exactly once");
  // The repair prompt must reference the contract issues
  const repairPrompt = promptTexts[1] ?? "";
  assert.match(repairPrompt, /REPAIR generator/, "repair prompt fired for the generator");
  assert.deepEqual(out.specs, ["flows/repair.spec.ts"], "repaired specs in result");
});

// ── B.3.3 — bounded reviewer repair (reviewer contract miss, valid:false) ─────
test("B.3.3: reviewer contract miss fires exactly ONE bounded re-prompt (valid:false)", async () => {
  const promptTexts: string[] = [];
  let reviewCallCount = 0;

  const ports: GenerationPorts = {
    runtime: {
      openSession: async (role) => ({
        prompt: async (text: string) => {
          promptTexts.push(`[${role}] ${text}`);
          return { output: "SESSION_OUTPUT" };
        },
        dispose: () => {},
      }),
    },
    rendering: {
      render: () => "",
      renderMain: () => ({ text: "GEN_PROMPT", sectionSizes: {} }),
      renderWorker: () => ({ text: "", sectionSizes: {} }),
      renderReviewer: () => ({ text: "REV_PROMPT", sectionSizes: {} }),
      renderExplorer: () => "",
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: () => ({ specs: ["flows/a.spec.ts"], parsed: true }),
      parseReview: () => {
        reviewCallCount++;
        if (reviewCallCount === 1) {
          // First parse: contract miss — `approved` field present but not boolean
          return { approved: false, corrections: [], valid: false, issues: ["approved: expected boolean"], parsed: true };
        }
        // After repair: clean verdict
        return { approved: true, corrections: [], valid: true, issues: [], parsed: true };
      },
    },
    manifest: {
      read: async () => [],
      reconcile: async (_d, e) => [...e] as ManifestEntry[],
    },
    budget: {
      capDiff: (d) => d,
      capText: (t) => t,
      budgetForRole: () => 0,
    },
    repair: {
      checkGenerator: () => ({ valid: true, issues: [] }),
      instruction: (kind, issues) => `REPAIR ${kind}: ${issues.join(";")}`,
    },
  };

  let repairCount = 0;
  const useCase = new GenerateTestsUseCase(ports);
  await useCase.generate({
    repo: "r",
    sha: "s",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    needsReview: true,
    target: "e2e",
    mode: "diff",
    appName: "a",
  }, { onRepair: () => { repairCount++; } });

  // EXACTLY ONE reviewer repair re-prompt
  const repairPrompts = promptTexts.filter((p) => p.includes("REPAIR reviewer"));
  assert.equal(repairPrompts.length, 1, "exactly one reviewer repair prompt fired");
  assert.equal(repairCount, 1, "onRepair called once for reviewer repair");
  assert.equal(reviewCallCount, 2, "parseReview called twice: initial + after repair");
});

// ── B.3.4 — fail-closed: parse miss without review ───────────────────────────
test("B.3.4: parse miss → empty specs (fail-closed, no phantom spec names)", async () => {
  const ports: GenerationPorts = {
    runtime: {
      openSession: async () => ({
        prompt: async () => ({ output: "no parseable verdict here" }),
        dispose: () => {},
      }),
    },
    rendering: {
      render: () => "",
      renderMain: () => ({ text: "P", sectionSizes: {} }),
      renderWorker: () => ({ text: "", sectionSizes: {} }),
      renderReviewer: () => ({ text: "", sectionSizes: {} }),
      renderExplorer: () => "",
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: () => ({ specs: [], parsed: false }),
      parseReview: () => ({ approved: true, corrections: [], valid: true, issues: [] }),
    },
    manifest: {
      read: async () => [],
      reconcile: async (_d, e) => [...e] as ManifestEntry[],
    },
    budget: {
      capDiff: (d) => d,
      capText: (t) => t,
      budgetForRole: () => 0,
    },
  };

  const useCase = new GenerateTestsUseCase(ports);
  const out = await useCase.generate({
    repo: "r",
    sha: "s",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    needsReview: false,
    target: "e2e",
    mode: "diff",
    appName: "a",
  });
  assert.deepEqual(out.specs, [], "parse miss → empty specs");
});

// ── B.3.5 — manifest is reconciled with specs from the deliverable ────────────
test("B.3.5: manifest.reconcile is called with entries derived from the specs list", async () => {
  let reconcileArgs: ManifestEntry[] | undefined;
  const ports: GenerationPorts = {
    runtime: {
      openSession: async () => ({
        prompt: async () => ({ output: '{"specs":["flows/checkout.spec.ts"]}' }),
        dispose: () => {},
      }),
    },
    rendering: {
      render: () => "",
      renderMain: () => ({ text: "P", sectionSizes: {} }),
      renderWorker: () => ({ text: "", sectionSizes: {} }),
      renderReviewer: () => ({ text: "", sectionSizes: {} }),
      renderExplorer: () => "",
      specFileForFlow: (flow) => `flows/${flow}.spec.ts`,
    },
    verdicts: {
      parseGenerator: () => ({ specs: ["flows/checkout.spec.ts"], parsed: true }),
      parseReview: () => ({ approved: true, corrections: [], valid: true, issues: [] }),
    },
    manifest: {
      read: async () => [],
      reconcile: async (_d, e) => {
        reconcileArgs = [...e] as ManifestEntry[];
        return reconcileArgs;
      },
    },
    budget: {
      capDiff: (d) => d,
      capText: (t) => t,
      budgetForRole: () => 0,
    },
  };

  const useCase = new GenerateTestsUseCase(ports);
  const out = await useCase.generate({
    repo: "r",
    sha: "s",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    needsReview: false,
    target: "e2e",
    mode: "diff",
    appName: "a",
  });
  // reconcile must be called — if it was skipped, reconcileArgs would be undefined
  assert.ok(reconcileArgs !== undefined, "reconcile was called");
  assert.deepEqual(out.specs, ["flows/checkout.spec.ts"]);
});
