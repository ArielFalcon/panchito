// qa-engine/src/shared-kernel/run-step.ts
// The canonical pipeline-phase vocabulary for the progress stepper. Mirrors contract/events.ts
// RunStepSchema exactly (an unknown raw step is omitted, never invented). One source of truth so the
// orchestrator's phase labels and the wire enum cannot drift.

export type RunStep =
  | "gate" | "classify" | "setup" | "generate" | "validate"
  | "health" | "execute" | "coverage" | "retry" | "decide" | "done";
export const RUN_STEPS: readonly RunStep[] = [
  "gate", "classify", "setup", "generate", "validate",
  "health", "execute", "coverage", "retry", "decide", "done",
] as const;
