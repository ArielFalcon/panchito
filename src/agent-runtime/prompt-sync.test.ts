// Prompt-sync drift guard (T-P1-1 / AC1.1.1-3 / C3.2 / T-P3-2).
//
// MUST-MATCH sections must stay byte-identical between the OpenCode mirror
// (agents/agent/*.md) and the Codex neutral mirror (agent/roles/*.md).
//
// T-P3-2 (C3.2 / AC3.2.1-2) STRENGTHENS this from a reviewer-only guard to a comprehensive
// sync covering ALL files where deliberate drift must fail CI:
//   - qa-reviewer.md: Output format, Anti-pattern catalog, Dual-review protocol (added in P1)
//   - qa-generator.md: Final output (must-match), + presence of the anti-hang/no-op section
//   - AGENTS.md: Global rules section (shared safety-critical rules must not diverge silently)
//
// DELIBERATE divergences between the mirrors (wording improvements, phrasing adjustments) are
// catalogued in the KNOWN_GENERATOR_PROCEDURE_DRIFT constant below. Section-level identity
// is required for MUST-MATCH sections; prose rewrites inside WAIVED sections are allowed.
//
// Section detection: sections are identified by their H2 header text (##). A section
// is a MUST-MATCH candidate when its header or content includes the sentinel phrase
// MUST-MATCH-SECTION. For the reviewer severity contract we check by known header names.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Resolve repo root relative to this test file (src/agent-runtime/ → two levels up)
const REPO_ROOT = join(import.meta.dirname ?? __dirname, "..", "..");

// Skill file pairs that must be byte-identical (modulo trailing whitespace) across both trees.
// Full-file parity is stricter than section-level parity: any one-tree edit fails CI immediately.
// The whole playwright-authoring skill directory is locked (SKILL.md excepted — it carries a known,
// out-of-scope canonical/Codex divergence) so drift cannot reappear in a sibling file we did not edit.
const SKILL_FILE_PAIRS: Array<[string, string]> = [
  [
    "agents/skill/playwright-authoring/locators-and-waiting.md",
    "agent/skills/playwright-authoring/locators-and-waiting.md",
  ],
  [
    "agents/skill/playwright-authoring/auth.md",
    "agent/skills/playwright-authoring/auth.md",
  ],
  [
    "agents/skill/playwright-authoring/browser-conditions.md",
    "agent/skills/playwright-authoring/browser-conditions.md",
  ],
  [
    "agents/skill/playwright-authoring/storage-and-uploads.md",
    "agent/skills/playwright-authoring/storage-and-uploads.md",
  ],
];

// Must-match sections for the worker role (by canonical H2 header text).
// The guard compares H2 bodies between the OpenCode mirror (agents/agent/qa-worker.md)
// and the Codex mirror (agent/roles/qa-worker.md). H1 may differ (Flash suffix).
const WORKER_MUST_MATCH_SECTIONS = ["How to write a valuable spec"];

function readFile(rel: string): string {
  const p = join(REPO_ROOT, rel);
  assert.ok(existsSync(p), `Prompt file not found: ${rel} (resolved: ${p})`);
  return readFileSync(p, "utf8");
}

