// qa-engine/src/contexts/qa-run-orchestration/infrastructure/legacy-pipeline.adapter.ts
// WRAP of src/pipeline.ts runPipeline (Plan 6, Slice A, Task A.1). The strangler net. Translates a
// RunInput into the legacy positional call and surfaces the RunOutcome the wrapped pipeline
// persisted via saveOutcome. NO decision logic lives here — it delegates to the proven function.
// AppConfig + PipelineDeps + the runPipeline fn are injected so the adapter is src/-free at type
// level and testable with the scenarios.ts stubs.
import type { RunPipelinePort, RunInput } from "../application/ports/index.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";

// Structural shapes of the wrapped legacy surface (no src/ import at type level; the composition
// root in Slice E supplies the real runPipeline + PipelineDeps + AppConfig).
export interface LegacyRunner {
  app: unknown; // legacy AppConfig
  deps: { savedOutcomes?: RunOutcome[] } & Record<string, unknown>; // legacy PipelineDeps (+ capture hook)
  // Per-run legacy-only opts (e.g. triggerRepo) — opaque, spread over the derived opts. Threads
  // cross-repo routing without widening RunInput (the brief keeps WorkspacePort opaque for Plan 6).
  legacyOpts?: Record<string, unknown>;
  runPipeline: (
    app: unknown,
    sha: string,
    deps: unknown,
    source: string,
    opts: unknown,
    ...cbs: unknown[]
  ) => Promise<{ verdict: string }>;
}

export class LegacyPipelineAdapter implements RunPipelinePort {
  constructor(private readonly legacy: LegacyRunner) {}

  async run(input: RunInput): Promise<RunOutcome> {
    // legacyOpts carries cross-repo routing (triggerRepo) opaquely — the composition root/scenario
    // supplies it; RunInput is NOT widened (cross-repo stays opaque inside the adapter for Plan 6).
    const opts = {
      mode: input.mode,
      target: input.target,
      guidance: input.guidance,
      runId: input.runId,
      ...this.legacy.legacyOpts,
    };
    const result = await this.legacy.runPipeline(this.legacy.app, input.sha.value, this.legacy.deps, input.source, opts);
    // R2 — consecutiveReviewerFailures is a module-level `let` in pipeline.ts that survives between
    // queue entries (a cross-run side effect). The adapter delegates to the unchanged function, so
    // it INHERITS this defect for the legacy path. Documented (bug register entry #1, behavior-
    // changing, fixed later per-run in the rewritten Run aggregate — Task D.1). The legacy adapter
    // does NOT attempt to reset the global.
    return mapToOutcome(result, this.legacy.deps, input);
  }
}

// Surfaces the RunOutcome the wrapped pipeline saved. Context mode returns early without calling
// saveOutcome — synthesize per the Task A.2 convention (matches capture-goldens.ts
// synthesizeContextOutcome so the legacy adapter's context path matches the golden with no
// allowlist entry needed).
function mapToOutcome(result: { verdict: string }, deps: LegacyRunner["deps"], input: RunInput): RunOutcome {
  const saved = deps.savedOutcomes?.[deps.savedOutcomes.length - 1];
  if (saved) return saved;
  return synthesizeContextOutcome(result.verdict, input);
}

function synthesizeContextOutcome(verdict: string, input: RunInput): RunOutcome {
  return {
    runId: input.runId,
    app: input.app,
    sha: input.sha.value,
    mode: input.mode,
    target: input.target,
    verdict: verdict as RunOutcome["verdict"],
    errorClass: null,
    gateSignals: {
      static: false,
      coverageRatio: null,
      valueScore: null,
      reviewerCorrections: [],
      flaky: false,
      retries: 0,
    },
    rulesRetrieved: [],
    at: new Date().toISOString(),
  };
}
