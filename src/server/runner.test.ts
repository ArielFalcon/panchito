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
import type { RunPipelinePort, RunInput } from "@contexts/qa-run-orchestration/application/ports/index.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";

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

// A fake RunPipelinePort that records whether it was invoked, so the dispatch tests below can
// assert routing without needing a real qa-engine wiring (deferred to Slice F.2's operator script).
function fakePort(outcome: Partial<RunOutcome> = {}): { port: RunPipelinePort; calls: RunInput[] } {
  const calls: RunInput[] = [];
  const port: RunPipelinePort = {
    async run(input) {
      calls.push(input);
      return {
        runId: input.runId,
        app: input.app,
        sha: input.sha.value,
        mode: input.mode,
        target: input.target,
        verdict: "pass",
        errorClass: null,
        gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
        rulesRetrieved: [],
        at: new Date().toISOString(),
        ...outcome,
      };
    },
  };
  return { port, calls };
}

// ── PIPELINE_ENGINE dispatch seam (Task E.3) ───────────────────────────────────
// The runner is the ONLY src/ file allowed to consult the flag. With PIPELINE_ENGINE absent
// (or any value other than the literal "rewritten"), the legacy runPipeline path must be
// byte-identical to today — the rewritten RunPipelinePort must NEVER be invoked. With
// PIPELINE_ENGINE=rewritten AND an injected engineFactory, the runner must route through the
// factory's port and never call the legacy runPipeline.

test("PIPELINE_ENGINE absent — routes to legacy runPipeline, never touches engineFactory", async () => {
  const queue = new JobQueue();
  let legacyCalled = false;
  let factoryCalled = false;
  const id = enqueueTrackedRun(
    queue,
    { app: "runner-flag-absent", sha: "abc1234", target: "e2e", mode: "diff", source: "manual" },
    {
      pipeline: stubDeps({ prepare: async (...args) => { legacyCalled = true; return stubDeps().prepare(...args); } }),
      loadApp: cfg,
      engineFactory: () => {
        factoryCalled = true;
        return fakePort().port;
      },
    },
  );
  await queue.drain();
  const r = getRecord(id)!;
  assert.equal(r.status, "done");
  assert.equal(r.verdict, "pass");
  assert.equal(legacyCalled, true, "the legacy pipeline must run when PIPELINE_ENGINE is absent");
  assert.equal(factoryCalled, false, "engineFactory must NEVER be consulted on the legacy path");
});

