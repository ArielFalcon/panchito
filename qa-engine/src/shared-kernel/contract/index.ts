// qa-engine/src/shared-kernel/contract/index.ts
// The FROZEN external wire surface. `events.ts` and `commands.ts` in this directory are now the
// canonical source of truth (Plan 7.3 — moved from src/contract/*, which re-exports back FROM here
// during coexistence so legacy src/ consumers keep resolving). The kernel re-exports; it does not
// redefine.
//
// SELECTIVE re-export only: AgentRole, AgentProvider, and RoleAssignment are EXCLUDED because the
// kernel owns canonical versions in agent-role.ts. Re-exporting the 6-member wire AgentRole from
// commands.ts would silently shadow the 8-member kernel union. Analytics view DTOs (TrendsViewSchema,
// ReportViewSchema, IntelligenceViewSchema) are excluded — they belong to the analytics surface.

// All events exports are safe (events.ts does not export AgentRole/AgentProvider/RoleAssignment).
export * from "./events";

// Selective commands exports — only wire/run surface, excluding kernel-owned names and analytics DTOs.
export {
  AgentRoleSchema as ContractAgentRoleSchema,
  AgentProviderSchema,
  // Excluded: AgentRole, AgentProvider, RoleAssignment (kernel owns canonical versions).
  // Excluded: TrendsViewSchema, ReportViewSchema, IntelligenceViewSchema (analytics surface).
  // Note: AgentRuntimeModeSchema and RunPipelineCommandSchema do not exist in this version of commands.ts.
} from "./commands";
