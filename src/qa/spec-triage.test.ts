import { test } from "node:test";
import assert from "node:assert/strict";
import {
  perFileSelectorPresence,
  attributeCorrections,
  buildPerFileEvidence,
  triagePublish,
  findDanglingPrSpecs,
} from "./spec-triage";
import type { QaCase } from "../types";

// ── findDanglingPrSpecs (Spec-Req-4: never publish a broken subset) ───────────────

test("findDanglingPrSpecs: a PR spec importing a DROPPED sibling spec is flagged", () => {
  const read = (f: string) =>
    f === "flows/a.spec.ts" ? `import { helper } from "../flows/b";\ntest("x", async () => {});` : null;
  assert.deepEqual(findDanglingPrSpecs(["flows/a.spec.ts"], ["flows/b.spec.ts"], read), ["flows/a.spec.ts"]);
});

test("findDanglingPrSpecs: importing an ISSUE-bucket sibling (also unpublished) is flagged", () => {
  const read = () => `import x from "./b.spec";`;
  assert.deepEqual(findDanglingPrSpecs(["flows/a.spec.ts"], ["flows/b.spec.ts"], read), ["flows/a.spec.ts"]);
});

test("findDanglingPrSpecs: importing a PR sibling (also published) is SAFE", () => {
  const read = (f: string) => (f === "flows/a.spec.ts" ? `import { x } from "./c";` : null);
  assert.deepEqual(findDanglingPrSpecs(["flows/a.spec.ts", "flows/c.spec.ts"], ["flows/b.spec.ts"], read), []);
});

test("findDanglingPrSpecs: importing a pre-existing repo file (../fixtures) is SAFE", () => {
  const read = () => `import { test } from "../fixtures";`;
  assert.deepEqual(findDanglingPrSpecs(["flows/a.spec.ts"], ["flows/b.spec.ts"], read), []);
});

test("findDanglingPrSpecs: a spec with no relative imports is SAFE", () => {
  const read = () => `import { test, expect } from "@playwright/test";\ntest("x", async () => {});`;
  assert.deepEqual(findDanglingPrSpecs(["flows/a.spec.ts"], ["flows/b.spec.ts"], read), []);
});

test("findDanglingPrSpecs: dynamic import() of a dropped spec is flagged", () => {
  const read = () => `const m = await import("./b.spec.ts");`;
  assert.deepEqual(findDanglingPrSpecs(["flows/a.spec.ts"], ["flows/b.spec.ts"], read), ["flows/a.spec.ts"]);
});

test("findDanglingPrSpecs: unreadable PR spec is skipped (already compiled in the whole-dir gate)", () => {
  assert.deepEqual(findDanglingPrSpecs(["flows/a.spec.ts"], ["flows/b.spec.ts"], () => null), []);
});

test("findDanglingPrSpecs: empty PR or empty unpublished set yields no dangling", () => {
  assert.deepEqual(findDanglingPrSpecs([], ["flows/b.spec.ts"], () => "x"), []);
  assert.deepEqual(findDanglingPrSpecs(["flows/a.spec.ts"], [], () => `import "./b";`), []);
});

// ── Shared fixtures ────────────────────────────────────────────────────────────

function makeCase(
  file: string | undefined,
  status: "pass" | "fail",
  opts: {
    detail?: string;
    failureDom?: string;
    httpStatus?: number;
  } = {},
): QaCase {
  return {
    name: `test in ${file ?? "(unfiled)"}`,
    status,
    file,
    detail: opts.detail,
    failureDom: opts.failureDom,
    httpStatus: opts.httpStatus,
  };
}

// ── perFileSelectorPresence ────────────────────────────────────────────────────

// Spec sources that reference a verifiably-absent selector
const ABSENT_SPEC = `
  await page.getByRole("button", { name: "SubmitMissing" }).click();
`;

// Spec sources that reference a present selector
const PRESENT_SPEC = `
  await page.getByRole("button", { name: "Save" }).click();
`;

const SAVE_BUTTON_DOM = "button: Save";

test("perFileSelectorPresence: single-file run — result equals the run-level allUnique formula", () => {
  const cases: QaCase[] = [
    makeCase("login.spec.ts", "fail", { failureDom: SAVE_BUTTON_DOM }),
  ];
  const specSourcesByFile: Record<string, string[]> = {
    "login.spec.ts": [PRESENT_SPEC],
  };
  const result = perFileSelectorPresence(cases, specSourcesByFile);
  const entry = result.get("login.spec.ts");
  assert.ok(entry !== undefined, "entry for login.spec.ts should exist");
  // Save button is present and unique → allUnique true, absentKeysCount 0
  assert.equal(entry!.allUnique, true);
  assert.equal(entry!.absentKeysCount, 0);
});

