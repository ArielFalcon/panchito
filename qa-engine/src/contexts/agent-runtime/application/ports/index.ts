// qa-engine/src/contexts/agent-runtime/application/ports/index.ts
// Provider-agnostic session management ports. AgentRuntimePort is the kernel-facing seam (AgentRole +
// RoleAssignment are kernel-resident, §5.1 P3). AgentRuntimeStrategy [SWAP — one per provider] is
// lifted nearly verbatim from src/agent-runtime/types.ts. StallWatchdogPort is a SEPARATE port
// alongside the (Plan-5) ResilienceDecorator (Option B): the per-session attach/detach lifecycle is
// distinct from the breaker's retry loop and must not be coupled to it. ProcessKillPort is consumed
// FROM the kernel. RunUsage stays here (no kernel leak) — modeled as a local UsageSnapshot type.

// The kernel-facing session-management types now live in the kernel (design §5.2) so generation depends
// on AgentRuntimePort FROM the kernel, decoupled from this context. The barrel re-exports them and extends
// AgentRuntimePort with provider-strategy concerns (AgentRuntimeStrategy below).
export type { UsageSnapshot, AgentTurnEvent, AgentSession, OpenSessionOpts, AgentRuntimePort, AgentOpenDescriptor }
  from "@kernel/ports/agent-runtime.port.ts";
import type { AgentRuntimePort, AgentSession, AgentTurnEvent } from "@kernel/ports/agent-runtime.port.ts";
import type { AgentRole, RoleAssignment, AgentProvider } from "@kernel/agent-role.ts";

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

// Wraps configFromEnv / validateAgentRuntimeConfig / publicAgentConfig. publicAgentConfig is the
// redacted view safe to expose over the API; validation reports per-provider key presence. The config
// shapes are structural (no src/ import) — the adapter maps the legacy AgentRuntimeConfig onto them.
export interface AgentRuntimeConfigView {
  mode: "single" | "dual";
  assignments: { role: string; provider: AgentProvider; model: string }[];
}
export interface AgentConfigValidationView {
  valid: boolean;
  errors: string[];
}
export interface ConfigPort {
  fromEnv(env?: Record<string, string | undefined>): AgentRuntimeConfigView;
  validate(cfg: AgentRuntimeConfigView, keys: Record<string, boolean>): AgentConfigValidationView;
  publicView(cfg: AgentRuntimeConfigView): AgentRuntimeConfigView; // redacted (no secrets)
}

// The mode-aware (single/dual) facade seam. Wraps SingleAgentFacade/DualAgentFacade — getStatus reports
// one provider (single) or both (dual); startEventStream multiplexes the dual streams. The adapter
// delegates to whichever legacy facade it was constructed with; it never collapses dual into single.
export interface AgentFacadePort {
  getStatus(): Promise<{ mode: "single" | "dual"; providers: AgentProviderHealth[] }>;
  listModels(provider?: AgentProvider): Promise<AgentModelInfo[]>;
  startEventStream?(onActivity: (a: unknown) => void, signal?: AbortSignal,
    onRunEvent?: (runId: string, body: unknown) => void): Promise<void>;
}
