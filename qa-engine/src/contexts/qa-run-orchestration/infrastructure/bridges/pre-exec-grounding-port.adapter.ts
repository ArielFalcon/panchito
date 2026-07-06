// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/pre-exec-grounding-port.adapter.ts
// Bridge: PreExecGroundingPort -> the REAL captureRouteTrees (generation/infrastructure/
// dom-snapshot.ts, Plan 7.4a). THIN — no new policy: mirrors ReviewDomGroundingPortAdapter's own
// shape (this file's sibling) — resolve specDir into the CURRENT on-disk spec text, then forward to
// the already-ported capture primitive. captureRouteTrees itself already extracts each spec's
// `.goto(...)` routes, renders them, and returns the raw per-route RAW node lines (RouteSnapshot[])
// this bridge's own domain consumer (pre-exec-grounding.service.ts's checkPreExecGrounding /
// checkPersistingAmbiguity) needs — this bridge's only job is resolving specDir into spec sources +
// forwarding, plus the PreExecGroundingPort's own contract of returning BOTH `specSources` AND
// `routes` together (mirrors legacy's capturePreExecSnaps `{ specSources, snaps }` shape, per the
// port's own header doc, ports/index.ts:466-483).
//
// UNLIKE ReviewDomGroundingPortAdapter.capture(specDir, specs, signal) (which is handed an EXPLICIT
// spec list by its caller), PreExecGroundingPort.capture(specDir, signal) receives ONLY specDir — the
// port's own doc is explicit that "specDir is enough for the adapter to find + read the on-disk specs
// itself" (ports/index.ts:481-483). This bridge therefore ALSO owns enumerating which files under
// specDir are specs, reusing enumerateExistingSpecFiles VERBATIM (pre-generation-grounding-port.
// adapter.ts's own *.spec.ts recursive walk, already unit-tested there) rather than re-implementing a
// second copy — "reuse the leaf, don't re-port" (CLAUDE.md's own convention for this codebase).
//
// Re-reads specSources off disk on EVERY capture() call (never cached) — required so a re-invocation
// after a corrective regen (W1) sees the REWRITTEN specs, never a stale capture (the port's own doc,
// same file, "Re-reading specSources off disk on EVERY call... is required for the W2 persisting-
// ambiguity re-check to be meaningful").
//
// Fail-open (mirrors ReviewDomGroundingPortAdapter's own posture): an unreadable spec file
// contributes no routes/text rather than throwing (captureRouteTrees itself already degrades a
// render failure to [] with its own console.warn — dom-snapshot.ts's own header).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PreExecGroundingPort } from "../../application/ports/index.ts";
import { captureRouteTrees, defaultCaptureDomDeps } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import type { CaptureDomDeps } from "@contexts/generation/infrastructure/dom-snapshot.ts";
import { buildRouteCatalog } from "@contexts/generation/infrastructure/route-catalog.ts";
import { enumerateExistingSpecFiles } from "./pre-generation-grounding-port.adapter.ts";
import { raceWithAbort, isAbortError } from "./abort-race.ts";

// The port's own return shape for one captured route (ports/index.ts:485-494) — `nodes` REQUIRED
// (unlike RouteSnapshot.nodes?, which is optional pre-catalog), `status`/`settled`/`testIds` sourced
// from buildRouteCatalog (the Pillar-2 confidence derivation), not the raw capture. Local alias only
// (no cross-context import of the port's own inline type) to keep the mapping below self-describing.
type CapturedRoute = Awaited<ReturnType<PreExecGroundingPort["capture"]>>["routes"][number];

export interface PreExecGroundingStaticContext {
  e2eDir: string; // absolute path to the seeded e2e project (mirrors CaptureDomInput.e2eDir)
  baseUrl?: string; // live DEV base URL — absent -> captureRouteTrees always resolves []
  testIdAttribute?: string; // config-declared convention (e.g. "data-cy")
}

export interface PreExecGroundingCollaborators {
  // Optional overrides — default to the real generation/infrastructure primitives. Injectable for
  // testing (existence-level: this bridge is exercised without a real Playwright/browser), matching
  // PreGenerationGroundingCollaborators/ReviewDomGroundingCollaborators' own [SWAP] shape exactly.
  captureRouteTrees?: typeof captureRouteTrees;
  captureDomDeps?: CaptureDomDeps;
}

