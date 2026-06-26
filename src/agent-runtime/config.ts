import type { AgentMode, AgentProvider, AgentRuntimeConfig, AgentProviderHealth, RoleAssignment } from "./types";

export interface KeyPresence {
  opencode: boolean;
  codex: boolean;
}

export interface AgentConfigValidation {
  ok: boolean;
  errors: string[];
  requiresSingleDowngradeConfirmation?: boolean;
  downgradeProvider?: AgentProvider;
}

export interface PublicAgentConfig {
  mode: AgentMode;
  singleProvider: AgentProvider;
  assignments: AgentRuntimeConfig["assignments"];
  keys: KeyPresence;
  validation: AgentConfigValidation;
  health?: Record<AgentProvider, AgentProviderHealth>;
}

const DEFAULT_MODELS: Record<AgentProvider, Record<keyof AgentRuntimeConfig["assignments"], string>> = {
  opencode: {
    // MUST match opencode/opencode.json's qa-generator model (the primary that actually runs).
    primary: "opencode-go/kimi-k2.7-code",
    // MUST match opencode/opencode.json's qa-reviewer model (the file that actually runs the
    // reviewer on the e2e path) AND differ from `primary` — two different models guarantee
    // independent judgment. A guard test (model-config.test.ts) asserts both, so this can
    // never silently drift out of the catalog again (which made applyConfig throw).
    reviewer: "opencode-go/minimax-m3",
    chat: "opencode-go/deepseek-v4-flash",
  },
  codex: {
    primary: "gpt-5.4",
    // MUST differ from primary — two different models guarantee independent judgment.
    // A guard test (model-config.test.ts) asserts reviewer!=primary for BOTH providers
    // so this can never silently collapse back to the same model.
    reviewer: "gpt-5.4-mini",
    chat: "gpt-5.4-mini",
  },
};

export function defaultAgentRuntimeConfig(env: Record<string, string | undefined> = process.env): AgentRuntimeConfig {
  const singleProvider: AgentProvider = env.OPENCODE_API_KEY ? "opencode" : env.CODEX_API_KEY ? "codex" : "opencode";
  return singleProviderConfig(singleProvider, env);
}

export function singleProviderConfig(provider: AgentProvider, env: Record<string, string | undefined> = process.env): AgentRuntimeConfig {
  return {
    mode: "single",
    singleProvider: provider,
    assignments: {
      primary: assignment(provider, "primary", env),
      reviewer: assignment(provider, "reviewer", env),
      chat: assignment(provider, "chat", env),
    },
  };
}

// The "other" provider, for dual-mode role separation. Binary today; the provider-registry refactor
// (provider-agnosticism backlog) generalizes this to "first registered provider != p".
function complementProvider(p: AgentProvider): AgentProvider {
  return p === "opencode" ? "codex" : "opencode";
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): AgentRuntimeConfig {
  const mode = env.AGENT_RUNTIME_MODE === "dual" ? "dual" : "single";
  const singleProvider = env.AGENT_SINGLE_PROVIDER === "codex" ? "codex" : env.AGENT_SINGLE_PROVIDER === "opencode" ? "opencode" : defaultAgentRuntimeConfig(env).singleProvider;
  if (mode === "single") return singleProviderConfig(singleProvider, env);
  const primaryProvider = providerFromEnv(env.AGENT_PRIMARY_PROVIDER, singleProvider);
  return {
    mode,
    singleProvider,
    assignments: {
      primary: assignment(primaryProvider, "primary", env),
      // Dual mode exists for INDEPENDENT judgment, so the reviewer defaults to a DIFFERENT provider
      // than the primary — not a hardcoded "codex" (which silently collapsed onto the primary when the
      // primary was already codex, defeating dual mode). Falls back to the primary's complement.
      reviewer: assignment(providerFromEnv(env.AGENT_REVIEWER_PROVIDER, complementProvider(primaryProvider)), "reviewer", env),
      chat: assignment(providerFromEnv(env.AGENT_CHAT_PROVIDER, singleProvider), "chat", env),
    },
  };
}

export function keyPresence(env: Record<string, string | undefined> = process.env): KeyPresence {
  return { opencode: Boolean(env.OPENCODE_API_KEY), codex: Boolean(env.CODEX_API_KEY) };
}

export function validateAgentRuntimeConfig(config: AgentRuntimeConfig, keys: KeyPresence): AgentConfigValidation {
  const errors: string[] = [];
  if (config.mode === "single") {
    if (!keys[config.singleProvider]) errors.push(`${keyName(config.singleProvider)} is required for single/${config.singleProvider}`);
    for (const role of visibleRoles()) {
      const a = config.assignments[role];
      if (a.provider !== config.singleProvider) errors.push(`${role} must use ${config.singleProvider} in single mode`);
      if (!a.model.trim()) errors.push(`${role} model is required`);
    }
    return { ok: errors.length === 0, errors };
  }

  if (!keys.opencode) errors.push("OPENCODE_API_KEY is required for dual mode");
  if (!keys.codex) errors.push("CODEX_API_KEY is required for dual mode");
  for (const role of visibleRoles()) {
    const a = config.assignments[role];
    if (!a.model.trim()) errors.push(`${role} model is required`);
  }
  const providers = new Set(visibleRoles().map((r) => config.assignments[r].provider));
  if (providers.size < 2) {
    const downgradeProvider = [...providers][0] ?? config.singleProvider;
    return {
      ok: false,
      errors,
      requiresSingleDowngradeConfirmation: true,
      downgradeProvider,
    };
  }
  return { ok: errors.length === 0, errors };
}

export function publicAgentConfig(
  config: AgentRuntimeConfig,
  keys: KeyPresence,
  health?: Record<AgentProvider, AgentProviderHealth>,
): PublicAgentConfig {
  return {
    mode: config.mode,
    singleProvider: config.singleProvider,
    assignments: config.assignments,
    keys,
    validation: validateAgentRuntimeConfig(config, keys),
    ...(health ? { health } : {}),
  };
}

function assignment(provider: AgentProvider, role: keyof AgentRuntimeConfig["assignments"], env: Record<string, string | undefined>): RoleAssignment {
  const envKey = `AGENT_${role.toUpperCase()}_MODEL`;
  return { provider, model: env[envKey] || DEFAULT_MODELS[provider][role] };
}

function providerFromEnv(raw: string | undefined, fallback: AgentProvider): AgentProvider {
  return raw === "codex" || raw === "opencode" ? raw : fallback;
}

function keyName(provider: AgentProvider): string {
  return provider === "opencode" ? "OPENCODE_API_KEY" : "CODEX_API_KEY";
}

function visibleRoles(): Array<keyof AgentRuntimeConfig["assignments"]> {
  return ["primary", "reviewer", "chat"];
}
