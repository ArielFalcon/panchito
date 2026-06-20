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
// The runtimes live in the ORCHESTRATOR image, not the agents container — the
// orchestrator spawns the test commands directly.

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
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
  "GONOSUMCHECK", "GOFLAGS", "GOCACHE", "JAVA_HOME", "M2_HOME", "M2_REPO", "M2", "NVM_DIR", "NODE_PATH", "NODE_OPTIONS",
  "DISPLAY", "SSH_AUTH_SOCK", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "DEBUG",
  "PKG_CONFIG_PATH", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH",
  // Playwright's browsers are baked at a NON-default path in the orchestrator image
  // (PLAYWRIGHT_BROWSERS_PATH=/ms-playwright). The e2e execution spawns Playwright through
  // scrubEnv; without this the child loses the path, falls back to the empty default cache
  // (/root/.cache/ms-playwright) and EVERY run fails with "Executable doesn't exist" — a false
  // `fail`, never an actual test result. The value is the orchestrator's own (not attacker
  // input) and points only at browser binaries, so it is safe to forward.
  "PLAYWRIGHT_BROWSERS_PATH",
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
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (BLOCKED_ENV_PREFIX.test(key)) continue; // secrets are blocked even if extraAllowed matches
    if (ALLOWED_ENV_EXACT.has(key) || ALLOWED_ENV_PREFIX.test(key) || (extraAllowed?.test(key) ?? false)) {
      env[key] = value;
    } else {
      dropped.push(key);
    }
  }
  if (dropped.length > 0) {
    console.warn(`[qa] scrubEnv dropped ${dropped.length} env var(s) not in allowlist: ${dropped.join(", ")}`);
  }
  return env;
}

// ── Privilege-drop sandbox for untrusted code execution (§21) ──────────────────
// scrubEnv() removes SECRETS FROM THE ENVIRONMENT, but the watched repo's install/test/coverage
// commands still run as the orchestrator's user (root, in the container) with its filesystem. That
// lets a malicious or buggy test READ the root-owned API token (config/.api_token, 0600), TAMPER
// with the orchestrator's own files (/app/src, node_modules), write SIBLING repos under
// /app/.mirrors, or plant a .git hook that later runs as root on the publish `git commit`. We close
// those by DROPPING PRIVILEGE: the untrusted spawns run as a dedicated unprivileged user (the
// `sandbox` user baked into the image), and the run's working copy is chowned to it so it can only
// write its OWN tree. NETWORK is intentionally left intact — Maven/Gradle resolve dependencies
// during the test phase, so a network namespace would break the JVM target; egress restriction is a
// deploy-layer control (see docker-compose.yml / docs/code-mode-sandbox.md).

export interface Sandbox {
  uid: number;
  gid: number;
  home: string;
}

// Resolves the sandbox identity, or null when privilege-drop does not apply (not root, not Linux,
// explicitly disabled, or the sandbox home is absent → the image wasn't built with the user). When
// null, spawns run as the current user exactly as before — so local `npm run qa` on macOS still works.
export function resolveSandbox(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  getuid: () => number = () => process.getuid?.() ?? -1,
  homeExists: (p: string) => boolean = existsSync,
): Sandbox | null {
  if (env.CODE_SANDBOX === "off") return null; // operator escape hatch
  if (platform !== "linux") return null; // uid/gid spawn needs POSIX privilege semantics
  if (getuid() !== 0) return null; // only root can setuid to the sandbox user
  const uid = Number(env.CODE_SANDBOX_UID ?? 1001);
  const gid = Number(env.CODE_SANDBOX_GID ?? uid);
  const home = env.CODE_SANDBOX_HOME ?? "/home/sandbox";
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid < 0) return null;
  if (!homeExists(home)) {
    console.warn(`[qa] code-mode sandbox DISABLED: home ${home} not found (image built without the sandbox user?). Untrusted code will run as the current user.`);
    return null;
  }
  return { uid, gid, home };
}

