// CHARACTERIZATION: pins the CURRENT opencode-client generate→review→reconcile outcome BEFORE the
// GenerateTestsUseCase extraction (design §7.2 Step 8). Drives runOpencode/generateParallel through a
// stub AgentDeps; asserts the (specs, manifest, review) outcome. Reuses existing fixtures. Imports from
// src/ → excluded from qa-engine typecheck; runs via tsx. This is the golden the extracted use-case must match.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runOpencode,
  reviewIndependently,
  generateParallel,
} from "../../../../../src/integrations/opencode-client.ts";
import type {
  AgentDeps,
  OpencodeRunInput,
  ReviewInput,
  ParallelWorkerInput,
  ManifestFs,
} from "../../../../../src/integrations/opencode-client.ts";

// ── Shared fixture ───────────────────────────────────────────────────────────
const baseInput: OpencodeRunInput = {
  repo: "org/demo",
  sha: "abc123",
  diff: "diff --git a/x b/x\n+const x = 1;",
  mirrorDir: "/mirrors/org__demo",
  e2eRelDir: "e2e",
  namespace: "qa-bot-abc123",
  needsReview: true,
  target: "e2e",
  mode: "diff",
  appName: "demo-app",
  intent: { type: "feat", breaking: false, message: "feat: new screen", changedFiles: ["src/x.ts"] },
};

function makeAgentDeps(responses: Record<string, string | ((text: string) => string)>): AgentDeps {
  return {
    open: async (agent) => ({
      id: `s-${agent}`,
      prompt: async (text: string) => {
        const r = responses[agent];
        if (r === undefined) throw new Error(`Unexpected agent: ${agent}`);
        return typeof r === "function" ? r(text) : r;
      },
      dispose: async () => {},
    }),
  };
}

// ── B.2.1 — runOpencode: single-agent approved path ──────────────────────────
//
// Characterizes the CURRENT generate→verdict outcome: the generator session returns specs,
// the verdict is parsed, approved=true is forwarded.
test("CHAR B.2.1: runOpencode single-agent → approved result with specs list", async () => {
  const deps = makeAgentDeps({
    "qa-generator": '{"specs":["flows/login.spec.ts"]}',
  });
  const result = await runOpencode({ ...baseInput, needsReview: false }, deps);
  assert.equal(result.approved, true, "review disabled → approved");
  assert.deepEqual(result.specs, ["flows/login.spec.ts"], "specs forwarded from verdict");
  assert.equal(result.reviewed, false, "no review requested → reviewed:false");
});

// ── B.2.2 — runOpencode: fail-closed on parse miss ───────────────────────────
//
// When the agent emits no parseable verdict JSON, the outcome must be fail-closed (no approval)
// and the parse miss must be distinguishable from an explicit rejection. This is the #1 invariant.
test("CHAR B.2.2: runOpencode fail-closed on parse miss (no verdict JSON)", async () => {
  const deps = makeAgentDeps({
    "qa-generator": "sorry, I could not determine what to write",
  });
  // With needsReview:false the generator's output is not reviewed — but a parse miss still
  // yields an empty specs list (the agent wrote nothing we can trust).
  const result = await runOpencode({ ...baseInput, needsReview: false }, deps);
  assert.deepEqual(result.specs, [], "parse miss → empty specs (no phantom spec names)");
});

// ── B.2.3 — reviewIndependently: approved result with corrections ─────────────
//
// Characterizes the reviewer path: the reviewer session returns approved=true, corrections=[],
// parsed=true, valid=true. The use-case must propagate these to the publish gate.
test("CHAR B.2.3: reviewIndependently → approved:true, blockingCount:0, parsed:true", async () => {
  const reviewInput: ReviewInput = {
    diff: "diff --git a/x b/x\n+const x = 1;",
    specs: ["flows/login.spec.ts"],
    mirrorDir: "/mirrors/org__demo",
    e2eRelDir: "e2e",
    appName: "demo-app",
    mode: "diff",
  };
  const deps = makeAgentDeps({
    "qa-reviewer": '{"approved":true,"rationale":"tests are correct","corrections":[]}',
  });
  const result = await reviewIndependently(reviewInput, deps);
  assert.equal(result.approved, true, "reviewer approved");
  assert.deepEqual(result.corrections, [], "no corrections");
  assert.equal(result.blockingCount, 0, "zero blocking corrections");
  assert.equal(result.parsed, true, "verdict was parseable");
});

