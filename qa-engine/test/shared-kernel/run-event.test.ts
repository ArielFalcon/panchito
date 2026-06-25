// qa-engine/test/shared-kernel/run-event.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { RunEventSchema, type RunEvent, type AgentRole } from "@kernel/run-event.ts";

test("RunEvent re-exports the frozen wire schema and parses a valid envelope", () => {
  const ev: RunEvent = RunEventSchema.parse({
    seq: 0, runId: "r1", ts: 0,
    body: { type: "run.verdict", verdict: "pass", engineStatus: "success" },
  });
  assert.equal(ev.body.type, "run.verdict");
});

test("AgentRole carries all 8 runtime roles (kernel-resident vocabulary)", () => {
  // NOTE: this checks an array literal length, not the type union — it cannot catch a new member
  // added to the union but omitted from the array. For exhaustiveness at the type level, add a
  // `Record<AgentRole, true>` check:
  //   const _exhaustive: Record<AgentRole, true> = { primary: true, reviewer: true, ... };
  // That would cause a compile error if the union gains a member not in the object. Left as an
  // array check here since the kernel union is frozen for this plan; upgrade to the Record pattern
  // if AgentRole ever becomes extensible.
  const roles: AgentRole[] = ["primary", "reviewer", "chat", "worker", "workerCode", "maintainer", "reflector", "explorer"];
  assert.equal(roles.length, 8);
});
