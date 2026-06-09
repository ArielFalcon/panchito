import { test } from "node:test";
import assert from "node:assert/strict";
import { routeEvent, ActivityRouter } from "./agent-activity";

const sessions = () => new Map([["s1", "run-1"]]);

// A message.part.updated event wrapping a part (sessionID lives INSIDE the part).
const partEvent = (part: Record<string, unknown>) => ({ type: "message.part.updated", properties: { part: { sessionID: "s1", ...part } } });

test("routeEvent surfaces a completed write tool as a clean file basename", () => {
  const r = routeEvent(partEvent({ type: "tool", tool: "write", state: { status: "completed", input: { filePath: "e2e/specs/checkout.spec.ts" } } }), sessions());
  assert.equal(r.activities.length, 1);
  assert.equal(r.activities[0]!.kind, "file");
  assert.equal(r.activities[0]!.text, "checkout.spec.ts");
});

test("routeEvent surfaces a completed bash tool as a command", () => {
  const r = routeEvent(partEvent({ type: "tool", tool: "bash", state: { status: "completed", input: { command: "npx playwright test --list" } } }), sessions());
  assert.equal(r.activities[0]!.kind, "command");
  assert.equal(r.activities[0]!.text, "npx playwright test --list");
});

test("routeEvent ignores a tool that has NOT completed yet (still streaming)", () => {
  const r = routeEvent(partEvent({ type: "tool", tool: "write", state: { status: "running", input: { filePath: "x.spec.ts" } } }), sessions());
  assert.deepEqual(r.activities, []);
});

test("routeEvent DROPS model prose (text/reasoning parts — the source of broken `\"file\": \"s`)", () => {
  const text = routeEvent(partEvent({ type: "text", text: '{ "file": "src/components/butt' }), sessions());
  const reasoning = routeEvent(partEvent({ type: "reasoning", text: "thinking about the contact form" }), sessions());
  assert.deepEqual(text.activities, []);
  assert.deepEqual(reasoning.activities, []);
});

test("routeEvent expands todo.updated into one activity per todo, preserving status", () => {
  const r = routeEvent({
    type: "todo.updated",
    properties: { sessionID: "s1", todos: [
      { content: "map repo structure", status: "completed" },
      { content: "generate checkout specs", status: "in_progress" },
      { content: "document learnings", status: "pending" },
    ] },
  }, sessions());
  assert.deepEqual(r.activities.map((a) => `${a.text}:${a.status}`), [
    "map repo structure:completed",
    "generate checkout specs:in_progress",
    "document learnings:pending",
  ]);
});

test("routeEvent reads command.executed name + arguments", () => {
  const r = routeEvent({ type: "command.executed", properties: { sessionID: "s1", name: "test", arguments: "--watch" } }, sessions());
  assert.equal(r.activities[0]!.kind, "command");
  assert.equal(r.activities[0]!.text, "test --watch");
});

test("routeEvent drops with a reason for unknown session, unknown kind, and missing session", () => {
  assert.equal(routeEvent(partEvent({ type: "tool", tool: "write", sessionID: "ghost", state: { status: "completed", input: { filePath: "a.ts" } } }), new Map()).dropped, "unknown-session");
  assert.equal(routeEvent({ type: "secret.internal", properties: { sessionID: "s1" } }, sessions()).dropped, "unknown-kind");
  assert.equal(routeEvent({ type: "todo.updated", properties: { todos: [] } }, sessions()).dropped, "no-session");
});

test("ActivityRouter dedups repeated tool emissions (a part updates many times)", () => {
  const router = new ActivityRouter();
  router.register("s1", "run-1");
  const ev = partEvent({ type: "tool", tool: "write", callID: "c1", state: { status: "completed", input: { filePath: "nav.spec.ts" } } });
  assert.equal(router.route(ev).length, 1); // first completed update → emitted
  assert.equal(router.route(ev).length, 0); // same again → deduped
});

test("ActivityRouter demuxes interleaved sessions and counts unknown-session drops", () => {
  const router = new ActivityRouter();
  router.register("sA", "run-A");
  router.register("sB", "run-B");
  assert.equal(router.route({ type: "todo.updated", properties: { sessionID: "sA", todos: [{ content: "x", status: "pending" }] } })[0]!.runId, "run-A");
  assert.equal(router.route({ type: "todo.updated", properties: { sessionID: "sB", todos: [{ content: "y", status: "pending" }] } })[0]!.runId, "run-B");
  assert.equal(router.route({ type: "command.executed", properties: { sessionID: "maintainer", name: "x", arguments: "" } }).length, 0);
  assert.equal(router.drops["unknown-session"], 1);
});

test("ActivityRouter tracks context for heartbeat enrichment (last todo, files)", () => {
  const router = new ActivityRouter();
  router.register("s1", "run-1");
  router.route({ type: "todo.updated", properties: { sessionID: "s1", todos: [{ content: "read existing suite", status: "in_progress" }] } });
  router.route(partEvent({ type: "tool", tool: "write", callID: "a", state: { status: "completed", input: { filePath: "e2e/nav.spec.ts" } } }));
  router.route(partEvent({ type: "tool", tool: "write", callID: "b", state: { status: "completed", input: { filePath: "e2e/checkout.spec.ts" } } }));
  const ctx = router.contextForRun("run-1");
  assert.match(ctx, /read existing suite/);
  assert.match(ctx, /files edited: 2/);
  assert.match(ctx, /checkout\.spec\.ts/);
});

test("ActivityRouter forgets a session after unregister", () => {
  const router = new ActivityRouter();
  router.register("s1", "run-1");
  assert.equal(router.route({ type: "command.executed", properties: { sessionID: "s1", name: "build", arguments: "" } }).length, 1);
  router.unregister("s1");
  assert.equal(router.route({ type: "command.executed", properties: { sessionID: "s1", name: "build", arguments: "" } }).length, 0);
  assert.equal(router.drops["unknown-session"], 1);
});
