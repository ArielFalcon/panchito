// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/generation-port.adapter.ts
// Bridge: GenerationPort -> generation's REAL GenerateTestsUseCase. THIN — no new policy: the
// generate/review/reconcile shell (fail-closed reviewer gate, bounded repair, blockingCount) is
// GenerateTestsUseCase's OWN logic, reused verbatim.
//
// Shape translation: GenerationPort.generate(objectives, specDir, signal?, diff?) -> GenerationResult
// {specs, reviewed, approved, note}. This bridge holds the STATIC per-run context
// (repo/appName/mirrorDir/e2eRelDir/namespace/needsReview/target/mode/diff/baseUrl) as constructor
// config — the composition root (Task E.1/E.2) supplies these once per run; specDir/objectives/
// signal/diff vary per generate() call, matching the barrel's GenerationPort signature.
//
// "baseUrl" fix (live-run root cause): ctx.baseUrl was missing entirely until this fix — a live
// codex run returned zero specs with the agent's own note that Playwright DOM grounding is
// mandatory and no LIVE DEV URL was provided, so it correctly aborted rather than inventing
// selectors. The bug was never the agent's refusal; it was this adapter never forwarding the
// app's configured baseUrl into OpencodeRunInput.baseUrl. See composition-root.ts's wireBridges()
// for where CompositionConfig.baseUrl (already used by ExecutionPortAdapter/ReviewPortAdapter) is
// now also threaded into this context.
//
// "Dynamic diff" fix (engram #936): ctx.diff alone is a STATIC composition-time value — the real
// production engineFactory constructs this adapter BEFORE the run's checkout/diff exist, so ctx.diff
// is always "" there (only the F.2 shadow operator pre-computes it before building the config). The
// optional per-call `diff` argument carries the run's REAL commit diff (RunQaUseCase threads it from
// ChangeAnalysisPort.classify()'s own result) and takes precedence; ctx.diff is now only the fallback
// for callers/modes that never supply one.
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
//
// W2 fix (F1, generation regen/enrichment context): generate()'s new optional trailing `enrichment`
// (GenerationEnrichment, ports/index.ts) is spread-conditionally into the OpencodeRunInput this
// adapter already builds — reviewCorrections/fixCases/selectorContradictions/domSnapshot/
// coverageGap/intent are ALL fields OpencodeRunInput already carries (generation-ports.ts's FULL
// current field set, copied verbatim from src/integrations/opencode-client.ts) and buildPromptAssembled
// already renders sections for (src/integrations/prompts.ts:667-737,912-924) — this bridge was
// simply never given the data to forward. Absent enrichment/fields -> unchanged prompt, exactly
// today's behavior (every field is independently optional, matching the barrel's own precedent).
import type { Objective } from "@kernel/objective.ts";
import type { GenerationPort, GenerationEnrichment } from "../../application/ports/index.ts";
import { GenerateTestsUseCase } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { OpencodeRunInput, CommitIntent as GenerationCommitIntent } from "@contexts/generation/application/ports/generation-ports.ts";
import type { RunMode, TestTarget } from "@kernel/run-mode.ts";

// The barrel's CommitIntent (ports/index.ts) is kernel-resident/structural — `type` is a plain
// `string` there (this bridge, not the barrel, is where cross-context types are allowed). Generation's
// OWN CommitIntent narrows `type` to its CommitType union. The value ALWAYS originates from
// ChangeAnalysisPortAdapter's classifyCommit() call (commit-classification.ts's own CommitType union
// is structurally identical to generation's), so this is a same-shape re-assertion at the bridge
// boundary, never a fabricated narrowing.
function toGenerationIntent(intent: GenerationEnrichment["intent"]): GenerationCommitIntent | undefined {
  return intent as GenerationCommitIntent | undefined;
}

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
  // Live-run root cause (baseUrl gap): the LIVE DEV URL the agent must navigate to (Playwright
  // MCP) — OpencodeRunInput.baseUrl's own contract. Absent here left the generator with no live
  // URL, which a correctly-behaving agent treats as "DOM grounding is mandatory, abort" (the
  // anti-hallucination invariant working as designed) rather than inventing selectors — the bug
  // was never the agent's refusal, it was this adapter silently never forwarding the app's
  // configured baseUrl into OpencodeRunInput. Optional: absent -> unchanged (matches every other
  // optional field on this context).
  baseUrl?: string;
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

  async generate(_objectives: readonly Objective[], specDir: string, signal?: AbortSignal, diff?: string, enrichment?: GenerationEnrichment): Promise<GenerationPortResult> {
    const input: OpencodeRunInput = {
      repo: this.ctx.repo,
      sha: "", // provenance only; the use-case never branches on it — the caller's Sha VO owns identity
      // "Dynamic diff" fix (engram #936): PREFER the run's real diff (threaded per-call from
      // RunQaUseCase's ChangeAnalysisPort.classify() result) over the STATIC ctx.diff supplied at
      // construction time — the real production engineFactory builds this adapter BEFORE the
      // run/checkout, so ctx.diff is always "" there. Falling back to ctx.diff when the caller omits
      // the argument keeps the F.2 operator's own pre-computed-diff composition working unchanged.
      diff: diff ?? this.ctx.diff,
      mirrorDir: this.ctx.mirrorDir,
      e2eRelDir: this.ctx.e2eRelDir,
      namespace: this.ctx.namespace,
      needsReview: this.ctx.needsReview,
      target: this.ctx.target,
      mode: this.ctx.mode,
      appName: this.ctx.appName,
      ...(this.ctx.guidance ? { guidance: this.ctx.guidance } : {}),
      ...(this.ctx.baseUrl ? { baseUrl: this.ctx.baseUrl } : {}),
      // W2 fix (F1): spread-conditional — every enrichment field is independently optional, mapped
      // 1:1 onto the SAME OpencodeRunInput fields buildPromptAssembled already renders sections for.
      // Absent enrichment or an absent/empty individual field -> that field is omitted from `input`,
      // unchanged prompt (exactly the pre-fix behavior).
      ...(enrichment?.reviewCorrections?.length ? { reviewCorrections: [...enrichment.reviewCorrections] } : {}),
      ...(enrichment?.fixCases?.length ? { fixCases: [...enrichment.fixCases] } : {}),
      ...(enrichment?.selectorContradictions?.length ? { selectorContradictions: [...enrichment.selectorContradictions] } : {}),
      ...(enrichment?.domSnapshot ? { domSnapshot: enrichment.domSnapshot } : {}),
      ...(enrichment?.coverageGap ? { coverageGap: enrichment.coverageGap } : {}),
      ...(enrichment?.intent ? { intent: toGenerationIntent(enrichment.intent) } : {}),
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
