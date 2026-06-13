import { test } from "node:test";
import assert from "node:assert/strict";
import { RUN_MODES } from "../types";
import {
  RunEventSchema,
  RunEventBodySchema,
  RunModeSchema,
  RunStepSchema,
  RunVerdictSchema,
  TestTargetSchema,
} from "./events";

test("a valid envelope with a test.passed body parses", () => {
  const ev = RunEventSchema.parse({
    seq: 7,
    runId: "run_abc",
    ts: 1_700_000_000_000,
    body: { type: "test.passed", name: "login flow", durationMs: 1234 },
  });
  assert.equal(ev.seq, 7);
  assert.equal(ev.body.type, "test.passed");
});

test("the discriminated union narrows by `type`", () => {
  const body = RunEventBodySchema.parse({ type: "run.verdict", verdict: "pass", passed: 4, failed: 0 });
  // After parse, `type` narrows the union — the verdict field is only reachable here.
  if (body.type === "run.verdict") {
    assert.equal(body.verdict, "pass");
    assert.equal(body.passed, 4);
  } else {
    assert.fail("expected run.verdict");
  }
});

test("an unknown event type is rejected", () => {
  assert.throws(() => RunEventBodySchema.parse({ type: "totally.made.up", x: 1 }));
});

test("a body missing a required field is rejected", () => {
  // test.passed requires durationMs.
  assert.throws(() => RunEventBodySchema.parse({ type: "test.passed", name: "x" }));
});

test("agent.activity carries only structured fields (no prose passthrough)", () => {
  const body = RunEventBodySchema.parse({
    type: "agent.activity",
    kind: "analyzing",
    target: "Header.astro",
    status: "running",
    callId: "call_1",
  });
  assert.equal(body.type === "agent.activity" && body.kind, "analyzing");
});

test("enums stay in lockstep with src/types.ts (drift guard during migration)", () => {
  assert.deepEqual([...RunModeSchema.options], [...RUN_MODES]);
  assert.deepEqual([...RunVerdictSchema.options], ["pass", "fail", "flaky", "invalid", "infra-error", "skipped"]);
  assert.deepEqual([...TestTargetSchema.options], ["e2e", "code"]);
});

test("RunStepSchema accepts 'coverage' — needed by the coverage phase stepper", () => {
  // The pipeline emits onStep?.("coverage") but the step was missing from the
  // schema allowlist, so step.changed events for coverage were silently dropped.
  assert.doesNotThrow(() => RunStepSchema.parse("coverage"));
  // Also verify all known steps from the pipeline are accepted.
  const steps = ["gate", "classify", "setup", "generate", "validate", "health", "execute", "retry", "coverage", "decide", "done"];
  for (const s of steps) {
    assert.doesNotThrow(() => RunStepSchema.parse(s), `RunStepSchema must accept "${s}"`);
  }
});
