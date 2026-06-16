// Write-confinement guard: classify + revert agent writes outside the allowed area.
// What it catches: out-of-area writes that `git status --porcelain` surfaces (a tracked
// file modified, or an untracked file created, outside the permitted area). A symlink that
// escapes the mirror is DETECTED and its link entry is reverted — but any external file the
// agent may have written THROUGH that link is NOT un-written (the guard reverts the working
// copy, not the host). `.git/` is NOT enforced here: git status never reports paths inside
// `.git/`, so there is nothing for this guard to revert; `.git/` hook RCE is hardened
// SEPARATELY by realGit running every command with `core.hooksPath=/dev/null`.
//
// Secret tier — honest scope: detection runs off `git status --untracked-files=all`, which does
// NOT list git-ignored paths. Since `.env*` is git-ignored in most repos, the `.env*` dangerous/
// denylist tier rarely fires in practice — it only catches a secret write that is NOT git-ignored.
// The REAL guard against committing a secret is at publish: CODE_EXCLUDES + `git add -- e2e` re-
// exclude `.env*` (publish.ts), so even an undetected git-ignored secret never reaches a PR. This
// tier is defense-in-depth on top of that, not the primary control.
//
// Pure classifiers (parseStatusOutput, isE2eStray, isCodeDenied, isDangerousPath,
// classifyStrays) are testable without I/O. runConfinement is the effectful layer.

import { join, sep } from "node:path";
import type { Git } from "../integrations/repo-mirror";

export interface ConfinementResult {
  strays: number;
  dangerous: number;
  reverted: string[];
}

export interface ParsedChange {
  xy: string; // 2-char porcelain status code, e.g. "M ", "??", "R "
  path: string; // repo-relative path (after rename resolution and quote-stripping)
}

export interface ConfineDeps {
  git: Git;
  realpath(p: string): string;
  // Cheap symlink pre-filter: only an actual symlink needs the full realpath resolution for the
  // escape check, so lstat lets the common case (ordinary files) skip realpath entirely.
  isSymlink(p: string): boolean;
}

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

// ── PURE (no I/O, fully unit-testable) ────────────────────────────────────────

// Parse `git status --porcelain --untracked-files=all` output into typed records.
// Handles: 2-char XY status codes; rename/copy lines `R  old -> new` (takes new path);
// git-quoted paths with spaces/unicode (core.quotePath — strips surrounding `"`).
export function parseStatusOutput(out: string): ParsedChange[] {
  return out
    .split("\n")
    .filter((l) => l.length > 3)
    .map((l) => {
      const xy = l.slice(0, 2);
      let path = l.slice(3);
      // The ` -> ` split applies ONLY to rename/copy entries (status X is R or C). A non-rename
      // file whose name literally contains " -> " must keep its full path, not be truncated to a
      // phantom suffix (which would then make `git checkout` throw on a bogus pathspec).
      if (xy[0] === "R" || xy[0] === "C") {
        const arrowIdx = path.indexOf(" -> ");
        if (arrowIdx !== -1) path = path.slice(arrowIdx + 4);
      }
      // Strip surrounding git quotes added for paths with spaces/unicode.
      if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
      return { xy, path };
    });
}

// True when the path falls OUTSIDE the `e2e/` area (the only area an e2e-target
// agent is permitted to write).
export function isE2eStray(path: string): boolean {
  return path !== "e2e" && !path.startsWith("e2e/");
}

