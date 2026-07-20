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
import type { GenerationPort, GenerationEnrichment, RetrievedRule } from "../../application/ports/index.ts";
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

// W3 F2 (dual-judge round, generator side): a FAITHFUL port of legacy's renderRulesForPrompt
// (src/qa/learning/learning-rule.ts:237-270), byte-for-byte — same two section headers, same
// framing sentences, same per-rule field layout (### heading with errorClass/confidence for
// active rules, "Consider:" phrasing for candidates). Ported here (not imported — qa-engine stays
// src/-free) because this bridge is the ONLY place with both the structured RetrievedRule[] input
// and the OpencodeRunInput.learnedRules string output legacy's own generator prompt renders a
// section for. Empty input never reaches here (guarded at the call site by `.length` before
// invoking).
export function renderLearnedRules(rules: readonly RetrievedRule[]): string {
  const active = rules.filter((r) => r.status === "active");
  const candidates = rules.filter((r) => r.status === "candidate");

  const lines: string[] = [];

  if (active.length > 0) {
    lines.push("## Proven rules from past QA runs");
    lines.push("These rules were earned from real failures and validated by measured outcomes. Apply them when they match the current change.");
    lines.push("");
    for (const r of active) {
      lines.push(`### Rule (${r.errorClass}, confidence=${r.confidence})`);
      lines.push(`- Trigger: ${r.trigger}`);
      lines.push(`- Action: ${r.action}`);
      lines.push("");
    }
  }

  if (candidates.length > 0) {
    lines.push("## Experimental rules (unproven — consider, not prescriptive)");
    lines.push("These are hypotheses from recent runs that have not yet been validated by enough measured outcomes. Consider them when clearly applicable, but do not let them override your judgment.");
    lines.push("");
    for (const r of candidates) {
      lines.push(`### Experimental rule (${r.errorClass})`);
      lines.push(`- Trigger: ${r.trigger}`);
      lines.push(`- Consider: ${r.action}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

// W3 F2 (dual-judge round, reviewer side): a FAITHFUL port of legacy's renderRulesForReviewer
// (src/qa/learning/learning-rule.ts:299-313) — ONLY `active` (proven) rules are enforced;
// unproven candidates exist for the generator to explore, never for the judge to gate on
// (rejecting tests over speculative rules would be a false-positive gate — the SAME rationale
// legacy's own header documents). Includes the 2 framing sentences verbatim, and the SAME
// `- ${trigger} → ${action} (${errorClass})` per-rule line format.
export function renderLearnedRulesForReviewer(rules: readonly RetrievedRule[]): string {
  const proven = rules.filter((r) => r.status === "active");
  if (proven.length === 0) return "";

  const lines = [
    "## App-specific reject-on-sight rules (earned from past runs on this app)",
    "Each was learned from a real failure and proven by the value oracle or sustained prevention.",
    "Treat them as an extension of the anti-pattern catalog: if a spec violates one, REJECT.",
    "",
  ];
  for (const r of proven) {
    lines.push(`- ${r.trigger} → ${r.action} (${r.errorClass})`);
  }
  return lines.join("\n");
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
  // W5 fix (seam-parity FIXME): the app's declared OpenAPI glob hint (AppConfig.openapi,
  // src/orchestrator/schemas.ts) — mirrors OpencodeRunInput.openapi's own doc: "optional hint (from
  // app config): where the repo's OpenAPI contract(s) live" (prompts.ts:500,1068 renders it so the
  // agent knows where to look for backend contracts). App-static (composition-time), the SAME
  // "known once per run, not per generate() call" shape as baseUrl above — NOT per-call/dynamic like
  // diff/intent. Absent -> unchanged (matches every other optional field on this context).
  openapi?: string | string[];
  // Cross-repo generation-prompt parity (legacy pipeline.ts:1909): identifies the TRIGGERING
  // microservice for a cross-repo run — its repo, its OWN read-only mirror dir, and its OWN openapi
  // hint (all distinct from ctx.mirrorDir/ctx.openapi above, which stay bound to the PRIMARY repo).
  // App-static (fixed for the whole run, known once at composition time), the SAME shape as
  // baseUrl/openapi above — NOT per-call/dynamic. Maps 1:1 onto OpencodeRunInput.service. Absent
  // (the common same-repo case) -> unchanged, matching every other optional field on this context.
  service?: { repo: string; mirrorDir: string; openapi?: string | string[] };
  // Context-mode multi-service parity (legacy pipeline.ts:1330-1355 buildContextMap): EVERY declared
  // service repo (read-only working copies), distinct from `service` above (the SINGLE triggering
  // service on a cross-repo run — mutually exclusive with this field by construction, since context
  // mode can never be service-triggered). App-static, the SAME shape as service/openapi above — NOT
  // per-call/dynamic. Maps 1:1 onto OpencodeRunInput.services. Absent (every non-context run, or a
  // context run with no declared services) -> unchanged, matching every other optional field here.
  services?: Array<{ repo: string; mirrorDir: string; openapi?: string | string[] }>;
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
  // parsed: forwarded from GenerateTestsUseCase — FALSE means the agent runtime emitted no parseable
  // verdict (empty/errored session), so the orchestrator can distinguish a genuine agent no-op from a
  // runtime failure instead of silently skipping. See GenerationResult.parsed's own doc.
  parsed?: boolean;
  // sdd/migration-remediation Slice 4 (D-P1a): the agent's own per-spec metadata (flow/objective),
  // narrowed from GenerateTestsUseCase's GenerationResult.specMetas (ManifestEntry[], generate-
  // tests.use-case.ts) — see GenerationPort.generate()'s own doc (ports/index.ts) for the full
  // port-boundary-projection rationale. Only flow/objective survive this bridge; file/targets/
  // changeRef/sha256 stay internal to generation's own manifest reconciliation.
  specMetas?: { flow?: string; objective?: string }[];
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
      // Manifest-enrichment fix: sha now feeds GenerateTestsUseCase's ManifestEntry.changeRef.sha
      // (the real manifest schema requires changeRef.sha non-empty — the use-case is no longer
      // sha-inert). Sourced from enrichment.sha (the run's Sha VO, stringified by the caller) when
      // supplied; falls back to "" (today's behavior, and the value production hits until
      // run-qa.use-case.ts's baseEnrichment is widened to thread input.sha.toString() the same way
      // it already threads intent — see GenerationEnrichment.sha's own comment for why that call
      // site is out of this change's scope).
      sha: enrichment?.sha ?? "",
      // W5 fix (seam-parity FIXME): threads the run's id onto OpencodeRunInput.runId, which becomes
      // the session descriptor's runId. WS6.2 correction (full-flow remediation): this field alone
      // was NOT sufficient for SSE registration on the rewritten path — registerRunSession was never
      // called here (the claim this comment previously made was wrong); the actual gap was in the
      // composition seam (rewritten-engine-factory.ts's runtimeAdapter open() closure was dropping
      // opts?.descriptor before it ever reached AgentDeps.open, and nothing wrapped AgentDeps with
      // withSessionRegistration). Both are now fixed at the factory's composition point — this
      // field's own contribution is unchanged: supplying a correct descriptor.runId so that fix has
      // something real to register. Absent -> omitted, unchanged (today's behavior for a caller that
      // predates this enrichment field).
      ...(enrichment?.runId ? { runId: enrichment.runId } : {}),
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
      // W5 fix (seam-parity FIXME): app-static, mirrors baseUrl's own "known once per run" shape.
      ...(this.ctx.openapi ? { openapi: this.ctx.openapi } : {}),
      // Cross-repo generation-prompt parity (legacy pipeline.ts:1909): app-static, mirrors
      // openapi's own conditional-spread precedent immediately above.
      ...(this.ctx.service ? { service: this.ctx.service } : {}),
      // Context-mode multi-service parity (legacy pipeline.ts:1330-1355 buildContextMap): app-static,
      // mirrors service's own conditional-spread precedent immediately above.
      ...(this.ctx.services?.length ? { services: this.ctx.services } : {}),
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
      // W3 F2 (cross-run learning retrieval): mirrors legacy's baseGenInput({ learnedRules, ... })
      // threading (src/pipeline.ts:1899) — LearningPort.retrieve(sha)'s rule-trigger strings,
      // rendered into the SAME OpencodeRunInput.learnedRules field buildPromptAssembled already
      // renders a section for. Rendering (not just a join) happens HERE, at the adapter boundary —
      // matching every other enrichment field's own format-at-the-adapter precedent.
      ...(enrichment?.learnedRules?.length ? { learnedRules: renderLearnedRules(enrichment.learnedRules) } : {}),
      // Plan 7-R W4 (audit CRITICAL, selector-grounding cutover): the PRE-generate grounding data
      // (PreGenerationGroundingPort, run-qa.use-case.ts) — mapped 1:1 onto the SAME OpencodeRunInput
      // fields buildPromptAssembled already renders sections for (contextPack's own "VOLATILE
      // context-pack section" doc; existingSpecFiles' own "existing-suite-manifest" doc,
      // generation-ports.ts). Absent -> omitted, unchanged prompt (today's behavior).
      ...(enrichment?.contextPack ? { contextPack: enrichment.contextPack } : {}),
      ...(enrichment?.existingSpecFiles?.length ? { existingSpecFiles: [...enrichment.existingSpecFiles] } : {}),
      // CodeGraph Phase 4 (design §5.1, ADR-3): the rendered structural-blast-radius advisory block
      // (GenerationEnrichment.staticSignal's own doc, ports/index.ts) — mapped 1:1 onto the SAME
      // OpencodeRunInput.staticSignal field buildPromptAssembled already renders a section for.
      // Absent -> omitted, unchanged prompt (closes the seam-parity ALLOWLIST gap for this field).
      ...(enrichment?.staticSignal ? { staticSignal: enrichment.staticSignal } : {}),
      // Stitcher→Generation seam (design §3.4, S2.3): 1:1 spread, mirroring staticSignal's own
      // conditional-spread precedent exactly — mapped onto the SAME OpencodeRunInput.serviceLinks/
      // contractDrift fields generation-ports.ts already declares (canonical ServiceLink/
      // ContractDrift import — see design §0's "imports the canonical type, already wired" note).
      // Absent/empty -> omitted, never set to [] (matches every other array-shaped enrichment field).
      ...(enrichment?.serviceLinks?.length ? { serviceLinks: [...enrichment.serviceLinks] } : {}),
      ...(enrichment?.contractDrift?.length ? { contractDrift: [...enrichment.contractDrift] } : {}),
      // Slice C (structural-signals-expansion, design §3.7): 1:1 spread, mirroring serviceLinks'
      // own conditional-spread precedent immediately above — mapped onto the SAME
      // OpencodeRunInput.crossRepoImpact field generation-ports.ts already declares.
      // Absent/empty -> omitted, never set to an empty-impactedLinks object.
      ...(enrichment?.crossRepoImpact?.impactedLinks.length
        ? { crossRepoImpact: { impactedLinks: enrichment.crossRepoImpact.impactedLinks.map((x) => ({ ...x })) } }
        : {}),
      // WS7.4 (full-flow remediation): 1:1 spread, mirroring intent's own conditional-spread
      // precedent — mapped onto the SAME OpencodeRunInput.classificationReason/contradiction
      // fields generation-ports.ts declares. Absent -> omitted, unchanged prompt.
      ...(enrichment?.classificationReason ? { classificationReason: enrichment.classificationReason } : {}),
      ...(enrichment?.contradiction ? { contradiction: true } : {}),
    };

    const generated = await this.useCase.generate(input, { ...(signal ? { signal } : {}) });

    const result: GenerationPortResult = {
      specs: generated.specs,
      approved: generated.approved,
      ...(generated.note !== undefined ? { note: generated.note } : {}),
      ...(generated.parsed !== undefined ? { parsed: generated.parsed } : {}),
      // sdd/migration-remediation Slice 4 (D-P1a): project down to the narrow flow/objective shape
      // GenerationPort.generate()'s return type declares — never leak the fuller ManifestEntry
      // (file/targets/changeRef/sha256) across this port boundary.
      ...(generated.specMetas?.length
        ? { specMetas: generated.specMetas.map((m) => ({ flow: m.flow, objective: m.objective })) }
        : {}),
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
