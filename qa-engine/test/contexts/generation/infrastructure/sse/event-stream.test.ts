// qa-engine/test/contexts/generation/infrastructure/sse/event-stream.test.ts
// Moved from src/integrations/opencode-client.test.ts (migration-tier-4c Slice 3, D-4c-2) — these
// characterization tests exercise the SSE lifecycle POLICY (reconnect-with-backoff,
// refcounted per-directory subscription lifecycle) that now lives in event-stream.ts, decoupled
// from the SDK (openStream is injected in every test — none rely on the real raw opener).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startEventStreamWithReconnect,
  EventStreamManager,
} from "@contexts/generation/infrastructure/sse/event-stream.ts";

test("startEventStreamWithReconnect retries after a stream error until aborted", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const delays: number[] = [];
  const logs: string[] = [];

  await startEventStreamWithReconnect(
    () => {},
    controller.signal,
    {
      initialDelayMs: 10,
      maxDelayMs: 20,
      log: (msg) => logs.push(msg),
      sleep: async (ms) => { delays.push(ms); },
      start: async () => {
        attempts++;
        if (attempts === 1) throw new Error("opencode down");
        controller.abort();
      },
    },
  );

  assert.equal(attempts, 2);
  assert.deepEqual(delays, [10]);
  assert.match(logs.join("\n"), /opencode down/);
});

test("startEventStreamWithReconnect reconnects after a clean stream close", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const delays: number[] = [];

  await startEventStreamWithReconnect(
    () => {},
    controller.signal,
    {
      initialDelayMs: 5,
      sleep: async (ms) => { delays.push(ms); },
      start: async () => {
        attempts++;
        if (attempts === 2) controller.abort();
      },
    },
  );

  assert.equal(attempts, 2);
  assert.deepEqual(delays, [5]);
});

// v2 has no global firehose, so the orchestrator opens ONE scoped event.subscribe
// per run directory. The manager refcounts them (parallelDiff sessions share a dir)
// and closes a stream when its last session unregisters. openStream is injected so
// the demux/lifecycle is unit-tested without the SDK.
test("EventStreamManager opens one scoped stream per directory (refcounted) and closes on last detach", () => {
  const opened: Array<{ dir: string; signal: AbortSignal }> = [];
  const mgr = new EventStreamManager((dir, _onActivity, signal) => { opened.push({ dir, signal }); });
  mgr.setSink(() => {}, new AbortController().signal);

  mgr.attach("s1", "/m/a");
  mgr.attach("s2", "/m/a"); // same dir → shares the stream (refcount), no second open
  mgr.attach("s3", "/m/b");

  assert.deepEqual(opened.map((o) => o.dir).sort(), ["/m/a", "/m/b"]);
  assert.equal(opened.length, 2);

  const a = opened.find((o) => o.dir === "/m/a")!;
  mgr.detach("s1"); // /m/a refs 2→1, still open
  assert.equal(a.signal.aborted, false);
  mgr.detach("s2"); // /m/a refs 1→0, closed
  assert.equal(a.signal.aborted, true);
  assert.equal(opened.find((o) => o.dir === "/m/b")!.signal.aborted, false); // /m/b untouched
});

test("EventStreamManager defers opening a stream until the sink is set", () => {
  const opened: string[] = [];
  const mgr = new EventStreamManager((dir) => { opened.push(dir); });
  mgr.attach("s1", "/m/a"); // no sink yet → nothing opens
  assert.deepEqual(opened, []);
  mgr.setSink(() => {}, new AbortController().signal);
  assert.deepEqual(opened, ["/m/a"]); // opened once the sink arrives
});

test("EventStreamManager closes every directory stream on shutdown and ignores later attaches", () => {
  const opened: Array<{ dir: string; signal: AbortSignal }> = [];
  const shutdown = new AbortController();
  const mgr = new EventStreamManager((dir, _oa, signal) => { opened.push({ dir, signal }); });
  mgr.setSink(() => {}, shutdown.signal);
  mgr.attach("s1", "/m/a");
  mgr.attach("s2", "/m/b");

  shutdown.abort();
  assert.ok(opened.every((o) => o.signal.aborted), "all directory streams aborted on shutdown");
  mgr.attach("s3", "/m/c"); // after shutdown → no-op
  assert.equal(opened.length, 2);
});
