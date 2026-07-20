// qa-engine/test/contexts/test-execution/infrastructure/code-execution.runner.test.ts
// Behavioral tests for the code-mode detection/scoping/execution body, moved from
// src/qa/code-runner.test.ts (migration-tier-4b, Slice 1 — code-execution migration). Byte-identical
// assertions to the legacy file (only the import path changes, plus the return-type rename
// QaRunResult → CodeRunResult, which is structurally identical). setupCodeProject tests live in this
// directory's own code-setup.test.ts sibling; resolveSandbox/sandboxSpawnOptions tests live in
// shared-infrastructure/process-sandbox/sandbox.test.ts; scrubEnv tests live in that directory's own
// scrub-env.test.ts (all pre-existing / already split, per code-runner.ts's own new home split).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  detectCodeProject,
  runCodeTests,
  coverageCommand,
  resolveChangedModules,
  scopeTestCommand,
  scopeForChangedFiles,
  failureDetail,
  parsePorcelain,
  effectiveChangedFiles,
  type DetectDeps,
  type CodeProject,
  type CodeExecuteDeps,
} from "@contexts/test-execution/infrastructure/code-execution.runner.ts";

// ── Module scoping (diff-driven) ──────────────────────────────────────────────
function existsFrom(paths: string[]): (p: string) => boolean {
  const set = new Set(paths);
  return (p) => set.has(p);
}

test("resolveChangedModules: maven files in one submodule resolve to that module", () => {
  const exists = existsFrom(["/repo/customers-service/pom.xml", "/repo/pom.xml"]);
  const mods = resolveChangedModules(
    "maven",
    "/repo",
    ["customers-service/src/main/java/Owner.java", "customers-service/src/test/java/OwnerTest.java"],
    { exists },
  );
  assert.deepEqual(mods, ["customers-service"]);
});

test("resolveChangedModules: files across two submodules resolve to both (sorted, deduped)", () => {
  const exists = existsFrom(["/repo/vets-service/pom.xml", "/repo/customers-service/pom.xml", "/repo/pom.xml"]);
  const mods = resolveChangedModules(
    "maven",
    "/repo",
    ["vets-service/src/main/java/Vet.java", "customers-service/src/main/java/Owner.java"],
    { exists },
  );
  assert.deepEqual(mods, ["customers-service", "vets-service"]);
});

test("resolveChangedModules: a changed module pom.xml resolves to its OWN module, not the root", () => {
  const exists = existsFrom(["/repo/customers-service/pom.xml", "/repo/pom.xml"]);
  assert.deepEqual(resolveChangedModules("maven", "/repo", ["customers-service/pom.xml"], { exists }), ["customers-service"]);
});

test("resolveChangedModules: a root-level change (root pom / CI file) cannot scope → null", () => {
  const exists = existsFrom(["/repo/customers-service/pom.xml", "/repo/pom.xml"]);
  assert.equal(resolveChangedModules("maven", "/repo", ["pom.xml"], { exists }), null);
  assert.equal(resolveChangedModules("maven", "/repo", [".github/workflows/ci.yml"], { exists }), null);
});

test("resolveChangedModules: ANY unresolved file forces a whole-repo fallback (null)", () => {
  const exists = existsFrom(["/repo/customers-service/pom.xml", "/repo/pom.xml"]);
  assert.equal(
    resolveChangedModules("maven", "/repo", ["customers-service/src/main/java/Owner.java", "README.md"], { exists }),
    null,
  );
});

test("resolveChangedModules: empty changed files and unsupported ecosystems return null", () => {
  const exists = existsFrom(["/repo/pom.xml"]);
  assert.equal(resolveChangedModules("maven", "/repo", [], { exists }), null);
  assert.equal(resolveChangedModules("rust", "/repo", ["src/lib.rs"], { exists }), null);
  assert.equal(resolveChangedModules("python", "/repo", ["pkg/mod.py"], { exists }), null);
});

test("scopeTestCommand: maven scopes with -pl <modules> -am (also-make upstream deps)", () => {
  const project: CodeProject = { ecosystem: "maven", install: null, test: { cmd: "mvn", args: ["-B", "test"] } };
  assert.deepEqual(scopeTestCommand(project, ["customers-service", "vets-service"]), {
    cmd: "mvn",
    args: ["-B", "-pl", "customers-service,vets-service", "-am", "test"],
  });
});

