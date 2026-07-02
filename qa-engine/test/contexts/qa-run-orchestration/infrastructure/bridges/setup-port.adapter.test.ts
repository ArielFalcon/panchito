// test/contexts/qa-run-orchestration/infrastructure/bridges/setup-port.adapter.test.ts
// RED-first: SetupPortAdapter dispatches between the e2e/code setup collaborators (duck-typed
// callbacks matching setupE2eProject/setupCodeProject's call shape). THIN — no new policy: this
// bridge only selects the collaborator by target and forwards specDir/signal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SetupPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/setup-port.adapter.ts";

test("setup() dispatches to the e2e collaborator for target 'e2e' and forwards specDir", async () => {
  let capturedDir: string | undefined;
  const e2e = async (dir: string) => {
    capturedDir = dir;
  };
  const code = async () => {
    throw new Error("must not be called for target 'e2e'");
  };
  const adapter = new SetupPortAdapter({ e2e, code }, { target: "e2e" });

  await adapter.setup("/mirrors/org/app/e2e");

  assert.equal(capturedDir, "/mirrors/org/app/e2e");
});

test("setup() dispatches to the code collaborator for target 'code' and forwards specDir", async () => {
  let capturedDir: string | undefined;
  const e2e = async () => {
    throw new Error("must not be called for target 'code'");
  };
  const code = async (dir: string) => {
    capturedDir = dir;
  };
  const adapter = new SetupPortAdapter({ e2e, code }, { target: "code" });

  await adapter.setup("/mirrors/org/app");

  assert.equal(capturedDir, "/mirrors/org/app");
});

test("setup() forwards an AbortSignal into the e2e collaborator", async () => {
  const controller = new AbortController();
  let capturedSignal: AbortSignal | undefined;
  const e2e = async (_dir: string, opts?: { signal?: AbortSignal }) => {
    capturedSignal = opts?.signal;
  };
  const code = async () => {};
  const adapter = new SetupPortAdapter({ e2e, code }, { target: "e2e" });

  await adapter.setup("/mirrors/org/app/e2e", controller.signal);

  assert.equal(capturedSignal, controller.signal, "the SAME AbortSignal instance passed to setup() must reach the e2e collaborator, not be dropped at the bridge");
});

test("setup() forwards an AbortSignal into the code collaborator", async () => {
  const controller = new AbortController();
  let capturedSignal: AbortSignal | undefined;
  const e2e = async () => {};
  const code = async (_dir: string, opts?: { signal?: AbortSignal }) => {
    capturedSignal = opts?.signal;
  };
  const adapter = new SetupPortAdapter({ e2e, code }, { target: "code" });

  await adapter.setup("/mirrors/org/app", controller.signal);

  assert.equal(capturedSignal, controller.signal, "the SAME AbortSignal instance passed to setup() must reach the code collaborator, not be dropped at the bridge");
});

test("setup() with no signal at all leaves opts.signal undefined (no fabricated AbortSignal)", async () => {
  let capturedOpts: { signal?: AbortSignal } | undefined;
  const e2e = async (_dir: string, opts?: { signal?: AbortSignal }) => {
    capturedOpts = opts;
  };
  const code = async () => {};
  const adapter = new SetupPortAdapter({ e2e, code }, { target: "e2e" });

  await adapter.setup("/mirrors/org/app/e2e");

  assert.equal(capturedOpts?.signal, undefined);
});

test("setup() propagates a throw from the e2e collaborator verbatim (never swallowed)", async () => {
  const e2e = async () => {
    throw new Error("npm ci failed (code 1)");
  };
  const code = async () => {};
  const adapter = new SetupPortAdapter({ e2e, code }, { target: "e2e" });

  await assert.rejects(() => adapter.setup("/mirrors/org/app/e2e"), /npm ci failed/);
});

test("setup() propagates a throw from the code collaborator verbatim (never swallowed)", async () => {
  const e2e = async () => {};
  const code = async () => {
    throw new Error("code-mode install timeout after 600000ms");
  };
  const adapter = new SetupPortAdapter({ e2e, code }, { target: "code" });

  await assert.rejects(() => adapter.setup("/mirrors/org/app"), /timeout/);
});
