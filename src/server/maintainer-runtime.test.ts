import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMaintainerRuntime, type MaintainerSideEffects, type MaintainerConfig } from "./maintainer-runtime";
import { recordIncident, getIncident, getIncidents, getMaintainerStatus } from "./maintainer";
import type { AgentDeps } from "../integrations/opencode-client";

// These are the FIRST tests of the self-deploy path — ARCH-01 extracted it from index.ts behind a DI
// factory precisely so the safety-layer SEQUENCING (open PR → justify → kill-switch → scope → rate →
// self-test → canary swap) can be asserted without actually swapping code, merging a PR, exec-ing npm,
// or exiting the process. The irreversible boundaries are injected as spies.

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "maint-rt-"));
  mkdirSync(join(root, "data"), { recursive: true });
  return root;
}

// A well-formed agent reply: a real fix with a valid (3-field, non-trivial) justification.
function fixReply(): string {
  const j = {
    fixed: true,
    changes: ["src/foo.ts: fixed the thing"],
    prTitle: "fix: the thing",
    justification: {
      rootCause: "the deploy gate read the wrong field so every gated run timed out",
      whyNecessary: "without it the service never actually tests anything at all",
      whyMinimal: "a single field rename, no other behaviour changes are made here",
    },
  };
  return `done.\n<!--MAINTAINER_SUMMARY ${JSON.stringify(j)} END_MAINTAINER_SUMMARY-->`;
}

function agentDeps(promptReturn: string): AgentDeps {
  return {
    open: async () => ({ id: "s1", prompt: async () => promptReturn, dispose: async () => {} }),
  };
}

interface Spies {
  createPR: number;
  performSwap: number;
  exit: number[];
  gateCmds: string[];
}

function harness(opts: { root: string; autonomous: boolean; promptReturn: string }) {
  const calls: Spies = { createPR: 0, performSwap: 0, exit: [], gateCmds: [] };
  const git = async (args: string[]): Promise<string> => {
    if (args[0] === "status" && args[1] === "--porcelain") return " M src/foo.ts\n"; // dirty → commit
    if (args[0] === "diff" && args[1] === "--numstat") return "1\t0\tsrc/foo.ts\n"; // 1 file/1 line, unprotected
    return "";
  };
  const fx: MaintainerSideEffects = {
    github: {
      createPullRequest: async () => {
        calls.createPR++;
        return { url: "https://gh/pr/1", number: 1, nodeId: "n1" };
      },
      mergePullRequest: async () => {},
      enableAutoMerge: async () => {},
      getPrStatus: async () => ({ merged: true, state: "open", checks: "success" }),
    } as unknown as MaintainerSideEffects["github"],
    performSwap: () => {
      calls.performSwap++;
    },
    confirmSwapHealthy: () => {},
    rollback: () => false,
    realSwapFs: { readMarker: () => null } as unknown as MaintainerSideEffects["realSwapFs"],
    mirrorDeps: { exists: () => true, git } as unknown as MaintainerSideEffects["mirrorDeps"],
    exec: (cmd) => {
      calls.gateCmds.push(cmd);
    },
    exit: ((code: number) => {
      calls.exit.push(code);
    }) as unknown as MaintainerSideEffects["exit"],
    fetchHealth: async () => ({ ok: true }),
  };
  const cfg: MaintainerConfig = {
    queue: { drain: async () => {} },
    getAgentDeps: () => agentDeps(opts.promptReturn),
    setShuttingDown: () => {},
    root: opts.root,
    selfRepo: "Org/ai-pipeline",
    autonomous: opts.autonomous,
    port: 9999,
  };
  return { runtime: createMaintainerRuntime(cfg, fx), calls };
}

// THE kill-switch invariant: with SELF_MAINTAINER_AUTOMERGE off, a perfectly fixable incident still
// stops at an OPEN PR — it is never swapped into the running service and never exits to restart.
test("triggerMaintainer opens a PR but does NOT auto-deploy when autonomous=false (kill-switch)", async () => {
  const root = freshRoot();
  const inc = recordIncident({ source: "health-check", severity: "critical", summary: "kill-switch case" });
  const { runtime, calls } = harness({ root, autonomous: false, promptReturn: fixReply() });

  await runtime.triggerMaintainer();

  assert.equal(calls.createPR, 1, "the fix PR is opened");
  assert.equal(calls.performSwap, 0, "the kill-switch must block the canary swap");
  assert.deepEqual(calls.exit, [], "the kill-switch must block the restart");
  assert.equal(getIncident(inc.id)?.status, "fixed", "the incident is marked fixed (PR open) for a human");
  assert.equal(getMaintainerStatus(), "idle");
});

// The full green path: all five gates pass → the fix IS hot-swapped into the running service and the
// process exits(0) to restart into it (canary). performSwap + exit(0) are the proof it deployed.
test("triggerMaintainer canary-deploys when autonomous=true and every gate is green", async () => {
  const root = freshRoot();
  recordIncident({ source: "health-check", severity: "critical", summary: "green path case" });
  const { runtime, calls } = harness({ root, autonomous: true, promptReturn: fixReply() });

  await runtime.triggerMaintainer();

  assert.equal(calls.createPR, 1);
  assert.equal(calls.performSwap, 1, "the verified fix is swapped into the running tree");
  assert.deepEqual(calls.exit, [0], "the service restarts into the canary");
  // The pre-deploy self-test gate ran install + typecheck + test on the fix branch before the swap.
  assert.ok(calls.gateCmds.some((c) => c.includes("typecheck")) && calls.gateCmds.some((c) => c.includes("test")));
});

// An agent that produces no usable fix never opens a PR; the incident is returned to "diagnosing".
test("triggerMaintainer records no PR and re-queues the incident when the agent produces no fix", async () => {
  const root = freshRoot();
  const inc = recordIncident({ source: "health-check", severity: "warn", summary: "no-fix case" });
  const { runtime, calls } = harness({ root, autonomous: true, promptReturn: "I could not locate the root cause." });

  await runtime.triggerMaintainer();

  assert.equal(calls.createPR, 0);
  assert.equal(calls.performSwap, 0);
  assert.equal(getIncident(inc.id)?.status, "diagnosing");
  assert.equal(getMaintainerStatus(), "idle");
});

// boot-guard.mjs (which can't use the app's modules) leaves a bridge file when it rolls back a
// crash-looping swap. recoverRollbackRecord must fold it into failure memory + a critical incident so
// the agent learns the fix crash-looped, then delete the bridge.
test("recoverRollbackRecord folds a boot-guard rollback bridge into failure memory + an incident", () => {
  const root = freshRoot();
  const bridge = join(root, "data", "last-rollback.json");
  writeFileSync(bridge, JSON.stringify({ prUrl: "https://gh/pr/42", fix: { prTitle: "fix: x", rootCause: "bad gate" } }));
  const { runtime } = harness({ root, autonomous: true, promptReturn: "" });

  runtime.recoverRollbackRecord();

  assert.equal(existsSync(bridge), false, "the bridge file is consumed (removed)");
  const failures = readFileSync(join(root, "data", "maintainer-failures.json"), "utf8");
  assert.match(failures, /boot-crash-loop/);
  assert.match(failures, /pr\/42/);
  assert.ok(
    getIncidents().some((i) => i.severity === "critical" && /crash-looped/.test(i.summary)),
    "a critical incident is recorded for the crash-loop",
  );
});
