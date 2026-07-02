// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/review-dom-grounding-port.adapter.ts
// Bridge: ReviewDomGroundingPort -> the REAL captureDom (generation/infrastructure/dom-snapshot.ts,
// Plan 7.4a). THIN — no new policy: mirrors legacy's reviewGenerated() captureDom call VERBATIM
// (src/pipeline.ts:1643-1651 — read each spec's current on-disk text, then captureDom(...) against
// the live DEV baseUrl). captureDom itself already extracts the `.goto(...)` routes from the spec
// text, renders them, and formats the snapshot — this bridge's only job is resolving specDir + spec
// names into file contents (the "adapter resolves its own paths" precedent PreExecGroundingPort /
// SetupPort already established) and forwarding to it.
//
// Fail-open (mirrors legacy's own `.catch(() => undefined)` at the SAME call site exactly):
// captureDom already swallows a render failure into `undefined` with its own console.warn
// (dom-snapshot.ts's own header) — this bridge adds NO further try/catch narrowing beyond a
// defensive backstop so a spec-read failure (an unreadable file) also degrades to undefined rather
// than throwing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewDomGroundingPort } from "../../application/ports/index.ts";
import { captureDom, defaultCaptureDomDeps } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import type { CaptureDomDeps } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import { raceWithAbort } from "./abort-race.ts";

export interface ReviewDomGroundingStaticContext {
  e2eDir: string; // absolute path to the seeded e2e project (mirrors CaptureDomInput.e2eDir)
  baseUrl?: string; // live DEV base URL — absent -> capture() always resolves undefined
  testIdAttribute?: string; // config-declared convention (e.g. "data-cy")
}

export interface ReviewDomGroundingCollaborators {
  captureDom?: typeof captureDom;
  captureDomDeps?: CaptureDomDeps;
}

export class ReviewDomGroundingPortAdapter implements ReviewDomGroundingPort {
  constructor(
    private readonly ctx: ReviewDomGroundingStaticContext,
    private readonly collaborators: ReviewDomGroundingCollaborators = {},
  ) {}

  async capture(specDir: string, specs: readonly string[], signal?: AbortSignal): Promise<string | undefined> {
    // Cheap, exact pre-check (FIX 1a, judgment-day W4 abort-plumbing): an already-aborted signal
    // skips the capture entirely — mirrors PreGenerationGroundingPortAdapter.ground()'s own
    // pre-check and the use-case's `if (signal?.aborted) return` posture at every phase boundary.
    if (signal?.aborted) return undefined;
    if (!this.ctx.baseUrl || specs.length === 0) return undefined;
    const specContents = specs.map((spec) => {
      try {
        return readFileSync(join(specDir, spec), "utf8");
      } catch {
        return ""; // an unreadable spec contributes no routes — mirrors legacy's own `catch { return ""; }`
      }
    });
    const capture = this.collaborators.captureDom ?? captureDom;
    const deps = this.collaborators.captureDomDeps ?? defaultCaptureDomDeps;
    const capturePromise = capture(
      { e2eDir: this.ctx.e2eDir, baseUrl: this.ctx.baseUrl, specContents, testIdAttribute: this.ctx.testIdAttribute },
      deps,
    );
    // FIX 1b (judgment-day W4 abort-plumbing): captureDom (dom-snapshot.ts) does NOT accept an
    // AbortSignal — same pre-existing legacy-parity gap as buildContextPack (see this file's own
    // header + abort-race.ts). Racing against the signal unblocks the caller promptly on cancel;
    // the in-flight render finishes on its own internal timeout in the background.
    //
    // Abort resolves undefined (never rejects) here — the port's OWN "must NEVER throw" contract
    // holds unconditionally (same posture as captureDom's own `.catch(() => undefined)`); it is
    // the use-case's own `if (signal?.aborted) return this.abortedResult()` check IMMEDIATELY
    // AFTER this call (run-qa.use-case.ts) that routes an abort to the ABORT path instead of the
    // degraded-ungrounded-continue path.
    try {
      return await (signal ? raceWithAbort(capturePromise, signal) : capturePromise);
    } catch {
      // Both an abort and any other capture failure degrade to undefined here (mirrors legacy's
      // own `.catch(() => undefined)` at this exact call site) — the use-case's post-call
      // signal?.aborted check is what distinguishes "aborted" from "ordinary grounding failure".
      return undefined;
    }
  }
}
