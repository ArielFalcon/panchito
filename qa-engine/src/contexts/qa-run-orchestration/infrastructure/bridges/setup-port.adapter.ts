// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/setup-port.adapter.ts
// Bridge: SetupPort -> the REAL e2e/code setup dispatch. THIN — no new policy: this bridge only
// maps SetupPort.setup(specDir, signal?) onto whichever collaborator matches the run's target,
// mirroring ExecutionPortAdapter's own target-dispatch pattern exactly (same file, same discipline).
//
// The collaborators are duck-typed callbacks: `code` still matches src/qa/code-runner.ts's
// setupCodeProject(repoDir, deps, opts?) call shape (unmigrated, out of scope for migration-tier-4a) —
// the factory binds the real function + defaultCodeSetupDeps into that slot. `e2e` is now bound to
// qa-engine's OWN SetupAdapter.setup(e2eDir, opts?) (migration-tier-4a — the real bootstrap/install
// logic relocated from the now-deleted src/qa/setup.ts); this bridge still never re-implements it —
// only the call SHAPE is pinned here, kept duck-typed on purpose so `e2e`/`code` stay symmetric even
// though one collaborator is qa-engine-native and the other is still src-bound.
//
// A throw from either collaborator propagates verbatim (never caught here) — CLAUDE.md's invariant:
// a setup failure is infra-error, never a code verdict. RunQaUseCase.run is the layer that maps the
// throw to infraErrorResult().
import type { SetupPort } from "../../application/ports/index.ts";
import type { TestTarget } from "@kernel/run-mode.ts";

export type SetupFn = (dir: string, opts?: { signal?: AbortSignal }) => Promise<void>;

export interface SetupPortCollaborators {
  e2e: SetupFn; // bound to qa-engine's own SetupAdapter.setup (migration-tier-4a)
  code: SetupFn; // bound to setupCodeProject(repoDir, defaultCodeSetupDeps)
}

export interface SetupPortStaticContext {
  target: TestTarget;
}

export class SetupPortAdapter implements SetupPort {
  constructor(
    private readonly collaborators: SetupPortCollaborators,
    private readonly ctx: SetupPortStaticContext,
  ) {}

  async setup(specDir: string, signal?: AbortSignal): Promise<void> {
    const fn = this.ctx.target === "code" ? this.collaborators.code : this.collaborators.e2e;
    await fn(specDir, { ...(signal ? { signal } : {}) });
  }
}
