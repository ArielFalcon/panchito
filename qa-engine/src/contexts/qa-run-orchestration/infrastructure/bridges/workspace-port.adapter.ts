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
//
// WS2.1 (full-flow remediation, code-mode restoration): this adapter was previously e2e-only in
// effect — the composition root always passed "e2e" as the rel-dir (rewritten-engine-factory.ts's
// own `const e2eRelDir = "e2e"` was UNCONDITIONAL), so a code:true app's specDir resolved to
// `<mirrorDir>/e2e`, a directory that never exists for a code-mode watched repo (panchito has no
// e2e/ folder) — setup/validate/execute all died against a phantom path. Legacy passed `mirrorDir`
// itself for the code target (git show 1228ea7~1:src/pipeline.ts:1299 `setupCode(mirrorDir, ...)`,
// :2497 `executeCode(mirrorDir, ...)` — never a mirrorDir/e2e subpath). `specRelDir` (renamed from
// `e2eRelDir` to make the field's target-aware contract explicit — it is no longer always "the e2e
// folder") reproduces that exactly: an EMPTY string composes to the bare mirrorDir, never
// `mirrorDir/` (a trailing-slash artifact would be a cosmetic but needless divergence from legacy's
// literal `mirrorDir` value). A non-empty specRelDir (e2e's "e2e") keeps the prior join unchanged.
import type { Sha } from "@kernel/sha.ts";
import type { WorkspacePort } from "../../application/ports/index.ts";

export type CheckoutFn = (sha: Sha) => Promise<string>; // resolves the sha's working-copy mirrorDir

export interface WorkspacePortStaticContext {
  // Tests folder relative to mirrorDir. "e2e" for the e2e target; "" (empty) for the code target —
  // an empty value composes prepare()'s specDir to the BARE mirrorDir, matching legacy's code-mode
  // semantics exactly (see this module's own header). Renamed from `e2eRelDir` (which implied "the
  // e2e folder" unconditionally) to `specRelDir` to make the target-aware contract explicit at the
  // type level; distinct from CompositionConfig.e2eRelDir, which stays the PROMPT-side "e2e folder
  // name" constant (unused by code-mode prompt builders — see rewritten-engine-factory.ts's own note).
  specRelDir: string;
}

export class WorkspacePortAdapter implements WorkspacePort {
  constructor(
    private readonly checkout: CheckoutFn,
    private readonly ctx: WorkspacePortStaticContext,
  ) {}

  async prepare(sha: Sha): Promise<{ specDir: string }> {
    const mirrorDir = await this.checkout(sha);
    return { specDir: this.ctx.specRelDir ? `${mirrorDir}/${this.ctx.specRelDir}` : mirrorDir };
  }
}
