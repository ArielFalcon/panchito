import { test } from "node:test";
import assert from "node:assert/strict";
import { routeEvent, ActivityRouter } from "./agent-activity";

test("routeEvent routes an allowlisted event from a known session to its run", () => {
  const sessions = new Map([["s1", "run-1"]]);
  const r = routeEvent({
    type: "message.part.updated",
    properties: { sessionID: "s1", delta: "writing login.spec.ts" },
  }, sessions);
  assert.equal(r.activity?.runId, "run-1");
  assert.equal(r.activity?.kind, "message");
  assert.match(r.activity?.text ?? "", /login\.spec\.ts/);
});

test("routeEvent routes file.edited events", () => {
  const sessions = new Map([["s1", "run-1"]]);
  const r = routeEvent({
    type: "file.edited",
    properties: { sessionID: "s1", file: "e2e/checkout.spec.ts" },
  }, sessions);
  assert.equal(r.activity?.kind, "file");
  assert.match(r.activity?.text ?? "", /checkout/);
});

test("routeEvent drops (with a reason) unknown sessions, unknown kinds, and missing sessions", () => {
  const sessions = new Map([["s1", "run-1"]]);
  assert.equal(routeEvent({ type: "message.part.updated", properties: { sessionID: "ghost" } }, sessions).dropped, "unknown-session");
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

test("ActivityRouter forgets a session after unregister", () => {
  const router = new ActivityRouter();
  router.register("s1", "run-1");
  assert.ok(router.route({ type: "command.executed", properties: { sessionID: "s1" } }));
  router.unregister("s1");
  assert.equal(router.route({ type: "command.executed", properties: { sessionID: "s1" } }), null);
  assert.equal(router.drops["unknown-session"], 1);
});