test("perFileSelectorPresence: multi-file run — per-file maps are scoped correctly (file A's absent key does not bleed into file B)", () => {
  const cases: QaCase[] = [
    makeCase("login.spec.ts", "fail", { failureDom: "button: Save" }),
    makeCase("checkout.spec.ts", "fail", { failureDom: "button: Pay" }),
  ];
  // login.spec.ts refers to absent selector; checkout.spec.ts has present selector
  const specSourcesByFile: Record<string, string[]> = {
    "login.spec.ts": [ABSENT_SPEC],
    "checkout.spec.ts": [`await page.getByRole("button", { name: "Pay" }).click();`],
  };
  const result = perFileSelectorPresence(cases, specSourcesByFile);

  const loginEntry = result.get("login.spec.ts");
  const checkoutEntry = result.get("checkout.spec.ts");
  assert.ok(loginEntry !== undefined);
  assert.ok(checkoutEntry !== undefined);
  // login has absent key, checkout does not
  assert.ok(loginEntry!.absentKeysCount > 0, "login.spec.ts should have absent keys");
  assert.equal(checkoutEntry!.absentKeysCount, 0, "checkout.spec.ts should NOT have absent keys from login");
});

test("perFileSelectorPresence: file with no failureDom cases — yields allUnique false (indeterminate)", () => {
  const cases: QaCase[] = [
    makeCase("no-dom.spec.ts", "fail"), // no failureDom
  ];
  const result = perFileSelectorPresence(cases, { "no-dom.spec.ts": [ABSENT_SPEC] });
  const entry = result.get("no-dom.spec.ts");
  assert.ok(entry !== undefined);
  // No trees → cannot confirm presence → allUnique false
  assert.equal(entry!.allUnique, false);
});

// ── attributeCorrections ───────────────────────────────────────────────────────

test("attributeCorrections: [GRAVE] tag on a filename → graveByFile[file] === true", () => {
  const corrections = ["[false-positive] foo.spec.ts: test asserts nothing"];
  const result = attributeCorrections(corrections, ["foo.spec.ts", "bar.spec.ts"]);
  assert.equal(result.get("foo.spec.ts"), true);
  assert.equal(result.get("bar.spec.ts"), false);
});

test("attributeCorrections: multiple GRAVE corrections for the same file → still true (no double-count)", () => {
  const corrections = [
    "[false-positive] foo.spec.ts: test asserts nothing",
    "[wrong-objective] foo.spec.ts: misses the change",
  ];
  const result = attributeCorrections(corrections, ["foo.spec.ts"]);
  assert.equal(result.get("foo.spec.ts"), true);
});

test("attributeCorrections: correction with no resolvable filename → ALL files receive grave:true (unattributable GRAVE blocks everyone)", () => {
  const corrections = ["[false-positive] this is a grave correction with no filename"];
  const allFiles = ["foo.spec.ts", "bar.spec.ts", "baz.spec.ts"];
  const result = attributeCorrections(corrections, allFiles);
  for (const f of allFiles) {
    assert.equal(result.get(f), true, `${f} should be grave when correction is unattributable`);
  }
});

test("attributeCorrections: [fragile-selector] tag → NOT grave (fragile is recoverable)", () => {
  const corrections = ["[fragile-selector] foo.spec.ts: ambiguous selector"];
  const result = attributeCorrections(corrections, ["foo.spec.ts"]);
  assert.equal(result.get("foo.spec.ts"), false);
});

test("attributeCorrections: correction with no tag → NOT grave (untagged advisory)", () => {
  const corrections = ["this is just plain text with no bracket tag"];
  const result = attributeCorrections(corrections, ["foo.spec.ts"]);
  assert.equal(result.get("foo.spec.ts"), false);
});

test("attributeCorrections: empty corrections → all files false", () => {
  const result = attributeCorrections([], ["foo.spec.ts", "bar.spec.ts"]);
  assert.equal(result.get("foo.spec.ts"), false);
  assert.equal(result.get("bar.spec.ts"), false);
});

// ── triagePublish decision table ───────────────────────────────────────────────

