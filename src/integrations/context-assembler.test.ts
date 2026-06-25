// Colocated tests for the ContextAssembler (Slice E / Phase 1b + Slice F / Phase 2).
// Covers: canonical ordering, per-section byte cap enforcement,
// scaffold-vs-verbatim language handling, section_sizes output,
// the lazy-producer path (Phase 1b), AND the global byte-budget enforcement
// added in Phase 2 (Slice F): budget overflow sheds lowest-priority sections,
// logs the action, and preserves higher-priority sections intact.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assemble, section, Section } from "./context-assembler";

// ── Canonical ordering ───────────────────────────────────────────────────────

test("assemble: sections are emitted in canonical role order regardless of input order", () => {
  const sections: Section[] = [
    section("task", "task", "## TASK\nconcrete objective"),
    section("working-rules", "stable-prefix", "## Working rules\ndo good work"),
    section("critical-recap", "critical-recap", "## Critical recap\nDO NOT hallucinate"),
    section("diff", "semi-stable", "## Diff\n+x"),
    section("dom", "volatile", "## DOM\nbutton: Submit"),
  ];
  const { text } = assemble(sections);

  // Verify all five roles appear and in the right relative order.
  const wpIdx = text.indexOf("Working rules");
  const diffIdx = text.indexOf("## Diff");
  const domIdx = text.indexOf("## DOM");
  const taskIdx = text.indexOf("## TASK");
  const recapIdx = text.indexOf("## Critical recap");

  assert.ok(wpIdx < diffIdx, "stable-prefix must come before semi-stable");
  assert.ok(diffIdx < domIdx, "semi-stable must come before volatile");
  assert.ok(domIdx < taskIdx, "volatile must come before task");
  assert.ok(taskIdx < recapIdx, "task must come before critical-recap");
});

test("assemble: priority within same role determines sub-order", () => {
  const sections: Section[] = [
    section("rule-b", "stable-prefix", "RULE_B", { priority: 2 }),
    section("rule-a", "stable-prefix", "RULE_A", { priority: 1 }),
    section("rule-c", "stable-prefix", "RULE_C", { priority: 3 }),
  ];
  const { text } = assemble(sections);
  const aIdx = text.indexOf("RULE_A");
  const bIdx = text.indexOf("RULE_B");
  const cIdx = text.indexOf("RULE_C");
  assert.ok(aIdx < bIdx, "priority 1 before priority 2");
  assert.ok(bIdx < cIdx, "priority 2 before priority 3");
});

test("assemble: TASK section index is after VOLATILE and before CRITICAL recap", () => {
  const sections: Section[] = [
    section("recap", "critical-recap", "RECAP_SENTINEL"),
    section("obj", "task", "TASK_SENTINEL"),
    section("dom-s", "volatile", "VOLATILE_SENTINEL"),
    section("rules", "stable-prefix", "STABLE_SENTINEL"),
    section("arch", "semi-stable", "SEMI_SENTINEL"),
  ];
  const { text } = assemble(sections);
  const volatileIdx = text.indexOf("VOLATILE_SENTINEL");
  const taskIdx = text.indexOf("TASK_SENTINEL");
  const recapIdx = text.indexOf("RECAP_SENTINEL");

  assert.ok(volatileIdx < taskIdx, "volatile comes before task");
  assert.ok(taskIdx < recapIdx, "task comes before critical-recap");
});

// ── Per-section byte cap ─────────────────────────────────────────────────────

test("assemble: content within maxBytes is passed through unchanged", () => {
  const content = "A".repeat(100);
  const s = section("s", "task", content, { maxBytes: 500 });
  const { text, sectionSizes } = assemble([s]);
  assert.equal(text, content);
  assert.equal(sectionSizes["s"], Buffer.byteLength(content, "utf8"));
});

test("assemble: content exceeding maxBytes is truncated with a visible marker (overflow=summarize)", () => {
  const longContent = "X".repeat(1000);
  const maxBytes = 50;
  const s = section("reviewer-corrections", "volatile", longContent, { maxBytes, overflow: "summarize" });
  const { text, sectionSizes } = assemble([s]);

  // The capped output must be shorter than the original.
  assert.ok(Buffer.byteLength(text, "utf8") < Buffer.byteLength(longContent, "utf8"));
  // The marker must be present so the operator can see it was capped.
  assert.match(text, /capped at 50 bytes/);
  // The sectionSizes entry must reflect the actual (capped) byte count.
  const reportedSize = sectionSizes["reviewer-corrections"]!;
  assert.ok(reportedSize > 0);
  // The reported size must be less than the original content's byte length.
  assert.ok(reportedSize < Buffer.byteLength(longContent, "utf8"), "capped section size must be less than original");
  // The total assembled text byte length must match reported size (single section).
  assert.equal(reportedSize, Buffer.byteLength(text, "utf8"));
});

