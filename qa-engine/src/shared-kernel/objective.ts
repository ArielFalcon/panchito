// NEW kernel concept: one planned generation objective — a named user Flow + the acceptance criterion
// + the symbols/routes it exercises. Promoted from the planner's scattered {flow, objective, targets}
// fields so fan-out and manifest reconciliation share one typed unit instead of loose strings.

export class Flow {
  private constructor(readonly name: string) {}
  static of(name: string): Flow {
    const n = name.trim();
    if (n.length === 0) throw new Error("Flow: name must be non-empty");
    return new Flow(n);
  }
}

export class Objective {
  private constructor(
    readonly flow: Flow,
    readonly objective: string,
    readonly targets: readonly string[],
  ) {}

  static of(input: { flow: string; objective: string; targets: readonly string[] }): Objective {
    const obj = input.objective.trim();
    if (obj.length === 0) throw new Error("Objective: acceptance criterion must be non-empty");
    return new Objective(Flow.of(input.flow), obj, Object.freeze([...input.targets]));
  }
}
