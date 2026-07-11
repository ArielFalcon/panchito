// qa-engine/test/shared-kernel/manifest/manifest-entry.test.ts
// Direct unit tests for the canonical manifest-entry schema (migration-tier-4b Slice 2 — THE
// manifest reconciliation). manifest-fs.test.ts and src/qa/metadata.test.ts (via schemas.ts's
// re-export) already exercise this schema through its two real consumption paths (write/read); this
// file pins the schema's OWN contract directly — the union shape, the round-trip of every Shape-A
// field, and the requiredness/enum rules — independent of either call site.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ManifestEntrySchema, ManifestSchema, validateManifest, manifestEntryViolation } from "@kernel/manifest/manifest-entry.ts";

const complete = {
  id: "checkout/over-10-items",
  objective: "With >10 items, checkout completes the payment",
  flow: "checkout",
  useCase: "bulk-checkout",
  file: "flows/checkout.spec.ts",
  targets: ["CheckoutService.validateCart"],
  changeRef: { sha: "abc1234", type: "fix", pr: 42, ticket: "QA-1" },
  sha256: "a".repeat(64),
  criticality: "critical" as const,
  owner: "qa-bot",
  createdAt: "2026-07-11T00:00:00Z",
  coverage: { files: ["src/checkout.ts"], functions: ["validateCart"] },
  sensitivity: { status: "pass" as const, method: "regression", at: "2026-07-11T00:00:00Z" },
  stability: { runs: 10, flakyRuns: 0 },
  ledger: { caughtRegressions: 1, falsePositives: 0 },
  merit: 0.9,
};

test("round-trip: every Shape-A field + file survives ManifestEntrySchema.safeParse unchanged", () => {
  const result = ManifestEntrySchema.safeParse(complete);
  assert.equal(result.success, true);
  if (result.success) assert.deepEqual(result.data, complete);
});

test("file is OPTIONAL — a Shape-A-only entry (no file) is still valid (never a forbidden widening)", () => {
  const { file: _file, ...shapeAOnly } = complete;
  const result = ManifestEntrySchema.safeParse(shapeAOnly);
  assert.equal(result.success, true);
});

test("targets/changeRef are REQUIRED at the schema level — missing either rejects", () => {
  const { targets: _targets, ...noTargets } = complete;
  assert.equal(ManifestEntrySchema.safeParse(noTargets).success, false);
  const { changeRef: _changeRef, ...noChangeRef } = complete;
  assert.equal(ManifestEntrySchema.safeParse(noChangeRef).success, false);
});

test("targets:[] is rejected — the SAME schema instance both the read-path and write-path import", () => {
  assert.equal(ManifestEntrySchema.safeParse({ ...complete, targets: [] }).success, false);
});

test("criticality enum rejects an out-of-enum value (e.g. 'urgent')", () => {
  assert.equal(ManifestEntrySchema.safeParse({ ...complete, criticality: "urgent" }).success, false);
});

test("sensitivity.status enum rejects an out-of-enum value", () => {
  assert.equal(ManifestEntrySchema.safeParse({ ...complete, sensitivity: { status: "bogus" } }).success, false);
});

test("validateManifest: an empty array is valid (repo with no tests yet)", () => {
  assert.equal(validateManifest([]).ok, true);
});

test("validateManifest: a well-formed array is valid", () => {
  assert.equal(validateManifest([complete]).ok, true);
});

test("validateManifest: rejects a non-array", () => {
  assert.equal(validateManifest({}).ok, false);
});

test("validateManifest: reports which entry/field failed", () => {
  const r = validateManifest([{ id: "x" }]);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /objective/);
  assert.match(r.errors.join(" "), /flow/);
  assert.match(r.errors.join(" "), /targets/);
});

test("ManifestSchema: an array of well-formed entries parses", () => {
  assert.equal(ManifestSchema.safeParse([complete]).success, true);
});

// manifestEntryViolation: the canonical single-entry check manifest-fs.ts's write-path safetyFilter
// uses (replacing the old hand-rolled twin).
test("manifestEntryViolation: undefined for a well-formed entry", () => {
  assert.equal(manifestEntryViolation(complete), undefined);
});

test("manifestEntryViolation: returns a message for a missing required field", () => {
  const { objective: _objective, ...bad } = complete;
  assert.equal(typeof manifestEntryViolation(bad), "string");
});

test("manifestEntryViolation: returns a message for an out-of-enum criticality (write-time enum validation, closing the latent bug)", () => {
  assert.equal(typeof manifestEntryViolation({ ...complete, criticality: "urgent" }), "string");
});

test("manifestEntryViolation: returns a message for empty targets — same rejection the read-path array schema gives", () => {
  assert.equal(typeof manifestEntryViolation({ ...complete, targets: [] }), "string");
});
