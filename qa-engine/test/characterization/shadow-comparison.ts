// test/characterization/shadow-comparison.ts
// Compares a legacy RunOutcome to a rewritten RunOutcome from the SAME sha — the Slice F shadow proof.
// Reuses runOutcomeEquivalent (§10), the SAME behavioral projection the golden-parity net uses, and
// renders a human-readable report line. shadow:true means NEITHER engine fires a real PR/Issue (both
// route to the shadow-log — side-effects.ts), so the equivalence proof is on the persisted RunOutcome
// only. When the operator's probe (F.2) recorded a concrete SideEffect per engine, it is passed in and
// any divergence between the two OBSERVED effects is flagged too — an observed comparison, never a
// re-derivation of publish policy (that lives in workspace-and-publication, not here).
import type { RunOutcome } from "@kernel/run-outcome.ts";
import { runOutcomeEquivalent, type ComparableOutcome } from "./equivalence.ts";
import type { SideEffect } from "./side-effect-type.ts";

// RunOutcome is structurally a ComparableOutcome (the SAME cast the golden harness uses at
// golden-outcome.harness.ts:937) — one comparator surface for both engines, no parallel projection.
function toComparable(o: RunOutcome): ComparableOutcome {
  return o as unknown as ComparableOutcome;
}

export interface ShadowSideEffects {
  legacy?: SideEffect;
  rewritten?: SideEffect;
}

export interface ShadowComparison {
  equal: boolean;
  diff?: string;
  report: string;
}

// Proves the rewritten engine produced a behaviorally-equivalent RunOutcome to legacy on the same sha.
export function compareShadowRun(
  legacy: RunOutcome,
  rewritten: RunOutcome,
  observed?: ShadowSideEffects,
): ShadowComparison {
  const cmp = runOutcomeEquivalent(toComparable(legacy), toComparable(rewritten));

  // Under shadow:true both engines suppress PR/Issue and log instead, so a concrete side effect is
  // "shadow-log" or "none" for both. When the probe recorded them, flag a divergence between the two.
  const seDiff =
    observed && observed.legacy !== observed.rewritten
      ? `sideEffect: ${observed.legacy ?? "n/a"} !== ${observed.rewritten ?? "n/a"}`
      : undefined;

  const equal = cmp.equal && seDiff === undefined;
  const diff = [cmp.diff, seDiff].filter(Boolean).join("; ") || undefined;
  const report = renderReport(legacy, rewritten, equal, diff, observed);

  return { equal, ...(diff !== undefined ? { diff } : {}), report };
}

function renderReport(
  legacy: RunOutcome,
  rewritten: RunOutcome,
  equal: boolean,
  diff: string | undefined,
  observed: ShadowSideEffects | undefined,
): string {
  const head = `shadow-run ${legacy.app}@${legacy.sha} [${legacy.mode}/${legacy.target}]`;
  const verdicts = `legacy=${legacy.verdict} rewritten=${rewritten.verdict}`;
  const se = observed
    ? ` sideEffect(legacy=${observed.legacy ?? "n/a"}, rewritten=${observed.rewritten ?? "n/a"})`
    : "";
  const status = equal ? "EQUIVALENT ✓ (rewritten ≡ legacy)" : `DIVERGENT ✗ — ${diff}`;
  return `${head}: ${verdicts}${se} → ${status}`;
}
