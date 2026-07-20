// src/contexts/objective-signal/infrastructure/fault-injection-oracle.adapter.ts
// ValueOraclePort for the E2E target. Self-contained (migration-tier-1-2, Slice 2): the
// orchestration previously in src/qa/learning/fault-injection-e2e.ts's runFaultInjectionOracle is
// absorbed directly into measure() — this adapter no longer wraps a legacy runner closure. The
// pure scoring half (computeFaultInjectionScore/isFlowBreak) lives in
// ../domain/fault-injection-score.ts. Signal-only by contract: a null valueScore never gates
// publish.
//
// Ctor collaborators stay effectful and src-bound (Playwright re-run via runE2E, node:fs marker
// reads) — injected by the composition factory (rewritten-engine-factory.ts), which is the only
// src<->qa-engine bridge for this adapter.
import type { ValueOraclePort, ValueOracleResult } from "../application/ports/index.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { computeFaultInjectionScore } from "../domain/fault-injection-score.ts";

// Local structural type replacing the legacy src/types.ts QaRunResult import — only the fields
// this orchestration actually reads.
interface CorruptedRunResult {
  verdict: string;
  cases: QaCase[];
}

type RunCorrupted = (args: { dir: string; baseUrl: string; namespace: string }) => Promise<CorruptedRunResult>;
type CountInjected = (e2eDir: string, namespace: string) => number;

export class FaultInjectionOracleAdapter implements ValueOraclePort {
  constructor(
    // Re-runs the suite against DEV with fault-injection enabled (Playwright, src-bound).
    private readonly runCorrupted: RunCorrupted,
    // How many JSON responses the seed's `_faultInject` fixture ACTUALLY corrupted during the
    // re-run. 0 ⇒ the app exposed no JSON API surface to corrupt: the oracle is NOT APPLICABLE
    // and must score null — scoring 0 would label every green run E-VALUE-SURVIVED on a static
    // site and systematically demote healthy rules.
    private readonly countInjected: CountInjected,
    private readonly baseUrl: string, // live DEV URL (from the App config at wiring time)
  ) {}

  async measure(br: BlastRadius, repoDir: string, namespace: string, baselineCases?: string[]): Promise<ValueOracleResult> {
    if (!repoDir || !this.baseUrl || !baselineCases || baselineCases.length === 0) {
      return {
        valueScore: null,
        mutantCount: 0,
        killedCount: 0,
        details: "fault-injection needs e2eDir + baseUrl + baseline-passing specs",
      };
    }
    // A distinct namespace isolates this pass's (possibly broken) data from the published run's.
    const fiNamespace = `${namespace}-fi`;
    const run = await this.runCorrupted({ dir: repoDir, baseUrl: this.baseUrl, namespace: fiNamespace });
    if (run.verdict === "infra-error") {
      return { valueScore: null, mutantCount: 0, killedCount: 0, details: "fault-injection re-run inconclusive (infra)" };
    }
    // Not applicable ≠ weak: if the fixture intercepted no JSON at all (static site, no API
    // traffic in these flows), there was nothing to notice and the pass proves nothing.
    if (this.countInjected(repoDir, fiNamespace) === 0) {
      return {
        valueScore: null,
        mutantCount: 0,
        killedCount: 0,
        details: "no JSON responses were intercepted — fault-injection is not applicable to this app's flows (no score)",
      };
    }
    // Score only the baseline-passing specs the corrupted pass actually executed: a spec absent
    // from the re-run (filtered project, skipped) carries no evidence about its oracle strength.
    const ranCorrupted = new Set(run.cases.map((c) => c.name));
    const scoreable = baselineCases.filter((n) => ranCorrupted.has(n));
    if (scoreable.length === 0) {
      return {
        valueScore: null,
        mutantCount: 0,
        killedCount: 0,
        details: "the corrupted re-run executed none of the baseline-passing specs (inconclusive)",
      };
    }
    const { valueScore, killed, total } = computeFaultInjectionScore(scoreable, run.cases);
    return {
      valueScore,
      mutantCount: total,
      killedCount: killed,
      details: `${killed}/${total} baseline-passing specs noticed corrupted responses (response-oracle catch-rate)`,
    };
  }
}
