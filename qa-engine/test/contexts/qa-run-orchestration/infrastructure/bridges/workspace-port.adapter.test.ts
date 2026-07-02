// test/contexts/qa-run-orchestration/infrastructure/bridges/workspace-port.adapter.test.ts
// RED-first (Task E.0): WorkspacePortAdapter — a REAL minimal implementation. NO sibling collaborator
// exists to wrap: grep-confirmed there is NO "mirror prepare"/checkout concept anywhere under
// workspace-and-publication/ (MirrorRegistryPort resolves repo->dir only, explicitly decoupled from
// WorkspacePort per its own header; MirrorGcPort only prunes an EXISTING mirror). This adapter injects
// a checkout primitive (same DI pattern as GitMirrorReadAdapter/VcsWriteAdapter: argv/paths live in
// the adapter, the actual git/fs call is injected so the test needs no real git binary). Cross-repo
// routing stays OPAQUE inside this bridge (the plan's own scope note) — the injected checkout fn
// receives only sha + the static repo/e2eRelDir context; the composition root decides which mirror.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspacePortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/workspace-port.adapter.ts";
import { Sha } from "@kernel/sha.ts";

test("prepare() delegates to the injected checkout collaborator and derives specDir from mirrorDir + e2eRelDir", async () => {
  let capturedSha: Sha | undefined;
  const checkout = async (sha: Sha): Promise<string> => {
    capturedSha = sha;
    return "/mirrors/org/app";
  };
  const adapter = new WorkspacePortAdapter(checkout, { e2eRelDir: "e2e" });

  const sha = Sha.of("abc1234");
  const result = await adapter.prepare(sha);

  assert.equal(capturedSha, sha);
  assert.equal(result.specDir, "/mirrors/org/app/e2e");
});

test("prepare() surfaces a checkout failure loudly (no swallowed error — CLAUDE.md invariant)", async () => {
  const checkout = async (): Promise<string> => { throw new Error("mirror clone failed: network unreachable"); };
  const adapter = new WorkspacePortAdapter(checkout, { e2eRelDir: "e2e" });

  await assert.rejects(() => adapter.prepare(Sha.of("abc1234")), /mirror clone failed/);
});