// #6 regression: a cap that lands in the MIDDLE of a multi-byte UTF-8 sequence must not inject a
// U+FFFD replacement char, and the truncated content must be a TRUE byte ceiling (≤ maxBytes).
// "€" is 3 bytes (E2 82 AC); maxBytes=10 lands on the 4th char's lead byte (bytes 0-8 = 3 chars,
// byte 9 = start of the 4th) → the partial lead byte must be dropped, leaving 9 valid bytes.
test("assemble: a cap at a mid-multibyte boundary yields valid UTF-8 (no U+FFFD) within the ceiling", () => {
  const content = "€".repeat(20); // 60 bytes of 3-byte chars
  const maxBytes = 10;
  const { text, sectionSizes } = assemble([section("reviewer-corrections", "volatile", content, { maxBytes, overflow: "summarize" })]);

  // No replacement char anywhere in the output.
  assert.doesNotMatch(text, /�/, "no U+FFFD replacement char may appear");

  // Isolate the truncated CONTENT (everything before the appended cap marker line).
  const markerIdx = text.indexOf("\n…(section");
  assert.ok(markerIdx > 0, "the cap marker must be appended");
  const truncatedContent = text.slice(0, markerIdx);

  // The truncated content is a true byte ceiling and a whole number of complete code points.
  assert.ok(
    Buffer.byteLength(truncatedContent, "utf8") <= maxBytes,
    `truncated content (${Buffer.byteLength(truncatedContent, "utf8")} bytes) must be ≤ maxBytes (${maxBytes})`,
  );
  assert.equal(truncatedContent, "€€€", "exactly 3 whole '€' chars (9 bytes) fit under a 10-byte cap");
  // sectionSizes reflects the full (content + marker) byte length actually emitted.
  assert.equal(sectionSizes["reviewer-corrections"], Buffer.byteLength(text, "utf8"));
});

test("assemble: maxBytes=0 means uncapped (no truncation)", () => {
  const longContent = "Y".repeat(100_000);
  const s = section("diff", "semi-stable", longContent, { maxBytes: 0, language: "verbatim" });
  const { text, sectionSizes } = assemble([s]);
  assert.equal(text, longContent);
  assert.equal(sectionSizes["diff"], Buffer.byteLength(longContent, "utf8"));
});

// ── Overflow policy (FIX 2) ──────────────────────────────────────────────────

// FIX 2: an overflow="drop" section that exceeds maxBytes must be OMITTED entirely — never
// truncated mid-content (a half-cut instruction can read as a DIFFERENT instruction). This is
// the policy the production reviewer-corrections section declares (prompts.ts).
test("assemble: an overflow='drop' section over budget is omitted entirely (not truncated)", () => {
  const longContent = "Z".repeat(1000);
  const maxBytes = 50;
  const dropped = section("reviewer-corrections", "volatile", longContent, { maxBytes, overflow: "drop" });
  // A neighbouring task section proves the assembler keeps going after a drop.
  const keep = section("task", "task", "## TASK\nthe objective");
  const { text, sectionSizes } = assemble([dropped, keep]);

  // The over-budget drop section contributes NOTHING — no content, no marker, no size entry.
  assert.ok(!text.includes("Z"), "dropped section content must not appear");
  assert.doesNotMatch(text, /capped at 50 bytes/, "a dropped section must not emit a truncation marker");
  assert.ok(!("reviewer-corrections" in sectionSizes), "a dropped section must be absent from sectionSizes");
  // The other section is unaffected.
  assert.ok(text.includes("## TASK"), "non-overflowing sections must still be assembled");
  assert.ok("task" in sectionSizes, "the kept section must be in sectionSizes");
});

// FIX 2: an overflow='drop' section that is WITHIN budget passes through unchanged (drop only
// fires on overflow, never on in-budget content).
test("assemble: an overflow='drop' section within budget is passed through unchanged", () => {
  const content = "within budget";
  const s = section("reviewer-corrections", "volatile", content, { maxBytes: 500, overflow: "drop" });
  const { text, sectionSizes } = assemble([s]);
  assert.equal(text, content, "in-budget drop section must be emitted verbatim");
  assert.equal(sectionSizes["reviewer-corrections"], Buffer.byteLength(content, "utf8"));
});

