// src/server/run-history-sqlite-adapter.ts
//
// W3 F1 (CRITICAL, audit-verified cutover blocker): the REAL durable RunHistoryPort — bridges the
// qa-engine kernel's RunOutcome into src/server/history.ts's saveRunOutcome (the SQLite
// `run_outcomes` table), the SAME store the TUI trends view, /ask learning context, and the audit
// process all read. Without this adapter, production never sets CompositionConfig.historyFilePath
// (src/index.ts / src/cli.ts's createRewrittenEngineFactory({getAgentDeps}) call sites never pass
// it), so composition-root.ts's wireBridges() falls to InMemoryRunHistoryAdapter — a process-lifetime
// array that dies with the container, and even FileRunHistoryAdapter would only write a parallel
// JSONL nobody reads.
//
// This is the src/-importing seam CLAUDE.md carves out for exactly this class of bridge (mirrors
// rewritten-engine-factory.ts's own "E.3 seam" precedent: qa-engine/src stays src/-free; the src/
// collaborator is injected here, in src/, never imported into qa-engine). It lives in src/server/
// (not qa-engine/src/contexts/.../bridges/) because CLAUDE.md's "app-specificity lives only in
// config/; agents/models only in agents/" invariant reads through to "the durable control-plane
// store lives only in src/" — qa-engine's own run-history-port.adapter.ts explicitly documents this
// boundary ("the legacy's own control-plane store... lives in src/ and is OFF LIMITS to import").
//
// Field mapping (faithful, not fabricated): the kernel RunOutcome (qa-engine/src/shared-kernel/
// run-outcome.ts) is a DELIBERATE structural WIDENING of legacy's src/types.ts RunOutcome —
// errorClass is `string | null` (legacy's ErrorClass string-literal union is a subtype), reflection
// is `unknown` (legacy's StructuredReflection is a subtype), usage is `unknown` (legacy's RunUsage is
// a subtype). Every field legacy's saveRunOutcome persists has a same-named counterpart on the
// kernel type — this adapter is a structural pass-through, casting the widened optional/unknown
// fields back to their legacy-typed home at the boundary (the kernel's own documented direction:
// "any legacy value satisfies [the kernel type] without importing from downstream contexts" — the
// reverse cast here is the ONE place that direction is inverted, deliberately, at the src/ seam).
// Fields the kernel RunOutcome does NOT carry (confinement/usage/phaseTimings/catalogGate* live
// under kernel gateSignals too — see below) are threaded through unchanged; nothing is invented for
// a field the upstream RunQaUseCase never populated (e.g. reflection is never set by the rewritten
// engine yet — stays absent, exactly as legacy's own optional field allows).
import { saveRunOutcome } from "./history";
import type { RunHistoryPort } from "@contexts/qa-run-orchestration/application/ports/index.ts";
import type { RunOutcome as KernelRunOutcome } from "@kernel/run-outcome.ts";
import type { RunOutcome as LegacyRunOutcome } from "../types";

// Dependency injection is the testing strategy (CLAUDE.md): a test supplies a fake saveOutcome so
// the mapping is verifiable without touching the real (lazily-initialized, module-singleton)
// SQLite database history.ts owns.
export interface RunHistorySqliteAdapterDeps {
  saveOutcome: (outcome: LegacyRunOutcome) => void;
}

export const defaultRunHistorySqliteAdapterDeps: RunHistorySqliteAdapterDeps = {
  saveOutcome: saveRunOutcome,
};

// Maps the kernel's WIDE RunOutcome onto legacy's saveRunOutcome's expected shape. Every field is a
// direct structural carry-over (same name, kernel's type is a supertype of legacy's) — the only
// "narrowing" is a type-level cast at the optional/unknown fields (errorClass, reflection, usage),
// which is safe because the ONLY producer of a kernel RunOutcome on this path (RewrittenOrchestratorAdapter's
// toOutcome / RunQaUseCase's toRunOutcome) already derives errorClass via the re-ported labeler
// taxonomy (domain/helpers/error-class.ts, a verbatim port of src/qa/learning/taxonomy.ts) — so the
// string it produces is always a genuine ErrorClass member or null, never an arbitrary string.
export function toLegacyRunOutcome(outcome: KernelRunOutcome): LegacyRunOutcome {
  return {
    runId: outcome.runId,
    app: outcome.app,
    sha: outcome.sha,
    mode: outcome.mode,
    target: outcome.target,
    verdict: outcome.verdict,
    errorClass: outcome.errorClass as LegacyRunOutcome["errorClass"],
    gateSignals: {
      static: outcome.gateSignals.static,
      coverageRatio: outcome.gateSignals.coverageRatio,
      valueScore: outcome.gateSignals.valueScore,
      reviewerCorrections: outcome.gateSignals.reviewerCorrections,
      ...(outcome.gateSignals.reviewerRationale !== undefined ? { reviewerRationale: outcome.gateSignals.reviewerRationale } : {}),
      ...(outcome.gateSignals.reviewerApproved !== undefined ? { reviewerApproved: outcome.gateSignals.reviewerApproved } : {}),
      flaky: outcome.gateSignals.flaky,
      retries: outcome.gateSignals.retries,
      ...(outcome.gateSignals.confinement !== undefined ? { confinement: outcome.gateSignals.confinement } : {}),
      ...(outcome.gateSignals.usage !== undefined ? { usage: outcome.gateSignals.usage as LegacyRunOutcome["gateSignals"]["usage"] } : {}),
      ...(outcome.gateSignals.phaseTimings !== undefined ? { phaseTimings: outcome.gateSignals.phaseTimings } : {}),
      ...(outcome.gateSignals.preExecAmbiguityCatches !== undefined ? { preExecAmbiguityCatches: outcome.gateSignals.preExecAmbiguityCatches } : {}),
      ...(outcome.gateSignals.deterministicSelectorBlocks !== undefined ? { deterministicSelectorBlocks: outcome.gateSignals.deterministicSelectorBlocks } : {}),
      ...(outcome.gateSignals.catalogGateInWindow !== undefined ? { catalogGateInWindow: outcome.gateSignals.catalogGateInWindow } : {}),
      ...(outcome.gateSignals.catalogGateAdvisory !== undefined ? { catalogGateAdvisory: outcome.gateSignals.catalogGateAdvisory } : {}),
      ...(outcome.gateSignals.catalogGateFailClosed !== undefined ? { catalogGateFailClosed: outcome.gateSignals.catalogGateFailClosed } : {}),
    },
    rulesRetrieved: outcome.rulesRetrieved,
    ...(outcome.reflection !== undefined ? { reflection: outcome.reflection as LegacyRunOutcome["reflection"] } : {}),
    at: outcome.at,
  };
}

// The REAL production RunHistoryPort: every save() reaches the SAME SQLite run_outcomes table the
// legacy engine writes to (src/server/history.ts's saveRunOutcome, lazily-initialized on first use —
// see that module's own header). No in-memory/file fallback; a write failure propagates loudly
// (CLAUDE.md "surface integration errors loudly — never swallow errors into an empty result"),
// matching saveRunOutcome's own un-guarded synchronous better-sqlite3 call.
export class SqliteRunHistoryAdapter implements RunHistoryPort {
  constructor(private readonly deps: RunHistorySqliteAdapterDeps = defaultRunHistorySqliteAdapterDeps) {}

  async save(outcome: KernelRunOutcome): Promise<void> {
    this.deps.saveOutcome(toLegacyRunOutcome(outcome));
  }
}
