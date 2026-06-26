// qa-engine/src/contexts/agent-runtime/infrastructure/role-assignment-resolver.ts
// WRAP of src/agent-runtime/types.ts assignmentForRole. Preserves the DELIBERATE 3-explicit / 5-fallback
// policy (§5.3(4)): the adapter forwards EVERY role to the injected fn, which owns the fallback. It does
// NOT pre-filter roles. Config + fn injected so the test needs no opencode.json.
import type { RoleAssignmentResolver } from "../application/ports/index.ts";
import type { AgentRole, RoleAssignment } from "@kernel/agent-role.ts";

type AssignmentForRole = (cfg: unknown, role: AgentRole) => RoleAssignment;

export class RoleAssignmentResolverAdapter implements RoleAssignmentResolver {
  constructor(private readonly config: unknown, private readonly assignmentForRole: AssignmentForRole) {}
  resolve(role: AgentRole): RoleAssignment {
    return this.assignmentForRole(this.config, role);
  }
}
