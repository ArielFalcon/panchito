// Colocated tests for the ContextAssembler (Slice E / Phase 1b).
// Covers: canonical ordering, per-section byte cap enforcement,
// scaffold-vs-verbatim language handling, section_sizes output,
// and the lazy-producer path.

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

test("assemble: content exceeding maxBytes is truncated with a visible marker", () => {
  const longContent = "X".repeat(1000);
  const maxBytes = 50;
  const s = section("reviewer-corrections", "volatile", longContent, { maxBytes });
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

test("assemble: maxBytes=0 means uncapped (no truncation)", () => {
  const longContent = "Y".repeat(100_000);
  const s = section("diff", "semi-stable", longContent, { maxBytes: 0, language: "verbatim" });
  const { text, sectionSizes } = assemble([s]);
  assert.equal(text, longContent);
  assert.equal(sectionSizes["diff"], Buffer.byteLength(longContent, "utf8"));
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
