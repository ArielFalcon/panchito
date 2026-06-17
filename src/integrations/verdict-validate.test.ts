import { test } from "node:test";
import assert from "node:assert/strict";
import { checkGeneratorVerdict, parseReviewerVerdict, repairInstruction } from "./verdict-validate";

// ── checkGeneratorVerdict ─────────────────────────────────────────────────────

test("checkGeneratorVerdict accepts a well-formed generator block", () => {
  const c = checkGeneratorVerdict('done.\n{"specs":["login.spec.ts"],"specMetas":[{"file":"login.spec.ts","flow":"login","objective":"valid creds reach the dashboard","targets":["AuthService.login"]}],"note":""}');
  assert.equal(c.valid, true);
  assert.deepEqual(c.issues, []);
});

test("checkGeneratorVerdict accepts an EMPTY specs list (valid no-op skip)", () => {
  const c = checkGeneratorVerdict('{"specs":[],"note":"nothing in this change is worth an E2E test"}');
  assert.equal(c.valid, true);
});

test("checkGeneratorVerdict accepts specMetas without targets (targets default to [])", () => {
  const c = checkGeneratorVerdict('{"specs":["a.spec.ts"],"specMetas":[{"file":"a.spec.ts","flow":"f","objective":"o"}]}');
  assert.equal(c.valid, true);
});

test("checkGeneratorVerdict ignores a stray legacy `approved` field", () => {
  const c = checkGeneratorVerdict('{"approved":true,"specs":["a.spec.ts"]}');
  assert.equal(c.valid, true);
});

test("checkGeneratorVerdict rejects a missing closing JSON block", () => {
  const c = checkGeneratorVerdict("the agent rambled without emitting a verdict");
  assert.equal(c.valid, false);
  assert.ok(c.issues.length > 0);
});

test("checkGeneratorVerdict rejects a legacy approved-only block with no specs", () => {
  // A block carrying only `approved` (the old contract) is located as a candidate but fails
  // the new schema (specs is required) → repair asks the generator for its specs.
  const c = checkGeneratorVerdict('{"approved":true}');
  assert.equal(c.valid, false);
  assert.ok(c.issues.some((i) => i.includes("specs")), `issues should name the missing field: ${c.issues.join("; ")}`);
});

test("checkGeneratorVerdict rejects specs that is not an array of strings", () => {
  const c = checkGeneratorVerdict('{"specs":"login.spec.ts"}');
  assert.equal(c.valid, false);
  assert.ok(c.issues.some((i) => i.includes("specs")), `issues should name the bad field: ${c.issues.join("; ")}`);
});

test("checkGeneratorVerdict rejects a specMeta missing a required field", () => {
  const c = checkGeneratorVerdict('{"specs":["a.spec.ts"],"specMetas":[{"file":"a.spec.ts","flow":"f"}]}');
  assert.equal(c.valid, false);
  assert.ok(c.issues.some((i) => i.includes("objective")), `issues should point at the missing field: ${c.issues.join("; ")}`);
});

// ── parseReviewerVerdict ──────────────────────────────────────────────────────

test("parseReviewerVerdict reads an approval with a rationale", () => {
  const v = parseReviewerVerdict('{"approved":true,"rationale":"the discount logic is asserted","corrections":[]}');
  assert.equal(v.parsed, true);
  assert.equal(v.valid, true);
  assert.equal(v.approved, true);
  assert.equal(v.rationale, "the discount logic is asserted");
  assert.deepEqual(v.corrections, []);
});

test("parseReviewerVerdict reads a rejection with tagged corrections", () => {
  const v = parseReviewerVerdict('{"approved":false,"rationale":"no assertion on the discount","corrections":["[false-positive] checkout.spec.ts: assert the discounted total"]}');
  assert.equal(v.approved, false);
  assert.deepEqual(v.corrections, ["[false-positive] checkout.spec.ts: assert the discounted total"]);
});

test("parseReviewerVerdict flags a non-boolean approved for repair (does not silently pass or miss)", () => {
  // A mistyped gate must be caught by the schema as an actionable issue, not mislabelled
  // "no verdict". parsed=true (an `approved` field was found) but valid=false → repair.
  const v = parseReviewerVerdict('{"approved":"true","rationale":"looks fine"}');
  assert.equal(v.parsed, true);
  assert.equal(v.valid, false);
  assert.equal(v.approved, false); // fail-closed until a clean boolean is produced
  assert.ok(v.issues.some((i) => i.includes("approved")), `issues should name the bad field: ${v.issues.join("; ")}`);
});

test("parseReviewerVerdict fails closed and flags a parse miss when no verdict is present", () => {
  const v = parseReviewerVerdict("the reviewer wrote prose but no JSON");
  assert.equal(v.parsed, false);
  assert.equal(v.valid, false);
  assert.equal(v.approved, false); // fail-closed: nothing publishes on an unreadable gate
  assert.ok(v.issues.length > 0);
});

