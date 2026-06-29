import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Pillar 3 (selector grounding — docs/superpowers/selector-grounding-root-cause-and-design.md):
// the agent must NEVER fabricate a selector it did not observe. This guard pins that the fabrication
// license ("derive selectors from source code when no live DOM is reachable") is removed from BOTH
// authoring roles in BOTH prompt trees, and that the grounded-only contract is explicit. The license
// has crept back across five "definitive" fixes — this test fails CI if it returns.

const AUTHORING_PROMPTS = [
  "agent/roles/qa-generator.md",
  "agents/agent/qa-generator.md",
  "agent/roles/qa-worker.md",
  "agents/agent/qa-worker.md",
];

for (const file of AUTHORING_PROMPTS) {
  test(`Pillar 3: ${file} carries no fabrication license`, () => {
    const src = readFileSync(file, "utf8");
    assert.ok(
      !/derive them from the code/i.test(src),
      `${file}: must NOT license deriving selectors from source code`,
    );
    assert.ok(
      !/do your best with code analysis alone/i.test(src),
      `${file}: must NOT license code-only authoring of selectors`,
    );
  });

  test(`Pillar 3: ${file} forbids constructing a test-id from source`, () => {
    const src = readFileSync(file, "utf8");
    assert.ok(
      /never construct a test-id/i.test(src),
      `${file}: must explicitly forbid constructing a test-id value from source code / naming convention`,
    );
  });
}