// FIX 2: overflow='summarize' has no summarizer yet, so it DEGRADES to truncate-with-marker
// (the documented fallback) — same observable behaviour as before this fix for that policy.
test("assemble: an overflow='summarize' section over budget is truncated with a marker (degraded fallback)", () => {
  const longContent = "W".repeat(1000);
  const maxBytes = 40;
  const s = section("reviewer-corrections", "volatile", longContent, { maxBytes, overflow: "summarize" });
  const { text, sectionSizes } = assemble([s]);
  assert.match(text, /capped at 40 bytes/, "summarize must fall back to truncation-with-marker");
  assert.ok("reviewer-corrections" in sectionSizes, "a truncated section is still emitted (present in sectionSizes)");
  assert.ok(sectionSizes["reviewer-corrections"]! < Buffer.byteLength(longContent, "utf8"));
});

// ── Scaffold vs verbatim language ────────────────────────────────────────────

test("assemble: scaffold and verbatim sections coexist without modification", () => {
  // The assembler itself does NOT translate content (P4 is about the assembler tagging
  // sections, not transforming them). The test asserts the language tag is respected:
  // verbatim sections reach the output byte-for-byte (beyond cap), scaffold sections do too.
  const verbatimContent = "Contenido de usuario: comprobar el formulario de registro";
  const scaffoldContent = "## Working rules\nDo not navigate routes you have not explored.";

  const sections: Section[] = [
    section("user-guidance", "volatile", verbatimContent, { language: "verbatim" }),
    section("working-rules", "stable-prefix", scaffoldContent, { language: "scaffold" }),
  ];
  const { text } = assemble(sections);

  // Both sections reach the output unmodified (the assembler does not translate).
  assert.ok(text.includes(verbatimContent), "verbatim user content must appear unchanged");
  assert.ok(text.includes(scaffoldContent), "scaffold content must appear unchanged");
});

// ── section_sizes output ─────────────────────────────────────────────────────

test("assemble: sectionSizes maps every non-empty section id to its byte length", () => {
  const sections: Section[] = [
    section("a", "stable-prefix", "AAA"),
    section("b", "semi-stable", "BB"),
    section("c", "volatile", "CCCCC"),
    section("d", "task", "DDDD"),
    section("e", "critical-recap", "EE"),
  ];
  const { sectionSizes } = assemble(sections);

  assert.equal(sectionSizes["a"], 3);
  assert.equal(sectionSizes["b"], 2);
  assert.equal(sectionSizes["c"], 5);
  assert.equal(sectionSizes["d"], 4);
  assert.equal(sectionSizes["e"], 2);
});

test("assemble: empty sections are omitted from sectionSizes", () => {
  const sections: Section[] = [
    section("present", "task", "content"),
    section("empty", "volatile", ""),
  ];
  const { sectionSizes } = assemble(sections);

  assert.ok("present" in sectionSizes, "non-empty section must be in sectionSizes");
  assert.ok(!("empty" in sectionSizes), "empty section must be omitted from sectionSizes");
});

test("assemble: sectionSizes byte counts match actual assembled content lengths", () => {
  // Use non-ASCII content to stress-test UTF-8 byte length calculation.
  const emoji = "🚀";
  const s = section("emoji-section", "task", emoji);
  const { text, sectionSizes } = assemble([s]);
  // The emoji is 4 bytes in UTF-8.
  assert.equal(sectionSizes["emoji-section"], Buffer.byteLength(emoji, "utf8"));
  assert.equal(Buffer.byteLength(text, "utf8"), Buffer.byteLength(emoji, "utf8"));
});

// ── Lazy producer path ───────────────────────────────────────────────────────

test("assemble: content can be a lazy producer function (resolved at assembly time)", () => {
  let calls = 0;
  const producer = () => {
    calls++;
    return "PRODUCED_CONTENT";
  };
  const s = section("lazy", "task", producer);
  const { text } = assemble([s]);
  assert.equal(calls, 1, "producer must be called exactly once");
  assert.ok(text.includes("PRODUCED_CONTENT"));
});

// ── section() helper defaults ────────────────────────────────────────────────

test("section() helper fills in sensible defaults", () => {
  const s = section("x", "task", "content");
  assert.equal(s.priority, 0);
  assert.equal(s.maxBytes, 0);
  assert.equal(s.cacheable, false);
  assert.equal(s.overflow, "drop");
  assert.equal(s.language, "scaffold");
});

test("section() helper accepts explicit overrides", () => {
  const s = section("x", "volatile", "content", {
    priority: 5,
    maxBytes: 1000,
    cacheable: true,
    overflow: "summarize",
    language: "verbatim",
  });
  assert.equal(s.priority, 5);
  assert.equal(s.maxBytes, 1000);
  assert.equal(s.cacheable, true);
  assert.equal(s.overflow, "summarize");
  assert.equal(s.language, "verbatim");
});

