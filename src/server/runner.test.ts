import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JobQueue } from "./queue";
import { enqueueTrackedRun, cancelTrackedRun } from "./runner";
import { getRecord, createRecord, updateRecord } from "./history";
import { PipelineDeps } from "../pipeline";
import { AppConfig } from "../orchestrator/config-loader";
import { QaCase } from "../types";
import { createRunEventStore } from "./run-events";

const cfg = (name: string): AppConfig => ({
  name,
  repo: "org/demo",
  dev: { baseUrl: "https://dev" },
  qa: { needsReview: true, testDataPrefix: "qa-bot", shadow: true },
  report: { onFailure: "github-issue" },
});

function makeMirror(): string {
  const mirrorDir = mkdtempSync(join(tmpdir(), "qa-runner-"));
  mkdirSync(join(mirrorDir, "e2e", ".qa"), { recursive: true });
  writeFileSync(join(mirrorDir, "e2e", ".qa", "context.json"), JSON.stringify({ builtAtSha: "def5678", routes: [], api: [], feBe: [] }));
  return mirrorDir;
}

function stubDeps(over: Partial<PipelineDeps> = {}): PipelineDeps {
  const mirrorDir = makeMirror();
  return {
    waitForDeploy: async () => {},
    prepare: async () => ({ mirrorDir, diff: "", message: "feat: x" }),
    prepareAtBranch: async () => ({ mirrorDir }),
    generate: async (_input, _signal) => ({ output: "", specs: ["a.spec.ts"], reviewed: false, approved: true }),
    setupE2e: async () => {},
    validate: async () => ({ ok: true, errors: [], infra: false }),
    execute: async (_dir, opts) => {
      const cases: QaCase[] = [
        { name: "t1", status: "pass" },
        { name: "t2", status: "pass" },
      ];
      cases.forEach((c) => opts.onCase?.(c));
      return { sha: opts.namespace ?? "ns", verdict: "pass", passed: true, cases, logs: "" };
    },
    isHealthy: async () => true,
    isReachable: async () => true,
    publish: async () => null,
    publishContext: async () => null,
    setupCode: async () => {},
    executeCode: async (_dir, opts) => ({ sha: opts.namespace ?? "ns", verdict: "pass", passed: true, cases: [], logs: "" }),
    publishCode: async () => null,
    cleanup: async () => {},
    openIssue: async () => ({ url: "" }),
    log: () => {},
    ...over,
  };
}

test("the run does NOT execute synchronously — it is deferred to the queue (no bypass)", async () => {
  const queue = new JobQueue();
  const id = enqueueTrackedRun(
    queue,
    { app: "runner-skip", sha: "abc1234", target: "e2e", mode: "diff", source: "manual" },
    { pipeline: stubDeps({ prepare: async () => ({ mirrorDir: "/m", diff: "", message: "docs: tweak" }) }), loadApp: cfg },
  );
  // Right after enqueue, before draining: the job has not run yet.
  assert.equal(getRecord(id)?.status, "enqueued");
  await queue.drain();
  const r = getRecord(id)!;
  assert.equal(r.status, "done");
  assert.equal(r.verdict, "skipped"); // a docs commit classifies to skip
});

test("a green run finalizes the record with verdict + case counts", async () => {
  const queue = new JobQueue();
  const id = enqueueTrackedRun(
    queue,
    { app: "runner-pass", sha: "def5678", target: "e2e", mode: "diff", source: "webhook" },
    { pipeline: stubDeps(), loadApp: cfg },
  );
  await queue.drain();
  const r = getRecord(id)!;
  assert.equal(r.verdict, "pass");
  assert.equal(r.passed, 2);
  assert.equal(r.failed, 0);
  assert.equal(r.cases.length, 2); // onCase populated the record
});

