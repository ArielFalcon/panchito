import { test } from "node:test";
import assert from "node:assert/strict";
import { progressBar, stepState, verdictColor, verdictIcon, caseIcon, shortSha, deriveActivityView, formatElapsed } from "./format";
import { AgentActivity } from "../types";

const act = (kind: AgentActivity["kind"], text: string, status?: AgentActivity["status"], ts = "t"): AgentActivity =>
  ({ kind, text, ...(status ? { status } : {}), ts });

test("progressBar fills proportionally and clamps", () => {
  assert.equal(progressBar(0, 0).length, 20);
  assert.match(progressBar(0, 0), /^░{20}$/);
  assert.equal(progressBar(1, 1), "▓".repeat(20));
  const half = progressBar(2, 4);
  assert.equal(half.length, 20);
  assert.equal([...half].filter((c) => c === "▓").length, 10);
});

test("stepState marks earlier steps done, the current active, later pending", () => {
  assert.equal(stepState("validate", "classify"), "done");
  assert.equal(stepState("validate", "generate"), "done");
  assert.equal(stepState("validate", "validate"), "active");
  assert.equal(stepState("validate", "execute"), "pending");
});

test("stepState: done marks everything done; retry keeps execute active", () => {
  assert.equal(stepState("done", "classify"), "done");
  assert.equal(stepState("done", "execute"), "done");
  assert.equal(stepState("retry", "validate"), "done");
  assert.equal(stepState("retry", "execute"), "active");
});

test("verdictColor / verdictIcon map verdicts", () => {
  assert.equal(verdictColor("pass"), "#3b7a57");
  assert.equal(verdictColor("fail"), "#c0392b");
  assert.equal(verdictColor("infra-error"), "#4a6877");
  assert.equal(verdictColor(undefined), "cyan");
  assert.equal(verdictIcon("pass"), "✓");
  assert.equal(verdictIcon("fail"), "✗");
  assert.equal(verdictIcon("skipped"), "⊘");
});

test("caseIcon and shortSha", () => {
  assert.equal(caseIcon("fail"), "✗");
  assert.equal(caseIcon("pass"), "✓");
  assert.equal(shortSha("abcdef1234567890"), "abcdef1");
});

test("deriveActivityView dedups todos (latest status wins, order kept), files, and commands", () => {
  const v = deriveActivityView([
    act("todo", "map repo", "in_progress"),
    act("todo", "read suite", "pending"),
    act("file", "nav.spec.ts"),
    act("todo", "map repo", "completed"),       // same todo updated → completed
    act("file", "nav.spec.ts"),                 // duplicate file → collapsed
    act("file", "checkout.spec.ts"),
    act("command", "npm ci"),
    act("command", "npx playwright test --list"),
    act("todo", "read suite", "in_progress"),
  ]);
  assert.deepEqual(v.todos.map((t) => `${t.text}:${t.status}`), ["map repo:completed", "read suite:in_progress"]);
  assert.deepEqual(v.filesWritten, ["nav.spec.ts", "checkout.spec.ts"]);
  assert.equal(v.fileCount, 2);
  assert.deepEqual(v.commands, ["npm ci", "npx playwright test --list"]);
});

test("deriveActivityView focus = in-progress todo with progress + last file/command", () => {
  const v = deriveActivityView([
    act("todo", "a", "completed"),
    act("todo", "b", "in_progress"),
    act("file", "x.spec.ts"),
    act("command", "npx playwright test --list"),
  ]);
  assert.equal(v.focus?.title, "b");
  assert.equal(v.focus?.progress, "1/2");
  assert.equal(v.focus?.lastFile, "x.spec.ts");
  assert.equal(v.focus?.lastCommand, "npx playwright test --list");
});

test("deriveActivityView quiet state: focus falls back to the last action", () => {
  const v = deriveActivityView([act("file", "only.spec.ts")]);
  assert.equal(v.focus?.title, "only.spec.ts"); // no in-progress todo → last action stays visible
  assert.equal(v.lastText, "only.spec.ts");
});

test("deriveActivityView: empty activity → null focus, zero elapsed", () => {
  const v = deriveActivityView(undefined, {});
  assert.equal(v.focus, null);
  assert.equal(v.elapsedMs, 0);
  assert.equal(v.fileCount, 0);
});

test("deriveActivityView computes elapsed from stepStartedAt against injected now", () => {
  const v = deriveActivityView([act("file", "a.ts")], { stepStartedAt: "2026-06-08T00:00:00.000Z", now: Date.parse("2026-06-08T00:08:21.000Z") });
  assert.equal(v.elapsedMs, 8 * 60_000 + 21_000);
});

test("formatElapsed renders s / m s / h m", () => {
  assert.equal(formatElapsed(47_000), "47s");
  assert.equal(formatElapsed(8 * 60_000 + 21_000), "8m 21s");
  assert.equal(formatElapsed(2 * 3_600_000 + 5 * 60_000), "2h 5m");
});
