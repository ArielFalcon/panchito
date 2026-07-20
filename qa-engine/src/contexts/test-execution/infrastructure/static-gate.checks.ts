// qa-engine/src/contexts/test-execution/infrastructure/static-gate.checks.ts
// Harness Filter B: static gate over the generated specs, BEFORE spending a browser (e2e target),
// PLUS the CODE target's compile-feedback gate and the manifest-entry validator both gates share.
// Body-moved from src/qa/validate.ts + src/qa/code-validate.ts + src/qa/metadata.ts (migration-
// tier-4b Slice 3) — qa-engine now OWNS the static gate's real body directly; StaticGateAdapter/
// CodeValidationStrategy stop wrapping a closure that calls back into src/. Behavior-preserving: the
// verdict matrix (typecheck/lint/listTests/checkManifest run CONCURRENTLY, never short-circuiting;
// the B2 zero-assertion scan; the per-ecosystem compile-only matrix; the manifest validators) is
// byte-identical to the legacy implementation.
//
// Two deliberate differences from the legacy body (mirroring code-execution.runner.ts's own two,
// Slice 1):
//   1. `killTree` (imported at HEAD from src/qa/execute.ts — a seam-pinned file that migrates LAST,
//      4d) is replaced by the canonical `ProcessKillAdapter` (shared-infrastructure) — this is what
//      lets this cluster relocate WITHOUT waiting for execute.ts's own migration. Never a fifth
//      duplicate copy (process-kill.adapter.ts's own header: "the ONE killTree").
//   2. `checkManifest`'s manifest-shape validation (metadata.ts's `validateManifest`) now delegates
//      to the canonical `@kernel/manifest/manifest-entry.ts` schema (migration-tier-4b Slice 2's THE
//      MANIFEST RECONCILIATION) instead of `src/orchestrator/schemas.ts` — qa-engine/src stays
//      src/-free. `checkManifest`'s OWN strict file read (readFileSync + JSON.parse, missing/
//      unreadable/corrupt -> ok:false) is preserved UNCHANGED and stays DISTINCT from generation's
//      fail-open `readManifest` (gate DEFECT-1 fix, confirmed in Slice 2) — never re-plumbed through
//      the fail-open reader.
//
// code-validate.ts's hard coupling to code-runner.ts dissolves here: both relocated to qa-engine in
// the SAME sub-change (Slice 1 code-execution, this Slice 3 validate cluster) — see
// migration-tier-3-decisions.md §2 (Option A, a partial move, was REJECTED for exactly this reason).

import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sanitizeText } from "@contexts/generation/infrastructure/sanitize-text.ts";
import { validateManifest as validateManifestShape, type ManifestValidation } from "@kernel/manifest/manifest-entry.ts";
import { ProcessKillAdapter } from "../../../shared-infrastructure/process-sandbox/process-kill.adapter.ts";
import { scrubEnv } from "../../../shared-infrastructure/process-sandbox/scrub-env.ts";
import type { CheckResult, ValidationResult } from "../application/ports/index.ts";
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
} from "./code-execution.runner.ts";

const processKill = new ProcessKillAdapter();

// ── e2e static gate (validateSpecs / runCheck / checkManifest) ───────────────────────────────────

// Per-check wall-clock budget for the static gate's spawned tools (tsc, eslint,
// playwright --list). A wedged child must never freeze the sequential queue; on
// expiry the process TREE is SIGKILLed and the check resolves as INFRA (the gate
// itself couldn't run — not a code-quality verdict).
export const DEFAULT_VALIDATE_CHECK_TIMEOUT_MS = 300_000; // 5 min

export interface ValidateDeps {
  typecheck(specDir: string): Promise<CheckResult>;
  lint(specDir: string): Promise<CheckResult>;
  listTests(specDir: string): Promise<CheckResult>;
  checkManifest(specDir: string): Promise<CheckResult>; // standard metadata is valid
}