test("PIPELINE_ENGINE=legacy (explicit) — identical to absent: legacy runs, factory untouched", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "legacy";
  try {
    const queue = new JobQueue();
    let legacyCalled = false;
    let factoryCalled = false;
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-flag-legacy", sha: "abc1234", target: "e2e", mode: "diff", source: "manual" },
      {
        pipeline: stubDeps({ prepare: async (...args) => { legacyCalled = true; return stubDeps().prepare(...args); } }),
        loadApp: cfg,
        engineFactory: () => {
          factoryCalled = true;
          return fakePort().port;
        },
      },
    );
    await queue.drain();
    const r = getRecord(id)!;
    assert.equal(r.verdict, "pass");
    assert.equal(legacyCalled, true);
    assert.equal(factoryCalled, false);
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

test("PIPELINE_ENGINE=rewritten + engineFactory — routes to port.run, never calls legacy runPipeline", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    let legacyCalled = false;
    const { port, calls } = fakePort({ verdict: "pass" });
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-flag-rewritten", sha: "def5678", target: "e2e", mode: "diff", source: "manual" },
      {
        pipeline: stubDeps({ prepare: async (...args) => { legacyCalled = true; return stubDeps().prepare(...args); } }),
        loadApp: cfg,
        engineFactory: () => port,
      },
    );
    await queue.drain();
    const r = getRecord(id)!;
    assert.equal(r.status, "done");
    assert.equal(r.verdict, "pass");
    assert.equal(legacyCalled, false, "legacy runPipeline must NEVER run when the rewritten engine is selected");
    assert.equal(calls.length, 1, "the rewritten port must be invoked exactly once");
    assert.equal(calls[0]?.app, "runner-flag-rewritten");
    assert.equal(calls[0]?.sha.value, "def5678");
    assert.equal(calls[0]?.mode, "diff");
    assert.equal(calls[0]?.target, "e2e");
    assert.equal(calls[0]?.source, "manual");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

// CLAUDE.md invariant ("surface integration errors loudly — never swallow errors into an empty
// result"): a live portfolio run once produced verdict:infra-error with NO note/log/cases on the
// rewritten engine path — undiagnosable without instrumenting a live container. Root cause:
// runViaRewrittenEngine (this file) mapped RunOutcome -> QaRunResult but dropped `note` entirely.
// This test pins that the note now survives all the way out to the run record.
test("PIPELINE_ENGINE=rewritten — outcome.note is forwarded into the run record's note field", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    const { port } = fakePort({ verdict: "infra-error", note: "DEV did not serve sha def5678 within 5000ms" });
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-flag-rewritten-note", sha: "def5678", target: "e2e", mode: "diff", source: "manual" },
      { pipeline: stubDeps(), loadApp: cfg, engineFactory: () => port },
    );
    await queue.drain();
    const r = getRecord(id)!;
    assert.equal(r.status, "done");
    assert.equal(r.verdict, "infra-error");
    assert.equal(
      r.note,
      "DEV did not serve sha def5678 within 5000ms",
      "the rewritten engine's diagnostic note must reach the run record — previously silently dropped by runViaRewrittenEngine's RunOutcome -> QaRunResult mapping",
    );
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

// ── CRITICAL fix (judgment-day) — the runner MUST compute a PER-RUN namespace and pass it into
// engineFactory, mirroring the exact formula legacy uses (testDataNamespace(prefix, sha, runId) at
// src/pipeline.ts:1222). Without this, every run of every app collided on the SAME static branch
// literal ("qa-bot/rewritten"), which flows into BOTH GenerationPort's and ExecutionPort's
// `namespace` — the live DEV test-data scoping. These tests pin the runner's own dispatch, NOT the
// factory's internals (already covered in rewritten-engine-factory.test.ts).

test("PIPELINE_ENGINE=rewritten — the runner passes a testDataNamespace-shaped, per-run namespace to engineFactory (never a static literal)", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    const { port } = fakePort({ verdict: "pass" });
    let receivedNamespace: string | undefined;
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-namespace-shape", sha: "def5678", target: "e2e", mode: "diff", source: "manual" },
      {
        pipeline: stubDeps(),
        loadApp: cfg,
        engineFactory: (_appConfig, namespace) => {
          receivedNamespace = namespace;
          return port;
        },
      },
    );
    await queue.drain();
    assert.equal(getRecord(id)!.verdict, "pass");
    assert.ok(receivedNamespace, "engineFactory must receive a namespace argument");
    assert.notEqual(receivedNamespace, "qa-bot/rewritten", "must never be the old static literal");
    // testDataNamespace(prefix, sha, runId) formula: `${prefix}-${shortSha(sha)}-${runToken(runId)}`.
    // cfg(...) fixtures use testDataPrefix "qa-bot"; shortSha("def5678") === "def5678" (already 7 chars).
    assert.match(receivedNamespace!, /^qa-bot-def5678-/, "namespace must start with testDataPrefix-shortSha, matching legacy's formula");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

test("PIPELINE_ENGINE=rewritten — two DIFFERENT runs (different sha) produce DIFFERENT namespaces passed to engineFactory", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue1 = new JobQueue();
    const queue2 = new JobQueue();
    const { port: port1 } = fakePort({ verdict: "pass" });
    const { port: port2 } = fakePort({ verdict: "pass" });
    let namespace1: string | undefined;
    let namespace2: string | undefined;
    const id1 = enqueueTrackedRun(
      queue1,
      { app: "runner-namespace-diff", sha: "aaa1111", target: "e2e", mode: "diff", source: "manual" },
      { pipeline: stubDeps(), loadApp: cfg, engineFactory: (_a, ns) => { namespace1 = ns; return port1; } },
    );
    const id2 = enqueueTrackedRun(
      queue2,
      { app: "runner-namespace-diff", sha: "bbb2222", target: "e2e", mode: "diff", source: "manual" },
      { pipeline: stubDeps(), loadApp: cfg, engineFactory: (_a, ns) => { namespace2 = ns; return port2; } },
    );
    await Promise.all([queue1.drain(), queue2.drain()]);
    assert.equal(getRecord(id1)!.verdict, "pass");
    assert.equal(getRecord(id2)!.verdict, "pass");
    assert.ok(namespace1);
    assert.ok(namespace2);
    assert.notEqual(namespace1, namespace2, "two different-sha runs must never share the same DEV test-data namespace");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

// ── Fix 3+4 (engram #961) — mode/guidance MUST thread through the engineFactory seam, per-run,
// following the namespace precedent. The factory previously hardcoded mode:"diff" and never
// received guidance at all, so a manual run with --guidance generated with a stale diff-mode
// prompt and silently dropped the guidance.

test("PIPELINE_ENGINE=rewritten — the runner passes req.mode to engineFactory's 3rd (run) argument", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    const { port } = fakePort({ verdict: "pass" });
    let receivedMode: string | undefined;
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-mode-manual", sha: "def5678", target: "e2e", mode: "manual", source: "manual", guidance: "test the contact form" },
      {
        pipeline: stubDeps(),
        loadApp: cfg,
        engineFactory: (_appConfig, _namespace, run) => {
          receivedMode = run.mode;
          return port;
        },
      },
    );
    await queue.drain();
    assert.equal(getRecord(id)!.verdict, "pass");
    assert.equal(receivedMode, "manual", "engineFactory must receive req.mode, not a hardcoded 'diff'");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

test("PIPELINE_ENGINE=rewritten — the runner passes req.guidance to engineFactory's 3rd (run) argument when present", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    const { port } = fakePort({ verdict: "pass" });
    let receivedGuidance: string | undefined;
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-guidance", sha: "def5678", target: "e2e", mode: "manual", source: "manual", guidance: "test the contact form" },
      {
        pipeline: stubDeps(),
        loadApp: cfg,
        engineFactory: (_appConfig, _namespace, run) => {
          receivedGuidance = run.guidance;
          return port;
        },
      },
    );
    await queue.drain();
    assert.equal(getRecord(id)!.verdict, "pass");
    assert.equal(receivedGuidance, "test the contact form", "engineFactory must receive req.guidance when the run supplies it");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

test("PIPELINE_ENGINE=rewritten — engineFactory's run.guidance is absent (not an empty string) when req.guidance is omitted", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    const { port } = fakePort({ verdict: "pass" });
    let receivedRun: { mode: string; guidance?: string } | undefined;
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-guidance-absent", sha: "def5678", target: "e2e", mode: "diff", source: "manual" },
      {
        pipeline: stubDeps(),
        loadApp: cfg,
        engineFactory: (_appConfig, _namespace, run) => {
          receivedRun = run;
          return port;
        },
      },
    );
    await queue.drain();
    assert.equal(getRecord(id)!.verdict, "pass");
    assert.equal(receivedRun?.guidance, undefined, "guidance must be absent, not fabricated, when the request never supplied one");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

// ── Cross-repo coverage guard (dual-judge finding) ─────────────────────────────
// Legacy's coverage-collect gate is `mode === "diff" && ... && !triggerService`
// (src/pipeline.ts:2912) — browser V8 coverage cannot map a service repo's changed lines, so a
// cross-repo (deploy-event) run must degrade change-coverage to "unknown", never a real ratio.
// runViaRewrittenEngine must thread req.triggerRepo into the RunInput it hands to port.run() so
// RunQaUseCase can starve the ObjectiveSignalPort.measure() diff arg for these runs.

test("PIPELINE_ENGINE=rewritten — the runner threads req.triggerRepo into port.run's RunInput when present", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    const { port, calls } = fakePort({ verdict: "pass" });
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-trigger-repo", sha: "def5678", target: "e2e", mode: "diff", source: "webhook", triggerRepo: "org/orders-svc" },
      { pipeline: stubDeps(), loadApp: cfg, engineFactory: () => port },
    );
    await queue.drain();
    assert.equal(getRecord(id)!.verdict, "pass");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.triggerRepo, "org/orders-svc", "RunInput.triggerRepo must carry req.triggerRepo through to port.run, mirroring legacy's triggerService cross-repo gate");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

test("PIPELINE_ENGINE=rewritten — RunInput.triggerRepo is absent (not fabricated) when req.triggerRepo is omitted", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    const { port, calls } = fakePort({ verdict: "pass" });
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-trigger-repo-absent", sha: "def5678", target: "e2e", mode: "diff", source: "manual" },
      { pipeline: stubDeps(), loadApp: cfg, engineFactory: () => port },
    );
    await queue.drain();
    assert.equal(getRecord(id)!.verdict, "pass");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.triggerRepo, undefined, "an ordinary (non-cross-repo) run must never fabricate a triggerRepo");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

