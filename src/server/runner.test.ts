import { test } from "node:test";
import assert from "node:assert/strict";
import { JobQueue } from "./queue";
import { enqueueTrackedRun, cancelTrackedRun } from "./runner";
import { getRecord, createRecord, updateRecord } from "./history";
import { AppConfig } from "../orchestrator/config-loader";
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

// ── engineFactory dispatch (Plan 7.6: the rewritten engine is the ONLY engine) ─────────────────
// The legacy runPipeline path is deleted. enqueueTrackedRun now REQUIRES RunnerDeps.engineFactory
// — a missing factory throws loudly (a boot-time wiring defect), never silently falls back.

test("enqueueTrackedRun with no engineFactory supplied — throws loudly, finalizes as infra-error (no silent fallback)", async () => {
  const queue = new JobQueue();
  const id = enqueueTrackedRun(
    queue,
    { app: "runner-flag-no-factory", sha: "abc1234", target: "e2e", mode: "diff", source: "manual" },
    { loadApp: cfg },
  );
  await queue.drain();
  const r = getRecord(id)!;
  assert.equal(r.status, "done");
  assert.equal(r.verdict, "infra-error", "a missing engineFactory must surface as a loud infra-error, never a silent legacy fallback (the legacy engine was removed)");
  assert.match(r.note ?? "", /engineFactory is required/);
});

test("engineFactory supplied — routes to port.run", async () => {
  const queue = new JobQueue();
  const { port, calls } = fakePort({ verdict: "pass" });
  const id = enqueueTrackedRun(
    queue,
    { app: "runner-flag-rewritten", sha: "def5678", target: "e2e", mode: "diff", source: "manual" },
    { loadApp: cfg, engineFactory: () => port },
  );
  await queue.drain();
  const r = getRecord(id)!;
  assert.equal(r.status, "done");
  assert.equal(r.verdict, "pass");
  assert.equal(calls.length, 1, "the rewritten port must be invoked exactly once");
  assert.equal(calls[0]?.app, "runner-flag-rewritten");
  assert.equal(calls[0]?.sha.value, "def5678");
  assert.equal(calls[0]?.mode, "diff");
  assert.equal(calls[0]?.target, "e2e");
  assert.equal(calls[0]?.source, "manual");
});