// Spawn options that drop to the sandbox: the uid/gid plus a HOME pointing at the sandbox's own
// writable home (so toolchain caches — ~/.m2, ~/.gradle, ~/.cache, ~/.cargo — never touch root's),
// merged onto the scrubbed env. When `sandbox` is null this is just the scrubbed env (unchanged),
// so the spawn runs exactly as before.
export function sandboxSpawnOptions(
  base: Record<string, string>,
  sandbox: Sandbox | null,
): { env: Record<string, string>; uid?: number; gid?: number } {
  if (!sandbox) return { env: base };
  return {
    env: { ...base, HOME: sandbox.home, USER: "sandbox", LOGNAME: "sandbox" },
    uid: sandbox.uid,
    gid: sandbox.gid,
  };
}

// Hand the run's working copy to the sandbox user so its install/test can write ONLY there. The
// chown runs on the SOURCE tree (before install/deps), so it is cheap. `.git` is kept ROOT-owned: a
// sandbox-writable `.git/hooks` would run as root on the orchestrator's next `git commit` (a classic
// sandbox escape). Root retains full access regardless of ownership, so publish/mirror git ops are
// unaffected. No-op when the sandbox does not apply.
export function prepareSandboxWorkdir(repoDir: string, sandbox: Sandbox | null = resolveSandbox()): void {
  if (!sandbox) return;
  execFileSync("chown", ["-R", `${sandbox.uid}:${sandbox.gid}`, repoDir], { stdio: "ignore" });
  const gitDir = join(repoDir, ".git");
  if (existsSync(gitDir)) execFileSync("chown", ["-R", "0:0", gitDir], { stdio: "ignore" });
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
    // `--ignore-scripts`: the watched repo is UNTRUSTED code running in the orchestrator. A
    // package.json install lifecycle (preinstall/postinstall/prepare) is arbitrary code execution
    // — the cheapest RCE vector. Skipping it closes that vector (SEC-01). Fail-safe: a repo that
    // genuinely needs a build script will fail its test command → infra-error (inconclusive), never
    // a false pass. (Only the code-mode UNTRUSTED install; the e2e seed install is the orchestrator's
    // own trusted fixtures and keeps its scripts.)
    const install: Command =
      pm === "npm"
        ? { cmd: "npm", args: [deps.exists(at("package-lock.json")) ? "ci" : "install", "--ignore-scripts"] }
        : { cmd: pm, args: ["install", "--ignore-scripts"] };
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
    // `-B` (batch mode), NOT `-q`: quiet mode suppresses surefire's INFO-level "Tests run: N"
    // summary, which is the only reliable signal that >=1 test actually executed (so a build
    // that compiles but collects zero tests cannot be told apart from a real pass). Batch mode
    // keeps that summary while dropping interactive download-progress noise.
    return { ecosystem: "maven", install: null, test: { cmd: "mvn", args: ["-B", "test"] } };
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

// ── Module scoping (diff-driven) ──────────────────────────────────────────────
// Running a monorepo's whole-repo test command on every diff is slow and lets an unrelated module's
// failure mask (or be blamed on) the changed module. When the diff's changed files ALL resolve to a
// build SUBMODULE, scope the command to those modules; otherwise fall back to the whole-repo command.
// Pure (the fs probe is injected) so the resolution is fully unit-tested.

const MODULE_DESCRIPTORS: Partial<Record<Ecosystem, readonly string[]>> = {
  maven: ["pom.xml"],
  gradle: ["build.gradle", "build.gradle.kts"],
  go: ["go.mod"],
  node: ["package.json"],
};

// Parent of a repo-relative POSIX path ("a/b/c" → "a/b", "pom.xml" → ""). Git always emits
// "/"-separated paths, so this is deterministic regardless of host platform.
function parentDir(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "" : p.slice(0, i);
}

// Resolve each changed file to the nearest ancestor SUBMODULE (a dir below the repo root carrying the
// ecosystem's build descriptor). Returns the unique submodule dirs (repo-relative, sorted) when EVERY
// file resolves; null when scoping is unsafe — no files, an unsupported ecosystem, or any file that
// lives only under the root descriptor (not a submodule). Null means "run the whole repo" (the safe
// fallback). A file that IS a descriptor (e.g. `svc/pom.xml`) resolves to its own module.
export function resolveChangedModules(
  ecosystem: Ecosystem,
  repoDir: string,
  changedFiles: string[],
  deps: Pick<DetectDeps, "exists">,
): string[] | null {
  const descriptors = MODULE_DESCRIPTORS[ecosystem];
  if (!descriptors || changedFiles.length === 0) return null;
  const hasDescriptor = (dir: string): boolean => descriptors.some((d) => deps.exists(join(repoDir, dir, d)));

  const modules = new Set<string>();
  for (const file of changedFiles) {
    let dir = parentDir(file);
    let resolved: string | null = null;
    while (dir) {
      if (hasDescriptor(dir)) {
        resolved = dir;
        break;
      }
      dir = parentDir(dir);
    }
    if (resolved === null) return null; // not in a submodule (root-level file) → cannot safely scope
    modules.add(resolved);
  }
  return [...modules].sort();
}

// Narrow a project's TEST command to the resolved module(s). Pure. Caller guarantees `modules`
// non-empty (it came from resolveChangedModules).
export function scopeTestCommand(project: CodeProject, modules: string[]): Command {
  switch (project.ecosystem) {
    case "maven":
      // -pl selects the module(s); -am also-makes their upstream deps so a clean checkout compiles.
      return { cmd: "mvn", args: ["-B", "-pl", modules.join(","), "-am", "test"] };
    case "gradle":
      // One :module:test task per changed module; preserve the detected launcher (./gradlew | gradle).
      return { cmd: project.test.cmd, args: modules.map((m) => `:${m.replace(/\//g, ":")}:test`) };
    case "go":
      // Scope to the changed packages (and their subpackages).
      return { cmd: "go", args: ["test", ...modules.map((m) => `./${m}/...`)] };
    default:
      return project.test; // defensive: resolveChangedModules already returns null for these
  }
}

export interface ScopedRun {
  test: Command;
  scoped: boolean;
  note: string; // log-ready line explaining the decision (distinguishes the two fallback reasons)
}

// The single entry the runner + compile gate use. Returns the scoped command + a note; falls back to
// the whole-repo command (with a DISTINCT note) when there is no changed-file list (non-diff run) vs.
// when a diff's files did not all resolve to a submodule (a genuine scope-loss worth surfacing).
export function scopeForChangedFiles(
  project: CodeProject,
  repoDir: string,
  changedFiles: string[],
  deps: Pick<DetectDeps, "exists"> = realDetectDeps,
): ScopedRun {
  if (changedFiles.length === 0) {
    return { test: project.test, scoped: false, note: "non-diff run (no changed-file list) — running the whole repo" };
  }
  const modules = resolveChangedModules(project.ecosystem, repoDir, changedFiles, deps);
  if (!modules || modules.length === 0) {
    return {
      test: project.test,
      scoped: false,
      note: `changed files did not all resolve to a ${project.ecosystem} submodule — running the whole repo`,
    };
  }
  return { test: scopeTestCommand(project, modules), scoped: true, note: `scoped to module(s): ${modules.join(", ")}` };
}

// ── Setup (install deps) ──────────────────────────────────────────────────────

export interface CodeSetupDeps {
  detect(repoDir: string): CodeProject;
  install(project: CodeProject, repoDir: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  // Hands the working copy to the unprivileged sandbox user BEFORE any untrusted spawn (§21). Runs
  // for every code-mode run — including the null-install ecosystems (Maven/Gradle/Rust) whose first
  // untrusted spawn is the test itself — so it must execute before the install-null early return.
  prepareWorkdir?(repoDir: string): void;
}

export async function setupCodeProject(
  repoDir: string,
  deps: CodeSetupDeps,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<void> {
  const project = deps.detect(repoDir);
  deps.prepareWorkdir?.(repoDir); // drop the working copy to the sandbox user before any spawn
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
  prepareWorkdir: (repoDir) => prepareSandboxWorkdir(repoDir),
  install: (project, repoDir, opts) =>
    new Promise((resolve, reject) => {
      const { cmd, args } = project.install!;
      const child = spawn(cmd, args, { cwd: repoDir, detached: true, ...sandboxSpawnOptions(scrubEnv(), resolveSandbox()) });
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
  changedFiles?: string[]; // diff-driven module scoping: the commit's changed files (repo-relative)
  log?: (line: string) => void; // surface the scope decision into the run log
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

  // rust (cargo test): libtest prints "running N tests" per test binary AND per doctest set,
  // regardless of verbosity. If the crate compiled (exit 0), reported "running 0 tests", and
  // NO binary/doctest ran >=1 test, nothing was collected — a green build with zero coverage.
  if (project.ecosystem === "rust" && out.exitCode === 0 && /running 0 tests/.test(log) && !/running [1-9]\d* tests?/.test(log)) return true;

  // maven (surefire, run with -B so the summary is visible): a successful build that never
  // printed "Tests run: [1-9]" executed zero tests — no *Test classes matched or surefire was
  // skipped. Conservative: a real run always prints a non-zero "Tests run" summary.
  if (project.ecosystem === "maven" && out.exitCode === 0 && !/Tests run: [1-9]/.test(log)) return true;

  // gradle: the test task reports NO-SOURCE (no test sources) or SKIPPED when nothing runs.
  // Marker-based (never fires on a real run, which prints neither for :test).
  if (project.ecosystem === "gradle" && out.exitCode === 0 && /> Task :\S*[Tt]est\S*\s+(?:NO-SOURCE|SKIPPED)/.test(log)) return true;

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
  const detected = deps.detect(repoDir);
  // Diff-driven module scoping: narrow the command to the changed module(s) on a monorepo, else fall
  // back to the whole repo. Surfaced so a scoped run is never confused with a whole-repo fallback.
  const scope = scopeForChangedFiles(detected, repoDir, opts.changedFiles ?? []);
  opts.log?.(`[qa] code-mode: ${scope.note}`);
  const project: CodeProject = { ...detected, test: scope.test };

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
      const child = spawn(cmd, args, { cwd: repoDir, detached: true, ...sandboxSpawnOptions(scrubEnv(), resolveSandbox()) });
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

// ── Code-mode change coverage ─────────────────────────────────────────────────
// Real change-coverage for code runs (the keystone). The repo's plain test command emits
// no coverage report, so we re-run the NODE suite under c8 — universal V8 coverage WITH
// source-map support, so TS/tsx maps back to source lines. This is BEST-EFFORT and fully
// DECOUPLED from the pass/fail run: it runs after the verdict is decided, its exit code is
// ignored, and any failure just means "unmeasured" (never a false fail). Other ecosystems
// are not yet instrumented (→ null → honest "unmeasured"); add them the same way.

// resolveC8Bin finds the c8 CLI bundled with the orchestrator (a devDependency, installed
// into the image). null when absent — coverage is then simply skipped.
function resolveC8Bin(): string | null {
  try {
    return createRequire(import.meta.url).resolve("c8/bin/c8.js");
  } catch {
    return null;
  }
}

// coverageCommand wraps a node project's test command with c8 to emit coverage/lcov.info.
// Pure (the command shape is unit-tested); returns null for ecosystems we don't instrument.
export function coverageCommand(project: CodeProject, repoDir: string, c8Bin: string): Command | null {
  if (project.ecosystem !== "node") return null;
  return {
    cmd: process.execPath, // node — run the c8 CLI directly so no PATH/npx lookup is needed
    args: [
      c8Bin,
      "--reporter=lcovonly",
      "--reports-dir",
      join(repoDir, "coverage"),
      "--all=false", // measure only files the suite touched, not the whole tree
      "--",
      project.test.cmd,
      ...project.test.args,
    ],
  };
}

// runCodeCoverage produces coverage/lcov.info for the repo's suite, best-effort. Returns
// without throwing on any failure (missing c8, non-node ecosystem, timeout, crash) so the
// caller falls back to "unmeasured". It never reports pass/fail — only a side-effect report.
export async function runCodeCoverage(
  repoDir: string,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<void> {
  if (opts?.signal?.aborted) return;
  const c8Bin = resolveC8Bin();
  if (!c8Bin) return;
  const command = coverageCommand(detectCodeProject(repoDir), repoDir, c8Bin);
  if (!command) return;
  await new Promise<void>((resolve) => {
    const child = spawn(command.cmd, command.args, { cwd: repoDir, detached: true, ...sandboxSpawnOptions(scrubEnv(), resolveSandbox()) });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish();
    }, opts?.timeoutMs ?? DEFAULT_CODE_MODE_TIMEOUT_MS);
    opts?.signal?.addEventListener("abort", () => {
      killTree(child);
      finish();
    }, { once: true });
    child.on("error", finish); // c8 missing or spawn failure → no report, no harm
    child.on("close", finish); // success OR test failure — we only want the report
  });
}
