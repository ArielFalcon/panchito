// qa-engine/test/contexts/test-execution/infrastructure/static-gate.checks.test.ts
// Behavioral tests for the static gate (e2e checks + code-mode compile gate + manifest-entry
// validation), moved from src/qa/validate.test.ts + src/qa/code-validate.test.ts +
// src/qa/metadata.test.ts (migration-tier-4b, Slice 3 — validate cluster migration). Byte-identical
// assertions to the three legacy files; only the import paths change (all three now live in ONE
// module, static-gate.checks.ts, mirroring code-execution.runner.ts's own consolidation in Slice 1).
//
// PARITY RETIREMENT (spec's static-gate-validate-parity requirement — folded into THIS slice, not
// deferred, because the spec MUST retire the pin in the SAME SLICE that deletes src/qa/validate.ts):
// the former qa-engine/test/.../static-gate-validate-parity.test.ts (TE-04) existed to prove the
// REAL, non-stubbed validateSpecs (imported across the src/qa-engine boundary) still catches the
// WF-02 zero-assertion gap — a Plan-6-style no-op validateAll wiring that would pass every STUB test
// but not a real one. That coverage is NOT lost: the "B2 RED"/"B2 GREEN" tests below already exercise
// the SAME real, non-stubbed zero-assertion scan (checkZeroAssertionSpecs is baked into validateSpecs
// itself, never injectable) against real temp-dir fixtures — now against the qa-engine-native
// validateSpecs directly, with no cross-boundary import left to retire. The old parity file, its
// qa-engine/tsconfig.json exclude entry, and its qa-engine/tsconfig.parity.json include entry are all
// removed in this same commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateSpecs,
  type ValidateDeps,
  runCheck,
  defaultValidateDeps,
  validateManifest,
  compileCommand,
  isToolchainFailure,
  validateCodeProject,
  type CodeValidateDeps,
} from "@contexts/test-execution/infrastructure/static-gate.checks.ts";
import type { CheckResult } from "@contexts/test-execution/application/ports/index.ts";
import type { CodeProject } from "@contexts/test-execution/infrastructure/code-execution.runner.ts";

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Part 1 — validateSpecs / runCheck / checkManifest (moved from src/qa/validate.test.ts)
// ══════════════════════════════════════════════════════════════════════════════════════════════

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
  assert.equal(res.infra, false); // lint error makes it a real validation failure
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

// ── B2: zero-assertion spec detection ───────────────────────────────────────

import { readFileSync as _readFileSync, writeFileSync as _writeFileSync, mkdtempSync as _mkdtempSync, mkdirSync as _mkdirSync, rmSync as _rmSync } from "node:fs";
import { tmpdir as _tmpdir } from "node:os";
import { join as _join } from "node:path";

function makeTmpSpecDir(specContent: string): string {
  const dir = _mkdtempSync(_join(_tmpdir(), "qa-validate-b2-"));
  // B2 scans the flows/ subdir (the generated-spec dir), so place the spec there.
  _mkdirSync(_join(dir, "flows"));
  _writeFileSync(_join(dir, "flows", "login.spec.ts"), specContent);
  return dir;
}

test("B2 RED: a spec file with NO expect() call is flagged as a zero-assertion error", async () => {
  const specDir = makeTmpSpecDir([
    `import { test } from "@playwright/test";`,
    `test("login loads", async ({ page }) => {`,
    `  await page.goto("/login");`,
    `  await page.click("button[type=submit]");`,
    `});`,
  ].join("\n"));
  try {
    const deps: ValidateDeps = { typecheck: ok, lint: ok, listTests: ok, checkManifest: ok };
    const res = await validateSpecs(specDir, deps);
    assert.equal(res.ok, false, "zero-assertion spec must produce a validation failure");
    assert.ok(res.errors.some((e) => /zero.assertion|no.*expect|login\.spec\.ts/i.test(e)),
      `expected a zero-assertion error; got: ${JSON.stringify(res.errors)}`);
    // Must NOT be classified as infra — this is a code quality issue, not a tool failure.
    assert.equal(res.infra, false);
  } finally {
    _rmSync(specDir, { recursive: true });
  }
});

test("B2 GREEN: a spec file with at least one expect() passes the zero-assertion check", async () => {
  const specDir = makeTmpSpecDir([
    `import { test, expect } from "@playwright/test";`,
    `test("login succeeds", async ({ page }) => {`,
    `  await page.goto("/login");`,
    `  await expect(page).toHaveURL("/dashboard");`,
    `});`,
  ].join("\n"));
  try {
    const deps: ValidateDeps = { typecheck: ok, lint: ok, listTests: ok, checkManifest: ok };
    const res = await validateSpecs(specDir, deps);
    // The other four checks all pass via stubs, so the overall result is ok.
    assert.equal(res.ok, true, "spec with expect() must pass the zero-assertion check");
  } finally {
    _rmSync(specDir, { recursive: true });
  }
});

