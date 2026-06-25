// qa-engine/src/shared-kernel/contract/index.ts
// The FROZEN external wire surface, re-exported from src/contract/* so the kernel owns one canonical
// reference to it without copying the zod schemas (which codegen the SDK; openapi.json is frozen by
// the Plan-1 drift-guard). The kernel re-exports; it does not redefine.
//
// SELECTIVE re-export only: AgentRole, AgentProvider, and RoleAssignment are EXCLUDED because the
// kernel owns canonical versions in agent-role.ts. Re-exporting the 6-member wire AgentRole from
// commands.ts would silently shadow the 8-member kernel union. Analytics view DTOs (TrendsViewSchema,
// ReportViewSchema, IntelligenceViewSchema) are excluded — they belong to the analytics surface.

// All events exports are safe (events.ts does not export AgentRole/AgentProvider/RoleAssignment).
export * from "../../../../src/contract/events.ts";

// Selective commands exports — only wire/run surface, excluding kernel-owned names and analytics DTOs.
export {
  AgentRoleSchema as ContractAgentRoleSchema,
  AgentProviderSchema,
  // Excluded: AgentRole, AgentProvider, RoleAssignment (kernel owns canonical versions).
  // Excluded: TrendsViewSchema, ReportViewSchema, IntelligenceViewSchema (analytics surface).
  // Note: AgentRuntimeModeSchema and RunPipelineCommandSchema do not exist in this version of commands.ts.
} from "../../../../src/contract/commands.ts";
