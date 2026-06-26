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
    const session = await runtime.openSession(generatorRole, input.mirrorDir, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
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
    // Reconcile uses the spec list from the deliverable. In the use-case the "on-disk
    // verification" invariant (a parsed spec NAME is a CLAIM, not proof it wrote the file)
    // is delegated to the ManifestRepositoryPort.reconcile implementation — the use-case
    // trusts the port to prune phantoms (mirrors the legacy disk-reconcile path).
    const specDir = `${input.mirrorDir}/${input.e2eRelDir}`;
    const rawEntries: ManifestEntry[] = deliverable.specs.map((spec) => ({
      id: spec.replace(/^.*\//, "").replace(/\.spec\.ts$/, ""),
      file: spec,
      flow: spec.replace(/^flows\//, "").replace(/\.spec\.ts$/, ""),
      objective: "", // enriched by the manifest repo impl if specMetas are available
    }));
    const reconciledEntries = await manifest.reconcile(specDir, rawEntries);

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
    const reviewerSession = await runtime.openSession(reviewerRole, input.mirrorDir, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
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
