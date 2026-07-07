// qa-engine/src/contexts/generation/application/generate-tests.use-case.ts
// PORT of the deterministic generate→review→reconcile orchestration from src/integrations/opencode-client.ts.
// Driven ENTIRELY through ports — no inline IO, no Playwright, no git, no SDK calls.
//
// Key invariants preserved from the legacy:
//   • The review gate is FAIL-CLOSED: an unparseable verdict is approved:false.
//   • blockingCount gates blocking-vs-advisory: zero blocking corrections → may approve.
//   • One bounded generator repair: if checkGenerator returns valid:false, re-prompt ONCE.
//   • One bounded reviewer repair: if parseReview returns valid:false, re-prompt ONCE.
//   • A parse miss (parsed:false) is distinguished from an explicit rejection.
//
// Characterized BEFORE this extraction (Task B.2) — the use-case must match that golden outcome.
import type { AgentRuntimePort } from "@kernel/ports/agent-runtime.port.ts";
import type { AgentRole } from "@kernel/agent-role.ts";
import type {
  PromptRenderingPort,
  VerdictParserPort,
  ManifestRepositoryPort,
  PromptBudgetPort,
  ManifestEntry,
} from "./ports/index.ts";
import type { OpencodeRunInput } from "./ports/generation-ports.ts";

// Injected repair utilities (wrapping repairInstruction + checkGeneratorVerdict from src/).
// Optional: when absent the use-case skips the generator contract check (useful for minimal stubs).
export interface RepairPort {
  checkGenerator(text: string): { valid: boolean; issues: string[] };
  instruction(kind: "generator" | "reviewer", issues: string[]): string;
}

// All ports the use-case depends on.
export interface GenerationPorts {
  runtime: AgentRuntimePort;
  rendering: PromptRenderingPort;
  verdicts: VerdictParserPort;
  manifest: ManifestRepositoryPort;
  // DEPRECATED (WS5.1, full-flow remediation plan): this port is declared here and constructed at
  // composition time (src/server/rewritten-engine-factory.ts's `budget: new PromptBudgetAdapter(...)`,
  // ~line 495) but NEVER CALLED anywhere in this class's generate() method — dead wiring. The prompt-
  // budget concern (capDiff/capText) is now owned by the RENDER layer instead: buildDiffSection,
  // buildCodeTask, and buildExplorerPrompt in src/integrations/prompts.ts all call capDiff directly
  // (see those functions' own WS5.1 comments) — the diff has non-prompt consumers (coverage assembler,
  // adjudication) that need it whole, so capping at the use-case/source layer would corrupt them; the
  // render boundary is the only place "too big for a prompt" is the right concept.
  // NOT removed in this slice: removing this field requires deleting the `budget:` construction line
  // in rewritten-engine-factory.ts, which is OWNED BY A CONCURRENT WORK UNIT in this delivery and is
  // out of this slice's file-touch boundary. Handoff: the next slice that owns that file should (a)
  // delete `budget: new PromptBudgetAdapter(...)` from the GenerateTestsUseCase construction, (b)
  // remove this field + the PromptBudgetPort import, and (c) drop `budget` from every test fixture
  // that constructs GenerationPorts (qa-engine/test/contexts/generation/application/generate-tests.
  // use-case.test.ts, qa-engine/test/contexts/qa-run-orchestration/**, qa-engine/test/contract/
  // seam-parity.contract.test.ts, qa-engine/test/contexts/service-topology/infrastructure/
  // level3-wiring.test.ts) — a wider blast radius than this slice's file-touch boundary allows.
  budget: PromptBudgetPort;
  repair?: RepairPort; // absent → no generator contract check; reviewer repair falls back to parse-miss only
}

// The outcome of a single generation run.
export interface GenerationResult {
  specs: string[];
  specMetas?: ManifestEntry[];
  approved: boolean;
  reviewed: boolean;
  note?: string;
}

// Options for a single generate() call.
export interface GenerateOpts {
  signal?: AbortSignal;
  // Called once when a bounded repair re-prompt fires (generator or reviewer).
  // Mirrors the onRepair hook in the legacy runOpencode/reviewIndependently signatures.
  onRepair?: () => void;
}

export class GenerateTestsUseCase {
  constructor(private readonly ports: GenerationPorts) {}

