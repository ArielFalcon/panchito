// qa-engine/src/contexts/generation/infrastructure/prompt-budget.adapter.ts
// WRAP of src/integrations/model-window-catalog.ts roleWindowBytes + the capDiff/capText cappers behind
// PromptBudgetPort. The per-role byte budget is OWNED by the catalog (model → window → bytes); this
// adapter FORWARDS it. It NEVER hardcodes a budget threshold — the value is whatever roleWindowBytes
// returns for the role given the current catalog. Inherits the user's catalog fix via delegation.
import type { PromptBudgetPort } from "../application/ports/index.ts";

type RoleWindowBytes = (role: string) => number;
type Cap = (s: string) => string;

export class PromptBudgetAdapter implements PromptBudgetPort {
  constructor(
    private readonly roleWindowBytesFn: RoleWindowBytes,
    private readonly _capDiff: Cap,
    private readonly _capText: Cap,
  ) {}

  budgetForRole(role: string): number {
    return this.roleWindowBytesFn(role);
  }

  capDiff(diff: string): string {
    return this._capDiff(diff);
  }

  capText(text: string): string {
    return this._capText(text);
  }
}
