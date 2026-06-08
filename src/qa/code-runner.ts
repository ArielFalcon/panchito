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
// Runtime note: the orchestrator image ships Node. A non-Node ecosystem only runs
// if its runtime is present in the image (see Dockerfile) — otherwise the spawn
// fails with ENOENT and is reported as infra-error (NOT a code bug), never a pass.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { QaCase, QaRunResult } from "../types";
import { sanitizeText, containsSecrets, recordAudit } from "../orchestrator/sanitizer";

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
    const install: Command | null = deps.exists(at("requirements.txt"))
      ? { cmd: "pip", args: ["install", "-r", "requirements.txt"] }
      : deps.exists(at("pyproject.toml")) || deps.exists(at("setup.py"))
        ? { cmd: "pip", args: ["install", "-e", "."] }
        : null;
    return { ecosystem: "python", install, test: { cmd: "python", args: ["-m", "pytest", "-q"] } };
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
  install(project: CodeProject, repoDir: string): Promise<void>;
}

export async function setupCodeProject(repoDir: string, deps: CodeSetupDeps): Promise<void> {
  const project = deps.detect(repoDir);
  if (project.install) await deps.install(project, repoDir);
}

export const defaultCodeSetupDeps: CodeSetupDeps = {
  detect: (repoDir) => detectCodeProject(repoDir),
  install: (project, repoDir) =>
    new Promise((resolve, reject) => {
      const { cmd, args } = project.install!;
      const child = spawn(cmd, args, { cwd: repoDir, env: { ...process.env } });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`code-mode install failed (${cmd} ${args.join(" ")}, exit ${code})`)),
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
  runTests(project: CodeProject, repoDir: string): Promise<CodeRunOutput>;
}

export interface CodeExecuteOptions {
  namespace: string;
  onCase?: (c: QaCase) => void;
}

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

  // node --test: the TAP/summary line reports the executed count.
  if (cmd.includes("node --test") && /(?:#|ℹ)\s*tests\s+0\b/.test(log)) return true;

  // jest / vitest: explicit "no tests" message (robust to --passWithNoTests configured).
  if (/\bnpx (?:jest|vitest)\b/.test(cmd) && /No tests? (?:found|files? found)/i.test(log)) return true;

  // mocha: prints "0 passing" and exits 0 when it ran nothing.
  if (cmd.includes("npx mocha") && out.exitCode === 0 && /\b0 passing\b/.test(log)) return true;

  return false;
}

export async function runCodeTests(
  repoDir: string,
  opts: CodeExecuteOptions,
  deps: CodeExecuteDeps,
): Promise<QaRunResult> {
  const project = deps.detect(repoDir);
  const out = await deps.runTests(project, repoDir);

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
  const kase: QaCase = { name: label, status, detail, objective: "code test suite" };
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
  runTests: (project, repoDir) =>
    new Promise((resolve) => {
      const { cmd, args } = project.test;
      const child = spawn(cmd, args, { cwd: repoDir, env: { ...process.env } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      // A missing runtime (ENOENT) is infra, not a test failure — surface it distinctly.
      child.on("error", (err) => resolve({ exitCode: null, logs: `${stderr}${stdout}`, spawnError: String(err) }));
      child.on("close", (code) => resolve({ exitCode: code, logs: `${stdout}\n${stderr}`.trim() }));
    }),
};
