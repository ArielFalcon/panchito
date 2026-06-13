import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultPipelineDeps, type GenerateInput } from "./pipeline";
import type { AgentDeps } from "./integrations/opencode-client";
import type { RunOutcome } from "./types";

function fakeAgentDeps(opened: string[], responseFor: (agent: string) => string): AgentDeps {
  return {
    open: async (agent) => {
      opened.push(agent);
      return {
        id: `${agent}-session`,
        prompt: async () => responseFor(agent),
        dispose: async () => {},
      };
    },
  };
}

function generateInput(): GenerateInput {
  return {
    repo: "org/demo",
    sha: "abc1234",
    diff: "diff --git a/src/x.ts b/src/x.ts\n+++ b/src/x.ts\n@@ -0,0 +1 @@\n+x",
    mirrorDir: mkdtempSync(join(tmpdir(), "qa-agent-deps-")),
    namespace: "qa-abc1234",
    needsReview: true,
    mode: "diff",
    appName: "demo",
  };
}

function failedOutcome(): RunOutcome {
  return {
    runId: "run_1",
    app: "demo",
    sha: "abc1234",
    mode: "diff",
    target: "e2e",
    verdict: "fail",
    errorClass: "E-EXEC-FAIL",
    gateSignals: {
      static: true,
      coverageRatio: null,
      valueScore: null,
      reviewerCorrections: [],
      flaky: false,
      retries: 0,
    },
    rulesRetrieved: [],
    at: "2026-01-01T00:00:00.000Z",
  };
}

test("defaultPipelineDeps routes generation through the injected agent deps factory", async () => {
  const opened: string[] = [];
  const deps = defaultPipelineDeps({
    agentDepsFactory: async () => fakeAgentDeps(opened, () => '{ "approved": true, "specs": ["flows/generated.spec.ts"] }'),
  });

  const result = await deps.generate(generateInput());

  assert.deepEqual(opened, ["qa-generator"]);
  assert.equal(result.approved, true);
  assert.deepEqual(result.specs, ["flows/generated.spec.ts"]);
});

test("defaultPipelineDeps routes independent review through the injected agent deps factory", async () => {
  const opened: string[] = [];
  const deps = defaultPipelineDeps({
    agentDepsFactory: async () => fakeAgentDeps(opened, () => '{ "approved": true, "corrections": [] }'),
  });

  const result = await deps.review!({
    diff: "diff",
    specs: ["flows/generated.spec.ts"],
    mirrorDir: mkdtempSync(join(tmpdir(), "qa-review-deps-")),
    e2eRelDir: "e2e",
    appName: "demo",
    mode: "diff",
  });

  assert.deepEqual(opened, ["qa-reviewer"]);
  assert.equal(result.approved, true);
});

test("defaultPipelineDeps routes reflection through the injected agent deps factory", async () => {
  const opened: string[] = [];
  const deps = defaultPipelineDeps({
    agentDepsFactory: async () => fakeAgentDeps(opened, () => "not json"),
    hasOpenSessions: () => false,
  });

  const result = await deps.reflectAndDistill!({
    app: "demo",
    runId: "run_1",
    outcome: failedOutcome(),
  });

  assert.deepEqual(opened, ["qa-reflector"]); // tool-less reflector role, not the engram-backed chat assistant
  assert.equal(result, null);
});