export async function validateSpecs(
  specDir: string,
  deps: ValidateDeps,
): Promise<ValidationResult> {
  // Run ALL of them (do not stop at the first) to return complete feedback.
  const checks: Array<[string, (d: string) => Promise<CheckResult>]> = [
    ["typecheck", deps.typecheck],
    ["lint", deps.lint],
    ["list", deps.listTests],
    ["manifest", deps.checkManifest],
  ];
  const errors: string[] = [];
  let allFailuresAreInfra = true;
  const results = await Promise.all(
    checks.map(async ([name, run]) => ({ name, res: await run(specDir) })),
  );
  for (const { name, res } of results) {
    if (!res.ok) {
      errors.push(`[${name}] ${res.output.trim()}`);
      if (!res.infra) allFailuresAreInfra = false;
    }
  }

  // B2: detect GENERATED spec files with zero assertions. A generated Playwright spec that never
  // calls expect() is almost always a trivially-passing false-positive. Flag it as a code quality
  // failure (not infra) so the run becomes `invalid` and feeds a corrective regeneration. Scoped to
  // the `flows/` subdir (where the agent writes generated specs) so the assertion-free `cleanup.spec.ts`
  // SEED at the e2e root — and any pre-existing non-generated spec — is never falsely flagged.
  const zeroAssertionErrors = checkZeroAssertionSpecs(specDir);
  for (const e of zeroAssertionErrors) {
    errors.push(e);
    allFailuresAreInfra = false; // these are code quality failures, not tool/infra failures
  }

  return { ok: errors.length === 0, errors, infra: errors.length > 0 && allFailuresAreInfra };
}

// B2: deterministic check — scan *.spec.ts files under specDir/flows (the GENERATED-spec dir;
// panchito writes generated specs there) and return one error per file with NO assertion. Detects
// `expect(`, `await expect(`, `expect.soft(`, `expect.poll(`. Scoping to flows/ keeps the
// assertion-free seed `cleanup.spec.ts` (at the e2e root) and any pre-existing non-generated spec
// out of scope. A missing flows/ dir yields no errors (fail-safe — readdirSync throws → skip).
function checkZeroAssertionSpecs(specDir: string): string[] {
  const errors: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return; // unreadable directory: skip silently — the other checks will catch infra issues
    }
    for (const name of names) {
      const full = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue; // unreadable stat: skip
      }
      if (isDir) {
        walk(full);
      } else if (name.endsWith(".spec.ts")) {
        let content: string;
        try {
          content = readFileSync(full, "utf8");
        } catch {
          continue; // unreadable file: skip (infra, not a code quality issue)
        }
        // Detect any assertion form: `expect(`, `await expect(`, `expect.soft(`, `expect.poll(`.
        // A single regex (`expect` followed by `.` or `(`) covers every Playwright assertion entry
        // point without enumerating them — the safe direction (never false-flag a real assertion).
        const hasAssertion = /\bexpect\s*[.(]/.test(content);
        if (!hasAssertion) {
          errors.push(`[zero-assertions] ${name}: spec has no expect() calls — remove it or add assertions`);
        }
      }
    }
  };
  walk(join(specDir, "flows"));
  return errors;
}

