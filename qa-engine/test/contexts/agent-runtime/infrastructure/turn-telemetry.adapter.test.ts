// test/contexts/agent-runtime/infrastructure/turn-telemetry.adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnTelemetryAdapter } from "@contexts/agent-runtime/infrastructure/turn-telemetry.adapter.ts";

test("record delegates to the injected saveAgentTurn with the mapped event", () => {
  let seen: unknown = null;
  const adapter = new TurnTelemetryAdapter((row) => { seen = row; });
  adapter.record({ runId: "r1", role: "primary", round: 2, isRepair: true, sectionSizes: { task: 100 } });
  assert.ok(seen, "saveAgentTurn must be called — a gutted impl that no-ops FAILS this");
});

test("record passes the runId and role through to the row", () => {
  let seen: Record<string, unknown> | null = null;
  const adapter = new TurnTelemetryAdapter((row) => { seen = row as Record<string, unknown>; });
  adapter.record({ runId: "run-42", role: "reviewer", round: 0, isRepair: false, sectionSizes: null });
  assert.ok(seen, "saveAgentTurn must be called");
  // The row must carry the runId and role so callers can route it correctly.
  // A gutted impl that calls saveAgentTurn with an empty object FAILS this.
  assert.equal(seen["runId"], "run-42");
  assert.equal(seen["role"], "reviewer");
});

test("record passes a null runId through unchanged (turns without a run context)", () => {
  let seen: Record<string, unknown> | null = null;
  const adapter = new TurnTelemetryAdapter((row) => { seen = row as Record<string, unknown>; });
  adapter.record({ runId: null, role: "primary", round: 1, isRepair: false, sectionSizes: null });
  assert.ok(seen);
  assert.equal(seen["runId"], null);
});
