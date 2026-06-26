// qa-engine/src/contexts/agent-runtime/infrastructure/config.adapter.ts
// WRAP of src/agent-runtime/config.ts (configFromEnv / validateAgentRuntimeConfig / publicAgentConfig).
// All three injected so the adapter test needs no env / no keys. Maps the legacy AgentRuntimeConfig onto
// the structural AgentRuntimeConfigView — delegates, does not reimplement config parsing.
import type { AgentProvider } from "@kernel/agent-role.ts";
import type { ConfigPort, AgentRuntimeConfigView, AgentConfigValidationView } from "../application/ports/index.ts";

// Structural shapes of the legacy fns (no src/ import at runtime — only the optional parity test may).
export interface ConfigFns {
  configFromEnv(env?: Record<string, string | undefined>): unknown;            // returns legacy AgentRuntimeConfig
  validateAgentRuntimeConfig(cfg: unknown, keys: Record<string, boolean>): { valid: boolean; errors: string[] };
  publicAgentConfig(cfg: unknown): unknown;
}

// Structural mirror of the legacy AgentRuntimeConfig (src/agent-runtime/types.ts) — the shape toView reads.
// assignments is a KEYED OBJECT here, an ARRAY on the view: that is the transform this adapter owns.
interface LegacyConfig {
  mode: "single" | "dual";
  assignments: Record<string, { provider: AgentProvider; model: string }>;
}

export class ConfigAdapter implements ConfigPort {
  constructor(private readonly fns: ConfigFns) {}
  fromEnv(env?: Record<string, string | undefined>): AgentRuntimeConfigView {
    return toView(this.fns.configFromEnv(env));
  }
  validate(cfg: AgentRuntimeConfigView, keys: Record<string, boolean>): AgentConfigValidationView {
    return this.fns.validateAgentRuntimeConfig(cfg, keys);
  }
  publicView(cfg: AgentRuntimeConfigView): AgentRuntimeConfigView {
    return toView(this.fns.publicAgentConfig(cfg));
  }
}
// Map the legacy AgentRuntimeConfig (mode + assignments KEYED OBJECT) onto the structural view, whose
// assignments is an ARRAY of {role,provider,model}. A blind cast leaks the object through and crashes
// every array-iterating caller at cutover (QA-01) — so flatten the record explicitly.
function toView(legacy: unknown): AgentRuntimeConfigView {
  const cfg = legacy as LegacyConfig;
  return {
    mode: cfg.mode,
    assignments: Object.entries(cfg.assignments).map(([role, a]) => ({ role, provider: a.provider, model: a.model })),
  };
}
