import { defaultEnvStoreFs, applyEnvVars, type EnvStoreFs } from "./env-store";
import { RedactionPortAdapter } from "../orchestrator/sanitizer";
import {
  configFromEnv,
  defaultAgentRuntimeConfig,
  keyPresence,
  publicAgentConfig,
  runtimeRoleModelsFromConfig,
  singleProviderConfig,
  validateAgentRuntimeConfig,
  type PublicAgentConfig,
} from "../agent-runtime/config";
import { setRuntimeRoleModels } from "@contexts/generation/infrastructure/prompt-builders/model-window-catalog";
import { DualAgentFacade, SingleAgentFacade } from "../agent-runtime/facades";
import type {
  AgentFacade,
  AgentProvider,
  AgentProviderHealth,
  AgentRuntimeConfig,
  AgentRuntimeStrategy,
  RoleAssignment,
} from "../agent-runtime/types";
import type { AgentConfigUpdate, AgentModelInfo } from "../contract/commands";

export interface AgentRuntimeManager {
  getConfig(): Promise<PublicAgentConfig>;
  applyConfig(input: AgentConfigUpdate): Promise<{ config: PublicAgentConfig; restarted: AgentProvider[]; downgraded?: boolean }>;
  listModels(provider: AgentProvider): Promise<AgentModelInfo[]>;
  restart(provider: AgentProvider): Promise<AgentProviderHealth>;
  facade(): AgentFacade;
  hasOpenSessions(): boolean;
}

export interface CreateAgentRuntimeManagerOptions {
  env?: Record<string, string | undefined>;
  fs?: EnvStoreFs;
  strategies: Record<AgentProvider, AgentRuntimeStrategy>;
  hasOpenSessions?: () => boolean;
}

const PROVIDERS: AgentProvider[] = ["opencode", "codex"];
const ROLES: Array<keyof AgentRuntimeConfig["assignments"]> = ["primary", "reviewer", "chat"];

// sdd/migration-wiring-phase-2 Slice 7b-2: the canonical redaction adapter (env+pattern) for this
// file's provider-health error reporting, replacing src/util/redact.ts's redactError.
const redactionPort = new RedactionPortAdapter();

