// test/contexts/generation/application/ports/generation-ports.test.ts
// Structural unit test for the Seam-2 canonical input types. The real guard is tsc: the literal below
// must satisfy OpencodeRunInput with the full deterministic-signal field set. Imports only from @contexts.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OpencodeRunInput, ReviewInput, ParallelWorkerInput } from "@contexts/generation/application/ports/generation-ports.ts";

test("OpencodeRunInput accepts the full deterministic-signal field set (contextPack/domSnapshot/staticSignal/diffArchetypes)", () => {
  const input: OpencodeRunInput = {
    repo: "o/a", sha: "abc", diff: "d", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "qa-bot-abc",
    needsReview: true, target: "e2e", mode: "diff", appName: "a",
    contextPack: "pack", domSnapshot: "dom", staticSignal: "sig", diffArchetypes: ["auth-flow"],
  };
  assert.equal(input.target, "e2e"); // compile-time is the real assertion; this keeps node:test happy
});

test("ReviewInput accepts the full reviewer field set (specs/blockingCount inputs/executionResult)", () => {
  const input: ReviewInput = {
    diff: "d", specs: ["e2e/login.spec.ts"], mirrorDir: "/m", e2eRelDir: "e2e",
    appName: "a", mode: "diff", target: "e2e",
    domSnapshot: "dom", priorCorrections: ["fix selector"], executionResult: "500 on /login",
  };
  assert.equal(input.specs.length, 1);
});

test("ParallelWorkerInput accepts the full worker field set (objective/flow/specFile/staticSignal)", () => {
  const input: ParallelWorkerInput = {
    objective: "login flow", flow: "login", symbols: ["AuthService.login"], needsUi: true,
    specFile: "flows/login.spec.ts", repo: "o/a", mirrorDir: "/m", e2eRelDir: "e2e",
    namespace: "qa-bot-abc", appName: "a", mode: "diff", staticSignal: "sig",
  };
  assert.equal(input.flow, "login");
});
