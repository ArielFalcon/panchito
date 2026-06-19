import { test } from "node:test";
import assert from "node:assert/strict";
import { reexploreToolKind, reexploreKindFromEvent, ReexploreTracker } from "./reexplore";

// RE-2 — objective telemetry: count the agent's re-exploration tool calls (browser_navigate /
// browser_snapshot / serena blast-radius) per cycle so we can prove RE-1 worked and detect when the
// agent re-explores despite injected grounding. Observability only — NOT a quality/ledger signal.

test("RE-2 classifier: browser navigation/snapshot and serena map to their kinds", () => {
  assert.equal(reexploreToolKind("browser_navigate"), "navigate");
  assert.equal(reexploreToolKind("browser_snapshot"), "snapshot");
  assert.equal(reexploreToolKind("activate_project"), "serena");
  assert.equal(reexploreToolKind("find_referencing_symbols"), "serena");
  assert.equal(reexploreToolKind("get_symbols_overview"), "serena");
  assert.equal(reexploreToolKind("find_symbol"), "serena");
});

test("RE-2 classifier: tool names are matched even when the MCP prefixes them", () => {
  assert.equal(reexploreToolKind("playwright_browser_navigate"), "navigate");
  assert.equal(reexploreToolKind("mcp__playwright__browser_snapshot"), "snapshot");
});

test("RE-2 classifier: writing/reading/interaction tools are NOT re-exploration", () => {
  for (const t of ["edit", "write", "bash", "read", "grep", "glob", "browser_click", "browser_type"]) {
    assert.equal(reexploreToolKind(t), null, `${t} must not count as re-exploration`);
  }
});

test("RE-2 event extractor: a COMPLETED browser_navigate tool part yields navigate", () => {
  const raw = {
    type: "message.part.updated",
    properties: { part: { type: "tool", tool: "browser_navigate", sessionID: "s1", state: { status: "completed" } } },
  };
  assert.equal(reexploreKindFromEvent(raw), "navigate");
});

test("RE-2 event extractor: a RUNNING tool part is NOT counted (avoid double-count)", () => {
  const raw = {
    type: "message.part.updated",
    properties: { part: { type: "tool", tool: "browser_navigate", sessionID: "s1", state: { status: "running" } } },
  };
  assert.equal(reexploreKindFromEvent(raw), null);
});

test("RE-2 event extractor: a non-tool part (prose) is ignored", () => {
  const raw = { type: "message.part.updated", properties: { part: { type: "text", sessionID: "s1" } } };
  assert.equal(reexploreKindFromEvent(raw), null);
});

test("RE-2 tracker: records per session and snapshots totals", () => {
  const t = new ReexploreTracker();
  t.record("s1", "navigate");
  t.record("s1", "navigate");
  t.record("s1", "snapshot");
  t.record("s2", "serena");
  assert.deepEqual(t.snapshot("s1"), { navigate: 2, snapshot: 1, serena: 0, total: 3 });
  assert.deepEqual(t.snapshot("s2"), { navigate: 0, snapshot: 0, serena: 1, total: 1 });
  // Unknown session is all-zero.
  assert.deepEqual(t.snapshot("nope"), { navigate: 0, snapshot: 0, serena: 0, total: 0 });
});

test("RE-2 tracker: clear resets a session's counts", () => {
  const t = new ReexploreTracker();
  t.record("s1", "navigate");
  t.clear("s1");
  assert.deepEqual(t.snapshot("s1"), { navigate: 0, snapshot: 0, serena: 0, total: 0 });
});
