// qa-engine/src/shared-kernel/run-mode.ts
// Run mode, target, and trigger source — the orthogonal axes a run is parameterized on. Carried from
// src/types.ts. Only `diff` runs classifyCommit; the others always generate (CLAUDE.md "Run modes").

export type TestTarget = "e2e" | "code";
export type TriggerSource = "webhook" | "manual";
export type RunMode = "diff" | "complete" | "exhaustive" | "manual" | "context";
export const RUN_MODES: readonly RunMode[] = ["diff", "complete", "exhaustive", "manual", "context"] as const;
