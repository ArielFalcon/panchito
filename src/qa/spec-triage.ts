// Pure, synchronous, never-throws triage module for quality-filtered-dual-publish.
// Classifies each generated spec file into PR / ISSUE / DROP using only deterministic
// signals already available at the decide step. No LLM call. No I/O. No async.
//
// Conservative bias: when evidence is ambiguous, routes to ISSUE, never to DROP.
// DROP only fires on affirmative evidence of a test defect (GRAVE reviewer tag or
// all-locator-fail with verifiably-absent selectors). Real-bug evidence always beats
// test-defect evidence (T3 precedes T4 in the decision table).

import type { QaCase, RunMode } from "../types";
import { classifyFailure, isLikelyRealBug } from "./progress-gate";
import { checkSpecSelectors } from "./selector-check";
import { adjudicate, ADJ_CLASS, type AdjudicatorEvidence } from "./failure-adjudicator";
import { GRAVE_TAGS } from "./learning/taxonomy";
import { posix as posixPath } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FilePresence {
  /** True when every extractable selector for this file was present and unique in the failure DOM. */
  allUnique: boolean;
  /** Count of verifiably-absent selectors for this file. */
  absentKeysCount: number;
}

export type FileVerdict = {
  file: string;
  class: string;
  reason: string;
};

export interface TriageInput {
  cases: QaCase[];
  presenceByFile: Map<string, FilePresence>;
  graveByFile: Map<string, boolean>;
  mode: RunMode;
  objectiveSource: string[];
  /** When true, the grave verdicts for ALL files came from an unattributable correction —
   *  the safe action is ISSUE (not DROP) to avoid silent loss. */
  allFilesGraveUnattributable?: boolean;
}

export interface TriageResult {
  pr: string[];
  issue: FileVerdict[];
  drop: string[];
  reasons: Record<string, string>;
}

// ── `perFileSelectorPresence` ─────────────────────────────────────────────────

/**
 * Groups `cases` by `QaCase.file` and, for each file, runs `checkSpecSelectors` over
 * that file's failed cases' failure-DOM trees. Returns a map from file basename → the
 * per-file allUnique / absentKeysCount values that parallel the run-level computation
 * in pipeline.ts (line 2436). Pure, no I/O, never throws.
 *
 * `specSourcesByFile` maps file basename → spec source string array (the file contents
 * as read by the caller). Files in `cases` that have no entry in `specSourcesByFile`
 * are checked against empty sources (yields allUnique=false, absentKeysCount=0).
 */
export function perFileSelectorPresence(
  cases: QaCase[],
  specSourcesByFile: Record<string, string[]>,
): Map<string, FilePresence> {
  // Group cases by file (undefined file → skip, handled by buildPerFileEvidence unfiled bucket)
  const byFile = new Map<string, QaCase[]>();
  for (const c of cases) {
    if (!c.file) continue;
    let bucket = byFile.get(c.file);
    if (!bucket) {
      bucket = [];
      byFile.set(c.file, bucket);
    }
    bucket.push(c);
  }

  const result = new Map<string, FilePresence>();
  for (const [file, fileCases] of byFile) {
    const failedCases = fileCases.filter((c) => c.status !== "pass");
    // Build the trees array from the failed cases' failureDom fields
    // (same shape as pipeline.ts's `failedTrees.map(t => t.lines)`)
    const trees = failedCases
      .map((c) => buildDomLines(c.failureDom))
      .filter((lines) => lines.length > 0);

    const specSources = specSourcesByFile[file] ?? [];
    if (specSources.length === 0 || trees.length === 0) {
      // No spec sources or no trees → presence is indeterminate → allUnique=false
      result.set(file, { allUnique: false, absentKeysCount: 0 });
      continue;
    }

    const findings = checkSpecSelectors(specSources, trees);
    // Replicates the run-level `allUnique` formula from pipeline.ts:2436
    const allUnique =
      findings.anyVerifiedPresent &&
      findings.absentKeys.size === 0 &&
      !findings.anyNonExtractable &&
      !findings.anyUnverifiable &&
      !findings.contradictions.some((c) => c.includes("MULTIPLE"));

    result.set(file, { allUnique, absentKeysCount: findings.absentKeys.size });
  }
  return result;
}