// ── Canonical structure with assemble() = P3 spec assertion ─────────────────

test("assemble: a realistic multi-section prompt has canonical structure (P3 spec)", () => {
  // Simulates what buildPrompt and buildReviewerPrompt declare.
  const sections: Section[] = [
    section("engram-rule", "stable-prefix", "engram: scoped per app", { priority: 10 }),
    section("playwright-rules", "stable-prefix", "## Working rules\nPrefer getByRole.", { priority: 5 }),
    section("diff", "semi-stable", "```diff\n+new feature\n```", { language: "verbatim" }),
    section("arch-map", "semi-stable", "## Architecture context\nroutes: /checkout", { priority: 2 }),
    section("dom-snapshot", "volatile", "## Live DEV DOM\nbutton: Submit", { priority: 1 }),
    section("review-corrections", "volatile", "## Reviewer corrections\n- fix selector", { priority: 2 }),
    section("objective", "task", "## Objective\nconfirm user sees discount", { priority: 1 }),
    section("acceptance-rule", "task", "MUST fail if regression", { priority: 2 }),
    section("critical-bottom", "critical-recap", "## Critical recap\nWRITE the file."),
  ];

  const { text, sectionSizes } = assemble(sections);

  // Verify role ordering.
  const stableIdx = text.indexOf("Working rules");
  const archIdx = text.indexOf("Architecture context");
  const diffIdx = text.indexOf("```diff");
  const domIdx = text.indexOf("Live DEV DOM");
  const correctionsIdx = text.indexOf("Reviewer corrections");
  const objectiveIdx = text.indexOf("## Objective");
  const recapIdx = text.indexOf("## Critical recap");

  // stable-prefix before semi-stable.
  assert.ok(stableIdx < archIdx, "stable-prefix before semi-stable");
  // semi-stable before volatile (both diff and dom are after arch).
  assert.ok(archIdx < domIdx, "semi-stable before volatile");
  // volatile before task.
  assert.ok(domIdx < objectiveIdx, "volatile before task");
  assert.ok(correctionsIdx < objectiveIdx, "corrections (volatile) before task");
  // task before critical-recap.
  assert.ok(objectiveIdx < recapIdx, "task before critical-recap");

  // All sections present in sectionSizes.
  const expectedIds = [
    "engram-rule", "playwright-rules", "diff", "arch-map",
    "dom-snapshot", "review-corrections", "objective", "acceptance-rule", "critical-bottom",
  ];
  for (const id of expectedIds) {
    assert.ok(id in sectionSizes, `sectionSizes must contain '${id}'`);
    assert.ok(sectionSizes[id]! > 0, `sectionSizes['${id}'] must be > 0`);
  }
});

// ── Phase 2 / Slice F: Global byte-budget enforcement ────────────────────────
// These tests verify the OUTER global budget layer added in Phase 2.

// Helper: count bytes of a string (UTF-8).
function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

test("assemble: no budgetBytes option preserves original Phase-1 behaviour (no global cap)", () => {
  // Without budgetBytes, even a very large total is not trimmed.
  const bigContent = "A".repeat(100_000);
  const sections = [section("big", "volatile", bigContent, { overflow: "summarize" })];
  const { text } = assemble(sections); // no opts
  assert.equal(text, bigContent, "without budgetBytes the content must pass through unchanged");
});

test("assemble: budgetBytes=0 disables the global budget (same as omitting it)", () => {
  const bigContent = "B".repeat(100_000);
  const sections = [section("big", "volatile", bigContent, { overflow: "summarize" })];
  const { text } = assemble(sections, { budgetBytes: 0 });
  assert.equal(text, bigContent, "budgetBytes=0 must be treated as no budget");
});

test("assemble: prompt within budget is emitted unchanged (no shedding needed)", () => {
  const content = "C".repeat(50);
  const sections = [
    section("rules", "stable-prefix", content),
    section("task", "task", content),
  ];
  const bigBudget = 100_000;
  const { text, sectionSizes } = assemble(sections, { budgetBytes: bigBudget });
  // Both sections fit comfortably — nothing is shed.
  assert.ok(text.includes(content), "content must survive when within budget");
  assert.ok("rules" in sectionSizes, "both sections must be in sectionSizes when within budget");
  assert.ok("task" in sectionSizes, "both sections must be in sectionSizes when within budget");
});

