// qa-engine/src/shared-kernel/agent-role.ts
// WHO the agent is (role) and WHICH provider+model serves it. Kernel-resident because
// AgentRuntimePort.openSession() takes `role: AgentRole` and `RoleAssignment` appears in the port
// surface — placing them here keeps the kernel from forward-depending on agent-runtime/ (§5.1 P3).
// The 8 roles are the runtime union (src/agent-runtime/types.ts); the contract AgentRoleSchema is a
// narrower 6-member WIRE subset, not the domain vocabulary.

export type AgentRole =
  | "primary" | "reviewer" | "chat" | "worker"
  | "workerCode" | "maintainer" | "reflector" | "explorer";

export type AgentProvider = "opencode" | "codex";

export interface RoleAssignment {
  provider: AgentProvider;
  model: string;
}

// What a role is structurally allowed to do — the provider-agnostic capability policy. The judge, the
// read-only chat, the one-shot reflector, and the explorer never mutate the workspace.
export interface RoleCapabilities {
  canWrite: boolean;
}

const READ_ONLY_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>(["reviewer", "chat", "reflector", "explorer"]);

export function capabilitiesForRole(role: AgentRole): RoleCapabilities {
  return { canWrite: !READ_ONLY_ROLES.has(role) };
}