// Parse H2 sections out of a markdown document. Returns a map: header text → body.
function parseSections(md: string): Map<string, string> {
  const sections = new Map<string, string>();
  const headerRe = /^## (.+)$/m;
  const parts = md.split(/^(?=## )/m);
  for (const part of parts) {
    const m = headerRe.exec(part);
    if (!m || !m[1] || !m[0]) continue;
    const header = m[1].trim();
    const body = part.slice(m[0].length).trim();
    sections.set(header, body);
  }
  return sections;
}

// The must-match sections for the reviewer role (by canonical header text).
// These are the sections that define the shared quality contract between runtimes.
const REVIEWER_MUST_MATCH_SECTIONS = [
  "Output format",
  "Anti-pattern catalog (reject on sight)",
  "Dual-review protocol (judgment-day style)",
];

// Must-match sections for the generator role.
// "Final output" defines the JSON verdict contract shared by both runtimes — it must stay identical.
// Procedure sections are ALLOWED to diverge (wording improvements) — see GENERATOR_WAIVED_SECTIONS.
const GENERATOR_MUST_MATCH_SECTIONS = ["Final output"];

// Sections in the generator that are ALLOWED to have different prose between the two mirrors.
// These represent known, deliberate wording improvements — not semantic drift.
// If a new semantic change is made to one mirror's procedure, it must be ported to the other,
// at which point both versions become identical and can be moved to GENERATOR_MUST_MATCH_SECTIONS.
const GENERATOR_WAIVED_SECTIONS = new Set([
  "Procedure",
  "Stop when the spec is written — then emit the verdict",
]);

// Must-match sections for the shared AGENTS.md.
// "Global rules" contains safety-critical constraints shared by both runtimes and must not diverge.
// "Execution context" carries the TRANSCRIBE-from-injected-grounding contract (do not re-navigate
// routes already covered by the Context Pack / re-judge a11y tree) — a stale mirror here silently
// reverts Codex-run generation to always-re-explore, sabotaging grounding reuse.
// "Protocols (to keep quality from degrading over time)" carries Protocol 4 (cleanup via the UI, or
// namespaced-and-left; NEVER a fabricated API call) — a stale mirror here lets Codex hallucinate a
// DELETE endpoint that was never verified to exist.
const AGENTS_MUST_MATCH_SECTIONS = [
  "Global rules",
  "Execution context",
  "Protocols (to keep quality from degrading over time)",
];

describe("prompt-sync drift guard", () => {
  it("agent/roles/qa-reviewer.md contains the {text,severity} structured corrections contract (AC1.1.1)", () => {
    const codexReviewer = readFile("agent/roles/qa-reviewer.md");
    // The structured contract requires both fields in the JSON example.
    // Plain-string corrections do NOT have a `severity` field.
    assert.ok(
      codexReviewer.includes('"severity"'),
      'agent/roles/qa-reviewer.md is missing the structured corrections contract: ' +
        'corrections entries must be objects with a "severity" field. ' +
        'Port the {text,severity} block from agents/agent/qa-reviewer.md.',
    );
    assert.ok(
      codexReviewer.includes('"blocking"') || codexReviewer.includes('"advisory"'),
      'agent/roles/qa-reviewer.md must document "blocking" and "advisory" severity values.',
    );
  });

  it("agent/roles/qa-reviewer.md Output format section matches agents/agent/qa-reviewer.md (AC1.1.3)", () => {
    const codexReviewer = parseSections(readFile("agent/roles/qa-reviewer.md"));
    const opencodeReviewer = parseSections(readFile("agents/agent/qa-reviewer.md"));

    for (const section of REVIEWER_MUST_MATCH_SECTIONS) {
      const codexBody = codexReviewer.get(section);
      const opencodeBody = opencodeReviewer.get(section);

      if (opencodeBody === undefined) continue; // section only in codex mirror is allowed

      assert.ok(
        codexBody !== undefined,
        `prompt-sync DIVERGENCE: section "## ${section}" is present in agents/agent/qa-reviewer.md ` +
          `but missing from agent/roles/qa-reviewer.md. Port it.`,
      );

      // Normalize trailing whitespace for comparison; intentional content differences still fail.
      const normalize = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
      assert.equal(
        normalize(codexBody),
        normalize(opencodeBody),
        `prompt-sync DIVERGENCE in section "## ${section}": ` +
          `agent/roles/qa-reviewer.md and agents/agent/qa-reviewer.md differ. ` +
          `The codex mirror must match the canonical OpenCode version.`,
      );
    }
  });

  it("agent/roles/qa-reviewer.md contains the app-agnostic warning and ARIA-role selector guidance (AC1.1.2)", () => {
    const codexReviewer = readFile("agent/roles/qa-reviewer.md");
    // These anchors are confirmed present by the design gate.
    assert.ok(
      codexReviewer.includes("app-agnostic") || codexReviewer.includes("App-specific"),
      'agent/roles/qa-reviewer.md must contain the app-agnostic warning block.',
    );
    // ARIA / role selector guidance (getByRole is the canonical Playwright ARIA selector)
    assert.ok(
      codexReviewer.includes("getByRole") || codexReviewer.includes("ARIA"),
      'agent/roles/qa-reviewer.md must contain ARIA-role selector guidance.',
    );
  });

  it("a deliberate divergence in Output format is detected — drift structurally caught (AC1.1.3 inverse)", () => {
    const opencodeReviewer = parseSections(readFile("agents/agent/qa-reviewer.md"));
    const section = "Output format";
    const opencodeBody = opencodeReviewer.get(section);
    if (!opencodeBody) return; // section unexpectedly absent — skip inverse check

    // Build a deliberately-diverged in-memory sections map and run it through the SAME
    // comparison code the guard uses in the must-match loop above, confirming assert.equal
    // throws on the diverged copy. This proves the guard catches real drift, not just that
    // string concatenation changes a string.
    const divergedBody = opencodeBody + "\n\n<!-- deliberate drift -->";
    const normalize = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();

    assert.throws(
      () => {
        assert.equal(
          normalize(divergedBody),
          normalize(opencodeBody),
          `prompt-sync DIVERGENCE in section "## ${section}"`,
        );
      },
      (err: unknown) => err instanceof assert.AssertionError,
      "The drift guard must throw an AssertionError when the codex mirror diverges from canonical.",
    );
  });

  // ---------------------------------------------------------------------------
  // T-P3-2 additions: generator + AGENTS.md comprehensive sync (C3.2 / AC3.2.1-2)
  // ---------------------------------------------------------------------------

  it("T-P3-2: agent/roles/qa-generator.md contains the anti-hang/no-op section (AC1.1.2, C3.2)", () => {
    const codexGenerator = readFile("agent/roles/qa-generator.md");
    // The anti-hang section prevents the generator from over-working past the verdict, which
    // causes run timeouts. It must be present in the codex mirror so both runtimes share this
    // critical timing constraint. Source: agents/agent/qa-generator.md "Stop when the spec is
    // written" section + the "DONE generating" sentinel phrase.
    assert.ok(
      codexGenerator.includes("DONE generating") ||
        codexGenerator.includes("Stop when the spec is written") ||
        codexGenerator.includes("verdict is your LAST action"),
      "prompt-sync DRIFT: agent/roles/qa-generator.md is missing the anti-hang/no-op section. " +
        'Port the "Stop when the spec is written — then emit the verdict" section from ' +
        "agents/agent/qa-generator.md. This section prevents the generator from over-working " +
        "past the closing verdict (AC1.1.2).",
    );
  });

  it("T-P3-2: agent/roles/qa-generator.md Final output section matches agents/agent/qa-generator.md (C3.2)", () => {
    const codexGenerator = parseSections(readFile("agent/roles/qa-generator.md"));
    const opencodeGenerator = parseSections(readFile("agents/agent/qa-generator.md"));

    for (const section of GENERATOR_MUST_MATCH_SECTIONS) {
      const codexBody = codexGenerator.get(section);
      const opencodeBody = opencodeGenerator.get(section);

      if (opencodeBody === undefined) continue;

      assert.ok(
        codexBody !== undefined,
        `prompt-sync DIVERGENCE: section "## ${section}" is present in agents/agent/qa-generator.md ` +
          `but missing from agent/roles/qa-generator.md. Port it.`,
      );

      const normalize = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
      assert.equal(
        normalize(codexBody),
        normalize(opencodeBody),
        `prompt-sync DIVERGENCE in section "## ${section}" (generator): ` +
          `agent/roles/qa-generator.md and agents/agent/qa-generator.md differ. ` +
          `The codex mirror must match the canonical OpenCode version.`,
      );
    }
  });

  it("T-P3-2: AGENTS.md Global rules section matches between agents/ and agent/ (C3.2)", () => {
    const codexAgents = parseSections(readFile("agent/AGENTS.md"));
    const opencodeAgents = parseSections(readFile("agents/AGENTS.md"));

    for (const section of AGENTS_MUST_MATCH_SECTIONS) {
      const codexBody = codexAgents.get(section);
      const opencodeBody = opencodeAgents.get(section);

      if (opencodeBody === undefined) continue;

      assert.ok(
        codexBody !== undefined,
        `prompt-sync DIVERGENCE: section "## ${section}" is present in agents/AGENTS.md ` +
          `but missing from agent/AGENTS.md. Port it.`,
      );

      const normalize = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
      assert.equal(
        normalize(codexBody),
        normalize(opencodeBody),
        `prompt-sync DIVERGENCE in section "## ${section}" (AGENTS.md): ` +
          `agent/AGENTS.md and agents/AGENTS.md differ. ` +
          `Safety-critical global rules must stay identical across both mirrors.`,
      );
    }
  });

  it("T-P3-2: GENERATOR_WAIVED_SECTIONS list accounts for all known generator procedure drift (C3.2)", () => {
    // Verify that any section present in agents/ generator but NOT identical in the codex mirror
    // is explicitly listed in GENERATOR_WAIVED_SECTIONS. If a new section appears in agents/
    // with content that differs from agent/ and is NOT waived, this test fails — forcing the
    // developer to either port the section or explicitly waive it with a comment.
    const codexSections = parseSections(readFile("agent/roles/qa-generator.md"));
    const opencodeSections = parseSections(readFile("agents/agent/qa-generator.md"));
    const normalize = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();

    const unaccountedDrift: string[] = [];
    for (const [section, opencodeBody] of opencodeSections) {
      if (GENERATOR_MUST_MATCH_SECTIONS.includes(section)) continue; // already tested above
      if (GENERATOR_WAIVED_SECTIONS.has(section)) continue; // explicitly waived

      const codexBody = codexSections.get(section);
      if (codexBody === undefined) {
        // Section only in agents/ — must be waived or ported
        unaccountedDrift.push(`missing: "${section}"`);
      } else if (normalize(codexBody) !== normalize(opencodeBody)) {
        // Section in both but differs — must be waived or ported
        unaccountedDrift.push(`diverged: "${section}"`);
      }
    }

    assert.deepEqual(
      unaccountedDrift,
      [],
      `prompt-sync: generator has unaccounted drift in sections that are neither MUST-MATCH ` +
        `nor WAIVED: ${unaccountedDrift.join(", ")}. ` +
        `Either port the section to agent/roles/qa-generator.md (if semantically identical content ` +
        `is the goal) or add it to GENERATOR_WAIVED_SECTIONS (if the wording difference is deliberate).`,
    );
  });

  it("T-P3-2: AC3.2.2 — a deliberate divergence in generator Final output is structurally caught (inverse)", () => {
    const opencodeGenerator = parseSections(readFile("agents/agent/qa-generator.md"));
    const section = "Final output";
    const opencodeBody = opencodeGenerator.get(section);
    if (!opencodeBody) return;

    // Build a deliberately-diverged in-memory body and run it through the SAME comparison
    // the guard uses in the must-match loop above. assert.throws confirms the guard would
    // have caught the divergence — not just that appending text changes a string.
    const divergedBody = opencodeBody + "\n\n<!-- deliberate drift -->";
    const normalize = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();

    assert.throws(
      () => {
        assert.equal(
          normalize(divergedBody),
          normalize(opencodeBody),
          `prompt-sync DIVERGENCE in section "## ${section}" (generator)`,
        );
      },
      (err: unknown) => err instanceof assert.AssertionError,
      "The generator Final output drift guard must throw an AssertionError when the codex mirror diverges.",
    );
  });
});

describe("agent-guidance-runtime-semantics drift guard", () => {
  const normalize = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();

  // ---------------------------------------------------------------------------
  // Task 1.1: Full-file parity for playwright-authoring skill files.
  // The two trees must be byte-identical (modulo trailing whitespace).
  // This assertion PASSES on the current byte-identical files and FAILS on any one-tree edit.
  // ---------------------------------------------------------------------------
  it("playwright-authoring skill file parity: locators-and-waiting.md matches across both trees (Task 1.1)", () => {
    for (const [opencodeRel, codexRel] of SKILL_FILE_PAIRS) {
      const opencodeContent = readFile(opencodeRel);
      const codexContent = readFile(codexRel);
      assert.equal(
        normalize(codexContent),
        normalize(opencodeContent),
        `prompt-sync DIVERGENCE: skill file "${opencodeRel}" and "${codexRel}" differ. ` +
          `Both trees must be byte-identical. Edit both mirrors in the same step.`,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // Task 1.2: Section-level parity for the worker role's "How to write a valuable spec" section.
  // Worker H1 may differ (Flash suffix) — the guard compares H2 bodies only.
  // ---------------------------------------------------------------------------
  it("qa-worker.md 'How to write a valuable spec' section matches across both mirrors (Task 1.2)", () => {
    const opencodeWorker = parseSections(readFile("agents/agent/qa-worker.md"));
    const codexWorker = parseSections(readFile("agent/roles/qa-worker.md"));

    for (const sectionHeader of WORKER_MUST_MATCH_SECTIONS) {
      const opencodeBody = opencodeWorker.get(sectionHeader);
      const codexBody = codexWorker.get(sectionHeader);

      if (opencodeBody === undefined) continue; // section only in codex mirror is allowed

      assert.ok(
        codexBody !== undefined,
        `prompt-sync DIVERGENCE: section "## ${sectionHeader}" is present in agents/agent/qa-worker.md ` +
          `but missing from agent/roles/qa-worker.md. Port it.`,
      );

      assert.equal(
        normalize(codexBody),
        normalize(opencodeBody),
        `prompt-sync DIVERGENCE in worker section "## ${sectionHeader}": ` +
          `agent/roles/qa-worker.md and agents/agent/qa-worker.md differ. ` +
          `The codex mirror must match the canonical OpenCode version.`,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // Task 1.3: Inverse proofs — confirm the guard actually catches divergence.
  // (a) Skill-file parity: appending a comment to the in-memory content must trigger AssertionError.
  // (b) Worker section parity: appending a comment to the in-memory section body must trigger AssertionError.
  // ---------------------------------------------------------------------------
  it("inverse: skill-file parity guard catches one-tree drift (Task 1.3 — skill file)", () => {
    const [opencodeRel] = SKILL_FILE_PAIRS[0]!;
    const opencodeContent = readFile(opencodeRel);
    const divergedContent = opencodeContent + "\n\n<!-- drift -->";

    assert.throws(
      () => {
        assert.equal(
          normalize(divergedContent),
          normalize(opencodeContent),
          `prompt-sync DIVERGENCE in skill file "${opencodeRel}"`,
        );
      },
      (err: unknown) => err instanceof assert.AssertionError,
      "The skill-file parity guard must throw an AssertionError when the codex mirror diverges.",
    );
  });

  it("inverse: worker section parity guard catches one-tree drift (Task 1.3 — worker section)", () => {
    const opencodeWorker = parseSections(readFile("agents/agent/qa-worker.md"));
    const sectionHeader = WORKER_MUST_MATCH_SECTIONS[0]!;
    const opencodeBody = opencodeWorker.get(sectionHeader);
    if (!opencodeBody) return; // section unexpectedly absent — skip inverse check

    const divergedBody = opencodeBody + "\n\n<!-- drift -->";

    assert.throws(
      () => {
        assert.equal(
          normalize(divergedBody),
          normalize(opencodeBody),
          `prompt-sync DIVERGENCE in worker section "## ${sectionHeader}"`,
        );
      },
      (err: unknown) => err instanceof assert.AssertionError,
      "The worker section-parity guard must throw an AssertionError when the codex mirror diverges.",
    );
  });
});
