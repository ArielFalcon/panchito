// Code mode (TestTarget "code"): test source-code logic WITHOUT a web environment
// or Playwright. The agent writes tests in the repo's own framework/conventions;
// the orchestrator installs the repo's dependencies and runs its test command,
// classifying the outcome by EXIT CODE — binary pass/fail (no flaky concept).
//
// This is the code-mode analogue of setup.ts (install) + execute.ts (run+classify).
// The project is auto-detected from the files present in the repo; the spawn is
// injected so the orchestration is unit-testable and the real process is the only
// uncovered boundary (mirroring the rest of src/qa/*).
//
// Runtime note: the orchestrator image ships Node plus Python, Go, Rust, Maven
// and Gradle (see the root Dockerfile). A missing runtime (e.g. image built without
// a language) fails with ENOENT and is reported as infra-error, never a pass.
// The runtimes live in the ORCHESTRATOR image, not the opencode container — the
// orchestrator spawns the test commands directly.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { QaCase, QaRunResult } from "../types";
import { sanitizeText, containsSecrets, recordAudit } from "../orchestrator/sanitizer";

// ── Environment scrubbing for untrusted code execution ─────────────────────────
// The watched repo's install and test commands run in the orchestrator process.
// Passing the full process.env would give untrusted code GITHUB_TOKEN (push access
// to the repo) and other secrets. This function strips credentials while preserving
// the OS and language vars that package managers and test runners need to function.

// Secret FAMILIES that must never reach untrusted code (prefix match — DOPPLER_TOKEN,
// AWS_*, AZURE_* are all blocked). Defense-in-depth: the allowlist below is the real gate
// (anything not allowed is dropped), but blocking secrets explicitly guards against an
// allowlist entry accidentally widening to cover one.
const BLOCKED_ENV_PREFIX = /^(?:GITHUB_TOKEN|GH_TOKEN|OPENCODE_API_KEY|WEBHOOK_SECRET|QA_API_TOKEN|DOPPLER_|AWS_|AZURE_|GCP_|GOOGLE_APPLICATION_CREDENTIALS|NPM_TOKEN|NODE_AUTH_TOKEN)/;

// Allowed exact var names (OS + language essentials that are single vars, not families).
const ALLOWED_ENV_EXACT = new Set([
  "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "TMPDIR", "TEMPDIR", "TMP", "TEMP",
  "NODE_ENV", "CI", "PYTHON", "VIRTUAL_ENV", "GOPATH", "GOROOT", "GOPRIVATE", "GOPROXY",
  "GONOSUMCHECK", "GOFLAGS", "GOCACHE", "JAVA_HOME", "NVM_DIR", "NODE_PATH", "NODE_OPTIONS",
  "DISPLAY", "SSH_AUTH_SOCK", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "DEBUG",
  "PKG_CONFIG_PATH", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH",
]);

// Allowed var FAMILIES (prefix match — each token genuinely names a family of vars the
// toolchain needs: npm registry/cache/proxy config, Cargo/Rust/Gradle/Maven homes, locale).
const ALLOWED_ENV_PREFIX = /^(?:LC_|npm_config_|PIP_|CGO_|CARGO_|RUSTUP_|RUST_|GRADLE_|MAVEN_|PNPM_|YARN_|COREPACK_)/;

// Builds a scrubbed environment for an UNTRUSTED spawn (the watched repo's own test/install
// commands, or agent-written specs). Drops the orchestrator's secrets, keeps OS + language
// vars. `extraAllowed` lets a caller widen the allowlist by prefix without ever overriding
// the secret block — e2e passes /^DEV_/ to keep the app's login creds the specs need.
// Kills the spawned process AND its descendants. Spawns are `detached: true` so the child
// is its own process-group leader; `process.kill(-pid)` signals the whole group (npm/mvn/
// gradle fork grandchildren that a plain `child.kill()` would orphan). Falls back to a direct
// kill if the group send fails (e.g. the child already exited).
function killTree(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

export function scrubEnv(extraAllowed?: RegExp): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (BLOCKED_ENV_PREFIX.test(key)) continue; // secrets are blocked even if extraAllowed matches
    if (ALLOWED_ENV_EXACT.has(key) || ALLOWED_ENV_PREFIX.test(key) || (extraAllowed?.test(key) ?? false)) {
      env[key] = value;
    }
  }
  return env;
}

