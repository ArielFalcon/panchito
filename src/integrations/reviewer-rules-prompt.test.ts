import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewIndependently, type AgentDeps } from "./opencode-client";

// The independent reviewer is the authoritative publish gate. Arming it with the PROVEN learned
// rules (passed as a pre-rendered block by the orchestrator) lets the judge enforce app-specific
// anti-patterns earned from past failures — without leaking the generator's reasoning.

function captureStub(captured: { prompt?: string }): AgentDeps {
  return {
    open: async () => ({
      id: "rev",
      prompt: async (text: string) => {
        captured.prompt = text;
        return '{"approved":true,"corrections":[],"rationale":"ok"}';
      },
      dispose: async () => {},
    }),
  };
}

test("reviewIndependently injects the learned-rules block into the judge's prompt when provided", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-review-rules-"));
  mkdirSync(join(dir, "e2e"), { recursive: true });
  writeFileSync(join(dir, "e2e", "x.spec.ts"), "test('x', async () => {});");
  const captured: { prompt?: string } = {};
  try {
    await reviewIndependently(
      {
        diff: "d",
        specs: ["x.spec.ts"],
        mirrorDir: dir,
        e2eRelDir: "e2e",
        appName: "a",
        mode: "diff",
        learnedRules: "## App-specific reject-on-sight rules\n- Applies when X → do Y (E-FRAGILE-SELECTOR)",
      },
      captureStub(captured),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const p = captured.prompt ?? "";
  assert.match(p, /App-specific reject-on-sight rules/, "the rules block is present");
  assert.match(p, /do Y/, "the rule body reaches the judge");
  assert.match(p, /reject/i, "an instruction tells the judge to reject on violation");
});

test("reviewIndependently omits the learned-rules section when none are provided", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-review-norules-"));
  mkdirSync(join(dir, "e2e"), { recursive: true });
  writeFileSync(join(dir, "e2e", "x.spec.ts"), "test('x', async () => {});");
  const captured: { prompt?: string } = {};
  try {
    await reviewIndependently(
      { diff: "d", specs: ["x.spec.ts"], mirrorDir: dir, e2eRelDir: "e2e", appName: "a", mode: "diff" },
      captureStub(captured),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.doesNotMatch(captured.prompt ?? "", /reject-on-sight rules/, "no empty section when there are no rules");
});
