// Per-run token/cost usage accumulator — observation-only; never influences verdict or publish.
// Captures OpenCode SDK info.tokens + info.cost from every session.prompt response within a run,
// sums them into a RunUsage blob, and persists it on gateSignals.usage.
// Codex exposes no usage, so a Codex-only run yields undefined (never zero).

// A single SDK response's normalized token counts + optional cost.
export interface UsageSnapshot {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number; // SDK-computed; 0 when the model's rate config is absent from opencode.json
}

// The persisted shape on RunOutcome.gateSignals.usage.
// total = input + output + reasoning (reasoning is the semantic spend, not cache).
// cost is absent when no snapshot fired (the accumulator never invents a zero cost).
// complete: true iff both primary and reviewer are OpenCode in this run config.
export interface RunUsage {
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    total: number; // = input + output + reasoning
  };
  cost?: number; // USD, SDK-computed; present iff >= 1 snapshot fired
  complete: boolean; // true = full picture; false = partial (e.g. dual mode, Codex reviewer)
}

// The mutable accumulator for one run — created in runPipeline, discarded after persist.
export interface UsageAccumulator {
  add(s: UsageSnapshot): void;
  result(complete: boolean): RunUsage | undefined; // undefined when nothing was ever added
}

// Factory: pure, no I/O.
export function createUsageAccumulator(): UsageAccumulator {
  let count = 0;
  let input = 0;
  let output = 0;
  let reasoning = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let costSum = 0;

  return {
    add(s: UsageSnapshot): void {
      count++;
      input += s.input;
      output += s.output;
      reasoning += s.reasoning;
      cacheRead += s.cacheRead;
      cacheWrite += s.cacheWrite;
      costSum += s.cost;
    },
    result(complete: boolean): RunUsage | undefined {
      if (count === 0) return undefined;
      return {
        tokens: {
          input,
          output,
          reasoning,
          cacheRead,
          cacheWrite,
          total: input + output + reasoning,
        },
        cost: costSum,
        complete,
      };
    },
  };
}
