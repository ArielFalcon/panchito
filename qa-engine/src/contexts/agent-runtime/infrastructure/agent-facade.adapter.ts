// qa-engine/src/contexts/agent-runtime/infrastructure/agent-facade.adapter.ts
// WRAP of src/agent-runtime/facades.ts SingleAgentFacade / DualAgentFacade behind AgentFacadePort. The
// legacy facade (single OR dual) is injected — the adapter forwards getStatus/listModels/startEventStream
// verbatim. It NEVER decides single-vs-dual itself (the wrapped facade owns that) and NEVER collapses dual
// into single. The two-provider independence (a Codex outage must not trip OpenCode) lives in the wrapped
// facade + the strategy adapters (A.8), not here.
import type { AgentFacadePort, AgentProviderHealth, AgentModelInfo } from "../application/ports/index.ts";
import type { AgentProvider } from "@kernel/agent-role.ts";

// Structural shape of the legacy AgentFacade (no src/ import at runtime — only the optional parity test may).
interface LegacyFacade {
  getStatus(): Promise<{ mode: "single" | "dual"; providers: AgentProviderHealth[] }>;
  listModels(provider?: AgentProvider): Promise<AgentModelInfo[]>;
  startEventStream?(onActivity: (a: unknown) => void, signal?: AbortSignal,
    onRunEvent?: (runId: string, body: unknown) => void): Promise<void>;
}

export class AgentFacadeAdapter implements AgentFacadePort {
  constructor(private readonly facade: LegacyFacade) {}
  getStatus() { return this.facade.getStatus(); }
  listModels(provider?: AgentProvider) { return this.facade.listModels(provider); }
  startEventStream(onActivity: (a: unknown) => void, signal?: AbortSignal,
    onRunEvent?: (runId: string, body: unknown) => void) {
    // Honor the optional method: only delegate if the wrapped facade exposes it.
    return this.facade.startEventStream
      ? this.facade.startEventStream(onActivity, signal, onRunEvent)
      : Promise.resolve();
  }
}
