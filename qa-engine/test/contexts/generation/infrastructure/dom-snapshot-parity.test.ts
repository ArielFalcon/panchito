// Parity test: assert the ported qa-engine dom-snapshot functions match the legacy src/qa/
// dom-snapshot.ts byte-for-byte on representative inputs. This file imports from src/ (outside
// qa-engine rootDir) and is excluded from qa-engine typecheck (see qa-engine/tsconfig.json exclude
// list) — identical pattern to symbols-parity.test.ts (Plan 7.3). Runs via tsx at runtime; the
// strangler guard keeping the port honest until the legacy original is fully retired.
//
// ADJUSTED (migration-remediation Slice 8.E): src/qa/dom-snapshot.ts was trimmed to its 3 exports
// with live src/ callers — normalizeRoutes, MAX_ROUTES's extractTargetRoutes, and parseAriaSnapshot.
// Every other function this file used to compare (formatDomSnapshot, parseAriaSnapshotWithState,
// capDomLines, isPriorityNode, mergeAttrs, normalizeKey, buildChangedMarker, and the four capture*
// entry points) was removed from the legacy file — those comparisons are retired along with them.
// Do NOT retire this file entirely; the 3 surviving comparisons still guard real parity.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractTargetRoutes as portedExtractTargetRoutes,
  parseAriaSnapshot as portedParseAriaSnapshot,
  normalizeRoutes as portedNormalizeRoutes,
} from "@contexts/generation/infrastructure/dom-snapshot.ts";

import {
  extractTargetRoutes as legacyExtractTargetRoutes,
  parseAriaSnapshot as legacyParseAriaSnapshot,
  normalizeRoutes as legacyNormalizeRoutes,
} from "../../../../../src/qa/dom-snapshot.ts";

// ── extractTargetRoutes ───────────────────────────────────────────────────────

test("PARITY: extractTargetRoutes matches legacy — dedup, comments, ${} interpolation, absolute URLs", () => {
  const spec = `
    await page.goto("/#!/owners/new");
    await page.goto('owners');
    await page.goto("/#!/owners/new");
    // await page.goto("/admin");
    await page.goto("https://evil.example/x");
    await page.goto(\`/owners/\${id}\`);
  `;
  assert.deepEqual(portedExtractTargetRoutes([spec]), legacyExtractTargetRoutes([spec]));
});

test("PARITY: extractTargetRoutes bounds match legacy", () => {
  const spec = ["/a", "/b", "/c", "/d", "/e", "/f"].map((r) => `page.goto("${r}")`).join("\n");
  assert.deepEqual(portedExtractTargetRoutes([spec], 3), legacyExtractTargetRoutes([spec], 3));
});

// ── parseAriaSnapshot ────────────────────────────────────────────────────────

test("PARITY: parseAriaSnapshot matches legacy on a real table + presentation-table collapse", () => {
  const yaml = `
- navigation
- link "Register owner"
- button "say \\"hi\\""
- heading "Owners [level=2]"
- textbox
- checkbox "Subscribe" [checked]
- table
  - rowgroup
    - row "Name Address"
      - columnheader "Name"
      - columnheader "Address"
  - rowgroup
    - row
      - cell "Helen Leary"
      - cell "radiology"
    - row
      - cell "Henry Stevens"
      - cell "radiology"
- text: layout cell only
- dialog "Confirm Delete"
- form:
- switch "Dark mode"
- alert:
`.trim();
  assert.deepEqual(portedParseAriaSnapshot(yaml), legacyParseAriaSnapshot(yaml));
});

test("PARITY: parseAriaSnapshot matches legacy on empty input", () => {
  assert.deepEqual(portedParseAriaSnapshot(""), legacyParseAriaSnapshot(""));
  assert.deepEqual(portedParseAriaSnapshot("   \n  \n  "), legacyParseAriaSnapshot("   \n  \n  "));
});

// ── normalizeRoutes ───────────────────────────────────────────────────────────

test("PARITY: normalizeRoutes matches legacy — trim, dedupe, drop absolute/interpolated", () => {
  const routes = [" /a ", "/a", "https://x.com/y", "/p/${id}", "/b"];
  assert.deepEqual(portedNormalizeRoutes(routes), legacyNormalizeRoutes(routes));
});
