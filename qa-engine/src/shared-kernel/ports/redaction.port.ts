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
  // True when the text still contains a detectable secret AFTER redaction would run. Available for
  // a future fail-loud egress guard (rather than ship a leak); no production call site wires it in
  // yet — every current caller only invokes `redact`.
  containsSecret(text: string): boolean;
}

// sdd/migration-wiring-phase-2 Slice 6 (AMENDMENT 1, mode-aware containsSecret guard): thrown by the
// post-redaction fail-loud egress guard at BOTH boundaries — diff→model
// (src/integrations/prompts.ts's cappedDiffText, via src/orchestrator/sanitizer.ts's
// assertNoSecretLeak) and logs→Issue (this context's own publication-port.adapter.ts). Defined here,
// in the shared kernel, rather than in src/orchestrator/sanitizer.ts (where the design otherwise
// places it) because publication-port.adapter.ts lives in qa-engine and the arch-lint boundary
// (no-vcs-write-in-agent-contexts, this context's own header note) forbids qa-engine importing
// anything under src/ — the kernel is the one place both sides can import from without crossing that
// line. src/orchestrator/sanitizer.ts re-exports this class so src/ callers see it as if it were
// declared there.
export class SecretLeakError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretLeakError";
  }
}