test("PIPELINE_ENGINE=rewritten but NO engineFactory supplied — falls back to legacy (fail-safe)", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    let legacyCalled = false;
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-flag-no-factory", sha: "abc1234", target: "e2e", mode: "diff", source: "manual" },
      {
        pipeline: stubDeps({ prepare: async (...args) => { legacyCalled = true; return stubDeps().prepare(...args); } }),
        loadApp: cfg,
        // engineFactory intentionally omitted.
      },
    );
    await queue.drain();
    const r = getRecord(id)!;
    assert.equal(r.status, "done");
    assert.equal(legacyCalled, true, "with no engineFactory, the runner must fail safe to legacy even if the flag says rewritten");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

test("the rewritten path finalizes the record + publishes run.verdict RunEvents from the port's RunOutcome", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    const runEvents = createRunEventStore({ now: () => 999 });
    const { port } = fakePort({ verdict: "fail" });
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-flag-events", sha: "def5678", target: "e2e", mode: "diff", source: "webhook" },
      { pipeline: stubDeps(), loadApp: cfg, runEvents, engineFactory: () => port },
    );
    await queue.drain();
    const r = getRecord(id)!;
    assert.equal(r.status, "done");
    assert.equal(r.verdict, "fail");
    const bodies = runEvents.replay(id).map((e) => e.body);
    assert.deepEqual(bodies[0], { type: "run.started", app: "runner-flag-events", sha: "def5678", mode: "diff", target: "e2e" });
    const last = bodies.at(-1) as { type: string; verdict: string };
    assert.equal(last.type, "run.verdict");
    assert.equal(last.verdict, "fail");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

