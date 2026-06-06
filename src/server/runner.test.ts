import { test } from "node:test";
import assert from "node:assert/strict";
import { JobQueue } from "./queue";
import { enqueueTrackedRun } from "./runner";
import { getRecord } from "./history";
import { PipelineDeps } from "../pipeline";
import { AppConfig } from "../orchestrator/config-loader";
import { QaCase } from "../types";

const cfg = (name: string): AppConfig => ({
  name,
  repo: "org/demo",
  dev: { baseUrl: "https://dev" },
  qa: { needsReview: true, testDataPrefix: "qa-bot", shadow: true },
  report: { onFailure: "github-issue" },
});

function stubDeps(over: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    waitForDeploy: async () => {},
    prepare: async () => ({ mirrorDir: "/m", diff: "", message: "feat: x" }),
    generate: async (_input, _signal) => ({ output: "", specs: ["a.spec.ts"], reviewed: false, approved: true }),
    setupE2e: async () => {},
    validate: async () => ({ ok: true, errors: [] }),
    execute: async (_dir, opts) => {
      const cases: QaCase[] = [
        { name: "t1", status: "pass" },
        { name: "t2", status: "pass" },
      ];
      cases.forEach((c) => opts.onCase?.(c));
      return { sha: opts.namespace ?? "ns", verdict: "pass", passed: true, cases, logs: "" };
    },
    isHealthy: async () => true,
    publish: async () => null,
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
    { pipeline: stubDeps({ prepare: async () => ({ mirrorDir: "/m", diff: "", message: "docs: tweak" }) }), loadApp: cfg },
  );
  await queue.drain();
  const r = getRecord(id)!;
  assert.equal(r.parentRunId, "parent-1");
  assert.notEqual(r.verdict, "skipped"); // it generated + ran despite the docs commit
  assert.equal(r.verdict, "pass");
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
