// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/generation-port.adapter.ts
// Bridge: GenerationPort -> generation's REAL GenerateTestsUseCase. THIN — no new policy: the
// generate/review/reconcile shell (fail-closed reviewer gate, bounded repair, blockingCount) is
// GenerateTestsUseCase's OWN logic, reused verbatim.
//
// Shape translation: GenerationPort.generate(objectives, specDir, signal?) -> GenerationResult
// {specs, reviewed, approved, note}. This bridge holds the STATIC per-run context
// (repo/appName/mirrorDir/e2eRelDir/namespace/needsReview/target/mode/diff) as constructor config —
// the composition root (Task E.1/E.2) supplies these once per run; only specDir/objectives/signal
// vary per generate() call, matching the barrel's narrower GenerationPort signature.
//
// Plan 7.2 (closes engram #916): signal is forwarded verbatim into
// GenerateTestsUseCase.generate(input, {signal}) — the use-case already forwards opts?.signal into
// BOTH the generator and reviewer runtime.openSession() calls (Plan 7.1 territory, untouched here);
// this bridge was the ONLY missing link, silently dropping a cancelled run's signal before it ever
// reached the wall-clock-dominant in-flight agent turn.
//
// specSources (consumed by the FixLoop's Lever-2 selector check, per fix-loop.aggregate.ts's own
// FixLoopGenerateResult.specSources contract): re-reads the JUST-GENERATED spec files' source text
// via an OPTIONAL injected readSpecSource collaborator — file I/O deliberately stays OUTSIDE the
// domain (mirrors the aggregate's own header: "a composed adapter populates this from the CURRENT
// generate() call's own output"). Absent collaborator -> specSources omitted (matches
// "Absent/empty -> Lever-2 finds nothing to check against for this round", the documented safe
// default), never a fabricated read.
//
// reexploreNavigations: NO real sibling counter exists under generation/ today (confirmed by grep —
// GenerationResult carries no navigation count). Omitted here; the FixLoop's own contract treats
// absent as 0 ("matching the legacy's `result?.reexploreNavigations ?? 0`"), the documented safe
// default — never invented.
import type { Objective } from "@kernel/objective.ts";
import type { GenerationPort } from "../../application/ports/index.ts";
import { GenerateTestsUseCase } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { OpencodeRunInput } from "@contexts/generation/application/ports/generation-ports.ts";
import type { RunMode, TestTarget } from "@kernel/run-mode.ts";

export interface GenerationPortStaticContext {
  repo: string;
  appName: string;
  mirrorDir: string;
  e2eRelDir: string;
  namespace: string;
  needsReview: boolean;
  target: TestTarget;
  mode: RunMode;
  diff: string;
  guidance?: string;
}

export interface GenerationPortCollaborators {
  // Optional: re-reads a just-generated spec file's source text. Absent -> specSources omitted.
  readSpecSource?: (absolutePath: string) => Promise<string>;
}

export interface GenerationPortResult {
  specs: string[];
  approved: boolean;
  note?: string;
  specSources?: string[];
}

export class GenerationPortAdapter implements GenerationPort {
  constructor(
    private readonly useCase: GenerateTestsUseCase,
    private readonly ctx: GenerationPortStaticContext,
    private readonly collaborators: GenerationPortCollaborators = {},
  ) {}

  async generate(_objectives: readonly Objective[], specDir: string, signal?: AbortSignal): Promise<GenerationPortResult> {
    const input: OpencodeRunInput = {
      repo: this.ctx.repo,
      sha: "", // provenance only; the use-case never branches on it — the caller's Sha VO owns identity
      diff: this.ctx.diff,
      mirrorDir: this.ctx.mirrorDir,
      e2eRelDir: this.ctx.e2eRelDir,
      namespace: this.ctx.namespace,
      needsReview: this.ctx.needsReview,
      target: this.ctx.target,
      mode: this.ctx.mode,
      appName: this.ctx.appName,
      ...(this.ctx.guidance ? { guidance: this.ctx.guidance } : {}),
    };

    const generated = await this.useCase.generate(input, { ...(signal ? { signal } : {}) });

    const result: GenerationPortResult = {
      specs: generated.specs,
      approved: generated.approved,
      ...(generated.note !== undefined ? { note: generated.note } : {}),
    };

    if (this.collaborators.readSpecSource && generated.specs.length > 0) {
      const sources = await Promise.all(
        generated.specs.map((spec) => this.collaborators.readSpecSource!(`${specDir}/${spec}`)),
      );
      result.specSources = sources;
    }

    return result;
  }
}
