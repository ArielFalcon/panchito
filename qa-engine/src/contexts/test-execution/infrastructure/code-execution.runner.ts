// qa-engine/src/contexts/test-execution/infrastructure/code-execution.runner.ts
// Code mode (TestTarget "code"): test source-code logic WITHOUT a web environment or Playwright.
// The agent writes tests in the repo's own framework/conventions; the orchestrator installs the
// repo's dependencies (code-setup.ts, this file's sibling) and runs its test command, classifying
// the outcome by EXIT CODE — binary pass/fail (no flaky concept).
//
// migration-tier-4b Slice 1 (code-execution migration): body-moved from src/qa/code-runner.ts —
// qa-engine now OWNS this body directly instead of CodeExecutionStrategy injecting a closure that
// calls back into src/. Behavior-preserving: the 7-branch ecosystem matrix, module-scoping rules,
// zero-test detection signatures, and exit-code classification are byte-identical to the legacy
// implementation. Two deliberate, invariant-driven differences from the legacy body:
//   1. `killTree` (a local, unexported helper at HEAD) is replaced by the canonical
//      `ProcessKillPort`/`ProcessKillAdapter` (shared-kernel/shared-infrastructure) — this is the
//      LAST of the four duplicate killTree copies named in process-kill.adapter.ts's own header,
//      now retired.
//   2. The privilege-drop `Sandbox` is INJECTED (not resolved internally via `resolveSandbox()`
//      reading `process.env`) — CLAUDE.md's env-read confinement invariant forbids a NEW
//      `process.env` read inside qa-engine/src; the composition-root shell
//      (src/server/rewritten-engine-factory.ts) resolves the sandbox ONCE and passes it in, exactly
//      like PANCHITO_ROOT/GITHUB_TOKEN are injected into tier-4a's adapters. See sandbox.ts's own
//      header for the full rationale.
//
// Runtime note: the orchestrator image ships Node plus Python, Go, Rust, Maven and Gradle (see the
// root Dockerfile). A missing runtime (e.g. image built without a language) fails with ENOENT and is
// reported as infra-error, never a pass. The runtimes live in the ORCHESTRATOR image, not the agents
// container — the orchestrator spawns the test commands directly.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { QaCase } from "@kernel/qa-case.ts";
import type { RunVerdict } from "@kernel/run-verdict.ts";
import { sanitizeText, type SecretDetection } from "@contexts/generation/infrastructure/sanitize-text.ts";
import { ProcessKillAdapter } from "../../../shared-infrastructure/process-sandbox/process-kill.adapter.ts";
import type { ProcessKillPort } from "@kernel/process-sandbox/process-kill.port.ts";
import { scrubEnv } from "../../../shared-infrastructure/process-sandbox/scrub-env.ts";
import { sandboxSpawnOptions, type Sandbox } from "../../../shared-infrastructure/process-sandbox/sandbox.ts";