export function createAgentRuntimeManager(opts: CreateAgentRuntimeManagerOptions): AgentRuntimeManager {
  const env = opts.env ?? process.env;
  const fs = opts.fs ?? defaultEnvStoreFs();
  let config = configFromEnv(env);

  async function health(): Promise<Record<AgentProvider, AgentProviderHealth>> {
    const keys = keyPresence(env);
    const entries = await Promise.all(PROVIDERS.map(async (provider) => {
      if (!keys[provider]) {
        return [provider, { provider, status: "needs_config", configured: false }] as const;
      }
      try {
        const h = await opts.strategies[provider].health();
        return [provider, { ...h, provider, configured: true }] as const;
      } catch (err) {
        return [provider, { provider, status: "failed", configured: true, error: redactionPort.redactError(err) }] as const;
      }
    }));
    return Object.fromEntries(entries) as Record<AgentProvider, AgentProviderHealth>;
  }

  async function currentPublicConfig(): Promise<PublicAgentConfig> {
    return publicAgentConfig(config, keyPresence(env), await health());
  }

  async function restartProvider(
    provider: AgentProvider,
    apiKey?: string,
    runtimeEnv = configEnvVars(config),
  ): Promise<AgentProviderHealth> {
    if (!keyPresence(env)[provider]) return { provider, status: "needs_config", configured: false };
    if (opts.strategies[provider].restart) {
      return opts.strategies[provider].restart({ apiKey, reason: "runtime config changed", env: runtimeEnv });
    }
    return opts.strategies[provider].health();
  }

  return {
    getConfig: currentPublicConfig,

    async applyConfig(input) {
      const previous = config;
      const nextEnv = { ...env };
      const apiKeyVars = apiKeyEnvVars(input);
      for (const [key, value] of Object.entries(apiKeyVars)) nextEnv[key] = value;

      let next = mergeConfig(previous, input, nextEnv);
      let downgraded = false;
      let validation = validateAgentRuntimeConfig(next, keyPresence(nextEnv));

      if (validation.requiresSingleDowngradeConfirmation) {
        if (!input.confirmSingleDowngrade) {
          throw new Error(`confirmSingleDowngrade is required to convert dual/${validation.downgradeProvider} to single/${validation.downgradeProvider}`);
        }
        next = downgradeToSingle(next, validation.downgradeProvider ?? next.singleProvider, nextEnv);
        downgraded = true;
        validation = validateAgentRuntimeConfig(next, keyPresence(nextEnv));
      }
      if (!validation.ok) throw new Error(validation.errors.join("; "));
      await validateAssignedModels(next, opts.strategies);

      const runtimeVars = configEnvVars(next);
      applyEnvVars({ ...apiKeyVars, ...runtimeVars }, { fs, env });
      config = next;

      // D-4c-6 follow-up (live-reconfiguration split-brain): re-derive the runtime role→model map
      // from the NEW live config and re-inject it into the qa-engine catalog seam — the SAME
      // derivation the boot path (`opencode-client.ts`'s module load, via `configFromEnv()`) uses,
      // via the shared `runtimeRoleModelsFromConfig` helper. Without this, `roleWindowBytes` keeps
      // budgeting against the STALE snapshot injected at boot even after a live role→model
      // reassignment through this guarded operator path (PUT /api/agent-config).
      setRuntimeRoleModels(runtimeRoleModelsFromConfig(config));

      const restarted = changedProviders(previous, next, apiKeyVars);
      await Promise.all(restarted.map((provider) => restartProvider(provider, apiKeyForProvider(input, provider), runtimeVars)));

      // Release a provider that is no longer used by any role (e.g. single/opencode →
      // single/codex): the supervisor stops its process, but the orchestrator-side
      // strategy still caches a live client until we dispose it.
      await Promise.all(
        PROVIDERS
          .filter((provider) => usedProvider(previous, provider) && !usedProvider(next, provider))
          .map((provider) => opts.strategies[provider].dispose?.()),
      );
      return { config: await currentPublicConfig(), restarted, ...(downgraded ? { downgraded: true } : {}) };
    },

    async listModels(provider) {
      return (await opts.strategies[provider].listModels()).map((m) => ({ ...m, provider }));
    },

    restart: restartProvider,

    facade() {
      return config.mode === "dual"
        ? new DualAgentFacade(opts.strategies, config)
        : new SingleAgentFacade(opts.strategies[config.singleProvider], config);
    },

    hasOpenSessions() {
      return opts.hasOpenSessions?.() ?? false;
    },
  };
}

async function validateAssignedModels(
  config: AgentRuntimeConfig,
  strategies: Record<AgentProvider, AgentRuntimeStrategy>,
): Promise<void> {
  const catalogs = new Map<AgentProvider, Set<string>>();
  const errors: string[] = [];
  for (const role of ROLES) {
    const assignment = config.assignments[role];
    let models = catalogs.get(assignment.provider);
    if (!models) {
      models = new Set((await strategies[assignment.provider].listModels()).map((m) => m.id));
      catalogs.set(assignment.provider, models);
    }
    if (!models.has(assignment.model)) {
      errors.push(`${role} model '${assignment.model}' is not available for ${assignment.provider}`);
    }
  }
  if (errors.length > 0) throw new Error(errors.join("; "));
}

function mergeConfig(
  current: AgentRuntimeConfig,
  input: AgentConfigUpdate,
  env: Record<string, string | undefined>,
): AgentRuntimeConfig {
  const mode = input.mode ?? current.mode;
  const singleProvider = input.singleProvider ?? current.singleProvider;

  if (mode === "single") {
    const base = singleProviderConfig(singleProvider, env);
    return {
      ...base,
      assignments: overlayAssignments(base.assignments, input.assignments),
    };
  }

  const base = current.mode === "dual" ? current : defaultDualConfig(singleProvider, env);
  return {
    mode: "dual",
    singleProvider,
    assignments: overlayAssignments(base.assignments, input.assignments),
  };
}

