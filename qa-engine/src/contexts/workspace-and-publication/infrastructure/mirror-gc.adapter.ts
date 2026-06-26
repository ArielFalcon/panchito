// src/contexts/workspace-and-publication/infrastructure/mirror-gc.adapter.ts
// Implements MirrorGcPort.prune by delegating to an injected gc fn, keeping the mirror working
// copies lean (orphaned object packs accumulate over time — `git gc` compacts them). The gc fn
// is injected so the adapter test needs no git binary. Errors from the gc fn propagate loudly —
// a failed GC is surfaced, not swallowed (the sequential queue never masks an infra fault).
// Plan-6 wiring injects: (dir) => realGit(["gc", "--auto", "--quiet"], dir).
import type { MirrorGcPort } from "../application/ports/index.ts";

type GcFn = (mirrorDir: string) => Promise<void>;

export class MirrorGcAdapter implements MirrorGcPort {
  constructor(private readonly gc: GcFn) {}

  async prune(mirrorDir: string): Promise<void> {
    await this.gc(mirrorDir);
  }
}