// Default runners: run the tools INSIDE the repo's `e2e/` project (its own
// config/tooling). They require tsc/eslint/playwright to be available (the e2e
// project's own deps, installed by the orchestrator before this gate).
// Exported so the timeout/kill-tree behavior is testable with a real (cheap) child.
export function runCheck(
  cmd: string,
  args: string[],
  e2eDir: string,
  timeoutMs: number = DEFAULT_VALIDATE_CHECK_TIMEOUT_MS,
): Promise<CheckResult> {
  return new Promise((resolve) => {
    // `detached: true` makes the child its own process-group leader so killTree can
    // reap grandchildren (npx forks the real tool as a child of the child).
    const child = spawn(cmd, args, { cwd: e2eDir, env: scrubEnv(), detached: true });
    let out = "";
    let settled = false;
    const settle = (res: CheckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };
    // A wedged check (hung tsc/eslint/playwright) is infrastructure, same as
    // ENOENT/signal-kill below: kill the tree and route through the infra path.
    const timer = setTimeout(() => {
      processKill.killTree(child);
      settle({ ok: false, output: `${cmd} ${args.join(" ")} timed out after ${timeoutMs}ms — killed`, infra: true });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    // ENOENT (missing binary) or any spawn-level failure is infrastructure, not a
    // code-quality verdict — it means the static gate itself couldn't run.
    child.on("error", (e) => settle({ ok: false, output: String(e), infra: true }));
    // Signal-kill (code === null) is also infrastructure (OOM, host pressure).
    child.on("close", (code) => settle({ ok: code === 0, output: out, infra: code === null ? true : undefined }));
  });
}

export const defaultValidateDeps: ValidateDeps = {
  typecheck: (e2eDir) => runCheck("npx", ["tsc", "--noEmit"], e2eDir),
  lint: (e2eDir) => runCheck("npx", ["eslint", "."], e2eDir),
  listTests: (e2eDir) => runCheck("npx", ["playwright", "test", "--list"], e2eDir),
  checkManifest: async (e2eDir) => {
    try {
      const raw = JSON.parse(readFileSync(join(e2eDir, ".qa", "manifest.json"), "utf8"));
      const v = validateManifest(raw);
      return { ok: v.ok, output: v.errors.join("\n") };
    } catch (e) {
      return { ok: false, output: `e2e/.qa/manifest.json unreadable or missing: ${String(e)}` };
    }
  },
};

// ── manifest-entry validation (src/qa/metadata.ts body-move) ─────────────────────────────────────
// Array-level validator: delegates FIELD/SHAPE validation to the canonical @kernel/manifest
// validateManifest (Slice 2's THE MANIFEST RECONCILIATION — imported above as `validateManifestShape`,
// the ONE structural check, no reimplemented zod-parse here) and layers the READ-GATE-specific
// duplicate-id check on top (zod cannot check cross-entry uniqueness — the write path structurally
// cannot produce duplicates via its upsert-by-id merge, so this check is read-gate-only, exactly as
// the kernel schema's own header documents). `checkManifest` above is the only caller.
export function validateManifest(raw: unknown): ManifestValidation {
  const shape = validateManifestShape(raw);
  const errors = [...shape.errors];

  // Zod cannot check for duplicate IDs across array entries — do it manually. Guarded by
  // Array.isArray so a non-array `raw` (already reported by validateManifestShape above) is never
  // iterated.
  if (Array.isArray(raw)) {
    const ids = new Set<string>();
    raw.forEach((entry) => {
      const m = (entry ?? {}) as Record<string, unknown>;
      const id = typeof m.id === "string" ? m.id.trim() : "";
      if (id.length > 0) {
        if (ids.has(id)) {
          errors.push(`'${id}': duplicate id`);
        } else {
          ids.add(id);
        }
      }
    });
  }

  return { ok: errors.length === 0, errors };
}

// ── code target static gate (src/qa/code-validate.ts body-move) ─────────────────────────────────
// A compile-feedback gate, BEFORE running the repo's own suite. e2e has the checks above
// (tsc/eslint/playwright --list); code mode previously had NOTHING — the agent's compile errors
// only surfaced as an opaque whole-build failure with no structured feedback. This compiles the
// generated TEST sources (without running them), per ecosystem, and returns the SAME
// ValidationResult shape the e2e checks do, so the pipeline can feed the errors back through the
// same static-fix loop.
//
// It NEVER routes through runCodeTests/ranZeroTests — a clean `test-compile` (which runs no tests)
// must never be misread as "zero tests collected". Compiled ecosystems only; interpreted ones
// (python, plain JS, unknown) are an honest no-op (the suite itself is the gate, exactly as before).

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
  // Spawn-and-classify, REUSING the e2e checks' runCheck contract: ENOENT/signal-kill/timeout →
  // infra, non-zero exit → a real failure. Decoupled from runCodeTests/ranZeroTests on purpose.
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
  // properties, local-repo paths, profile secrets (the e2e checks above are exempt: tsc/eslint output is
  // clean).
  const infra = res.infra === true || isToolchainFailure(res.output);
  const clean = sanitizeText(res.output).text.trim();
  return { ok: false, errors: [`[compile] ${clean}`], infra };
}
