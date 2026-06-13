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

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runE2E, defaultExecuteDeps } from "../execute";
import type { OracleInput, ValueOracleResult } from "./oracle-types";
import type { QaCase, QaRunResult } from "../../types";

// A failure caused by the corrupted value BREAKING the flow (navigation/network/context death)
// rather than an assertion NOTICING wrong data — it would have failed regardless of assertion
// strength, so it is noise, not a real "kill". Deliberately NARROW: only unambiguous flow-breaks.
// A plain assertion timeout ("expect(locator).toBeVisible timed out") is a genuine catch and is
// intentionally NOT matched here.
const FLOW_BREAK = /net::ERR|\bERR_[A-Z_]+|page\.goto|Target (?:closed|page, context or browser has been closed)|Execution context was destroyed|ECONNREFUSED/i;

function isFlowBreak(c: QaCase): boolean {
  return FLOW_BREAK.test(`${c.detail ?? ""} ${c.reason ?? ""}`);
}

// Pure: of the specs that passed at baseline, how many flipped to fail/flaky under corrupted
// responses BECAUSE AN ASSERTION CAUGHT IT (not because the corruption broke navigation)? A clean
// flip means the spec's oracle was strong enough to catch wrong data.
export function computeFaultInjectionScore(
  baselinePass: string[],
  corrupted: QaCase[],
): { valueScore: number | null; killed: number; total: number } {
  if (baselinePass.length === 0) return { valueScore: null, killed: 0, total: 0 };
  const byName = new Map(corrupted.map((c) => [c.name, c]));
  let killed = 0;
  for (const name of baselinePass) {
    const c = byName.get(name);
    if (!c) continue;
    if (c.status === "fail" || c.status === "flaky") {
      if (isFlowBreak(c)) continue; // the corruption broke the flow, not a strong-assertion catch
      killed++; // noticed the corruption via an assertion
    }
  }
  return { valueScore: killed / baselinePass.length, killed, total: baselinePass.length };
}

export interface FaultInjectionDeps {
  runCorrupted(args: { dir: string; baseUrl: string; namespace: string }): Promise<QaRunResult>;
  // How many JSON responses the seed's `_faultInject` fixture ACTUALLY corrupted during the
  // re-run, summed from the marker dumps it writes to .qa/fault-injection/<namespace>/.
  // 0 ⇒ the app exposed no JSON API surface to corrupt: the oracle is NOT APPLICABLE and must
  // score null — scoring 0 would label every green run E-VALUE-SURVIVED on a static site and
  // systematically demote healthy rules. (Repos seeded before the marker existed also read 0,
  // which degrades to the safe "no signal" side.)
  countInjected(e2eDir: string, namespace: string): number;
}

export const defaultFaultInjectionDeps: FaultInjectionDeps = {
  // Desktop-only on purpose: the oracle measures assertion strength, not viewport behavior,
  // and the seed runs every spec in BOTH projects — one project halves the re-run cost.
  // A repo whose config renamed the seed's "desktop" project fails the pass → infra-error
  // → valueScore null (inconclusive), never a wrong score.
  runCorrupted: ({ dir, baseUrl, namespace }) =>
    runE2E(dir, { baseUrl, namespace, faultInject: true, project: "desktop" }, defaultExecuteDeps),
  countInjected: (e2eDir, namespace) => {
    try {
      const dir = join(e2eDir, ".qa", "fault-injection", namespace);
      let total = 0;
      for (const f of readdirSync(dir)) {
        try {
          total += Number((JSON.parse(readFileSync(join(dir, f), "utf8")) as { corrupted?: unknown }).corrupted) || 0;
        } catch {
          /* unreadable dump — skip */
        }
      }
      return total;
    } catch {
      return 0; // no marker dir — nothing was corrupted
    }
  },
};

export async function runFaultInjectionOracle(
  input: OracleInput,
  deps: FaultInjectionDeps = defaultFaultInjectionDeps,
): Promise<ValueOracleResult> {
  if (!input.e2eDir || !input.baseUrl || !input.baselineCases || input.baselineCases.length === 0) {
    return { valueScore: null, mutantCount: 0, killedCount: 0, details: "fault-injection needs e2eDir + baseUrl + baseline-passing specs" };
  }
  // A distinct namespace isolates this pass's (possibly broken) data from the published run's.
  const fiNamespace = `${input.namespace}-fi`;
  const run = await deps.runCorrupted({ dir: input.e2eDir, baseUrl: input.baseUrl, namespace: fiNamespace });
  if (run.verdict === "infra-error") {
    return { valueScore: null, mutantCount: 0, killedCount: 0, details: "fault-injection re-run inconclusive (infra)" };
  }
  // Not applicable ≠ weak: if the fixture intercepted no JSON at all (static site, no API
  // traffic in these flows), there was nothing to notice and the pass proves nothing.
  if (deps.countInjected(input.e2eDir, fiNamespace) === 0) {
    return { valueScore: null, mutantCount: 0, killedCount: 0, details: "no JSON responses were intercepted — fault-injection is not applicable to this app's flows (no score)" };
  }
  // Score only the baseline-passing specs the corrupted pass actually executed: a spec absent
  // from the re-run (filtered project, skipped) carries no evidence about its oracle strength.
  const ranCorrupted = new Set(run.cases.map((c) => c.name));
  const scoreable = input.baselineCases.filter((n) => ranCorrupted.has(n));
  if (scoreable.length === 0) {
    return { valueScore: null, mutantCount: 0, killedCount: 0, details: "the corrupted re-run executed none of the baseline-passing specs (inconclusive)" };
  }
  const { valueScore, killed, total } = computeFaultInjectionScore(scoreable, run.cases);
  return {
    valueScore,
    mutantCount: total,
    killedCount: killed,
    details: `${killed}/${total} baseline-passing specs noticed corrupted responses (response-oracle catch-rate)`,
  };
}