test("PIPELINE_ENGINE=legacy (stale operator setting) — still routes through the rewritten engineFactory (accepted-but-ignored)", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "legacy";
  try {
    const queue = new JobQueue();
    const { port, calls } = fakePort({ verdict: "pass" });
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-flag-legacy", sha: "abc1234", target: "e2e", mode: "diff", source: "manual" },
      { loadApp: cfg, engineFactory: () => port },
    );
    await queue.drain();
    const r = getRecord(id)!;
    assert.equal(r.verdict, "pass");
    assert.equal(calls.length, 1, "PIPELINE_ENGINE=legacy no longer selects a different code path — the rewritten engine always runs");
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
      { loadApp: cfg, engineFactory: () => port },
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
      { loadApp: cfg, engineFactory: (_a, ns) => { namespace1 = ns; return port1; } },
    );
    const id2 = enqueueTrackedRun(
      queue2,
      { app: "runner-namespace-diff", sha: "bbb2222", target: "e2e", mode: "diff", source: "manual" },
      { loadApp: cfg, engineFactory: (_a, ns) => { namespace2 = ns; return port2; } },
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
    // Must be a DECLARED service (assertTriggerRepoDeclared, judgment-day security fix) — an
    // undeclared triggerRepo now rejects the run before it ever reaches port.run(); see the
    // dedicated "rejects an undeclared triggerRepo" test group below.
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-trigger-repo", sha: "def5678", target: "e2e", mode: "diff", source: "webhook", triggerRepo: "org/orders-svc" },
      { loadApp: (name) => ({ ...cfg(name), services: [{ repo: "org/orders-svc" }] }), engineFactory: () => port },
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

// ── triggerRepo validation (judgment-day, WARNING real) ────────────────────────
// Legacy runPipeline throws `trigger repo ${x} is not a declared service of app ${y}`
// (src/pipeline.ts:1008-1013) BEFORE the run ever starts — an unvalidated webhook-supplied
// triggerRepo could otherwise route a real GitHub Issue (decision.issueRepo defaults to
// input.triggerRepo, F3/643818c) into an arbitrary repo. Only the rewritten branch bypassed this
// (RunQaUseCase has no app.services knowledge) — assertTriggerRepoDeclared closes that gap at the
// SAME boundary the legacy branch already protects (runViaRewrittenEngine, mirroring
// runPipeline's own check). A rejected run finalizes as verdict "infra-error" (a plain Error,
// same as legacy — isInfraError(err) is false for it, matching the existing "unexpected internal
// error" classification the queue callback's catch block already applies to non-InfraError throws).

test("PIPELINE_ENGINE=rewritten — rejects an undeclared triggerRepo (finalizes infra-error, never reaches port.run)", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    const { port, calls } = fakePort({ verdict: "pass" });
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-trigger-repo-undeclared", sha: "def5678", target: "e2e", mode: "diff", source: "webhook", triggerRepo: "org/evil-repo" },
      // cfg() declares no services[] at all — org/evil-repo cannot be a declared service.
      { loadApp: cfg, engineFactory: () => port },
    );
    await queue.drain();
    const r = getRecord(id)!;
    assert.equal(r.status, "done");
    assert.equal(r.verdict, "infra-error", "an undeclared triggerRepo must never reach a real verdict — the run is rejected outright");
    assert.match(r.note ?? "", /trigger repo org\/evil-repo is not a declared service of app runner-trigger-repo-undeclared/);
    assert.equal(calls.length, 0, "port.run must NEVER be invoked for an undeclared triggerRepo");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

test("PIPELINE_ENGINE=rewritten — accepts a DECLARED service triggerRepo", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    const { port, calls } = fakePort({ verdict: "pass" });
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-trigger-repo-declared", sha: "def5678", target: "e2e", mode: "diff", source: "webhook", triggerRepo: "org/orders-svc" },
      { loadApp: (name) => ({ ...cfg(name), services: [{ repo: "org/orders-svc" }] }), engineFactory: () => port },
    );
    await queue.drain();
    assert.equal(getRecord(id)!.verdict, "pass");
    assert.equal(calls.length, 1, "a declared service triggerRepo must reach port.run normally");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

test("PIPELINE_ENGINE=rewritten — an app with NO services[] rejects ANY triggerRepo other than its own repo", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    const { port, calls } = fakePort({ verdict: "pass" });
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-trigger-repo-no-services", sha: "def5678", target: "e2e", mode: "diff", source: "webhook", triggerRepo: "org/anything" },
      // cfg() has no `services` key at all — matches legacy's `app.services?.find(...)` on undefined.
      { loadApp: cfg, engineFactory: () => port },
    );
    await queue.drain();
    assert.equal(getRecord(id)!.verdict, "infra-error");
    assert.equal(calls.length, 0);
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
      { loadApp: cfg, engineFactory: () => port },
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

// ── Bug fix (cross-repo composition threading) — engineFactory's `run` param must ALSO carry
// triggerRepo, not just mode/guidance. Prior to this fix, req.triggerRepo reached RunInput (pinned
// above) but never reached the engineFactory's `run` object, so rewritten-engine-factory.ts had no
// way to route vcs/checkout/the deploy gate to the declared service — this is the seam that closes
// that gap. Mirrors this file's own "engineFactory's run.guidance is absent..." precedent exactly.

test("PIPELINE_ENGINE=rewritten — engineFactory's run param carries req.triggerRepo when present", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    const { port } = fakePort({ verdict: "pass" });
    let receivedRun: { mode: string; guidance?: string; triggerRepo?: string } | undefined;
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-engfactory-triggerrepo", sha: "def5678", target: "e2e", mode: "diff", source: "webhook", triggerRepo: "org/orders-svc" },
      {
        loadApp: (name) => ({ ...cfg(name), services: [{ repo: "org/orders-svc" }] }),
        engineFactory: (_appConfig, _namespace, run) => {
          receivedRun = run;
          return port;
        },
      },
    );
    await queue.drain();
    assert.equal(getRecord(id)!.verdict, "pass");
    assert.equal(receivedRun?.triggerRepo, "org/orders-svc", "engineFactory's run param must carry req.triggerRepo so the factory can route vcs/checkout/gate to the declared service");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

test("PIPELINE_ENGINE=rewritten — engineFactory's run.triggerRepo is absent (not fabricated) when req.triggerRepo is omitted", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    const { port } = fakePort({ verdict: "pass" });
    let receivedRun: { mode: string; guidance?: string; triggerRepo?: string } | undefined;
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-engfactory-triggerrepo-absent", sha: "def5678", target: "e2e", mode: "diff", source: "manual" },
      {
        loadApp: cfg,
        engineFactory: (_appConfig, _namespace, run) => {
          receivedRun = run;
          return port;
        },
      },
    );
    await queue.drain();
    assert.equal(getRecord(id)!.verdict, "pass");
    assert.equal(receivedRun?.triggerRepo, undefined, "an ordinary (non-cross-repo) run must never fabricate a triggerRepo on the engineFactory's run param either");
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
      { loadApp: cfg, runEvents, engineFactory: () => port },
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
      { loadApp: cfg, engineFactory: () => crashingPort },
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
      { loadApp: cfg, engineFactory: () => cancellablePort },
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
      { loadApp: cfg, engineFactory: () => crashingPort },
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
  const { port } = fakePort({ verdict: "skipped" });
  const id = enqueueTrackedRun(
    queue,
    { app: "runner-skip", sha: "abc1234", target: "e2e", mode: "diff", source: "manual" },
    { loadApp: cfg, engineFactory: () => port },
  );
  // Right after enqueue, before draining: the job has not run yet.
  assert.equal(getRecord(id)?.status, "enqueued");
  await queue.drain();
  const r = getRecord(id)!;
  assert.equal(r.status, "done");
  assert.equal(r.verdict, "skipped");
});

