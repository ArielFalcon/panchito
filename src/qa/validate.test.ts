import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSpecs, ValidateDeps, runCheck } from "./validate";

const ok = async () => ({ ok: true, output: "" });

test("ok when the four checks pass", async () => {
  const deps: ValidateDeps = { typecheck: ok, lint: ok, listTests: ok, checkManifest: ok };
  const res = await validateSpecs("/dir", deps);
  assert.equal(res.ok, true);
  assert.equal(res.errors.length, 0);
});

test("accumulates ALL failures (does not stop at the first) with their label", async () => {
  const deps: ValidateDeps = {
    typecheck: async () => ({ ok: false, output: "TS2322 type error" }),
    lint: ok,
    listTests: async () => ({ ok: false, output: "no spec files found" }),
    checkManifest: ok,
  };
  const res = await validateSpecs("/dir", deps);
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 2);
  assert.match(res.errors[0]!, /\[typecheck\] TS2322/);
  assert.match(res.errors[1]!, /\[list\] no spec files/);
});

test("infra failures (spawn ENOENT, signal-kill) are flagged separately from real lint errors", async () => {
  // The typecheck check failed because tsc is missing (ENOENT) — infrastructure, NOT bad code.
  // The lint check found a real error — code quality.
  const deps: ValidateDeps = {
    typecheck: async () => ({ ok: false, output: "Error: spawn tsc ENOENT", infra: true }),
    lint: async () => ({ ok: false, output: "expect-expect: Test has no assertions" }),
    listTests: async () => ({ ok: true, output: "" }),
    checkManifest: async () => ({ ok: true, output: "" }),
  };
  const res = await validateSpecs("/dir", deps);
  assert.equal(res.ok, false);
  // There are non-infra errors → not a pure infra failure.
  assert.equal(res.infra, false);  // lint error makes it a real validation failure
});

test("a pure-infra validation failure is flagged as infra, not invalid", async () => {
  // ALL checks failed with infrastructure errors (e.g. npx not installed, ENOMEM).
  const deps: ValidateDeps = {
    typecheck: async () => ({ ok: false, output: "spawn npx ENOENT", infra: true }),
    lint: async () => ({ ok: false, output: "spawn npx ENOENT", infra: true }),
    listTests: async () => ({ ok: false, output: "spawn npx ENOENT", infra: true }),
    checkManifest: async () => ({ ok: true, output: "" }),
  };
  const res = await validateSpecs("/dir", deps);
  assert.equal(res.ok, false);
  // Pure infra: the gate itself couldn't run. Should be infra-error, not invalid.
  assert.equal(res.infra, true);
});

test("invalid metadata makes the run invalid", async () => {
  const deps: ValidateDeps = {
    typecheck: ok,
    lint: ok,
    listTests: ok,
    checkManifest: async () => ({ ok: false, output: "'login': missing 'objective'" }),
  };
  const res = await validateSpecs("/dir", deps);
  assert.equal(res.ok, false);
  assert.match(res.errors[0]!, /\[manifest\].*objective/);
});

// ── runCheck process safeguards (real, cheap children — no network/tooling) ──

test("runCheck kills a hung check on timeout and classifies it as INFRA", async () => {
  // A child that would hang forever — same shape as a wedged tsc/eslint/playwright.
  const res = await runCheck(process.execPath, ["-e", "setInterval(() => {}, 1000)"], process.cwd(), 100);
  assert.equal(res.ok, false);
  assert.equal(res.infra, true); // a wedged child is infrastructure, not a code defect
  assert.match(res.output, /timed out after 100ms — killed/);
});

test("runCheck resolves ok on a clean exit and captures output", async () => {
  const res = await runCheck(process.execPath, ["-e", "console.log('all good')"], process.cwd());
  assert.equal(res.ok, true);
  assert.match(res.output, /all good/);
  assert.equal(res.infra, undefined);
});

test("runCheck flags a non-zero exit as a CODE failure, not infra", async () => {
  const res = await runCheck(process.execPath, ["-e", "console.error('TS2322'); process.exit(2)"], process.cwd());
  assert.equal(res.ok, false);
  assert.equal(res.infra, undefined); // the tool ran and judged the code
  assert.match(res.output, /TS2322/);
});

test("runCheck flags a missing binary (ENOENT) as INFRA", async () => {
  const res = await runCheck("/definitely/not/a/binary-qa-xyz", [], process.cwd(), 5_000);
  assert.equal(res.ok, false);
  assert.equal(res.infra, true);
});

test("a timed-out check routes through validateSpecs as pure infra", async () => {
  // The shape runCheck produces on timeout, fed through the aggregation: the run
  // must surface as infra-error (gate couldn't run), never `invalid`.
  const timedOut = async () => ({ ok: false, output: "npx tsc --noEmit timed out after 300000ms — killed", infra: true });
  const deps: ValidateDeps = { typecheck: timedOut, lint: ok, listTests: ok, checkManifest: ok };
  const res = await validateSpecs("/dir", deps);
  assert.equal(res.ok, false);
  assert.equal(res.infra, true);
});
