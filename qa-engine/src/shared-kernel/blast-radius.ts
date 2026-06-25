// NEW kernel concept: the set of files a commit changed, keyed by its Sha — the unit the analyze and
// coverage phases reason over. Promoted from the bare diff/changed-files strings that flowed
// untyped through the legacy pipeline. Immutable, deterministic identity (deduped + sorted).

import { Sha } from "./sha.ts";

export class BlastRadius {
  private constructor(readonly sha: Sha, readonly changedFiles: readonly string[]) {}

  static of(sha: Sha, changedFiles: readonly string[]): BlastRadius {
    const normalized = Object.freeze([...new Set(changedFiles)].sort());
    return new BlastRadius(sha, normalized);
  }

  get isEmpty(): boolean {
    return this.changedFiles.length === 0;
  }
}
