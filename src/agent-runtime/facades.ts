import type { AgentDeps } from "../integrations/opencode-client";
import type { LiveActivity } from "../integrations/opencode-client";
import type { RunEventBody } from "../contract/events";
import {
  AgentFacade,
  AgentModelInfo,
  AgentProvider,
  AgentProviderHealth,
  AgentRuntimeConfig,
  AgentRuntimeStrategy,
  AgentRole,
  assignmentForRole,
  roleForLegacyAgent,
} from "./types";

export class SingleAgentFacade implements AgentFacade {
  constructor(
    private readonly strategy: AgentRuntimeStrategy,
    readonly config: AgentRuntimeConfig,
  ) {}

  deps(): AgentDeps {
    const deps: AgentDeps = {
      open: (agent, cwd, opts) => {
        const role = roleForLegacyAgent(agent);
        const model = assignmentForRole(this.config, role).model;
        return this.strategy.openSession(role, cwd, { ...opts, model });
      },
    };
    if (this.strategy.cleanupOrphans) deps.cleanupOrphans = (maxAgeMs) => this.strategy.cleanupOrphans!(maxAgeMs);
    return deps;
  }

  async getStatus(): Promise<{ mode: "single"; providers: AgentProviderHealth[] }> {
    return { mode: "single", providers: [await this.strategy.health()] };
  }

  async listModels(provider?: AgentProvider): Promise<AgentModelInfo[]> {
    if (provider && provider !== this.strategy.provider) return [];
    return (await this.strategy.listModels()).map((m) => ({ ...m, provider: this.strategy.provider }));
  }

  startEventStream(
    onActivity: (a: LiveActivity) => void,
    signal?: AbortSignal,
    onRunEvent?: (runId: string, body: RunEventBody) => void,
  ): Promise<void> {
    return this.strategy.startEventStream?.(onActivity, signal, onRunEvent) ?? Promise.resolve();
  }
}

export class DualAgentFacade implements AgentFacade {
  constructor(
    private readonly strategies: Record<AgentProvider, AgentRuntimeStrategy>,
    readonly config: AgentRuntimeConfig,
  ) {}

  deps(): AgentDeps {
    return {
      open: (agent, cwd, opts) => {
        const role = roleForLegacyAgent(agent);
        const assignment = assignmentForRole(this.config, role);
        return this.strategies[assignment.provider].openSession(role, cwd, { ...opts, model: assignment.model });
      },
      cleanupOrphans: async (maxAgeMs) => {
        const counts = await Promise.all(
          Object.values(this.strategies).map((strategy) => strategy.cleanupOrphans?.(maxAgeMs) ?? Promise.resolve(0)),
        );
        return counts.reduce((sum, count) => sum + count, 0);
      },
    };
  }

  async getStatus(): Promise<{ mode: "dual"; providers: AgentProviderHealth[] }> {
    return { mode: "dual", providers: await Promise.all([this.strategies.opencode.health(), this.strategies.codex.health()]) };
  }

  async listModels(provider?: AgentProvider): Promise<AgentModelInfo[]> {
    const providers: AgentProvider[] = provider ? [provider] : ["opencode", "codex"];
    const lists = await Promise.all(providers.map(async (p) => (await this.strategies[p].listModels()).map((m) => ({ ...m, provider: p }))));
    return lists.flat();
  }

  async startEventStream(
    onActivity: (a: LiveActivity) => void,
    signal?: AbortSignal,
    onRunEvent?: (runId: string, body: RunEventBody) => void,
  ): Promise<void> {
    await Promise.all([
      this.strategies.opencode.startEventStream?.(onActivity, signal, onRunEvent) ?? Promise.resolve(),
      this.strategies.codex.startEventStream?.(onActivity, signal, onRunEvent) ?? Promise.resolve(),
    ]);
  }
}