export class PreExecGroundingPortAdapter implements PreExecGroundingPort {
  constructor(
    private readonly ctx: PreExecGroundingStaticContext,
    private readonly collaborators: PreExecGroundingCollaborators = {},
  ) {}

  async capture(specDir: string, signal?: AbortSignal): Promise<{ specSources: string[]; routes: CapturedRoute[] }> {
    // Cheap, exact pre-check (mirrors PreGenerationGroundingPortAdapter.ground() / ReviewDom
    // GroundingPortAdapter.capture()'s own "already-aborted signal skips entirely" posture) — an
    // already-aborted signal skips BOTH the fs read and the capture call. The port's own contract
    // must NEVER throw (see below), so this resolves an empty result rather than reject.
    if (signal?.aborted) return { specSources: [], routes: [] };

    // Reads the CURRENT on-disk specs at specDir on EVERY call (never cached — see this file's own
    // header). enumerateExistingSpecFiles returns paths RELATIVE to specDir; each is read as the raw
    // spec TEXT the domain-service ambiguity/catalog checks extract selectors from (mirrors legacy's
    // own capturePreExecSnaps `specSources`, per the port's own doc).
    const specFiles = enumerateExistingSpecFiles(specDir);
    const specSources = specFiles.map((spec) => {
      try {
        return readFileSync(join(specDir, spec), "utf8");
      } catch {
        return ""; // an unreadable spec contributes no routes/text — mirrors ReviewDomGroundingPortAdapter's own `catch { return ""; }`
      }
    });

    if (specSources.length === 0 || !this.ctx.baseUrl) return { specSources, routes: [] };

    const capture = this.collaborators.captureRouteTrees ?? captureRouteTrees;
    const deps = this.collaborators.captureDomDeps ?? defaultCaptureDomDeps;
    const capturePromise = capture(
      { e2eDir: this.ctx.e2eDir, baseUrl: this.ctx.baseUrl, specContents: specSources, testIdAttribute: this.ctx.testIdAttribute },
      deps,
    );
    // captureRouteTrees (dom-snapshot.ts) does NOT accept an AbortSignal — the SAME pre-existing
    // legacy-parity gap buildContextPack/captureDom carry (see abort-race.ts's own header). Racing
    // against the signal unblocks the caller promptly on cancel; the in-flight render keeps running
    // to its own internal timeout in the background (harmless — its result is discarded here).
    //
    // The port's own contract must NEVER throw (mirrors PreGenerationGroundingPort/
    // ReviewDomGroundingPort's own "must NEVER throw" posture) — abort resolves the specSources
    // already read but an empty routes[], never rejects. It is the use-case's own
    // `if (signal?.aborted) return this.abortedResult()` check IMMEDIATELY AFTER this call
    // (run-qa.use-case.ts) that routes an abort to the ABORT path, not this adapter.
    try {
      const snapshots = await (signal ? raceWithAbort(capturePromise, signal) : capturePromise);
      // Adapt the raw RouteSnapshot[] into the port's CapturedRoute shape: `nodes` defaults to []
      // (RouteSnapshot.nodes is optional pre-catalog; the port requires it), `status`/`settled`/
      // `testIds` are sourced from buildRouteCatalog (the Pillar-2 confidence derivation this port's
      // own doc names — "A real adapter... wraps generation/infrastructure's captureRouteTrees +
      // buildRouteCatalog", ports/index.ts:479-480), never the raw capture fields directly.
      const routes: CapturedRoute[] = snapshots.map((snap) => {
        const catalog = buildRouteCatalog(snap);
        return {
          route: catalog.route,
          nodes: snap.nodes ?? [],
          status: catalog.status,
          settled: catalog.settled,
          testIds: catalog.testIds,
        };
      });
      return { specSources, routes };
    } catch (err) {
      if (isAbortError(err)) return { specSources, routes: [] };
      // captureRouteTrees itself already degrades a render failure to [] with its own console.warn
      // (dom-snapshot.ts's own header) — this catch is a defensive backstop only, matching
      // ReviewDomGroundingPortAdapter's own posture of never letting ANY throw escape this bridge.
      console.warn(`[qa] WARNING: pre-exec route capture FAILED (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      return { specSources, routes: [] };
    }
  }
}
