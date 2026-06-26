// src/contexts/generation/infrastructure/agent-runtime.adapter.ts
// WRAP of the src/integrations/opencode-client.ts session lifecycle (AgentDeps.open) behind the kernel
// AgentRuntimePort. Generation consumes this port from the kernel (§5.2). The descriptor threads the
// run→session SSE mapping; the prompt opts (round/isRepair/sectionSizes) are forwarded verbatim so the
// telemetry funnel keeps them. AgentDeps injected — no opencode serve in tests. Delegates only.
import type { AgentRuntimePort, AgentSession, OpenSessionOpts,
  UsageSnapshot, AgentTurnEvent, AgentOpenDescriptor } from "@kernel/ports/agent-runtime.port.ts"; // kernel-resident (Task A.0b)
import type { AgentRole } from "@kernel/agent-role.ts";

// Mirrors the src/integrations/opencode-client.ts AgentDeps.open boundary (declared locally so the adapter
// never imports from src/). The callback param types match the REAL AgentDeps (onUsage: UsageSnapshot,
// onTurn: AgentTurnEvent, descriptor: AgentOpenDescriptor) — the port forwards those richer callbacks
// verbatim, so typing them as `unknown` here would reject the kernel OpenSessionOpts. cleanupOrphans is
// intentionally omitted — it is an out-of-band janitor, not a session-lifecycle method, wired separately at
// Plan-6; this adapter only forwards open.
interface LegacyAgentDeps {
  open(agent: string, cwd: string, opts?: { signal?: AbortSignal; timeoutMs?: number; model?: string;
    onUsage?: (u: UsageSnapshot) => void; onTurn?: (t: AgentTurnEvent) => void; descriptor?: AgentOpenDescriptor }): Promise<{
      id: string; prompt(text: string, o?: { textOnly?: boolean; round?: number; isRepair?: boolean; sectionSizes?: Record<string, number> | null }): Promise<string>; dispose(): Promise<void>;
    }>;
}

export class AgentRuntimeAdapter implements AgentRuntimePort {
  constructor(private readonly deps: LegacyAgentDeps, private readonly roleToAgentName: (r: AgentRole) => string) {}
  async openSession(role: AgentRole, cwd: string, opts?: OpenSessionOpts): Promise<AgentSession> {
    const s = await this.deps.open(this.roleToAgentName(role), cwd, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts?.model ? { model: opts.model } : {}),
      ...(opts?.onUsage ? { onUsage: opts.onUsage } : {}),
      ...(opts?.onTurn ? { onTurn: opts.onTurn } : {}),
      ...(opts?.descriptor ? { descriptor: opts.descriptor } : {}),
    });
    return {
      prompt: async (text, o) => ({ output: await s.prompt(text, o) }),
      dispose: () => s.dispose(),
    };
  }
}
