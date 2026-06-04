import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureMirror, getCommitDiff, MirrorDeps } from "./repo-mirror";

// authArgs() depende de GITHUB_TOKEN; lo limpiamos para aislar la lógica.
delete process.env.GITHUB_TOKEN;

function recorder(exists: boolean): MirrorDeps & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    root: "/tmp/mirrors",
    exists: () => exists,
    git: async (args) => {
      calls.push(args);
      return "diff-output";
    },
  };
}

test("clona, hace checkout forzado y limpia si el espejo no existe", async () => {
  const d = recorder(false);
  const dir = await ensureMirror("org/app", "abc123", d);
  assert.equal(dir, "/tmp/mirrors/org__app");
  assert.equal(d.calls[0]![0], "clone");
  assert.deepEqual(d.calls[1], ["checkout", "-f", "abc123"]);
  assert.deepEqual(d.calls[2], ["clean", "-fd", "-e", "node_modules"]);
});

test("hace fetch, checkout forzado y limpieza si el espejo ya existe", async () => {
  const d = recorder(true);
  await ensureMirror("org/app", "abc123", d);
  assert.deepEqual(d.calls[0], ["fetch", "origin"]);
  assert.deepEqual(d.calls[1], ["checkout", "-f", "abc123"]);
  assert.deepEqual(d.calls[2], ["clean", "-fd", "-e", "node_modules"]);
});

test("getCommitDiff usa git show del SHA", async () => {
  const d = recorder(true);
  const diff = await getCommitDiff("/tmp/mirrors/org__app", "abc123", d);
  assert.equal(diff, "diff-output");
  assert.deepEqual(d.calls[0], ["show", "--format=", "abc123"]);
});