// Helper: build a minimal TriageInput for testing triagePublish
function makeTriageInput(overrides: {
  cases?: QaCase[];
  presenceOverrides?: Record<string, { allUnique: boolean; absentKeysCount: number }>;
  graveOverrides?: Record<string, boolean>;
}) {
  const { cases = [], presenceOverrides = {}, graveOverrides = {} } = overrides;
  const allFiles = [...new Set(cases.map((c) => c.file).filter((f): f is string => f !== undefined))];
  const presenceByFile = new Map<string, { allUnique: boolean; absentKeysCount: number }>(
    allFiles.map((f) => [f, presenceOverrides[f] ?? { allUnique: true, absentKeysCount: 0 }]),
  );
  const graveByFile = new Map<string, boolean>(
    allFiles.map((f) => [f, graveOverrides[f] ?? false]),
  );
  return {
    cases,
    presenceByFile,
    graveByFile,
    mode: "diff" as const,
    objectiveSource: ["src/index.ts"],
  };
}

// T0: unfiled bucket with ≥1 fail → ISSUE (never DROP/PR)
test("triagePublish T0: unfiled case with fail → ISSUE", () => {
  const cases = [makeCase(undefined, "fail", { detail: "some error" })];
  const input = makeTriageInput({ cases });
  const result = triagePublish(input);
  assert.ok(result.issue.length > 0, "unfiled fail should go to ISSUE");
  assert.equal(result.pr.length, 0);
  assert.equal(result.drop.length, 0);
});

// T1: GRAVE tag + all-pass → DROP (affirmative reviewer verdict)
test("triagePublish T1: GRAVE tag on passing file → DROP", () => {
  const cases = [makeCase("foo.spec.ts", "pass")];
  const input = makeTriageInput({ cases, graveOverrides: { "foo.spec.ts": true } });
  const result = triagePublish(input);
  assert.ok(result.drop.includes("foo.spec.ts"), "file with GRAVE tag should be dropped");
  assert.equal(result.pr.length, 0);
  assert.equal(result.issue.length, 0);
});

// T2: no fail + no GRAVE → PR
test("triagePublish T2: passing file with no GRAVE → PR", () => {
  const cases = [makeCase("login.spec.ts", "pass"), makeCase("login.spec.ts", "pass")];
  const input = makeTriageInput({ cases });
  const result = triagePublish(input);
  assert.ok(result.pr.includes("login.spec.ts"), "clean passing file should go to PR");
  assert.equal(result.issue.length, 0);
  assert.equal(result.drop.length, 0);
});

// T3: ≥1 fail, adjudicate returns APP_DEFECT (5xx) → ISSUE
test("triagePublish T3: failing case with 5xx httpStatus → ISSUE", () => {
  const cases = [makeCase("checkout.spec.ts", "fail", { httpStatus: 500, detail: "server error" })];
  const input = makeTriageInput({ cases });
  const result = triagePublish(input);
  assert.ok(result.issue.some((v) => v.file === "checkout.spec.ts"), "5xx fail should go to ISSUE");
  assert.equal(result.pr.length, 0);
  assert.equal(result.drop.length, 0);
});

// T4: all-locator-fail + absentKeysCount>0 + no real-bug signal → DROP
test("triagePublish T4: all-locator-fail with absent selector → DROP", () => {
  const cases = [
    makeCase("bad.spec.ts", "fail", {
      detail: "getByRole('button', { name: 'Ghost' }): not found",
      failureDom: "button: Save",
    }),
  ];
  const input = makeTriageInput({
    cases,
    presenceOverrides: { "bad.spec.ts": { allUnique: false, absentKeysCount: 1 } },
  });
  const result = triagePublish(input);
  assert.ok(result.drop.includes("bad.spec.ts"), "all-locator-absent should be dropped");
  assert.equal(result.pr.length, 0);
  assert.equal(result.issue.length, 0);
});

// T5: ambiguous/mixed/timeout-only fall-through → ISSUE (conservative fallback)
test("triagePublish T5: ambiguous failure (no real-bug signal, no absent-selector) → ISSUE", () => {
  const cases = [
    makeCase("ambiguous.spec.ts", "fail", {
      detail: "Timeout 30000ms exceeded",
      failureDom: "button: Save",
    }),
  ];
  // No absent keys, so T4 doesn't fire; no 5xx, so T3 doesn't fire → T5 conservative fallback
  const input = makeTriageInput({
    cases,
    presenceOverrides: { "ambiguous.spec.ts": { allUnique: true, absentKeysCount: 0 } },
  });
  const result = triagePublish(input);
  assert.ok(result.issue.some((v) => v.file === "ambiguous.spec.ts"), "ambiguous should go to ISSUE");
  assert.equal(result.drop.length, 0);
});

