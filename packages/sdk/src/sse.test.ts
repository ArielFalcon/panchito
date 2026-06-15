import { test } from "node:test";
import assert from "node:assert/strict";
import { streamRunEvents } from "./sse";
import type { Transport } from "./transport";
import type { RunEvent } from "./types";

// --- fixtures ---------------------------------------------------------------

const enc = new TextEncoder();

// One SSE frame on the wire, mirroring the server's gateway (api.ts handleRunEvents):
//   id: <seq>\nevent: <type>\ndata: <json>\n\n
function frame(event: RunEvent): string {
  return `id: ${event.seq}\nevent: ${event.body.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function heartbeat(): string {
  return `: heartbeat\n\n`; // a comment frame — bytes on the wire, no event
}

function ev(seq: number, body: RunEvent["body"]): RunEvent {
  return { seq, runId: "r1", ts: seq, body };
}

// A ReadableStream that emits the given chunks (each a string) then closes — the cleanly-drained
// "reader done" path the backstop keys off.
function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

// A live stream the request abort errors from the producer side — mirroring how undici surfaces a
// fetch abort as an error on the in-flight body, so the consumer's pending read() REJECTS. `signal`
// is the request's AbortSignal; aborting it errors the stream controller.
function abortableLiveStream(signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      signal.addEventListener("abort", () => c.error(new Error("aborted")), { once: true });
    },
  });
}

// A per-reconnect response spec. `throws` simulates a fetch/transport throw; otherwise a status +
// a FRESH body. A ReadableStream is single-use, so each reconnect must build a new one — hence each
// step is a factory invoked per call, not a shared instance.
type Step = { throws: true } | { status?: number; body: () => ReadableStream<Uint8Array> | null };

// Build a Transport whose fetchImpl returns successive responses from `steps`. Each call advances
// to the next step; once exhausted it repeats the last one (so "repeatedly closes empty" works).
// The injected fetch mirrors real fetch's abort semantics enough for these tests: an already-aborted
// request throws (the abort tests error the body from the producer side via abortableLiveStream).
function transportWith(steps: Step[]): { t: Transport; calls: () => number } {
  let i = 0;
  const fetchImpl = (async (_url: string, init?: { signal?: AbortSignal }) => {
    const idx = Math.min(i, steps.length - 1);
    i++;
    const spec = steps[idx]!;
    if ("throws" in spec) throw new Error("transport error");
    if (init?.signal?.aborted) throw new Error("aborted");
    const { status = 200, body } = spec;
    return new Response(body(), { status });
  }) as unknown as typeof fetch;
  return {
    t: { base: "http://x", token: undefined, fetchImpl, request: async () => undefined as never },
    calls: () => i,
  };
}

async function collect(gen: AsyncGenerator<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

// A no-op sleep injected into streamRunEvents so the reconnect backstop's counting is exercised
// deterministically without real backoff waits. It does NOT change production backoff values.
const noWait = async (): Promise<void> => {};

// --- tests ------------------------------------------------------------------

test("yields events then ends on the terminal run.verdict", async () => {
  const { t } = transportWith([
    {
      body: () =>
        streamOf(
          frame(ev(1, { type: "run.started", app: "a", sha: "s", mode: "diff", target: "e2e" })),
          frame(ev(2, { type: "run.verdict", verdict: "pass" })),
          // anything after the terminal must never be yielded — the generator returns at verdict.
          frame(ev(3, { type: "log.line", level: "info", text: "after" })),
        ),
    },
  ]);
  const events = await collect(streamRunEvents(t, "r1"));
  assert.equal(events.length, 2);
  assert.equal(events[0]?.body.type, "run.started");
  assert.equal(events[1]?.body.type, "run.verdict");
});

test("a finished run that cleanly closes empty terminates after the empty-close cap (no infinite loop)", async () => {
  // Every connection opens OK and the reader drains to `done` with zero bytes — the finished-run-
  // no-replay signature. The cap (3) must stop the generator instead of reconnecting forever.
  const { t, calls } = transportWith([{ body: () => streamOf() }]); // a fresh empty, clean close each reconnect
  const events = await collect(streamRunEvents(t, "r1", { sleep: noWait }));
  assert.equal(events.length, 0);
  // 3 empty closes ⇒ give up; it must stop at the small cap rather than spinning unbounded.
  assert.equal(calls(), 3, "the empty-close cap (3) must stop the generator");
});

test("heartbeat-only connections keep the empty-close counter reset (a quiet live run never gives up early)", async () => {
  // First three connections carry ONLY a heartbeat comment then close — bytes arrived, so they are
  // NOT empty closes; the counter must stay at 0. The fourth carries the terminal verdict.
  const { t } = transportWith([
    { body: () => streamOf(heartbeat()) },
    { body: () => streamOf(heartbeat()) },
    { body: () => streamOf(heartbeat()) },
    { body: () => streamOf(frame(ev(1, { type: "run.verdict", verdict: "pass" }))) },
  ]);
  const events = await collect(streamRunEvents(t, "r1", { sleep: noWait }));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.body.type, "run.verdict");
});

test("a persistent server error gives up only after the larger error cap", async () => {
  const { t, calls } = transportWith([{ status: 503, body: () => null }]); // always 5xx
  const events = await collect(streamRunEvents(t, "r1", { sleep: noWait }));
  assert.equal(events.length, 0);
  // It must NOT stop at the small empty-close cap (3) — a persistent error rides the larger cap (15).
  assert.equal(calls(), 15, "a persistent 5xx must ride the error cap, not the empty-close cap");
});

test("a transient blip recovers and does not count toward the error cap", async () => {
  // A throw, then a 5xx, then a healthy connection carrying the terminal verdict. The recovery must
  // reset errorRetries so the two early blips never accumulate — the run completes normally.
  const { t } = transportWith([
    { throws: true },
    { status: 502, body: () => null },
    { body: () => streamOf(frame(ev(1, { type: "run.verdict", verdict: "pass" }))) },
  ]);
  const events = await collect(streamRunEvents(t, "r1", { sleep: noWait }));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.body.type, "run.verdict");
});

test("throws immediately on 401/403/404 (no retry)", async () => {
  for (const status of [401, 403, 404]) {
    const { t, calls } = transportWith([{ status, body: () => null }]);
    await assert.rejects(collect(streamRunEvents(t, "r1")), /HTTP/);
    assert.equal(calls(), 1, "must throw on the first attempt without retrying");
  }
});

test("an AbortSignal ends the generator promptly", async () => {
  const ac = new AbortController();
  // The body stays live until the request aborts, then errors from the producer side (as undici
  // does). The generator's pending read() rejects → it unwinds and the outer while sees aborted,
  // so the generator resolves with no events instead of hanging on the live stream.
  const { t } = transportWith([{ body: () => abortableLiveStream(ac.signal) }]);
  const gen = streamRunEvents(t, "r1", { signal: ac.signal, sleep: noWait });
  const done = collect(gen);
  await new Promise((r) => setTimeout(r, 5)); // let the first read() block on the live stream
  ac.abort();
  // The generator must resolve promptly after the abort; race it against a watchdog so a hang fails.
  const watchdog = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 500));
  const result = await Promise.race([done.then(() => "done" as const), watchdog]);
  assert.equal(result, "done", "the generator must end promptly on abort, not hang");
  assert.equal((await done).length, 0);
});

test("early break by the consumer does not throw an unhandled rejection", async () => {
  let cancelled = false;
  const { t } = transportWith([
    {
      body: () =>
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(frame(ev(1, { type: "run.started", app: "a", sha: "s", mode: "diff", target: "e2e" }))));
            // leave the stream open so break happens with a read() in flight.
          },
          cancel() {
            cancelled = true;
          },
        }),
    },
  ]);
  const gen = streamRunEvents(t, "r1");
  for await (const e of gen) {
    assert.equal(e.body.type, "run.started");
    break; // consumer bails after the first event
  }
  // Give any orphaned read()/rejection a tick to surface — an unhandled rejection would fail the run.
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(cancelled, "breaking should cancel the body stream via the generator's return()");
});