  // Generate E2E tests for a single input. Orchestrates the deterministic shell:
  //   1. Build the generation prompt (via PromptRenderingPort).
  //   2. Open a session and fire the prompt (via AgentRuntimePort).
  //   3. Check generator contract; if invalid, fire ONE bounded repair re-prompt.
  //   4. Parse the deliverable (via VerdictParserPort).
  //   5. Reconcile the manifest (via ManifestRepositoryPort).
  //   6. If needsReview: open a reviewer session, parse the reviewer verdict,
  //      fire ONE bounded repair re-prompt on valid:false, apply the fail-closed gate.
  async generate(input: OpencodeRunInput, opts?: GenerateOpts): Promise<GenerationResult> {
    const { runtime, rendering, verdicts, manifest, repair } = this.ports;

    // ── 1. Build the generation prompt ────────────────────────────────────────
    // renderMain wraps buildPromptAssembled (the single-agent primary path in runOpencode:724).
    const assembled = rendering.renderMain(input);

    // ── 2. Open a generator session and fire the initial prompt ───────────────
    const generatorRole: AgentRole = "primary"; // maps to "qa-generator" at wiring time
    // W5 fix (seam-parity FIXME, runId/onTurn threading): descriptor.runId is what the real
    // AgentDeps.open() (src/integrations/opencode-client.ts) needs to register this session for SSE
    // live activity AND to fire its own internal agent_turns persistence (defaultOnTurn) — mirrors
    // legacy's own generator descriptor (opencode-client.ts:701's `descriptor: { runId: input.runId,
    // role: "qa-generator", objective: ... }`). Absent input.runId -> descriptor.runId is undefined,
    // matching every other optional field's "absent -> unchanged" contract on this input.
    const session = await runtime.openSession(generatorRole, input.mirrorDir, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      descriptor: { runId: input.runId, role: "qa-generator" },
    });
    let generatorOutput: string;
    try {
      const result = await session.prompt(assembled.text, { sectionSizes: assembled.sectionSizes });
      generatorOutput = result.output;

      // ── 3. Bounded generator contract repair ─────────────────────────────────
      // When the repair port is available, check the generator's closing JSON against
      // the typed contract. A miss (valid:false) triggers ONE bounded re-prompt.
      // This recovers runs lost to formatting slips; bounded so a confused agent cannot
      // stall the queue (mirrors opencode-client.ts:734-743).
      if (repair) {
        const genCheck = repair.checkGenerator(generatorOutput);
        if (!genCheck.valid) {
          opts?.onRepair?.();
          const repairResult = await session.prompt(
            repair.instruction("generator", genCheck.issues),
            { isRepair: true },
          );
          generatorOutput = repairResult.output;
        }
      }
    } finally {
      await session.dispose();
    }

    // ── 4. Parse the generator deliverable ───────────────────────────────────
    const deliverable = verdicts.parseGenerator(generatorOutput);

    // ── 5. Reconcile the manifest ─────────────────────────────────────────────
    // Ported faithfully from the legacy manifest upsert (src/integrations/opencode-client.ts:
    // 764-810): entries are built EXCLUSIVELY from `deliverable.specMetas` (flow/objective/targets
    // per spec, self-reported by the agent's closing verdict JSON), keyed by `flow` — NOT derived
    // from `deliverable.specs` (the bare file-path list). A spec name that appears in `specs[]`
    // but has NO matching entry in `specMetas[]` gets NO manifest entry at all; this is legacy's
    // actual behavior (opencode-client.ts's loop iterates specMetas only, never cross-references
    // specs[] to synthesize a default entry) — silent, not an error, because the manifest is
    // best-effort metadata, not proof the spec exists (the spec file itself is what matters for
    // execution; only its METADATA entry is skipped).
    //
    // changeRef {sha, type} is the orchestrator-stamped provenance field the real manifest schema
    // requires (src/orchestrator/schemas.ts ManifestEntrySchema — objective/flow/targets non-empty,
    // changeRef.sha/type non-empty). `type` mirrors legacy's `input.intent?.type ?? "unknown"`
    // (opencode-client.ts:765); `sha` mirrors legacy's `input.sha`. Previously this used
    // `deliverable.specs.map(...)` with objective:"" and no targets/changeRef — always failing the
    // schema the static gate (Filter B) validates against once specMetas is the ONLY hydration path
    // wired here (live-run evidence: verdict=invalid, "entry 0.objective / entry 0.targets /
    // entry 0.changeRef" all missing).
    //
    // On-disk phantom verification (legacy's sha256File check: a specMeta naming a file NOT on disk
    // is dropped before it reaches the manifest) plus schema-shape validation (legacy's
    // ManifestEntrySchema.safeParse) are ported into manifest.reconcile()'s implementation
    // (manifest-fs.ts's safetyFilter, run BEFORE the upsert-merge — same ordering as legacy's
    // drop-before-write). A phantom entry (file absent on disk) or a malformed entry (empty
    // objective/targets/changeRef) is dropped with a console.warn there, never silently, and never
    // reaches this use-case's `reconciledEntries` return value.
    const specDir = `${input.mirrorDir}/${input.e2eRelDir}`;
    const changeType = input.intent?.type ?? "unknown";
    const rawEntries: ManifestEntry[] = (deliverable.specMetas ?? []).map((m) => ({
      id: m.flow,
      file: m.file,
      flow: m.flow,
      objective: m.objective,
      targets: m.targets,
      changeRef: { sha: input.sha, type: changeType },
      ...(m.sha256 ? { sha256: m.sha256 } : {}),
    }));
    // The e2e manifest does not exist for the code target (tests live in the repo's own framework,
    // there is no e2e/.qa/ dir to reconcile against — and specDir above composes the e2e folder).
    // Legacy parity: opencode-client.ts:800 gates reconciliation on `input.target !== "code"`;
    // raw specMetas pass through untouched so downstream consumers keep the agent's metadata.
    const reconciledEntries = input.target === "code" ? rawEntries : await manifest.reconcile(specDir, rawEntries);

