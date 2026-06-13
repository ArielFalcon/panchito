// Sealed error taxonomy for the run pipeline. The runner classifies a thrown error by its TYPE
// (never by substring-matching the message, which is brittle and silently mislabels a real fault
// as "infrastructure"): an InfraError means the run was inconclusive because of the ENVIRONMENT
// (DEV down, deploy gate, git/network unavailable, host/runner pressure) — NOT a code/test fault
// and NOT a bug in the orchestrator. Anything else thrown out of the pipeline is an UNEXPECTED
// internal error: still inconclusive (we could not produce a verdict), but it is a defect to
// investigate, not "infrastructure, ignore".

export class InfraError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "InfraError";
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

// The AI agent layer could not produce a result for a NON-code reason: the model provider
// rejected the request (auth / out of credits), rate-limited it, hit an output-length limit, was
// aborted, or returned a server/unknown error. It is a kind of InfraError — the run is
// INCONCLUSIVE, NEVER a code/test verdict (the operator's tests are not at fault) — but it is its
// own type so the run can be surfaced with an actionable, agent-specific operator message and
// never mistaken for an orchestrator defect. ROOT-CAUSE class: every boundary that talks to the
// agent throws THIS instead of letting a provider fault degrade into empty output that downstream
// misreads as `invalid`/`fail` (the bug that made an out-of-credits run blame the user's tests).
export class AgentUnavailableError extends InfraError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentUnavailableError";
  }
}

// True when a thrown error is genuine infrastructure: an InfraError (incl. AgentUnavailableError),
// the deploy-gate timeout (DeployTimeoutError, matched by name so this module need not import env/),
// or an operator cancel. The name fallbacks cover the case where `instanceof` fails across module/
// bundle realms (the dual OpenCode SDK is loaded in two realms).
export function isInfraError(err: unknown): boolean {
  if (err instanceof InfraError) return true;
  if (err instanceof Error && (err.name === "InfraError" || err.name === "AgentUnavailableError" || err.name === "DeployTimeoutError")) return true;
  if (err instanceof Error && /\brun cancelled by operator\b/i.test(err.message)) return true;
  return false;
}
