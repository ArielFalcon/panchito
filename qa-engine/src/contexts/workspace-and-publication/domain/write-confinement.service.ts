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
    // Strip the surrounding C-style quotes git adds (core.quotePath, ON by default) AND fully
    // decode the C-style escaping inside them — NOT just the outer quotes. Under the default
    // core.quotePath=true, git octal-escapes every non-ASCII byte (`café.spec.ts` ->
    // `"caf\303\251.spec.ts"`) and backslash-escapes an embedded literal `"` or `\` in the name
    // itself. Leaving those escapes undecoded means the returned path string is NOT the real
    // on-disk path — a revert built from it (`git clean -f --`, `git restore -- ...`) then matches
    // NOTHING, and enforce() silently reports the stray as reverted while the file survives on
    // disk (Judgment Day round 3, CRITICAL: silent confinement-bypass on any accented filename).
    // Decode by accumulating raw BYTES: `\NNN` contributes an octal byte, `\"`/`\\`/`\t`/`\n`/`\r`/
    // etc. their single-byte meaning, and a literal (unescaped) character contributes its REAL
    // UTF-8 bytes (code-point-safe — a surrogate pair is consumed as ONE unit so an astral/4-byte
    // character isn't split into two invalid lone-surrogate pushes). Interpreting the accumulated
    // byte sequence as UTF-8 mirrors what git itself does when writing the octal escapes, so
    // multi-byte UTF-8 sequences reconstruct correctly whether they arrive octal-escaped (the
    // default `core.quotePath=true`) OR literal inside the quotes (`core.quotePath=false` still
    // C-style-quotes a path for other reasons — e.g. an embedded space — but leaves non-ASCII bytes
    // literal). Judgment Day round 4: the literal branch used to push `ch.charCodeAt(0)` — a raw
    // UTF-16 code unit treated as one byte, invalid standalone UTF-8 for any non-ASCII character —
    // which silently corrupted the decoded path into the same class of revert-matches-nothing bug
    // round 3 fixed for the octal-escape path.
    const SIMPLE_ESCAPES: Record<string, number> = {
      '"': 0x22,
      "\\": 0x5c,
      a: 0x07,
      b: 0x08,
      f: 0x0c,
      n: 0x0a,
      r: 0x0d,
      t: 0x09,
      v: 0x0b,
    };
    const decodeQuoted = (inner: string): string => {
      const bytes: number[] = [];
      for (let i = 0; i < inner.length; i++) {
        const ch = inner[i] ?? "";
        if (ch !== "\\") {
          // Literal (unescaped) character — encode its REAL UTF-8 bytes, not the raw UTF-16 code
          // unit. `codePointAt` combines a high+low surrogate pair into the single astral code
          // point it represents, so a 4-byte character (e.g. an emoji) is consumed as ONE unit —
          // pushing per-UTF-16-unit would split it into two lone surrogates, each invalid on its
          // own. Advance the extra index when a pair was consumed.
          const codePoint = inner.codePointAt(i) as number;
          bytes.push(...Buffer.from(String.fromCodePoint(codePoint), "utf8"));
          if (codePoint > 0xffff) i += 1;
          continue;
        }
        const octal = inner.slice(i + 1, i + 4);
        if (/^[0-7]{3}$/.test(octal)) {
          bytes.push(Number.parseInt(octal, 8));
          i += 3;
          continue;
        }
        const next = inner[i + 1];
        if (next !== undefined && next in SIMPLE_ESCAPES) {
          bytes.push(SIMPLE_ESCAPES[next] as number);
          i += 1;
          continue;
        }
        // Unrecognized escape shape — no known git C-style-quoting escape starts this way. Fail
        // LOUDLY (CLAUDE.md invariant "surface integration errors loudly — never swallow errors
        // into an empty/degraded result") instead of silently keeping the bare backslash, which
        // would hand a corrupted path to the revert git calls and reproduce the same
        // revert-matches-nothing silent bypass this function exists to prevent. enforce()'s caller
        // (RunQaUseCase's enforceConfinement wrapper) already catches, logs loudly, and records
        // this in gateSignals — a throw here is fault-isolated, never a run crash.
        throw new Error(
          `decodeQuoted: unrecognized escape sequence starting at ${JSON.stringify(inner.slice(i, i + 4))} in quoted path segment ${JSON.stringify(inner)}`,
        );
      }
      return Buffer.from(bytes).toString("utf8");
    };
    const stripQuotes = (p: string): string =>
      p.startsWith('"') && p.endsWith('"') ? decodeQuoted(p.slice(1, -1)) : p;
    // Quote-aware arrow-split index: a plain `rest.indexOf(" -> ")` first-match breaks when the
    // OLD path is itself C-style-quoted (git quotes it whenever it literally contains " -> ", to
    // disambiguate from the rename separator) AND that quoted path also contains " -> " — the
    // naive search would split inside the quoted span instead of at the real separator after it.
    // When `rest` opens with a quote, scan for its matching unescaped closing quote first (git's
    // C-style quoting backslash-escapes embedded `"` and `\`), then require the arrow immediately
    // after it; any other shape falls back to the plain search.
    const findArrowSplit = (rest: string): number => {
      if (rest[0] === '"') {
        let i = 1;
        while (i < rest.length) {
          if (rest[i] === "\\") {
            i += 2;
            continue;
          }
          if (rest[i] === '"') break;
          i++;
        }
        if (i < rest.length && rest.startsWith(" -> ", i + 1)) return i + 1;
      }
      return rest.indexOf(" -> ");
    };
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
          const arrowIdx = findArrowSplit(rest);
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

  // The paths that must be reverted TOGETHER as a single unit for a change, given its optional
  // rename counterpart — shared by classifyStrays and the adapter's own escape-scan
  // (write-confinement.adapter.ts) so the two mechanisms cannot drift apart again. Judgment Day
  // round 2: the escape-scan loop destructured only `{ xy, path }`, dropping renameCounterpart —
  // an escape-detected path that was one side of a staged rename got reverted alone, orphaning the
  // other side's staged half exactly like the round-1 rename-over-revert bug this method already
  // fixes for classifyStrays.
  revertUnit(path: string, renameCounterpart?: string): string[] {
    return renameCounterpart !== undefined ? [path, renameCounterpart] : [path];
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
  //
  // KNOWN LIMITATION (Judgment Day round 2, pre-existing, legacy-parity): this pairing relies on
  // git's own R/C rename DETECTION, which only fires for a STAGED move. The agent has no git access
  // (read-only on watched repos), so its file moves surface as two INDEPENDENT lines — an in-area
  // unstaged deletion (` D e2e/old.spec.ts`) plus an out-of-area untracked stray (`?? stray.spec.ts`)
  // — with no renameCounterpart to pair them. The out-of-area stray IS still cleaned by the untracked
  // path below (content destroyed, correct), but the in-area unstaged deletion is NOT restored here:
  // unconditionally reverting every in-area unstaged deletion would over-revert a legitimate agent
  // deletion (e.g. exhaustive mode deliberately deletes stale specs) — pairing without git's own
  // rename detection is guesswork. Deferred as a Phase 2 DESIGN item (see the decisions doc's
  // Judgment Day round 2 register): content-similarity pairing, restore-then-let-reviewer-arbitrate,
  // or publish-time deletion review are the candidate approaches, not decided here.
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
          for (const p of this.revertUnit(path, renameCounterpart)) {
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
