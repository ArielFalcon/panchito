import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectCodeProject,
  setupCodeProject,
  runCodeTests,
  DetectDeps,
  CodeProject,
  CodeExecuteDeps,
  CodeSetupDeps,
} from "./code-runner";

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
  assert.deepEqual(p.install, { cmd: "npm", args: ["ci"] });
  assert.deepEqual(p.test, { cmd: "npm", args: ["test"] });
});

test("Node without a lockfile installs with npm install", () => {
  const p = detectCodeProject("/r", fs(["package.json"], { scripts: { test: "jest" } }));
  assert.deepEqual(p.install, { cmd: "npm", args: ["install"] });
});

test("pnpm/yarn detected from their lockfiles", () => {
  const pnpm = detectCodeProject("/r", fs(["package.json", "pnpm-lock.yaml"], { scripts: { test: "x" } }));
  assert.deepEqual(pnpm.install, { cmd: "pnpm", args: ["install"] });
  assert.deepEqual(pnpm.test, { cmd: "pnpm", args: ["test"] });
  const yarn = detectCodeProject("/r", fs(["package.json", "yarn.lock"], { scripts: { test: "x" } }));
  assert.deepEqual(yarn.install, { cmd: "yarn", args: ["install"] });
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

test("detects Python (pytest)", () => {
  const p = detectCodeProject("/r", fs(["pyproject.toml"]));
  assert.equal(p.ecosystem, "python");
  assert.deepEqual(p.install, { cmd: "pip", args: ["install", "-e", "."] });
  assert.deepEqual(p.test, { cmd: "python", args: ["-m", "pytest", "-q"] });
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

test("setupCodeProject runs install only when there is an install command", async () => {
  let installed = 0;
  const project: CodeProject = { ecosystem: "node", install: { cmd: "npm", args: ["ci"] }, test: { cmd: "npm", args: ["test"] } };
  const deps: CodeSetupDeps = { detect: () => project, install: async () => { installed++; } };
  await setupCodeProject("/r", deps);
  assert.equal(installed, 1);

  const noInstall: CodeSetupDeps = {
    detect: () => ({ ecosystem: "rust", install: null, test: { cmd: "cargo", args: ["test"] } }),
    install: async () => { installed++; },
  };
  await setupCodeProject("/r", noInstall);
  assert.equal(installed, 1); // unchanged
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

test("logs are sanitized before returning", async () => {
  const deps: CodeExecuteDeps = {
    detect: () => nodeProject,
    runTests: async () => ({ exitCode: 1, logs: "leaking token: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa here" }),
  };
  const run = await runCodeTests("/r", { namespace: "qa-bot-s" }, deps);
  assert.doesNotMatch(run.logs, /ghp_aaaa/);
});
