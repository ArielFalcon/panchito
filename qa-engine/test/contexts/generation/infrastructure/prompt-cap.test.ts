// qa-engine/test/contexts/generation/infrastructure/prompt-cap.test.ts
// Behavioral tests for the real, src/-free capDiff/capText fns (Sub-Plan 7.2 item 4). Ported
// verbatim from src/orchestrator/sanitizer.ts: capDiff is a DIFF-AWARE, relevance-ordered,
// per-file-section capper (distinct from capText's flat prose truncation) — a real capDiff already
// exists in src/, so this is a verbatim port, not a "one capper for both" decision. See the module
// header comment in prompt-cap.ts for the full rationale.
import { test } from "node:test";
import assert from "node:assert/strict";
import { capDiff, capText } from "@contexts/generation/infrastructure/prompt-cap.ts";

test("capDiff returns the diff unchanged when it is within the budget", () => {
  const diff = "diff --git a/src/foo.ts b/src/foo.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n";
  assert.equal(capDiff(diff, 10_000), diff);
});

// KNOWN BUG (parity-preserved, NOT fixed here — engram bugfix "sanitizer.ts capDiff silently drops
// first-file diff section when oversized"): `diff.split(/^(?=diff --git )/m)` treats rawSections[0]
// as an unconditional "preamble" even when the diff starts immediately with `diff --git` (the normal
// case) — so rawSections[0] IS the first file's section, never subjected to the budget check or the
// omitted-list. This is verified byte-for-byte identical against the REAL src/orchestrator/
// sanitizer.ts capDiff (a verbatim port), so these tests assert the REAL current behavior for parity,
// not the theoretically-correct behavior. A fix ships as its own declared change per the migration's
// bug-register protocol (Plan 6 addendum §3 / carried invariant), touching both sanitizer.ts and
// this port together — never silently inside a behavior-identical port.
test("capDiff — the FIRST file section is always kept regardless of budget (ported preamble quirk)", () => {
  const fileA = "diff --git a/src/a.ts b/src/a.ts\n@@ -1,1 +1,1 @@\n-oldA\n+newA\n";
  const fileB = "diff --git a/src/b.ts b/src/b.ts\n@@ -1,1 +1,1 @@\n-oldB\n+newB\n";
  const diff = fileA + fileB;
  // Budget fits fileA's section exactly; the KNOWN quirk keeps fileB too (fileA is treated as an
  // unconditional "preamble" that never increments `used`, so the budget check never actually bites
  // fileB here) — asserting the real ported behavior, not the naive "budget enforced" expectation.
  const out = capDiff(diff, fileA.length);
  assert.ok(out.startsWith(fileA), "fileA's whole section is kept first");
  assert.ok(out.includes("newB"), "KNOWN QUIRK: fileB is also kept — the budget did not bite it");
  assert.ok(out.includes("0 file(s) omitted"), "KNOWN QUIRK: the marker reports zero omissions");
});

test("capDiff — a first-file section LARGER than the budget is silently dropped (KNOWN BUG, ported verbatim)", () => {
  const huge1 = "diff --git a/src/huge1.ts b/src/huge1.ts\n" + "+line\n".repeat(2000);
  const small2 = "diff --git a/src/small2.ts b/src/small2.ts\n+x\n";
  const out = capDiff(huge1 + small2, 50);
  // KNOWN BUG: huge1 (the "preamble") fails the budget check but is `continue`d past the omitted-list
  // push too — it vanishes with NO trace. small2 (second file) is kept because `used` never moved.
  assert.ok(!out.includes("+line\n+line"), "huge1's content is gone");
  assert.ok(!out.includes("huge1"), "huge1 is NOT named as omitted — the bug: silent, untraceable loss");
  assert.ok(out.includes("small2.ts"), "small2 (the second file) survives, unaffected by the budget");
});

test("capDiff — a genuinely single-file diff over budget drops ALL content with no fallback (KNOWN BUG, ported verbatim)", () => {
  const oneHugeFile = "diff --git a/src/huge.ts b/src/huge.ts\n@@ -1,1 +1,1 @@\n" + "+line\n".repeat(5000);
  const out = capDiff(oneHugeFile, 100);
  // Full trace: a single-file diff produces exactly ONE rawSection (no second "diff --git " boundary
  // to split on), so `fileSections = rawSections.slice(1)` is EMPTY and the whole file content lives
  // in `preamble = rawSections[0]`. The loop's `continue` on the preamble means `kept` ends up EMPTY.
  // The "degenerate single-oversized-file" fallback is GUARDED by `fileSections.length > 0`, which is
  // FALSE here (fileSections is empty, not populated with the huge file) — so the fallback that is
  // SUPPOSED to hard-truncate a lone giant file never fires. Net result: the output is JUST the
  // marker text, zero real diff content, claiming "0 file(s) omitted" — the most severe form of the
  // same root-cause bug (registered in engram, not fixed here — verbatim parity port).
  assert.ok(!out.includes("+line"), "ALL of the huge file's real content is gone — not even hard-truncated");
  assert.ok(out.includes("0 file(s) omitted"), "the marker still falsely reports zero omissions");
  assert.ok(out.length < 200, "the output is just the marker text — the degenerate fallback never fired");
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
