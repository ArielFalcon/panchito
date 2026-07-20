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
//
// sdd/migration-wiring-phase-2, Slice 9 (D-G, AMENDMENT 2): enforce() also pairs an UNSTAGED
// fs-level agent rename (no git access, so a move surfaces as an independent ` D` + `??` pair, not
// a git-native R line) via git's own content-similarity rename detection, closing the KNOWN
// LIMITATION documented on WriteConfinementService.classifyStrays. See enforce()'s own inline
// comment for the transient add-N -> diff -> reset sequence.
import { join, sep } from "node:path";
import { WriteConfinementService, type GitRename } from "../domain/write-confinement.service.ts";

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
    for (const { xy, path, renameCounterpart } of changes) {
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
      // Add the FULL revert unit if not already there (an in-area e2e escape was skipped by
      // classifyStrays; a code-target escape may already be a denied stray). Judgment Day round 2:
      // an escape-detected path that is one side of a staged rename must revert its counterpart
      // too (this.classifier.revertUnit, shared with classifyStrays) — pushing only the
      // escape-detected side orphans the other half's staged deletion, the same destructive
      // pattern the round-1 rename-over-revert fix closed for classifyStrays.
      for (const p of this.classifier.revertUnit(path, renameCounterpart)) {
        if (!tracked.includes(p) && !untracked.includes(p)) {
          if (xy === "??") untracked.push(p);
          else tracked.push(p);
        }
      }
    }

    // ── unstaged fs-level rename pairing (Slice 9, D-G, AMENDMENT 2) ──────────────────────────
    // The agent has no git access (read-only on watched repos), so its own `fs.rename` surfaces as
    // two INDEPENDENT status lines with no git-native renameCounterpart: an in-area unstaged
    // deletion (` D`, NOT staged, NOT already a stray under the target's rules — a legitimate
    // agent-owned path) plus an out-of-area untracked stray (`??`, already in `untracked` above).
    // Pair them using git's OWN content-similarity rename detection, never a hand-rolled heuristic:
    // transiently `git add -N` (intent-to-add) the untracked candidates so they appear as additions
    // in a working-tree diff, ask `git diff --find-renames` whether it pairs any of them with one
    // of the in-area deletions, then hand the (adapter-computed) pairing evidence to the classifier's
    // PURE pairUnstagedRenames decision. RIDER 2: the whole add-N -> diff -> reset sequence is
    // wrapped in try/finally so `git reset` (undoing the transient intent-to-add) ALWAYS fires — on
    // the happy path AND on any error mid-sequence — never leaving the index mutated.
    const isConfined = (p: string): boolean => (isCode ? !this.classifier.isCodeDenied(p) : !this.classifier.isE2eStray(p));
    const candidateDeleted = changes
      .filter((c) => c.xy === " D" && c.renameCounterpart === undefined && isConfined(c.path))
      .map((c) => c.path);
    let restoredDeleted: string[] = [];
    if (candidateDeleted.length > 0 && untracked.length > 0) {
      let gitRenames: GitRename[] = [];
      try {
        await this.deps.git(["add", "-N", "--", ...untracked], mirrorDir);
        const diffOut = await this.deps.git(
          ["diff", "--find-renames", "-M50%", "--diff-filter=R", "--name-status", "HEAD"],
          mirrorDir,
        );
        gitRenames = parseRenameNameStatus(diffOut, (raw) => this.classifier.decodeGitPath(raw));
      } finally {
        await this.deps.git(["reset", "--", ...untracked], mirrorDir);
      }
      restoredDeleted = this.classifier.pairUnstagedRenames(candidateDeleted, untracked, gitRenames).restore;
    }

    // Revert tracked strays — staged-aware (unstage + restore working tree from HEAD).
    if (tracked.length > 0) {
      await this.deps.git(["restore", "--staged", "--worktree", "--source=HEAD", "--", ...tracked], mirrorDir);
    }
    // Revert untracked strays (git clean -f removes the unversioned file).
    if (untracked.length > 0) {
      await this.deps.git(["clean", "-f", "--", ...untracked], mirrorDir);
    }
    // Restore the confirmed OLD side of a paired unstaged rename — recovers the moved content
    // that git's own detection matched to a now-cleaned stray. --source=HEAD is explicit (not
    // strictly required — the index already holds HEAD's content for an unstaged-only deletion —
    // but matches the "restored from HEAD" contract these paths carry).
    if (restoredDeleted.length > 0) {
      await this.deps.git(["restore", "--source=HEAD", "--", ...restoredDeleted], mirrorDir);
    }

    return {
      // A paired unstaged rename counts as 2 strays (both sides), matching the existing convention
      // for a git-detected staged rename (both sides land in `tracked` via classifyStrays above).
      strays: tracked.length + untracked.length + restoredDeleted.length,
      // Dedup: a path can be BOTH a denylist secret (dangerousByPath) and an escaping symlink
      // (escapes); a plain sum would count it twice. The Set collapses the overlap to one.
      dangerous: new Set([...dangerousByPath, ...escapes]).size,
      reverted: [...tracked, ...untracked, ...restoredDeleted],
    };
  }
}

// Parse `git diff --find-renames --diff-filter=R --name-status HEAD` output (restricted to renames
// only, via --diff-filter=R) into typed {from, to} pairs. Each matching line is `R<score>\told\tnew`
// — paths are decoded through the SAME git-quote/octal-escape decoder `git status --porcelain`
// output goes through (`decode`, injected as WriteConfinementService.decodeGitPath), so a non-ASCII
// or otherwise-quoted filename composes correctly through the pairing path too.
function parseRenameNameStatus(out: string, decode: (raw: string) => string): GitRename[] {
  return out
    .split("\n")
    .filter((l) => l.startsWith("R"))
    .map((l) => l.split("\t"))
    .filter((parts): parts is [string, string, string] => parts.length === 3)
    .map(([, from, to]) => ({ from: decode(from as string), to: decode(to as string) }));
}
