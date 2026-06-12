import type { OpencodeDeps, OpencodeSession } from "../integrations/opencode-client";
import type { LiveActivity } from "../integrations/opencode-client";
import type { RunEventBody } from "../contract/events";

export type AgentProvider = "opencode" | "codex";
export type AgentMode = "single" | "dual";
export type AgentRole = "primary" | "reviewer" | "chat" | "worker" | "workerCode" | "maintainer";

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

export interface AgentRuntimeSession extends OpencodeSession {}

export interface AgentRuntimeStrategy {
  provider: AgentProvider;
  health(): Promise<AgentProviderHealth>;
  listModels(): Promise<AgentModelInfo[]>;
  openSession(role: AgentRole, cwd: string, opts?: { signal?: AbortSignal; timeoutMs?: number; model?: string }): Promise<AgentRuntimeSession>;
  startEventStream?(
    onActivity: (a: LiveActivity) => void,
    signal?: AbortSignal,
    onRunEvent?: (runId: string, body: RunEventBody) => void,
  ): Promise<void>;
  cleanupOrphans?(maxAgeMs: number): Promise<number>;
  restart?(opts?: { apiKey?: string; reason?: string; env?: Record<string, string> }): Promise<AgentProviderHealth>;
  dispose?(): void | Promise<void>;
}

export interface AgentFacadeDeps extends OpencodeDeps {}

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
};

export function roleForLegacyAgent(agent: string): AgentRole {
  return LEGACY_AGENT_TO_ROLE[agent] ?? "primary";
}

export function assignmentForRole(config: AgentRuntimeConfig, role: AgentRole): RoleAssignment {
  if (role === "reviewer") return config.assignments.reviewer;
  if (role === "chat") return config.assignments.chat;
  // Parallel workers and self-maintainer inherit the primary provider/model by design.
  return config.assignments.primary;
}
