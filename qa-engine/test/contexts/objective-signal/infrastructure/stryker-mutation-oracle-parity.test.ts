// test/contexts/objective-signal/infrastructure/stryker-mutation-oracle-parity.test.ts
// PARITY (mutation-oracle twin of fault-injection-oracle-parity.test.ts — kills false-green
// PC-003): wrap the REAL legacy runMutationOracle through the StrykerMutationOracleAdapter with
// STUBBED MutationDeps.spawn (a fake ChildProcess, no real Stryker binary spawned). This is the
// mutation oracle's FIRST parity test — written BEFORE any src/qa/learning/mutation-code.ts
// modification (the top proposal risk for this migration: the mutation oracle had no such pin,
// unlike its fault-injection twin). It proves the FUNCTIONAL contract end to end — that
// BlastRadius.changedFiles actually reaches selectMutateTargets' Stryker `mutate` scoping, and
// that the ecosystem/report/spawn-error/timeout branches degrade exactly as they do pre-move.
//
// Excluded from qa-engine/tsconfig.json typecheck (like every other *-parity.test.ts) because the
// direct src/ relative import drags the legacy graph outside the composite project's rootDir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { StrykerMutationOracleAdapter } from "@contexts/objective-signal/infrastructure/stryker-mutation-oracle.adapter.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";
import { runMutationOracle, type MutationDeps } from "../../../../../src/qa/learning/mutation-code.ts";
import type { OracleInput } from "../../../../../src/qa/learning/oracle-types.ts";

const sha = Sha.of("abcdef1");
const br = BlastRadius.of(sha, ["src/svc.ts"]);

// Mirrors src/qa/learning/mutation-code.test.ts's mockSpawn helper exactly — same fixture shape,
// so a divergence in this parity test's fixture matrix would also flag a legacy test drift.
function mockSpawn(result: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: Error;
  createReport?: boolean;
}): MutationDeps {
  return {
    spawn: (_cmd, _args, opts) => {
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
    },
  };
}

// A spawn stub that intercepts the Stryker config written to disk before responding — proves
// changedFiles threaded through the adapter reaches selectMutateTargets' `mutate` scoping, without
// needing to import selectMutateTargets directly.
function scopingSpawn(onConfig: (mutate: string[]) => void): MutationDeps {
  return {
    spawn: (_cmd, _args, opts) => {
      const configPath = join(opts.cwd, "stryker.conf.json");
      const config = JSON.parse(readFileSync(configPath, "utf8")) as { mutate: string[] };
      onConfig(config.mutate);
      const child = {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (event: string, fn: (...args: unknown[]) => void) => {
          if (event === "close") setTimeout(() => fn(0), 1);
        },
        pid: 12345,
      } as unknown as ChildProcess;
      return child;
    },
  };
}

// A spawn stub that never fires "close" — only a timeout (or abort) resolves the promise.
const neverCloseSpawn: MutationDeps = {
  spawn: () =>
    ({
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: () => {},
      pid: 12345,
    }) as unknown as ChildProcess,
};

function setupNodeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "mut-parity-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "test-project", scripts: { test: "node --test" }, devDependencies: {} }),
  );
  writeFileSync(join(repo, "package-lock.json"), "{}");
  writeFileSync(join(repo, "src", "index.ts"), "export const x = 1;");
  return repo;
}

// Build an adapter whose runner is the REAL oracle bound to the supplied stubbed deps — mirrors
// fault-injection-oracle-parity.test.ts's realOracleAdapter pattern for the mutation twin.
function realOracleAdapter(deps: MutationDeps): StrykerMutationOracleAdapter {
  return new StrykerMutationOracleAdapter((input) =>
    runMutationOracle(
      {
        target: "code",
        repoDir: input.repoDir,
        namespace: input.namespace,
        changedFiles: input.changedFiles,
      } satisfies OracleInput,
      deps,
    ),
  );
}

// Same as realOracleAdapter, but embeds a short timeoutMs in the closure — OracleInputLike (the
// adapter's public measure() surface) has no timeoutMs field, so this test-only variant hardcodes
// it the same way realOracleAdapter hardcodes BASE_URL in the fault-injection twin.
function realOracleAdapterWithTimeout(deps: MutationDeps, timeoutMs: number): StrykerMutationOracleAdapter {
  return new StrykerMutationOracleAdapter((input) =>
    runMutationOracle(
      {
        target: "code",
        repoDir: input.repoDir,
        namespace: input.namespace,
        changedFiles: input.changedFiles,
        timeoutMs,
      } satisfies OracleInput,
      deps,
    ),
  );
}

test("real oracle through the adapter: non-node ecosystem (no package.json) -> valueScore null", async () => {
  const repo = mkdtempSync(join(tmpdir(), "mut-parity-nonnode-"));
  try {
    const r = await realOracleAdapter(mockSpawn({})).measure(br, repo, "qa-bot-abc");
    assert.equal(r.valueScore, null);
    assert.equal(r.mutantCount, 0);
    assert.equal(r.killedCount, 0);
    assert.match(r.details, /not available/i);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("real oracle through the adapter: node ecosystem + parseable Stryker report -> score/100 + killed/mutant", async () => {
  const repo = setupNodeRepo();
  try {
    const r = await realOracleAdapter(mockSpawn({ exitCode: 0, createReport: true })).measure(br, repo, "qa-bot-abc");
    assert.equal(r.valueScore, 0.755, "mutationScore/100, matching the legacy report-parse arithmetic");
    assert.equal(r.mutantCount, 200);
    assert.equal(r.killedCount, 151);
    assert.match(r.details, /151\/200/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("real oracle through the adapter: Stryker spawn error -> valueScore null", async () => {
  const repo = setupNodeRepo();
  try {
    const r = await realOracleAdapter(mockSpawn({ error: new Error("ENOENT: stryker not found") })).measure(
      br,
      repo,
      "qa-bot-abc",
    );
    assert.equal(r.valueScore, null);
    assert.match(r.details, /spawn failed|ENOENT/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("real oracle through the adapter: Stryker spawn that never closes -> timeout -> valueScore null", async () => {
  const repo = setupNodeRepo();
  try {
    const r = await realOracleAdapterWithTimeout(neverCloseSpawn, 10).measure(br, repo, "qa-bot-abc");
    assert.equal(r.valueScore, null);
    assert.match(r.details, /timeout/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("real oracle through the adapter: BlastRadius.changedFiles scopes the Stryker mutate targets (selectMutateTargets)", async () => {
  const repo = setupNodeRepo();
  writeFileSync(join(repo, "src", "changed.ts"), "export const y = 2;");
  try {
    let seenMutate: string[] | undefined;
    const localBr = BlastRadius.of(sha, ["src/changed.ts"]);
    await realOracleAdapter(scopingSpawn((mutate) => (seenMutate = mutate))).measure(localBr, repo, "qa-bot-abc");
    assert.deepEqual(
      seenMutate,
      ["src/changed.ts"],
      "BlastRadius.changedFiles must scope the Stryker mutate targets via selectMutateTargets, not the whole repo",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