test("B2: await expect() and expect.soft() both count as assertions", async () => {
  const specDir = makeTmpSpecDir([
    `import { test, expect } from "@playwright/test";`,
    `test("soft assertion", async ({ page }) => {`,
    `  await page.goto("/");`,
    `  await expect.soft(page.locator("h1")).toBeVisible();`,
    `});`,
  ].join("\n"));
  try {
    const deps: ValidateDeps = { typecheck: ok, lint: ok, listTests: ok, checkManifest: ok };
    const res = await validateSpecs(specDir, deps);
    assert.equal(res.ok, true, "expect.soft() must count as an assertion");
  } finally {
    _rmSync(specDir, { recursive: true });
  }
});

test("B2: a spec asserting ONLY via expect.poll() is NOT flagged (regression — poll is a real assertion)", async () => {
  const specDir = makeTmpSpecDir([
    `import { test, expect } from "@playwright/test";`,
    `test("eventually consistent", async ({ page }) => {`,
    `  await page.goto("/");`,
    `  await expect.poll(() => page.locator(".count").count()).toBeGreaterThan(0);`,
    `});`,
  ].join("\n"));
  try {
    const deps: ValidateDeps = { typecheck: ok, lint: ok, listTests: ok, checkManifest: ok };
    const res = await validateSpecs(specDir, deps);
    assert.equal(res.ok, true, "expect.poll() must count as an assertion (not a zero-assertion false-flag)");
  } finally {
    _rmSync(specDir, { recursive: true });
  }
});

test("B2: a zero-assertion spec at the e2e ROOT (the cleanup seed) is NOT flagged — only flows/ is checked", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "qa-validate-b2-seed-"));
  try {
    // The seed cleanup.spec.ts sits at the e2e ROOT and has no expect() by design (skip-guarded).
    _writeFileSync(_join(dir, "cleanup.spec.ts"), `import { test } from "@playwright/test";\ntest.skip("cleanup", async () => {});\n`);
    _mkdirSync(_join(dir, "flows"));
    _writeFileSync(_join(dir, "flows", "login.spec.ts"), `import { test, expect } from "@playwright/test";\ntest("login", async ({ page }) => { await expect(page).toHaveURL("/"); });\n`);
    const deps: ValidateDeps = { typecheck: ok, lint: ok, listTests: ok, checkManifest: ok };
    const res = await validateSpecs(dir, deps);
    assert.equal(res.ok, true, "the assertion-free seed spec at the e2e root must NOT be flagged");
  } finally {
    _rmSync(dir, { recursive: true });
  }
});

test("B2: a zero-assertion GENERATED spec under flows/ IS flagged", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "qa-validate-b2-flows-"));
  try {
    _mkdirSync(_join(dir, "flows"));
    _writeFileSync(_join(dir, "flows", "trivial.spec.ts"), `import { test } from "@playwright/test";\ntest("trivial", async ({ page }) => { await page.goto("/"); });\n`);
    const deps: ValidateDeps = { typecheck: ok, lint: ok, listTests: ok, checkManifest: ok };
    const res = await validateSpecs(dir, deps);
    assert.equal(res.ok, false, "a generated spec under flows/ with no expect must be flagged");
    assert.ok(res.errors.some((e) => /zero.assertion|trivial\.spec\.ts/i.test(e)), `expected a zero-assertion error; got ${JSON.stringify(res.errors)}`);
  } finally {
    _rmSync(dir, { recursive: true });
  }
});

// ── migration-tier-4b Slice 2 (gate DEFECT-1 fix): checkManifest is a DISTINCT strict read from
// generation's manifest-fs.ts::readManifest (fail-open-to-[]). This pins the byte-matching strict-
// read behavior against the REAL defaultValidateDeps implementation (not a stub), with real fs
// fixtures — now against the qa-engine-native home (Slice 3 relocated checkManifest itself).
test("defaultValidateDeps.checkManifest: a MISSING manifest.json is ok:false (never a fail-open pass)", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "qa-validate-checkmanifest-missing-"));
  try {
    const res = await defaultValidateDeps.checkManifest(dir);
    assert.equal(res.ok, false);
    assert.match(res.output, /unreadable or missing/);
  } finally {
    _rmSync(dir, { recursive: true });
  }
});

