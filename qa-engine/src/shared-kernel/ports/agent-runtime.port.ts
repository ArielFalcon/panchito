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

// AgentTurnEvent telemetry fields are ADDED by Task A.2 (it edits THIS file).
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
  // Threads the run→session mapping so the strategy adapter can wire SSE/telemetry registration.
  descriptor?: AgentOpenDescriptor;
}
export interface AgentRuntimePort {
  openSession(role: AgentRole, cwd: string, opts?: OpenSessionOpts): Promise<AgentSession>;
}
