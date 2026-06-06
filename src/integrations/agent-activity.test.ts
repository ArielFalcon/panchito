import { test } from "node:test";
import assert from "node:assert/strict";
import { routeEvent, ActivityRouter } from "./agent-activity";

test("routeEvent routes an allowlisted event from a known session to its run", () => {
  const sessions = new Map([["s1", "run-1"]]);
  const r = routeEvent({ sessionID: "s1", kind: "tool.invoked", text: "read login.spec.ts" }, sessions);
  assert.equal(r.activity?.runId, "run-1");
  assert.equal(r.activity?.kind, "tool");
  assert.match(r.activity?.text ?? "", /login\.spec\.ts/);
});

test("routeEvent drops (with a reason) unknown sessions, unknown kinds, and missing sessions", () => {
  const sessions = new Map([["s1", "run-1"]]);
  assert.equal(routeEvent({ sessionID: "ghost", kind: "tool" }, sessions).dropped, "unknown-session");
  assert.equal(routeEvent({ sessionID: "s1", kind: "secret.internal" }, sessions).dropped, "unknown-kind");
  assert.equal(routeEvent({ kind: "tool" }, sessions).dropped, "no-session");
});

test("ActivityRouter demuxes interleaved sessions to the correct run and never to the wrong one", () => {
  const router = new ActivityRouter();
  router.register("sA", "run-A");
  router.register("sB", "run-B");

  assert.equal(router.route({ sessionID: "sA", kind: "step", text: "validate" })?.runId, "run-A");
  assert.equal(router.route({ sessionID: "sB", kind: "step", text: "execute" })?.runId, "run-B");

  // An interleaved event from the out-of-queue maintainer session is DROPPED + counted,
  // never misattributed to run-A or run-B.
  assert.equal(router.route({ sessionID: "maintainer-session", kind: "tool" }), null);
  assert.equal(router.drops["unknown-session"], 1);
});

test("ActivityRouter forgets a session after unregister (its events then drop)", () => {
  const router = new ActivityRouter();
  router.register("s1", "run-1");
  assert.ok(router.route({ sessionID: "s1", kind: "tool" }));
  router.unregister("s1");
  assert.equal(router.route({ sessionID: "s1", kind: "tool" }), null);
  assert.equal(router.drops["unknown-session"], 1);
});