test("a green run publishes live RunEvents for steps, tests and final verdict", async () => {
  const queue = new JobQueue();
  const runEvents = createRunEventStore({ now: () => 123 });
  const id = enqueueTrackedRun(
    queue,
    { app: "runner-events", sha: "def5678", target: "e2e", mode: "diff", source: "webhook" },
    {
      pipeline: stubDeps({
        execute: async (_dir, opts) => {
          opts.onRunning?.("checkout");
          const cases: QaCase[] = [{ name: "checkout", status: "pass" }];
          cases.forEach((c) => opts.onCase?.(c));
          return { sha: opts.namespace ?? "ns", verdict: "pass", passed: true, cases, logs: "" };
        },
      }),
      loadApp: cfg,
      runEvents,
    },
  );

  await queue.drain();

  const bodies = runEvents.replay(id).map((event) => event.body);
  assert.deepEqual(bodies[0], { type: "run.started", app: "runner-events", sha: "def5678", mode: "diff", target: "e2e" });
  assert.ok(bodies.some((body) => body.type === "step.changed" && body.step === "execute"));
  assert.ok(bodies.some((body) => body.type === "test.started" && body.name === "checkout"));
  assert.ok(bodies.some((body) => body.type === "test.passed" && body.name === "checkout"));
  const last = bodies.at(-1) as { type: string; verdict: string; passed: number; failed: number; outcome?: string };
  assert.equal(last.type, "run.verdict");
  assert.equal(last.verdict, "pass");
  assert.equal(last.passed, 1);
  assert.equal(last.failed, 0);
  // The verdict event carries what the run PRODUCED (here: a shadow run → no PR).
  assert.ok(typeof last.outcome === "string" && last.outcome.length > 0, "run.verdict must carry the outcome");
});

test("pipeline log lines are emitted as log.line events for the TUI's log tail", async () => {
  const queue = new JobQueue();
  const runEvents = createRunEventStore({ now: () => 789 });
  const id = enqueueTrackedRun(
    queue,
    { app: "runner-logs", sha: "log1234", target: "e2e", mode: "diff", source: "manual" },
    { pipeline: stubDeps(), loadApp: cfg, runEvents },
  );
  await queue.drain();
  const logs = runEvents.replay(id).map((e) => e.body).filter((b) => b.type === "log.line");
  assert.ok(logs.length > 0, "the pipeline's log() narration must reach the stream as log.line events");
  assert.ok(logs.every((b) => "text" in b && typeof b.text === "string" && b.text.length > 0 && !b.text.includes("\n")));
});

test("a crashing pipeline finalizes the record as infra-error with the message (no zombie)", async () => {
  const queue = new JobQueue();
  const id = enqueueTrackedRun(
    queue,
    { app: "runner-crash", sha: "999aaaa", target: "e2e", mode: "diff", source: "manual" },
    { pipeline: stubDeps({ prepare: async () => { throw new Error("boom"); } }), loadApp: cfg },
  );
  await queue.drain();
  const r = getRecord(id)!;
  assert.equal(r.status, "done");
  assert.equal(r.verdict, "infra-error");
  assert.match(r.note ?? "", /boom/);
});

test("a continuation forces generation (no skip) and records the parent run", async () => {
  const queue = new JobQueue();
  const id = enqueueTrackedRun(
    queue,
    {
      app: "runner-cont",
      sha: "ccc1234", target: "e2e",
      mode: "diff",
      source: "manual",
      parentRunId: "parent-1",
      fixCases: [{ name: "checkout", status: "fail" }],
    },
    // The commit message classifies as "docs" (would normally skip) — the continuation must still run.
    { pipeline: stubDeps({ prepare: async () => ({ mirrorDir: makeMirror(), diff: "", message: "docs: tweak" }) }), loadApp: cfg },
  );
  await queue.drain();
  const r = getRecord(id)!;
  assert.equal(r.parentRunId, "parent-1");
  assert.notEqual(r.verdict, "skipped"); // it generated + ran despite the docs commit
  assert.equal(r.verdict, "pass");
});

