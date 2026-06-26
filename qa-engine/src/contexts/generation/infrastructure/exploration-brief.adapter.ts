// qa-engine/src/contexts/generation/infrastructure/exploration-brief.adapter.ts
// WRAP of src/qa/exploration-brief.ts schema fns (parseExplorationBrief/coerceExplorationBrief/
// renderExplorationBrief) — pure, thin delegators. Parity test pins the round-trip to the legacy fn.
// The legacy source is src/qa/exploration-brief.ts (NOT src/integrations/ — there is no such file).
// All three fns are injected (constructor seam) so the adapter test needs no real implementations.

// Structural shapes mirroring src/qa/exploration-brief.ts — no src/ import at runtime.
export interface BlastNode {
  symbol: string;
  file: string;
  role: string;
}

export interface FeBeFact {
  route: string;
  operationId: string;
  via?: string;
}

export interface ContractFact {
  operationId: string;
  method: string;
  path: string;
  fields?: string[];
  errors?: string[];
}

export interface RouteRecon {
  path: string;
  component?: string;
  domLandmarks?: string[];
  verified: boolean;
}

export interface ExplorationBrief {
  builtForSha: string;
  objective: string;
  blastRadius: BlastNode[];
  feBe?: FeBeFact[];
  contracts?: ContractFact[];
  routes?: RouteRecon[];
  risks?: string[];
  notes?: string;
}

export interface BriefFns {
  parseExplorationBrief(text: string): ExplorationBrief | null;
  coerceExplorationBrief(raw: unknown): ExplorationBrief | null;
  renderExplorationBrief(brief: ExplorationBrief, opts?: { suppressFeBe?: boolean }): string;
}

export class ExplorationBriefAdapter {
  constructor(private readonly fns: BriefFns) {}

  parse(text: string): ExplorationBrief | null {
    return this.fns.parseExplorationBrief(text);
  }

  coerce(raw: unknown): ExplorationBrief | null {
    return this.fns.coerceExplorationBrief(raw);
  }

  render(brief: ExplorationBrief, opts?: { suppressFeBe?: boolean }): string {
    return this.fns.renderExplorationBrief(brief, opts);
  }
}
