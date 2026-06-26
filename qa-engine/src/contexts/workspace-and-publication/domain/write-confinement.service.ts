// Pure confinement classifiers lifted from src/qa/confinement.ts — copy+parity.
// Lifts parseStatusOutput, isE2eStray, isCodeDenied, isDangerousPath, classifyStrays
// (all pure, no I/O) into a domain service. The effectful runConfinement stays in the
// VcsWrite adapter wiring (Plan 6); this class is fully unit-testable without git.
//
// PARITY: every method body is copied VERBATIM from confinement.ts. The parity test
// (write-confinement-parity.test.ts) pins the copy to the legacy originals until Plan 7
// deletes them. Do NOT "improve" the logic here — the parity test is the guard.

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
}

export interface ClassifiedStrays {
  tracked: string[];
  untracked: string[];
  dangerousByPath: string[];
}

export class WriteConfinementService {
  // Parse `git status --porcelain --untracked-files=all` output into typed records.
  // Handles: 2-char XY status codes; rename/copy lines `R  old -> new` (takes new path);
  // git-quoted paths with spaces/unicode (core.quotePath — strips surrounding `"`).
  // VERBATIM from confinement.ts parseStatusOutput.
  parseStatusOutput(out: string): ParsedChange[] {
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
  // VERBATIM from confinement.ts classifyStrays.
  classifyStrays(changes: ParsedChange[], isCode: boolean): ClassifiedStrays {
    const isStray = isCode ? this.isCodeDenied.bind(this) : this.isE2eStray.bind(this);
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
      if (this.isDangerousPath(path)) dangerousByPath.push(path);
    }

    return { tracked, untracked, dangerousByPath };
  }
}