test("parseReviewerVerdict tolerates malformed corrections (never false-blocks an approval)", () => {
  // The gate is `approved`; a botched corrections field must not turn a real approval into a
  // fail-closed rejection. corrections falls back to [].
  const v = parseReviewerVerdict('{"approved":true,"corrections":"oops not an array"}');
  assert.equal(v.parsed, true);
  assert.equal(v.valid, true);
  assert.equal(v.approved, true);
  assert.deepEqual(v.corrections, []);
});

test("parseReviewerVerdict takes the LAST verdict object", () => {
  const v = parseReviewerVerdict('{"approved":true}\nthen reconsidered\n{"approved":false,"rationale":"did not converge"}');
  assert.equal(v.approved, false);
});

// ── Phase 4: severity gate — parseReviewerVerdict ────────────────────────────

test("Phase 4 (a): advisory-only verdict — blockingCount is zero, gate passes", () => {
  // A verdict with advisory corrections only must yield blockingCount=0 so the caller's
  // severity gate approves (advisory corrections are non-fatal notes, not regeneration triggers).
  const json = JSON.stringify({
    approved: false, // model says false, but severity gate overrides when zero blocking
    rationale: "minor nits only",
    corrections: [
      { text: "[fragile-selector] login.spec.ts: use getByRole instead of nth-child", severity: "advisory" },
      { text: "[other] login.spec.ts: prefer const over let for page variable", severity: "advisory" },
    ],
  });
  const v = parseReviewerVerdict(json);
  assert.equal(v.valid, true);
  assert.equal(v.parsed, true);
  assert.equal(v.blockingCount, 0, "advisory-only verdict must have blockingCount=0");
  assert.equal(v.corrections.length, 2, "both advisory corrections surfaced as strings");
});

test("Phase 4 (b): blocking correction — blockingCount is non-zero, gate fails", () => {
  // A verdict with at least one blocking correction must yield blockingCount>=1.
  const json = JSON.stringify({
    approved: false,
    rationale: "test does not assert the discount was applied",
    corrections: [
      { text: "[false-positive] checkout.spec.ts: add assertion for discount total", severity: "blocking" },
      { text: "[fragile-selector] checkout.spec.ts: scope the Pay button selector", severity: "advisory" },
    ],
  });
  const v = parseReviewerVerdict(json);
  assert.equal(v.valid, true);
  assert.equal(v.blockingCount, 1, "exactly one blocking correction");
  assert.equal(v.corrections.length, 2, "both corrections in the flat list");
});

test("Phase 4 (c): missing severity field defaults to blocking (fail-closed backward compat)", () => {
  // A plain-string correction (no severity field) must be treated as blocking so older
  // reviewer outputs do not accidentally pass the gate with unclassified corrections.
  const json = JSON.stringify({
    approved: false,
    rationale: "legacy format correction",
    corrections: ["[other] some.spec.ts: a correction without a severity field"],
  });
  const v = parseReviewerVerdict(json);
  assert.equal(v.valid, true);
  assert.equal(v.blockingCount, 1, "plain-string correction defaults to blocking");
  assert.equal(v.corrections[0], "[other] some.spec.ts: a correction without a severity field");
});

test("Phase 4 (c2): mixed structured and plain-string corrections — plain strings count as blocking", () => {
  const json = JSON.stringify({
    approved: false,
    rationale: "mixed format",
    corrections: [
      "[false-positive] a.spec.ts: plain string, no severity",           // → blocking
      { text: "[other] b.spec.ts: structured advisory", severity: "advisory" }, // → advisory
    ],
  });
  const v = parseReviewerVerdict(json);
  assert.equal(v.blockingCount, 1, "only the plain-string counts as blocking");
  assert.equal(v.corrections.length, 2);
});

test("Phase 4 (e): approve-when-resolved — zero blocking in round 2 approves even with advisories", () => {
  // Simulates the round-2 verdict after the generator resolved the blocking correction:
  // the remaining advisory nit must NOT prevent approval.
  const round2Json = JSON.stringify({
    approved: true,
    rationale: "blocking issue resolved; advisory nit remains but does not block",
    corrections: [
      { text: "[fragile-selector] checkout.spec.ts: use getByRole for robustness", severity: "advisory" },
    ],
  });
  const v = parseReviewerVerdict(round2Json);
  assert.equal(v.blockingCount, 0, "zero blocking in round 2 → gate passes");
  assert.equal(v.corrections.length, 1, "advisory correction still surfaces for logging");
  assert.equal(v.approved, true);
});

// ── repairInstruction ─────────────────────────────────────────────────────────

test("repairInstruction names the generator shape and the specific issues", () => {
  const msg = repairInstruction("generator", ["specs: expected array"]);
  assert.match(msg, /specs/);
  assert.match(msg, /expected array/);
  assert.match(msg, /ONLY the closing JSON/i);
});

test("repairInstruction names the reviewer shape", () => {
  const msg = repairInstruction("reviewer", ["approved: required"]);
  assert.match(msg, /approved/);
  assert.match(msg, /rationale/);
  assert.match(msg, /corrections/);
});
