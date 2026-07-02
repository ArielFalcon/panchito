// test/characterization/side-effects.ts
// The runOutcomeEquivalent comparator does NOT model side effects (verdict/coverage only). The
// byte-equivalence proof asserts side effects SEPARATELY: which publish/issue path fired. This probe
// wraps the existing scenarios.ts CaptureDeps and records the side effect without changing behavior.
import type { CaptureDeps } from "./scenarios.ts";
import type { SideEffect } from "./side-effect-type.ts";

// Re-exported from side-effect-type.ts (a non-excluded, type-only module) so CI-gated importers like
// shadow-comparison.ts get the type WITHOUT pulling this tsconfig-excluded probe into project scope.
export type { SideEffect };

// Discovery (GATE A, shadow scenario): shadow mode NEVER calls publish*/openIssue — pipeline.ts's
// issueOrShadow()/the green-path branch route straight to deps.log(...) with a "(shadow)"-prefixed
// message instead (pipeline.ts:3181-3183, :3331-3333). scenarios.ts's makeDeps() does not wire
// deps.log at all, so runPipeline falls back to its internal no-op and the signal is otherwise
// unobservable. The probe installs a log observer (in addition to wrapping publish*/openIssue) so
// the shadow-log side effect is detectable without touching scenarios.ts or runPipeline itself.
const SHADOW_LOG_MARKER = "(shadow)";

export function probeSideEffects(deps: CaptureDeps): { deps: CaptureDeps; seen: () => SideEffect } {
  let effect: SideEffect = "none";
  const wrap =
    <A extends unknown[], R>(orig: (...a: A) => R, tag: SideEffect) =>
    (...a: A): R => {
      effect = tag;
      return orig(...a);
    };
  deps.publish = wrap(deps.publish, "pr");
  deps.publishCode = wrap(deps.publishCode, "pr");
  deps.publishContext = wrap(deps.publishContext, "pr");
  deps.openIssue = wrap(deps.openIssue, "issue");
  const origLog = deps.log;
  deps.log = (msg: string) => {
    if (effect === "none" && msg.includes(SHADOW_LOG_MARKER)) effect = "shadow-log";
    origLog?.(msg);
  };
  return { deps, seen: () => effect };
}

// Convention (Flag 3): context mode does NOT call saveOutcome; both the legacy adapter
// (legacy-pipeline.adapter.ts) and the golden (capture-goldens.ts) synthesize the outcome from the
// QaRunResult using persistOutcome's defaults. NO allowlist entry needed for the legacy path (it
// matches the golden). If the rewritten engine (Slice D) calls saveOutcome for context mode
// instead, that divergence must be declared in parity-allowlist.json at Task D.10.
export function synthesizeContextOutcome(verdict: string, app: string, sha: string) {
  return {
    app,
    sha,
    mode: "context",
    target: "e2e",
    verdict,
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
  };
}