// The structural shape runCodeTests returns. Declared locally (not imported from src/types.ts) so
// this file stays src/-free — CodeExecutionStrategy's own RunCodeFn seam (a narrower, LOCAL
// structural type) already establishes this pattern; QaCase/RunVerdict are the qa-engine kernel's
// own canonical copies of the same fields src/types.ts's QaRunResult declares.
export interface CodeRunResult {
  sha: string;
  verdict: RunVerdict;
  passed: boolean;
  cases: QaCase[];
  logs: string;
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

// Ecosystems whose TEST RUN command scopeTestCommand can actually narrow to a module. node resolves a
// package.json dir but workspace layouts vary too much to scope its run generically (deferred), so it
// is NOT here — listing it would mislabel a whole-repo node run as "scoped".
const RUN_SCOPE_SUPPORTED = new Set<Ecosystem>(["maven", "gradle", "go", "node"]);

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
// non-empty (it came from resolveChangedModules). Returns null when THIS command cannot be safely
// narrowed (e.g. an opaque package-manager `test` script) → the caller falls back to the whole repo.
export function scopeTestCommand(project: CodeProject, modules: string[]): Command | null {
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
    case "node": {
      // Only the DIRECT runners accept a path filter; an opaque `npm/pnpm/yarn test` SCRIPT is a black
      // box we must not rewrite. A mis-scoped direct run that matches no tests is caught as
      // `infra-error` (ranZeroTests), never a false pass — so path-scoping fails safe.
      const t = project.test;
      const direct = t.args.includes("jest") || t.args.includes("vitest") || (t.cmd === "node" && t.args.includes("--test"));
      return direct ? { cmd: t.cmd, args: [...t.args, ...modules] } : null;
    }
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
  if (!RUN_SCOPE_SUPPORTED.has(project.ecosystem)) {
    return { test: project.test, scoped: false, note: `per-module run scoping is not yet supported for ${project.ecosystem} — running the whole repo` };
  }
  const modules = resolveChangedModules(project.ecosystem, repoDir, changedFiles, deps);
  if (!modules || modules.length === 0) {
    return {
      test: project.test,
      scoped: false,
      note: `changed files did not all resolve to a ${project.ecosystem} submodule — running the whole repo`,
    };
  }
  const scopedTest = scopeTestCommand(project, modules);
  if (!scopedTest) {
    return { test: project.test, scoped: false, note: `could not scope the ${project.ecosystem} run command — running the whole repo` };
  }
  return { test: scopedTest, scoped: true, note: `scoped to module(s): ${modules.join(", ")}` };
}

// Parse `git status --porcelain` into the changed/added/untracked file paths (repo-relative). For a
// rename ("R  old -> new") take the NEW path. Pure. (The agent's generated tests show up as untracked
// "?? path" entries, which is exactly what we want to scope by.)
export function parsePorcelain(output: string): string[] {
  const files: string[] = [];
  for (const line of output.split("\n")) {
    if (line.length < 4) continue; // "XY path" — need at least a 2-char status + space + 1 char
    const path = line.slice(3);
    const arrow = path.indexOf(" -> ");
    files.push(arrow >= 0 ? path.slice(arrow + 4) : path);
  }
  return files;
}

// The scope basis for a run: the input diff when present (diff mode), else the files the agent just
// WROTE (manual/complete/exhaustive have no input diff, so scope by the agent's working-tree changes
// — this is what lets manual/complete runs scope to a module instead of always running the whole repo).
// Pure: the writes probe is injected.
export function effectiveChangedFiles(
  inputChangedFiles: string[],
  repoDir: string,
  listWrites?: (repoDir: string) => string[],
): string[] {
  if (inputChangedFiles.length > 0) return inputChangedFiles;
  return listWrites ? listWrites(repoDir) : [];
}

// Default writes probe: the working-tree changes in the mirror (the agent's generated tests are
// uncommitted there). Best-effort — any git failure yields [] (→ whole-repo fallback), never throws.
export function gitWorkingChanges(repoDir: string): string[] {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf8" });
    return parsePorcelain(out);
  } catch {
    return [];
  }
}

// ── Execute (run tests, classify by exit code) ────────────────────────────────

export interface CodeRunOutput {
  exitCode: number | null; // null when the process was killed by a signal
  logs: string;
  spawnError?: string; // set when the runtime/binary is missing (ENOENT) → infra
}

