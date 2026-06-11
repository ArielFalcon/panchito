import { test } from "node:test";
import assert from "node:assert/strict";
import { streamEventToRunEvents } from "./test-events";
import type { StreamEvent } from "./execute";
import { RunEventBodySchema } from "../contract/events";

// Every emitted body must be a valid contract event (ties this producer to the
// source of truth).
function mapValid(ev: StreamEvent): unknown[] {
  const out = streamEventToRunEvents(ev);
  for (const b of out) RunEventBodySchema.parse(b);
  return out;
}

test("testbegin → test.started", () => {
  assert.deepEqual(mapValid({ phase: "testbegin", title: "home › hero" }), [{ type: "test.started", name: "home › hero" }]);
});

test("a passed test → test.passed with its duration", () => {
  assert.deepEqual(
    mapValid({ phase: "testend", title: "home › hero", status: "passed", durationMs: 1200 }),
    [{ type: "test.passed", name: "home › hero", durationMs: 1200 }],
  );
});

test("a passed test with no duration falls back to 0 (durationMs is required on test.passed)", () => {
  assert.deepEqual(
    mapValid({ phase: "testend", title: "x", status: "expected" }),
    [{ type: "test.passed", name: "x", durationMs: 0 }],
  );
});

test("a failed test → test.failed (duration optional, fail-closed on non-green status)", () => {
  assert.deepEqual(
    mapValid({ phase: "testend", title: "cart › total", status: "failed", durationMs: 800 }),
    [{ type: "test.failed", name: "cart › total", durationMs: 800 }],
  );
  assert.deepEqual(
    mapValid({ phase: "testend", title: "cart › total", status: "timedOut" }),
    [{ type: "test.failed", name: "cart › total" }],
  );
});

test("skipped tests and the suite begin produce no domain event", () => {
  assert.deepEqual(mapValid({ phase: "testend", title: "skip › me", status: "skipped" }), []);
  assert.deepEqual(mapValid({ phase: "begin", total: 3 }), []);
});
