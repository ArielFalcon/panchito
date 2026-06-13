import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSandbox, buildCodexExecArgs } from "./agent-supervisor.mjs";

// Importing agent-supervisor.mjs must NOT start the HTTP server (it is main-guarded). If it did, the
// listening socket would keep this process alive and node:test would hang instead of exiting — so
// reaching these assertions and finishing cleanly is itself the proof that the import is side-effect-free.

test("resolveSandbox: read-only roles stay read-only; an absent sandbox defaults to workspace-write", () => {
  assert.equal(resolveSandbox("read-only"), "read-only");
  assert.equal(resolveSandbox("workspace-write"), "workspace-write");
  assert.equal(resolveSandbox(undefined), "workspace-write"); // older orchestrator that omits it
});

test("resolveSandbox rejects an unknown value (no `--sandbox` flag-injection)", () => {
  assert.throws(() => resolveSandbox("danger-full-access"), /sandbox must be/);
  assert.throws(() => resolveSandbox("--privileged"), /sandbox must be/);
});

test("buildCodexExecArgs applies the per-role sandbox so the reviewer cannot write the workspace", () => {
  const reviewer = buildCodexExecArgs({ cwd: "/repo", sandbox: "read-only" });
  const i = reviewer.indexOf("--sandbox");
  assert.ok(i >= 0 && reviewer[i + 1] === "read-only", "reviewer must run --sandbox read-only");

  const dflt = buildCodexExecArgs({ cwd: "/repo" });
  const j = dflt.indexOf("--sandbox");
  assert.equal(dflt[j + 1], "workspace-write", "an absent sandbox defaults to workspace-write");

  const withModel = buildCodexExecArgs({ cwd: "/repo", model: "gpt-5.4", sandbox: "workspace-write" });
  assert.ok(withModel.includes("--model") && withModel.includes("gpt-5.4"));
});

test("buildCodexExecArgs throws on an invalid sandbox (surfaced as a 400, never spawned)", () => {
  assert.throws(() => buildCodexExecArgs({ cwd: "/repo", sandbox: "nope" }), /sandbox must be/);
});
