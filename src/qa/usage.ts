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
// primaryProvider / reviewerProvider: the provider names from the role assignment at run time,
//   persisted for attribution (e.g. "codex" vs "opencode"). Absent when no runtime config is known.
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
  primaryProvider?: string; // provider for the primary/generator role (e.g. "opencode" | "codex")
  reviewerProvider?: string; // provider for the reviewer role (e.g. "opencode" | "codex")
}

// Provider attribution context passed to result() from the pipeline's runtime config.
export interface UsageProviderAttribution {
  primaryProvider?: string;
  reviewerProvider?: string;
}

// The mutable accumulator for one run — created in runPipeline, discarded after persist.
export interface UsageAccumulator {
  add(s: UsageSnapshot): void;
  // undefined when nothing was ever added (Codex-only run with no snapshots).
  // attribution: optional provider names from the role assignment (for persisted attribution).
  result(complete: boolean, attribution?: UsageProviderAttribution): RunUsage | undefined;
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
    result(complete: boolean, attribution?: UsageProviderAttribution): RunUsage | undefined {
      // When no snapshots were fired AND no attribution is provided, return undefined to signal
      // "no usage data available" (e.g. a Codex-only run before the usage hook is activated).
      // When attribution IS provided (provider names from the runtime config), always return a
      // record — with zero tokens when none were accumulated — so the run is attributable even
      // when the provider emits no token counts. This keeps AC2.5.2 honest: complete=false,
      // tokens are genuinely zero (not fabricated), and the provider fields name the runtime.
      if (count === 0 && !attribution?.primaryProvider && !attribution?.reviewerProvider) {
        return undefined;
      }
      const record: RunUsage = {
        tokens: {
          input,
          output,
          reasoning,
          cacheRead,
          cacheWrite,
          total: input + output + reasoning,
        },
        ...(count > 0 ? { cost: costSum } : {}),
        complete,
      };
      if (attribution?.primaryProvider !== undefined) record.primaryProvider = attribution.primaryProvider;
      if (attribution?.reviewerProvider !== undefined) record.reviewerProvider = attribution.reviewerProvider;
      return record;
    },
  };
}