test("scopeTestCommand: go scopes to the changed packages", () => {
  const project: CodeProject = { ecosystem: "go", install: null, test: { cmd: "go", args: ["test", "./..."] } };
  assert.deepEqual(scopeTestCommand(project, ["svc/users"]), { cmd: "go", args: ["test", "./svc/users/..."] });
});

test("scopeTestCommand: node scopes the DIRECT runners (jest/vitest/node --test) by path; an opaque script → null", () => {
  const jest: CodeProject = { ecosystem: "node", install: null, test: { cmd: "npx", args: ["jest"] } };
  assert.deepEqual(scopeTestCommand(jest, ["packages/billing"]), { cmd: "npx", args: ["jest", "packages/billing"] });
  const vitest: CodeProject = { ecosystem: "node", install: null, test: { cmd: "npx", args: ["vitest", "run"] } };
  assert.deepEqual(scopeTestCommand(vitest, ["packages/billing"]), { cmd: "npx", args: ["vitest", "run", "packages/billing"] });
  const nodeTest: CodeProject = { ecosystem: "node", install: null, test: { cmd: "node", args: ["--test"] } };
  assert.deepEqual(scopeTestCommand(nodeTest, ["pkg"]), { cmd: "node", args: ["--test", "pkg"] });
  const script: CodeProject = { ecosystem: "node", install: null, test: { cmd: "npm", args: ["test"] } };
  assert.equal(scopeTestCommand(script, ["pkg"]), null); // opaque `npm test` script — cannot scope safely
});

test("scopeForChangedFiles: node with a jest runner scopes to the changed package", () => {
  const exists = existsFrom(["/repo/packages/billing/package.json", "/repo/package.json"]);
  const project: CodeProject = { ecosystem: "node", install: null, test: { cmd: "npx", args: ["jest"] } };
  const r = scopeForChangedFiles(project, "/repo", ["packages/billing/src/x.ts"], { exists });
  assert.equal(r.scoped, true);
  assert.deepEqual(r.test, { cmd: "npx", args: ["jest", "packages/billing"] });
});

test("scopeForChangedFiles: no changed files → whole-repo fallback (non-diff run)", () => {
  const project: CodeProject = { ecosystem: "maven", install: null, test: { cmd: "mvn", args: ["-B", "test"] } };
  const r = scopeForChangedFiles(project, "/repo", [], { exists: () => true });
  assert.equal(r.scoped, false);
  assert.deepEqual(r.test, project.test);
  assert.match(r.note, /non-diff|whole repo/i);
});

test("scopeForChangedFiles: resolved modules → scoped command + a note naming the module", () => {
  const exists = existsFrom(["/repo/customers-service/pom.xml", "/repo/pom.xml"]);
  const project: CodeProject = { ecosystem: "maven", install: null, test: { cmd: "mvn", args: ["-B", "test"] } };
  const r = scopeForChangedFiles(project, "/repo", ["customers-service/src/main/java/Owner.java"], { exists });
  assert.equal(r.scoped, true);
  assert.deepEqual(r.test.args, ["-B", "-pl", "customers-service", "-am", "test"]);
  assert.match(r.note, /customers-service/);
});

test("scopeForChangedFiles: a diff-mode change that does not resolve → fallback with a DISTINCT note", () => {
  const exists = existsFrom(["/repo/customers-service/pom.xml", "/repo/pom.xml"]);
  const project: CodeProject = { ecosystem: "maven", install: null, test: { cmd: "mvn", args: ["-B", "test"] } };
  const r = scopeForChangedFiles(project, "/repo", ["pom.xml"], { exists });
  assert.equal(r.scoped, false);
  assert.deepEqual(r.test, project.test);
  assert.match(r.note, /did not all resolve|could not scope/i);
});

