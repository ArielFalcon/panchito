// Integration tests for the bounded verdict-repair loop (post-ADR-001, Phase 1): a contract
// miss in the generator's or the reviewer's closing JSON triggers exactly ONE targeted
// re-prompt before the orchestrator gives up. Kept in a separate file from opencode-client's
// large suite to stay out of its way (it is edited concurrently).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runOpencode,
  reviewIndependently,
  type AgentDeps,
  type OpencodeRunInput,
  type ReviewInput,
} from "./opencode-client";

// A deps stub whose session.prompt() returns a queued response per call and records every
// prompt it was sent (so a test can assert how many turns happened and what the repair said).
function queuedDeps(responses: string[], sent: string[]): AgentDeps {
  let i = 0;
  return {
    open: async () => ({
      id: "test-session",
      prompt: async (text: string) => {
        sent.push(text);
        const r = responses[Math.min(i, responses.length - 1)] ?? "";
        i++;
        return r;
      },
      dispose: async () => {},
    }),
  };
}

const genInput: OpencodeRunInput = {
  repo: "org/demo",
  sha: "abc123",
  diff: "diff --git a/x b/x\n+const x = 1;",
  mirrorDir: "/tmp/qa-nonexistent",
  e2eRelDir: "e2e",
  namespace: "qa-bot-abc123",
  needsReview: true,
  target: "e2e",
  mode: "diff",
  appName: "demo-app",
};

const revInput: ReviewInput = {
  diff: "diff --git a/x b/x\n+const x = 1;",
  specs: ["login.spec.ts"], // file does not exist on disk → renderReviewSpecs degrades gracefully
  mirrorDir: "/tmp/qa-nonexistent",
  e2eRelDir: "e2e",
  appName: "demo-app",
  mode: "diff",
};

// ── generator ─────────────────────────────────────────────────────────────────

test("runOpencode repairs a malformed generator verdict with one re-prompt", async () => {
  const sent: string[] = [];
  // 1st turn: specs is not an array (contract miss). 2nd turn (repair): valid.
  const res = await runOpencode(genInput, queuedDeps(['{"specs":"login.spec.ts"}', '{"specs":["login.spec.ts"]}'], sent));
  assert.equal(sent.length, 2, "expected exactly one repair re-prompt");
  assert.match(sent[1]!, /Re-emit ONLY the closing JSON/i, "the 2nd turn must be the repair instruction");
  assert.deepEqual(res.specs, ["login.spec.ts"], "the result must reflect the repaired verdict");
});

test("runOpencode does NOT re-prompt when the generator verdict is already valid", async () => {
  const sent: string[] = [];
  const res = await runOpencode(genInput, queuedDeps(['{"specs":["login.spec.ts"]}'], sent));
  assert.equal(sent.length, 1, "a valid verdict must not cost an extra turn");
  assert.deepEqual(res.specs, ["login.spec.ts"]);
});

// ── reviewer (the authoritative gate) ───────────────────────────────────────────

test("reviewIndependently repairs a missing reviewer verdict with one re-prompt", async () => {
  const sent: string[] = [];
  // 1st turn: prose, no JSON. 2nd turn (repair): a clean approval.
  const res = await reviewIndependently(revInput, queuedDeps(["I think these tests look fine overall.", '{"approved":true,"rationale":"asserts the changed behavior","corrections":[]}'], sent));
  assert.equal(sent.length, 2, "expected one repair re-prompt for the missing verdict");
  assert.match(sent[1]!, /"approved"/, "the repair instruction must name the reviewer shape");
  assert.equal(res.approved, true);
  assert.equal(res.parsed, true);
});

test("reviewIndependently fails closed if the verdict is still unreadable after repair", async () => {
  const sent: string[] = [];
  const res = await reviewIndependently(revInput, queuedDeps(["still no json", "and still none"], sent));
  assert.equal(sent.length, 2, "exactly one repair attempt, then give up");
  assert.equal(res.approved, false, "fail-closed: nothing publishes on an unreadable gate");
  assert.equal(res.parsed, false, "flagged as a parse miss, not an actionable rejection");
});

test("reviewIndependently does NOT re-prompt when the verdict is already valid", async () => {
  const sent: string[] = [];
  const res = await reviewIndependently(revInput, queuedDeps(['{"approved":false,"rationale":"no assertion on the change","corrections":["[false-positive] login.spec.ts: assert the outcome"]}'], sent));
  assert.equal(sent.length, 1, "a valid verdict must not cost an extra turn");
  assert.equal(res.approved, false);
  assert.deepEqual(res.corrections, ["[false-positive] login.spec.ts: assert the outcome"]);
});
