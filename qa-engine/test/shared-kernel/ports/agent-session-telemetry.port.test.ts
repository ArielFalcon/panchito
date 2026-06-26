// test/shared-kernel/ports/agent-session-telemetry.port.test.ts
//
// Task A.2 — the kernel AgentSession.prompt must carry the per-call telemetry/contract-repair opts the
// legacy session exposes (textOnly/round/isRepair/sectionSizes), and AgentTurnEvent must surface the
// per-turn telemetry the legacy funnel records (round/isRepair/sectionSizes; runId nullable). tsc is the
// real assertion for the type widening; the runtime asserts the opts are forwarded verbatim (so a stub
// that silently dropped them would FAIL) and that a TurnTelemetrySink can record the enriched event.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentSession, AgentTurnEvent } from "@kernel/ports/agent-runtime.port.ts";
import type { TurnTelemetrySink } from "@contexts/agent-runtime/application/ports/index.ts";

test("AgentSession.prompt forwards the per-call telemetry/repair opts verbatim", async () => {
  // The session echoes the received opts so the test proves they reached prompt() unchanged — a session
  // whose prompt ignored opts (the pre-A.2 narrow signature) would not even compile here.
  let seen: { textOnly?: boolean; round?: number; isRepair?: boolean; sectionSizes?: Record<string, number> | null } | undefined;
  const session: AgentSession = {
    async prompt(text, opts) {
      seen = opts;
      return { output: text };
    },
    dispose() {},
  };

  const opts = { textOnly: true, round: 3, isRepair: true, sectionSizes: { system: 42, context: 1024 } };
  const { output } = await session.prompt("body", opts);

  assert.equal(output, "body");
  assert.deepEqual(seen, opts);
});

test("AgentTurnEvent carries round/isRepair/sectionSizes and a TurnTelemetrySink records them", () => {
  const recorded: AgentTurnEvent[] = [];
  const sink: TurnTelemetrySink = { record: (e) => void recorded.push(e) };

  // runId nullable (mirrors the legacy funnel: null for runs without a run context); sectionSizes is the
  // ContextAssembler byte map, null for non-assembled prompts (repairs/explorer).
  const assembled: AgentTurnEvent = {
    runId: "run-1",
    role: "primary",
    objective: "test the contact form",
    round: 1,
    isRepair: false,
    sectionSizes: { system: 10, blastRadius: 20 },
  };
  const repair: AgentTurnEvent = {
    runId: null,
    role: "primary",
    round: 2,
    isRepair: true,
    sectionSizes: null,
  };

  sink.record(assembled);
  sink.record(repair);

  assert.equal(recorded.length, 2);
  assert.equal(recorded[0]?.round, 1);
  assert.equal(recorded[0]?.isRepair, false);
  assert.deepEqual(recorded[0]?.sectionSizes, { system: 10, blastRadius: 20 });
  assert.equal(recorded[1]?.runId, null);
  assert.equal(recorded[1]?.isRepair, true);
  assert.equal(recorded[1]?.sectionSizes, null);
});
