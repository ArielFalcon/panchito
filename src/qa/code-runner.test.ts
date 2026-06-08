import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectCodeProject,
  setupCodeProject,
  runCodeTests,
  scrubEnv,
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

// A hung `npm ci`/`mvn`/`gradle` install must NOT block the sequential queue forever.
// The install path needs the same timeout the test path has.
test("code-mode install that hangs is killed by timeout (does not block the queue)", { timeout: 3000 }, async () => {
  const project: CodeProject = { ecosystem: "node", install: { cmd: "npm", args: ["ci"] }, test: { cmd: "npm", args: ["test"] } };
  const deps: CodeSetupDeps = { detect: () => project, install: () => new Promise(() => {}) }; // never resolves
  await assert.rejects(() => setupCodeProject("/r", deps, { timeoutMs: 100 }), /timeout/i);
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

test("npm test wrapping node:test that executed ZERO tests is infra-error (the real self-test case)", async () => {
  // ai-pipeline's own test command is `npm test`, which wraps `node --test`. The node:test
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

test("logs are sanitized before returning", async () => {
  const deps: CodeExecuteDeps = {
    detect: () => nodeProject,
    runTests: async () => ({ exitCode: 1, logs: "leaking token: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa here" }),
  };
  const run = await runCodeTests("/r", { namespace: "qa-bot-s" }, deps);
  assert.doesNotMatch(run.logs, /ghp_aaaa/);
});

// Security: untrusted code (the watched repo's install and test commands) must never
// receive secrets. GITHUB_TOKEN in the spawn env would let a malicious/compromised
// repo push to itself — breaking the read-only security boundary.
test("scrubEnv strips secrets but preserves language vars and OS essentials", () => {
  const saved = { ...process.env };
  try {
    // Plant secrets that the watched repo must never see.
    process.env.GITHUB_TOKEN = "ghp_fakeSecretValue123456";
    process.env.OPENCODE_API_KEY = "opencode-go-fakeKeyValue12345";
    process.env.WEBHOOK_SECRET = "whsec_fakeWebhookSecret";
    process.env.QA_API_TOKEN = "qa_fakeApiTokenValue12345";
    process.env.DOPPLER_TOKEN = "dp_fakeDopplerToken";
    // Plant harmless vars that code-mode tools need.
    process.env.PATH = "/custom/bin";
    process.env.HOME = "/home/testuser";
    process.env.GOPATH = "/home/testuser/go";
    process.env.NODE_ENV = "test";
    process.env.CI = "true";

    const env = scrubEnv();

    // Secrets MUST be absent.
    assert.ok(!("GITHUB_TOKEN" in env), "GITHUB_TOKEN must not leak to untrusted code");
    assert.ok(!("OPENCODE_API_KEY" in env), "OPENCODE_API_KEY must not leak to untrusted code");
    assert.ok(!("WEBHOOK_SECRET" in env), "WEBHOOK_SECRET must not leak to untrusted code");
    assert.ok(!("QA_API_TOKEN" in env), "QA_API_TOKEN must not leak to untrusted code");
    assert.ok(!("DOPPLER_TOKEN" in env), "DOPPLER_TOKEN must not leak to untrusted code");

    // Essential vars for package managers / test runners MUST be present.
    assert.equal(env.PATH, "/custom/bin", "PATH must be preserved");
    assert.equal(env.HOME, "/home/testuser", "HOME must be preserved");
    assert.equal(env.GOPATH, "/home/testuser/go", "GOPATH must be preserved");
    assert.equal(env.NODE_ENV, "test", "NODE_ENV must be preserved");
    assert.equal(env.CI, "true", "CI must be preserved");
  } finally {
    // Restore original env so no side effects leak to other tests.
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
});

// e2e spawns need the app's DEV_* login creds (fixtures read DEV_TEST_USER/PASS) but must
// still drop the orchestrator's own secrets. scrubEnv takes an extra-allowed prefix for this.
test("scrubEnv with an extra-allowed prefix keeps DEV_* creds but still drops orchestrator secrets", () => {
  const saved = { ...process.env };
  try {
    process.env.DEV_TEST_USER = "qauser";
    process.env.DEV_TEST_PASS = "qapass";
    process.env.GITHUB_TOKEN = "ghp_fakeSecretValue1234567890";
    const env = scrubEnv(/^DEV_/);
    assert.equal(env.DEV_TEST_USER, "qauser", "DEV_* must be kept for e2e login");
    assert.equal(env.DEV_TEST_PASS, "qapass");
    assert.ok(!("GITHUB_TOKEN" in env), "orchestrator secrets must still be dropped");
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
});

// The allowlist must keep whole FAMILIES of package-manager/locale vars (npm_config_*,
// CARGO_*, LC_*, GRADLE_*), not just the bare prefix string — otherwise `npm ci` loses its
// registry/cache/proxy config and Cargo/Gradle lose their home dirs.
test("scrubEnv preserves prefix-family language vars (npm_config_*, CARGO_*, LC_*, GRADLE_*)", () => {
  const saved = { ...process.env };
  try {
    process.env.npm_config_cache = "/cache";
    process.env.npm_config_registry = "https://registry.local";
    process.env.CARGO_HOME = "/home/u/.cargo";
    process.env.LC_ALL = "C.UTF-8";
    process.env.GRADLE_USER_HOME = "/home/u/.gradle";
    process.env.DOPPLER_TOKEN = "dp_fakeSecret"; // a secret family → must STILL be dropped
    const env = scrubEnv();
    assert.equal(env.npm_config_cache, "/cache", "npm_config_* must be preserved (npm ci needs it)");
    assert.equal(env.npm_config_registry, "https://registry.local");
    assert.equal(env.CARGO_HOME, "/home/u/.cargo");
    assert.equal(env.LC_ALL, "C.UTF-8");
    assert.equal(env.GRADLE_USER_HOME, "/home/u/.gradle");
    assert.ok(!("DOPPLER_TOKEN" in env), "DOPPLER_ secrets must still be blocked");
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
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