// ── Bug fix: rewritten-engine runs left their RunRecord/RunEvents frozen — record.step never
// advanced past its initial value and /api/runs/:id/events stayed empty, because nothing wired
// RunQaUseCaseDeps.observer. The runner's own fix is buildRewrittenObserver (this file) +
// engineFactory's widened 4th (observer) argument. These tests pin: (1) engineFactory receives a
// live ObserverPort as its 4th argument, and (2) a port that drives that observer mid-run produces
// the SAME updateRecord + step.changed RunEvent shape the legacy engine's own onStep callback
// produces — so the TUI/API render identically regardless of which engine is running. ────────────

test("PIPELINE_ENGINE=rewritten — the runner passes a live ObserverPort as engineFactory's 4th argument", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    const { port } = fakePort();
    let receivedObserver: unknown;
    enqueueTrackedRun(
      queue,
      { app: "runner-observer-arg", sha: "abc1234", target: "e2e", mode: "diff", source: "manual" },
      {
        pipeline: stubDeps(),
        loadApp: cfg,
        engineFactory: (_appConfig, _namespace, _run, observer) => {
          receivedObserver = observer;
          return port;
        },
      },
    );
    await queue.drain();
    assert.ok(receivedObserver, "engineFactory must receive a 4th (observer) argument");
    assert.equal(typeof (receivedObserver as { onStep?: unknown }).onStep, "function");
    assert.equal(typeof (receivedObserver as { onEvent?: unknown }).onEvent, "function");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

test("PIPELINE_ENGINE=rewritten — a port that drives ObserverPort.onStep mid-run updates the record's step + publishes step.changed RunEvents live (not just at the final verdict)", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    const runEvents = createRunEventStore({ now: () => 1234 });
    // A port standing in for RewrittenOrchestratorAdapter -> RunQaUseCase: it drives the SAME
    // observer the runner handed it through a representative phase sequence BEFORE resolving,
    // exactly as RunQaUseCase.run() now does at each phase boundary.
    const observingPort: RunPipelinePort = {
      run: async (input) => {
        const stepsSeenMidRun = ["gate", "classify", "generate", "validate", "health", "execute"] as const;
        for (const step of stepsSeenMidRun) {
          currentObserver?.onStep(step);
          // Assert the record already reflects this step BEFORE the run finishes — proving the
          // update is live, not batched until the final verdict.
          assert.equal(getRecord(id)?.step, step, `record.step must advance to '${step}' while the run is still in flight`);
        }
        return {
          runId: input.runId,
          app: input.app,
          sha: input.sha.value,
          mode: input.mode,
          target: input.target,
          verdict: "pass",
          errorClass: null,
          gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
          rulesRetrieved: [],
          at: new Date().toISOString(),
        };
      },
    };
    let currentObserver: { onStep(step: string, detail?: string): void } | undefined;
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-observer-live", sha: "def5678", target: "e2e", mode: "diff", source: "webhook" },
      {
        pipeline: stubDeps(),
        loadApp: cfg,
        runEvents,
        engineFactory: (_appConfig, _namespace, _run, observer) => {
          currentObserver = observer as { onStep(step: string, detail?: string): void };
          return observingPort;
        },
      },
    );
    await queue.drain();

    const r = getRecord(id)!;
    assert.equal(r.status, "done");
    assert.equal(r.verdict, "pass");
    assert.equal(r.step, "done", "the record's final step is 'done' (set by the queue callback's own finalize, after the port resolved)");

    const bodies = runEvents.replay(id).map((e) => e.body);
    const stepEvents = bodies.filter((b): b is Extract<typeof b, { type: "step.changed" }> => b.type === "step.changed");
    assert.deepEqual(
      stepEvents.map((e) => e.step),
      ["gate", "classify", "generate", "validate", "health", "execute"],
      "every onStep() call the port made mid-run must publish its own step.changed RunEvent, in order — this is the SAME machinery the legacy engine's own onStep callback drives",
    );
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

test("PIPELINE_ENGINE=rewritten — ObserverPort.onStep('retry', detail) sets record.stepDetail and record.retrying:true, mirroring the legacy callback's own retrying:step==='retry' convention", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    let currentObserver: { onStep(step: string, detail?: string): void } | undefined;
    const retryingPort: RunPipelinePort = {
      run: async (input) => {
        currentObserver?.onStep("retry", "static-fix round 1/2");
        assert.equal(getRecord(id)?.retrying, true);
        assert.equal(getRecord(id)?.stepDetail, "static-fix round 1/2");
        return {
          runId: input.runId,
          app: input.app,
          sha: input.sha.value,
          mode: input.mode,
          target: input.target,
          verdict: "pass",
          errorClass: null,
          gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 1 },
          rulesRetrieved: [],
          at: new Date().toISOString(),
        };
      },
    };
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-observer-retry", sha: "abc1234", target: "e2e", mode: "diff", source: "manual" },
      {
        pipeline: stubDeps(),
        loadApp: cfg,
        engineFactory: (_appConfig, _namespace, _run, observer) => {
          currentObserver = observer as { onStep(step: string, detail?: string): void };
          return retryingPort;
        },
      },
    );
    await queue.drain();
    // The queue callback's own happy-path finalize always writes retrying:false — this proves the
    // mid-run retrying:true was genuinely observed above (asserted synchronously inside run()),
    // not that it survives to the terminal record.
    assert.equal(getRecord(id)?.retrying, false);
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

