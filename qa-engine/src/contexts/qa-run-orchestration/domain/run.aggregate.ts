// qa-engine/src/contexts/qa-run-orchestration/domain/run.aggregate.ts
// The Run aggregate (design §5.3(1)). Identity = RunId+Sha+App; the lifecycle (gate→analyze→
// generate→review→validate→execute→coverage→decide) is GUARDED so a phase cannot be skipped, moved
// backward, or transitioned after the run is finalized. Replaces the in-place-mutated
// `QaRunResult`/`RunRecord` local from src/pipeline.ts.
//
// consecutiveReviewerFailures is PER-RUN here (eliminates the module-level cross-run `let` at
// src/pipeline.ts:84 — **R2**): reviewer-outage detection is instance state on this aggregate, not
// a process global shared across every queue entry. The 3-strike threshold and reset-on-success
// semantics are ported VERBATIM from src/pipeline.ts:1695-1717 (`>= 3` triggers CRITICAL logging;
// a successful reviewer response resets the counter to 0).
//
// Immutable: every transition method returns a NEW Run instance rather than mutating in place.

import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { Sha } from "@kernel/sha.ts";

// Ported invariant from src/pipeline.ts:1695-1717 — 3 consecutive reviewer failures (either a
// thrown error from the reviewer call, or an unparseable verdict) triggers a CRITICAL reviewer-
// outage state. A successful reviewer response resets the counter to 0.
const REVIEWER_OUTAGE_THRESHOLD = 3;

// A minimal identity value object — no dedicated RunId VO existed prior to this task (the legacy
// `RunOptions.runId` is a bare optional `string`). Guards only against an empty identity; the
// legacy code treats runId as an opaque namespace/log tag, so no further validation is warranted.
export class RunId {
  private constructor(readonly value: string) {}

  static of(raw: string): RunId {
    const v = raw.trim();
    if (v.length === 0) {
      throw new Error("RunId: must not be empty");
    }
    return new RunId(v);
  }

  toString(): string {
    return this.value;
  }
}

export type RunPhase =
  | "gate"
  | "analyze"
  | "generate"
  | "review"
  | "validate"
  | "execute"
  | "coverage"
  | "decide"
  | "finalized";

// The guarded phase order. Each phase may only advance to the NEXT entry in this list — skipping
// or moving backward is rejected. "finalized" is reached only via finalize(), never via advanceTo().
const PHASE_ORDER: readonly RunPhase[] = [
  "gate",
  "analyze",
  "generate",
  "review",
  "validate",
  "execute",
  "coverage",
  "decide",
];

export interface RunStartInput {
  runId: RunId;
  sha: Sha;
  app: string;
}

export class Run {
  private constructor(
    readonly runId: RunId,
    readonly sha: Sha,
    readonly app: string,
    readonly phase: RunPhase,
    readonly reviewerFailureCount: number,
    readonly verdict: RunVerdict | undefined,
  ) {}

  static start(input: RunStartInput): Run {
    return new Run(input.runId, input.sha, input.app, "gate", 0, undefined);
  }

  // Guarded transition: only the NEXT phase in PHASE_ORDER is a legal target. Throws on skip,
  // backward movement, a repeated no-op transition, or any transition once finalized.
  advanceTo(next: RunPhase): Run {
    if (this.phase === "finalized") {
      throw new Error(`Run.advanceTo: cannot advance — this run is already finalized`);
    }
    const currentIndex = PHASE_ORDER.indexOf(this.phase);
    const nextIndex = PHASE_ORDER.indexOf(next);
    if (nextIndex !== currentIndex + 1) {
      throw new Error(`Run.advanceTo: cannot advance from "${this.phase}" to "${next}" — phases must advance one step at a time, in order`);
    }
    return new Run(this.runId, this.sha, this.app, next, this.reviewerFailureCount, this.verdict);
  }

  // Guarded terminal transition: only legal from "decide", and only once. A finalized run can never
  // transition again (advanceTo or finalize both reject on an already-finalized instance).
  finalize(verdict: RunVerdict): Run {
    if (this.phase === "finalized") {
      throw new Error(`Run.finalize: cannot finalize — this run is already finalized`);
    }
    if (this.phase !== "decide") {
      throw new Error(`Run.finalize: cannot finalize from phase "${this.phase}" — must be at "decide"`);
    }
    return new Run(this.runId, this.sha, this.app, "finalized", this.reviewerFailureCount, verdict);
  }

  // Ports src/pipeline.ts:1695/1707 — increments the PER-INSTANCE reviewer-failure counter. Fixes
  // R2: two Run instances never share this count, unlike the legacy module-level `let`.
  recordReviewerFailure(): Run {
    return new Run(this.runId, this.sha, this.app, this.phase, this.reviewerFailureCount + 1, this.verdict);
  }

  // Ports src/pipeline.ts:1717 — reset on a successful (parseable) reviewer response.
  resetReviewerFailures(): Run {
    return new Run(this.runId, this.sha, this.app, this.phase, 0, this.verdict);
  }

  // Ports the `consecutiveReviewerFailures >= 3` check (src/pipeline.ts:1696/1708).
  reviewerOutage(): boolean {
    return this.reviewerFailureCount >= REVIEWER_OUTAGE_THRESHOLD;
  }
}