// ── B.2.4 — reviewIndependently: one bounded repair on contract miss (valid:false) ──
//
// When the reviewer's first response has an `approved` field but fails the typed schema,
// the legacy code re-prompts ONCE (opencode-client.ts:983-989). The second response
// is the clean verdict. The use-case must fire exactly ONE repair, never an unbounded loop.
test("CHAR B.2.4: reviewIndependently fires exactly ONE bounded repair re-prompt on contract miss", async () => {
  const reviewInput: ReviewInput = {
    diff: "d",
    specs: ["flows/x.spec.ts"],
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    appName: "a",
    mode: "diff",
  };
  const prompts: string[] = [];
  let callCount = 0;
  const deps: AgentDeps = {
    open: async () => ({
      id: "s-reviewer",
      prompt: async (text: string) => {
        prompts.push(text);
        callCount++;
        if (callCount === 1) {
          // First call: a verdict whose `approved` field is a string (fails schema → valid:false)
          return '{"approved":"yes","corrections":[]}';
        }
        // Second call (the ONE bounded repair re-prompt): clean verdict
        return '{"approved":true,"rationale":"ok","corrections":[]}';
      },
      dispose: async () => {},
    }),
  };
  let repairCount = 0;
  const result = await reviewIndependently(reviewInput, deps, { onRepair: () => { repairCount++; } });
  assert.equal(callCount, 2, "exactly two prompt calls: initial + one bounded repair");
  assert.equal(repairCount, 1, "onRepair fired exactly once");
  assert.equal(result.approved, true, "clean verdict accepted after repair");
  assert.equal(result.parsed, true);
  // The repair prompt must name the schema issues (not generic prose)
  const repairPrompt = prompts[1] ?? "";
  assert.match(repairPrompt, /approved/, "repair prompt references the approved field");
});

// ── B.2.5 — reviewIndependently: fail-closed after two failed parses ──────────
//
// If BOTH the initial and the repair response are unparseable (no approved field at all),
// the outcome is approved:false, parsed:false (the parse-miss result).
test("CHAR B.2.5: reviewIndependently fail-closed after repair attempt also fails", async () => {
  const reviewInput: ReviewInput = {
    diff: "d",
    specs: ["flows/x.spec.ts"],
    mirrorDir: "/m",
    e2eRelDir: "e2e",
    appName: "a",
    mode: "diff",
  };
  const deps: AgentDeps = {
    open: async () => ({
      id: "s",
      prompt: async () => "no parseable JSON in either response",
      dispose: async () => {},
    }),
  };
  const result = await reviewIndependently(reviewInput, deps);
  assert.equal(result.approved, false, "fail-closed: no approval on total parse failure");
  assert.equal(result.parsed, false, "parse miss flagged");
  assert.equal(result.blockingCount, 0);
});

// ── B.2.6 — generateParallel: worker dispatch + on-disk phantom guard ─────────
//
// Workers report spec names; the function verifies each on disk via the injected specExists.
// A worker that returns a spec name but whose file is NOT on disk is a phantom — counted as error.
// A worker that returns no spec name is also an error.
test("CHAR B.2.6: generateParallel maps flow→spec and detects phantoms (specExists gate)", async () => {
  const workers: ParallelWorkerInput[] = [
    {
      objective: "login valid credentials reach the dashboard",
      flow: "login",
      symbols: ["AuthService.login"],
      needsUi: true,
      specFile: "flows/login.spec.ts",
      repo: "org/demo",
      mirrorDir: "/m",
      e2eRelDir: "e2e",
      namespace: "ns",
      appName: "demo",
      mode: "complete",
    },
    {
      objective: "checkout payment succeeds",
      flow: "checkout",
      symbols: ["CartService.pay"],
      needsUi: true,
      specFile: "flows/checkout.spec.ts",
      repo: "org/demo",
      mirrorDir: "/m",
      e2eRelDir: "e2e",
      namespace: "ns",
      appName: "demo",
      mode: "complete",
    },
  ];
  const deps: AgentDeps = {
    open: async () => ({
      id: "w",
      prompt: async (text: string) => {
        // login worker returns a valid spec; checkout worker returns a phantom (spec not on disk)
        if (text.includes("flows/login.spec.ts")) return '{"spec":"flows/login.spec.ts"}';
        return '{"spec":"flows/checkout.spec.ts"}';
      },
      dispose: async () => {},
    }),
  };
  // specExists: login lands on disk, checkout does not (phantom)
  const { results, errors } = await generateParallel(workers, deps, {
    concurrency: 1,
    specExists: (p) => p.includes("login"),
  });
  assert.deepEqual(results, [{ flow: "login", spec: "flows/login.spec.ts" }], "only on-disk spec counted");
  assert.equal(errors.length, 1, "phantom checkout generates an error entry");
  assert.match(errors[0]!, /checkout/, "error names the failing flow");
  assert.match(errors[0]!, /NOT on disk|phantom/, "error describes the phantom condition");
});

