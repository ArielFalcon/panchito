// test/characterization/side-effect-type.ts
// The publish side-effect a run fired, in its OWN type-only module — deliberately SEPARATE from
// side-effects.ts (the runtime probe), which is tsconfig-excluded because it bridges to the legacy
// src/ harness via scenarios.ts. CI-gated characterization modules (shadow-comparison.ts, and the
// F.2 operator script) import this type FROM HERE so they typecheck cleanly, without pulling the
// excluded probe into the project's file list (which trips TS6307). side-effects.ts re-exports it,
// so this stays the single source of truth for the four publish outcomes.
export type SideEffect = "pr" | "issue" | "shadow-log" | "none";