export interface CodeExecuteDeps {
  detect(repoDir: string): CodeProject;
  runTests(project: CodeProject, repoDir: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<CodeRunOutput>;
  // The scope basis when there is no input diff (manual/complete): the files the agent wrote.
  // Optional — absent ⇒ no derivation ⇒ whole-repo (the prior behavior). Default: git working changes.
  listWrites?(repoDir: string): string[];
  // OPTIONAL diagnostic sink for a secret-redaction audit trail (src/orchestrator/sanitizer.ts's
  // recordAudit/SECRET_AUDIT — a security-boundary concern this module does not import directly, to
  // stay src/-free). Absent ⇒ no audit recorded (safe for every unit test that doesn't care about
  // it). The composition-root shell (rewritten-engine-factory.ts) binds the REAL recordAudit into
  // createDefaultCodeExecuteDeps's returned object, so production behavior is unchanged.
  recordAudit?(runId: string, detection: SecretDetection): void;
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
): Promise<CodeRunResult> {
  const detected = deps.detect(repoDir);
  // Module scoping: narrow the command to the changed module(s) on a monorepo, else fall back to the
  // whole repo. Scope basis = the input diff (diff mode) OR the agent's writes (manual/complete, which
  // have no input diff). Surfaced so a scoped run is never confused with a whole-repo fallback.
  const changed = effectiveChangedFiles(opts.changedFiles ?? [], repoDir, deps.listWrites);
  const scope = scopeForChangedFiles(detected, repoDir, changed);
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
  // level (defense in depth: the spawn in createDefaultCodeExecuteDeps also SIGKILLs the
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

  // Single sanitizeText pass: `containsSecrets(out.logs)` (legacy's separate scan) is derivable from
  // this SAME detection result (sanitizeText's default "issue" mode is byte-identical to
  // containsSecrets's default "issue" mode — see src/orchestrator/sanitizer.ts's own AMENDMENT-1
  // comment) — so this is a behavior-preserving refactor that drops a redundant second regex pass,
  // not a semantic change: the warn fires under the EXACT same condition as before.
  const sanitized = sanitizeText(out.logs);
  if (sanitized.detection.redacted) {
    console.warn("[sanitizer] Secrets detected in code-test logs — redacting before publish");
  }
  deps.recordAudit?.(opts.namespace, sanitized.detection);

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
  const detail = ok ? undefined : failureDetail(sanitized.text, 1500);
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

// Build the failed-case detail from raw runner output. A single TAIL drops the real error on a large
// monorepo build (the failing module's section scrolls off the end), so capture HEAD + TAIL, and for
// surefire/JUnit output surface the failing test identifiers explicitly — otherwise the Issue carries
// an uninformative "BUILD FAILURE" tail. Generic across ecosystems: the failing-test lines only appear
// for JVM output; others fall back to head+tail of their (already concise) output.
export function failureDetail(logs: string, maxChars = 1500): string {
  const failing = [...new Set(logs.split("\n").filter((l) => /<<< (?:FAILURE|ERROR)!/.test(l)).map((l) => l.trim()))].slice(0, 20);
  const body = headTail(logs, maxChars);
  return failing.length > 0 ? `Failing tests:\n${failing.join("\n")}\n\n${body}` : body;
}

function headTail(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const half = Math.floor(maxChars / 2);
  return `${s.slice(0, half)}\n…[${s.length - maxChars} chars omitted]…\n${s.slice(-half)}`;
}

// The REAL, spawning CodeExecuteDeps — a FACTORY (not a plain constant) because the privilege-drop
// sandbox is now injected rather than resolved internally (see this file's header, difference #2).
// `processKill` defaults to a fresh ProcessKillAdapter — mirrors CodebaseMemoryClient's own
// constructor-default convention for the same shared-infrastructure primitive.
export function createDefaultCodeExecuteDeps(
  sandbox: Sandbox | null,
  processKill: ProcessKillPort = new ProcessKillAdapter(),
): CodeExecuteDeps {
  return {
    detect: (repoDir) => detectCodeProject(repoDir),
    listWrites: (repoDir) => gitWorkingChanges(repoDir),
    runTests: (project, repoDir, opts) =>
      new Promise((resolve) => {
        const { cmd, args } = project.test;
        const child = spawn(cmd, args, { cwd: repoDir, detached: true, ...sandboxSpawnOptions(scrubEnv(), sandbox) });
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
          processKill.killTree(child);
          finish({ exitCode: null, logs: `${stdout}\n${stderr}`, spawnError: `code-mode timeout after ${timeoutMs}ms` });
        }, timeoutMs);

        // Operator cancel: the pipeline's AbortSignal fires → kill the suite immediately.
        if (opts?.signal) {
          opts.signal.addEventListener("abort", () => {
            processKill.killTree(child);
            finish({ exitCode: null, logs: `${stdout}\n${stderr}`, spawnError: "aborted by operator cancel" });
          }, { once: true });
        }

        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", (err) => finish({ exitCode: null, logs: `${stderr}${stdout}`, spawnError: String(err) }));
        child.on("close", (code) => finish({ exitCode: code, logs: `${stdout}\n${stderr}`.trim() }));
      }),
  };
}

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
// `sandbox` is INJECTED (see this file's header, difference #2) — the composition-root shell
// resolves it once and passes it to every code-mode entry point (setup/execute/coverage) alike.
export async function runCodeCoverage(
  repoDir: string,
  sandbox: Sandbox | null,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
  processKill: ProcessKillPort = new ProcessKillAdapter(),
): Promise<void> {
  if (opts?.signal?.aborted) return;
  const c8Bin = resolveC8Bin();
  if (!c8Bin) return;
  const command = coverageCommand(detectCodeProject(repoDir), repoDir, c8Bin);
  if (!command) return;
  await new Promise<void>((resolve) => {
    const child = spawn(command.cmd, command.args, { cwd: repoDir, detached: true, ...sandboxSpawnOptions(scrubEnv(), sandbox) });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      processKill.killTree(child);
      finish();
    }, opts?.timeoutMs ?? DEFAULT_CODE_MODE_TIMEOUT_MS);
    opts?.signal?.addEventListener("abort", () => {
      processKill.killTree(child);
      finish();
    }, { once: true });
    child.on("error", finish); // c8 missing or spawn failure → no report, no harm
    child.on("close", finish); // success OR test failure — we only want the report
  });
}
