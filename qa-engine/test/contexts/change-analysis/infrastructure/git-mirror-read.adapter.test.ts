import { test } from "node:test";
import assert from "node:assert/strict";
import { GitMirrorReadAdapter } from "@contexts/change-analysis/infrastructure/git-mirror-read.adapter.ts";
import type { SandboxedBinaryRunner, SandboxedRunRequest } from "../../../../src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import { Sha } from "@kernel/sha.ts";

function runnerReturning(stdout: string, capture?: (r: SandboxedRunRequest) => void): SandboxedBinaryRunner {
  return { run: async (req) => { capture?.(req); return { exitCode: 0, stdout, stderr: "", timedOut: false }; } };
}

test("diff() shells git with the sha and returns stdout", async () => {
  let seen: SandboxedRunRequest | null = null;
  const adapter = new GitMirrorReadAdapter("/repo", runnerReturning("DIFF", (r) => (seen = r)));
  const out = await adapter.diff(Sha.of("abc1234"));
  assert.equal(out, "DIFF");
  assert.equal(seen!.command, "git");
  assert.ok(seen!.args.includes("abc1234"));
  assert.equal(seen!.cwd, "/repo");
});

test("blastRadius() returns a Sha-keyed BlastRadius from the parsed diff", async () => {
  const diff = ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -1,1 +1,2 @@", " a", "+b"].join("\n");
  const adapter = new GitMirrorReadAdapter("/repo", runnerReturning(diff));
  const br = await adapter.blastRadius(Sha.of("abc1234"));
  assert.deepEqual([...br.changedFiles], ["x.ts"]);
  assert.equal(br.isEmpty, false);
});

test("message() returns the commit message stdout trimmed", async () => {
  const adapter = new GitMirrorReadAdapter("/repo", runnerReturning("feat: x\n\nbody\n"));
  assert.equal(await adapter.message(Sha.of("abc1234")), "feat: x\n\nbody");
});

test("diff() throws on non-zero exitCode — never returns silent empty diff (CLAUDE.md surface-errors rule)", async () => {
  const badRunner: SandboxedBinaryRunner = {
    run: async () => ({ exitCode: 128, stdout: "", stderr: "fatal: bad object deadbeef", timedOut: false }),
  };
  const adapter = new GitMirrorReadAdapter("/repo", badRunner);
  await assert.rejects(
    () => adapter.diff(Sha.of("deadbeef")),
    (err: unknown) => err instanceof Error && /fatal: bad object deadbeef/.test(err.message),
    "expected diff() to throw when git exits non-zero",
  );
});
