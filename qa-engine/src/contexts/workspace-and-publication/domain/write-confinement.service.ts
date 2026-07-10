// Pure confinement classifiers, originally lifted from src/qa/confinement.ts (now deleted; this
// domain service is the sole implementation). Hosts parseStatusOutput, isE2eStray, isCodeDenied,
// isDangerousPath, classifyStrays (all pure, no I/O). The effectful runConfinement stays in the
// VcsWrite adapter wiring; this class is fully unit-testable without git.
//
// parseStatusOutput and classifyStrays diverge intentionally from the original legacy behavior:
// a rename/copy status line is expanded into BOTH sides (old + new) and reverted as a unit — see
// ParsedChange.renameCounterpart — fixing a bug where the legacy single-record shape degraded a
// reverted staged rename into an orphaned staged deletion of the legitimate old path.

// Code-target denylist: paths (or glob patterns) the agent must NOT write.
// e2e-target uses an allowlist (only `e2e/` is permitted), not this list.
// `.git/` is intentionally NOT listed: git status never reports paths inside `.git/`, so a
// denylist entry for it would be dead — `.git/` is hardened separately via core.hooksPath.
// Note: `.env.*` needs a prefix case beyond isProtectedPath's three rules — handled in isCodeDenied.
// HONESTY: the `.env*` entries only catch a secret write that is NOT git-ignored — git status
// (the only input) omits git-ignored paths, and `.env*` is git-ignored in most repos. The publish
// exclude (CODE_EXCLUDES + e2e add, publish.ts) is the actual guard against committing a secret;
// these entries are defense-in-depth. See the module header.
export const CONFINEMENT_DENYLIST: string[] = [
  ".env",
  ".env.*",
  "*.env",
  ".github/",
  "Dockerfile",
  "docker-compose*",
  // VCS metadata that would alter how git itself treats the tree (filters/attributes, submodule
  // wiring). publishCode stages `.`, so an agent-written one would otherwise be committed.
  ".gitattributes",
  ".gitmodules",
];

export interface ParsedChange {
  xy: string; // 2-char porcelain status code, e.g. "M ", "??", "R "
  path: string; // repo-relative path (after rename resolution and quote-stripping)
  // For a rename/copy (`R`/`C`) status line ONLY: the other side's path (old<->new). A rename is
  // two independent filesystem effects — the old path is a deletion of a file that exists in HEAD
  // (reverting it restores the content), the new path is an addition with no HEAD counterpart
  // (reverting it removes it). Both records carry this so classifyStrays can revert them as a
  // unit and never leave one half orphaned. Absent for every non-rename status line.
  renameCounterpart?: string;
}

export interface ClassifiedStrays {
  tracked: string[];
  untracked: string[];
  dangerousByPath: string[];
}