// ── B.2.7 — generateParallel: worker error isolation ─────────────────────────
//
// A worker that throws must not abort the other workers — errors are collected,
// successful workers are forwarded.
test("CHAR B.2.7: generateParallel isolates worker exceptions (other workers complete)", async () => {
  const workers: ParallelWorkerInput[] = [
    {
      objective: "login",
      flow: "login",
      symbols: [],
      needsUi: true,
      specFile: "flows/login.spec.ts",
      repo: "r",
      mirrorDir: "/m",
      e2eRelDir: "e2e",
      namespace: "ns",
      appName: "a",
      mode: "complete",
    },
    {
      objective: "crash",
      flow: "crash-flow",
      symbols: [],
      needsUi: true,
      specFile: "flows/crash-flow.spec.ts",
      repo: "r",
      mirrorDir: "/m",
      e2eRelDir: "e2e",
      namespace: "ns",
      appName: "a",
      mode: "complete",
    },
  ];
  const deps: AgentDeps = {
    open: async (_agent, _cwd) => ({
      id: "w",
      prompt: async (text: string) => {
        if (text.includes("crash-flow")) throw new Error("simulated worker crash");
        return '{"spec":"flows/login.spec.ts"}';
      },
      dispose: async () => {},
    }),
  };
  const { results, errors } = await generateParallel(workers, deps, {
    concurrency: 2,
    specExists: () => true,
  });
  assert.deepEqual(results, [{ flow: "login", spec: "flows/login.spec.ts" }], "login succeeds");
  assert.equal(errors.length, 1, "crash-flow error collected");
  assert.match(errors[0]!, /crash-flow/, "error identifies the failing flow");
});

// ── B.2.8 — runOpencode: generator bounded repair (checkGeneratorVerdict.valid:false) ──────
//
// When the generator's first response fails the typed contract (valid:false from checkGeneratorVerdict),
// the orchestrator re-prompts ONCE. The use-case must fire exactly one generator repair, never more.
test("CHAR B.2.8: runOpencode fires exactly ONE bounded repair on generator contract miss", async () => {
  const prompts: string[] = [];
  let callCount = 0;
  const deps: AgentDeps = {
    open: async () => ({
      id: "s-gen",
      prompt: async (text: string) => {
        prompts.push(text);
        callCount++;
        if (callCount === 1) {
          // First call: deliberately MISSING the `specs` key so checkGeneratorVerdict fires
          return '{"note":"done but forgot specs"}';
        }
        // Second call (the ONE bounded repair): valid verdict
        return '{"specs":["flows/repair.spec.ts"]}';
      },
      dispose: async () => {},
    }),
  };
  let repairCount = 0;
  const result = await runOpencode({ ...baseInput, needsReview: false }, deps, {
    onRepair: () => { repairCount++; },
  });
  assert.equal(callCount, 2, "two prompt calls: initial + one bounded repair");
  assert.equal(repairCount, 1, "onRepair notified once");
  // The repaired verdict is used for the final result
  assert.deepEqual(result.specs, ["flows/repair.spec.ts"], "repaired specs in result");
});

// ── B.2.9 — runOpencodeParallel (fan-out) empty plan: clean no-op ─────────────
//
// An empty plan (objectives=[]) is a valid no-op. The outcome must be approved:true, specs:[],
// and the manifest must NOT be written. This is the "skipped" path.
test("CHAR B.2.9: runOpencodeParallel empty plan → approved:true, no specs, no manifest write", async () => {
  // Import here (same module, same stub pattern)
  const { runOpencodeParallel } = await import("../../../../../src/integrations/opencode-client.ts");
  const store = new Map<string, string>();
  const fakeFs: ManifestFs = {
    read: (p) => store.get(p) ?? null,
    write: (p, c) => void store.set(p, c),
  };
  const deps = makeAgentDeps({
    "qa-generator": '{"objectives":[]}',
  });
  const result = await runOpencodeParallel(
    { ...baseInput, mode: "complete", intent: undefined },
    deps,
    {},
    fakeFs,
  );
  assert.deepEqual(result.specs, [], "empty plan → no specs");
  assert.equal(result.approved, true, "empty plan is approved (clean no-op)");
  assert.equal(store.size, 0, "empty plan → no manifest written");
});
