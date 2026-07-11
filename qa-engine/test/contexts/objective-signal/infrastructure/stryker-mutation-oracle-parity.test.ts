// test/contexts/objective-signal/infrastructure/stryker-mutation-oracle-parity.test.ts
// PARITY (mutation-oracle twin of fault-injection-oracle-parity.test.ts — kills false-green
// PC-003): pins StrykerMutationOracleAdapter.measure() against FROZEN snapshot literals captured
// from the legacy src/qa/learning/mutation-code.ts's runMutationOracle BEFORE that file was
// deleted (migration-tier-1-2, Slice 3 — this test itself was written in Slice 1, wrapping the
// still-live legacy function, and is re-pointed here in the SAME commit as the src deletion). The
// orchestration is now absorbed into the adapter itself (see stryker-mutation-oracle.adapter.ts)
// — no src/ import remains in this file, and it is no longer excluded from qa-engine's typecheck.
//
// WARNING (judgment-day round-1, frozen-snapshot discipline — precedent:
// error-class-parity.test.ts's LEGACY_RESOLVE_ERROR_CLASS_SNAPSHOT): the literals asserted below
// are a FROZEN oracle — the legacy source they were captured from
// (src/qa/learning/mutation-code.ts) no longer exists, so there is no live re-derivation
// possible. If a change to the adapter's absorbed orchestration makes one of these assertions
// fail, that failure is signaling a REAL behavioral divergence from the legacy oracle, not a
// stale fixture. Editing a snapshot VALUE here to make a failing test pass silently rebaselines
// away that regression instead of fixing it — never do that without a written justification (in
// the commit message or a comment here) for why the NEW value is the correct behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { StrykerMutationOracleAdapter, type MutationOracleDeps } from "@contexts/objective-signal/infrastructure/stryker-mutation-oracle.adapter.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";

const sha = Sha.of("abcdef1");
const br = BlastRadius.of(sha, ["src/svc.ts"]);

// Same fixture shape captured in Slice 1's original mockSpawn (mirrors
// src/qa/learning/mutation-code.test.ts's mockSpawn helper).
function mockSpawn(result: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: Error;
  createReport?: boolean;
}) {
  return (_cmd: string, _args: string[], opts: { cwd: string }): ChildProcess => {
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = { error: [], close: [] };
    const child = {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
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
      listeners["close"]?.forEach((fn) => fn(result.exitCode ?? 0));
    }, 1);

    return child;
  };
}

function deps(overrides: Partial<MutationOracleDeps> = {}): MutationOracleDeps {
  return {
    spawn: mockSpawn({}),
    detectCodeProject: () => ({ ecosystem: "node", test: { cmd: "node", args: ["--test"] } }),
    scrubEnv: () => ({}),
    processKill: { killTree: () => {} },
    ...overrides,
  };
}

function tmpRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "mut-parity-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "index.ts"), "export const x = 1;");
  return repo;
}

test("FROZEN: non-node ecosystem -> valueScore null (legacy behavior, pinned pre-deletion)", async () => {
  const repo = tmpRepo();
  try {
    const adapter = new StrykerMutationOracleAdapter(
      deps({ detectCodeProject: () => ({ ecosystem: "python", test: { cmd: "python3", args: ["-m", "pytest"] } }) }),
    );
    const r = await adapter.measure(br, repo, "qa-bot-abc");
    assert.equal(r.valueScore, null, "FROZEN: non-node ecosystem yields no score");
    assert.equal(r.mutantCount, 0);
    assert.equal(r.killedCount, 0);
    assert.match(r.details, /not available/i);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("FROZEN: node ecosystem + parseable Stryker report -> score/100 + killed/mutant (legacy arithmetic, pinned pre-deletion)", async () => {
  const repo = tmpRepo();
  try {
    const adapter = new StrykerMutationOracleAdapter(deps({ spawn: mockSpawn({ exitCode: 0, createReport: true }) }));
    const r = await adapter.measure(br, repo, "qa-bot-abc");
    assert.equal(r.valueScore, 0.755, "FROZEN: mutationScore/100, matching the legacy report-parse arithmetic");
    assert.equal(r.mutantCount, 200);
    assert.equal(r.killedCount, 151);
    assert.match(r.details, /151\/200/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("FROZEN: Stryker spawn error -> valueScore null (legacy behavior, pinned pre-deletion)", async () => {
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

test("FROZEN: BlastRadius.changedFiles scopes the Stryker mutate targets (legacy selectMutateTargets behavior, pinned pre-deletion)", async () => {
  const repo = tmpRepo();
  writeFileSync(join(repo, "src", "changed.ts"), "export const y = 2;");
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
    const localBr = BlastRadius.of(sha, ["src/changed.ts"]);
    const adapter = new StrykerMutationOracleAdapter(deps({ spawn: scopingSpawn }));
    await adapter.measure(localBr, repo, "qa-bot-abc");
    assert.deepEqual(seenMutate, ["src/changed.ts"], "FROZEN: BlastRadius.changedFiles must scope the mutate targets, not the whole repo");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