export class WriteConfinementService {
  // Parse `git status --porcelain --untracked-files=all` output into typed records.
  // Handles: 2-char XY status codes; rename/copy lines `R  old -> new` (emits BOTH the old and new
  // path — see ParsedChange.renameCounterpart; collapsing to only the new path is the rename-over-
  // revert bug: enforce() would then degrade a staged rename into an orphaned staged deletion of
  // the legitimate old path); git-quoted paths with spaces/unicode (core.quotePath — strips
  // surrounding `"`, applied independently to each side of a rename).
  parseStatusOutput(out: string): ParsedChange[] {
    const stripQuotes = (p: string): string => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p);
    return out
      .split("\n")
      .filter((l) => l.length > 3)
      .flatMap((l): ParsedChange[] => {
        const xy = l.slice(0, 2);
        const rest = l.slice(3);
        // The ` -> ` split applies ONLY to rename/copy entries (status X is R or C). A non-rename
        // file whose name literally contains " -> " must keep its full path, not be truncated to a
        // phantom suffix (which would then make `git checkout` throw on a bogus pathspec).
        if (xy[0] === "R" || xy[0] === "C") {
          const arrowIdx = rest.indexOf(" -> ");
          if (arrowIdx !== -1) {
            const oldPath = stripQuotes(rest.slice(0, arrowIdx));
            const newPath = stripQuotes(rest.slice(arrowIdx + 4));
            return [
              { xy, path: oldPath, renameCounterpart: newPath },
              { xy, path: newPath, renameCounterpart: oldPath },
            ];
          }
        }
        return [{ xy, path: stripQuotes(rest) }];
      });
  }

  // True when the path falls OUTSIDE the `e2e/` area (the only area an e2e-target
  // agent is permitted to write).
  // VERBATIM from confinement.ts isE2eStray.
  isE2eStray(path: string): boolean {
    return path !== "e2e" && !path.startsWith("e2e/");
  }

  // True when a path matches any entry in CONFINEMENT_DENYLIST (code-target only).
  // Mirrors the isProtectedPath style from merge-guard.ts:59-66, with an extra
  // prefix-glob case for `.env.*` entries (`.env.local`, etc.).
  // VERBATIM from confinement.ts isCodeDenied.
  isCodeDenied(path: string): boolean {
    // The backslash→slash normalization is defensive-only: git status output (the only caller's
    // input) is already forward-slashed, so it is a guard for non-git callers, never hit on-path.
    // Lowercase BOTH sides: on a case-insensitive host (.ENV, DOCKERFILE, .GitHub/) the OS treats
    // them as the same file, so the denylist must match them too — comparing raw would let them slip.
    const f = path.replace(/^\.\//, "").replace(/\\/g, "/").toLowerCase();
    return CONFINEMENT_DENYLIST.some((entry) => {
      const p = entry.toLowerCase();
      if (p === ".env.*") return f.startsWith(".env."); // prefix glob: .env.local, .env.production…
      if (p.startsWith("*")) return f.endsWith(p.slice(1)); // suffix glob: *.env
      if (p.endsWith("/")) return f.startsWith(p); // directory prefix: .github/
      if (p.endsWith("*")) return f.startsWith(p.slice(0, -1)); // trailing-star prefix: docker-compose*
      return f === p; // exact match: .env, Dockerfile
    });
  }

  // True when the path meets the dangerous tier: a secret-file write (`.env` exact,
  // `.env.*` prefix, or `*.env` suffix). Applies regardless of run target. `.git/` is
  // NOT a case here — git status never surfaces paths inside `.git/`, so it could never
  // reach this predicate; `.git/` hook RCE is hardened separately via core.hooksPath.
  // VERBATIM from confinement.ts isDangerousPath.
  isDangerousPath(path: string): boolean {
    // Lowercase so a case-insensitive host (.ENV, secrets.ENV) is flagged too — the OS would resolve
    // them to the same secret file the lowercase comparands target.
    const f = path.replace(/\\/g, "/").toLowerCase();
    return f === ".env" || f.startsWith(".env.") || f.endsWith(".env");
  }

  // Classify every changed path: apply the run-target predicate (e2e allowlist or
  // code denylist), split by tracked vs. untracked (XY `??`), and flag dangerous paths.
  // Rename/copy pairs (renameCounterpart set) are classified and reverted as a UNIT, not
  // independently: git stores a rename as a plain delete+add (there is no rename metadata; `R`/`C`
  // in `git status` is only inferred by content similarity), so reverting just one side leaves the
  // other half orphaned — e.g. reverting only a stray new path leaves the legitimate old path's
  // staged deletion in place, destroying the file. If EITHER side is a stray under the target's
  // rules, BOTH sides go into the revert bucket; a rename fully inside the allowed area (neither
  // side a stray) is a legitimate agent write and is left untouched.
  classifyStrays(changes: ParsedChange[], isCode: boolean): ClassifiedStrays {
    const isStray = isCode ? this.isCodeDenied.bind(this) : this.isE2eStray.bind(this);
    const tracked: string[] = [];
    const untracked: string[] = [];
    const dangerousByPath: string[] = [];
    const renameHandled = new Set<string>();

    for (const { xy, path, renameCounterpart } of changes) {
      if (renameCounterpart !== undefined) {
        if (renameHandled.has(path)) continue; // already handled together with its counterpart
        renameHandled.add(path);
        renameHandled.add(renameCounterpart);
        if (isStray(path) || isStray(renameCounterpart)) {
          for (const p of [path, renameCounterpart]) {
            // A rename is always staged (git only emits R/C once a rename is staged/detected — an
            // unstaged rename shows as separate D + ?? lines, handled by the branch below), so both
            // sides always belong in the tracked bucket.
            tracked.push(p);
            if (this.isDangerousPath(p)) dangerousByPath.push(p);
          }
        }
        continue;
      }

      if (!isStray(path)) continue;
      if (xy === "??") {
        untracked.push(path);
      } else {
        tracked.push(path);
      }
      if (this.isDangerousPath(path)) dangerousByPath.push(path);
    }

    return { tracked, untracked, dangerousByPath };
  }
}
