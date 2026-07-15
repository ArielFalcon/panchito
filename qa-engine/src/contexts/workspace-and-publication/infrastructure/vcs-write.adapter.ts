// src/contexts/workspace-and-publication/infrastructure/vcs-write.adapter.ts
// THE security seam: the ONLY implementation of VcsWritePort. The arch-lint gate forbids
// generation/* and agent-runtime/* from importing this file or the port (agent-is-read-only).
// Delegates to the injected Git fn (same boundary as repo-mirror.realGit); argv lives here.
//
// SECURITY: the injected git fn MUST prepend authHeaderArgs() before any network git operation
// (clone, fetch, push) and the commit-identity `-c user.name/-c user.email` flags before commit.
// The adapter itself is auth- and identity-agnostic (token-free, testable) — the real-wiring
// obligation is on the injector, not this class.
//
// CORRECTED (adversarial review): an earlier revision of this header claimed realGit itself
// "prepends authHeaderArgs()" — FALSE. realGit (src/integrations/repo-mirror.ts) is a bare execFile
// wrapper that only applies hardenGitArgs (hooks/safe.directory) + GIT_TERMINAL_PROMPT=0; auth in
// this codebase is applied per CALL SITE (syncMirror/resolveRef there, legacy publish.ts:124). The
// production injector (buildVcsPublish in src/server/rewritten-engine-factory.ts) therefore wraps
// the git fn in withPublishGitDecorations, which prepends authHeaderArgs() on push and the legacy
// `-c user.name/-c user.email` identity flags (GIT_AUTHOR_* env fallbacks) on commit — keyed on
// this adapter's own pinned argv shapes (args[0] is always the bare subcommand; this class never
// emits leading -c flags itself, and its unit tests pin that invariant). The adapter stays
// token-agnostic so the test needs no token.
//
// PROD-BLOCKER fix: widened with checkoutBranch/hasChanges/writeExcludes — the remaining git
// mechanics from the legacy contract (src/integrations/publish.ts's publishChanges) that were never
// ported when this adapter was first written. writeExcludes is a filesystem write (not a git
// subprocess call), so it takes its OWN injected fn rather than going through `git` — defaults to a
// real fs write in the composition root (rewritten-engine-factory.ts), same DI boundary as `git`.
//
// sdd/security-hardening Slice 1: commit()'s optional `denyModifiedTracked` predicate is the SECOND,
// independent, deterministic tracked-file guard — see VcsWritePort's own header for the full
// rationale (gitignore excludes are untracked-only; the runtime confinement step is documented
// fail-open). Reuses WriteConfinementService.decodeGitPath so a quoted/escaped path from `git diff`
// decodes identically to how the sibling write-confinement adapter decodes `git status` output —
// the two must never drift on path decoding.
import type { VcsWritePort } from "../application/ports/index.ts";
import { WriteConfinementService } from "../domain/write-confinement.service.ts";

type Git = (args: string[], cwd?: string) => Promise<string>;
type WriteExcludesFn = (dir: string, patterns: readonly string[]) => void | Promise<void>;

export class VcsWriteAdapter implements VcsWritePort {
  private readonly pathDecoder = new WriteConfinementService();

  constructor(
    private readonly git: Git,
    private readonly writeExcludesFn?: WriteExcludesFn,
  ) {}

  async commit(
    dir: string,
    message: string,
    files: readonly string[],
    denyModifiedTracked?: (path: string) => boolean,
  ): Promise<void> {
    await this.git(["add", "--", ...files], dir);
    if (denyModifiedTracked) {
      // Scoped to MODIFIED (not added/deleted) staged paths — a newly-added tracked file was, until
      // this commit, untracked, so it is already caught by the exclude-file guard; the gap this
      // closes is specifically an already-tracked path an agent modified in place.
      const diffOut = await this.git(["diff", "--cached", "--name-only", "--diff-filter=M"], dir);
      const denied = diffOut
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((l) => this.pathDecoder.decodeGitPath(l))
        .filter((p) => denyModifiedTracked(p));
      if (denied.length > 0) {
        // Staged-aware AND working-tree revert (matches write-confinement.adapter.ts's own tracked
        // revert exactly) — the tamper must not merely be unstaged (it would resurface on the very
        // next publish attempt), it must be restored to HEAD.
        await this.git(["restore", "--staged", "--worktree", "--source=HEAD", "--", ...denied], dir);
      }
    }
    await this.git(["commit", "-m", message], dir);
  }

  async push(dir: string, branch: string): Promise<void> {
    await this.git(["push", "--force-with-lease", "-u", "origin", branch], dir);
  }

  async checkoutBranch(dir: string, branch: string): Promise<void> {
    await this.git(["checkout", "-B", branch], dir);
  }

  async hasChanges(dir: string, pathspecs: readonly string[]): Promise<boolean> {
    const status = await this.git(["status", "--porcelain", "--", ...pathspecs], dir);
    return status.trim().length > 0;
  }

  async writeExcludes(dir: string, patterns: readonly string[]): Promise<void> {
    if (!this.writeExcludesFn) return;
    await this.writeExcludesFn(dir, patterns);
  }
}