test("assemble: overflow budget sheds the lowest-priority volatile section first (overflow='drop')", () => {
  // low-priority volatile (priority 10) must be shed before high-priority volatile (priority 1).
  const highPriContent = "H".repeat(100);
  const lowPriContent  = "L".repeat(200);
  const sections = [
    section("high-pri-vol", "volatile",      highPriContent, { priority: 1, overflow: "drop" }),
    section("low-pri-vol",  "volatile",      lowPriContent,  { priority: 10, overflow: "drop" }),
    section("task",         "task",          "T".repeat(10), { priority: 1 }),
    section("rules",        "stable-prefix", "R".repeat(10), { priority: 1 }),
  ];

  // Total without shedding: 100 + 200 + 10 + 10 = 320 bytes.
  // Budget of 150 bytes forces the low-priority volatile to be shed (200 bytes).
  // After shed: 100 + 10 + 10 = 120 bytes ≤ 150 budget.
  const budgetBytes = 150;
  const { text, sectionSizes } = assemble(sections, { budgetBytes });

  // High-priority volatile survives.
  assert.ok(text.includes(highPriContent), "high-priority volatile section must survive budget enforcement");
  assert.ok("high-pri-vol" in sectionSizes, "high-priority volatile must be in sectionSizes");

  // Low-priority volatile is shed.
  assert.ok(!text.includes(lowPriContent), "low-priority volatile section must be shed");
  assert.ok(!("low-pri-vol" in sectionSizes), "shed section must be absent from sectionSizes");

  // The surviving sections + task + rules keep the total within budget.
  // D1+D2: a shed-notice is appended after the budget check and is excluded from the budget assertion.
  const textWithoutNotice = text.split("\n⚠ Budget:")[0]!;
  assert.ok(byteLen(textWithoutNotice) <= budgetBytes, `total without notice (${byteLen(textWithoutNotice)}) must be ≤ budget (${budgetBytes})`);
});

test("assemble: budget enforcement sheds volatile before semi-stable before task", () => {
  // volatile sections are shed before semi-stable, which are shed before task.
  // This test forces enough overflow that both volatile AND semi-stable must go.
  const volatileContent   = "V".repeat(200);
  const semiStableContent = "S".repeat(200);
  const taskContent       = "T".repeat(50);
  const stableContent     = "R".repeat(20);

  const sections = [
    section("dom",     "volatile",      volatileContent,   { priority: 1, overflow: "drop" }),
    section("arch",    "semi-stable",   semiStableContent, { priority: 1, overflow: "drop" }),
    section("task",    "task",          taskContent,       { priority: 1, overflow: "drop" }),
    section("rules",   "stable-prefix", stableContent,     { priority: 1, overflow: "drop" }),
  ];

  // Total: 200 + 200 + 50 + 20 = 470 bytes.
  // Budget: 75 bytes → only task (50) + rules (20) = 70 bytes survive.
  const budgetBytes = 75;
  const { text, sectionSizes } = assemble(sections, { budgetBytes });

  // task and stable-prefix survive (load-bearing, shed last).
  assert.ok(text.includes(taskContent),   "task must survive — it is load-bearing");
  assert.ok(text.includes(stableContent), "stable-prefix must survive — it is load-bearing");
  assert.ok("task"  in sectionSizes, "task must be in sectionSizes");
  assert.ok("rules" in sectionSizes, "stable-prefix must be in sectionSizes");

  // volatile and semi-stable are shed.
  assert.ok(!text.includes(volatileContent),   "volatile section must be shed before semi-stable");
  assert.ok(!text.includes(semiStableContent), "semi-stable section must be shed before task");
  assert.ok(!("dom"  in sectionSizes), "shed volatile must be absent from sectionSizes");
  assert.ok(!("arch" in sectionSizes), "shed semi-stable must be absent from sectionSizes");

  // D1+D2: a shed-notice is appended after the budget check and is excluded from the budget assertion.
  const textWithoutNotice = text.split("\n⚠ Budget:")[0]!;
  assert.ok(byteLen(textWithoutNotice) <= budgetBytes, `total without notice (${byteLen(textWithoutNotice)}) must be ≤ budget (${budgetBytes})`);
});

