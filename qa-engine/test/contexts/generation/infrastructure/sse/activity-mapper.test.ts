// qa-engine/test/contexts/generation/infrastructure/sse/activity-mapper.test.ts
// Moved from src/integrations/activity-mapper.test.ts (migration-tier-4c Slice 3, D-4c-2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapOpencodeEvent, eventRunId, type RawOpencodeEvent } from "@contexts/generation/infrastructure/sse/activity-mapper.ts";
import { RunEventBodySchema } from "@kernel/contract/events.ts";

const SESSIONS = new Map<string, string>([["sess_1", "run_1"]]);

// Every body the mapper emits MUST be a valid contract event — this ties the
// integration adapter to the source of truth so it can never drift.
function mapValid(event: RawOpencodeEvent): unknown[] {
  const out = mapOpencodeEvent(event, SESSIONS);
  for (const body of out) RunEventBodySchema.parse(body);
  return out;
}

// Helper to build a message.part.updated tool event.
const toolEvent = (state: Record<string, unknown>, extra: Record<string, unknown> = {}): RawOpencodeEvent => ({
  type: "message.part.updated",
  properties: { part: { type: "tool", sessionID: "sess_1", state, ...extra } },
});

test("a running read tool → analyzing, using ToolState.title, keyed by callID", () => {
  const out = mapValid(toolEvent({ status: "running", title: "Reading Header.astro", input: { filePath: "src/Header.astro" } }, { tool: "read", callID: "call_1" }));
  assert.deepEqual(out, [{ type: "agent.activity", kind: "analyzing", target: "Reading Header.astro", status: "running", callId: "call_1" }]);
});

test("missing title falls back to the input file basename", () => {
  const out = mapValid(toolEvent({ status: "running", input: { filePath: "src/components/Nav.astro" } }, { tool: "grep" }));
  assert.deepEqual(out, [{ type: "agent.activity", kind: "analyzing", target: "Nav.astro", status: "running" }]);
});

test("a fan-out worker's tool activity is tagged with its workerId", () => {
  const workers = new Map<string, string>([["sess_1", "checkout"]]);
  const out = mapOpencodeEvent(toolEvent({ status: "running", title: "Reading Header.astro" }, { tool: "read", callID: "c1" }), SESSIONS, workers);
  assert.deepEqual(out, [{ type: "agent.activity", kind: "analyzing", target: "Reading Header.astro", status: "running", callId: "c1", workerId: "checkout" }]);
  RunEventBodySchema.parse(out[0]); // still a valid contract event
});

test("a completed write to a spec file emits writing + spec.written", () => {
  const out = mapValid(toolEvent({ status: "completed", title: "Wrote login.spec.ts", input: { filePath: "e2e/login.spec.ts" } }, { tool: "write" }));
  assert.deepEqual(out, [
    { type: "agent.activity", kind: "writing", target: "Wrote login.spec.ts", status: "completed" },
    { type: "spec.written", file: "login.spec.ts" },
  ]);
});

test("bash → command, task → subagent", () => {
  assert.deepEqual(
    mapValid(toolEvent({ status: "completed", input: { command: "npm ci" } }, { tool: "bash" })),
    [{ type: "agent.activity", kind: "command", target: "npm ci", status: "completed" }],
  );
  assert.deepEqual(
    mapValid(toolEvent({ status: "running", input: { description: "review auth flow" } }, { tool: "task" })),
    [{ type: "agent.activity", kind: "subagent", target: "review auth flow", status: "running" }],
  );
});

test("a tool error → agent.error", () => {
  assert.deepEqual(
    mapValid(toolEvent({ status: "error", output: "ENOENT: missing file" }, { tool: "read" })),
    [{ type: "agent.error", detail: "ENOENT: missing file" }],
  );
});

test("pending tools and prose parts are dropped", () => {
  assert.deepEqual(mapValid(toolEvent({ status: "pending" }, { tool: "read" })), []);
  assert.deepEqual(mapValid({ type: "message.part.updated", properties: { part: { type: "text", sessionID: "sess_1", text: "ok, let me check the..." } } }), []);
  assert.deepEqual(mapValid({ type: "message.part.updated", properties: { part: { type: "reasoning", sessionID: "sess_1" } } }), []);
});

test("todo.updated → plan.updated with normalized statuses (empty content dropped)", () => {
  const out = mapValid({
    type: "todo.updated",
    properties: { sessionID: "sess_1", todos: [
      { content: "Analyze blast radius", status: "in_progress" },
      { content: "Write nav spec", status: "pending" },
      { content: "", status: "completed" },
    ] },
  });
  assert.deepEqual(out, [{ type: "plan.updated", todos: [
    { content: "Analyze blast radius", status: "in_progress" },
    { content: "Write nav spec", status: "pending" },
  ] }]);
});

test("command.executed → command activity; session.error → agent.error", () => {
  assert.deepEqual(
    mapValid({ type: "command.executed", properties: { sessionID: "sess_1", name: "format", arguments: "--all" } }),
    [{ type: "agent.activity", kind: "command", target: "format --all", status: "completed" }],
  );
  assert.deepEqual(
    mapValid({ type: "session.error", properties: { sessionID: "sess_1", error: "rate limited" } }),
    [{ type: "agent.error", detail: "rate limited" }],
  );
});

test("events for an unknown session are dropped (demux safety)", () => {
  assert.deepEqual(mapOpencodeEvent(toolEvent({ status: "completed" }, { tool: "read", sessionID: "sess_OTHER" }), SESSIONS), []);
  assert.deepEqual(mapOpencodeEvent({ type: "todo.updated", properties: { sessionID: "ghost", todos: [{ content: "x", status: "pending" }] } }, SESSIONS), []);
});

test("an event with no resolvable session is dropped", () => {
  assert.deepEqual(mapOpencodeEvent({ type: "file.edited", properties: { file: "a.ts" } }, SESSIONS), []);
});

test("eventRunId resolves the run from a top-level or part-level sessionID", () => {
  assert.equal(eventRunId({ type: "todo.updated", properties: { sessionID: "sess_1" } }, SESSIONS), "run_1");
  assert.equal(eventRunId(toolEvent({ status: "completed" }, { tool: "read" }), SESSIONS), "run_1");
  assert.equal(eventRunId({ type: "todo.updated", properties: { sessionID: "ghost" } }, SESSIONS), undefined);
  assert.equal(eventRunId({ type: "file.edited", properties: { file: "a.ts" } }, SESSIONS), undefined);
});