test("scopeForChangedFiles: node is NOT mislabeled as scoped — per-module RUN scoping is unsupported → whole repo", () => {
  // node CAN resolve a package.json dir, but scopeTestCommand has no node case (workspace layouts
  // vary), so the run must HONESTLY fall back to whole-repo, not claim a scope it does not apply.
  const exists = existsFrom(["/repo/packages/billing/package.json", "/repo/package.json"]);
  const project: CodeProject = { ecosystem: "node", install: null, test: { cmd: "npm", args: ["test"] } };
  const r = scopeForChangedFiles(project, "/repo", ["packages/billing/src/x.ts"], { exists });
  assert.equal(r.scoped, false);
  assert.deepEqual(r.test, project.test);
  assert.match(r.note, /not yet supported|whole repo/i);
});

// ── G1: scope by the agent's git writes when there is no input diff (manual/complete) ─────────────
test("parsePorcelain: extracts modified, added and untracked paths (rename → new path)", () => {
  const out = [
    " M src/foo.ts",
    "A  src/added.go",
    "?? customers-service/src/test/java/X.java",
    "R  old/path.ts -> new/path.ts",
  ].join("\n");
  assert.deepEqual(parsePorcelain(out), ["src/foo.ts", "src/added.go", "customers-service/src/test/java/X.java", "new/path.ts"]);
});

test("effectiveChangedFiles: prefers the input diff; falls back to the agent's writes when empty", () => {
  assert.deepEqual(effectiveChangedFiles(["a.ts"], "/repo", () => ["b.ts"]), ["a.ts"]);
  assert.deepEqual(effectiveChangedFiles([], "/repo", () => ["b.ts"]), ["b.ts"]);
  assert.deepEqual(effectiveChangedFiles([], "/repo", undefined), []);
});

test("manual scoping: with NO input diff, scope by the agent's git writes (the highest-impact gap)", () => {
  const exists = existsFrom(["/repo/customers-service/pom.xml", "/repo/pom.xml"]);
  const project: CodeProject = { ecosystem: "maven", install: null, test: { cmd: "mvn", args: ["-B", "test"] } };
  // No input changedFiles (manual run) — derive the scope from what the agent wrote.
  const changed = effectiveChangedFiles([], "/repo", () => ["customers-service/src/test/java/OwnerTest.java"]);
  const r = scopeForChangedFiles(project, "/repo", changed, { exists });
  assert.equal(r.scoped, true);
  assert.match(r.test.args.join(" "), /-pl customers-service/);
});

// ── failureDetail: diagnosable code-mode failure output ───────────────────────
test("failureDetail: short output is returned whole", () => {
  assert.equal(failureDetail("boom", 1500), "boom");
});

test("failureDetail: long output keeps the HEAD and the TAIL (a 1500-char tail alone drops the error)", () => {
  const head = "HEAD_MARKER" + "a".repeat(1000);
  const tail = "b".repeat(1000) + "TAIL_MARKER";
  const out = failureDetail(head + tail, 400);
  assert.match(out, /HEAD_MARKER/);
  assert.match(out, /TAIL_MARKER/);
  assert.match(out, /omitted/);
});

test("failureDetail: surfaces surefire failing-test lines so a large reactor failure is diagnosable", () => {
  const log = [
    "[INFO] Running com.example.OwnerResourceTest",
    "testMapOwner(com.example.OwnerEntityMapperTest)  Time elapsed: 0.1 s  <<< FAILURE!",
    "org.opentest4j.AssertionFailedError: expected: <X> but was: <Y>",
    "[INFO] Tests run: 3, Failures: 1",
  ].join("\n");
  const out = failureDetail(log, 1500);
  assert.match(out, /Failing tests/);
  assert.match(out, /OwnerEntityMapperTest/);
});

test("coverageCommand wraps a node suite with c8 → coverage/lcov.info", () => {
  const project: CodeProject = { ecosystem: "node", install: null, test: { cmd: "npm", args: ["test"] } };
  const cmd = coverageCommand(project, "/repo", "/c8/bin/c8.js");
  assert.ok(cmd, "node projects must be instrumented");
  assert.deepEqual(cmd.args, [
    "/c8/bin/c8.js", "--reporter=lcovonly", "--reports-dir", join("/repo", "coverage"), "--all=false", "--", "npm", "test",
  ]);
});

test("coverageCommand returns null for ecosystems not yet instrumented", () => {
  const go: CodeProject = { ecosystem: "go", install: { cmd: "go", args: ["mod", "download"] }, test: { cmd: "go", args: ["test", "./..."] } };
  assert.equal(coverageCommand(go, "/repo", "/c8.js"), null);
});