// ── `attributeCorrections` ───────────────────────────────────────────────────

/**
 * Parses reviewer correction strings and determines which files carry a GRAVE tag.
 * Returns a map from file basename → boolean (true = grave for this file).
 *
 * Attribution rules:
 * - Each correction may start with `[tag] filename.spec.ts: ...`
 * - A GRAVE_TAG on an attributable file → that file's entry = true
 * - A GRAVE_TAG with NO resolvable filename → ALL files = true (conservative; unattributable)
 * - `[fragile-selector]` is NOT grave (recoverable tag, excluded from GRAVE_TAGS)
 * - Non-grave tags and untagged corrections → no change (file stays false)
 *
 * Pure, synchronous, never throws.
 */
export function attributeCorrections(
  corrections: string[],
  allFiles: string[],
): Map<string, boolean> {
  const result = new Map<string, boolean>(allFiles.map((f) => [f, false]));

  for (const correction of corrections) {
    // Parse `[tag]` prefix
    const tagMatch = /^\s*\[([a-z][a-z-]*)\]/i.exec(correction);
    if (!tagMatch) continue; // no bracket tag → not grave, skip

    const tag = tagMatch[1]!.toLowerCase();
    if (!GRAVE_TAGS.has(tag)) continue; // not a grave tag → skip

    // Try to extract the filename token that follows the tag prefix.
    // Pattern: `[tag] filename.spec.ts:` or `[tag] filename.spec.ts ...`
    // The filename ends at the first `:` or whitespace after the tag.
    const afterTag = correction.slice(tagMatch[0].length).trim();
    const filenameMatch = /^([^\s:]+\.spec\.ts)/i.exec(afterTag);
    const attributedFile = filenameMatch?.[1];

    if (attributedFile) {
      // Find the matching file in allFiles (by basename)
      const matched = allFiles.find(
        (f) => f === attributedFile || f.endsWith(`/${attributedFile}`) || basename(f) === attributedFile,
      );
      if (matched) {
        result.set(matched, true);
      } else {
        // Filename token present but not in allFiles → treat as unattributable (conservative)
        for (const f of allFiles) result.set(f, true);
      }
    } else {
      // No filename found → unattributable GRAVE → ALL files blocked from PR, never DROP
      for (const f of allFiles) result.set(f, true);
    }
  }
  return result;
}

// ── `buildPerFileEvidence` ───────────────────────────────────────────────────

/**
 * Groups `run.cases` by `QaCase.file` and assembles an `AdjudicatorEvidence` per file,
 * exactly as pipeline.ts does at the run level but scoped to each file's failed cases.
 * Cases with `undefined` file → synthetic `"(unfiled)"` bucket (conservative: never PR).
 *
 * `presenceByFile` comes from `perFileSelectorPresence`. `graveByFile` comes from
 * `attributeCorrections`. Both are passed pre-computed (pure, from the caller).
 *
 * `gateSpend=false` uniformly (the fix-loop is over at decide time — makes adjudicate's
 * Rule 4 inert and pushes ambiguous failures toward Rule 5 → ISSUE, which is correct).
 */
export function buildPerFileEvidence(
  cases: QaCase[],
  presenceByFile: Map<string, FilePresence>,
  mode: RunMode,
  objectiveSource: string[],
): Map<string, AdjudicatorEvidence> {
  // Group ALL cases by file (pass + fail); unfiled → "(unfiled)"
  const byFile = new Map<string, QaCase[]>();
  for (const c of cases) {
    const key = c.file ?? "(unfiled)";
    let bucket = byFile.get(key);
    if (!bucket) {
      bucket = [];
      byFile.set(key, bucket);
    }
    bucket.push(c);
  }

  const result = new Map<string, AdjudicatorEvidence>();
  for (const [file, fileCases] of byFile) {
    const failed = fileCases.filter((c) => c.status === "fail" || c.status === "flaky");
    const presence = presenceByFile.get(file) ?? { allUnique: false, absentKeysCount: 0 };

    const evidence: AdjudicatorEvidence = {
      isCode: false, // triage runs e2e only
      allUnique: presence.allUnique,
      failureDetails: failed.map((c) => c.detail ?? ""),
      failureClasses: failed.map((c) => classifyFailure(c.detail ?? "")),
      absentKeysCount: presence.absentKeysCount,
      gateSpend: false, // post-loop: no retry to spend; makes Rule 4 inert → Rule 5 fires (ISSUE)
      gateReason: "triage (post-loop)",
      devHealthy: true, // decide only runs after infra-error is already routed upstream
      mode,
      objectiveSource,
      failingFiles: failed.map((c) => c.file),
      httpStatuses: failed.map((c) => c.httpStatus),
      runtimeErrorsByCase: failed.map((c) => c.runtimeErrors ?? []),
    };
    result.set(file, evidence);
  }
  return result;
}

