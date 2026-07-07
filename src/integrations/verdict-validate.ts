// Typed verdict contract (post-ADR-001, Phase 1). The ADR-001 evaluation rejected turning
// the orchestrator↔agent boundary into an MCP server, but kept its one real improvement:
// make the agent's output a TYPED, validated contract instead of JSON scraped best-effort
// from free text. This module validates the two verdicts the agent emits — the generator's
// deliverable and the reviewer's authoritative gate — against the zod schemas, and builds the
// targeted re-prompt used by the bounded repair loop in opencode-client.
//
// Separation of concerns: verdict-parse.ts EXTRACTS data from the agent's free-form text
// (the balanced-brace scanner); this module JUDGES shape against the contract and explains
// what is wrong so the agent can fix the format rather than re-reason the whole task.

import { z } from "zod";
import { GeneratorVerdictSchema, ReviewerVerdictSchema, correctionText, correctionSeverity } from "../orchestrator/schemas";
import { lastJsonMatching, isClosingVerdict } from "./verdict-parse";
import { GRAVE_TAGS } from "../qa/learning/taxonomy";

// FIX 4: the GRAVE anti-pattern class tags. A correction the reviewer prefixes with one of these
// (e.g. "[false-positive] cart.spec.ts: asserts nothing") names a defect that MUST block publish —
// a false-positive test (green when the feature is broken), a test that misses the change entirely,
// or one that leaves orphaned DEV data. The class tag is structured, parsed-adjacent data the model
// already emits; we trust it over the model's own self-assigned `severity`, so a reviewer cannot
// (accidentally or otherwise) downgrade a grave finding to "advisory" and slip it past the gate.
// FIX B: the set is now DERIVED from taxonomy.ts GRAVE_TAGS (a single source: TAG_TO_CLASS minus the
// recoverable [fragile-selector]) — a hand-maintained local literal could silently fall out of sync
// if a future grave tag were added to the taxonomy, re-opening the downgrade hole this gate closes.

// Extract a correction's leading [class-tag] (lowercased), or null when it carries none.
// Mirrors the tag grammar in taxonomy.ts classifyReviewerCorrection.
function leadingClassTag(text: string): string | null {
  return /^\s*\[([a-z][a-z-]*)\]/i.exec(text)?.[1]?.toLowerCase() ?? null;
}

// The EFFECTIVE severity of a correction: "blocking" for a grave class tag regardless of the model's
// self-assigned severity (FIX 4), otherwise the model's declared severity (fail-closed default).
function effectiveSeverity(entry: import("../orchestrator/schemas").CorrectionEntry): "blocking" | "advisory" {
  const tag = leadingClassTag(correctionText(entry));
  if (tag && GRAVE_TAGS.has(tag)) return "blocking";
  return correctionSeverity(entry);
}