test("a green run finalizes the record with verdict + case counts", async () => {
  const queue = new JobQueue();
  const { port } = fakePort({
    verdict: "pass",
    cases: [
      { name: "t1", status: "pass" },
      { name: "t2", status: "pass" },
    ],
  });
  const id = enqueueTrackedRun(
    queue,
    { app: "runner-pass", sha: "def5678", target: "e2e", mode: "diff", source: "webhook" },
    { loadApp: cfg, engineFactory: () => port },
  );
  await queue.drain();
  const r = getRecord(id)!;
  assert.equal(r.verdict, "pass");
  assert.equal(r.passed, 2);
  assert.equal(r.failed, 0);
  assert.equal(r.cases.length, 2);
});

test("a green run publishes live RunEvents for steps and the final verdict", async () => {
  const queue = new JobQueue();
  const runEvents = createRunEventStore({ now: () => 123 });
  const port: RunPipelinePort = {
    run: async (input, _signal) => {
      return {
        runId: input.runId, app: input.app, sha: input.sha.value, mode: input.mode, target: input.target,
        verdict: "pass", errorClass: null,
        gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
        rulesRetrieved: [], at: new Date().toISOString(),
        cases: [{ name: "checkout", status: "pass" }],
      };
    },
  };
  const id = enqueueTrackedRun(
    queue,
    { app: "runner-events", sha: "def5678", target: "e2e", mode: "diff", source: "webhook" },
    { loadApp: cfg, runEvents, engineFactory: () => port },
  );

  await queue.drain();

  const bodies = runEvents.replay(id).map((event) => event.body);
  assert.deepEqual(bodies[0], { type: "run.started", app: "runner-events", sha: "def5678", mode: "diff", target: "e2e" });
  assert.ok(bodies.some((body) => body.type === "test.passed" && body.name === "checkout"));
  const last = bodies.at(-1) as { type: string; verdict: string; passed: number; failed: number };
  assert.equal(last.type, "run.verdict");
  assert.equal(last.verdict, "pass");
  assert.equal(last.passed, 1);
  assert.equal(last.failed, 0);
});