test("the coverage step event reaches the event store (was silently dropped before fix)", async () => {
  const queue = new JobQueue();
  const runEvents = createRunEventStore({ now: () => 456 });
  // Simulate a pipeline with collectCoverage wired — the orchestrator must emit
  // step.changed { step: "coverage" } instead of silently dropping it.
  const id = enqueueTrackedRun(
    queue,
    { app: "runner-cov", sha: "cov1234", target: "e2e", mode: "diff", source: "manual" },
    {
      pipeline: stubDeps({
        // A valid unified diff with +++ header → parseDiffHunks finds changed lines
        prepare: async () => ({ mirrorDir: makeMirror(), diff: "diff --git a/src/a.ts b/src/a.ts\nindex 0000000..1111111 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,4 @@\n+new line", message: "feat: add coverage" }),
        collectCoverage: async () => new Map(),
      }),
      loadApp: cfg,
      runEvents,
    },
  );
  await queue.drain();
  const bodies = runEvents.replay(id).map((event) => event.body);
  assert.ok(
    bodies.some((body) => body.type === "step.changed" && body.step === "coverage"),
    "step.changed { step: 'coverage' } must be present in the event stream",
  );
});

test("a bad app name is finalized (not a zombie) — loadApp throwing is caught", async () => {
  const queue = new JobQueue();
  const id = enqueueTrackedRun(
    queue,
    { app: "runner-noapp", sha: "111bbbb", target: "e2e", mode: "diff", source: "manual" },
    { pipeline: stubDeps(), loadApp: () => { throw new Error("config/apps/x.yaml not found"); } },
  );
  await queue.drain();
  const r = getRecord(id)!;
  assert.equal(r.status, "done");
  assert.equal(r.verdict, "infra-error");
});

// ── cancelTrackedRun ──────────────────────────────────────────────────────────
// The operator's stop control. Two close-together but distinct failures used to make a run
// "impossible to stop" from the dashboard: a stale "running" record the live queue no longer
// held would answer 409 and never clear. These pin the funnel's cancel behavior.

test("cancelTrackedRun aborts a LIVE run and finalizes its record (returns true)", async () => {
  const queue = new JobQueue();
  let aborted = false;
  const rec = createRecord({ app: "cancel-live", sha: "aaa1111", target: "e2e", mode: "diff" });
  updateRecord(rec.id, { status: "running" });
  // A job that blocks until its signal aborts — stands in for an in-flight agent turn.
  queue.enqueue(async (signal) => {
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
    });
  }, rec.id);
  await new Promise((r) => setImmediate(r)); // let the job claim the queue controller
  assert.equal(cancelTrackedRun(queue, rec.id), true);
  await queue.drain();
  assert.equal(aborted, true, "the live turn must be interrupted via the signal");
  assert.equal(getRecord(rec.id)?.status, "done");
});

test("cancelTrackedRun finalizes a STALE running record the queue no longer holds (the stuck-at-0% bug)", () => {
  const queue = new JobQueue(); // empty: nothing is actually executing
  const rec = createRecord({ app: "cancel-zombie", sha: "bbb2222", target: "e2e", mode: "diff" });
  updateRecord(rec.id, { status: "running" }); // a zombie left "running" by a restart/crash race
  // Not the live queue job, so nothing is aborted (false) — but the stuck record MUST be
  // finalized so the operator's stop actually clears it (the old path left it "running" → 409).
  assert.equal(cancelTrackedRun(queue, rec.id), false);
  const r = getRecord(rec.id)!;
  assert.equal(r.status, "done");
  assert.equal(r.verdict, "infra-error");
});

test("cancelTrackedRun dequeues an enqueued run so it never executes", () => {
  const queue = new JobQueue();
  const rec = createRecord({ app: "cancel-enq", sha: "ccc3333", target: "e2e", mode: "diff" });
  // status stays "enqueued" (createRecord default) — never started
  assert.equal(cancelTrackedRun(queue, rec.id), false);
  assert.equal(getRecord(rec.id)?.status, "done");
});

test("cancelTrackedRun is a no-op on an already-terminal record", () => {
  const queue = new JobQueue();
  const rec = createRecord({ app: "cancel-done", sha: "ddd4444", target: "e2e", mode: "diff" });
  updateRecord(rec.id, { status: "done", verdict: "pass" });
  assert.equal(cancelTrackedRun(queue, rec.id), false);
  assert.equal(getRecord(rec.id)?.verdict, "pass"); // untouched, not overwritten to infra-error
});

test("cancelTrackedRun returns false for an unknown run id", () => {
  assert.equal(cancelTrackedRun(new JobQueue(), "does-not-exist"), false);
});