// ── `triagePublish` ──────────────────────────────────────────────────────────

/**
 * Pure triage function. Classifies each spec file into PR / ISSUE / DROP using the
 * first-match decision table (T0–T5). Never throws; deterministic.
 *
 * Decision table (first match wins):
 *   T0: unfiled bucket + ≥1 fail → ISSUE
 *   T1: GRAVE reviewer tag (attributed, not unattributable) → DROP
 *   T2: no failing case + no GRAVE tag → PR
 *   T3: ≥1 fail + adjudicate → APP_DEFECT (5xx or isLikelyRealBug) → ISSUE
 *   T4: failing file + absentKeysCount>0 OR all-locator-fail + no real-bug → DROP
 *   T5: everything else (ambiguous / mixed / timeout-only) → ISSUE (conservative)
 *
 * Conservative bias: T4 is the ONLY failing-file drop path. Any co-present real-bug
 * signal wins → ISSUE. `allFilesGraveUnattributable` overrides T1→ISSUE for the case
 * where the reviewer gave a GRAVE correction with no attributable file (fail-safe).
 */
export function triagePublish(input: TriageInput): TriageResult {
  const { cases, presenceByFile, graveByFile, mode, objectiveSource, allFilesGraveUnattributable } = input;

  // Pre-compute per-file evidence
  const evidenceByFile = buildPerFileEvidence(cases, presenceByFile, mode, objectiveSource);

  const pr: string[] = [];
  const issue: FileVerdict[] = [];
  const drop: string[] = [];
  const reasons: Record<string, string> = {};

  // Iterate files in deterministic order (insertion order of the evidence map)
  for (const [file, evidence] of evidenceByFile) {
    const hasFail = evidence.failureDetails.length > 0;
    const isGrave = graveByFile.get(file) ?? false;

    // T0: unfiled bucket with ≥1 fail → ISSUE (never PR, never DROP)
    if (file === "(unfiled)" && hasFail) {
      const reason = "unattributable failure — unfiled cases routed to ISSUE";
      issue.push({ file, class: "generated_test_defect", reason });
      reasons[file] = reason;
      continue;
    }

    // T1: GRAVE reviewer tag → DROP (attributed) or ISSUE (unattributable)
    if (isGrave) {
      if (allFilesGraveUnattributable) {
        // Unattributable GRAVE → demote to ISSUE, NEVER drop
        const reason = "unattributable GRAVE reviewer correction — routed to ISSUE (safe)";
        issue.push({ file, class: "generated_test_defect", reason });
        reasons[file] = reason;
      } else {
        // Attributed GRAVE → DROP (affirmative test-defect from reviewer)
        const reason = "GRAVE reviewer correction — affirmative test defect";
        drop.push(file);
        reasons[file] = reason;
      }
      continue;
    }

    // T2: no failing case + no GRAVE tag → PR (good passing test)
    if (!hasFail) {
      pr.push(file);
      reasons[file] = "all cases passing, no grave reviewer tag";
      continue;
    }

    // T3: ≥1 fail → run adjudicator; APP_DEFECT (5xx or isLikelyRealBug) → ISSUE
    const verdict = adjudicate(evidence);
    if (verdict.class === ADJ_CLASS.APP_DEFECT) {
      const reason = `app defect: ${verdict.reason}`;
      issue.push({ file, class: verdict.class, reason });
      reasons[file] = reason;
      continue;
    }

    // T4: failing file + absentKeysCount>0 OR all-locator-fail (and NOT app_defect from T3)
    // Strict: ONLY fire when there is NO real-bug co-signal (T3 already handled that)
    const allLocator = evidence.failureClasses.length > 0 && evidence.failureClasses.every((c) => c === "locator");
    if (evidence.absentKeysCount > 0 || allLocator) {
      const reason =
        evidence.absentKeysCount > 0
          ? `${evidence.absentKeysCount} absent selector(s) — affirmative test defect`
          : "all failures are locator errors — affirmative test defect";
      drop.push(file);
      reasons[file] = reason;
      continue;
    }

    // T5: conservative fallback — ambiguous / mixed / timeout-only → ISSUE
    const reason = `ambiguous failure evidence — conservative ISSUE: ${verdict.reason}`;
    issue.push({ file, class: "generated_test_defect", reason });
    reasons[file] = reason;
  }

  return { pr, issue, drop, reasons };
}

