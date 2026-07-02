// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/cleanup-port.adapter.ts
// Bridge: CleanupPort -> the REAL orphan test-data cleanup dispatch. THIN — no new policy: this
// bridge only maps CleanupPort.cleanup(specDir, opts) onto the collaborator, mirroring
// SetupPortAdapter's own "duck-typed callback matching src/qa/*'s call shape" pattern (same file
// discipline) and ExecutionPortAdapter's own "baseUrl/namespace held as static per-run context"
// pattern (same constructor-config shape) — baseUrl/testIdAttribute are NOT part of CleanupPort's
// own call-time signature (see that port's own header for why), so this adapter resolves them from
// its OWN static context, exactly like ExecutionPortAdapter/SetupPortAdapter already do.
//
// The collaborator is a duck-typed callback matching src/qa/execute.ts's runCleanup(args) call
// shape — the composition root/factory bind the REAL defaultCleanupDeps.runCleanup into this slot;
// this adapter never re-implements the cleanup.spec.ts dispatch itself (qa-engine must not depend
// on src/, so it cannot import runCleanup directly — only its call SHAPE is pinned here).
//
// e2e-only: mirrors legacy's `!isCode` conjunct (pipeline.ts:1453) — the composition root only ever
// wires this adapter for the e2e target (matches setupCollaborators/groundingCollaborators' own
// `!cfg.isCode` gating precedent, composition-root.ts's wireBridges()).
//
// baseUrl absent (no live DEV target configured) -> cleanup() is a documented no-op here, mirroring
// legacy's `app.dev?.baseUrl` conjunct — RunQaUseCase itself has no baseUrl of its own to gate on
// (see CleanupPort's own header), so this adapter-level guard is the ONLY place that conjunct can
// live without leaking baseUrl into the use-case.
//
// Failure semantics: a real collaborator (defaultCleanupDeps.runCleanup) NEVER rejects by its own
// contract (src/qa/execute.ts's own doc: "cleanup never throws and never blocks the next run") —
// this adapter forwards whatever the collaborator does verbatim, with NO additional try/catch of
// its own. The use-case's own call site (run-qa.use-case.ts) already wraps this call in a
// non-blocking try/catch as the documented THIRD safety net (mirrors legacy's OWN redundant
// `.catch(...)` at the pipeline call site, on top of runCleanup's own never-rejects contract) — a
// misbehaving collaborator that DOES reject is still caught there, never propagated into a verdict.
import type { CleanupPort } from "../../application/ports/index.ts";

export type CleanupFn = (args: {
  dir: string;
  baseUrl: string;
  namespace: string;
  testIdAttribute?: string;
  signal?: AbortSignal;
}) => Promise<void>;

export interface CleanupPortCollaborators {
  e2e: CleanupFn; // bound to defaultCleanupDeps.runCleanup
}

export interface CleanupPortStaticContext {
  baseUrl?: string; // absent -> cleanup() is a no-op (mirrors legacy's `app.dev?.baseUrl` conjunct)
  testIdAttribute?: string; // injected as PW_TEST_ID_ATTRIBUTE, mirrors ExecutionPortStaticContext's own field
}

export class CleanupPortAdapter implements CleanupPort {
  constructor(
    private readonly collaborators: CleanupPortCollaborators,
    private readonly ctx: CleanupPortStaticContext,
  ) {}

  async cleanup(specDir: string, opts: { namespace: string; signal?: AbortSignal }): Promise<void> {
    if (!this.ctx.baseUrl) return; // no live DEV target to clean against — mirrors legacy's own guard
    await this.collaborators.e2e({
      dir: specDir,
      baseUrl: this.ctx.baseUrl,
      namespace: opts.namespace,
      ...(this.ctx.testIdAttribute !== undefined ? { testIdAttribute: this.ctx.testIdAttribute } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }
}
