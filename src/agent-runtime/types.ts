import type { AgentDeps, AgentSession, AgentOpenDescriptor, AgentTurnEvent } from "../integrations/opencode-client";
import type { LiveActivity } from "../integrations/opencode-client";
import type { UsageSnapshot } from "../qa/usage";
import type { RunEventBody } from "../contract/events";

export type AgentProvider = "opencode" | "codex";
export type AgentMode = "single" | "dual";
export type AgentRole = "primary" | "reviewer" | "chat" | "worker" | "workerCode" | "maintainer" | "reflector" | "explorer" | "proposer";

// What a role is structurally allowed to do, independent of the runtime provider — the single,
// provider-agnostic capability policy. Each AgentRuntimeStrategy translates it to its own mechanism
// (OpenCode: the agent's tools{} map in opencode.json, checked against this policy by the
// agent-tool-surface tripwire; Codex: the `codex exec --sandbox` flag, see codexSandboxForRole).
// This is the security-boundary principle applied to quality: trust what a role CAN do, not that its
// prompt behaves. The judge, the read-only chat and the one-shot reflector never mutate the workspace.
export interface RoleCapabilities {
  canWrite: boolean;
}

const READ_ONLY_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>(["reviewer", "chat", "reflector", "explorer", "proposer"]);

export function capabilitiesForRole(role: AgentRole): RoleCapabilities {
  return { canWrite: !READ_ONLY_ROLES.has(role) };
}

export interface RoleAssignment {
  provider: AgentProvider;
  model: string;
}

export interface AgentRuntimeConfig {
  mode: AgentMode;
  singleProvider: AgentProvider;
  assignments: {
    primary: RoleAssignment;
    reviewer: RoleAssignment;
    chat: RoleAssignment;
  };
}

export type AgentRuntimeStatus = "stopped" | "starting" | "healthy" | "degraded" | "failed" | "needs_config";

export interface AgentProviderHealth {
  provider: AgentProvider;
  status: AgentRuntimeStatus;
  configured: boolean;
  error?: string;
}

export interface AgentModelInfo {
  id: string;
  label?: string;
  provider?: AgentProvider;
}

export interface AgentRuntimeSession extends AgentSession {}

export interface AgentRuntimeStrategy {
  provider: AgentProvider;
  health(): Promise<AgentProviderHealth>;
  listModels(): Promise<AgentModelInfo[]>;
  // onUsage is part of the TYPED end-to-end usage path: the facade forwards it through to the
  // underlying strategy's deps.open, where each session.prompt response emits a UsageSnapshot
  // (observation-only — never influences any verdict). `descriptor`/`onTurn` are part of the
  // analogous TYPED turn-telemetry path: the facade spreads them from opts into openSession, and
  // each strategy emits an AgentTurnEvent per prompt so agent_turns rows are persisted with a real
  // run_id regardless of provider (OpenCode fires it at the SDK funnel; Codex per `codex exec`).
  openSession(
    role: AgentRole,
    cwd: string,
    opts?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      model?: string;
      onUsage?: (u: UsageSnapshot) => void;
      descriptor?: AgentOpenDescriptor;
      onTurn?: (t: AgentTurnEvent) => void;
    },
  ): Promise<AgentRuntimeSession>;
  startEventStream?(
    onActivity: (a: LiveActivity) => void,
    signal?: AbortSignal,
    onRunEvent?: (runId: string, body: RunEventBody) => void,
  ): Promise<void>;
  cleanupOrphans?(maxAgeMs: number): Promise<number>;
  restart?(opts?: { apiKey?: string; reason?: string; env?: Record<string, string> }): Promise<AgentProviderHealth>;
  dispose?(): void | Promise<void>;
}

export interface AgentFacadeDeps extends AgentDeps {}

export interface AgentFacade {
  config: AgentRuntimeConfig;
  deps(): AgentFacadeDeps;
  getStatus(): Promise<{ mode: AgentMode; providers: AgentProviderHealth[] }>;
  listModels(provider?: AgentProvider): Promise<AgentModelInfo[]>;
  startEventStream?(
    onActivity: (a: LiveActivity) => void,
    signal?: AbortSignal,
    onRunEvent?: (runId: string, body: RunEventBody) => void,
  ): Promise<void>;
}

const LEGACY_AGENT_TO_ROLE: Record<string, AgentRole> = {
  "qa-generator": "primary",
  "qa-reviewer": "reviewer",
  "qa-assistant": "chat",
  "qa-worker": "worker",
  "qa-worker-code": "workerCode",
  "qa-maintainer": "maintainer",
  "qa-reflector": "reflector",
  "qa-explorer": "explorer",
  "qa-proposer": "proposer",
};

export function roleForLegacyAgent(agent: string): AgentRole {
  return LEGACY_AGENT_TO_ROLE[agent] ?? "primary";
}

export function assignmentForRole(config: AgentRuntimeConfig, role: AgentRole): RoleAssignment {
  if (role === "reviewer") return config.assignments.reviewer;
  if (role === "chat") return config.assignments.chat;
  // The one-shot reflector is a cheap read-only transform: it rides the chat tier (same provider
  // and small model), not the expensive primary author.
  if (role === "reflector") return config.assignments.chat;
  // Parallel workers and self-maintainer inherit the primary provider/model by design.
  return config.assignments.primary;
}
