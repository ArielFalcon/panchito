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

// ── B.3.5 — manifest.reconcile is ALWAYS called, even with zero specMetas ─────
// Legacy-faithful: manifest entries are built EXCLUSIVELY from specMetas (opencode-client.ts:
// 772-788), never from the bare specs[] list. A deliverable with specs but NO specMetas produces
// an EMPTY rawEntries array — reconcile still fires (so an empty entries array can prune/no-op
// per the port's own contract), but with nothing to upsert.
test("B.3.5: manifest.reconcile is called with [] when the deliverable carries specs but no specMetas", async () => {
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
  assert.deepEqual(reconcileArgs, [], "no specMetas -> no manifest entries synthesized from specs[] alone");
  assert.deepEqual(out.specs, ["flows/checkout.spec.ts"]);
});

// ── manifest-enrichment fix: entries are built from specMetas, stamped with changeRef ─────────
// Live-run root cause: the rewritten engine assembled rawEntries from deliverable.specs alone
// (objective:"", no targets/changeRef), which the real manifest schema (src/orchestrator/
// schemas.ts ManifestEntrySchema) always rejects — verdict=invalid on every real run that reached
// the static gate with a non-empty manifest. Faithful port of opencode-client.ts:772-788: entries
// come from specMetas (objective/flow/targets from the agent), changeRef stamped by the
// orchestrator from input.sha + input.intent?.type.
test("manifest entries are built from specMetas with objective/flow/targets + changeRef stamped from input.sha/intent.type", async () => {
  let reconcileArgs: ManifestEntry[] | undefined;
  const ports: GenerationPorts = {
    runtime: {
      openSession: async () => ({
        prompt: async () => ({
          output: JSON.stringify({
            specs: ["flows/checkout.spec.ts"],
            specMetas: [{ file: "flows/checkout.spec.ts", flow: "checkout", objective: "user can checkout", targets: ["CheckoutService.pay"] }],
          }),
        }),
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
      parseGenerator: () => ({
        specs: ["flows/checkout.spec.ts"],
        parsed: true,
        specMetas: [{ file: "flows/checkout.spec.ts", flow: "checkout", objective: "user can checkout", targets: ["CheckoutService.pay"] }],
      }),
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
  await useCase.generate({
    repo: "r",
    sha: "abc1234",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    needsReview: false,
    target: "e2e",
    mode: "diff",
    appName: "a",
    intent: { type: "feat", breaking: false, message: "add checkout", changedFiles: ["src/checkout.ts"] },
  });

  assert.equal(reconcileArgs?.length, 1);
  assert.deepEqual(reconcileArgs?.[0], {
    id: "checkout",
    file: "flows/checkout.spec.ts",
    flow: "checkout",
    objective: "user can checkout",
    targets: ["CheckoutService.pay"],
    changeRef: { sha: "abc1234", type: "feat" },
  });
});

test("manifest entry changeRef.type falls back to 'unknown' when input.intent is absent (matches legacy's input.intent?.type ?? \"unknown\")", async () => {
  let reconcileArgs: ManifestEntry[] | undefined;
  const ports: GenerationPorts = {
    runtime: {
      openSession: async () => ({
        prompt: async () => ({ output: "irrelevant — parseGenerator stub below drives the deliverable" }),
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
      parseGenerator: () => ({
        specs: ["flows/login.spec.ts"],
        parsed: true,
        specMetas: [{ file: "flows/login.spec.ts", flow: "login", objective: "user can log in", targets: ["AuthService.login"] }],
      }),
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
  await useCase.generate({
    repo: "r",
    sha: "def5678",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    needsReview: false,
    target: "e2e",
    mode: "manual",
    appName: "a",
    // no `intent` — manual mode, no commit classification
  });

  assert.equal(reconcileArgs?.[0]?.changeRef?.type, "unknown");
  assert.equal(reconcileArgs?.[0]?.changeRef?.sha, "def5678");
});

// ── missing-from-specMetas: legacy-faithful behavior pinned ────────────────────────────────────
// Legacy evidence (src/integrations/opencode-client.ts:772): the manifest-building loop is
// `verdict.specMetas.map(...)` — it iterates specMetas ONLY and never cross-references
// verdict.specs. A spec file the agent listed in specs[] but did NOT describe in specMetas[]
// gets NO manifest entry — silently, not an error (the spec file itself still executes; only its
// metadata entry is skipped). This test pins that a partial specMetas list (2 specs, 1 meta)
// yields exactly 1 manifest entry, not a synthesized default for the second.
test("a spec present in specs[] but ABSENT from specMetas[] gets NO manifest entry (legacy-faithful, opencode-client.ts:772)", async () => {
  let reconcileArgs: ManifestEntry[] | undefined;
  const ports: GenerationPorts = {
    runtime: {
      openSession: async () => ({
        prompt: async () => ({ output: "irrelevant — parseGenerator stub below drives the deliverable" }),
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
      parseGenerator: () => ({
        // Two specs written, but the agent's specMetas only describes ONE of them.
        specs: ["flows/checkout.spec.ts", "flows/login.spec.ts"],
        parsed: true,
        specMetas: [{ file: "flows/checkout.spec.ts", flow: "checkout", objective: "user can checkout", targets: ["CheckoutService.pay"] }],
      }),
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
    sha: "sha1",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    needsReview: false,
    target: "e2e",
    mode: "diff",
    appName: "a",
  });

  // Both specs are still reported in the deliverable's specs list (they were written to disk)...
  assert.deepEqual(out.specs, ["flows/checkout.spec.ts", "flows/login.spec.ts"]);
  // ...but only the one with specMetas coverage gets a manifest entry.
  assert.equal(reconcileArgs?.length, 1);
  assert.equal(reconcileArgs?.[0]?.flow, "checkout");
});

// ── manifest schema conformance: assembled entries satisfy the real static-gate schema ─────────
// Cross-checks the assembled entry shape against the ACTUAL ManifestEntrySchema the orchestrator's
// static gate validates (src/orchestrator/schemas.ts) — replicated here (qa-engine does not import
// from src/, per the src/-independence invariant) as the same field/type assertions the schema
// encodes: id/objective/flow non-empty strings, targets a non-empty array, changeRef.sha/type
// non-empty strings. This is the exact shape whose absence produced the live-run "invalid" verdict.
test("assembled manifest entries satisfy the real ManifestEntrySchema shape (objective/flow/targets non-empty, changeRef required)", async () => {
  let reconcileArgs: ManifestEntry[] | undefined;
  const ports: GenerationPorts = {
    runtime: {
      openSession: async () => ({
        prompt: async () => ({ output: "irrelevant" }),
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
      parseGenerator: () => ({
        specs: ["flows/checkout.spec.ts"],
        parsed: true,
        specMetas: [{ file: "flows/checkout.spec.ts", flow: "checkout", objective: "user can checkout", targets: ["CheckoutService.pay"] }],
      }),
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
  await useCase.generate({
    repo: "r",
    sha: "shaXYZ",
    diff: "d",
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    namespace: "ns",
    needsReview: false,
    target: "e2e",
    mode: "diff",
    appName: "a",
    intent: { type: "fix", breaking: false, message: "fix checkout bug", changedFiles: ["src/checkout.ts"] },
  });

  const entry = reconcileArgs?.[0];
  assert.ok(entry, "an entry was produced");
  // Replicates ManifestEntrySchema's field checks (src/orchestrator/schemas.ts:137-148).
  assert.ok(typeof entry?.id === "string" && entry.id.length > 0, "id: non-empty string");
  assert.ok(typeof entry?.objective === "string" && entry.objective.length > 0, "objective: non-empty string");
  assert.ok(typeof entry?.flow === "string" && entry.flow.length > 0, "flow: non-empty string");
  assert.ok(Array.isArray(entry?.targets) && entry.targets.length > 0, "targets: non-empty array");
  assert.ok(typeof entry?.changeRef === "object" && entry.changeRef !== null, "changeRef: present");
  assert.ok(typeof entry?.changeRef?.sha === "string" && entry.changeRef.sha.length > 0, "changeRef.sha: non-empty string");
  assert.ok(typeof entry?.changeRef?.type === "string" && entry.changeRef.type.length > 0, "changeRef.type: non-empty string");
});
