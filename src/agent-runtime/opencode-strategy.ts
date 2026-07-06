import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultAgentDeps,
  disposeSharedClient,
  startActivitySink,
  type LiveActivity,
  type AgentDeps,
  type AgentOpenDescriptor,
  type AgentTurnEvent,
} from "../integrations/opencode-client";
import type { RunEventBody } from "../contract/events";
import type { UsageSnapshot } from "../qa/usage";
import type {
  AgentModelInfo,
  AgentProviderHealth,
  AgentRole,
  AgentRuntimeSession,
  AgentRuntimeStrategy,
} from "./types";

interface OpenCodeRuntimeStrategyOptions {
  env?: Record<string, string | undefined>;
  depsFactory?: () => Promise<AgentDeps>;
  startEvents?: (
    onActivity: (a: LiveActivity) => void,
    signal?: AbortSignal,
    opts?: { onRunEvent?: (runId: string, body: RunEventBody) => void },
  ) => Promise<void>;
  dispose?: () => void;
  configPath?: string;
}

export const ROLE_TO_OPENCODE_AGENT: Record<AgentRole, string> = {
  primary: "qa-generator",
  reviewer: "qa-reviewer",
  chat: "qa-assistant",
  worker: "qa-worker",
  workerCode: "qa-worker-code",
  maintainer: "qa-maintainer",
  reflector: "qa-reflector",
  explorer: "qa-explorer",
  proposer: "qa-proposer",
};

// Used ONLY when opencode.json is missing/unreadable (otherwise the live agent catalog wins). Kept
// aligned with the models actually assigned in opencode.json so a fallback never rejects a valid
// default (Config A: generator=kimi, reviewer=minimax, chat/workers=flash).
const FALLBACK_MODELS: AgentModelInfo[] = [
  { id: "opencode-go/kimi-k2.7-code", label: "Kimi K2.7 Code" },
  { id: "opencode-go/minimax-m3", label: "MiniMax M3" },
  { id: "opencode-go/deepseek-v4-flash", label: "DeepSeek V4 Flash" },
];

export class OpenCodeRuntimeStrategy implements AgentRuntimeStrategy {
  readonly provider = "opencode" as const;
  private depsPromise: Promise<AgentDeps> | undefined;
  private readonly env: Record<string, string | undefined>;
  private readonly depsFactory: () => Promise<AgentDeps>;
  private readonly startEvents: NonNullable<OpenCodeRuntimeStrategyOptions["startEvents"]>;
  private readonly disposeClient: () => void;
  private readonly configPath: string;

  constructor(opts: OpenCodeRuntimeStrategyOptions = {}) {
    this.env = opts.env ?? process.env;
    this.depsFactory = opts.depsFactory ?? defaultAgentDeps;
    this.startEvents = opts.startEvents ?? startActivitySink;
    this.disposeClient = opts.dispose ?? disposeSharedClient;
    this.configPath = opts.configPath ?? join(process.cwd(), "agents", "opencode.json");
  }

  async health(): Promise<AgentProviderHealth> {
    if (!this.env.OPENCODE_API_KEY) return { provider: this.provider, status: "needs_config", configured: false };
    const supervised = await supervisorHealth(this.env, this.provider);
    if (supervised) return supervised;
    return { provider: this.provider, status: "healthy", configured: true };
  }

  async listModels(): Promise<AgentModelInfo[]> {
    return modelsFromOpenCodeConfig(this.configPath);
  }

  async openSession(
    role: AgentRole,
    cwd: string,
    // onUsage/descriptor/onTurn are forwarded verbatim to deps.open: the typed usage + turn-telemetry
    // paths. defaultAgentDeps.open builds the AgentTurnEvent funnel from the descriptor (see AgentRuntimeStrategy).
    opts?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      model?: string;
      onUsage?: (u: UsageSnapshot) => void;
      descriptor?: AgentOpenDescriptor;
      onTurn?: (t: AgentTurnEvent) => void;
    },
  ): Promise<AgentRuntimeSession> {
    const deps = await this.deps();
    return deps.open(ROLE_TO_OPENCODE_AGENT[role], cwd, opts);
  }

  async startEventStream(
    onActivity: (a: LiveActivity) => void,
    signal?: AbortSignal,
    onRunEvent?: (runId: string, body: RunEventBody) => void,
  ): Promise<void> {
    return this.startEvents(onActivity, signal, { onRunEvent });
  }

  async cleanupOrphans(maxAgeMs: number): Promise<number> {
    const deps = await this.deps();
    return deps.cleanupOrphans?.(maxAgeMs) ?? 0;
  }

  async restart(opts?: { apiKey?: string; env?: Record<string, string> }): Promise<AgentProviderHealth> {
    if (opts?.apiKey) this.env.OPENCODE_API_KEY = opts.apiKey;
    this.depsPromise = undefined;
    this.disposeClient();
    const supervised = await supervisorRestart(this.env, this.provider, opts?.apiKey, opts?.env);
    if (supervised) return supervised;
    return this.health();
  }

  dispose(): void {
    this.depsPromise = undefined;
    this.disposeClient();
  }

  private deps(): Promise<AgentDeps> {
    this.depsPromise ??= this.depsFactory();
    return this.depsPromise;
  }
}

async function supervisorHealth(env: Record<string, string | undefined>, provider: "opencode"): Promise<AgentProviderHealth | undefined> {
  const base = env.AGENT_SUPERVISOR_URL;
  if (!base) return undefined;
  try {
    const res = await fetch(`${base}/providers`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) throw new Error(`supervisor returned ${res.status}`);
    const body = await res.json() as { providers?: Record<string, AgentProviderHealth> };
    return body.providers?.[provider];
  } catch (err) {
    return { provider, status: "failed", configured: true, error: err instanceof Error ? err.message : String(err) };
  }
}

async function supervisorRestart(
  env: Record<string, string | undefined>,
  provider: "opencode",
  apiKey?: string,
  runtimeEnv?: Record<string, string>,
): Promise<AgentProviderHealth | undefined> {
  const base = env.AGENT_SUPERVISOR_URL;
  if (!base) return undefined;
  const res = await fetch(`${base}/restart`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, ...(apiKey ? { apiKey } : {}), ...(runtimeEnv ? { env: runtimeEnv } : {}) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`supervisor restart failed (${res.status})`);
  const body = await res.json() as { health?: AgentProviderHealth };
  return body.health;
}

function modelsFromOpenCodeConfig(path: string): AgentModelInfo[] {
  if (!existsSync(path)) return FALLBACK_MODELS;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { agent?: Record<string, { model?: string }> };
    const ids = new Set<string>();
    for (const agent of Object.values(raw.agent ?? {})) {
      if (agent.model) ids.add(agent.model);
    }
    return (ids.size ? [...ids].map((id) => ({ id })) : FALLBACK_MODELS).sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return FALLBACK_MODELS;
  }
}
