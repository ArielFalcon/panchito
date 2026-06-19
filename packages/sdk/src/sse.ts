// Live run events over SSE. Uses fetch (not EventSource) so the Authorization header and
// Last-Event-ID resume both work — mirroring panchito's Go client. Reconnects with capped
// backoff until the terminal run.verdict event or the caller aborts, resuming from the last
// seen seq so no event is dropped across a reconnect. A two-counter backstop (see the loop)
// gives up on a finished-but-unreplayable run or a persistent server error without ever
// abandoning a live feed that keeps producing events or heartbeats.
import type { RunEvent } from "./types";
import type { Transport } from "./transport";

export interface StreamOptions {
  signal?: AbortSignal;
  lastEventId?: number;
  // Internal seam: the inter-reconnect sleep. Defaults to the real backoff delay; tests inject a
  // no-op so the backstop's reconnect counting is exercised deterministically without real waits.
  // Production never sets this — it does NOT alter the backoff values, only how the wait is taken.
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export async function* streamRunEvents(
  t: Transport,
  runId: string,
  opts: StreamOptions = {},
): AsyncGenerator<RunEvent> {
  let lastId = opts.lastEventId;
  const BASE_BACKOFF = 500;
  let backoff = BASE_BACKOFF;
  const url = `${t.base}/api/v1/runs/${encodeURIComponent(runId)}/events`;

  // Two-counter termination backstop. The danger is twofold and pulls in opposite directions:
  // a FINISHED run whose terminal verdict is not replayable lets the server cleanly close with
  // zero bytes → without a cap we reconnect forever; but an ACTIVE long-running run can hit a
  // transient network blip or a string of heartbeat-only idle-timeout closes → a single naive
  // counter would give up on a live feed. So we separate the two failure shapes:
  //
  //   emptyCloses — incremented ONLY when a connection opened OK (HTTP ok + body) AND was read to
  //     completion (reader done) AND carried ZERO bytes this connection (no events, no heartbeat/
  //     comment frames). This is the finished-run-no-replay signature. Reset to 0 the moment a
  //     connection produces ANY data. Small cap: a few clean empty closes ⇒ the run is done, stop.
  //   errorRetries — incremented on a fetch throw OR a non-ok status (5xx etc.). Reset to 0 on any
  //     successful (HTTP ok) connection, so transient blips that recover never accumulate; only a
  //     PERSISTENT server error walks it up to the larger cap before giving up.
  //
  // Net effect: a live run that yields events OR heartbeats never terminates; a transient blip
  // survives; a finished run with no replayable terminal stops after a few empty closes; a
  // permanent error stops after the larger cap.
  const MAX_EMPTY_CLOSES = 3;
  const MAX_ERROR_RETRIES = 15;
  let emptyCloses = 0;
  let errorRetries = 0;
  const sleep = opts.sleep ?? delay;

  while (!opts.signal?.aborted) {
    let res: Response;
    try {
      const headers: Record<string, string> = { accept: "text/event-stream" };
      if (t.token) headers["authorization"] = `Bearer ${t.token}`;
      if (lastId !== undefined) headers["last-event-id"] = String(lastId);
      res = await t.fetchImpl(url, { headers, signal: opts.signal });
    } catch {
      if (++errorRetries >= MAX_ERROR_RETRIES) return;
      await sleep(backoff, opts.signal);
      backoff = Math.min(backoff * 2, 10_000); // a failed attempt is never productive — escalate
      continue;
    }

    if (res.status === 401 || res.status === 403 || res.status === 404) {
      throw new Error(`run event stream failed (HTTP ${res.status})`);
    }
    if (!res.ok || !res.body) {
      if (++errorRetries >= MAX_ERROR_RETRIES) return;
      await sleep(backoff, opts.signal);
      backoff = Math.min(backoff * 2, 10_000);
      continue;
    }

    errorRetries = 0; // HTTP ok — the server is reachable; clear the transient-error tally
    let dataThisConnection = false;
    const sawData = () => {
      if (dataThisConnection) return;
      dataThisConnection = true;
      emptyCloses = 0; // any byte (event OR heartbeat) means the connection was alive — reset
      backoff = BASE_BACKOFF; // and a productive connection resets the backoff
    };
    let readToCompletion = false;
    try {
      const parser = parseSse(res.body, opts.signal);
      for await (const frame of parser) {
        if (frame.kind === "data") {
          sawData(); // a comment/heartbeat frame: bytes arrived even though no event is yielded
          continue;
        }
        const block = frame.block;
        if (block.id !== undefined) lastId = block.id;
        let event: RunEvent;
        try {
          event = JSON.parse(block.data) as RunEvent;
        } catch {
          sawData(); // a (malformed) data frame still proves the connection produced bytes
          continue; // ignore malformed frames, keep the stream alive
        }
        sawData();
        yield event;
        if (event.body.type === "run.verdict") return; // terminal
      }
      readToCompletion = true; // the reader signalled done without throwing
    } catch {
      // stream broke mid-flight — fall through and reconnect from lastId (this is NOT an empty
      // close: the connection was interrupted, not cleanly drained to zero bytes).
    }
    // A clean close (read to completion) that produced zero bytes is the finished-run-no-replay
    // signature — count it. Any productive connection already reset emptyCloses above.
    if (readToCompletion && !dataThisConnection && ++emptyCloses >= MAX_EMPTY_CLOSES) return;
    if (!opts.signal?.aborted) await sleep(backoff, opts.signal);
  }
}

// A parsed SSE frame. `block` carries a real data block (one or more `data:` lines → an event to
// JSON-parse). `data` is the no-op signal that bytes arrived — a heartbeat/comment frame, or any
// non-empty chunk that did not parse into a data block — so the reconnect loop can tell a LIVE but
// idle connection (resets the empty-close counter) apart from a cleanly-drained zero-byte close.
type SseFrame = { kind: "block"; block: { id?: number; data: string } } | { kind: "data" };

async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true }).replace(/\r/g, "");
      if (chunk.length > 0) yield { kind: "data" }; // bytes arrived — the connection is alive
      buf += chunk;
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const block = parseBlock(buf.slice(0, sep));
        buf = buf.slice(sep + 2);
        if (block) yield { kind: "block", block };
      }
    }
  } finally {
    // cancel() (not releaseLock()) cancels the underlying body stream and settles any pending
    // read() — releaseLock() while a read() is in flight leaves the connection uncancelled and
    // rejects the orphaned read with ERR_INVALID_STATE as an unhandled rejection.
    try {
      await reader.cancel();
    } catch {
      /* already cancelled / released */
    }
  }
}

function parseBlock(raw: string): { id?: number; data: string } | null {
  let id: number | undefined;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith(":")) continue; // blank or heartbeat comment
    const ci = line.indexOf(":");
    const field = ci === -1 ? line : line.slice(0, ci);
    let val = ci === -1 ? "" : line.slice(ci + 1);
    if (val.startsWith(" ")) val = val.slice(1);
    if (field === "id") {
      const n = Number(val);
      if (!Number.isNaN(n)) id = n;
    } else if (field === "data") {
      data.push(val);
    }
  }
  return data.length > 0 ? { id, data: data.join("\n") } : null;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    // Remove the abort listener in BOTH races — the timer-wins path (the common case) as well as
    // the abort-wins path — so a long-lived stream doesn't accumulate listeners on the shared
    // AbortSignal (MaxListenersExceededWarning + retained closures).
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
