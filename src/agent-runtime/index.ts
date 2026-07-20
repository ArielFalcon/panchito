// SHELL SURVIVOR (migration-tier-4d, D1-family): `src/agent-runtime/*` is DECLARED the permanent
// runtime-strategy shell (decided in `sdd/migration-remediation` Slice 8.D, commit `2f614e4`; the
// 8 qa-engine WRAP adapters that mirrored these files were deleted then). It owns the
// provider-agnostic facade (`AgentFacade`/`SingleAgentFacade`/`DualAgentFacade`) that dispatches
// each role (primary/reviewer/chat/...) to the OpenCode or Codex runtime strategy, plus each
// strategy's own raw process/SDK edge (`opencode-strategy.ts` wraps `opencode-client.ts`'s session
// closure; `codex-strategy.ts` spawns `codex exec`). This is provider-selection plumbing, not
// engine policy — the policy each strategy delegates to (transport resilience, SSE lifecycle,
// prompt assembly) already migrated to qa-engine in tier-4c.
export * from "./types";
export * from "./config";
export * from "./facades";
export * from "./opencode-strategy";
export * from "./codex-strategy";
