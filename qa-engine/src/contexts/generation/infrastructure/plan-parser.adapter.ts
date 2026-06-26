// qa-engine/src/contexts/generation/infrastructure/plan-parser.adapter.ts
// WRAP of src/integrations/opencode-client.ts parsePlan. Maps PlanObjective[] to PlanObjectiveView[]
// forwarding all fields including symbols/needsUi/brief so Phase B fan-out logic can drive
// ParallelWorkerInput construction from the port type without narrow-casting to the legacy type.
// parsePlan injected so the adapter test needs no real planner text.
// Delegates — does NOT reimplement the JSON extraction or de-dup logic.
import type { PlanParserPort, PlanObjectiveView } from "../application/ports/index.ts";
import type { ExplorationBrief } from "../application/ports/generation-ports.ts";

// Structural shape of one parsed objective from the legacy parsePlan (opencode-client.ts:1022-1027).
// All fields that PlanObjectiveView now carries must appear here so the adapter can forward them.
interface LegacyPlanObjective {
  flow: string;
  objective: string;
  symbols: string[];
  needsUi: boolean;
  brief?: ExplorationBrief;
}

// The injected parsePlan fn type: (text: string) => LegacyPlanObjective[] (may carry more fields).
type ParsePlanFn = (text: string) => LegacyPlanObjective[];

export class PlanParserAdapter implements PlanParserPort {
  constructor(private readonly parsePlan: ParsePlanFn) {}

  parse(text: string): PlanObjectiveView[] {
    return this.parsePlan(text).map((o) => ({
      flow: o.flow,
      objective: o.objective,
      symbols: o.symbols,
      needsUi: o.needsUi,
      ...(o.brief ? { brief: o.brief } : {}),
    }));
  }
}
