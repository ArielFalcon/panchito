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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateManifest } from "./metadata";

export interface CheckResult {
  ok: boolean;
  output: string;
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
  for (const [name, run] of checks) {
    const res = await run(specDir);
    if (!res.ok) errors.push(`[${name}] ${res.output.trim()}`);
  }
  return { ok: errors.length === 0, errors };
}

// Default runners: run the tools INSIDE the repo's `e2e/` project (its own
// config/tooling). They require tsc/eslint/playwright to be available (the e2e
// project's own deps, installed by the orchestrator before this gate).
function sh(cmd: string, args: string[], e2eDir: string): Promise<CheckResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: e2eDir, env: { ...process.env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => resolve({ ok: false, output: String(e) }));
    child.on("close", (code) => resolve({ ok: code === 0, output: out }));
  });
}

export const defaultValidateDeps: ValidateDeps = {
  typecheck: (e2eDir) => sh("npx", ["tsc", "--noEmit"], e2eDir),
  lint: (e2eDir) => sh("npx", ["eslint", "."], e2eDir),
  listTests: (e2eDir) => sh("npx", ["playwright", "test", "--list"], e2eDir),
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
