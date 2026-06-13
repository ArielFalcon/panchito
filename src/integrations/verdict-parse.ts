// Verdict/JSON parsing for the agent boundary, extracted from opencode-client.ts (BND-08). This is
// the one piece of the god module that reconstructs the agent's structured output reliably (a
// balanced-brace JSON extractor that respects string literals + a fail-closed verdict reader), so
// it earns its own focused, well-tested module.

import type { SpecMeta } from "../types";

export interface FinalVerdict {
  approved: boolean;
  specs: string[];
  specMetas?: SpecMeta[];
  note?: string;
  parsed: boolean; // false when NO verdict JSON was found (fail-closed default), so
  // callers can distinguish "agent rejected" from "we couldn't parse it".
}

// Extracts every BALANCED top-level JSON object from free-form agent text, respecting string
// literals and escapes (so a `}` inside a string, or nested objects, never mis-split the span).
// Returns them in document order; callers take the last one matching their shape. This replaces
// brittle regex/lastIndexOf scanning of the agent's closing JSON.
export function extractJsonObjects(text: string): unknown[] {
  const objs: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          try {
            objs.push(JSON.parse(text.slice(start, i + 1)));
          } catch {
            /* not valid JSON; ignore this span */
          }
          start = -1;
        }
      }
    }
  }
  return objs;
}

// Returns the LAST extracted JSON object for which `pred` holds, or undefined.
export function lastJsonMatching<T = Record<string, unknown>>(text: string, pred: (o: Record<string, unknown>) => boolean): T | undefined {
  const objs = extractJsonObjects(text);
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    if (o && typeof o === "object" && pred(o as Record<string, unknown>)) return o as T;
  }
  return undefined;
}

// The discriminator for the GENERATOR's closing verdict block: which balanced JSON object in the
// agent's free-form text IS the deliverable. It carries a `specs` array (the deliverable) or, for
// legacy/other modes, a boolean `approved`. SHARED — both the extractor (parseVerdict here) and the
// shape validator (checkGeneratorVerdict in verdict-validate.ts) must locate the SAME block; if the
// two drifted apart, validation and extraction could disagree on which object is the verdict.
// (The REVIEWER's block is discriminated separately, by a boolean `approved` alone.)
export function isClosingVerdict(o: Record<string, unknown>): boolean {
  return Array.isArray(o.specs) || typeof o.approved === "boolean";
}

// Extracts the agent's closing verdict JSON: the LAST balanced object carrying either a `specs`
// array (the deliverable) OR a boolean `approved` (legacy/other modes). The generator no longer
// self-reports `approved` — the independent reviewer is the authoritative gate — so a closing
// block with `specs` but no `approved` is a valid result, not a rejection; `approved` defaults to
// true in that case (the reviewer decides for real downstream). If no block is valid, assumes not
// approved (fail-closed) so nothing publishes by accident, and flags `parsed:false` so callers can
// tell a parse miss from a real rejection.
export function parseVerdict(text: string): FinalVerdict {
  const o = lastJsonMatching(text, isClosingVerdict);
  if (o) {
    return {
      approved: typeof o.approved === "boolean" ? o.approved : true,
      specs: Array.isArray(o.specs) ? (o.specs as string[]) : [],
      specMetas: parseSpecMetas(o.specMetas),
      note: typeof o.note === "string" ? o.note : undefined,
      parsed: true,
    };
  }
  return { approved: false, specs: [], note: "the agent emitted no parseable verdict", parsed: false };
}

function parseSpecMetas(raw: unknown): SpecMeta[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const metas: SpecMeta[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const file = typeof e.file === "string" ? e.file.trim() : "";
    const flow = typeof e.flow === "string" ? e.flow.trim() : "";
    const objective = typeof e.objective === "string" ? e.objective.trim() : "";
    const targets = Array.isArray(e.targets) ? e.targets.filter((t): t is string => typeof t === "string") : [];
    if (file && flow && objective) {
      metas.push({ file, flow, objective, targets });
    }
  }
  return metas.length > 0 ? metas : undefined;
}
