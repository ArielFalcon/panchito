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