test("defaultValidateDeps.checkManifest: a CORRUPT (non-JSON) manifest.json is ok:false", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "qa-validate-checkmanifest-corrupt-"));
  try {
    _mkdirSync(_join(dir, ".qa"));
    _writeFileSync(_join(dir, ".qa", "manifest.json"), "{ not valid json ][");
    const res = await defaultValidateDeps.checkManifest(dir);
    assert.equal(res.ok, false);
  } finally {
    _rmSync(dir, { recursive: true });
  }
});

test("defaultValidateDeps.checkManifest: a well-formed manifest.json is ok:true (byte-matching today)", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "qa-validate-checkmanifest-ok-"));
  try {
    _mkdirSync(_join(dir, ".qa"));
    const entry = {
      id: "checkout", objective: "o", flow: "checkout",
      targets: ["CheckoutService.pay"], changeRef: { sha: "s", type: "feat" },
    };
    _writeFileSync(_join(dir, ".qa", "manifest.json"), JSON.stringify([entry]));
    const res = await defaultValidateDeps.checkManifest(dir);
    assert.equal(res.ok, true);
  } finally {
    _rmSync(dir, { recursive: true });
  }
});

test("defaultValidateDeps.checkManifest: an entry with criticality:\"urgent\" (not in the enum) is ok:false — write-time and read-time now share the SAME canonical validator", async () => {
  const dir = _mkdtempSync(_join(_tmpdir(), "qa-validate-checkmanifest-enum-"));
  try {
    _mkdirSync(_join(dir, ".qa"));
    const entry = {
      id: "checkout", objective: "o", flow: "checkout",
      targets: ["CheckoutService.pay"], changeRef: { sha: "s", type: "feat" },
      criticality: "urgent",
    };
    _writeFileSync(_join(dir, ".qa", "manifest.json"), JSON.stringify([entry]));
    const res = await defaultValidateDeps.checkManifest(dir);
    assert.equal(res.ok, false);
  } finally {
    _rmSync(dir, { recursive: true });
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Part 2 — validateManifest (moved from src/qa/metadata.test.ts)
// ══════════════════════════════════════════════════════════════════════════════════════════════

const validManifestEntry = {
  id: "checkout/over-10-items",
  objective: "With >10 items, checkout completes the payment",
  flow: "checkout",
  targets: ["CheckoutService.validateCart"],
  changeRef: { sha: "abc1234", type: "fix" },
};

test("an empty manifest is valid (repo with no tests yet)", () => {
  assert.equal(validateManifest([]).ok, true);
});

test("a complete entry is valid", () => {
  assert.equal(validateManifest([validManifestEntry]).ok, true);
});

test("rejects a non-array", () => {
  assert.equal(validateManifest({}).ok, false);
});

test("requires objective, flow, targets and changeRef", () => {
  const r = validateManifest([{ id: "x" }]);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /objective/);
  assert.match(r.errors.join(" "), /flow/);
  assert.match(r.errors.join(" "), /targets/);
  assert.match(r.errors.join(" "), /changeRef/);
});

test("detects duplicate ids", () => {
  const r = validateManifest([validManifestEntry, validManifestEntry]);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /duplicate id/);
});

test("empty targets is not allowed", () => {
  const r = validateManifest([{ ...validManifestEntry, targets: [] }]);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /targets/);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Part 3 — compileCommand / isToolchainFailure / validateCodeProject (moved from
// src/qa/code-validate.test.ts)
// ══════════════════════════════════════════════════════════════════════════════════════════════

const maven: CodeProject = { ecosystem: "maven", install: null, test: { cmd: "mvn", args: ["-B", "test"] } };
const gradle: CodeProject = { ecosystem: "gradle", install: null, test: { cmd: "./gradlew", args: ["test"] } };
const go: CodeProject = { ecosystem: "go", install: null, test: { cmd: "go", args: ["test", "./..."] } };
const rust: CodeProject = { ecosystem: "rust", install: null, test: { cmd: "cargo", args: ["test"] } };
const node: CodeProject = { ecosystem: "node", install: null, test: { cmd: "npm", args: ["test"] } };
const python: CodeProject = { ecosystem: "python", install: null, test: { cmd: "python3", args: ["-m", "pytest"] } };

// ── compileCommand: compiles TEST sources without running them, scoped when possible ──────────────
test("compileCommand: maven test-compile, scoped to the changed module when it resolves", () => {
  const exists = (p: string) => p === "/repo/customers-service/pom.xml" || p === "/repo/pom.xml";
  assert.deepEqual(compileCommand(maven, "/repo", ["customers-service/src/main/java/X.java"], { exists }), {
    cmd: "mvn",
    args: ["-B", "-pl", "customers-service", "-am", "test-compile"],
  });
});

test("compileCommand: maven whole-reactor test-compile when nothing scopes", () => {
  assert.deepEqual(compileCommand(maven, "/repo", [], { exists: () => true }), { cmd: "mvn", args: ["-B", "test-compile"] });
});

test("compileCommand: gradle testClasses", () => {
  assert.deepEqual(compileCommand(gradle, "/repo", [], { exists: () => false }), { cmd: "./gradlew", args: ["testClasses"] });
});

test("compileCommand: go vet (compiles _test.go which go build skips), rust cargo check --tests", () => {
  assert.deepEqual(compileCommand(go, "/repo", [], { exists: () => false }), { cmd: "go", args: ["vet", "./..."] });
  assert.deepEqual(compileCommand(rust, "/repo", [], { exists: () => false }), { cmd: "cargo", args: ["check", "--tests"] });
});

test("compileCommand: node tsc --noEmit only with a tsconfig; plain JS has no compile step", () => {
  assert.deepEqual(compileCommand(node, "/repo", [], { exists: (p) => p === "/repo/tsconfig.json" }), { cmd: "npx", args: ["tsc", "--noEmit"] });
  assert.equal(compileCommand(node, "/repo", [], { exists: () => false }), null);
});

test("compileCommand: unknown ecosystem has no compile gate (null)", () => {
  const unknown: CodeProject = { ecosystem: "unknown", install: null, test: { cmd: "npm", args: ["test"] } };
  assert.equal(compileCommand(unknown, "/repo", ["x.py"], { exists: () => true }), null);
});

test("compileCommand: python byte-compiles the changed .py files (syntax gate); none → null", () => {
  assert.deepEqual(compileCommand(python, "/repo", ["pkg/test_owner.py", "README.md"], { exists: () => true }), {
    cmd: "python3",
    args: ["-m", "compileall", "-q", "pkg/test_owner.py"],
  });
  assert.equal(compileCommand(python, "/repo", ["README.md"], { exists: () => true }), null);
  assert.equal(compileCommand(python, "/repo", [], { exists: () => true }), null);
});

// ── isToolchainFailure: a broken JVM toolchain is infra, not a code defect ─────────────────────────
test("isToolchainFailure: matches the REAL JDK/JAVA_HOME misconfig messages, not a normal compile error", () => {
  assert.equal(isToolchainFailure("Error: JAVA_HOME is not set and could not be found."), true);
  assert.equal(isToolchainFailure("The JAVA_HOME environment variable is not correctly set"), true);
  assert.equal(isToolchainFailure("No compiler is provided in this environment. Perhaps you are running on a JRE rather than a JDK?"), true);
  assert.equal(isToolchainFailure("[ERROR] /src/X.java:[12,5] cannot find symbol"), false);
});

// ── validateCodeProject: the orchestration (runCheck injected) ─────────────────────────────────────
function deps(project: CodeProject, result: CheckResult, onRun?: () => void): CodeValidateDeps {
  return {
    detect: () => project,
    runCheck: async () => {
      onRun?.();
      return result;
    },
  };
}

test("validateCodeProject: a clean compile is ok with no errors", async () => {
  const r = await validateCodeProject("/repo", deps(maven, { ok: true, output: "BUILD SUCCESS" }), {});
  assert.deepEqual(r, { ok: true, errors: [], infra: false });
});

test("validateCodeProject: a real compile error is invalid (not infra), with the error fed back", async () => {
  const r = await validateCodeProject("/repo", deps(maven, { ok: false, output: "[ERROR] cannot find symbol method map()" }), {});
  assert.equal(r.ok, false);
  assert.equal(r.infra, false);
  assert.match(r.errors[0]!, /compile/);
  assert.match(r.errors[0]!, /cannot find symbol/);
});

test("validateCodeProject: a missing/broken toolchain is infra, never blamed on the agent", async () => {
  const enoent = await validateCodeProject("/repo", deps(maven, { ok: false, output: "spawn mvn ENOENT", infra: true }), {});
  assert.equal(enoent.infra, true);
  const jdk = await validateCodeProject("/repo", deps(maven, { ok: false, output: "Error: JAVA_HOME is not set and could not be found." }), {});
  assert.equal(jdk.infra, true);
});

test("validateCodeProject: interpreted ecosystems are a no-op — the gate never spawns", async () => {
  let ran = false;
  const r = await validateCodeProject("/repo", deps(python, { ok: false, output: "x" }, () => (ran = true)), {});
  assert.deepEqual(r, { ok: true, errors: [], infra: false });
  assert.equal(ran, false);
});

test("validateCodeProject: secrets in the compile output are sanitized before the agent sees them", async () => {
  const r = await validateCodeProject("/repo", deps(maven, { ok: false, output: "aws.key=AKIAIOSFODNN7EXAMPLE [ERROR] boom" }), {});
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.errors[0]!, /AKIAIOSFODNN7EXAMPLE/);
});