// A DetectDeps stub from a set of "present" files (+ optional package.json content).
function fs(present: string[], pkg?: Record<string, unknown>): DetectDeps {
  return {
    exists: (p) => present.some((f) => p.endsWith(f)),
    readJson: (p) => (p.endsWith("package.json") ? (pkg ?? {}) : null),
  };
}

test("detects a Node project with a real test script (npm)", () => {
  const p = detectCodeProject("/r", fs(["package.json", "package-lock.json"], { scripts: { test: "vitest run" } }));
  assert.equal(p.ecosystem, "node");
  // --ignore-scripts: untrusted-repo install must not run arbitrary lifecycle scripts (SEC-01).
  assert.deepEqual(p.install, { cmd: "npm", args: ["ci", "--ignore-scripts"] });
  assert.deepEqual(p.test, { cmd: "npm", args: ["test"] });
});

test("Node without a lockfile installs with npm install (scripts ignored)", () => {
  const p = detectCodeProject("/r", fs(["package.json"], { scripts: { test: "jest" } }));
  assert.deepEqual(p.install, { cmd: "npm", args: ["install", "--ignore-scripts"] });
});

test("pnpm/yarn detected from their lockfiles (scripts ignored)", () => {
  const pnpm = detectCodeProject("/r", fs(["package.json", "pnpm-lock.yaml"], { scripts: { test: "x" } }));
  assert.deepEqual(pnpm.install, { cmd: "pnpm", args: ["install", "--ignore-scripts"] });
  assert.deepEqual(pnpm.test, { cmd: "pnpm", args: ["test"] });
  const yarn = detectCodeProject("/r", fs(["package.json", "yarn.lock"], { scripts: { test: "x" } }));
  assert.deepEqual(yarn.install, { cmd: "yarn", args: ["install", "--ignore-scripts"] });
});

test("Node with the npm-default 'no test specified' script falls back to a runner", () => {
  const p = detectCodeProject(
    "/r",
    fs(["package.json"], { scripts: { test: 'echo "Error: no test specified" && exit 1' }, devDependencies: { vitest: "^1" } }),
  );
  assert.deepEqual(p.test, { cmd: "npx", args: ["vitest", "run"] });
});

test("Node with no test script and no known runner uses node --test", () => {
  const p = detectCodeProject("/r", fs(["package.json"], {}));
  assert.deepEqual(p.test, { cmd: "node", args: ["--test"] });
});

test("detects Python (pytest) using python3 (the binary the image actually provides)", () => {
  const p = detectCodeProject("/r", fs(["pyproject.toml"]));
  assert.equal(p.ecosystem, "python");
  // The orchestrator image installs `python3`/`python3-pip`, NOT `python`/`pip` symlinks.
  assert.deepEqual(p.install, { cmd: "python3", args: ["-m", "pip", "install", "-e", "."] });
  assert.deepEqual(p.test, { cmd: "python3", args: ["-m", "pytest", "-q"] });
});

test("detects Go", () => {
  const p = detectCodeProject("/r", fs(["go.mod"]));
  assert.equal(p.ecosystem, "go");
  assert.deepEqual(p.test, { cmd: "go", args: ["test", "./..."] });
});

test("unknown ecosystem falls back to npm test (no install)", () => {
  const p = detectCodeProject("/r", fs([]));
  assert.equal(p.ecosystem, "unknown");
  assert.equal(p.install, null);
});

const nodeProject: CodeProject = { ecosystem: "node", install: { cmd: "npm", args: ["ci"] }, test: { cmd: "npm", args: ["test"] } };

test("exit code 0 => pass with one synthetic case", async () => {
  const deps: CodeExecuteDeps = {
    detect: () => nodeProject,
    runTests: async () => ({ exitCode: 0, logs: "12 passing" }),
  };
  const cases: string[] = [];
  const run = await runCodeTests("/r", { namespace: "qa-bot-x", onCase: (c) => cases.push(c.status) }, deps);
  assert.equal(run.verdict, "pass");
  assert.equal(run.passed, true);
  assert.equal(run.cases.length, 1);
  assert.deepEqual(cases, ["pass"]);
});

