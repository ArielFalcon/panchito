// qa-engine/src/contexts/agent-runtime/infrastructure/opencode-runtime.strategy.ts
// WRAP of src/agent-runtime/opencode-strategy.ts OpenCodeRuntimeStrategy. Delegates openSession/health/
// listModels/restart to the injected legacy strategy. The RoleAssignmentResolver maps AgentRole → the
// provider+model the legacy open() expects; the descriptor (Task A.1) threads the run→session SSE mapping.
// PER-PROVIDER ISOLATION: this adapter holds NO breaker state — the wrapped strategy owns its own
// independent circuit-breaker (a Codex outage must never trip this one). Do not add shared global state.
import type { AgentRuntimeStrategy, AgentSession, OpenSessionOpts, RoleAssignmentResolver,
  AgentProviderHealth, AgentModelInfo, UsageSnapshot, AgentTurnEvent, AgentOpenDescriptor } from "../application/ports/index.ts";
import type { AgentRole } from "@kernel/agent-role.ts";

// Structural shape of the legacy strategy (no src/ import at runtime — only the optional parity test may).
// The open() callback param types match the REAL src/agent-runtime/types.ts AgentRuntimeStrategy.openSession
// signature (onUsage: UsageSnapshot, onTurn: AgentTurnEvent): the port forwards those richer callbacks here,
// so the seam must accept them (an `unknown` param would be contravariant-incompatible under strict mode).
interface LegacyStrategy {
  provider: "opencode" | "codex";
  open(agent: string, cwd: string, opts?: { signal?: AbortSignal; timeoutMs?: number; model?: string;
    onUsage?: (u: UsageSnapshot) => void; onTurn?: (t: AgentTurnEvent) => void; descriptor?: AgentOpenDescriptor }): Promise<LegacySession>;
  health(): Promise<AgentProviderHealth>;
  listModels(): Promise<AgentModelInfo[]>;
  restart?(opts?: { apiKey?: string; reason?: string }): Promise<AgentProviderHealth>;
  dispose?(): void | Promise<void>;
}
interface LegacySession {
  id: string;
  prompt(text: string, opts?: { textOnly?: boolean; round?: number; isRepair?: boolean; sectionSizes?: Record<string, number> | null }): Promise<string>;
  dispose(): Promise<void>;
}

export class OpenCodeRuntimeStrategyAdapter implements AgentRuntimeStrategy {
  readonly provider = "opencode" as const;
  // roleToAgentName is INJECTED (like AgentRuntimeAdapter, Task A.14) so the test supplies the real inverse
  // map and a wrong mapping is caught by the agent-argument assertion — not hidden behind a module stub.
  constructor(
    private readonly legacy: LegacyStrategy,
    private readonly resolver: RoleAssignmentResolver,
    private readonly roleToAgentName: (r: AgentRole) => string,
  ) {}

  async openSession(role: AgentRole, cwd: string, opts?: OpenSessionOpts): Promise<AgentSession> {
    const assignment = this.resolver.resolve(role);
    const session = await this.legacy.open(this.roleToAgentName(role), cwd, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      model: opts?.model ?? assignment.model,
      ...(opts?.onUsage ? { onUsage: opts.onUsage } : {}),
      ...(opts?.onTurn ? { onTurn: opts.onTurn } : {}),
      ...(opts?.descriptor ? { descriptor: opts.descriptor } : {}),
    });
    // Adapt the legacy session (prompt → string) to the port session (prompt → { output }).
    return {
      prompt: async (text, o) => ({ output: await session.prompt(text, o) }),
      dispose: () => session.dispose(),
    };
  }
  health(): Promise<AgentProviderHealth> { return this.legacy.health(); }
  listModels(): Promise<AgentModelInfo[]> { return this.legacy.listModels(); }
  restart(o?: { apiKey?: string; reason?: string }): Promise<AgentProviderHealth> {
    return this.legacy.restart ? this.legacy.restart(o) : this.legacy.health();
  }
  dispose(): void | Promise<void> { return this.legacy.dispose?.(); }
}

// The role→legacy-name map is INJECTED (constructor param above), NOT a module stub — so the test supplies
// the real map and the agent-argument assertion catches a wrong one. The canonical map is the INVERSE of
// LEGACY_AGENT_TO_ROLE in src/agent-runtime/facades.ts ("qa-generator"→primary, "qa-reviewer"→reviewer,
// "qa-explorer"→explorer, …); Plan-6 wiring constructs the adapter with it. Exporting a default inverse-map
// helper here is optional — keep it OUT of the adapter so no wrong identity-default can leak into wiring.
