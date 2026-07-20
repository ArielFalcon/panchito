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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildContextPack, defaultContextPackDeps } from "@contexts/generation/infrastructure/context-pack.ts";
import type { ContextPackDeps } from "@contexts/generation/infrastructure/context-pack.ts";
import type { ArchitectureContext } from "@contexts/generation/application/ports/generation-ports.ts";
import { readManifest } from "@contexts/generation/infrastructure/manifest-fs.ts";
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";
import { raceWithAbort, isAbortError } from "./abort-race.ts";

// WS5.3 (full-flow remediation, option c): pure, deterministic, no I/O — a single instance is safe
// to share across every ground() call (DiffParserService carries no state between calls).
const diffParser = new DiffParserService();

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
  // sdd/migration-wiring-phase-2 Slice 3 (D-C contextMap read-back): defaults to
  // loadContextMapFromDisk (below) — a real fs+JSON.parse+form-validate read of
  // `${specDir}/.qa/context.json`. Overridable for tests; [SWAP]-style: an omitted collaborator
  // still resolves to the REAL production fn (`this.collaborators.loadContextMap ??
  // loadContextMapFromDisk`), the SAME posture buildContextPack above already establishes — so
  // CompositionConfig.groundingCollaborators stays `{}` in production, unaffected by this field.
  loadContextMap?: (specDir: string) => ArchitectureContext | undefined;
}

// sdd/migration-wiring-phase-2 Slice 3 (D-C contextMap read-back): a minimal, faithful structural
// port of src/qa/context.ts's validateContext() — SAME rules (routes/api/feBe well-formed, every
// feBe link resolves to a declared route + operationId) — re-implemented natively here because
// qa-engine may not import from src/ (this file's own ArchitectureContext import already follows
// generation-ports.ts's "faithful structural alias" precedent for this exact type family). Only the
// FORM is validated (internal consistency), never truth against the code — mirrors src/qa/context.ts's
// own documented safety argument: a stale/incomplete map only degrades recall, never precision.
function isValidArchitectureContext(raw: unknown): raw is ArchitectureContext {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const c = raw as Partial<ArchitectureContext>;
  if (typeof c.builtAtSha !== "string" || c.builtAtSha.trim().length === 0) return false;
  if (!Array.isArray(c.routes) || !Array.isArray(c.api) || !Array.isArray(c.feBe)) return false;

  const routePaths = new Set<string>();
  for (const entry of c.routes) {
    const path = (entry as { path?: unknown } | undefined)?.path;
    if (typeof path !== "string" || path.trim().length === 0) return false;
    if (routePaths.has(path)) return false; // duplicate path
    routePaths.add(path);
  }

  const opIds = new Set<string>();
  for (const entry of c.api) {
    const o = entry as { operationId?: unknown; method?: unknown; path?: unknown } | undefined;
    if (typeof o?.operationId !== "string" || o.operationId.trim().length === 0) return false;
    if (opIds.has(o.operationId)) return false; // duplicate operationId
    opIds.add(o.operationId);
    if (typeof o?.method !== "string" || o.method.trim().length === 0) return false;
    if (typeof o?.path !== "string" || o.path.trim().length === 0) return false;
  }

  for (const entry of c.feBe) {
    const l = entry as { route?: unknown; operationId?: unknown } | undefined;
    if (typeof l?.route !== "string" || !routePaths.has(l.route)) return false;
    if (typeof l?.operationId !== "string" || !opIds.has(l.operationId)) return false;
  }

  if (c.flows !== undefined && !Array.isArray(c.flows)) return false;

  return true;
}

