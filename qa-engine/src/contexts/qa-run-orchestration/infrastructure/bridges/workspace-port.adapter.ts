// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/workspace-port.adapter.ts
// Bridge: WorkspacePort -> a REAL minimal implementation (no existing sibling to wrap).
//
// PLAN DRIFT (recorded per Task E.0's own instruction to report a missing/drifted sibling entry
// point): the plan describes this bridge as wrapping "the mirror prepare", implying an existing
// sibling collaborator. None exists — grep-confirmed: MirrorRegistryPort (kernel) resolves a repo
// STRING to an on-disk dir, but its OWN header states it is deliberately decoupled from
// WorkspacePort and the run's SHA ("without coupling to the run's SHA or WorkspacePort"); it has no
// prepare(sha)/checkout side effect. MirrorGcPort only PRUNES an already-existing mirror
// (git gc --auto), never creates/checks one out. No file under
// workspace-and-publication/ or change-analysis/ owns "checkout this sha into a working copy". This
// is the SAME class of gap as DeployGatePort/RunHistoryPort (Task E.0's own header already expects
// two such bridges to be REAL implementations, not wraps) — a third one, undeclared in the plan's
// text but structurally identical: no sibling exists, so this bridge IS the minimal real thing.
//
// Follows the codebase's established DI pattern (GitMirrorReadAdapter / VcsWriteAdapter): argv/paths
// live in this adapter, the actual checkout mechanism is injected so the test needs no real git
// binary or filesystem. Cross-repo routing stays OPAQUE inside this bridge (the plan's own scope
// note for WorkspacePort) — the injected checkout collaborator receives only the Sha; which mirror
// it resolves to (primary repo vs. a triggering service repo) is the injected fn's own concern, not
// this adapter's. Errors from checkout propagate loudly (CLAUDE.md: never swallow an integration
// error into an empty result).
import type { Sha } from "@kernel/sha.ts";
import type { WorkspacePort } from "../../application/ports/index.ts";

export type CheckoutFn = (sha: Sha) => Promise<string>; // resolves the sha's working-copy mirrorDir

export interface WorkspacePortStaticContext {
  e2eRelDir: string; // tests folder relative to mirrorDir (e.g. "e2e") — mirrors OpencodeRunInput.e2eRelDir
}

export class WorkspacePortAdapter implements WorkspacePort {
  constructor(
    private readonly checkout: CheckoutFn,
    private readonly ctx: WorkspacePortStaticContext,
  ) {}

  async prepare(sha: Sha): Promise<{ specDir: string }> {
    const mirrorDir = await this.checkout(sha);
    return { specDir: `${mirrorDir}/${this.ctx.e2eRelDir}` };
  }
}