// ── findDanglingPrSpecs (Spec-Req-4: never publish a broken subset) ───────────────

const MODULE_EXT_RE = /\.(spec\.ts|spec\.js|test\.ts|test\.js|d\.ts|tsx|ts|jsx|js|mjs|cjs|spec|test)$/i;
const RELATIVE_IMPORT_RE = /(?:from|import|require)\s*\(?\s*["'](\.[^"']+)["']/g;

// Normalize a module path/specifier to a comparable key: posix-normalized, no leading "./",
// no module extension, no trailing "/index".
function normalizeModulePath(p: string): string {
  const n = posixPath.normalize(p).replace(/^\.\//, "");
  return n.replace(MODULE_EXT_RE, "").replace(/\/index$/, "");
}

/**
 * Spec-Req-4 (quality-filtered-dual-publish): when only the green subset is published, a kept spec
 * that imports a sibling spec NOT in that subset (an ISSUE- or DROP-bucket file) would dangle once
 * that sibling is excluded from the commit — the committed suite would no longer compile. This is the
 * ONLY new failure that subsetting introduces (the whole-suite static gate already passed before the
 * decide step). Returns the PR-bucket files that must be DEMOTED to ISSUE so a broken subset is never
 * published.
 *
 * Resolves the design's open question with a deterministic STATIC IMPORT CHECK rather than a temp-dir
 * build or an isolated `playwright --list` spawn: precise for the exact failure mode, pure, and fully
 * unit-testable. Conservative — any relative import resolving to a non-published sibling spec demotes
 * the importer. `readSpec` returns a PR spec's source (null = unreadable → treated safe, since the
 * pre-decide whole-dir gate already compiled it with all files present).
 */
export function findDanglingPrSpecs(
  prFiles: string[],
  unpublishedSpecFiles: string[],
  readSpec: (file: string) => string | null,
): string[] {
  if (prFiles.length === 0 || unpublishedSpecFiles.length === 0) return [];
  const unpublishedKeys = new Set(unpublishedSpecFiles.map(normalizeModulePath));
  const dangling: string[] = [];
  for (const pr of prFiles) {
    const src = readSpec(pr);
    if (src === null) continue;
    const baseDir = posixPath.dirname(pr);
    let m: RegExpExecArray | null;
    let hit = false;
    RELATIVE_IMPORT_RE.lastIndex = 0;
    while (!hit && (m = RELATIVE_IMPORT_RE.exec(src)) !== null) {
      if (unpublishedKeys.has(normalizeModulePath(posixPath.join(baseDir, m[1]!)))) hit = true;
    }
    if (hit) dangling.push(pr);
  }
  return dangling;
}

// ── Private helpers ────────────────────────────────────────────────────────────

/** Split a failureDom string into "role: name" lines, filtering blanks. */
function buildDomLines(failureDom: string | undefined): string[] {
  if (!failureDom) return [];
  return failureDom.split("\n").filter((l) => l.trim());
}

/** Extract basename from a path. */
function basename(p: string): string {
  return p.replace(/.*[/\\]/, "");
}
