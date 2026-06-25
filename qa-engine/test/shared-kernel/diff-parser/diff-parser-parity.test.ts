// Parity tests: assert the kernel DiffParserService matches the legacy src/ functions byte-for-byte.
// This file imports from src/ (outside qa-engine rootDir) and is excluded from qa-engine typecheck
// (see qa-engine/tsconfig.json exclude list) — identical pattern to characterization/scenarios.ts.
// The tests still run via tsx at runtime and are the strangler guard keeping consolidation honest
// until Step 6 cutover deletes the legacy originals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";
import { extractChangedElements as legacyExtract, changedElementsFromGuidance as legacyGuidance } from "../../../../src/qa/changed-elements.ts";
import { parseDiffHunks as legacyHunks } from "../../../../src/qa/change-coverage.ts";

const svc = new DiffParserService();

function diff(file: string, body: string[]): string {
  return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, ...body].join("\n");
}

function htmlDiff(lines: string[], file = "src/home.component.html"): string {
  return [
    `diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`,
    `@@ -1,3 +1,${lines.length + 2} @@`, ` <div>`, ...lines, ` </div>`,
  ].join("\n");
}

test("PARITY: changedElements matches legacy extractChangedElements", () => {
  const d = htmlDiff([`+<button data-cy="x" id="y" name="z">Go</button>`, `+<a href="/p">P</a>`]);
  assert.deepEqual(svc.changedElements(d), legacyExtract(d));
});

test("PARITY: changedElementsFromGuidance matches legacy", () => {
  assert.deepEqual(svc.changedElementsFromGuidance("test the contact form and dashboard"), legacyGuidance("test the contact form and dashboard"));
});

test("PARITY mat-*: <mat-button> inner text is captured (isVisibleTextTag mat-* branch)", () => {
  // Exercises the low.startsWith("mat-") path in isVisibleTextTag + the extractMatInnerText dispatch.
  // If the mat-* branch was omitted, changedElements returns [] and this parity test fails.
  const d = htmlDiff([`+<mat-button color="primary">Save Changes</mat-button>`]);
  const got = svc.changedElements(d);
  const exp = legacyExtract(d);
  assert.deepEqual(got, exp, "mat-* inner text diverged from legacy — check isVisibleTextTag and extractMatInnerText");
  assert.ok(got.some((e) => e.text === "Save Changes"), "mat-button text not captured");
});

test("PARITY: changedLines matches legacy parseDiffHunks", () => {
  const d = htmlDiff([`+<button data-cy="x">Go</button>`]);
  const got = svc.changedLines(d);
  const exp = legacyHunks(d);
  assert.deepEqual([...got.entries()].map(([f, s]) => [f, [...s].sort((a, b) => a - b)]), [...exp.entries()].map(([f, s]) => [f, [...s].sort((a, b) => a - b)]));
});

test("PARITY two-pass: multiple hunks with interleaved deletions produce correct line numbers", () => {
  // A diff with two hunks and deletions between added lines. If the second pass drifts from the
  // first (e.g. by re-implementing line advance differently), the line numbers on buttons will
  // diverge — especially once line numbers reach ≥10 where lexicographic sort would mask it.
  const d = [
    "diff --git a/src/page.html b/src/page.html",
    "--- a/src/page.html",
    "+++ b/src/page.html",
    "@@ -1,5 +1,6 @@",
    " <div>",
    "-<span>old</span>",
    `+<button data-cy="btn-1">First</button>`,
    " <p>ctx</p>",
    " <p>ctx</p>",
    `+<button data-cy="btn-2">Second</button>`,
    " </div>",
    "@@ -20,3 +21,4 @@",
    " <footer>",
    "-<span>old-footer</span>",
    `+<button data-cy="btn-11">Eleven</button>`,
    `+<button data-cy="btn-12">Twelve</button>`,
    " </footer>",
  ].join("\n");
  const got = svc.changedElements(d);
  const exp = legacyExtract(d);
  // The two-pass port must match the legacy oracle byte-for-byte on every element.
  assert.deepEqual(got, exp, "two-pass line numbering diverged from the legacy oracle");
  // Spot-check: btn-11 must NOT appear on a line < 21 (catches off-by-one from hunk offset).
  const btn11 = got.find((e) => e.testId === "btn-11");
  assert.ok(btn11 !== undefined && btn11.line >= 21, `btn-11 line ${btn11?.line} should be ≥ 21`);
});