// Mixed evidence (5xx + locator in same file) → ISSUE not DROP (real-bug wins)
test("triagePublish: mixed evidence — 5xx + locator in same file → ISSUE not DROP", () => {
  const cases = [
    makeCase("mixed.spec.ts", "fail", {
      httpStatus: 503,
      detail: "server error 503",
    }),
    makeCase("mixed.spec.ts", "fail", {
      detail: "getByRole('button'): not found",
    }),
  ];
  const input = makeTriageInput({
    cases,
    presenceOverrides: { "mixed.spec.ts": { allUnique: false, absentKeysCount: 1 } },
  });
  const result = triagePublish(input);
  assert.ok(result.issue.some((v) => v.file === "mixed.spec.ts"), "5xx wins over locator → ISSUE");
  assert.equal(result.drop.length, 0, "must NOT drop when real-bug evidence present");
});

// Unattributable GRAVE → ALL files demoted to ISSUE, none to DROP
// The design says: "an unattributable GRAVE correction blocks PR for ALL files and NEVER triggers a
// DROP — so the failure mode is over-filing Issues (cheap to dismiss), never silently deleting a
// real-bug catcher." The `allFilesGraveUnattributable` flag signals this case.
test("triagePublish: unattributable GRAVE → ALL files ISSUE, not DROP", () => {
  const cases = [
    makeCase("a.spec.ts", "pass"),
    makeCase("b.spec.ts", "pass"),
  ];
  const allFiles = ["a.spec.ts", "b.spec.ts"];
  // All files marked grave (simulates unattributable GRAVE → all grave)
  const graveByFile = new Map<string, boolean>([
    ["a.spec.ts", true],
    ["b.spec.ts", true],
  ]);
  const presenceByFile = new Map<string, { allUnique: boolean; absentKeysCount: number }>(
    allFiles.map((f) => [f, { allUnique: true, absentKeysCount: 0 }]),
  );
  // allFilesGraveUnattributable=true triggers the conservative ISSUE path (not DROP)
  const result = triagePublish({
    cases,
    presenceByFile,
    graveByFile,
    mode: "diff",
    objectiveSource: [],
    allFilesGraveUnattributable: true,
  });
  assert.equal(result.drop.length, 0, "unattributable GRAVE must NOT drop any file");
  assert.equal(result.issue.length, 2, "unattributable GRAVE → all files demoted to ISSUE");
  assert.equal(result.pr.length, 0);
});

// All-pass run → all PR (equivalence to today's whole-suite PR path)
test("triagePublish: all-pass run → all files PR", () => {
  const cases = [
    makeCase("a.spec.ts", "pass"),
    makeCase("b.spec.ts", "pass"),
    makeCase("c.spec.ts", "pass"),
  ];
  const input = makeTriageInput({ cases });
  const result = triagePublish(input);
  assert.equal(result.pr.length, 3);
  assert.equal(result.issue.length, 0);
  assert.equal(result.drop.length, 0);
});

// All-low-quality (all GRAVE) → no-op (all DROP, no PR no Issue)
test("triagePublish: all files with attributed GRAVE → all DROP", () => {
  const cases = [
    makeCase("a.spec.ts", "pass"),
    makeCase("b.spec.ts", "pass"),
  ];
  // For attributed grave (file is known), T1 fires → DROP
  const allFiles = ["a.spec.ts", "b.spec.ts"];
  const graveByFile = new Map<string, boolean>([
    ["a.spec.ts", true],
    ["b.spec.ts", true],
  ]);
  const presenceByFile = new Map<string, { allUnique: boolean; absentKeysCount: number }>(
    allFiles.map((f) => [f, { allUnique: true, absentKeysCount: 0 }]),
  );
  // Pass attributedGrave = true (no unattributable flag)
  const result = triagePublish({
    cases,
    presenceByFile,
    graveByFile,
    mode: "diff",
    objectiveSource: [],
    allFilesGraveUnattributable: false,
  });
  assert.equal(result.drop.length, 2, "all attributed grave passing files → DROP");
  assert.equal(result.pr.length, 0);
  assert.equal(result.issue.length, 0);
});
