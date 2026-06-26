// src/contexts/workspace-and-publication/infrastructure/vcs-write.adapter.ts
// THE security seam: the ONLY implementation of VcsWritePort. The arch-lint gate forbids
// generation/* and agent-runtime/* from importing this file or the port (agent-is-read-only).
// Delegates to the injected Git fn (same boundary as repo-mirror.realGit); argv lives here.
//
// SECURITY: the injected git fn MUST prepend authHeaderArgs() before any network git operation
// (clone, fetch, push). The adapter itself is auth-agnostic (token-free, testable) — the
// real-wiring obligation is on the injector (Plan-6 composition root), not this class.
//
// Plan-6 wiring injects `realGit` (which prepends authHeaderArgs() + hardening). The adapter
// stays auth-agnostic so the test needs no token.
import type { VcsWritePort } from "../application/ports/index.ts";

type Git = (args: string[], cwd?: string) => Promise<string>;

export class VcsWriteAdapter implements VcsWritePort {
  constructor(private readonly git: Git) {}

  async commit(dir: string, message: string, files: readonly string[]): Promise<void> {
    await this.git(["add", "--", ...files], dir);
    await this.git(["commit", "-m", message], dir);
  }

  async push(dir: string, branch: string): Promise<void> {
    await this.git(["push", "--force-with-lease", "-u", "origin", branch], dir);
  }
}
