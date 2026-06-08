import { test } from "node:test";
import assert from "node:assert/strict";
import { routeEvent, ActivityRouter } from "./agent-activity";

test("routeEvent DROPS model-stream prose (the source of broken `\"file\": \"s` lines)", () => {
  const sessions = new Map([["s1", "run-1"]]);
  // A raw streaming delta that happens to be mid-JSON — exactly what used to leak.
  const r = routeEvent({
    type: "message.part.updated",
    properties: { sessionID: "s1", delta: '{ "file": "src/components/butt' },
  }, sessions);
  assert.equal(r.activity, undefined);
  assert.equal(r.dropped, "unknown-kind");
});

test("routeEvent routes file.edited to a clean basename", () => {
  const sessions = new Map([["s1", "run-1"]]);
  const r = routeEvent({
    type: "file.edited",
    properties: { sessionID: "s1", file: "e2e/specs/checkout.spec.ts" },
  }, sessions);
  assert.equal(r.activity?.runId, "run-1");
  assert.equal(r.activity?.kind, "file");
  assert.equal(r.activity?.text, "checkout.spec.ts");
});

test("routeEvent routes command.executed with the full command", () => {
  const sessions = new Map([["s1", "run-1"]]);
  const r = routeEvent({
    type: "command.executed",
    properties: { sessionID: "s1", command: "npx playwright test --list" },
  }, sessions);
  assert.equal(r.activity?.kind, "command");
  assert.equal(r.activity?.text, "npx playwright test --list");
});

test("routeEvent preserves todo content AND status separately", () => {
  const sessions = new Map([["s1", "run-1"]]);
  const r = routeEvent({
    type: "todo.updated",
    properties: { sessionID: "s1", todo: { content: "generate checkout specs", status: "in-progress" } },
  }, sessions);
  assert.equal(r.activity?.kind, "todo");
  assert.equal(r.activity?.text, "generate checkout specs");
  assert.equal(r.activity?.status, "in_progress");
});

test("routeEvent drops (with a reason) unknown sessions, unknown kinds, and missing sessions", () => {
  const sessions = new Map([["s1", "run-1"]]);
  assert.equal(routeEvent({ type: "file.edited", properties: { sessionID: "ghost", file: "a.ts" } }, sessions).dropped, "unknown-session");
  assert.equal(routeEvent({ type: "secret.internal", properties: { sessionID: "s1" } }, sessions).dropped, "unknown-kind");
  assert.equal(routeEvent({ type: "file.edited" }, sessions).dropped, "no-session");
});

test("ActivityRouter demuxes interleaved sessions to the correct run", () => {
  const router = new ActivityRouter();
  router.register("sA", "run-A");
  router.register("sB", "run-B");

  assert.equal(router.route({ type: "session.status", properties: { sessionID: "sA" } })?.runId, "run-A");
  assert.equal(router.route({ type: "session.status", properties: { sessionID: "sB" } })?.runId, "run-B");

  // Unregistered session → dropped + counted
  assert.equal(router.route({ type: "command.executed", properties: { sessionID: "maintainer" } }), null);
  assert.equal(router.drops["unknown-session"], 1);
});

test("ActivityRouter tracks context for heartbeat enrichment (files + last todo)", () => {
  const router = new ActivityRouter();
  router.register("s1", "run-1");
  router.route({ type: "todo.updated", properties: { sessionID: "s1", todo: { content: "read existing suite", status: "in_progress" } } });
  router.route({ type: "file.edited", properties: { sessionID: "s1", file: "e2e/nav.spec.ts" } });
  router.route({ type: "file.edited", properties: { sessionID: "s1", file: "e2e/checkout.spec.ts" } });
  const ctx = router.contextForRun("run-1");
  assert.match(ctx, /read existing suite/);
  assert.match(ctx, /files edited: 2/);
  assert.match(ctx, /checkout\.spec\.ts/);
});

test("ActivityRouter forgets a session after unregister", () => {
  const router = new ActivityRouter();
  router.register("s1", "run-1");
  assert.ok(router.route({ type: "command.executed", properties: { sessionID: "s1", command: "npm ci" } }));
  router.unregister("s1");
  assert.equal(router.route({ type: "command.executed", properties: { sessionID: "s1", command: "npm ci" } }), null);
  assert.equal(router.drops["unknown-session"], 1);
});
