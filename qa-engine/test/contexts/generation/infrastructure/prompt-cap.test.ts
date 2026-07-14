// qa-engine/test/contexts/generation/infrastructure/prompt-cap.test.ts
// Behavioral tests for the real, src/-free capDiff/capText fns (Sub-Plan 7.2 item 4). Ported
// verbatim from src/orchestrator/sanitizer.ts: capDiff is a DIFF-AWARE, relevance-ordered,
// per-file-section capper (distinct from capText's flat prose truncation) — a real capDiff already
// exists in src/, so this is a verbatim port, not a "one capper for both" decision. See the module
// header comment in prompt-cap.ts for the full rationale.
import { test } from "node:test";
import assert from "node:assert/strict";
import { capDiff, capText, extractDiffFilePath } from "@contexts/generation/infrastructure/prompt-cap.ts";

test("capDiff returns the diff unchanged when it is within the budget", () => {
  const diff = "diff --git a/src/foo.ts b/src/foo.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n";
  assert.equal(capDiff(diff, 10_000), diff);
});

// migration-tier-4c Slice 5b (task 5b.5 — re-deriving the "second known prompts.ts bug" fresh at
// HEAD): the ONLY concretely-documented candidate found (engram bugfix #919, registered 2026-07-02 —
// predates the 2026-07-09 triage doc's un-detailed "2 known live bugs" note by a week, and sits
// directly on prompts.ts's diff-capping hot path via cappedDiffText -> capDiff). Per the project's
// own bug-register protocol ("fixes ship as separate declared changes with their own tests"), this
// task (5b.5) IS that declared change.
//
// BEFORE this fix: `diff.split(/^(?=diff --git )/m)` treats rawSections[0] as an unconditional
// "preamble" even when the diff starts immediately with `diff --git` (the normal case for a real git
// diff — the split's zero-width lookahead never yields a leading empty element) — so rawSections[0]
// IS the first file's real section, never subjected to the budget check or the omitted-list. Two
// compounding failure modes: (1) a multi-file diff whose first file is oversized vanishes with ZERO
// trace while a smaller second file survives "for free"; (2) a genuinely single-file diff over budget
// produces JUST the truncation marker with ZERO real content, falsely claiming "0 file(s) omitted"
// (the degenerate hard-truncate fallback never fires because `fileSections` stayed empty).
//
// AFTER this fix: rawSections[0] is treated as a REAL file section (folded into `fileSections` for
// relevance-sorting, budget-checking, and omission-naming) whenever it itself starts with its own
// "diff --git " header — a TRUE preamble (content before any file header, e.g. a `git log -p` prefix)
// is the only case still unconditionally kept.
test("capDiff FIX (2nd known bug): the first file section is now REAL — an oversized first file sheds and is correctly NAMED in the omitted list, not silently kept", () => {
  const fileA = "diff --git a/src/a.ts b/src/a.ts\n@@ -1,1 +1,1 @@\n-oldA\n+newA\n";
  const fileB = "diff --git a/src/b.ts b/src/b.ts\n@@ -1,1 +1,1 @@\n-oldB\n+newB\n";
  const diff = fileA + fileB;
  // Budget fits fileA exactly; fileA is now subject to the SAME budget check as any other file —
  // fileB no longer survives "for free" once fileA has consumed the whole budget.
  const out = capDiff(diff, fileA.length);
  assert.ok(out.startsWith(fileA), "fileA's whole section is still kept first (relevance-ordered, fits within budget)");
  assert.ok(!out.includes("newB"), "FIXED: fileB no longer survives for free — the budget now genuinely applies to fileA");
  assert.ok(out.includes("1 file(s) omitted"), "FIXED: the marker correctly reports the one real omission");
  assert.ok(out.includes("src/b.ts"), "FIXED: fileB is correctly NAMED in the omitted list");
});

test("capDiff FIX (2nd known bug): an oversized FIRST file is now correctly named as omitted — no more silent, untraceable loss", () => {
  const huge1 = "diff --git a/src/huge1.ts b/src/huge1.ts\n" + "+line\n".repeat(2000);
  const small2 = "diff --git a/src/small2.ts b/src/small2.ts\n+x\n";
  const out = capDiff(huge1 + small2, 50);
  assert.ok(!out.includes("+line\n+line"), "huge1's content is still gone (correctly — it does not fit the budget)");
  assert.ok(out.includes("huge1"), "FIXED: huge1 IS now named as omitted — no more silent, untraceable loss");
  assert.ok(out.includes("small2.ts"), "small2 (the second file) still survives — it fits within the remaining budget");
});

test("capDiff FIX (2nd known bug): a genuinely single-file diff over budget now hard-truncates via the degenerate fallback instead of dropping ALL content", () => {
  const oneHugeFile = "diff --git a/src/huge.ts b/src/huge.ts\n@@ -1,1 +1,1 @@\n" + "+line\n".repeat(5000);
  const out = capDiff(oneHugeFile, 100);
  // FIXED: a single-file diff now correctly populates `fileSections` with its one real section
  // (rawSections[0] is no longer misclassified as an empty-preamble-only case), so the degenerate
  // "hard-truncate the lone oversized file" fallback fires as originally intended.
  assert.ok(out.includes("+line"), "FIXED: the degenerate fallback now hard-truncates real content instead of dropping everything");
  assert.ok(out.startsWith("diff --git a/src/huge.ts"), "the hard-truncated content starts with the real file's own header");
  assert.ok(out.length >= 100, "the output now carries real (truncated) diff content, not just the marker text");
});

// migration-tier-4c Slice 5a: extractDiffFilePath was module-private; exported so prompts.ts's
// relocated cappedDiffText can pick a per-file-section sanitize mode by extension. Same parsing
// capDiff already uses internally — no new logic.
test("extractDiffFilePath extracts the post-rename (b/) path from a diff --git header", () => {
  const section = "diff --git a/src/old-name.ts b/src/new-name.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n";
  assert.equal(extractDiffFilePath(section), "src/new-name.ts");
});

test("extractDiffFilePath returns an empty string when the section has no diff --git header", () => {
  assert.equal(extractDiffFilePath("no header here\n+just content\n"), "");
});

test("capText returns text unchanged when within the budget", () => {
  const text = "a short commit body";
  assert.equal(capText(text, 4000), text);
});

test("capText hard-slices and appends a truncation marker when over budget", () => {
  const text = "x".repeat(5000);
  const out = capText(text, 100);
  assert.ok(out.startsWith("x".repeat(100)));
  assert.ok(out.includes("truncated"));
  assert.ok(out.length < text.length + 200); // marker adds bytes but stays far under the original
});

test("capDiff and capText are DISTINCT functions — capDiff preserves diff structure, capText does not", () => {
  assert.notEqual(capDiff, capText);
  const diffLike = "diff --git a/src/a.ts b/src/a.ts\n" + "+line\n".repeat(2000);
  const viaCapDiff = capDiff(diffLike, 200);
  const viaCapText = capText(diffLike, 200);
  // capText slices AT the byte boundary regardless of diff structure; capDiff keeps whole sections
  // or falls back to a structured omission marker — their outputs differ for the same oversized input.
  assert.notEqual(viaCapDiff, viaCapText);
});
