import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMutationOracle, selectMutateTargets, resolveStrykerCommand, type MutationDeps } from "./mutation-code";
import type { OracleInput } from "./oracle-types";
import type { ChildProcess } from "node:child_process";

function mockSpawn(result: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: Error;
  createReport?: boolean;
}): MutationDeps {
  return {
    spawn: (_cmd, _args, _opts) => {
      const listeners: Record<string, Array<(...args: unknown[]) => void>> = {
        error: [],
        close: [],
      };
      const stdoutListeners: Array<(d: Buffer) => void> = [];
      const stderrListeners: Array<(d: Buffer) => void> = [];

      const child = {
        stdout: { on: (_e: string, fn: (d: Buffer) => void) => stdoutListeners.push(fn) },
        stderr: { on: (_e: string, fn: (d: Buffer) => void) => stderrListeners.push(fn) },
        on: (event: string, fn: (...args: unknown[]) => void) => {
          listeners[event] = listeners[event] ?? [];
          listeners[event]!.push(fn);
        },
        pid: 12345,
      } as unknown as ChildProcess;

      // Schedule the result asynchronously (like a real spawn)
      setTimeout(() => {
        if (result.error) {
          listeners["error"]?.forEach((fn) => fn(result.error!));
          return;
        }
        if (result.createReport) {
          // Simulate Stryker creating the report before closing
          const reportDir = join(_opts.cwd as string, "reports", "mutation");
          mkdirSync(reportDir, { recursive: true });
          writeFileSync(join(reportDir, "mutation.json"), JSON.stringify({
            metrics: {
              mutationScore: 75.5,
              killed: 151,
              totalMutants: 200,
            },
          }));
        }
        if (result.stdout) {
          stdoutListeners.forEach((fn) => fn(Buffer.from(result.stdout!)));
        }
        if (result.stderr) {
          stderrListeners.forEach((fn) => fn(Buffer.from(result.stderr!)));
        }
        listeners["close"]?.forEach((fn) => fn(result.exitCode ?? 0));
      }, 1);

      return child;
    },
  };
}

const tmpDir = join(process.cwd(), "data", "mutation-test-tmp");

function setupNodeRepo(): string {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(join(tmpDir, "src"), { recursive: true });
  writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
    name: "test-project",
    scripts: { test: "node --test" },
    devDependencies: {},
  }));
  writeFileSync(join(tmpDir, "package-lock.json"), "{}");
  return tmpDir;
}

