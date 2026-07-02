// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/setup-port.adapter.ts
// Bridge: SetupPort -> the REAL e2e/code setup dispatch. THIN — no new policy: this bridge only
// maps SetupPort.setup(specDir, signal?) onto whichever collaborator matches the run's target,
// mirroring ExecutionPortAdapter's own target-dispatch pattern exactly (same file, same discipline).
//
// The collaborators are duck-typed callbacks matching src/qa/setup.ts's setupE2eProject(e2eDir,
// deps, opts?) and src/qa/code-runner.ts's setupCodeProject(repoDir, deps, opts?) call shape — the
// composition root/factory bind the REAL functions + their real *Deps (defaultSetupDeps /
// defaultCodeSetupDeps) into these two slots; this adapter never re-implements bootstrap/install
// logic itself (qa-engine must not depend on src/, so it cannot import setupE2eProject/
// setupCodeProject directly — only their call SHAPE is pinned here).
//
// A throw from either collaborator propagates verbatim (never caught here) — CLAUDE.md's invariant:
// a setup failure is infra-error, never a code verdict. RunQaUseCase.run is the layer that maps the
// throw to infraErrorResult().
import type { SetupPort } from "../../application/ports/index.ts";
import type { TestTarget } from "@kernel/run-mode.ts";

export type SetupFn = (dir: string, opts?: { signal?: AbortSignal }) => Promise<void>;

export interface SetupPortCollaborators {
  e2e: SetupFn; // bound to setupE2eProject(e2eDir, defaultSetupDeps)
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