// Render zod issues as compact, prompt-ready strings ("path: message").
function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`);
}

export interface VerdictCheck {
  valid: boolean;
  issues: string[]; // empty when valid
}

// Validate the GENERATOR's closing JSON: { specs[], specMetas?, note? }. We locate the LAST
// balanced object that looks like the verdict block (carries a `specs` array — the
// deliverable — or a boolean `approved` from older/other modes) and validate it. A missing
// block is invalid (the agent forgot its closing JSON); the repair loop can recover it.
export function checkGeneratorVerdict(text: string): VerdictCheck {
  const candidate = lastJsonMatching(text, isClosingVerdict);
  if (!candidate) {
    return { valid: false, issues: ["no closing verdict JSON found (expected a block with a `specs` array)"] };
  }
  const r = GeneratorVerdictSchema.safeParse(candidate);
  return r.success ? { valid: true, issues: [] } : { valid: false, issues: formatIssues(r.error) };
}

export interface ReviewerVerdict {
  approved: boolean;
  rationale?: string;
  // Flat list of ALL correction texts (blocking + advisory), for backward-compat logging.
  corrections: string[];
  // Phase 4: count of BLOCKING corrections. The gate passes when this is zero, regardless
  // of advisory correction count. A plain-string correction (no severity field) is counted
  // as blocking (fail-closed backward compat).
  blockingCount: number;
  valid: boolean; // the reviewer JSON satisfied the schema (i.e. `approved` is a clean boolean)
  parsed: boolean; // an object carrying an `approved` field was found at all
  issues: string[];
}

// Parse the REVIEWER's verdict: { approved, rationale?, corrections[] } — the AUTHORITATIVE
// gate. Fail-closed: a missing/invalid verdict yields approved=false so nothing publishes by
// accident, but `valid`/`issues` let the caller repair once before giving up.
//
// The candidate predicate matches any object carrying an `approved` KEY (not only a boolean
// one) so that a mistyped gate (`"approved":"true"`, `1`, `null`) is caught by the schema and
// surfaced as a precise repair issue — rather than being missed entirely and mislabelled "no
// verdict". This is what makes the schema validation meaningful for the authoritative gate.
//
// Phase 4: corrections are parsed via CorrectionEntrySchema (plain string or structured
// { text, severity }). The returned `corrections` is a flat string list for backward compat;
// `blockingCount` is the count of corrections whose severity is "blocking" (or unset — fail-closed).
export function parseReviewerVerdict(text: string): ReviewerVerdict {
  const candidate = lastJsonMatching(text, (x) => "approved" in x);
  if (!candidate) {
    return {
      approved: false,
      corrections: [],
      blockingCount: 0,
      valid: false,
      parsed: false,
      issues: ["no reviewer verdict JSON (an object with an `approved` field) was found"],
    };
  }
  const r = ReviewerVerdictSchema.safeParse(candidate);
  if (r.success) {
    const corrections = r.data.corrections.map(correctionText);
    // FIX 4: count via effectiveSeverity so a grave class-tag correction is always blocking, even if
    // the model self-labeled it "advisory" — closing the downgrade-to-advisory gameability hole.
    const blockingCount = r.data.corrections.filter((e) => effectiveSeverity(e) === "blocking").length;
    return {
      approved: r.data.approved,
      ...(r.data.rationale && r.data.rationale.trim() ? { rationale: r.data.rationale.trim() } : {}),
      corrections,
      blockingCount,
      valid: true,
      parsed: true,
      issues: [],
    };
  }
  // An `approved` field was present but did not satisfy the schema (e.g. it is a string/number,
  // not a boolean). Fail closed and flag the precise issue so the bounded repair can fix it.
  return { approved: false, corrections: [], blockingCount: 0, valid: false, parsed: true, issues: formatIssues(r.error) };
}

// WS9.1 — the bounded tail embedded in a self-contained repair prompt. ~4096 CHARS (not a strict
// byte count — the slice operates on UTF-16 code units, which is close enough for a budget cap)
// is generous for a closing verdict block (typically a few hundred bytes) while staying small
// enough that a persistently-malformed agent cannot blow up the repair turn's own prompt budget.
const PRIOR_RESPONSE_TAIL_CHARS = 4096;

// The frame markers for the embedded tail. Deliberately long, distinctive, and STATIC
// (determinism over per-call randomness, per this repo's priority order): a generic "---" fence
// is trivially present in model output (markdown rules, YAML front-matter), which would let a
// pathological prior response fake a fence-close and place text OUTSIDE the untrusted block.
// Any tail line exactly matching a marker (modulo surrounding whitespace) is stripped before
// embedding, so exactly one open and one close marker — the frame's own — can ever appear.
const TAIL_FRAME_OPEN = "====== PRIOR RESPONSE TAIL (verbatim, untrusted) ======";
const TAIL_FRAME_CLOSE = "====== END PRIOR RESPONSE TAIL ======";

// Remove any tail line that IS one of the frame markers (whitespace-padded lines included, so a
// padded marker cannot bypass the exact-match check). Everything else stays verbatim: this text
// is model→model-scoped (the agent's OWN prior output fed back to the same lineage in the same
// session context, never human-bound and never rendered into an Issue), so no sanitizeText pass
// is needed here — the ONLY threat is frame escape, which this stripping closes.
function stripFrameMarkers(tail: string): string {
  return tail
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return t !== TAIL_FRAME_OPEN && t !== TAIL_FRAME_CLOSE;
    })
    .join("\n");
}

export interface RepairInstructionOpts {
  // The tail of the agent's PRIOR response (bounded to the last PRIOR_RESPONSE_TAIL_CHARS chars
  // by this function, so callers may pass the full text). Provider-agnostic fallback: a fresh
  // `codex exec` process (no resume) never saw the prior turn, so without this the repair
  // instruction gives it nothing to recover FROM — it can only fabricate a plausible verdict.
  // OpenCode's server-side session already remembers the prior turn, so passing this there is
  // additive (a harmless restatement of context the session already holds), never harmful.
  priorResponseTail?: string;
}

// The targeted re-prompt for the bounded repair loop. Names the exact shape and the specific
// issues so the agent fixes the format rather than re-running the whole task. When the caller
// supplies `priorResponseTail` (the tail of the agent's own prior output), the prompt embeds it
// so a stateless process can genuinely RE-EMIT its prior verdict rather than invent a new one.
export function repairInstruction(kind: "generator" | "reviewer", issues: string[], opts?: RepairInstructionOpts): string {
  const shape =
    kind === "generator"
      ? `{"specs": string[], "specMetas"?: [{"file","flow","objective","targets": string[]}], "note"?: string}`
      : `{"approved": boolean, "rationale": string, "corrections": string[]}`;
  const tail = opts?.priorResponseTail ? stripFrameMarkers(opts.priorResponseTail).trim() : "";
  const tailBlock = tail
    ? [
        "",
        "Your previous response (tail, for your own reference — do not repeat it verbatim, only",
        "use it to recover the specifics of what you already decided):",
        TAIL_FRAME_OPEN,
        tail.slice(-PRIOR_RESPONSE_TAIL_CHARS),
        TAIL_FRAME_CLOSE,
      ]
    : [];
  return [
    `Your previous response did not end with a valid ${kind} verdict JSON.`,
    `Problems: ${issues.join("; ")}.`,
    ...tailBlock,
    `Re-emit ONLY the closing JSON block — exactly this shape, with no text after it:`,
    shape,
  ].join("\n");
}
