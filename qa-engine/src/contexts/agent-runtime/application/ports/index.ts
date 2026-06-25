// qa-engine/src/contexts/agent-runtime/application/ports/index.ts
// Provider-agnostic session management ports. AgentRuntimePort is the kernel-facing seam (AgentRole +
// RoleAssignment are kernel-resident, §5.1 P3). AgentRuntimeStrategy [SWAP — one per provider] is
// lifted nearly verbatim from src/agent-runtime/types.ts. StallWatchdogPort is a SEPARATE port
// alongside the (Plan-5) ResilienceDecorator (Option B): the per-session attach/detach lifecycle is
// distinct from the breaker's retry loop and must not be coupled to it. ProcessKillPort is consumed
// FROM the kernel. RunUsage stays here (no kernel leak) — modeled as a local UsageSnapshot type.

import type { AgentRole, RoleAssignment, AgentProvider } from "@kernel/agent-role.ts";

export interface UsageSnapshot { inputTokens: number; outputTokens: number; provider: AgentProvider; }
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

// The kernel-facing port generation depends on.
export interface AgentRuntimePort {
  openSession(role: AgentRole, cwd: string, opts?: OpenSessionOpts): Promise<AgentSession>;
}

export interface AgentProviderHealth { provider: AgentProvider; status: string; configured: boolean; error?: string; }
export interface AgentModelInfo { id: string; label?: string; provider?: AgentProvider; }

// [SWAP — one adapter per provider]. Lifted from src/agent-runtime/types.ts AgentRuntimeStrategy.
export interface AgentRuntimeStrategy extends AgentRuntimePort {
  provider: AgentProvider;
  health(): Promise<AgentProviderHealth>;
  listModels(): Promise<AgentModelInfo[]>;
  restart?(opts?: { apiKey?: string; reason?: string }): Promise<AgentProviderHealth>;
  dispose?(): void | Promise<void>;
}

// [SWAP] opencode serve HTTP / codex exec.
export interface TransportPort {
  send(payload: unknown): Promise<unknown>;
}
export interface ModelCatalogPort {
  models(provider: AgentProvider): Promise<AgentModelInfo[]>;
}
// Replaces the direct saveAgentTurn import in both strategies.
export interface TurnTelemetrySink {
  record(event: AgentTurnEvent): void;
}
// Option B: separate from the ResilienceDecorator. Per-session attach/detach liveness watchdog.
export interface StallWatchdogPort {
  attach(session: AgentSession, onStall: () => void): () => void; // returns detach
}
// Assignment resolution preserves the deliberate fallback (3 explicit roles, 5 via fallback).
export interface RoleAssignmentResolver {
  resolve(role: AgentRole): RoleAssignment;
}
