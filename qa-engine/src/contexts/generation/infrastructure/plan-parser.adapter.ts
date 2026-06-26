// qa-engine/src/contexts/generation/infrastructure/plan-parser.adapter.ts
// WRAP of src/integrations/opencode-client.ts parsePlan. Maps PlanObjective[] to PlanObjectiveView[]
// (flow + objective — the use-case only needs those for fan-out, not symbols/needsUi which are
// worker-dispatch concerns). parsePlan injected so the adapter test needs no real planner text.
// Delegates — does NOT reimplement the JSON extraction or de-dup logic.
import type { PlanParserPort, PlanObjectiveView } from "../application/ports/index.ts";

// Structural shape of one parsed objective from the legacy parsePlan. The adapter accesses only the
// fields it maps onto the view; additional fields (symbols, needsUi, brief) are not consumed here.
interface LegacyPlanObjective {
  flow: string;
  objective: string;
}

// The injected parsePlan fn type: (text: string) => LegacyPlanObjective[] (may carry more fields).
type ParsePlanFn = (text: string) => LegacyPlanObjective[];

export class PlanParserAdapter implements PlanParserPort {
  constructor(private readonly parsePlan: ParsePlanFn) {}

  parse(text: string): PlanObjectiveView[] {
    return this.parsePlan(text).map((o) => ({
      flow: o.flow,
      objective: o.objective,
    }));
  }
}