describe("runMutationOracle", () => {
  it("returns null valueScore for non-node ecosystem", async () => {
    const result = await runMutationOracle(
      { target: "code", repoDir: tmpDir, namespace: "test", ecosystem: "python" },
      mockSpawn({}),
    );
    assert.equal(result.valueScore, null);
    assert.match(result.details, /not available/i);
  });

  it("returns null valueScore when Stryker spawn fails", async () => {
    const repo = setupNodeRepo();
    try {
      const result = await runMutationOracle(
        { target: "code", repoDir: repo, namespace: "test" },
        mockSpawn({ error: new Error("ENOENT: stryker not found") }),
      );
      assert.equal(result.valueScore, null);
      assert.match(result.details, /spawn failed|ENOENT/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns valueScore from Stryker report", async () => {
    const repo = setupNodeRepo();
    // Stryker needs actual source files to mutate
    writeFileSync(join(repo, "src", "index.ts"), "export function add(a: number, b: number) { return a + b; }");
    try {
      const result = await runMutationOracle(
        { target: "code", repoDir: repo, namespace: "test" },
        mockSpawn({ exitCode: 0, createReport: true }),
      );
      assert.equal(result.valueScore, 0.755);
      assert.equal(result.mutantCount, 200);
      assert.equal(result.killedCount, 151);
      assert.match(result.details, /151\/200/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns null valueScore when Stryker produces no report", async () => {
    const repo = setupNodeRepo();
    writeFileSync(join(repo, "src", "index.ts"), "export const x = 1;");
    try {
      const result = await runMutationOracle(
        { target: "code", repoDir: repo, namespace: "test" },
        mockSpawn({ exitCode: 0, stderr: "No mutants generated" }),
      );
      assert.equal(result.valueScore, null);
      assert.match(result.details, /no parseable report|No mutants/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns null valueScore on timeout", async () => {
    const repo = setupNodeRepo();
    // A spawn that NEVER fires close → timeout will be the only resolution path.
    const neverResolve: MutationDeps = {
      spawn: () => {
        const child = {
          stdout: { on: () => {} },
          stderr: { on: () => {} },
          on: () => {},
          pid: 12345,
        } as unknown as ChildProcess;
        return child;
      },
    };
    try {
      const result = await runMutationOracle(
        { target: "code", repoDir: repo, namespace: "test", timeoutMs: 10 },
        neverResolve,
      );
      assert.equal(result.valueScore, null);
      assert.match(result.details, /timeout/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("aborts on signal", async () => {
    const repo = setupNodeRepo();
    const controller = new AbortController();
    const neverResolve: MutationDeps = {
      spawn: () => {
        const child = {
          stdout: { on: () => {} },
          stderr: { on: () => {} },
          on: () => {},
          pid: 12345,
        } as unknown as ChildProcess;
        return child;
      },
    };
    try {
      const promise = runMutationOracle(
        { target: "code", repoDir: repo, namespace: "test", signal: controller.signal },
        neverResolve,
      );
      controller.abort();
      const result = await promise;
      assert.equal(result.valueScore, null);
      assert.match(result.details, /aborted/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("cleans up Stryker config + reports after run", async () => {
    const repo = setupNodeRepo();
    writeFileSync(join(repo, "src", "index.ts"), "export const x = 1;");
    try {
      await runMutationOracle(
        { target: "code", repoDir: repo, namespace: "test" },
        mockSpawn({ exitCode: 0, createReport: true }),
      );
      assert.equal(existsSync(join(repo, "stryker.conf.json")), false);
      assert.equal(existsSync(join(repo, "reports")), false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("selectMutateTargets (change-scoped mutation)", () => {
  function tmpRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), "mut-scope-"));
    mkdirSync(join(repo, "src"), { recursive: true });
    return repo;
  }

  it("scopes mutation to the changed source files, not the whole repo", () => {
    const repo = tmpRepo();
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;");
    writeFileSync(join(repo, "src", "b.ts"), "export const b = 2;");
    try {
      assert.deepEqual(selectMutateTargets(repo, ["src/a.ts"]), ["src/a.ts"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("ignores test/spec files and non-source changed paths", () => {
    const repo = tmpRepo();
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;");
    writeFileSync(join(repo, "src", "a.test.ts"), "// test");
    try {
      assert.deepEqual(
        selectMutateTargets(repo, ["src/a.ts", "src/a.test.ts", "README.md"]),
        ["src/a.ts"],
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("falls back to repo-wide globs when no changed source file exists", () => {
    const repo = tmpRepo();
    writeFileSync(join(repo, "src", "x.ts"), "export const x = 1;");
    try {
      const targets = selectMutateTargets(repo, ["docs/readme.md"]);
      assert.ok(targets.includes("src/**/*.ts"), `expected fallback globs, got ${targets.join(",")}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("falls back to repo-wide globs when no diff is provided", () => {
    const repo = tmpRepo();
    writeFileSync(join(repo, "src", "x.ts"), "export const x = 1;");
    try {
      assert.ok(selectMutateTargets(repo, undefined).includes("src/**/*.ts"));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("resolveStrykerCommand", () => {
  it("prefers the orchestrator's bundled Stryker binary over npx (no runtime download)", () => {
    // We ship @stryker-mutator/core in the orchestrator, so the resolved command must be the
    // local bin — never `npx stryker`, which would resolve from the watched repo and download the
    // deprecated unscoped package at runtime (the bug that made the code oracle a silent no-op).
    const { cmd, args } = resolveStrykerCommand();
    assert.notEqual(cmd, "npx", "must not fall through to npx when the bundled binary is present");
    assert.match(cmd, /[/\\]stryker$/, `expected a path to the local stryker bin, got ${cmd}`);
    assert.deepEqual(args, ["run"]);
  });
});
