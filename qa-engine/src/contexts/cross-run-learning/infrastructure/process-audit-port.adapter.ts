// qa-engine/src/contexts/cross-run-learning/infrastructure/process-audit-port.adapter.ts
// sdd/migration-remediation Slice 5 (P1 process-audit reconnect, D-P1b): ProcessAuditPort adapter.
// Self-sources `recent` outcomes + `rules` via factory-injected reads, runs the deterministic
// auditProcess/applyAudit domain logic (../domain/process-audit.ts, a verbatim port of
// src/qa/learning/process-audit.ts), and dispatches each finding to its disposition's sink — all 3
// sinks (recordEngineIncident/deprecateRule/invalidateContext) injected from src via the factory
// (src/server/rewritten-engine-factory.ts). This context never imports src/ directly.
//
// GATING (design D-P1b) is TWO-LAYER, deliberately stricter than legacy (which called auditProcess
// unconditionally with an UNFILTERED recent window):
//   (1) EXTERNAL current-run gate — the use-case's own call-site condition (mirrors ReflectorPort's
//       gate: shouldDistillLearning(...) AND verdict !== "flaky" AND errorClass not in
//       {E-INFRA, E-FLAKY}), which decides WHETHER audit() is invoked at all for this run. This
//       adapter trusts that gate and does not re-check the current outcome's own verdict/class.
//   (2) INTERNAL streak-input gate — THIS adapter filters the recent-outcomes read (layer 2, below)
//       to exclude flaky/infra-class entries BEFORE they ever reach auditProcess's streak
//       calculation, so a recurring-engine-defect streak can never be polluted/broken by
//       infra noise. Documented deliberate improvement over legacy, not silent drift.
//
// Fault isolation (mirrors ReflectorPortAdapter's own documented contract on the sibling port): a
// throwing read, a throwing sink, or a hang past the configured timeout budget is caught/bounded
// INLINE and never re-thrown — the run's already-made verdict/ledger writes are made BEFORE this
// call and are structurally unaffected by anything that happens inside audit().
import { auditProcess, applyAudit, type ProcessFinding, type RuleView } from "../domain/process-audit.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";

// legacy parity: src/pipeline.ts's auditProcess wiring read `listRunOutcomes(app, 10)` and
// `listLearningRules(app, 50)` — same window sizes, ported verbatim.
const RECENT_LIMIT = 10;
const RULES_LIMIT = 50;

// Default timeout budget for one audit() call (reads + dispatch). Unlike ReflectorPortAdapter (which
// forwards timeoutMs to an external agent-session runtime that enforces it), process-audit has no
// LLM/agent session — this adapter races its own work against the budget so a slow injected
// read/sink can never hang the run that awaits it. Overridable via ProcessAuditPortDeps.timeoutMs.
export const PROCESS_AUDIT_TIMEOUT_MS = 10_000;

export interface ProcessAuditPortDeps {
  app: string;
  // Factory-injected reads — design D-P1b: "RunHistoryPort exposes only save() — the recent-outcomes
  // READ is a factory-injected fn." Newest-first, INCLUDING the just-persisted current outcome
  // (mirrors legacy's listRunOutcomes(app, N) ordering, called AFTER runHistory.save()).
  readRecentOutcomes: (app: string, limit: number) => Promise<RunOutcome[]> | RunOutcome[];
  readRules: (app: string, limit: number) => Promise<RuleView[]> | RuleView[];
  // The 3 SINKS (design D-P1b), all synchronous in production (history.ts/maintainer.ts) — mirrors
  // AuditRouterDeps' own sync contract exactly, so applyAudit's output can be dispatched directly.
  deprecateRule: (ruleId: string, reason: string) => void;
  recordEngineIncident: (finding: ProcessFinding) => void;
  invalidateContext: (reason: string) => boolean;
  // Injectable so a test can assert log lines without polluting stdout; defaults to console.log,
  // mirroring ReflectorPortAdapter's own onReflectError/onSkipDuplicate injectable-logger convention.
  log?: (line: string) => void;
  onAuditError?: (e: unknown) => void;
  timeoutMs?: number;
}

export class ProcessAuditPortAdapter {
  constructor(private readonly deps: ProcessAuditPortDeps) {}

  async audit(outcome: RunOutcome): Promise<void> {
    const { app, readRecentOutcomes, readRules, deprecateRule, recordEngineIncident, invalidateContext, timeoutMs } = this.deps;
    const log = this.deps.log ?? ((line: string) => console.log(line));
    const reportError = this.deps.onAuditError ?? ((e: unknown) => console.error("[ProcessAuditPortAdapter] audit failed (off-path, swallowed):", e));
    const budget = timeoutMs ?? PROCESS_AUDIT_TIMEOUT_MS;

    const run = async (): Promise<void> => {
      const [rawRecent, rules] = await Promise.all([
        Promise.resolve(readRecentOutcomes(app, RECENT_LIMIT)),
        Promise.resolve(readRules(app, RULES_LIMIT)),
      ]);
      // Two-layer gating, layer 2 (see this file's own header): exclude flaky/infra-class outcomes
      // from the streak input BEFORE reaching auditProcess.
      const recent = rawRecent.filter(
        (r) => r.verdict !== "flaky" && r.errorClass !== "E-INFRA" && r.errorClass !== "E-FLAKY",
      );
      const findings = auditProcess({ outcome, recent, rules });
      if (findings.length === 0) return;
      applyAudit(findings, { log, deprecateRule, recordEngineIncident, invalidateContext });
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        log(`[audit] process-audit timed out after ${budget}ms (fault-isolated — run continues, never blocks publish)`);
        resolve();
      }, budget);
    });

    try {
      await Promise.race([run(), timeout]);
    } catch (e) {
      // Off-path by contract: never gates publish, never affects the already-made verdict/ledger
      // writes. Logged, not re-thrown — mirrors ReflectorPortAdapter's documented convention.
      reportError(e);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
