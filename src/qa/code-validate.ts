// Harness Filter B for CODE mode: a compile-feedback gate, BEFORE running the repo's suite. e2e has
// validate.ts (tsc/eslint/playwright --list); code mode previously had NOTHING — the agent's compile
// errors only surfaced as an opaque whole-build failure with no structured feedback. This compiles the
// generated TEST sources (without running them), per ecosystem, and returns the SAME {ok, errors, infra}
// shape validate.ts does, so the pipeline can feed the errors back through the same static-fix loop.
//
// It NEVER routes through runCodeTests/ranZeroTests — a clean `test-compile` (which runs no tests) must
// never be misread as "zero tests collected". Compiled ecosystems only; interpreted ones (python, plain
// JS, unknown) are an honest no-op (the suite itself is the gate, exactly as before).

import { join } from "node:path";
import { runCheck, type CheckResult, type ValidationResult } from "./validate";
// migration-tier-4b Slice 1: src/qa/code-runner.ts (the prior home of these 9 symbols) is deleted
// this slice. code-validate.ts itself does not relocate until Slice 3 (it is HARD-blocked on THIS
// re-point landing first — see the design's own slice-ordering note), but this import must move now
// or the file fails to compile the moment code-runner.ts is gone. Not called out in the design's own
// Slice-1 consumer sweep (a real gap, caught here); see the apply-progress artifact's Deviations
// section.
import {
  detectCodeProject,
  realDetectDeps,
  resolveChangedModules,
  effectiveChangedFiles,
  gitWorkingChanges,
  DEFAULT_CODE_MODE_TIMEOUT_MS,
  type CodeProject,
  type Command,
  type DetectDeps,
} from "../../qa-engine/src/contexts/test-execution/infrastructure/code-execution.runner";
import { sanitizeText } from "../orchestrator/sanitizer";

// A present-but-broken JVM toolchain (missing/incorrect JAVA_HOME, a JRE instead of a JDK) makes the
// compiler exit non-zero WITHOUT compiling anything. That is INFRA (inconclusive), not a code defect —
// it must never file an `invalid` Issue blaming the agent. ENOENT (the binary itself missing) is already
// infra via runCheck; these patterns match the REAL launcher/compiler-plugin messages on a misconfig.
const TOOLCHAIN_FAILURE_PATTERNS: readonly RegExp[] = [
  /JAVA_HOME (?:environment variable )?is not (?:correctly set|set|defined)/i,
  /JAVA_HOME is not set and could not be found/i,
  /No compiler is provided in this environment/i,
  /Unable to locate the Javac Compiler/i,
  /Perhaps you are running on a JRE rather than a JDK/i,
];

export function isToolchainFailure(output: string): boolean {
  return TOOLCHAIN_FAILURE_PATTERNS.some((re) => re.test(output));
}

// The compile-only command per ecosystem — compiles main + TEST sources but runs no tests. Scoped to
// the changed module(s) when they resolve (the same resolution as the test run). null = this ecosystem
// has no pre-run compile step (interpreted / plain JS) → the gate is a no-op. Pure (fs probe injected).
export function compileCommand(
  project: CodeProject,
  repoDir: string,
  changedFiles: string[],
  deps: Pick<DetectDeps, "exists"> = realDetectDeps,
): Command | null {
  const resolved = resolveChangedModules(project.ecosystem, repoDir, changedFiles, deps);
  const mods = resolved && resolved.length > 0 ? resolved : null;
  switch (project.ecosystem) {
    case "maven":
      // test-compile builds main + test sources, runs no tests. -am also-makes upstream deps.
      return mods
        ? { cmd: "mvn", args: ["-B", "-pl", mods.join(","), "-am", "test-compile"] }
        : { cmd: "mvn", args: ["-B", "test-compile"] };
    case "gradle":
      // testClasses compiles all test sources (language-agnostic within Gradle), runs no tests.
      return mods
        ? { cmd: project.test.cmd, args: mods.map((m) => `:${m.replace(/\//g, ":")}:testClasses`) }
        : { cmd: project.test.cmd, args: ["testClasses"] };
    case "go":
      // `go vet` type-checks _test.go (which `go build` SKIPS), so it catches the agent's test errors.
      return mods ? { cmd: "go", args: ["vet", ...mods.map((m) => `./${m}/...`)] } : { cmd: "go", args: ["vet", "./..."] };
    case "rust":
      return { cmd: "cargo", args: ["check", "--tests"] };
    case "node":
      // Only a TS project has a pre-run compile step; plain JS has none (errors surface at run).
      return deps.exists(join(repoDir, "tsconfig.json")) ? { cmd: "npx", args: ["tsc", "--noEmit"] } : null;
    case "python": {
      // python is file-based (no module compile): byte-compile the changed .py files for a fast SYNTAX
      // gate. With G1 these are the agent's written tests on a manual run. Syntax-only — import/name
      // errors still surface at pytest collection (the run), which the fix-loop already feeds back.
      const py = changedFiles.filter((f) => f.endsWith(".py"));
      return py.length > 0 ? { cmd: "python3", args: ["-m", "compileall", "-q", ...py] } : null;
    }
    default:
      return null; // unknown → interpreted; the suite is the gate
  }
}

export interface CodeValidateDeps {
  detect(repoDir: string): CodeProject;
  // Spawn-and-classify, REUSING validate.ts's runCheck contract: ENOENT/signal-kill/timeout → infra,
  // non-zero exit → a real failure. Decoupled from runCodeTests/ranZeroTests on purpose.
  runCheck(cmd: string, args: string[], cwd: string, timeoutMs?: number): Promise<CheckResult>;
  // Scope basis when there is no input diff (manual/complete): the files the agent wrote. Default: git.
  listWrites?(repoDir: string): string[];
}

export const defaultCodeValidateDeps: CodeValidateDeps = {
  detect: (repoDir) => detectCodeProject(repoDir),
  runCheck: (cmd, args, cwd, timeoutMs) => runCheck(cmd, args, cwd, timeoutMs ?? DEFAULT_CODE_MODE_TIMEOUT_MS),
  listWrites: (repoDir) => gitWorkingChanges(repoDir),
};

export async function validateCodeProject(
  repoDir: string,
  deps: CodeValidateDeps = defaultCodeValidateDeps,
  opts: { changedFiles?: string[]; timeoutMs?: number } = {},
): Promise<ValidationResult> {
  const project = deps.detect(repoDir);
  // Scope the compile to the input diff (diff mode) or the agent's writes (manual/complete).
  const changed = effectiveChangedFiles(opts.changedFiles ?? [], repoDir, deps.listWrites);
  const cmd = compileCommand(project, repoDir, changed);
  if (!cmd) return { ok: true, errors: [], infra: false }; // no compile step for this ecosystem
  const res = await deps.runCheck(cmd.cmd, cmd.args, repoDir, opts.timeoutMs);
  if (res.ok) return { ok: true, errors: [], infra: false };
  // A broken toolchain (classified on the RAW output) is infra; otherwise a real compile error. Sanitize
  // BEFORE the text reaches the agent (reviewCorrections) or an Issue — Maven output can carry pom.xml
  // properties, local-repo paths, profile secrets (validate.ts is exempt: tsc/eslint output is clean).
  const infra = res.infra === true || isToolchainFailure(res.output);
  const clean = sanitizeText(res.output).text.trim();
  return { ok: false, errors: [`[compile] ${clean}`], infra };
}
