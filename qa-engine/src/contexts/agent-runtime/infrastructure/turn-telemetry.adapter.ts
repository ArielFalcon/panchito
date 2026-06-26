// qa-engine/src/contexts/agent-runtime/infrastructure/turn-telemetry.adapter.ts
// WRAP of src/server/history.ts saveAgentTurn (the SSE/turn persistence bridge). Replaces the direct
// saveAgentTurn import in the legacy strategies with a clean sink. Injected so the test needs no DB.
// Maps the port AgentTurnEvent (runId/role/round/isRepair/sectionSizes) onto the legacy row shape.
// Plan-6 wiring will wire the real saveAgentTurn here; until then the partial shape is forward-compatible.
import type { TurnTelemetrySink, AgentTurnEvent } from "../application/ports/index.ts";

/** Structural shape of the legacy turn row (no src/ import at runtime). */
export interface TurnRow {
  runId: string | null;
  role: string;
  round: number;
  isRepair: boolean;
  sectionSizes: Record<string, number> | null;
  [key: string]: unknown; // forward-compatible: Plan-6 wiring adds sessionId, promptText, etc.
}

export type SaveAgentTurn = (row: TurnRow) => void;

export class TurnTelemetryAdapter implements TurnTelemetrySink {
  constructor(private readonly saveAgentTurn: SaveAgentTurn) {}

  record(event: AgentTurnEvent): void {
    this.saveAgentTurn(toRow(event));
  }
}

/** Map the kernel AgentTurnEvent onto the legacy agent_turns row shape.
 *  The kernel event carries the per-turn telemetry fields. Plan-6 wiring will
 *  enrich the row with sessionId, promptText, outputText, etc. via the strategy
 *  adapters that have direct access to the full legacy AgentTurnEvent.
 */
function toRow(e: AgentTurnEvent): TurnRow {
  return {
    runId: e.runId,
    role: e.role,
    round: e.round,
    isRepair: e.isRepair,
    sectionSizes: e.sectionSizes,
  };
}