// ── Observer fault isolation (judgment-day, both judges) ───────────────────────
// buildRewrittenObserver's onStep/onEvent wrap updateRecord/runEvents.publish in try/catch — a
// transient write failure (e.g. a flaky event-bus subscriber) must never propagate up through
// ObserverPort and abort an otherwise-healthy run. Before this fix, a throwing onStep call would
// have escaped RunQaUseCase's `this.deps.observer?.onStep(...)` call site and converted a genuine
// "pass" into an unrelated crash — the SAME class of bug CLAUDE.md's own "a bad event must never
// break..." pattern (src/index.ts) already guards against elsewhere in this codebase.
//
// Scoped precisely to buildRewrittenObserver's own onStep/onEvent (not every runEvents.publish
// call site in the runner, several of which are outside this fix's scope): the throwing stub only
// fails on "step.changed" events, which are published EXCLUSIVELY from inside
// buildRewrittenObserver.onStep — every other event type in this run (run.started, etc.) still
// publishes normally, isolating the assertion to the observer's own fault boundary.
test("PIPELINE_ENGINE=rewritten — a port that drives ObserverPort.onStep, where runEvents.publish throws on step.changed, still finalizes the run's own verdict (non-fatal, isolated)", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    let currentObserver: { onStep(step: string, detail?: string): void } | undefined;
    const observingPort: RunPipelinePort = {
      run: async (input) => {
        // Drive onStep through several phases — every call must swallow the publish throw below
        // without ever propagating into this run() call (which would otherwise reject the port's
        // own promise and convert this "pass" into an infra-error).
        for (const step of ["gate", "generate", "validate", "execute"] as const) {
          currentObserver?.onStep(step);
        }
        return {
          runId: input.runId,
          app: input.app,
          sha: input.sha.value,
          mode: input.mode,
          target: input.target,
          verdict: "pass",
          errorClass: null,
          gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
          rulesRetrieved: [],
          at: new Date().toISOString(),
        };
      },
    };
    const realRunEvents = createRunEventStore({ now: () => 1 });
    const throwingOnStepChanged = {
      ...realRunEvents,
      publish(runId: string, body: Parameters<typeof realRunEvents.publish>[1]) {
        if (body.type === "step.changed") throw new Error("simulated event-bus failure on step.changed");
        return realRunEvents.publish(runId, body);
      },
    };
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-observer-fault", sha: "abc1234", target: "e2e", mode: "diff", source: "manual" },
      {
        pipeline: stubDeps(),
        loadApp: cfg,
        runEvents: throwingOnStepChanged,
        engineFactory: (_appConfig, _namespace, _run, observer) => {
          currentObserver = observer as { onStep(step: string, detail?: string): void };
          return observingPort;
        },
      },
    );
    await queue.drain();
    const record = getRecord(id);
    assert.equal(record?.status, "done", "a throwing observer must not prevent the run from finalizing");
    assert.equal(record?.verdict, "pass", "a throwing observer must not change the run's own verdict");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

