// qa-engine/src/shared-kernel/domain-error.ts
// Sealed error taxonomy for the run pipeline. An error is classified by its TYPE, never by
// substring-matching the message. InfraError ⇒ the run was inconclusive because of the ENVIRONMENT
// (DEV down, deploy gate, git/network), not a code/test fault and not an orchestrator defect.
// Carried from src/errors.ts; the spec places StalledAgentError in the kernel InfraError taxonomy.

export class InfraError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "InfraError";
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

// The AI agent layer could not produce a result for a NON-code reason (provider rejected/rate-limited/
// length-limited/aborted/5xx). Its own type so the run surfaces an agent-specific operator message
// and is never mistaken for an orchestrator defect or a code/test verdict.
export class AgentUnavailableError extends InfraError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentUnavailableError";
  }
}

// The agent produced no activity for longer than the liveness-watchdog window — engine resilience,
// not the DEV environment. Still inconclusive (no verdict); distinct from AgentUnavailableError so
// alert routing can be specific.
export class StalledAgentError extends InfraError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StalledAgentError";
  }
}

// True when a thrown error is genuine infrastructure. The name fallbacks cover cross-realm cases where
// `instanceof` fails (e.g. an SDK loaded in two module realms); the message check covers operator cancel.
export function isInfraError(err: unknown): boolean {
  if (err instanceof InfraError) return true;
  if (err instanceof Error && (err.name === "InfraError" || err.name === "AgentUnavailableError" || err.name === "StalledAgentError" || err.name === "DeployTimeoutError")) return true;
  if (err instanceof Error && /\brun cancelled by operator\b/i.test(err.message)) return true;
  return false;
}
