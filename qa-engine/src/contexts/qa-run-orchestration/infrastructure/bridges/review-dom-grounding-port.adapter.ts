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

  async capture(specDir: string, specs: readonly string[], _signal?: AbortSignal): Promise<string | undefined> {
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
    return capture(
      { e2eDir: this.ctx.e2eDir, baseUrl: this.ctx.baseUrl, specContents, testIdAttribute: this.ctx.testIdAttribute },
      deps,
    ).catch(() => undefined);
  }
}