test("a crashing rewritten port finalizes the record as infra-error (no zombie)", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    const crashingPort: RunPipelinePort = { run: async () => { throw new Error("rewritten engine boom"); } };
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-flag-crash", sha: "abc1234", target: "e2e", mode: "diff", source: "manual" },
      { pipeline: stubDeps(), loadApp: cfg, engineFactory: () => crashingPort },
    );
    await queue.drain();
    const r = getRecord(id)!;
    assert.equal(r.status, "done");
    assert.equal(r.verdict, "infra-error");
    assert.match(r.note ?? "", /boom/);
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

// ── Plan 7.1 — closes the rewritten cancellation gap (engram #913): cancelTrackedRun must abort
// the rewritten port's OWN in-flight run via the queue's AbortSignal, and the port's late
// resolution (after the record is already finalized as cancelled) must NEVER overwrite it. ──────

test("cancelTrackedRun aborts the rewritten port's in-flight run.run() AND the record is not overwritten by the port's late resolution", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    let observedAborted = false;
    let resolveLate: (() => void) | undefined;
    // A port whose run() observes the signal (proving it was actually threaded in) and stays
    // pending until the test explicitly resolves it late — standing in for a rewritten engine
    // that keeps running headless after cancellation.
    const cancellablePort: RunPipelinePort = {
      run: async (input, signal) => {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) { observedAborted = true; return resolve(); }
          signal?.addEventListener("abort", () => { observedAborted = true; resolve(); }, { once: true });
        });
        // Simulate the late resolution: the port's own promise only settles AFTER this point,
        // well after cancelTrackedRun has already finalized the record.
        await new Promise<void>((resolve) => { resolveLate = resolve; });
        return {
          runId: input.runId,
          app: input.app,
          sha: input.sha.value,
          mode: input.mode,
          target: input.target,
          verdict: "pass",
          errorClass: null,
          gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
          rulesRetrieved: [],
          at: new Date().toISOString(),
        };
      },
    };
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-rewritten-cancel", sha: "abc1234", target: "e2e", mode: "diff", source: "manual" },
      { pipeline: stubDeps(), loadApp: cfg, engineFactory: () => cancellablePort },
    );
    await new Promise((r) => setImmediate(r)); // let the job claim the queue controller
    assert.equal(cancelTrackedRun(queue, id), true, "a live rewritten run must be cancellable via the queue signal");
    // Give the port's abort listener a tick to fire before asserting.
    await new Promise((r) => setImmediate(r));
    assert.equal(observedAborted, true, "the rewritten port's run() must observe the queue's AbortSignal — the gap this closes");
    const cancelledRecord = getRecord(id)!;
    assert.equal(cancelledRecord.status, "done");
    assert.equal(cancelledRecord.verdict, "infra-error", "matches cancelTrackedRun's own aborted-terminal mapping");
    // Now let the port's stale promise resolve LATE (as if it kept running headless) — this must
    // NEVER overwrite the already-finalized cancelled record with a stale "pass" verdict.
    resolveLate?.();
    await queue.drain();
    const finalRecord = getRecord(id)!;
    assert.equal(finalRecord.status, "done");
    assert.equal(finalRecord.verdict, "infra-error", "a late resolution from a cancelled rewritten run must NOT overwrite the finalized cancelled record");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

