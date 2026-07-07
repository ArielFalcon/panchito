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
import type { VcsWritePort } from "../application/ports/index.ts";

type Git = (args: string[], cwd?: string) => Promise<string>;
type WriteExcludesFn = (dir: string, patterns: readonly string[]) => void | Promise<void>;

export class VcsWriteAdapter implements VcsWritePort {
  constructor(
    private readonly git: Git,
    private readonly writeExcludesFn?: WriteExcludesFn,
  ) {}

  async commit(dir: string, message: string, files: readonly string[]): Promise<void> {
    await this.git(["add", "--", ...files], dir);
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
