// PORT (pure classifier, copy+parity). Carried VERBATIM from src/agent-runtime/codex-strategy.ts
// codexErrorToInfra. Maps an unknown Codex exec error to an AgentUnavailableError (infra — a Codex
// outage, never a code bug) or null (a real failure the run must surface). Per-provider isolation:
// a Codex outage classified here must never trip the OpenCode breaker (that lives in the strategy).
//
// ROOT-CAUSE classifier for Codex: mirrors agentErrorToInfra (opencode-client.ts:1754) for the
// Codex path. Maps `codex exec` non-zero exit / auth / out-of-credits / timeout to
// AgentUnavailableError (infra-error) so billing/auth failures never surface as false `fail`/`invalid`
// verdicts that open a spurious GitHub Issue. Returns null for non-infra outcomes (real test failures).
//
// IMPORTANT: This classifier operates on a plain Error — `codex exec` (or the supervisor transport)
// throws bare Error objects; the classification inspects the message for known infra signals.
// Do NOT extend this to substring-match test-output prose: only known provider/infra error patterns
// belong here. Any non-matching error returns null (caller decides the verdict).
import { AgentUnavailableError } from "@kernel/domain-error.ts";

export function codexErrorToInfra(error: unknown): AgentUnavailableError | null {
  if (!(error instanceof Error)) return null;
  const msg = error.message.toLowerCase();
  const tail = "INCONCLUSIVE (infrastructure), not a test failure";

  // Timeout is the highest-priority check: it's the controlled case (CodexExecTransport fires SIGTERM).
  if (/timed out after \d+ms/.test(msg)) {
    return new AgentUnavailableError(`Codex prompt timed out. ${tail}.`, { cause: error });
  }

  // Auth / credits / billing signals in stderr surfaced through the exit-code path.
  if (
    /\b(401|403|unauthorized|authentication failed|forbidden)\b/.test(msg) ||
    /\b(402|out of credits|payment required|billing)\b/.test(msg) ||
    /\b(429|too many requests|rate.?limit)\b/.test(msg)
  ) {
    return new AgentUnavailableError(
      `Codex provider rejected the request (auth / credits / rate-limit): ${error.message}. ${tail}.`,
      { cause: error },
    );
  }

  // Abort/SIGTERM from an external AbortSignal (not our internal timeout).
  if (/\b(aborted|sigterm|abort)\b/.test(msg)) {
    return new AgentUnavailableError(`Codex exec was aborted. ${tail}.`, { cause: error });
  }

  // Not an infra error — a genuine non-infra outcome (real test failure, script error, etc.).
  return null;
}