function defaultDualConfig(singleProvider: AgentProvider, env: Record<string, string | undefined>): AgentRuntimeConfig {
  const baseline = defaultAgentRuntimeConfig({ ...env, AGENT_SINGLE_PROVIDER: singleProvider });
  return {
    mode: "dual",
    singleProvider,
    assignments: {
      primary: baseline.assignments.primary,
      reviewer: { provider: opposite(singleProvider), model: modelFromEnv("reviewer", opposite(singleProvider), env) },
      chat: baseline.assignments.chat,
    },
  };
}

function downgradeToSingle(
  config: AgentRuntimeConfig,
  provider: AgentProvider,
  env: Record<string, string | undefined>,
): AgentRuntimeConfig {
  const base = singleProviderConfig(provider, env);
  const preserved = ROLES.reduce((acc, role) => {
    const current = config.assignments[role];
    acc[role] = current.provider === provider ? current : base.assignments[role];
    return acc;
  }, {} as AgentRuntimeConfig["assignments"]);
  return { mode: "single", singleProvider: provider, assignments: preserved };
}

function overlayAssignments(
  current: AgentRuntimeConfig["assignments"],
  patch?: Partial<Record<keyof AgentRuntimeConfig["assignments"], RoleAssignment>>,
): AgentRuntimeConfig["assignments"] {
  return {
    primary: patch?.primary ?? current.primary,
    reviewer: patch?.reviewer ?? current.reviewer,
    chat: patch?.chat ?? current.chat,
  };
}

function apiKeyEnvVars(input: AgentConfigUpdate): Record<string, string> {
  const vars: Record<string, string> = {};
  const open = input.apiKeys?.opencode?.trim();
  const codex = input.apiKeys?.codex?.trim();
  if (open) vars.OPENCODE_API_KEY = open;
  if (codex) vars.CODEX_API_KEY = codex;
  return vars;
}

function configEnvVars(config: AgentRuntimeConfig): Record<string, string> {
  return {
    AGENT_RUNTIME_MODE: config.mode,
    AGENT_SINGLE_PROVIDER: config.singleProvider,
    AGENT_PRIMARY_PROVIDER: config.assignments.primary.provider,
    AGENT_REVIEWER_PROVIDER: config.assignments.reviewer.provider,
    AGENT_CHAT_PROVIDER: config.assignments.chat.provider,
    AGENT_PRIMARY_MODEL: config.assignments.primary.model,
    AGENT_REVIEWER_MODEL: config.assignments.reviewer.model,
    AGENT_CHAT_MODEL: config.assignments.chat.model,
  };
}

function changedProviders(
  previous: AgentRuntimeConfig,
  next: AgentRuntimeConfig,
  apiKeyVars: Record<string, string>,
): AgentProvider[] {
  const changed = new Set<AgentProvider>();
  if (apiKeyVars.OPENCODE_API_KEY) changed.add("opencode");
  if (apiKeyVars.CODEX_API_KEY) changed.add("codex");
  if (previous.mode !== next.mode || previous.singleProvider !== next.singleProvider) changed.add(next.singleProvider);
  for (const provider of PROVIDERS) {
    if (usedProvider(next, provider) && JSON.stringify(assignmentsForProvider(previous, provider)) !== JSON.stringify(assignmentsForProvider(next, provider))) {
      changed.add(provider);
    }
  }
  return PROVIDERS.filter((p) => changed.has(p));
}

function assignmentsForProvider(config: AgentRuntimeConfig, provider: AgentProvider): Array<[string, RoleAssignment]> {
  return ROLES
    .filter((role) => config.assignments[role].provider === provider)
    .map((role) => [role, config.assignments[role]]);
}

function usedProvider(config: AgentRuntimeConfig, provider: AgentProvider): boolean {
  return ROLES.some((role) => config.assignments[role].provider === provider);
}

function apiKeyForProvider(input: AgentConfigUpdate, provider: AgentProvider): string | undefined {
  return provider === "opencode" ? input.apiKeys?.opencode : input.apiKeys?.codex;
}

function opposite(provider: AgentProvider): AgentProvider {
  return provider === "opencode" ? "codex" : "opencode";
}

function modelFromEnv(role: keyof AgentRuntimeConfig["assignments"], provider: AgentProvider, env: Record<string, string | undefined>): string {
  return singleProviderConfig(provider, env).assignments[role].model;
}
