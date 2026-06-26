// qa-engine/src/shared-kernel/ports/agent-runtime.port.ts
// Kernel-resident session-management seam (design §5.2). Generation depends on AgentRuntimePort FROM the
// kernel so it is decoupled from the agent-runtime context. The agent-runtime context barrel re-exports
// these and extends them with provider-strategy concerns (AgentRuntimeStrategy, ConfigPort, …).
import type { AgentRole, AgentProvider } from "@kernel/agent-role.ts";

export interface UsageSnapshot { inputTokens: number; outputTokens: number; provider: AgentProvider; }

// Session-scoped identity descriptor, forwarded by every openSession call-site that has a run context.
// Mirrors AgentOpenDescriptor in src/integrations/opencode-client.ts — declared locally so the port
// never imports from src/. runId/objective are optional so inapplicable call-sites (maintainer) omit them.
export interface AgentOpenDescriptor {
  runId?: string;
  role?: string;
  objective?: string;
}

// AgentTurnEvent gains the per-turn telemetry fields the legacy funnel records (round/isRepair distinguish
// generation rounds from contract-repair re-prompts; sectionSizes is the ContextAssembler byte map, null
// for non-assembled prompts). runId is nullable (mirrors the legacy funnel: null for runs without a run
// context). The TurnTelemetrySink (already defined) records these — no new port needed.
export interface AgentTurnEvent {
  runId: string | null;
  role: AgentRole;
  objective?: string;
  round: number;
  isRepair: boolean;
  sectionSizes: Record<string, number> | null;
}

export interface AgentSession {
  // Widened to carry the per-call telemetry/repair opts the legacy session exposes. The opts are
  // forwarded verbatim to the wrapped session so no capability is dropped at the port boundary.
  prompt(
    text: string,
    opts?: { textOnly?: boolean; round?: number; isRepair?: boolean; sectionSizes?: Record<string, number> | null },
  ): Promise<{ output: string }>;
  dispose(): Promise<void> | void;
}
export interface OpenSessionOpts {
  signal?: AbortSignal;
  timeoutMs?: number;
  model?: string;
  onUsage?: (u: UsageSnapshot) => void;
  onTurn?: (t: AgentTurnEvent) => void;
  // Threads the run→session mapping so the strategy adapter can wire SSE/telemetry registration.
  descriptor?: AgentOpenDescriptor;
}
export interface AgentRuntimePort {
  openSession(role: AgentRole, cwd: string, opts?: OpenSessionOpts): Promise<AgentSession>;
}