test("cancelTrackedRun + an UNRELATED late crash: the catch branch must NOT overwrite the finalized cancelled record", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    let rejectLate: ((e: Error) => void) | undefined;
    // A rewritten port that observes the cancel, then — in the async gap after cancelTrackedRun has
    // already finalized the record — its own work rejects with an UNRELATED (non-cancel) error,
    // routing to the queue callback's catch branch. Without the catch-branch guard, that catch would
    // overwrite the accurate "cancelled" record with a crash note + fire a spurious incident.
    const crashingPort: RunPipelinePort = {
      run: async (_input, signal) => {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        await new Promise<never>((_resolve, reject) => { rejectLate = reject; });
        throw new Error("unreachable — rejectLate drives the crash");
      },
    };
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-catch-cancel-race", sha: "abc1234", target: "e2e", mode: "diff", source: "manual" },
      { pipeline: stubDeps(), loadApp: cfg, engineFactory: () => crashingPort },
    );
    await new Promise((r) => setImmediate(r)); // let the job claim the queue controller
    assert.equal(cancelTrackedRun(queue, id), true);
    await new Promise((r) => setImmediate(r)); // let the port's abort listener fire
    const cancelledNote = getRecord(id)!.note;
    // Now the port's own work rejects LATE with an unrelated error → the catch branch runs.
    rejectLate?.(new Error("OpenCode 500 — unrelated crash racing the cancel"));
    await queue.drain();
    const finalRecord = getRecord(id)!;
    assert.equal(finalRecord.verdict, "infra-error");
    assert.equal(finalRecord.note, cancelledNote, "the catch branch must NOT overwrite the cancelled record's note with a crash note (nor fire a spurious incident — the guard returns before both)");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

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