test("a crashing rewritten port finalizes the record as infra-error with the message (no zombie)", async () => {
  const queue = new JobQueue();
  const crashingPort: RunPipelinePort = { run: async () => { throw new Error("boom"); } };
  const id = enqueueTrackedRun(
    queue,
    { app: "runner-crash", sha: "999aaaa", target: "e2e", mode: "diff", source: "manual" },
    { loadApp: cfg, engineFactory: () => crashingPort },
  );
  await queue.drain();
  const r = getRecord(id)!;
  assert.equal(r.status, "done");
  assert.equal(r.verdict, "infra-error");
  assert.match(r.note ?? "", /boom/);
});

test("a continuation records the parent run", async () => {
  const queue = new JobQueue();
  const { port } = fakePort({ verdict: "pass" });
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
    { loadApp: cfg, engineFactory: () => port },
  );
  await queue.drain();
  const r = getRecord(id)!;
  assert.equal(r.parentRunId, "parent-1");
  assert.equal(r.verdict, "pass");
});

test("a bad app name is finalized (not a zombie) — loadApp throwing is caught", async () => {
  const queue = new JobQueue();
  const { port } = fakePort({ verdict: "pass" });
  const id = enqueueTrackedRun(
    queue,
    { app: "runner-noapp", sha: "111bbbb", target: "e2e", mode: "diff", source: "manual" },
    { loadApp: () => { throw new Error("config/apps/x.yaml not found"); }, engineFactory: () => port },
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

// ── W3 F3 (HIGH cutover blocker): runViaRewrittenEngine maps outcome.cases -> history.addCase +
// outcome.logs -> the run record — previously hardcoded cases:[]/logs:"" unconditionally, so every
// passing rewritten-engine run showed passed=0/failed=0 with an empty case list regardless of what
// actually ran. ─────────────────────────────────────────────────────────────────────────────────

test("PIPELINE_ENGINE=rewritten — outcome.cases populate the run record's cases + passed/failed counts (was: permanent 0/0)", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    const { port } = fakePort({
      verdict: "pass",
      cases: [
        { name: "login flow", status: "pass" },
        { name: "checkout flow", status: "fail", detail: "timeout" },
      ],
    });
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-w3f3-cases", sha: "def5678", target: "e2e", mode: "diff", source: "manual" },
      { loadApp: cfg, engineFactory: () => port },
    );
    await queue.drain();
    const r = getRecord(id)!;
    assert.equal(r.status, "done");
    assert.equal(r.cases.length, 2, "the run record's cases must reflect the REAL outcome.cases, not the previous permanent []");
    assert.equal(r.passed, 1, "passed must be recomputed from the real cases (history.addCase's own single-source-of-truth contract)");
    assert.equal(r.failed, 1);
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

test("PIPELINE_ENGINE=rewritten — an absent outcome.cases (early-exit terminal) leaves the run record's cases empty, never throws", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    const { port } = fakePort({ verdict: "invalid", cases: undefined });
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-w3f3-no-cases", sha: "def5678", target: "e2e", mode: "diff", source: "manual" },
      { loadApp: cfg, engineFactory: () => port },
    );
    await queue.drain();
    const r = getRecord(id)!;
    assert.equal(r.status, "done");
    assert.equal(r.verdict, "invalid");
    assert.deepEqual(r.cases, []);
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

// ── W3 F4 (MEDIUM): per-case RunEvents (test.passed/test.failed/test.flaky) + reviewer.verdict are
// published from the already-returned RunOutcome, closing the "no live events on the rewritten
// path" gap for what IS available without widening ExecutionPort (true per-case LIVE events during
// execution need #35 — flagged, not built here). ──────────────────────────────────────────────

test("PIPELINE_ENGINE=rewritten — outcome.cases publish test.passed/test.failed RunEvents", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    const runEvents = createRunEventStore();
    const { port } = fakePort({
      verdict: "pass",
      cases: [
        { name: "login flow", status: "pass", durationMs: 500 },
        { name: "checkout flow", status: "fail", detail: "timeout" },
      ],
    });
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-w3f4-case-events", sha: "def5678", target: "e2e", mode: "diff", source: "manual" },
      { loadApp: cfg, engineFactory: () => port, runEvents },
    );
    await queue.drain();
    const events = runEvents.replay(id).map((e) => e.body);
    const passed = events.find((e) => e.type === "test.passed");
    const failed = events.find((e) => e.type === "test.failed");
    assert.ok(passed, "a test.passed event must be published for the passing case");
    assert.ok(failed, "a test.failed event must be published for the failing case");
    assert.equal((passed as { name: string }).name, "login flow");
    assert.equal((failed as { name: string }).name, "checkout flow");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

test("PIPELINE_ENGINE=rewritten — a flaky case publishes a test.flaky RunEvent", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    const runEvents = createRunEventStore();
    const { port } = fakePort({
      verdict: "flaky",
      cases: [{ name: "flaky checkout", status: "flaky" }],
    });
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-w3f4-flaky-event", sha: "def5678", target: "e2e", mode: "diff", source: "manual" },
      { loadApp: cfg, engineFactory: () => port, runEvents },
    );
    await queue.drain();
    const events = runEvents.replay(id).map((e) => e.body);
    const flaky = events.find((e) => e.type === "test.flaky");
    assert.ok(flaky, "a test.flaky event must be published for the flaky case");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

test("PIPELINE_ENGINE=rewritten — outcome.gateSignals.reviewerApproved publishes a reviewer.verdict RunEvent", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    const runEvents = createRunEventStore();
    const { port } = fakePort({
      verdict: "pass",
      gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: ["nit: naming"], reviewerApproved: true, flaky: false, retries: 0 },
    });
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-w3f4-reviewer-event", sha: "def5678", target: "e2e", mode: "diff", source: "manual" },
      { loadApp: cfg, engineFactory: () => port, runEvents },
    );
    await queue.drain();
    const events = runEvents.replay(id).map((e) => e.body);
    const verdict = events.find((e) => e.type === "reviewer.verdict");
    assert.ok(verdict, "a reviewer.verdict event must be published when the outcome carries reviewerApproved");
    assert.equal((verdict as { approved: boolean }).approved, true);
    assert.deepEqual((verdict as { reasons: string[] }).reasons, ["nit: naming"]);
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

// ── liveAnnounced dedup + convergence (judgment-day CRITICAL fix) ──────────────────────────────
// Playwright fires onTestEnd PER ATTEMPT (config/e2e/playwright.config.ts retries:2): a flaky test
// live-announces test.failed then test.passed within ONE execute(), but the final report correctly
// classifies it "flaky" (src/qa/playwright-report.ts). A naive Set<string> dedup ("was this name
// announced live at all?") permanently suppressed the terminal event once ANY live event fired for
// that name — silently dropping the correcting test.flaky the record store itself carries. These
// tests drive the SAME seam the engineFactory-based tests above use: the port receives the live
// ObserverPort as its 4th engineFactory argument (so it can fire onEvent mid-run, standing in for
// RunQaUseCase's own ExecutionOpts.onCase streaming) and returns outcome.cases for the post-hoc
// recordCase loop — exactly how runViaRewrittenEngine wires the two paths together.

test("liveAnnounced dedup — a case announced live with a MATCHING final status publishes its terminal event exactly once (no re-publish)", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    const runEvents = createRunEventStore();
    let observer: { onEvent(body: { type: string; name?: string; durationMs?: number; attempts?: number }): void } | undefined;
    const port: RunPipelinePort = {
      run: async (input, _signal) => {
        // Live-announce a clean pass for "login flow" BEFORE the run resolves — mirrors
        // ExecutionOpts.onCase streaming test.passed through the use-case's own onEvent.
        observer?.onEvent({ type: "test.passed", name: "login flow", durationMs: 500 });
        return {
          runId: input.runId, app: input.app, sha: input.sha.value, mode: input.mode, target: input.target,
          verdict: "pass", errorClass: null,
          gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
          rulesRetrieved: [], at: new Date().toISOString(),
          cases: [{ name: "login flow", status: "pass", durationMs: 500 }],
        };
      },
    };
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-dedup-match", sha: "def5678", target: "e2e", mode: "diff", source: "manual" },
      {
        loadApp: cfg,
        runEvents,
        engineFactory: (_appConfig, _namespace, _run, obs) => {
          observer = obs as { onEvent(body: { type: string; name?: string; durationMs?: number; attempts?: number }): void };
          return port;
        },
      },
    );
    await queue.drain();
    const r = getRecord(id)!;
    assert.equal(r.status, "done");
    // The record store's own write (addCase) still happened — the case is present in the record.
    assert.equal(r.cases.length, 1);
    assert.equal(r.cases[0]?.status, "pass");
    const passedEvents = runEvents.replay(id).map((e) => e.body).filter((b) => b.type === "test.passed");
    assert.equal(passedEvents.length, 1, "a matching final status must publish its terminal event exactly once (live announcement, no post-hoc re-publish)");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

test("liveAnnounced dedup — the flaky divergence: live announces failed then passed, final status flaky → publishes the correcting test.flaky exactly once", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    const runEvents = createRunEventStore();
    let observer: { onEvent(body: { type: string; name?: string; durationMs?: number; attempts?: number }): void } | undefined;
    const port: RunPipelinePort = {
      run: async (input, _signal) => {
        // Playwright retries:2 — attempt 1 fails live, attempt 2 (retry) passes live. The final
        // report classifies the case as "flaky" (src/qa/playwright-report.ts), which diverges from
        // the LAST live-announced status ("passed").
        observer?.onEvent({ type: "test.failed", name: "checkout flow" });
        observer?.onEvent({ type: "test.passed", name: "checkout flow", durationMs: 300 });
        return {
          runId: input.runId, app: input.app, sha: input.sha.value, mode: input.mode, target: input.target,
          verdict: "flaky", errorClass: null,
          gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: true, retries: 1 },
          rulesRetrieved: [], at: new Date().toISOString(),
          cases: [{ name: "checkout flow", status: "flaky" }],
        };
      },
    };
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-dedup-flaky", sha: "def5678", target: "e2e", mode: "diff", source: "manual" },
      {
        loadApp: cfg,
        runEvents,
        engineFactory: (_appConfig, _namespace, _run, obs) => {
          observer = obs as { onEvent(body: { type: string; name?: string; durationMs?: number; attempts?: number }): void };
          return port;
        },
      },
    );
    await queue.drain();
    const r = getRecord(id)!;
    assert.equal(r.status, "done");
    assert.equal(r.verdict, "flaky");
    assert.equal(r.cases.length, 1);
    assert.equal(r.cases[0]?.status, "flaky", "the record store's own truth is flaky");
    const bodies = runEvents.replay(id).map((e) => e.body);
    const flakyEvents = bodies.filter((b) => b.type === "test.flaky");
    assert.equal(flakyEvents.length, 1, "the divergence (live: passed, final: flaky) must publish exactly one correcting test.flaky event");
    // The live-announced test.failed/test.passed from onEvent are still present (they are real
    // per-attempt announcements) — the correction is additive, not a rewrite of history.
    assert.ok(bodies.some((b) => b.type === "test.failed" && (b as { name: string }).name === "checkout flow"));
    assert.ok(bodies.some((b) => b.type === "test.passed" && (b as { name: string }).name === "checkout flow"));
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

test("liveAnnounced dedup — a case NEVER announced live (e.g. code-mode) always publishes post-hoc", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    const runEvents = createRunEventStore();
    // No onEvent calls at all — standing in for a strategy without live callbacks (code-mode).
    const { port } = fakePort({
      verdict: "pass",
      cases: [{ name: "unit: parses config", status: "pass" }],
    });
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-dedup-never-announced", sha: "def5678", target: "e2e", mode: "diff", source: "manual" },
      { loadApp: cfg, runEvents, engineFactory: () => port },
    );
    await queue.drain();
    const bodies = runEvents.replay(id).map((e) => e.body);
    const passedEvents = bodies.filter((b) => b.type === "test.passed" && (b as { name: string }).name === "unit: parses config");
    assert.equal(passedEvents.length, 1, "a never-announced case must publish its terminal event post-hoc (the safety net for code-mode)");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

test("liveAnnounced dedup — addCase (the record-store write) always runs regardless of live announcement or dedup outcome", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    const runEvents = createRunEventStore();
    let observer: { onEvent(body: { type: string; name?: string; durationMs?: number; attempts?: number }): void } | undefined;
    const port: RunPipelinePort = {
      run: async (input, _signal) => {
        observer?.onEvent({ type: "test.passed", name: "case A", durationMs: 100 }); // live-announced, matching final
        // "case B" is never live-announced at all.
        return {
          runId: input.runId, app: input.app, sha: input.sha.value, mode: input.mode, target: input.target,
          verdict: "pass", errorClass: null,
          gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
          rulesRetrieved: [], at: new Date().toISOString(),
          cases: [
            { name: "case A", status: "pass" },
            { name: "case B", status: "pass" },
          ],
        };
      },
    };
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-dedup-addcase-always", sha: "def5678", target: "e2e", mode: "diff", source: "manual" },
      {
        loadApp: cfg,
        runEvents,
        engineFactory: (_appConfig, _namespace, _run, obs) => {
          observer = obs as { onEvent(body: { type: string; name?: string; durationMs?: number; attempts?: number }): void };
          return port;
        },
      },
    );
    await queue.drain();
    const r = getRecord(id)!;
    assert.equal(r.cases.length, 2, "addCase must write BOTH cases to the record store regardless of live-announcement/dedup status");
    assert.equal(r.passed, 2);
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});

test("PIPELINE_ENGINE=rewritten — no reviewer.verdict event when outcome.gateSignals.reviewerApproved is absent (review never ran)", async () => {
  const prev = process.env.PIPELINE_ENGINE;
  process.env.PIPELINE_ENGINE = "rewritten";
  try {
    const queue = new JobQueue();
    const runEvents = createRunEventStore();
    const { port } = fakePort({ verdict: "invalid" }); // no reviewerApproved on the default outcome
    const id = enqueueTrackedRun(
      queue,
      { app: "runner-w3f4-no-reviewer-event", sha: "def5678", target: "e2e", mode: "diff", source: "manual" },
      { loadApp: cfg, engineFactory: () => port, runEvents },
    );
    await queue.drain();
    const events = runEvents.replay(id).map((e) => e.body);
    assert.equal(events.some((e) => e.type === "reviewer.verdict"), false, "no reviewer.verdict must be fabricated when the use-case never computed one");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_ENGINE;
    else process.env.PIPELINE_ENGINE = prev;
  }
});