test("non-zero exit => fail with the output tail as detail", async () => {
  const deps: CodeExecuteDeps = {
    detect: () => nodeProject,
    runTests: async () => ({ exitCode: 1, logs: "1 failing: expected 2 got 3" }),
  };
  const run = await runCodeTests("/r", { namespace: "qa-bot-y" }, deps);
  assert.equal(run.verdict, "fail");
  assert.equal(run.passed, false);
  assert.match(run.cases[0]!.detail ?? "", /1 failing/);
});

test("a missing runtime (spawnError) is infra-error, NEVER fail or pass", async () => {
  const deps: CodeExecuteDeps = {
    detect: () => ({ ecosystem: "python", install: null, test: { cmd: "python", args: ["-m", "pytest"] } }),
    runTests: async () => ({ exitCode: null, logs: "", spawnError: "Error: spawn python ENOENT" }),
  };
  const run = await runCodeTests("/r", { namespace: "qa-bot-z" }, deps);
  assert.equal(run.verdict, "infra-error");
  assert.equal(run.passed, false);
  assert.equal(run.cases.length, 0);
  assert.match(run.logs, /runtime unavailable/);
});

// Code-mode false-green guard: exit-code 0 is NOT enough — a runner that collected
// ZERO tests (no tests matched, empty suite) exits 0 and would otherwise pass. And
// pytest's exit 5 ("no tests collected") must not be a false FAIL on the watched repo.
test("node --test that executed zero tests is infra-error, not a false pass", async () => {
  const project: CodeProject = { ecosystem: "node", install: null, test: { cmd: "node", args: ["--test"] } };
  const deps: CodeExecuteDeps = { detect: () => project, runTests: async () => ({ exitCode: 0, logs: "ℹ tests 0\nℹ pass 0\nℹ fail 0" }) };
  const run = await runCodeTests("/r", { namespace: "qa-bot-n0" }, deps);
  assert.equal(run.verdict, "infra-error");
  assert.equal(run.passed, false);
});

test("npm test wrapping node:test that executed ZERO tests is infra-error (the real self-test case)", async () => {
  // panchito's own test command is `npm test`, which wraps `node --test`. The node:test
  // summary still reports the count, so a zero-test run MUST be caught even though cmd is `npm`.
  const project: CodeProject = { ecosystem: "node", install: null, test: { cmd: "npm", args: ["test"] } };
  const deps: CodeExecuteDeps = { detect: () => project, runTests: async () => ({ exitCode: 0, logs: "ℹ tests 0\nℹ pass 0\nℹ fail 0" }) };
  const run = await runCodeTests("/r", { namespace: "qa-bot-npm0" }, deps);
  assert.equal(run.verdict, "infra-error"); // not a false pass over zero executed tests
  assert.equal(run.passed, false);
});

test("npm test wrapping node:test with real tests passing stays pass (no over-firing)", async () => {
  const project: CodeProject = { ecosystem: "node", install: null, test: { cmd: "npm", args: ["test"] } };
  const deps: CodeExecuteDeps = { detect: () => project, runTests: async () => ({ exitCode: 0, logs: "ℹ tests 331\nℹ pass 331\nℹ fail 0" }) };
  const run = await runCodeTests("/r", { namespace: "qa-bot-npmN" }, deps);
  assert.equal(run.verdict, "pass");
});

test("pytest exit 5 (no tests collected) is infra-error, not a false fail", async () => {
  const project: CodeProject = { ecosystem: "python", install: null, test: { cmd: "python", args: ["-m", "pytest", "-q"] } };
  const deps: CodeExecuteDeps = { detect: () => project, runTests: async () => ({ exitCode: 5, logs: "no tests ran in 0.01s" }) };
  const run = await runCodeTests("/r", { namespace: "qa-bot-p5" }, deps);
  assert.equal(run.verdict, "infra-error");
  assert.equal(run.passed, false);
});

test("go test with only [no test files] is infra-error, not a false pass", async () => {
  const project: CodeProject = { ecosystem: "go", install: null, test: { cmd: "go", args: ["test", "./..."] } };
  const deps: CodeExecuteDeps = { detect: () => project, runTests: async () => ({ exitCode: 0, logs: "?   example/gt   [no test files]" }) };
  const run = await runCodeTests("/r", { namespace: "qa-bot-g0" }, deps);
  assert.equal(run.verdict, "infra-error");
  assert.equal(run.passed, false);
});

