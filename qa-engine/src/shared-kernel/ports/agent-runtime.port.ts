// qa-engine/src/shared-kernel/ports/agent-runtime.port.ts
// Kernel-resident session-management seam (design §5.2). Generation depends on AgentRuntimePort FROM the
// kernel so it is decoupled from the agent-runtime context. The agent-runtime context barrel re-exports
// these and extends them with provider-strategy concerns (AgentRuntimeStrategy, ConfigPort, …).
import type { AgentRole, AgentProvider } from "@kernel/agent-role.ts";

export interface UsageSnapshot { inputTokens: number; outputTokens: number; provider: AgentProvider; }
// AgentOpenDescriptor / the widened prompt opts / AgentTurnEvent telemetry fields are ADDED by Tasks
// A.1 + A.2 (they edit THIS file now, not the context barrel).
export interface AgentTurnEvent { runId: string; role: AgentRole; objective?: string; }
export interface AgentSession {
  prompt(text: string): Promise<{ output: string }>;
  dispose(): Promise<void> | void;
}
export interface OpenSessionOpts {
  signal?: AbortSignal;
  timeoutMs?: number;
  model?: string;
  onUsage?: (u: UsageSnapshot) => void;
  onTurn?: (t: AgentTurnEvent) => void;
}
export interface AgentRuntimePort {
  openSession(role: AgentRole, cwd: string, opts?: OpenSessionOpts): Promise<AgentSession>;
}