// ── FIX 5: the Context Pack survives shedding OVER the diff (shedAs override) ──────────────
test("FIX 5: under a tight budget the Context Pack survives and the diff (TASK band) is shed FIRST", () => {
  // Mirrors buildPromptAssembled's real section setup: the pack is in the VOLATILE band for READING
  // (near the task) but declares shedAs:"critical-recap" so it is least-shedable. The raw diff lives
  // in the TASK section (recoverable via `git show`). Before FIX 5, VOLATILE shed first → the pack
  // (unrecoverable DOM ground-truth) died while the recoverable diff survived. This asserts the EFFECT.
  const packContent = "PACK-DOM-GROUND-TRUTH-".repeat(20); // ~440 bytes, the unrecoverable pack
  const diffContent = "DIFF-".repeat(40);                  // 200 bytes, lives in TASK, recoverable
  const rulesContent = "R".repeat(20);

  const sections = [
    section("working-rules", "stable-prefix", rulesContent, { priority: 1 }),
    // The pack: positioned VOLATILE, but shedAs critical-recap (least-shedable).
    section("context-pack", "volatile", packContent, { priority: 0, shedAs: "critical-recap" }),
    // The task carries the diff.
    section("task", "task", diffContent, { priority: 1 }),
  ];

  // Total ~660 bytes; budget forces dropping ~one section. The diff (TASK) must go before the pack.
  const budgetBytes = 480;
  const { text, sectionSizes } = assemble(sections, { budgetBytes });

  assert.ok(text.includes(packContent), "the Context Pack (unrecoverable DOM) must SURVIVE the budget squeeze");
  assert.ok("context-pack" in sectionSizes, "pack must remain in sectionSizes");
  assert.ok(!text.includes(diffContent), "the diff (TASK band, recoverable via git show) must be shed FIRST");
  assert.ok(!("task" in sectionSizes), "the shed diff/task must be absent from sectionSizes");
  // D1+D2: a shed-notice is appended after the budget check and is excluded from the budget assertion.
  const textWithoutNotice = text.split("\n⚠ Budget:")[0]!;
  assert.ok(byteLen(textWithoutNotice) <= budgetBytes, `total without notice (${byteLen(textWithoutNotice)}) must be ≤ budget (${budgetBytes})`);
});

// FIX D: shedAs must change ONLY the shed precedence, never the canonical ASSEMBLY order. Under a
// non-shedding (large) budget the Context Pack — a VOLATILE section that declares shedAs:"critical-recap"
// to be least-shedable — must still render in its VOLATILE position (after semi-stable, before task),
// NOT down in the critical-recap slot. This pins the invariant that shedAs is purely a shed-band hint.
test("FIX D: a shedAs:'critical-recap' VOLATILE section renders in its VOLATILE position under a large budget", () => {
  const sections: Section[] = [
    section("rules", "stable-prefix", "STABLE_SENTINEL"),
    section("arch", "semi-stable", "SEMI_SENTINEL"),
    // The Context Pack: positioned VOLATILE for reading, but shedAs critical-recap (least-shedable).
    section("context-pack", "volatile", "PACK_SENTINEL", { shedAs: "critical-recap" }),
    section("task", "task", "TASK_SENTINEL"),
    section("recap", "critical-recap", "RECAP_SENTINEL"),
  ];
  // A budget far larger than the total → NO shedding happens, so only canonical assembly order is exercised.
  const { text, sectionSizes } = assemble(sections, { budgetBytes: 1_000_000 });

  const semiIdx = text.indexOf("SEMI_SENTINEL");
  const packIdx = text.indexOf("PACK_SENTINEL");
  const taskIdx = text.indexOf("TASK_SENTINEL");
  const recapIdx = text.indexOf("RECAP_SENTINEL");

  // Everything survives (nothing shed under the huge budget).
  assert.ok("context-pack" in sectionSizes, "the pack must survive a non-shedding budget");
  // Canonical VOLATILE position: AFTER semi-stable and BEFORE task — its shedAs band is ignored for ordering.
  assert.ok(semiIdx < packIdx, "shedAs must NOT move the pack before semi-stable (canonical order unchanged)");
  assert.ok(packIdx < taskIdx, "the pack renders in its VOLATILE slot, before the task — not in the critical-recap slot");
  assert.ok(taskIdx < recapIdx, "task still precedes the real critical-recap section");
  // The pack must NOT be rendered down at the critical-recap position despite shedAs:"critical-recap".
  assert.ok(packIdx < recapIdx, "shedAs:'critical-recap' must not push the pack into the recap slot");
});

test("FIX 5: WITHOUT shedAs, a volatile section is still shed before the task (the old, unwanted behavior — control)", () => {
  // Control proving shedAs is what changes the outcome: an ordinary volatile section (no shedAs) sheds
  // before the task, exactly the path that killed the pack before the fix.
  const volatileContent = "V".repeat(440);
  const diffContent = "DIFF-".repeat(40);
  const sections = [
    section("ordinary-volatile", "volatile", volatileContent, { priority: 0 }), // no shedAs
    section("task", "task", diffContent, { priority: 1 }),
  ];
  const { text } = assemble(sections, { budgetBytes: 300 });
  assert.ok(!text.includes(volatileContent), "an ordinary volatile section sheds first (no shedAs)");
  assert.ok(text.includes(diffContent), "the task survives over an ordinary volatile section");
});

