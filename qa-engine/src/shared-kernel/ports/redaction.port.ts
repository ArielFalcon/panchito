// qa-engine/src/shared-kernel/ports/redaction.port.ts
// The ONE canonical secret-redaction seam. Replaces the two divergent src/ implementations
// (orchestrator/sanitizer.ts [REDACTED_SECRET] and util/redact.ts [REDACTED_CREDENTIAL]); the
// canonical placeholder in the rewrite is [REDACTED]. Everything leaving the system (diff → model,
// execution logs → Issue) passes through an adapter of this port. The adapter is wired in
// workspace-and-publication's egress sanitization (Plan 4); the port lives in the kernel.

export const REDACTED = "[REDACTED]";

export interface RedactionPort {
  // Returns text with every detected secret replaced by REDACTED. Pure and deterministic.
  redact(text: string): string;
  // True when the text still contains a detectable secret AFTER redaction would run — used by the
  // egress guard to fail loudly rather than ship a leak.
  containsSecret(text: string): boolean;
}