test("go test that actually ran tests stays a pass (not over-flagged)", async () => {
  const project: CodeProject = { ecosystem: "go", install: null, test: { cmd: "go", args: ["test", "./..."] } };
  const deps: CodeExecuteDeps = { detect: () => project, runTests: async () => ({ exitCode: 0, logs: "ok   example/gt   0.42s\n?   example/util   [no test files]" }) };
  const run = await runCodeTests("/r", { namespace: "qa-bot-gok" }, deps);
  assert.equal(run.verdict, "pass");
});

test("detects a Maven project with -B (not -q, so surefire summary stays visible)", () => {
  const p = detectCodeProject("/r", fs(["pom.xml"]));
  assert.equal(p.ecosystem, "maven");
  assert.deepEqual(p.test, { cmd: "mvn", args: ["-B", "test"] });
});

test("cargo test that compiled but ran zero tests is infra-error, not a false pass", async () => {
  const project: CodeProject = { ecosystem: "rust", install: null, test: { cmd: "cargo", args: ["test"] } };
  const log = "   Compiling app v0.1.0\n    Finished test [unoptimized]\n     Running unittests\n\nrunning 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored";
  const deps: CodeExecuteDeps = { detect: () => project, runTests: async () => ({ exitCode: 0, logs: log }) };
  const run = await runCodeTests("/r", { namespace: "qa-bot-rs0" }, deps);
  assert.equal(run.verdict, "infra-error");
  assert.equal(run.passed, false);
});

test("cargo test that actually ran tests stays a pass (not over-flagged)", async () => {
  const project: CodeProject = { ecosystem: "rust", install: null, test: { cmd: "cargo", args: ["test"] } };
  const log = "running 3 tests\ntest tests::adds ... ok\n\ntest result: ok. 3 passed; 0 failed";
  const deps: CodeExecuteDeps = { detect: () => project, runTests: async () => ({ exitCode: 0, logs: log }) };
  const run = await runCodeTests("/r", { namespace: "qa-bot-rsok" }, deps);
  assert.equal(run.verdict, "pass");
});

test("maven build with no 'Tests run: N' executed zero tests → infra-error, not a false pass", async () => {
  const project: CodeProject = { ecosystem: "maven", install: null, test: { cmd: "mvn", args: ["-B", "test"] } };
  const deps: CodeExecuteDeps = { detect: () => project, runTests: async () => ({ exitCode: 0, logs: "[INFO] Building app 1.0\n[INFO] BUILD SUCCESS\n[INFO] Total time: 4.2 s" }) };
  const run = await runCodeTests("/r", { namespace: "qa-bot-mvn0" }, deps);
  assert.equal(run.verdict, "infra-error");
  assert.equal(run.passed, false);
});

test("maven that ran tests (Tests run: 12) stays a pass", async () => {
  const project: CodeProject = { ecosystem: "maven", install: null, test: { cmd: "mvn", args: ["-B", "test"] } };
  const deps: CodeExecuteDeps = { detect: () => project, runTests: async () => ({ exitCode: 0, logs: "[INFO] Results:\n[INFO] Tests run: 12, Failures: 0, Errors: 0, Skipped: 0\n[INFO] BUILD SUCCESS" }) };
  const run = await runCodeTests("/r", { namespace: "qa-bot-mvnN" }, deps);
  assert.equal(run.verdict, "pass");
});

test("gradle :test NO-SOURCE (no test sources) is infra-error, not a false pass", async () => {
  const project: CodeProject = { ecosystem: "gradle", install: null, test: { cmd: "./gradlew", args: ["test"] } };
  const log = "> Task :compileTestJava NO-SOURCE\n> Task :test NO-SOURCE\n\nBUILD SUCCESSFUL in 2s";
  const deps: CodeExecuteDeps = { detect: () => project, runTests: async () => ({ exitCode: 0, logs: log }) };
  const run = await runCodeTests("/r", { namespace: "qa-bot-gr0" }, deps);
  assert.equal(run.verdict, "infra-error");
  assert.equal(run.passed, false);
});

