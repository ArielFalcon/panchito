// TDD tests for withSessionRegistration (opencode-client.ts) — WS6.2 (full-flow remediation,
// timeouts & operational observability). registerRunSession/unregisterRunSession existed and were
// exported, but nothing on the rewritten (qa-engine) production path ever called them — a session
// opened with a descriptor.runId never got mapped to its run, so SSE live-activity events for that
// session were never routed, and the run never showed live agent activity in the TUI. This wrapper
// restores that composition call at the SAME seam withStallWatchdog/withUsageSink already use.
// Written FIRST (RED) before implementation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { withSessionRegistration } from "./opencode-client";
import type { AgentDeps } from "./opencode-client";

function fakeBaseDeps(sessionId = "sess-1"): { deps: AgentDeps; disposed: boolean[] } {
  const disposed: boolean[] = [];
  const deps: AgentDeps = {
    open: async (_agent, _cwd, _opts) => ({
      id: sessionId,
      prompt: async (_text: string) => "output",
      dispose: async () => {
        disposed.push(true);
      },
    }),
  };
  return { deps, disposed };
}

test("withSessionRegistration returns a valid AgentDeps (structural)", async () => {
  const { deps: base } = fakeBaseDeps();
  const wrapped = withSessionRegistration(base);
  assert.equal(typeof wrapped.open, "function");
  const session = await wrapped.open("qa-reviewer", "/mirrors/org/app", {
    descriptor: { runId: "run-42", role: "qa-reviewer" },
  });
  assert.equal(typeof session.prompt, "function");
  assert.equal(typeof session.dispose, "function");
  await session.dispose();
});

test("withSessionRegistration calls registerRunSession with the session id, descriptor.runId, and cwd when a runId is present", async () => {
  const { deps: base } = fakeBaseDeps("sess-99");
  const calls: Array<{ sessionId: string; runId: string; directory: string }> = [];
  const wrapped = withSessionRegistration(base, {
    register: (sessionId, runId, directory) => calls.push({ sessionId, runId, directory }),
    unregister: () => {},
  });

  await wrapped.open("qa-reviewer", "/mirrors/org/app", {
    descriptor: { runId: "run-42", role: "qa-reviewer" },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { sessionId: "sess-99", runId: "run-42", directory: "/mirrors/org/app" });
});

test("withSessionRegistration does NOT register when descriptor.runId is absent (no fabricated run identity)", async () => {
  const { deps: base } = fakeBaseDeps();
  let registerCalls = 0;
  const wrapped = withSessionRegistration(base, {
    register: () => { registerCalls++; },
    unregister: () => {},
  });

  await wrapped.open("qa-generator", "/mirrors/org/app");
  await wrapped.open("qa-generator", "/mirrors/org/app", { descriptor: { role: "qa-generator" } });

  assert.equal(registerCalls, 0, "no descriptor.runId means no run context — must not register a session under a fabricated identity");
});

test("withSessionRegistration unregisters the session on dispose", async () => {
  const { deps: base } = fakeBaseDeps("sess-77");
  const unregistered: string[] = [];
  const wrapped = withSessionRegistration(base, {
    register: () => {},
    unregister: (sessionId) => unregistered.push(sessionId),
  });

  const session = await wrapped.open("qa-reviewer", "/mirrors/org/app", {
    descriptor: { runId: "run-1", role: "qa-reviewer" },
  });
  assert.equal(unregistered.length, 0, "must not unregister before dispose");
  await session.dispose();
  assert.deepEqual(unregistered, ["sess-77"]);
});

test("withSessionRegistration does NOT unregister on dispose when the session was never registered (no runId)", async () => {
  const { deps: base } = fakeBaseDeps("sess-55");
  let unregisterCalls = 0;
  const wrapped = withSessionRegistration(base, {
    register: () => {},
    unregister: () => { unregisterCalls++; },
  });

  const session = await wrapped.open("qa-generator", "/mirrors/org/app");
  await session.dispose();

  assert.equal(unregisterCalls, 0);
});

test("withSessionRegistration with no injected collaborators defaults to the real registerRunSession/unregisterRunSession (production wiring)", async () => {
  const { deps: base } = fakeBaseDeps("sess-real-1");
  const wrapped = withSessionRegistration(base);

  // Should not throw — proves the default collaborators resolve to the real exported functions.
  const session = await wrapped.open("qa-reviewer", "/mirrors/org/app", {
    descriptor: { runId: "run-real-1", role: "qa-reviewer" },
  });
  await session.dispose();
});

test("withSessionRegistration forwards prompt()/session identity unchanged (thin wrapper — no behavior mutation)", async () => {
  const { deps: base } = fakeBaseDeps("sess-passthrough");
  const wrapped = withSessionRegistration(base, { register: () => {}, unregister: () => {} });

  const session = await wrapped.open("qa-generator", "/mirrors/org/app");
  assert.equal(session.id, "sess-passthrough");
  const out = await session.prompt("hello");
  assert.equal(out, "output");
});