// sdd/migration-wiring-phase-2 Slice 3 (D-C contextMap read-back): a faithful port of the deleted
// legacy pipeline's loadContextMap() closure (src/pipeline.ts:1307-1320, preserved in git history at
// 1228ea7^) — reads `${specDir}/.qa/context.json`, form-validates it, and returns the parsed map when
// valid. Graceful at every failure mode: a missing file, malformed JSON, or a form-invalid map all
// degrade to `undefined` (never throw) — the caller falls back to whatever static ctx.contextMap it
// already had (always absent in production today, per rewritten-engine-factory.ts's own documented
// gap), identical to today's always-absent behavior. Never a crash, never a fabricated partial map.
export function loadContextMapFromDisk(specDir: string): ArchitectureContext | undefined {
  const ctxJsonPath = join(specDir, ".qa", "context.json");
  let raw: string;
  try {
    raw = readFileSync(ctxJsonPath, "utf8");
  } catch {
    return undefined; // no committed context.json for this run (first run, or app never ran context mode) — graceful.
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isValidArchitectureContext(parsed)) {
      console.warn(`[qa] WARNING: ${ctxJsonPath} exists but failed form-validation; contextMap stays absent this run (contracts component degrades gracefully).`);
      return undefined;
    }
    return parsed;
  } catch (err) {
    console.warn(`[qa] WARNING: could not parse ${ctxJsonPath} (non-blocking, contextMap stays absent this run): ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
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

  // WS5.3 (full-flow remediation, option c): `diff` is an OPTIONAL third arg — the adapter's static
  // context is built ONCE at composition time (before any run's diff is known), so the run's ACTUAL
  // diff must be threaded through this call instead. The use-case has classificationDiff in scope at
  // the grounding call site (diff mode only — non-diff modes never classify, so this stays absent
  // there, matching every other diff-mode-only enrichment). Absent -> changedElements stays absent,
  // byte-identical to before this field existed.
  //
  // sdd/migration-wiring-phase-2 Slice 3 (D-C contextMap read-back): `specDir` is no longer ignored —
  // it is the run's REAL per-run workspace.specDir (run-qa.use-case.ts's own call site), used below
  // to read `${specDir}/.qa/context.json` fresh on every run instead of relying solely on the static
  // ctx.contextMap (which stays permanently absent in production).
  async ground(specDir: string, signal?: AbortSignal, diff?: string): Promise<GroundingResult> {
    // Cheap, exact pre-check (FIX 1a, judgment-day W4 abort-plumbing): an already-aborted signal
    // skips BOTH collaborator calls entirely — no point starting a capture/build the caller has
    // already given up on. Mirrors the use-case's own `if (signal?.aborted) return` posture at
    // every other phase boundary (run-qa.use-case.ts).
    if (signal?.aborted) return {};

    const result: GroundingResult = {};

    // sdd/migration-wiring-phase-2 Slice 3 (D-C contextMap read-back): per-run read takes priority
    // over the static ctx value when present; a missing/invalid file (or a throwing collaborator)
    // degrades to the static ctx.contextMap (always undefined in production today), identical to
    // today's always-absent behavior — never a crash. [SWAP]: an omitted collaborator still resolves
    // to the REAL production fn, mirroring buildContextPack's own default-resolution posture above.
    let contextMap = this.ctx.contextMap;
    try {
      const loadContextMap = this.collaborators.loadContextMap ?? loadContextMapFromDisk;
      const loaded = loadContextMap(specDir);
      if (loaded) contextMap = loaded;
    } catch (err) {
      console.warn(`[qa] WARNING: contextMap read-back failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    }

    // Seam b: enumerate existing specs BEFORE the pack build (mirrors legacy's own ordering —
    // both run before the first generate() call; order between them is not load-bearing).
    try {
      const found = enumerateExistingSpecFiles(this.ctx.e2eDir);
      if (found.length > 0) {
        // WS5.5(c): enrich each entry with its flow/objective from e2e/.qa/manifest.json when a
        // matching entry exists — dedup-by-filename-alone invites duplicate flows as the suite
        // grows; the manifest already carries this metadata (ManifestRepositoryPort.reconcile()
        // writes it after every generation) and it is already trusted (the static gate validates
        // against the SAME schema). existingSpecFiles stays a plain string[] (its shape is pinned
        // by the generation-ports-parity AssertNever gate against the legacy opencode-client.ts
        // mirror — a new typed field is out of this bridge's reach), so the metadata is folded
        // INTO the string: "path — flow: X, objective: Y" when a manifest entry's `file` matches,
        // plain "path" otherwise (no manifest, or no matching entry — never fabricated).
        let byFile = new Map<string, { flow: string; objective: string }>();
        try {
          const entries = await readManifest(this.ctx.e2eDir);
          // migration-tier-4b Slice 2: `file` is now OPTIONAL on the canonical ManifestEntry (a
          // pre-4b/hand-edited entry may lack it) — a type-predicate filter is required so `e.file`
          // narrows from `string | undefined` to `string` for the Map key below.
          byFile = new Map(
            entries
              .filter((e): e is typeof e & { file: string } => Boolean(e.file))
              .map((e) => [e.file, { flow: e.flow, objective: e.objective }]),
          );
        } catch (err) {
          console.warn(`[qa] WARNING: manifest read failed (non-blocking, existingSpecFiles stays plain): ${err instanceof Error ? err.message : String(err)}`);
        }
        result.existingSpecFiles = found.map((f) => {
          const meta = byFile.get(f);
          return meta ? `${f} — flow: ${meta.flow}, objective: ${meta.objective}` : f;
        });
      }
    } catch (err) {
      console.warn(`[qa] WARNING: existing-spec enumeration failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    }

    // Context pack: brief is intentionally undefined (explorer pass not wired at this bridge —
    // see this file's own header). Degrades to contextMap-only contract filtering + no DOM/blast
    // radius when no brief is present, matching buildContextPack's own documented fallback.
    //
    // FIX 1b (judgment-day W4 abort-plumbing): buildContextPack (context-pack.ts) does NOT accept
    // an AbortSignal — a pre-existing legacy-parity gap (the underlying Playwright render has its
    // own internal ~200s cap but no cooperative cancellation). Racing the build against an abort
    // listener unblocks the RUN's control flow promptly on cancel; the in-flight render keeps
    // running to its own timeout in the background (harmless — its result is discarded here).
    // Killing the spawn tree from this adapter would reach into dom-snapshot.ts's shared render
    // internals — tracked as a follow-up, not done here (see this file's own docs).
    //
    // Abort resolves (never rejects) here — the port's OWN "must NEVER throw" contract holds
    // unconditionally; it is the use-case's own `if (signal?.aborted) return this.abortedResult()`
    // check IMMEDIATELY AFTER this call (run-qa.use-case.ts) that routes an abort to the ABORT
    // path instead of the degraded-ungrounded-continue path — coherent with how it already treats
    // every other phase boundary.
    try {
      const build = this.collaborators.buildContextPack ?? buildContextPack;
      const deps = this.collaborators.contextPackDeps ?? defaultContextPackDeps;
      // WS5.3 (option c): deterministic route feed — contextMap.routes is built ONCE by the
      // context-mode LLM pass and persisted to context.json; every diff-mode run afterward reuses it
      // here with ZERO further LLM cost. No brief required (the explorer pass stays unwired).
      // sdd/migration-wiring-phase-2 Slice 3: `contextMap` here is the per-run-read-or-static-ctx
      // value resolved above, not the raw static ctx field directly.
      const deterministicRoutes = contextMap?.routes?.length
        ? contextMap.routes.map((r) => r.path).filter(Boolean)
        : undefined;
      // WS5.3: [CHANGED] markers — pure, deterministic extraction from the run's actual diff (no
      // LLM). Absent when no diff was threaded (non-diff modes, or the caller omitted it).
      const changedElements = diff ? diffParser.changedElements(diff) : undefined;
      const buildPromise = build(
        {
          baseUrl: this.ctx.baseUrl,
          e2eDir: this.ctx.e2eDir,
          contextMap,
          prChangedFiles: this.ctx.prChangedFiles,
          testIdAttribute: this.ctx.testIdAttribute,
          ...(deterministicRoutes?.length ? { routes: deterministicRoutes } : {}),
          ...(changedElements?.length ? { changedElements } : {}),
        },
        deps,
      );
      const packResult = signal ? await raceWithAbort(buildPromise, signal) : await buildPromise;
      if (packResult.text) result.contextPack = packResult.text;
    } catch (err) {
      if (isAbortError(err)) return result; // abort: return whatever was gathered so far, never throw — see the note above.
      console.warn(`[qa] WARNING: context-pack build FAILED (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    }

    return result;
  }
}
