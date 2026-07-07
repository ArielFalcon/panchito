// test/contexts/qa-run-orchestration/infrastructure/bridges/workspace-port.adapter.test.ts
// RED-first (Task E.0): WorkspacePortAdapter — a REAL minimal implementation. NO sibling collaborator
// exists to wrap: grep-confirmed there is NO "mirror prepare"/checkout concept anywhere under
// workspace-and-publication/ (MirrorRegistryPort resolves repo->dir only, explicitly decoupled from
// WorkspacePort per its own header; MirrorGcPort only prunes an EXISTING mirror). This adapter injects
// a checkout primitive (same DI pattern as GitMirrorReadAdapter/VcsWriteAdapter: argv/paths live in
// the adapter, the actual git/fs call is injected so the test needs no real git binary). Cross-repo
// routing stays OPAQUE inside this bridge (the plan's own scope note) — the injected checkout fn
// receives only sha + the static repo/specRelDir context; the composition root decides which mirror.
//
// WS2.1 (full-flow remediation): the adapter is now TARGET-AWARE via `specRelDir` (renamed from
// `e2eRelDir` — see this module's own header). Legacy passed `mirrorDir` itself for a code-target run
// (git show 1228ea7~1:src/pipeline.ts:1299,2497 — `setupCode(mirrorDir, ...)`/`executeCode(mirrorDir,
// ...)`, never a `mirrorDir/e2e` subpath); this adapter reproduces that exactly: an EMPTY `specRelDir`
// (the code target's context) makes prepare() return the bare mirrorDir, never `mirrorDir/`. A
// non-empty `specRelDir` (e2e's "e2e") keeps the prior `${mirrorDir}/${specRelDir}` join.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspacePortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/workspace-port.adapter.ts";
import { Sha } from "@kernel/sha.ts";

test("prepare() delegates to the injected checkout collaborator and derives specDir from mirrorDir + specRelDir (e2e target)", async () => {
  let capturedSha: Sha | undefined;
  const checkout = async (sha: Sha): Promise<string> => {
    capturedSha = sha;
    return "/mirrors/org/app";
  };
  const adapter = new WorkspacePortAdapter(checkout, { specRelDir: "e2e" });

  const sha = Sha.of("abc1234");
  const result = await adapter.prepare(sha);

  assert.equal(capturedSha, sha);
  assert.equal(result.specDir, "/mirrors/org/app/e2e");
});

test("prepare() returns the bare mirrorDir when specRelDir is empty (code target — legacy parity: mirrorDir itself, never mirrorDir/e2e)", async () => {
  const checkout = async (): Promise<string> => "/mirrors/org/app";
  const adapter = new WorkspacePortAdapter(checkout, { specRelDir: "" });

  const result = await adapter.prepare(Sha.of("def5678"));

  assert.equal(result.specDir, "/mirrors/org/app", "code target: specDir must be the bare mirrorDir, matching legacy's setupCode(mirrorDir, ...)/executeCode(mirrorDir, ...)");
});

test("prepare() surfaces a checkout failure loudly (no swallowed error — CLAUDE.md invariant)", async () => {
  const checkout = async (): Promise<string> => { throw new Error("mirror clone failed: network unreachable"); };
  const adapter = new WorkspacePortAdapter(checkout, { specRelDir: "e2e" });

  await assert.rejects(() => adapter.prepare(Sha.of("abc1234")), /mirror clone failed/);
});
