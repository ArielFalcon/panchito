// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/pre-generation-grounding-port.adapter.ts
// Bridge: PreGenerationGroundingPort -> the REAL context-pack build (generation/infrastructure's
// buildContextPack) + a filesystem enumeration of the suite's existing spec files. THIN — no new
// policy: this bridge only wraps ALREADY-PORTED generation/infrastructure primitives (dom-snapshot.ts
// / context-pack.ts, Plan 7.4a/7.4b) and the leaf `node:fs` enumeration, mirroring legacy's own
// Seam b closure VERBATIM (src/pipeline.ts:1848-1872's globSpecs).
//
// Explorer pass NOT wired here (out of this bridge's scope — see PreGenerationGroundingPort's own
// header): no ExplorationBrief is threaded, so buildContextPack's `brief` input stays undefined and
// its DOM/blast-radius components degrade to whatever the (optional) contextMap/prChangedFiles
// inputs alone can produce — the SAME graceful degradation legacy documents for "explorer disabled"
// (pipeline.ts:2073's "The explorer is best-effort: failure -> no brief -> pack degrades to DOM+
// contracts"). A future bridge can widen this collaborator set to also run the explorer pass without
// touching RunQaUseCase or the port contract.
//
// Fail-open (mirrors legacy's own non-blocking try/catch at both call sites, pipeline.ts:2084-2101 +
// :2104-2137, and the Seam b try/catch at :1849-1872): every collaborator call is wrapped so a
// throw here NEVER propagates — ground() always resolves, never rejects.
import type { PreGenerationGroundingPort, GroundingResult } from "../../application/ports/index.ts";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildContextPack, defaultContextPackDeps } from "@contexts/generation/infrastructure/context-pack.ts";
import type { ContextPackDeps } from "@contexts/generation/infrastructure/context-pack.ts";
import type { ArchitectureContext } from "@contexts/generation/application/ports/generation-ports.ts";

export interface PreGenerationGroundingStaticContext {
  e2eDir: string; // absolute path to the seeded e2e project (mirrors legacy's own `e2eDir`)
  baseUrl?: string; // live DEV base URL — absent -> the pack's DOM component is skipped
  testIdAttribute?: string; // config-declared convention (e.g. "data-cy") — forwarded to DOM capture
  contextMap?: ArchitectureContext; // the FE<->BE architecture map (context.json), if loaded
  prChangedFiles?: string[]; // union of changed files, for contract filtering
}

export interface PreGenerationGroundingCollaborators {
  // Optional overrides — default to the real generation/infrastructure primitives. Injectable for
  // testing (existence-level: this bridge is exercised without a real Playwright/browser).
  buildContextPack?: typeof buildContextPack;
  contextPackDeps?: ContextPackDeps;
}

// Enumerate every "*.spec.ts" under `dir`, recursively, returning paths RELATIVE to `dir` — a
// faithful port of legacy's globSpecs closure (src/pipeline.ts:1852-1866). Graceful: a missing
// directory or a read error yields [] (the caller decides whether [] means "omit the field").
export function enumerateExistingSpecFiles(dir: string): string[] {
  let results: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory()) {
          results = results.concat(
            enumerateExistingSpecFiles(full).map((rel) => join(entry, rel)),
          );
        } else if (entry.endsWith(".spec.ts")) {
          results.push(entry);
        }
      } catch {
        // A single entry failing stat (race, permissions) is skipped — never aborts the whole scan.
      }
    }
  } catch {
    // Graceful degradation: the directory may not exist yet (first run) — matches legacy exactly.
  }
  return results;
}

export class PreGenerationGroundingPortAdapter implements PreGenerationGroundingPort {
  constructor(
    private readonly ctx: PreGenerationGroundingStaticContext,
    private readonly collaborators: PreGenerationGroundingCollaborators = {},
  ) {}

  async ground(_specDir: string, _signal?: AbortSignal): Promise<GroundingResult> {
    const result: GroundingResult = {};

    // Seam b: enumerate existing specs BEFORE the pack build (mirrors legacy's own ordering —
    // both run before the first generate() call; order between them is not load-bearing).
    try {
      const found = enumerateExistingSpecFiles(this.ctx.e2eDir);
      if (found.length > 0) result.existingSpecFiles = found;
    } catch (err) {
      console.warn(`[qa] WARNING: existing-spec enumeration failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    }

    // Context pack: brief is intentionally undefined (explorer pass not wired at this bridge —
    // see this file's own header). Degrades to contextMap-only contract filtering + no DOM/blast
    // radius when no brief is present, matching buildContextPack's own documented fallback.
    try {
      const build = this.collaborators.buildContextPack ?? buildContextPack;
      const deps = this.collaborators.contextPackDeps ?? defaultContextPackDeps;
      const packResult = await build(
        {
          baseUrl: this.ctx.baseUrl,
          e2eDir: this.ctx.e2eDir,
          contextMap: this.ctx.contextMap,
          prChangedFiles: this.ctx.prChangedFiles,
          testIdAttribute: this.ctx.testIdAttribute,
        },
        deps,
      );
      if (packResult.text) result.contextPack = packResult.text;
    } catch (err) {
      console.warn(`[qa] WARNING: context-pack build FAILED (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    }

    return result;
  }
}