// True when a path matches any entry in CONFINEMENT_DENYLIST (code-target only).
// Mirrors the isProtectedPath style from merge-guard.ts:59-66, with an extra
// prefix-glob case for `.env.*` entries (`.env.local`, etc.).
export function isCodeDenied(path: string): boolean {
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
// SCOPE: only fires for a secret that is NOT git-ignored (git status --untracked-files=all
// omits ignored paths, and `.env*` is usually ignored). The committing safeguard is the
// publish exclude (CODE_EXCLUDES / e2e add), not this tier — see the module header.
export function isDangerousPath(path: string): boolean {
  // Lowercase so a case-insensitive host (.ENV, secrets.ENV) is flagged too — the OS would resolve
  // them to the same secret file the lowercase comparands target.
  const f = path.replace(/\\/g, "/").toLowerCase();
  return f === ".env" || f.startsWith(".env.") || f.endsWith(".env");
}

interface ClassifiedStrays {
  tracked: string[];
  untracked: string[];
  dangerousByPath: string[];
}

// Classify every changed path: apply the run-target predicate (e2e allowlist or
// code denylist), split by tracked vs. untracked (XY `??`), and flag dangerous paths.
export function classifyStrays(changes: ParsedChange[], isCode: boolean): ClassifiedStrays {
  const isStray = isCode ? isCodeDenied : isE2eStray;
  const tracked: string[] = [];
  const untracked: string[] = [];
  const dangerousByPath: string[] = [];

  for (const { xy, path } of changes) {
    if (!isStray(path)) continue;
    if (xy === "??") {
      untracked.push(path);
    } else {
      tracked.push(path);
    }
    if (isDangerousPath(path)) dangerousByPath.push(path);
  }

  return { tracked, untracked, dangerousByPath };
}

// ── EFFECTFUL (injected Git + fs.realpathSync + fs.lstatSync) ──────────────────

// Detect + revert agent writes outside the allowed area.
//
// Steps:
//   1. git status --porcelain → parse
//   2. classifyStrays against the target-specific predicate
//   3. symlink/path-escape check (BOTH targets): any changed path that is a symlink whose
//      realpath resolves OUTSIDE mirrorDir is escalated to dangerous (and reverted). It runs for
//      code-target too: publishCode stages `.`, so an escaping symlink would otherwise be committed.
//   4. revert:
//        tracked → `git restore --staged --worktree --source=HEAD -- <paths>` (staged-aware: this
//          unstages AND restores from HEAD, so a STAGED-new stray — A /M /R after publishCode's
//          `git add .` — is actually removed; `git checkout --` alone restored from the INDEX and
//          left a staged-new file to be committed).
//        untracked → `git clean -f -- <paths>` (restore --source=HEAD errors on an untracked path,
//          so the two buckets stay strictly separate — never pass `??` paths to restore).
//      Skips the git call when the array is empty. Never swallows git errors (they THROW).
//   5. return { strays, dangerous, reverted }
export async function runConfinement(
  mirrorDir: string,
  isCode: boolean,
  deps: ConfineDeps,
): Promise<ConfinementResult> {
  const out = await deps.git(["status", "--porcelain", "--untracked-files=all"], mirrorDir);
  const changes = parseStatusOutput(out);
  const { tracked, untracked, dangerousByPath } = classifyStrays(changes, isCode);

  // Symlink / path-escape check (BOTH targets): a symlink whose realpath resolves outside
  // mirrorDir would let the agent write anywhere on the host. For e2e-target only the `e2e/`
  // area matters (everything else is already a stray); for code-target any escaping symlink is
  // dangerous (publishCode stages `.`). lstat is a cheap pre-filter so an ordinary file never
  // pays the full realpath resolution.
  const escapes: string[] = [];
  const mirrorReal = deps.realpath(mirrorDir) + sep;
  for (const { xy, path } of changes) {
    // e2e-target restricts the escape scan to the in-area paths (out-of-area paths are already
    // strays handled above); code-target scans every changed path.
    if (!isCode && path !== "e2e" && !path.startsWith("e2e/")) continue;
    let resolved: string;
    try {
      // Cheap pre-filter: only a real symlink can escape via resolution, so skip realpath for
      // ordinary files. lstat/realpath can throw when the path was deleted — not an escape, skip.
      if (!deps.isSymlink(join(mirrorDir, path))) continue;
      resolved = deps.realpath(join(mirrorDir, path));
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
    await deps.git(["restore", "--staged", "--worktree", "--source=HEAD", "--", ...tracked], mirrorDir);
  }
  // Revert untracked strays (git clean -f removes the unversioned file).
  if (untracked.length > 0) {
    await deps.git(["clean", "-f", "--", ...untracked], mirrorDir);
  }

  return {
    strays: tracked.length + untracked.length,
    // Dedup: a path can be BOTH a denylist secret (dangerousByPath) and an escaping symlink
    // (escapes); a plain sum would count it twice. The Set collapses the overlap to one.
    dangerous: new Set([...dangerousByPath, ...escapes]).size,
    reverted: [...tracked, ...untracked],
  };
}
