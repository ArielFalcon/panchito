// Harness Filter B: static gate over the generated specs, BEFORE spending a
// browser. Checks "dry" that the tests:
//   1. compile (typecheck),
//   2. pass the Playwright linter (catches hard waits, trivial asserts, element
//      handles, missing awaits...),
//   3. load in Playwright (`test --list`),
//   4. carry valid metadata (manifest).
// If anything fails the specs are invalid: generation was bad and running them
// makes no sense. Each check is injected, so the orchestration is verifiable with
// stubs; the real runners (which spawn) are the uncovered boundary.

import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { scrubEnv } from "./code-runner";
import { killTree } from "./execute";
import { validateManifest } from "./metadata";

// Per-check wall-clock budget for the static gate's spawned tools (tsc, eslint,
// playwright --list). A wedged child must never freeze the sequential queue; on
// expiry the process TREE is SIGKILLed and the check resolves as INFRA (the gate
// itself couldn't run — not a code-quality verdict).
export const DEFAULT_VALIDATE_CHECK_TIMEOUT_MS = 300_000; // 5 min

export interface CheckResult {
  ok: boolean;
  output: string;
  infra?: boolean; // true when the check itself failed (ENOENT, signal-kill), not the code
}

export interface ValidateDeps {
  typecheck(specDir: string): Promise<CheckResult>;
  lint(specDir: string): Promise<CheckResult>;
  listTests(specDir: string): Promise<CheckResult>;
  checkManifest(specDir: string): Promise<CheckResult>; // standard metadata is valid
}

export interface ValidationResult {
  ok: boolean;
  errors: string[]; // one error per failed check, with its output (for the agent)
  infra: boolean; // ALL failures are infrastructure (missing tools, OOM) — not code quality
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
      killTree(child);
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
