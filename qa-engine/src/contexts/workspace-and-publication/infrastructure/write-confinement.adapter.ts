// qa-engine/src/contexts/workspace-and-publication/infrastructure/write-confinement.adapter.ts
//
// sdd/migration-remediation, Slice 3 (P0 write-confinement wiring, D-P0b in
// docs/superpowers/2026-07-10-migration-remediation-decisions.md).
//
// The effectful half of write-confinement: wraps this context's own pure WriteConfinementService
// classifiers (../domain/write-confinement.service.ts) over an injected Git + realpath/isSymlink,
// mirroring src/qa/confinement.ts's runConfinement EXACTLY (the legacy behavioral oracle — never
// wired into any production caller there; this adapter is the faithful port). Same git semantics:
// tracked strays are reverted via a STAGED-AWARE `git restore --staged --worktree --source=HEAD`
// (unstages AND restores from HEAD — a plain `git checkout --` would leave a staged-new stray to be
// committed), untracked strays via `git clean -f`, and any changed path that is a symlink whose
// realpath resolves OUTSIDE mirrorDir is escalated to dangerous + reverted, in BOTH targets (the
// code target's publishCode stages `.`, so an escaping symlink would otherwise be committed there
// too). Git errors are NEVER swallowed here — they throw, exactly like runConfinement's own
// documented contract; RunQaUseCase (application layer) owns the fault-isolation/fail-open posture
// (design D-P0b) around every enforce() call, not this adapter.
//
// This class implements the qa-run-orchestration ConfinementPort STRUCTURALLY (duck-typed) — this
// context never imports that port type, honoring the barrel's own "no cross-context import" rule
// (qa-run-orchestration/application/ports/index.ts) and the dependency-cruiser "only
// workspace-and-publication may import the VCS write seam" gate (.dependency-cruiser.cjs): this file
// is itself INSIDE workspace-and-publication, so it may freely import its own domain's
// WriteConfinementService.
import { join, sep } from "node:path";
import { WriteConfinementService } from "../domain/write-confinement.service.ts";

export type Git = (args: string[], cwd?: string) => Promise<string>;

export interface WriteConfinementAdapterDeps {
  git: Git;
  realpath(p: string): string;
  // Cheap symlink pre-filter: only an actual symlink needs the full realpath resolution for the
  // escape check, so lstat lets the common case (ordinary files) skip realpath entirely.
  isSymlink(p: string): boolean;
}

export interface ConfinementResult {
  strays: number;
  dangerous: number;
  reverted: string[];
}

export class WriteConfinementAdapter {
  private readonly classifier = new WriteConfinementService();

  constructor(private readonly deps: WriteConfinementAdapterDeps) {}

  // Steps (mirrors src/qa/confinement.ts's runConfinement verbatim):
  //   1. git status --porcelain --untracked-files=all -> parse
  //   2. classifyStrays against the target-specific predicate (e2e allowlist / code denylist)
  //   3. symlink/path-escape check (BOTH targets)
  //   4. revert: tracked -> git restore (staged-aware); untracked -> git clean -f. Skips the git call
  //      when the bucket is empty. Never swallows a git error (it throws).
  //   5. return { strays, dangerous, reverted }
  async enforce(mirrorDir: string, isCode: boolean, signal?: AbortSignal): Promise<ConfinementResult> {
    // Defensive: a cancelled run has nothing left to enforce against — mirrors every other port's
    // own "an aborted signal short-circuits" posture elsewhere in this use-case's call sites. The
    // underlying injected Git fn takes no AbortSignal of its own (repo-mirror.ts's Git type), so this
    // is the only place this adapter can honor cancellation.
    if (signal?.aborted) {
      return { strays: 0, dangerous: 0, reverted: [] };
    }

    const out = await this.deps.git(["status", "--porcelain", "--untracked-files=all"], mirrorDir);
    const changes = this.classifier.parseStatusOutput(out);
    const { tracked, untracked, dangerousByPath } = this.classifier.classifyStrays(changes, isCode);

    const escapes: string[] = [];
    const mirrorReal = this.deps.realpath(mirrorDir) + sep;
    for (const { xy, path } of changes) {
      // e2e-target restricts the escape scan to the in-area paths (out-of-area paths are already
      // strays, handled above); code-target scans every changed path.
      if (!isCode && path !== "e2e" && !path.startsWith("e2e/")) continue;
      let resolved: string;
      try {
        // Cheap pre-filter: only a real symlink can escape via resolution, so ordinary files skip
        // realpath entirely. lstat/realpath can throw when the path was deleted — not an escape,
        // skip.
        if (!this.deps.isSymlink(join(mirrorDir, path))) continue;
        resolved = this.deps.realpath(join(mirrorDir, path));
      } catch {
        continue;
      }
      if (resolved.startsWith(mirrorReal)) continue;
      escapes.push(path);
      // Add to the right revert bucket if not already there (an in-area e2e escape was skipped by
      // classifyStrays; a code-target escape may already be a denied stray).
      if (!tracked.includes(path) && !untracked.includes(path)) {
        if (xy === "??") untracked.push(path);
        else tracked.push(path);
      }
    }

    // Revert tracked strays — staged-aware (unstage + restore working tree from HEAD).
    if (tracked.length > 0) {
      await this.deps.git(["restore", "--staged", "--worktree", "--source=HEAD", "--", ...tracked], mirrorDir);
    }
    // Revert untracked strays (git clean -f removes the unversioned file).
    if (untracked.length > 0) {
      await this.deps.git(["clean", "-f", "--", ...untracked], mirrorDir);
    }

    return {
      strays: tracked.length + untracked.length,
      // Dedup: a path can be BOTH a denylist secret (dangerousByPath) and an escaping symlink
      // (escapes); a plain sum would count it twice. The Set collapses the overlap to one.
      dangerous: new Set([...dangerousByPath, ...escapes]).size,
      reverted: [...tracked, ...untracked],
    };
  }
}