test("assemble: overflow='summarize' in global budget truncates rather than drops", () => {
  // A section with overflow='summarize' must be truncated (not dropped entirely)
  // when the global budget forces action, so some content survives.
  // We use a generous budget (400 bytes) so that the truncated content + task both fit,
  // proving truncation is used (not drop).
  const bigContent = "S".repeat(1000); // 1000 bytes
  const taskContent = "T".repeat(20);  // 20 bytes
  const sections = [
    section("big-volatile", "volatile", bigContent, { priority: 1, overflow: "summarize" }),
    section("task",         "task",     taskContent, { priority: 1 }),
  ];
  // Budget = 400 bytes. big-volatile (1000 bytes) must be truncated to ~380 bytes (leaving
  // room for task). The result must be shorter than the original but not absent.
  const budgetBytes = 400;
  const { text, sectionSizes } = assemble(sections, { budgetBytes });

  // Both sections survive: task is not shed (400 > 20), big-volatile is truncated.
  assert.ok(text.includes(taskContent), "task must survive within the 400-byte budget");
  // The volatile section is truncated (not dropped): it still appears in sectionSizes.
  assert.ok("big-volatile" in sectionSizes, "truncated volatile must still appear in sectionSizes (not dropped)");
  // The assembled text is shorter than the original 1000-byte content would have been.
  assert.ok(byteLen(text) < 1000 + 20, "total must be shorter than original (truncation applied)");
  assert.ok(byteLen(text) <= budgetBytes, `total (${byteLen(text)}) must be ≤ budget (${budgetBytes})`);
  // The marker must appear to signal truncation (not silent truncation).
  assert.match(text, /capped at \d+ bytes/, "truncation marker must be present (no silent truncation)");
});

test("assemble: canonical role order is preserved even after budget shedding", () => {
  // After some sections are shed, the surviving sections must still appear in
  // canonical order (stable-prefix → semi-stable → volatile → task → critical-recap).
  const sections = [
    section("stable",  "stable-prefix", "STABLE".repeat(5),   { priority: 1, overflow: "drop" }),
    section("semi",    "semi-stable",   "SEMI".repeat(50),    { priority: 1, overflow: "drop" }),
    section("vol",     "volatile",      "VOL".repeat(5),      { priority: 1, overflow: "drop" }),
    section("task",    "task",          "TASK".repeat(5),     { priority: 1, overflow: "drop" }),
    section("recap",   "critical-recap","RECAP".repeat(5),    { priority: 1, overflow: "drop" }),
  ];
  // Total: 30 + 200 + 30 + 20 + 25 = 305 bytes. Budget forces shed of semi (200 bytes).
  const budgetBytes = 110;
  const { text } = assemble(sections, { budgetBytes });

  const stableIdx = text.indexOf("STABLE");
  const volIdx    = text.indexOf("VOL");
  const taskIdx   = text.indexOf("TASK");
  const recapIdx  = text.indexOf("RECAP");

  if (stableIdx >= 0 && volIdx >= 0) {
    assert.ok(stableIdx < volIdx, "stable-prefix must precede volatile after budget enforcement");
  }
  if (volIdx >= 0 && taskIdx >= 0) {
    assert.ok(volIdx < taskIdx, "volatile must precede task after budget enforcement");
  }
  if (taskIdx >= 0 && recapIdx >= 0) {
    assert.ok(taskIdx < recapIdx, "task must precede critical-recap after budget enforcement");
  }
});

test("assemble: budget enforcement respects per-section inner caps (both layers stack)", () => {
  // A section with a per-section maxBytes cap (inner cap) that also needs global shedding
  // should have the inner cap already applied before the global budget sees it.
  // Here: inner-capped volatile → already truncated to 50 bytes before the budget check.
  const content = "I".repeat(1000);
  const sections = [
    section("capped-vol", "volatile", content, { priority: 1, maxBytes: 50, overflow: "summarize" }),
    section("task",       "task",     "T".repeat(20), { priority: 1 }),
  ];
  // Budget of 200 bytes — the inner-capped volatile is already ≤ 50+marker bytes,
  // so the global budget should not need to shed it.
  const { text, sectionSizes } = assemble(sections, { budgetBytes: 200 });

  // Both sections survive (inner cap brought volatile well under the global budget).
  assert.ok(text.includes("T".repeat(20)), "task must survive");
  assert.ok("capped-vol" in sectionSizes, "inner-capped volatile must survive the global budget check");
  assert.ok(byteLen(text) <= 200, "total must be ≤ global budget");
});

