// Behavioral tests for runBinary — the shared external-binary spawn wrapper used by
// complexity.ts, semantic-diff.ts, and patterns.ts. Wraps SandboxedBinaryRunnerAdapter (Plan
// 7.2) + scrubEnv, adapting to the legacy src/qa/static-signal/exec.ts fail-open contract:
// resolve (never reject) with code:null on spawn error or timeout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runBinary } from "@contexts/change-analysis/infrastructure/extractors/runbinary.ts";

test("runBinary spawns a real command and captures exitCode + stdout", async () => {
  const result = await runBinary(process.execPath, ["-e", "process.stdout.write('ok')"], process.cwd());
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "ok");
});

test("runBinary resolves (never rejects) with code:null when the binary does not exist", async () => {
  const result = await runBinary("this-binary-does-not-exist-xyz", [], process.cwd());
  assert.equal(result.code, null);
  assert.equal(result.stdout, "");
});

test("runBinary passes extraEnv through to the spawned process", async () => {
  const result = await runBinary(
    process.execPath,
    ["-e", "process.stdout.write(process.env.MY_EXTRA_VAR ?? 'MISSING')"],
    process.cwd(),
    60_000,
    { MY_EXTRA_VAR: "present" },
  );
  assert.equal(result.stdout, "present");
});
