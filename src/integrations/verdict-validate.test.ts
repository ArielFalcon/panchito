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