test("gradle that executed :test stays a pass (no NO-SOURCE/SKIPPED marker)", async () => {
  const project: CodeProject = { ecosystem: "gradle", install: null, test: { cmd: "./gradlew", args: ["test"] } };
  const deps: CodeExecuteDeps = { detect: () => project, runTests: async () => ({ exitCode: 0, logs: "> Task :compileTestJava\n> Task :test\n\nBUILD SUCCESSFUL in 6s" }) };
  const run = await runCodeTests("/r", { namespace: "qa-bot-grok" }, deps);
  assert.equal(run.verdict, "pass");
});

test("logs are sanitized before returning", async () => {
  const deps: CodeExecuteDeps = {
    detect: () => nodeProject,
    runTests: async () => ({ exitCode: 1, logs: "leaking token: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa here" }),
  };
  const run = await runCodeTests("/r", { namespace: "qa-bot-s" }, deps);
  assert.doesNotMatch(run.logs, /ghp_aaaa/);
});

// A hanging test suite (infinite loop, hung network call, OOM) blocks the sequential
// queue forever. Timeout must kill the process tree and resolve as infra-error.
test("code-mode spawn that never completes is killed by timeout → infra-error", async () => {
  const project: CodeProject = { ecosystem: "node", install: null, test: { cmd: "node", args: ["--test"] } };
  const deps: CodeExecuteDeps = {
    detect: () => project,
    // Return a promise that never resolves — the orchestrator's timeout must win.
    runTests: () => new Promise(() => {}),
  };
  const run = await runCodeTests("/r", { namespace: "qa-bot-t", timeoutMs: 100 }, deps);
  assert.equal(run.verdict, "infra-error");
  assert.match(run.logs, /timeout/i);
});

// An operator cancel mid-execute must stop the run and NOT publish. The AbortSignal
// must kill the spawned process and resolve as infra-error.
test("code-mode spawn aborted via AbortSignal → infra-error", async () => {
  const controller = new AbortController();
  const project: CodeProject = { ecosystem: "node", install: null, test: { cmd: "node", args: ["--test"] } };
  const deps: CodeExecuteDeps = {
    detect: () => project,
    // Return a promise that never resolves — the abort signal must win.
    runTests: () => new Promise(() => {}),
  };
  controller.abort();
  const run = await runCodeTests("/r", { namespace: "qa-bot-ab", signal: controller.signal }, deps);
  assert.equal(run.verdict, "infra-error");
  assert.match(run.logs, /aborted/i);
});

// migration-tier-4b Slice 1: recordAudit is now an OPTIONAL injected hook (CodeExecuteDeps.
// recordAudit), not a hardcoded import (qa-engine stays src/-free). Pins that it fires exactly
// when a secret was redacted, with the run's namespace and the detection result, and that a run
// with no redaction never calls it.
test("recordAudit hook fires with the run namespace + detection when a secret was redacted", async () => {
  const calls: Array<[string, boolean]> = [];
  const deps: CodeExecuteDeps = {
    detect: () => nodeProject,
    runTests: async () => ({ exitCode: 1, logs: "leaking token: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa here" }),
    recordAudit: (runId, detection) => calls.push([runId, detection.redacted]),
  };
  await runCodeTests("/r", { namespace: "qa-bot-audit" }, deps);
  assert.deepEqual(calls, [["qa-bot-audit", true]]);
});

test("recordAudit hook is called with redacted:false when no secret was found (never skipped)", async () => {
  const calls: Array<[string, boolean]> = [];
  const deps: CodeExecuteDeps = {
    detect: () => nodeProject,
    runTests: async () => ({ exitCode: 0, logs: "12 passing" }),
    recordAudit: (runId, detection) => calls.push([runId, detection.redacted]),
  };
  await runCodeTests("/r", { namespace: "qa-bot-clean" }, deps);
  assert.deepEqual(calls, [["qa-bot-clean", false]]);
});

test("runCodeTests works with no recordAudit hook at all (optional — safe for unit tests that don't care)", async () => {
  const deps: CodeExecuteDeps = {
    detect: () => nodeProject,
    runTests: async () => ({ exitCode: 0, logs: "12 passing" }),
  };
  const run = await runCodeTests("/r", { namespace: "qa-bot-noaudit" }, deps);
  assert.equal(run.verdict, "pass");
});
