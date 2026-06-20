import { test } from "node:test";
import assert from "node:assert/strict";
import { compileCommand, isToolchainFailure, validateCodeProject, type CodeValidateDeps } from "./code-validate";
import type { CodeProject } from "./code-runner";
import type { CheckResult } from "./validate";

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

test("compileCommand: interpreted/unknown ecosystems have no compile gate (null)", () => {
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