export type Ecosystem = "node" | "python" | "go" | "rust" | "maven" | "gradle" | "unknown";

export interface Command {
  cmd: string;
  args: string[];
}

export interface CodeProject {
  ecosystem: Ecosystem;
  install: Command | null; // null when the test command resolves its own deps
  test: Command;
}

// ── Detection ────────────────────────────────────────────────────────────────
// Pure: decide the ecosystem + commands from the files present. Readers injected.

export interface DetectDeps {
  exists(path: string): boolean;
  readJson(path: string): Record<string, unknown> | null;
}

export const realDetectDeps: DetectDeps = {
  exists: existsSync,
  readJson: (p) => {
    try {
      return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  },
};

export function detectCodeProject(repoDir: string, deps: DetectDeps = realDetectDeps): CodeProject {
  const at = (f: string): string => join(repoDir, f);

  // Node / JS / TS — the first-class, image-supported ecosystem.
  if (deps.exists(at("package.json"))) {
    const pm: "npm" | "pnpm" | "yarn" = deps.exists(at("pnpm-lock.yaml"))
      ? "pnpm"
      : deps.exists(at("yarn.lock"))
        ? "yarn"
        : "npm";
    const pkg = deps.readJson(at("package.json")) ?? {};
    const install: Command =
      pm === "npm"
        ? { cmd: "npm", args: [deps.exists(at("package-lock.json")) ? "ci" : "install"] }
        : { cmd: pm, args: ["install"] };
    return { ecosystem: "node", install, test: nodeTestCommand(pm, pkg) };
  }

  // Python
  if (
    deps.exists(at("pyproject.toml")) ||
    deps.exists(at("setup.py")) ||
    deps.exists(at("requirements.txt")) ||
    deps.exists(at("pytest.ini")) ||
    deps.exists(at("tox.ini"))
  ) {
    // Use `python3`/`python3 -m pip` — the binaries the orchestrator image actually provides
    // (it installs python3/python3-pip, not the `python`/`pip` symlinks).
    const install: Command | null = deps.exists(at("requirements.txt"))
      ? { cmd: "python3", args: ["-m", "pip", "install", "-r", "requirements.txt"] }
      : deps.exists(at("pyproject.toml")) || deps.exists(at("setup.py"))
        ? { cmd: "python3", args: ["-m", "pip", "install", "-e", "."] }
        : null;
    return { ecosystem: "python", install, test: { cmd: "python3", args: ["-m", "pytest", "-q"] } };
  }

  // Go
  if (deps.exists(at("go.mod"))) {
    return { ecosystem: "go", install: { cmd: "go", args: ["mod", "download"] }, test: { cmd: "go", args: ["test", "./..."] } };
  }

  // Rust
  if (deps.exists(at("Cargo.toml"))) {
    return { ecosystem: "rust", install: null, test: { cmd: "cargo", args: ["test"] } };
  }

  // JVM
  if (deps.exists(at("pom.xml"))) {
    return { ecosystem: "maven", install: null, test: { cmd: "mvn", args: ["-q", "test"] } };
  }
  if (deps.exists(at("build.gradle")) || deps.exists(at("build.gradle.kts"))) {
    const gradlew = deps.exists(at("gradlew"));
    return { ecosystem: "gradle", install: null, test: { cmd: gradlew ? "./gradlew" : "gradle", args: ["test"] } };
  }

  // Unknown: best-effort npm test (the agent declares its framework; if it wrote a
  // package.json test script this still works, otherwise execution fails loudly).
  return { ecosystem: "unknown", install: null, test: { cmd: "npm", args: ["test"] } };
}

function nodeTestCommand(pm: "npm" | "pnpm" | "yarn", pkg: Record<string, unknown>): Command {
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  const hasRealTestScript = typeof scripts.test === "string" && !/no test specified/i.test(scripts.test);
  if (hasRealTestScript) return { cmd: pm, args: ["test"] };

  // No usable test script → run a detected runner directly.
  const deps = {
    ...((pkg.devDependencies as Record<string, string>) ?? {}),
    ...((pkg.dependencies as Record<string, string>) ?? {}),
  };
  if ("vitest" in deps) return { cmd: "npx", args: ["vitest", "run"] };
  if ("jest" in deps) return { cmd: "npx", args: ["jest"] };
  if ("mocha" in deps) return { cmd: "npx", args: ["mocha"] };
  // Node's built-in test runner as the last resort.
  return { cmd: "node", args: ["--test"] };
}

// ── Setup (install deps) ──────────────────────────────────────────────────────

export interface CodeSetupDeps {
  detect(repoDir: string): CodeProject;
  install(project: CodeProject, repoDir: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
}

export async function setupCodeProject(
  repoDir: string,
  deps: CodeSetupDeps,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<void> {
  const project = deps.detect(repoDir);
  if (!project.install) return;
  if (opts?.signal?.aborted) throw new Error("code-mode install aborted by operator cancel");

  // Race install against a timeout at the orchestration level (defense in depth: the real
  // spawn below also SIGKILLs the child). A hung `npm ci`/`mvn`/`gradle` must not block the
  // sequential queue forever — on timeout we reject, which the pipeline maps to infra-error.
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_CODE_MODE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`code-mode install timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([deps.install(project, repoDir, opts), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

export const defaultCodeSetupDeps: CodeSetupDeps = {
  detect: (repoDir) => detectCodeProject(repoDir),
  install: (project, repoDir, opts) =>
    new Promise((resolve, reject) => {
      const { cmd, args } = project.install!;
      const child = spawn(cmd, args, { cwd: repoDir, env: scrubEnv(), detached: true });
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        err ? reject(err) : resolve();
      };
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_CODE_MODE_TIMEOUT_MS;
      const timer = setTimeout(() => {
        killTree(child);
        settle(new Error(`code-mode install timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      opts?.signal?.addEventListener("abort", () => {
        killTree(child);
        settle(new Error("code-mode install aborted by operator cancel"));
      }, { once: true });
      child.on("error", (err) => settle(err instanceof Error ? err : new Error(String(err))));
      child.on("close", (code) =>
        settle(code === 0 ? undefined : new Error(`code-mode install failed (${cmd} ${args.join(" ")}, exit ${code})`)),
      );
    }),
};

// ── Execute (run tests, classify by exit code) ────────────────────────────────

export interface CodeRunOutput {
  exitCode: number | null; // null when the process was killed by a signal
  logs: string;
  spawnError?: string; // set when the runtime/binary is missing (ENOENT) → infra
}

export interface CodeExecuteDeps {
  detect(repoDir: string): CodeProject;
  runTests(project: CodeProject, repoDir: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<CodeRunOutput>;
}

export interface CodeExecuteOptions {
  namespace: string;
  onCase?: (c: QaCase) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export const DEFAULT_CODE_MODE_TIMEOUT_MS = 600_000; // 10 min — prevents a hung suite from blocking the queue forever

// High-confidence "the suite executed ZERO tests" detection, per ecosystem/command.
// Exit code 0 is NOT proof of a real pass: `node --test`, `go test ./...` and others
// exit 0 when they collected nothing, and pytest exits 5 ("no tests collected") which
// the bare exit-code classifier would read as a FAIL on the watched repo. This is
// deliberately CONSERVATIVE — it only fires on unambiguous "nothing ran" signals, so a
// genuine pass/fail is never misclassified. The residual (e.g. a no-op npm "test"
// script that exits 0) is left to upstream spec-vs-disk reconciliation.
export function ranZeroTests(project: CodeProject, out: CodeRunOutput): boolean {
  const log = out.logs;
  const cmd = `${project.test.cmd} ${project.test.args.join(" ")}`;

  // pytest: exit code 5 is the documented "no tests collected".
  if (project.ecosystem === "python" && out.exitCode === 5) return true;

  // go test ./...: packages without _test.go print "[no test files]"; if NO package
  // reported "ok" (a package that actually ran tests), the suite executed nothing.
  if (project.ecosystem === "go" && out.exitCode === 0 && /no test files/.test(log) && !/^ok\s/m.test(log)) return true;

  // node:test: the TAP/summary line reports the executed count. Check it for the WHOLE
  // node ecosystem (not only a literal `node --test` cmd) because the project's test
  // script almost always wraps it as `npm test` — the case that ships in practice. The
  // `# tests N` / `ℹ tests N` line is node:test-specific, so this never matches jest/vitest.
  if (project.ecosystem === "node" && /(?:#|ℹ)\s*tests\s+0\b/.test(log)) return true;

  // jest / vitest: explicit "no tests" message (robust to --passWithNoTests configured).
  if (/\bnpx (?:jest|vitest)\b/.test(cmd) && /No tests? (?:found|files? found)/i.test(log)) return true;

  // mocha: prints "0 passing" and exits 0 when it ran nothing.
  if (cmd.includes("npx mocha") && out.exitCode === 0 && /\b0 passing\b/.test(log)) return true;

  return false;
}

// Extracts pass/fail/total counts from common test runner output formats.
export function parseTestCounts(logs: string): { pass: number; fail: number; total: number } | null {
  const nodeMatch = logs.match(/(?:[ℹ#])\s*tests\s+(\d+)[\s\S]*?(?:[ℹ#])\s*pass\s+(\d+)[\s\S]*?(?:[ℹ#])\s*fail\s+(\d+)/);
  if (nodeMatch) return { pass: Number(nodeMatch[2]), fail: Number(nodeMatch[3]), total: Number(nodeMatch[1]) };
  const jestMatch = logs.match(/Tests:\s*(\d+)\s+passed?,\s*(\d+)\s+failed?,\s*(\d+)\s+total/i);
  if (jestMatch) return { pass: Number(jestMatch[1]), fail: Number(jestMatch[2]), total: Number(jestMatch[3]) };
  const pyMatch = logs.match(/(\d+)\s+passed?,\s*(\d+)\s+failed/i);
  if (pyMatch) { const p=Number(pyMatch[1]), f=Number(pyMatch[2]); return { pass: p, fail: f, total: p+f }; }
  const mochaMatch = logs.match(/(\d+)\s+passing/i);
  if (mochaMatch) { const p=Number(mochaMatch[1]); return { pass: p, fail: 0, total: p }; }
  return null;
}

export async function runCodeTests(
  repoDir: string,
  opts: CodeExecuteOptions,
  deps: CodeExecuteDeps,
): Promise<QaRunResult> {
  const project = deps.detect(repoDir);

  // Already-aborted signal: don't even start the spawn.
  if (opts.signal?.aborted) {
    return {
      sha: opts.namespace,
      verdict: "infra-error",
      passed: false,
      cases: [],
      logs: "code-mode run aborted by operator cancel",
    };
  }

  // Race the suite against a timeout. The timeout is enforced at the orchestrator
  // level (defense in depth: the spawn in defaultCodeExecuteDeps also SIGKILLs the
  // child on timeout, but this catch-all handles stubbed tests and edge cases).
  const runPromise = deps.runTests(project, repoDir, { signal: opts.signal, timeoutMs: opts.timeoutMs });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CODE_MODE_TIMEOUT_MS;
  const timeoutResult: CodeRunOutput = {
    exitCode: null,
    logs: "",
    spawnError: `code-mode timeout after ${timeoutMs}ms`,
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<CodeRunOutput>((resolve) => {
    timer = setTimeout(() => resolve(timeoutResult), timeoutMs);
  });

  let out: CodeRunOutput;
  try {
    out = await Promise.race([runPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }

  if (containsSecrets(out.logs)) {
    console.warn("[sanitizer] Secrets detected in code-test logs — redacting before publish");
  }
  const sanitized = sanitizeText(out.logs);
  recordAudit(opts.namespace, sanitized.detection);

  const label = `${project.ecosystem} tests (${project.test.cmd} ${project.test.args.join(" ")})`;

  // The test runtime is missing in the image (ENOENT) — inconclusive infrastructure,
  // NEVER a code bug and NEVER a pass.
  if (out.spawnError) {
    return {
      sha: opts.namespace,
      verdict: "infra-error",
      passed: false,
      cases: [],
      logs: `${project.ecosystem} runtime unavailable: ${out.spawnError}\n\n${sanitized.text}`,
    };
  }

  // A run that collected zero tests proves nothing: never a pass, and never a FAIL
  // that blames the watched repo. Inconclusive infrastructure (mirrors the e2e
  // "ran but executed zero tests" guard and the spawn-error case above).
  if (ranZeroTests(project, out)) {
    return {
      sha: opts.namespace,
      verdict: "infra-error",
      passed: false,
      cases: [],
      logs: `${label} executed zero tests (no tests were collected) — inconclusive, not a pass\n\n${sanitized.text}`,
    };
  }

  const ok = out.exitCode === 0;
  const status = ok ? "pass" : "fail";
  const detail = ok ? undefined : tail(sanitized.text, 1500);
  const counts = parseTestCounts(sanitized.text);
  const kase: QaCase = { name: label, status, detail, objective: "code test suite", flow: counts ? `${counts.pass} pass / ${counts.fail} fail / ${counts.total} total` : undefined };
  opts.onCase?.(kase);

  return {
    sha: opts.namespace,
    verdict: ok ? "pass" : "fail",
    passed: ok,
    cases: [kase],
    logs: sanitized.text,
  };
}

function tail(s: string, n: number): string {
  return s.length > n ? s.slice(-n) : s;
}

export const defaultCodeExecuteDeps: CodeExecuteDeps = {
  detect: (repoDir) => detectCodeProject(repoDir),
  runTests: (project, repoDir, opts) =>
    new Promise((resolve) => {
      const { cmd, args } = project.test;
      const child = spawn(cmd, args, { cwd: repoDir, env: scrubEnv(), detached: true });
      let stdout = "";
      let stderr = "";
      let resolved = false;

      const finish = (result: CodeRunOutput) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve(result);
      };

      // Timeout guard: a hung suite must not block the sequential queue forever.
      // Kill the whole PROCESS TREE (npm/mvn/gradle fork grandchildren) and resolve as
      // inconclusive infra, not a pass.
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_CODE_MODE_TIMEOUT_MS;
      const timer = setTimeout(() => {
        killTree(child);
        finish({ exitCode: null, logs: `${stdout}\n${stderr}`, spawnError: `code-mode timeout after ${timeoutMs}ms` });
      }, timeoutMs);

      // Operator cancel: the pipeline's AbortSignal fires → kill the suite immediately.
      if (opts?.signal) {
        opts.signal.addEventListener("abort", () => {
          killTree(child);
          finish({ exitCode: null, logs: `${stdout}\n${stderr}`, spawnError: "aborted by operator cancel" });
        }, { once: true });
      }

      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) => finish({ exitCode: null, logs: `${stderr}${stdout}`, spawnError: String(err) }));
      child.on("close", (code) => finish({ exitCode: code, logs: `${stdout}\n${stderr}`.trim() }));
    }),
};
