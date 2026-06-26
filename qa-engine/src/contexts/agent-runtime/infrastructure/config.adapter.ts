// qa-engine/src/contexts/agent-runtime/infrastructure/config.adapter.ts
// WRAP of src/agent-runtime/config.ts (configFromEnv / validateAgentRuntimeConfig / publicAgentConfig).
// All three injected so the adapter test needs no env / no keys. Maps the legacy AgentRuntimeConfig onto
// the structural AgentRuntimeConfigView — delegates, does not reimplement config parsing.
import type { ConfigPort, AgentRuntimeConfigView, AgentConfigValidationView } from "../application/ports/index.ts";

// Structural shapes of the legacy fns (no src/ import at runtime — only the optional parity test may).
export interface ConfigFns {
  configFromEnv(env?: Record<string, string | undefined>): unknown;            // returns legacy AgentRuntimeConfig
  validateAgentRuntimeConfig(cfg: unknown, keys: Record<string, boolean>): { valid: boolean; errors: string[] };
  publicAgentConfig(cfg: unknown): unknown;
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
// Map the legacy AgentRuntimeConfig (mode + assignments record) onto the structural view. The exact
// legacy field names are resolved at Plan-6 wiring; this boundary map keeps the adapter src/-free.
function toView(legacy: unknown): AgentRuntimeConfigView { /* shape map; see Plan-6 wiring */ return legacy as AgentRuntimeConfigView; }
