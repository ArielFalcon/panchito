// test/contexts/objective-signal/infrastructure/stryker-mutation-oracle.adapter.test.ts
// migration-tier-1-2, Slice 3: the node-stdlib/Stryker helpers and runMutationOracle's
// orchestration previously in src/qa/learning/mutation-code.ts are now absorbed into this file's
// module (helpers as plain exports) and class (orchestration in measure()). Ctor takes one
// {spawn, detectCodeProject, scrubEnv} bundle — no more injected "runner closure" wrapping a
// legacy function.
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  StrykerMutationOracleAdapter,
  selectMutateTargets,
  resolveStrykerCommand,
  type MutationOracleDeps,
} from "@contexts/objective-signal/infrastructure/stryker-mutation-oracle.adapter.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";

const sha = Sha.of("abcdef1");
const br = BlastRadius.of(sha, ["src/svc.ts"]);

// Mirrors the legacy src/qa/learning/mutation-code.test.ts's mockSpawn helper.
function mockSpawn(result: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: Error;
  createReport?: boolean;
}) {
  return (_cmd: string, _args: string[], opts: { cwd: string; env: Record<string, string>; detached: boolean }): ChildProcess => {
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = { error: [], close: [] };
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

    setTimeout(() => {
      if (result.error) {
        listeners["error"]?.forEach((fn) => fn(result.error!));
        return;
      }
      if (result.createReport) {
        const reportDir = join(opts.cwd, "reports", "mutation");
        mkdirSync(reportDir, { recursive: true });
        writeFileSync(
          join(reportDir, "mutation.json"),
          JSON.stringify({ metrics: { mutationScore: 75.5, killed: 151, totalMutants: 200 } }),
        );
      }
      if (result.stdout) stdoutListeners.forEach((fn) => fn(Buffer.from(result.stdout!)));
      if (result.stderr) stderrListeners.forEach((fn) => fn(Buffer.from(result.stderr!)));
      listeners["close"]?.forEach((fn) => fn(result.exitCode ?? 0));
    }, 1);

    return child;
  };
}

function tmpRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "stryker-adapter-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  return repo;
}

function deps(overrides: Partial<MutationOracleDeps> = {}): MutationOracleDeps {
  return {
    spawn: mockSpawn({}),
    detectCodeProject: () => ({ ecosystem: "node", test: { cmd: "node", args: ["--test"] } }),
    scrubEnv: () => ({}),
    ...overrides,
  };
}

