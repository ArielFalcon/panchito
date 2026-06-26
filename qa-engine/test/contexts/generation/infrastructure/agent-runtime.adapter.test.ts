// test/contexts/generation/infrastructure/agent-runtime.adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntimeAdapter } from "@contexts/generation/infrastructure/agent-runtime.adapter.ts";

test("openSession delegates to AgentDeps.open and adapts prompt → { output }, forwarding round/isRepair/sectionSizes", async () => {
  let promptOpts: unknown = null;
  const adapter = new AgentRuntimeAdapter({
    open: async (_agent, _cwd, _opts) => ({
      id: "s1",
      prompt: async (_t: string, o: unknown) => { promptOpts = o; return "RESULT"; },
      dispose: async () => {},
    }) as never,
  }, (role) => role);
  const session = await adapter.openSession("primary", "/m", { descriptor: { runId: "r1" } });
  const out = await session.prompt("go", { round: 3, isRepair: true, sectionSizes: { task: 9 } });
  assert.equal(out.output, "RESULT");
  assert.deepEqual(promptOpts, { round: 3, isRepair: true, sectionSizes: { task: 9 } }); // opts NOT dropped
});
