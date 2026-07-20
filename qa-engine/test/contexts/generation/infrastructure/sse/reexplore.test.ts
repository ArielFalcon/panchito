// qa-engine/test/contexts/generation/infrastructure/sse/reexplore.test.ts
// Moved from src/integrations/reexplore.test.ts (migration-tier-4c Slice 3, D-4c-2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { reexploreToolKind, reexploreKindFromEvent, ReexploreTracker } from "@contexts/generation/infrastructure/sse/reexplore.ts";

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

// ── Judgment-day fixes (RE-2 correctness) ─────────────────────────────────────

// JD-S-B4: a tool part re-streams many "completed" updates (agent-activity.ts dedups for this very
// reason). The RAW tap sits BEFORE that dedup, so counts must be deduped by callID or they inflate.
test("JD-S-B4 tracker: the same tool call (callID) is counted ONCE across re-emitted updates", () => {
  const t = new ReexploreTracker();
  t.record("s1", "navigate", "call-1");
  t.record("s1", "navigate", "call-1"); // re-emitted completed update for the SAME call
  t.record("s1", "navigate", "call-2");
  assert.deepEqual(t.snapshot("s1"), { navigate: 2, snapshot: 0, serena: 0, total: 2 });
});

test("JD-S-B4 tracker: callID dedup is scoped per session", () => {
  const t = new ReexploreTracker();
  t.record("s1", "serena", "call-1");
  t.record("s2", "serena", "call-1"); // same callID, different session → distinct
  assert.equal(t.snapshot("s1").serena, 1);
  assert.equal(t.snapshot("s2").serena, 1);
});

// JD-C5: a browser_navigate that FAILS ends in the terminal "error" state, not "completed". It still
// happened (still burned time), so it must be counted — otherwise RE-2 under-reports the exact
// (often uncovered) routes of interest.
test("JD-C5 event extractor: an ERROR-terminal tool part is counted", () => {
  const raw = {
    type: "message.part.updated",
    properties: { part: { type: "tool", tool: "browser_navigate", sessionID: "s1", state: { status: "error" } } },
  };
  assert.equal(reexploreKindFromEvent(raw), "navigate");
});

// JD-C6: regen-discipline forbids "re-skim the repository / re-read unchanged code", but serena's read
// surface is more than the 4 symbol tools — read_file/search_for_pattern/find_file/list_dir are also
// repo re-exploration and must count, or RE-2 under-measures what RE-1 targets.
test("JD-C6 classifier: serena read/search tools also count as re-exploration", () => {
  for (const tool of ["read_file", "search_for_pattern", "find_file", "list_dir"]) {
    assert.equal(reexploreToolKind(tool), "serena", `${tool} must count as serena re-exploration`);
  }
});

// JD-R2: browser_navigate_back is a HISTORY interaction (going back), not orientation re-exploration.
// The unanchored /browser_navigate/ matcher wrongly counted it, polluting the navigate signal.
test("JD-R2 classifier: browser_navigate_back is interaction, NOT navigation re-exploration", () => {
  assert.equal(reexploreToolKind("browser_navigate_back"), null);
  assert.equal(reexploreToolKind("browser_navigate"), "navigate"); // the real navigate still matches
  assert.equal(reexploreToolKind("mcp__playwright__browser_navigate"), "navigate"); // and MCP-prefixed
});