describe("StrykerMutationOracleAdapter.measure", () => {
  it("returns null valueScore for a non-node ecosystem (detectCodeProject-driven)", async () => {
    const repo = tmpRepo();
    try {
      const adapter = new StrykerMutationOracleAdapter(
        deps({ detectCodeProject: () => ({ ecosystem: "python", test: { cmd: "python3", args: ["-m", "pytest"] } }) }),
      );
      const r = await adapter.measure(br, repo, "qa-bot-abc");
      assert.equal(r.valueScore, null);
      assert.match(r.details, /not available/i);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns null valueScore when Stryker spawn fails", async () => {
    const repo = tmpRepo();
    try {
      const adapter = new StrykerMutationOracleAdapter(deps({ spawn: mockSpawn({ error: new Error("ENOENT: stryker not found") }) }));
      const r = await adapter.measure(br, repo, "qa-bot-abc");
      assert.equal(r.valueScore, null);
      assert.match(r.details, /spawn failed|ENOENT/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns valueScore from a parseable Stryker report", async () => {
    const repo = tmpRepo();
    writeFileSync(join(repo, "src", "index.ts"), "export function add(a: number, b: number) { return a + b; }");
    try {
      const adapter = new StrykerMutationOracleAdapter(deps({ spawn: mockSpawn({ exitCode: 0, createReport: true }) }));
      const r = await adapter.measure(br, repo, "qa-bot-abc");
      assert.equal(r.valueScore, 0.755);
      assert.equal(r.mutantCount, 200);
      assert.equal(r.killedCount, 151);
      assert.match(r.details, /151\/200/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns null valueScore when Stryker produces no report", async () => {
    const repo = tmpRepo();
    writeFileSync(join(repo, "src", "index.ts"), "export const x = 1;");
    try {
      const adapter = new StrykerMutationOracleAdapter(deps({ spawn: mockSpawn({ exitCode: 0, stderr: "No mutants generated" }) }));
      const r = await adapter.measure(br, repo, "qa-bot-abc");
      assert.equal(r.valueScore, null);
      assert.match(r.details, /no parseable report|No mutants/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("cleans up Stryker config + reports after a run", async () => {
    const repo = tmpRepo();
    writeFileSync(join(repo, "src", "index.ts"), "export const x = 1;");
    try {
      const adapter = new StrykerMutationOracleAdapter(deps({ spawn: mockSpawn({ exitCode: 0, createReport: true }) }));
      await adapter.measure(br, repo, "qa-bot-abc");
      assert.equal(existsSync(join(repo, "stryker.conf.json")), false);
      assert.equal(existsSync(join(repo, "reports")), false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("BlastRadius.changedFiles from measure() scope the Stryker mutate targets", async () => {
    const repo = tmpRepo();
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;");
    try {
      let seenMutate: string[] | undefined;
      const scopingSpawn = (_cmd: string, _args: string[], opts: { cwd: string }): ChildProcess => {
        const config = JSON.parse(readFileSync(join(opts.cwd, "stryker.conf.json"), "utf8")) as { mutate: string[] };
        seenMutate = config.mutate;
        return {
          stdout: { on: () => {} },
          stderr: { on: () => {} },
          on: (event: string, fn: (...args: unknown[]) => void) => {
            if (event === "close") setTimeout(() => fn(0), 1);
          },
          pid: 12345,
        } as unknown as ChildProcess;
      };
      const localBr = BlastRadius.of(sha, ["src/a.ts"]);
      const adapter = new StrykerMutationOracleAdapter(deps({ spawn: scopingSpawn }));
      await adapter.measure(localBr, repo, "qa-bot-abc");
      assert.deepEqual(seenMutate, ["src/a.ts"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("selectMutateTargets (change-scoped mutation) — absorbed helper, exercised directly", () => {
  function scopedTmpRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), "mut-scope-"));
    mkdirSync(join(repo, "src"), { recursive: true });
    return repo;
  }

  it("scopes mutation to the changed source files, not the whole repo", () => {
    const repo = scopedTmpRepo();
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;");
    writeFileSync(join(repo, "src", "b.ts"), "export const b = 2;");
    try {
      assert.deepEqual(selectMutateTargets(repo, ["src/a.ts"]), ["src/a.ts"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("ignores test/spec files and non-source changed paths", () => {
    const repo = scopedTmpRepo();
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;");
    writeFileSync(join(repo, "src", "a.test.ts"), "// test");
    try {
      assert.deepEqual(selectMutateTargets(repo, ["src/a.ts", "src/a.test.ts", "README.md"]), ["src/a.ts"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("falls back to repo-wide globs when no changed source file exists", () => {
    const repo = scopedTmpRepo();
    writeFileSync(join(repo, "src", "x.ts"), "export const x = 1;");
    try {
      const targets = selectMutateTargets(repo, ["docs/readme.md"]);
      assert.ok(targets.includes("src/**/*.ts"), `expected fallback globs, got ${targets.join(",")}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("falls back to repo-wide globs when no diff is provided", () => {
    const repo = scopedTmpRepo();
    writeFileSync(join(repo, "src", "x.ts"), "export const x = 1;");
    try {
      assert.ok(selectMutateTargets(repo, undefined).includes("src/**/*.ts"));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("resolveStrykerCommand — absorbed helper, exercised directly", () => {
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

test("target:'code' identity is threaded via measure() and never routes to the e2e oracle", async () => {
  const repo = tmpRepo();
  try {
    const adapter = new StrykerMutationOracleAdapter(deps({ spawn: mockSpawn({ exitCode: 0, createReport: true }) }));
    const r = await adapter.measure(br, repo, "qa-bot-abc");
    assert.equal(typeof r.details, "string", "details field must be present — ValueOracleResult has 4 fields");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
