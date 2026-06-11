// Maps a Playwright stream lifecycle event (the NDJSON reporter feed parsed by
// execute.ts) to contract test.* RunEvents that drive the TUI's dedicated
// TestList — so a running test is a live row, not a log line. Pure and
// fixture-tested against the contract; needs no browser or engine.
//
// `begin` (suite total) and `skipped` tests carry no domain event. Flaky is NOT
// derivable from one attempt — the final report classifies it (parsePlaywrightReport)
// — so it is never emitted from the live stream.

import type { StreamEvent } from "./execute";
import { streamStatusToCase } from "./execute";
import type { RunEventBody } from "../contract/events";

export function streamEventToRunEvents(ev: StreamEvent): RunEventBody[] {
  switch (ev.phase) {
    case "testbegin":
      return [{ type: "test.started", name: ev.title }];
    case "testend": {
      const cs = streamStatusToCase(ev.status);
      if (cs === "pass") return [{ type: "test.passed", name: ev.title, durationMs: ev.durationMs ?? 0 }];
      if (cs === "fail") {
        return ev.durationMs !== undefined
          ? [{ type: "test.failed", name: ev.title, durationMs: ev.durationMs }]
          : [{ type: "test.failed", name: ev.title }];
      }
      return []; // skipped (cs === null)
    }
    default:
      return []; // begin
  }
}