test("assemble: global budget shedding does not affect sectionSizes for surviving sections", () => {
  // sectionSizes for a surviving section must reflect its actual byte length,
  // regardless of whether other sections were shed by the global budget.
  const surviveContent = "X".repeat(100);
  const shedContent    = "Y".repeat(200);
  const sections = [
    section("survive", "stable-prefix", surviveContent, { priority: 1 }),
    section("shed",    "volatile",      shedContent,    { priority: 1, overflow: "drop" }),
  ];
  // Budget of 110 bytes: stable-prefix (100) fits; volatile (200) must be shed.
  const { sectionSizes } = assemble(sections, { budgetBytes: 110 });

  assert.ok("survive" in sectionSizes, "surviving section must be in sectionSizes");
  assert.equal(sectionSizes["survive"], byteLen(surviveContent), "sectionSizes must reflect the surviving section's actual byte count");
  assert.ok(!("shed" in sectionSizes), "shed section must be absent from sectionSizes");
});

// ── D1+D2: budget-shed notice injected into assembled output ─────────────────
//
// When the global budget enforcement drops one or more sections, a small notice is appended to
// the assembled text naming the dropped section ids so the agent knows to explore them directly.
// Regression contract: when NOTHING is dropped, output is unchanged (no notice, no empty header).

// D1+D2-1: a forced over-budget drop produces the notice naming the dropped section id.
test("D1+D2: a forced budget-drop injects a notice naming the dropped section id", () => {
  const SURVIVE = "SURVIVE_MARKER";
  const sections = [
    section("survive", "stable-prefix", SURVIVE, { priority: 1 }),
    section("context-pack", "volatile", "Y".repeat(300), { priority: 1, overflow: "drop" }),
  ];
  // Budget forces the volatile section to be shed (300 > budget after stable).
  const { text } = assemble(sections, { budgetBytes: 150 });

  // The notice must be present and must name the dropped id.
  assert.match(
    text,
    /Budget.*omitted|omitted.*Budget/i,
    "the assembled text must contain a budget-shed notice",
  );
  assert.ok(
    text.includes("context-pack"),
    "the notice must name the dropped section id ('context-pack')",
  );
  // The surviving content is still present.
  assert.ok(text.includes(SURVIVE), "surviving content must still be present");
});

// D1+D2-2: the notice must always survive — it must remain even when the budget is very tight.
// We verify it is present alongside the stable-prefix (which is the last to shed).
test("D1+D2: the shed notice survives even under extreme budget pressure", () => {
  const stableContent = "R".repeat(50);
  const sections = [
    section("rules", "stable-prefix", stableContent, { priority: 1 }),
    section("dom-pack", "volatile",   "V".repeat(300), { priority: 1, overflow: "drop" }),
    section("arch",     "semi-stable","S".repeat(200), { priority: 1, overflow: "drop" }),
  ];
  // Very tight budget — only stable-prefix (50 bytes) fits plus the notice.
  const { text } = assemble(sections, { budgetBytes: 300 });

  assert.ok(
    /Budget.*omitted|omitted.*Budget/i.test(text) || text.includes("dom-pack") || text.includes("arch"),
    "the notice must mention at least one dropped section id",
  );
  // The shed notice must appear — it is tiny and always-surviving.
  const hasNotice = /Budget.*omitted|omitted.*Budget/i.test(text);
  assert.ok(hasNotice, "shed notice must be present under extreme budget pressure");
});

// D1+D2-3 (regression): when NOTHING is dropped, the output is unchanged — no notice, no empty header.
test("D1+D2: no shed notice when nothing is dropped (regression: output unchanged)", () => {
  const content = "A".repeat(50);
  const sections = [
    section("task",  "task",          content),
    section("rules", "stable-prefix", content),
  ];
  const { text } = assemble(sections, { budgetBytes: 100_000 });

  // Output must not contain any budget-shed notice.
  assert.doesNotMatch(
    text,
    /Budget.*omitted|omitted.*Budget/i,
    "no shed notice must appear when nothing was dropped",
  );
  // Output is the two contents joined normally.
  assert.ok(text.includes(content), "non-shed content must appear");
});

// D1+D2-4 (regression): without a budgetBytes option (Phase-1 behaviour), the notice must never appear.
test("D1+D2: no shed notice without budgetBytes option (phase-1 behaviour unchanged)", () => {
  const sections = [
    section("task", "task", "TASK_CONTENT"),
    section("huge", "volatile", "H".repeat(1_000_000), { overflow: "drop" }),
  ];
  // No budgetBytes — Phase-1 behaviour; the large section passes through uncapped (maxBytes=0).
  const { text } = assemble(sections);
  assert.doesNotMatch(
    text,
    /Budget.*omitted|omitted.*Budget/i,
    "no shed notice must appear when budgetBytes is not provided",
  );
});
