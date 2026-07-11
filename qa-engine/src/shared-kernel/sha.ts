// qa-engine/src/shared-kernel/sha.ts
// A git commit SHA as a value object: hex, validated once at construction so the rest of the domain
// treats it as already-correct. Replaces the bare `sha: string` that flowed unchecked through the
// legacy pipeline.
//
// Length range = a git object name: 4 (git's minimum abbreviation, `core.abbrev`) to 40 (full
// SHA-1). runPipeline treats the sha as an opaque passthrough tag (namespace / log / publish; no
// branch reads its digits), and every real sha is >= 7, so the floor carries no behavioral weight
// for real inputs — the range only rejects non-hex / empty / over-long garbage at the boundary. Sha
// is value-constructed from real shas in blast-radius.ts + git-mirror-read.adapter.ts (elsewhere a
// type import); the 4-char floor is behavior-neutral for them.

const HEX_SHA = /^[0-9a-f]{4,40}$/;

export class Sha {
  private constructor(readonly value: string) {}

  static of(raw: string): Sha {
    const v = raw.trim().toLowerCase();
    if (!HEX_SHA.test(v)) {
      throw new Error(`Sha: not a valid commit sha (expected 4-40 hex chars): ${JSON.stringify(raw)}`);
    }
    return new Sha(v);
  }

  static tryOf(raw: string): Sha | null {
    const v = raw.trim().toLowerCase();
    return HEX_SHA.test(v) ? new Sha(v) : null;
  }

  get short(): string {
    return this.value.slice(0, 7);
  }

  equals(other: Sha): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}

// DEV's /version may report a SHORT SHA (the 7-char form from Vercel/`git
// rev-parse --short`/`$GITHUB_SHA`) while the trigger carries the full 40-char SHA
// (or vice versa). Match when equal, or when one is a >=7-char prefix of the other,
// case-insensitive. The 7-char floor avoids accidental weak matches on tiny prefixes.
//
// Relocated verbatim from src/env/deploy-gate.ts (migration-tier-3, Decision 2). Kept as a
// raw string-in free function rather than a Sha-typed method — callers pass untrusted,
// possibly-short strings (e.g. v?.sha from an unvalidated version-poll response), and forcing
// them through Sha.of/tryOf would change behavior at the boundary.
export function shaMatches(a: string | undefined, b: string | undefined): boolean {
  const x = (a ?? "").toLowerCase();
  const y = (b ?? "").toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 7 && y.startsWith(x)) return true;
  if (y.length >= 7 && x.startsWith(y)) return true;
  return false;
}
