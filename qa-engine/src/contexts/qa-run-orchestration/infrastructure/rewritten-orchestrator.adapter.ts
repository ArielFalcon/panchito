// qa-engine/src/contexts/qa-run-orchestration/infrastructure/rewritten-orchestrator.adapter.ts
// RewrittenOrchestratorAdapter (design §5.3(1)) — RunPipelinePort over the rewritten domain.
// COMPLETE: it fully drives RunQaUseCase through the 11 ports. The composition root (Slice E)
// supplies REAL port adapters so this runs a full QA run end-to-end (required for the Slice F
// shadow run). Only the port implementations are swapped between the unit test (stubs, this task)
// and production (real adapters, Task E.0) — the adapter logic itself does not change.
//
// NO decision logic lives here. This is a THIN composition shell: it maps a RunInput into a
// RunQaUseCase invocation (assembling RunQaConfig from the config this adapter is constructed
// with), then maps the resulting RunQaResult (RunDecision + gate signals + cases) into a
// RunOutcome — the SAME shape RunHistoryPort.save already persisted for this run. It does NOT
// re-derive the outcome from scratch: RunQaUseCase.run() has ALREADY called runHistory.save() (or,
// on the entry-gate/classify-skip terminal exits, never calls it at all) before this adapter ever
// sees the result — see the per-source note below on why this method still SYNTHESIZES an outcome
// rather than reading back whatever was (or wasn't) saved.
//
// Mirrors LegacyPipelineAdapter's own contract (../legacy-pipeline.adapter.ts): both satisfy
// RunPipelinePort.run(RunInput): Promise<RunOutcome>, and both are interchangeable at the strangler
// seam. The legacy adapter surfaces the outcome the WRAPPED runPipeline itself saved (reading back
// deps.savedOutcomes); this adapter cannot do the equivalent read-back because RunHistoryPort has
// no query capability (save-only, one-way) — so it derives an EQUIVALENT RunOutcome directly from
// the RunQaResult the use-case already returns, using the exact same field derivation the
// use-case's own (private) toRunOutcome() applies. This keeps the two adapters' RunOutcome shapes
// structurally comparable without requiring RunHistoryPort to grow a read path.

import type { RunPipelinePort, RunInput } from "../application/ports/index.ts";
import { RunQaUseCase, type RunQaUseCaseDeps, type RunQaConfig, type RunQaResult } from "../application/run-qa.use-case.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";

export interface RewrittenOrchestratorAdapterDeps extends Omit<RunQaUseCaseDeps, "config"> {
  config?: Partial<RunQaConfig>;
}

export class RewrittenOrchestratorAdapter implements RunPipelinePort {
  private readonly useCase: RunQaUseCase;

  constructor(private readonly deps: RewrittenOrchestratorAdapterDeps) {
    this.useCase = new RunQaUseCase(deps);
  }

  async run(input: RunInput, signal?: AbortSignal): Promise<RunOutcome> {
    const result = await this.useCase.run(input, signal);
    return toOutcome(input, result);
  }
}

// Maps RunQaResult (RunDecision + gateSignals + cases) -> RunOutcome, matching the SAME field
// derivation RunQaUseCase's own (private) toRunOutcome() uses to build the outcome it already
// persisted via runHistory.save(). Kept as a free function (not a use-case method) because the
// use-case's toRunOutcome() is intentionally private — its own scope is "what gets persisted",
// not "what this driving-side adapter returns to its caller"; duplicating the derivation here
// (rather than widening the use-case's own surface) keeps NO decision logic leaking into this
// adapter — it is a pure structural remap of data the use-case ALREADY computed.
function toOutcome(input: RunInput, result: RunQaResult): RunOutcome {
  return {
    runId: input.runId,
    app: input.app,
    sha: input.sha.toString(),
    mode: input.mode,
    target: input.target,
    verdict: result.decision.verdict,
    // FIX 4 (judgment-day D.7): forward the SAME errorClass the use-case already derived (via the
    // re-ported labeler taxonomy, domain/helpers/error-class.ts) and persisted — RunHistoryPort has
    // no read-back path, so re-hardcoding null here would silently drop what the use-case computed.
    errorClass: result.errorClass,
    gateSignals: {
      static: result.gateSignals.static,
      coverageRatio: result.gateSignals.coverageRatio,
      // FIX 3 (judgment-day D.7): forward the SAME valueScore the use-case's ObjectiveSignalPort.
      // measure() call produced (the mutation-testing oracle result) — never re-hardcode null.
      valueScore: result.gateSignals.valueScore,
      reviewerCorrections: [],
      // FIX 1 (judgment-day D.7): forward reviewerApproved ONLY when the use-case's own RunQaResult
      // carries it (i.e. the review phase genuinely ran) — mirrors toRunOutcome()'s own
      // extra?.reviewerApproved !== undefined guard, never fabricating a value the use-case itself
      // never computed.
      ...(result.gateSignals.reviewerApproved !== undefined ? { reviewerApproved: result.gateSignals.reviewerApproved } : {}),
      flaky: result.decision.verdict === "flaky",
      retries: result.gateSignals.retries,
      preExecAmbiguityCatches: result.gateSignals.preExecAmbiguityCatches,
      deterministicSelectorBlocks: result.gateSignals.deterministicSelectorBlocks,
    },
    rulesRetrieved: [],
    at: new Date().toISOString(),
  };
}
