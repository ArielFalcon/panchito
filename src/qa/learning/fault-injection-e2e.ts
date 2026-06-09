// e2e value oracle via fault-injection — the agnostic, no-redeploy "mutation" for e2e.
//
// You cannot mutate a deployed app per-run (microservices, no second environment), so instead of
// mutating source we corrupt what the browser RECEIVES: the suite is re-run against the SAME live
// DEV with QA_FAULT_INJECT=1, and the seed's `_faultInject` fixture corrupts JSON response VALUES
// (numbers/booleans flipped; status, shape and strings/ids preserved so auth and refs survive).
//
// A spec that STAYS GREEN under corrupted data has a weak oracle (it would accept a backend
// regression). valueScore = the fraction of baseline-passing specs that NOTICED the corruption —
// the "response-oracle catch-rate". This is a PARTIAL signal (it does not cover pure client-side
// logic or no-network flows) and is SIGNAL-ONLY: the caller treats failures as non-blocking and
// never gates publish on it.

import { runE2E, defaultExecuteDeps } from "../execute";
import type { OracleInput, ValueOracleResult } from "./oracle-types";
import type { QaCase, QaRunResult } from "../../types";

// Pure: of the specs that passed at baseline, how many flipped to fail/flaky under corrupted
// responses? A flip means the spec's oracle was strong enough to catch wrong data.
export function computeFaultInjectionScore(
  baselinePass: string[],
  corrupted: QaCase[],
): { valueScore: number | null; killed: number; total: number } {
  if (baselinePass.length === 0) return { valueScore: null, killed: 0, total: 0 };
  const statusByName = new Map(corrupted.map((c) => [c.name, c.status]));
  let killed = 0;
  for (const name of baselinePass) {
    const st = statusByName.get(name);
    if (st === "fail" || st === "flaky") killed++; // noticed the corruption
  }
  return { valueScore: killed / baselinePass.length, killed, total: baselinePass.length };
}

export interface FaultInjectionDeps {
  runCorrupted(args: { dir: string; baseUrl: string; namespace: string }): Promise<QaRunResult>;
}

export const defaultFaultInjectionDeps: FaultInjectionDeps = {
  runCorrupted: ({ dir, baseUrl, namespace }) =>
    runE2E(dir, { baseUrl, namespace, faultInject: true }, defaultExecuteDeps),
};

export async function runFaultInjectionOracle(
  input: OracleInput,
  deps: FaultInjectionDeps = defaultFaultInjectionDeps,
): Promise<ValueOracleResult> {
  if (!input.e2eDir || !input.baseUrl || !input.baselineCases || input.baselineCases.length === 0) {
    return { valueScore: null, mutantCount: 0, killedCount: 0, details: "fault-injection needs e2eDir + baseUrl + baseline-passing specs" };
  }
  // A distinct namespace isolates this pass's (possibly broken) data from the published run's.
  const run = await deps.runCorrupted({ dir: input.e2eDir, baseUrl: input.baseUrl, namespace: `${input.namespace}-fi` });
  if (run.verdict === "infra-error") {
    return { valueScore: null, mutantCount: 0, killedCount: 0, details: "fault-injection re-run inconclusive (infra)" };
  }
  const { valueScore, killed, total } = computeFaultInjectionScore(input.baselineCases, run.cases);
  return {
    valueScore,
    mutantCount: total,
    killedCount: killed,
    details: `${killed}/${total} baseline-passing specs noticed corrupted responses (response-oracle catch-rate)`,
  };
}
