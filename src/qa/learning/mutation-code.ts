import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { OracleInput, ValueOracleResult } from "./oracle-types";
import { detectCodeProject } from "../code-runner";
import { scrubEnv } from "../code-runner";

const DEFAULT_MUTATION_TIMEOUT_MS = 600_000;

function killTree(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

function ecosystemForRepo(repoDir: string): string | null {
  try {
    return detectCodeProject(repoDir).ecosystem;
  } catch {
    return null;
  }
}

// Resolve the Stryker binary. We ship @stryker-mutator/core in the ORCHESTRATOR image, so the
// oracle works for ANY watched JS/TS repo even when the repo doesn't depend on Stryker — and we
// invoke that binary directly (cwd = repoDir) instead of `npx stryker`, which would resolve from
// the repo and, finding nothing, download the DEPRECATED unscoped `stryker` package at runtime
// (the bug that made this oracle a silent no-op for most repos). The command runner is built into
// core, so no per-framework runner plugin is needed. Falls back to `npx` only if the bundled
// binary is somehow absent (a degraded image) — logged by the caller via the null result.
export function resolveStrykerCommand(): { cmd: string; args: string[] } {
  const root = process.env.PANCHITO_ROOT ?? process.cwd();
  const bin = join(root, "node_modules", ".bin", "stryker");
  if (existsSync(bin)) return { cmd: bin, args: ["run"] };
  return { cmd: "npx", args: ["stryker", "run"] };
}

function sourceGlobs(repoDir: string): string[] {
  const candidates = [
    "src/**/*.ts",
    "src/**/*.tsx",
    "src/**/*.js",
    "src/**/*.jsx",
    "lib/**/*.ts",
    "lib/**/*.js",
    "app/**/*.ts",
    "app/**/*.tsx",
  ];
  return candidates.filter((g) => {
    const base = g.split("/")[0];
    return base && existsSync(join(repoDir, base));
  });
}

const SOURCE_EXT = /\.(ts|tsx|js|jsx)$/;
const TEST_FILE = /\.(test|spec)\.[tj]sx?$/;

// Prefer the diff: mutate ONLY the changed source files (change-scoped — fast, and it measures
// whether THIS commit's tests catch THIS commit's faults, not the whole suite). Falls back to
// repo-wide globs when there is no usable diff (e.g. complete/exhaustive runs).
export function selectMutateTargets(repoDir: string, changedFiles?: string[]): string[] {
  if (changedFiles && changedFiles.length > 0) {
    const scoped = changedFiles.filter(
      (f) => SOURCE_EXT.test(f) && !TEST_FILE.test(f) && existsSync(join(repoDir, f)),
    );
    if (scoped.length > 0) return scoped;
  }
  const globs = sourceGlobs(repoDir);
  return globs.length > 0 ? globs : ["src/**/*.ts", "src/**/*.js"];
}

function writeStrykerConfig(repoDir: string, testCommand: string, testArgs: string[], mutate: string[]): string {
  const configPath = join(repoDir, "stryker.conf.json");
  const config = {
    $schema: "https://raw.githubusercontent.com/stryker-mutator/stryker-js/master/packages/core/schema/stryker-schema.json",
    mutate,
    testRunner: "command",
    commandRunner: {
      command: [testCommand, ...testArgs].join(" "),
    },
    reporters: ["json", "clear-text"],
    jsonReportFile: "reports/mutation/mutation.json",
    thresholds: { high: 100, low: 0, break: null },
    timeoutMS: 30000,
    disableTypeChecks: `${testCommand} ${testArgs.join(" ")}`.includes("tsc") ? false : true,
    cleanTempDir: true,
    tempDirName: ".stryker-tmp",
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

function parseStrykerReport(repoDir: string): { mutationScore: number; mutantCount: number; killedCount: number } | null {
  const reportPath = join(repoDir, "reports", "mutation", "mutation.json");
  if (!existsSync(reportPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(reportPath, "utf8"));
    const score = raw.metrics?.mutationScore;
    const killed = raw.metrics?.killed;
    const total = raw.metrics?.totalMutants;
    if (typeof score !== "number" || typeof killed !== "number" || typeof total !== "number") return null;
    return { mutationScore: score, mutantCount: total, killedCount: killed };
  } catch {
    return null;
  }
}

function cleanupStryker(repoDir: string): void {
  try {
    rmSync(join(repoDir, "stryker.conf.json"), { force: true });
    rmSync(join(repoDir, "reports"), { recursive: true, force: true });
    rmSync(join(repoDir, ".stryker-tmp"), { recursive: true, force: true });
  } catch { /* best-effort cleanup */ }
}

export interface MutationDeps {
  spawn(
    cmd: string,
    args: string[],
    opts: { cwd: string; env: Record<string, string>; detached: boolean },
  ): ChildProcess;
}

export const realMutationDeps: MutationDeps = { spawn };

export async function runMutationOracle(
  input: OracleInput,
  deps: MutationDeps = realMutationDeps,
): Promise<ValueOracleResult> {
  const eco = input.ecosystem ?? ecosystemForRepo(input.repoDir);

  if (eco !== "node") {
    return {
      valueScore: null,
      mutantCount: 0,
      killedCount: 0,
      details: `mutation testing not available for ecosystem "${eco ?? "unknown"}" (only JS/TS via Stryker is supported)`,
    };
  }

  const project = detectCodeProject(input.repoDir);
  const testCmd = project.test.cmd;
  const testArgs = project.test.args;

  let configPath: string;
  try {
    configPath = writeStrykerConfig(input.repoDir, testCmd, testArgs, selectMutateTargets(input.repoDir, input.changedFiles));
  } catch (err) {
    return {
      valueScore: null,
      mutantCount: 0,
      killedCount: 0,
      details: `failed to write Stryker config: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS;

  return new Promise((resolve) => {
    const { cmd, args } = resolveStrykerCommand();
    const child = deps.spawn(cmd, args, {
      cwd: input.repoDir,
      env: scrubEnv(),
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    // Emit progress lines from Stryker's stdout so the TUI has live feedback
    // during long mutation runs (can take 10+ minutes for large diffs).
    if (input.onProgress && child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          const trimmed = line.trim();
          if (trimmed) input.onProgress!(trimmed);
        }
      });
    }

    const finish = (result: ValueOracleResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupStryker(input.repoDir);
      resolve(result);
    };

    const timer = setTimeout(() => {
      killTree(child);
      finish({
        valueScore: null,
        mutantCount: 0,
        killedCount: 0,
        details: `mutation testing timeout after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    if (input.signal) {
      input.signal.addEventListener("abort", () => {
        killTree(child);
        finish({
          valueScore: null,
          mutantCount: 0,
          killedCount: 0,
          details: "mutation testing aborted by operator cancel",
        });
      }, { once: true });
    }

    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));

    child.on("error", (err) => {
      finish({
        valueScore: null,
        mutantCount: 0,
        killedCount: 0,
        details: `mutation testing spawn failed: ${err.message}`,
      });
    });

    child.on("close", () => {
      const report = parseStrykerReport(input.repoDir);
      if (report) {
        const score = report.mutationScore / 100;
        finish({
          valueScore: Math.round(score * 1000) / 1000,
          mutantCount: report.mutantCount,
          killedCount: report.killedCount,
          details: `${report.killedCount}/${report.mutantCount} mutants killed (${report.mutationScore.toFixed(1)}%)`,
        });
      } else {
        finish({
          valueScore: null,
          mutantCount: 0,
          killedCount: 0,
          details: `Stryker ran but produced no parseable report. Last output: ${(stderr || stdout).slice(0, 300)}`,
        });
      }
    });
  });
}