    // Bail early if review is not requested (e.g. target:code or disabled config).
    if (!input.needsReview) {
      return {
        specs: deliverable.specs,
        reviewed: false,
        approved: true,
        note: deliverable.note,
      };
    }

    // ── 6. Independent reviewer session ──────────────────────────────────────
    // The reviewer is the AUTHORITATIVE publish gate. Opens a SEPARATE session to
    // guarantee independence — the generator cannot influence the reviewer.
    // (mirrors reviewIndependently in opencode-client.ts:952-1009)
    const reviewerRole: AgentRole = "reviewer"; // maps to "qa-reviewer" at wiring time
    const reviewerInput = {
      diff: input.diff,
      specs: deliverable.specs,
      mirrorDir: input.mirrorDir,
      e2eRelDir: input.e2eRelDir,
      appName: input.appName,
      mode: input.mode,
    };
    const reviewerAssembled = rendering.renderReviewer(reviewerInput as Parameters<typeof rendering.renderReviewer>[0]);
    // W5 fix (seam-parity FIXME, runId/onTurn threading): mirrors the generator session's own
    // descriptor fix above — the reviewer session (a SEPARATE session, legacy's own
    // opencode-client.ts:969 `descriptor: { runId: input.runId, role: "qa-reviewer", ... }`) needs
    // its own descriptor too, for the SAME SSE live-activity + agent_turns persistence reasons.
    const reviewerSession = await runtime.openSession(reviewerRole, input.mirrorDir, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      descriptor: { runId: input.runId, role: "qa-reviewer" },
    });
    let reviewJudgment;
    try {
      const reviewOut = await reviewerSession.prompt(reviewerAssembled.text, { sectionSizes: reviewerAssembled.sectionSizes });
      let reviewText = reviewOut.output;

      // One bounded reviewer repair: when valid:false (the reviewer JSON failed the typed
      // schema), re-prompt ONCE with the specific issues (opencode-client.ts:983-989).
      // valid:false ≠ approved:false: valid is "the reviewer JSON satisfied the schema",
      // approved is "the reviewer passed the suite". The use-case reads v.valid/v.issues
      // via the ReviewJudgment (Task A.3 port edit) so the contract-repair re-prompt fires.
      let v = verdicts.parseReview(reviewText);
      if (!v.valid && repair) {
        opts?.onRepair?.();
        const repaired = await reviewerSession.prompt(
          repair.instruction("reviewer", v.issues),
          { isRepair: true },
        );
        reviewText = repaired.output;
        v = verdicts.parseReview(reviewText);
      }

      reviewJudgment = v;
    } finally {
      await reviewerSession.dispose();
    }

    // Apply the fail-closed gate: no parseable verdict → approved:false (parse miss,
    // not a real rejection). blockingCount:0 (with parsed:true) → may approve.
    const approved = reviewJudgment.parsed === false
      ? false
      : (reviewJudgment.blockingCount !== undefined
          ? reviewJudgment.blockingCount === 0 && reviewJudgment.approved
          : reviewJudgment.approved);

    return {
      specs: deliverable.specs,
      specMetas: reconciledEntries,
      reviewed: true,
      approved,
      note: approved ? undefined : (reviewJudgment.rationale ?? "the reviewer did not approve the E2E tests"),
    };
  }
}
