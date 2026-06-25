// qa-engine/src/shared-kernel/sha.ts
// A git commit SHA as a value object: hex, at least 7 chars (the conventional abbreviation floor),
// validated once at construction so the rest of the domain treats it as already-correct. Replaces
// the bare `sha: string` that flowed unchecked through the legacy pipeline.

const HEX_SHA = /^[0-9a-f]{7,40}$/;

export class Sha {
  private constructor(readonly value: string) {}

  static of(raw: string): Sha {
    const v = raw.trim().toLowerCase();
    if (!HEX_SHA.test(v)) {
      throw new Error(`Sha: not a valid commit sha (expected 7-40 hex chars): ${JSON.stringify(raw)}`);
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
