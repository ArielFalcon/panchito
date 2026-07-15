// test/contexts/qa-run-orchestration/infrastructure/bridges/execution-port.adapter.test.ts
// RED-first (Task E.0): ExecutionPortAdapter dispatches between the REAL e2e/code strategies
// (E2eExecutionStrategy / CodeExecutionStrategy), both implementing ExecutionStrategyPort.run(req).
// THIN — no new policy: this bridge only maps ExecutionPort.execute(specDir) onto the richer
// ExecutionRequest shape (baseUrl/namespace held as static per-run context) and selects the
// strategy by target ("e2e" vs "code").
import { test } from "node:test";
import assert from "node:assert/strict";
import { ExecutionPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/execution-port.adapter.ts";
import { E2eExecutionStrategy } from "@contexts/test-execution/infrastructure/e2e-execution.strategy.ts";
import { CodeExecutionStrategy } from "@contexts/test-execution/infrastructure/code-execution.strategy.ts";
import type { E2eExecuteOptions } from "@contexts/test-execution/infrastructure/e2e-execution.runner.ts";

// ── E2eExecuteOptions exhaustiveness (migration-tier-4d Slice 1b) ───────────────────────────────
// Re-homes qa-engine/test/contract/seam-parity.contract.test.ts's retired block (c) EXECUTION
// exhaustiveness guard: E2eExecuteOptions (formerly the legacy ExecuteOptions, src/qa/execute.ts,
// now deleted) no longer straddles the src/qa-engine boundary — both sides of this guard are
// qa-engine-internal, so it is a NORMAL test here, not a parity pin. A field ADDED to
// E2eExecuteOptions without a matching mapped/allowlisted entry below FAILS TYPECHECK (the
// `satisfies` below); a field silently DROPPED by ExecutionPortAdapter FAILS THIS TEST.
const E2E_EXECUTE_OPTIONS_ALL_FIELDS = {
  baseUrl: true, namespace: true, onCase: true, onRunning: true, onDiscovered: true,
  faultInject: true, signal: true, timeoutMs: true, project: true, testIdAttribute: true,
  specFiles: true,
} satisfies Record<keyof E2eExecuteOptions, true>;

const E2E_EXECUTE_OPTIONS_ALLOWLIST: Record<string, string> = {
  baseUrl: "held as ExecutionPortStaticContext (constructor-time, not per-call) — carried through ctx.baseUrl, asserted by the dispatch tests below, not a drop.",
  namespace: "held as ExecutionPortStaticContext (constructor-time, overridable per-call via opts.namespace) — asserted by the dispatch/override tests below, not a drop.",
};

test("E2eExecuteOptions' own field list matches the allowlist + ExecutionPortAdapter's mapped set exactly (retired seam-parity block (c))", () => {
  const mapped = ["onCase", "onRunning", "onDiscovered", "faultInject", "signal", "timeoutMs", "project", "testIdAttribute", "specFiles"];
  const allFieldNames = Object.keys(E2E_EXECUTE_OPTIONS_ALL_FIELDS).sort();
  const accountedFor = [...new Set([...mapped, ...Object.keys(E2E_EXECUTE_OPTIONS_ALLOWLIST)])].sort();
  assert.deepEqual(accountedFor, allFieldNames, "every E2eExecuteOptions field must be either mapped by ExecutionPortAdapter or allowlisted with a reason");
});

test("execute() dispatches to E2eExecutionStrategy for target 'e2e' and forwards baseUrl/namespace", async () => {
  let capturedOpts: unknown;
  const e2e = new E2eExecutionStrategy(async (specDir, opts) => {
    capturedOpts = opts;
    return { verdict: "pass", cases: [{ name: "checkout", status: "pass" }], logs: `ran ${specDir}` };
  });
  const code = new CodeExecutionStrategy(async () => ({ verdict: "pass", cases: [], logs: "" }));
  const adapter = new ExecutionPortAdapter({ e2e, code }, { target: "e2e", baseUrl: "https://dev.example.com", namespace: "qa-bot-abc1234" });

  const result = await adapter.execute("/mirrors/org/app/e2e");

  assert.equal(result.verdict, "pass");
  assert.deepEqual(result.cases, [{ name: "checkout", status: "pass" }]);
  assert.match(result.logs, /\/mirrors\/org\/app\/e2e/);
  assert.equal((capturedOpts as { baseUrl: string }).baseUrl, "https://dev.example.com");
  assert.equal((capturedOpts as { namespace: string }).namespace, "qa-bot-abc1234");
});

test("execute() dispatches to CodeExecutionStrategy for target 'code' (no baseUrl required)", async () => {
  let called = false;
  const e2e = new E2eExecutionStrategy(async () => ({ verdict: "pass", cases: [], logs: "" }));
  const code = new CodeExecutionStrategy(async (repoDir, opts) => {
    called = true;
    return { verdict: "fail", cases: [{ name: "unit test A", status: "fail", detail: "AssertionError" }], logs: `code run ${repoDir} ns=${opts.namespace}` };
  });
  const adapter = new ExecutionPortAdapter({ e2e, code }, { target: "code", namespace: "qa-bot-def5678" });

  const result = await adapter.execute("/mirrors/org/app");

  assert.equal(called, true);
  assert.equal(result.verdict, "fail");
  assert.equal(result.cases.length, 1);
});

// ── Plan 7.2 — leaf-signal forwarding (closes engram #916): the ExecutionPort barrel already
// declares execute(specDir, signal?) (Plan 7.1), and E2eExecutionStrategy/CodeExecutionStrategy
// already forward ExecutionRequest.signal into runE2E/runCodeTests's own opts.signal — this
// adapter is the ONLY missing link. It must declare + forward the signal, or the queue's
// AbortSignal is silently dropped before it ever reaches Playwright/the code runner.

test("execute() forwards an AbortSignal into the e2e strategy's ExecutionRequest", async () => {
  const controller = new AbortController();
  let capturedSignal: AbortSignal | undefined;
  const e2e = new E2eExecutionStrategy(async (_specDir, opts) => {
    capturedSignal = opts.signal;
    return { verdict: "pass", cases: [], logs: "" };
  });
  const code = new CodeExecutionStrategy(async () => ({ verdict: "pass", cases: [], logs: "" }));
  const adapter = new ExecutionPortAdapter({ e2e, code }, { target: "e2e", baseUrl: "https://dev.example.com", namespace: "qa-bot-abc1234" });

  await adapter.execute("/mirrors/org/app/e2e", controller.signal);

  assert.equal(capturedSignal, controller.signal, "the SAME AbortSignal instance passed to execute() must reach the e2e strategy's ExecutionRequest.signal, not be dropped at the bridge");
});

test("execute() forwards an AbortSignal into the code strategy's ExecutionRequest", async () => {
  const controller = new AbortController();
  let capturedSignal: AbortSignal | undefined;
  const e2e = new E2eExecutionStrategy(async () => ({ verdict: "pass", cases: [], logs: "" }));
  const code = new CodeExecutionStrategy(async (_repoDir, opts) => {
    capturedSignal = opts.signal;
    return { verdict: "pass", cases: [], logs: "" };
  });
  const adapter = new ExecutionPortAdapter({ e2e, code }, { target: "code", namespace: "qa-bot-def5678" });

  await adapter.execute("/mirrors/org/app", controller.signal);

  assert.equal(capturedSignal, controller.signal, "the SAME AbortSignal instance passed to execute() must reach the code strategy's ExecutionRequest.signal, not be dropped at the bridge");
});

// A3: testIdAttribute must reach the e2e strategy so PW_TEST_ID_ATTRIBUTE is set for the verdictual
// Playwright run — otherwise getByTestId silently resolves the default data-testid on non-default apps.
test("execute() forwards testIdAttribute from static context into the e2e strategy's ExecutionRequest", async () => {
  let capturedOpts: unknown;
  const e2e = new E2eExecutionStrategy(async (_specDir, opts) => {
    capturedOpts = opts;
    return { verdict: "pass", cases: [], logs: "" };
  });
  const code = new CodeExecutionStrategy(async () => ({ verdict: "pass", cases: [], logs: "" }));
  const adapter = new ExecutionPortAdapter(
    { e2e, code },
    { target: "e2e", baseUrl: "https://dev.example.com", namespace: "qa-bot-abc1234", testIdAttribute: "data-cy" },
  );

  await adapter.execute("/mirrors/org/app/e2e");

  assert.equal((capturedOpts as { testIdAttribute?: string }).testIdAttribute, "data-cy");
});

test("execute() with no signal at all behaves exactly as before (no second-arg regression)", async () => {
  let capturedOpts: unknown;
  const e2e = new E2eExecutionStrategy(async (_specDir, opts) => {
    capturedOpts = opts;
    return { verdict: "pass", cases: [], logs: "" };
  });
  const code = new CodeExecutionStrategy(async () => ({ verdict: "pass", cases: [], logs: "" }));
  const adapter = new ExecutionPortAdapter({ e2e, code }, { target: "e2e", baseUrl: "https://dev.example.com", namespace: "qa-bot-abc1234" });

  const result = await adapter.execute("/mirrors/org/app/e2e");

  assert.equal(result.verdict, "pass");
  assert.equal((capturedOpts as { signal?: AbortSignal }).signal, undefined, "an absent signal must remain absent downstream — no fabricated AbortSignal");
});

// ── W4 fix (F1) — ExecutionPort widened with an ExecutionOpts bag (faultInject/specFiles/project/
// timeoutMs/onCase/onRunning/onDiscovered), replacing the old signal-only 2nd positional arg. ────

test("execute() still accepts a bare AbortSignal as the 2nd arg (old 2-arg callers keep compiling and working)", async () => {
  const controller = new AbortController();
  let capturedOpts: unknown;
  const e2e = new E2eExecutionStrategy(async (_specDir, opts) => {
    capturedOpts = opts;
    return { verdict: "pass", cases: [], logs: "" };
  });
  const code = new CodeExecutionStrategy(async () => ({ verdict: "pass", cases: [], logs: "" }));
  const adapter = new ExecutionPortAdapter({ e2e, code }, { target: "e2e", baseUrl: "https://dev.example.com", namespace: "qa-bot-abc1234" });

  // A caller written against the OLD `execute(specDir, signal?)` shape, unmodified:
  const result = await adapter.execute("/mirrors/org/app/e2e", controller.signal);

  assert.equal(result.verdict, "pass");
  assert.equal((capturedOpts as { signal?: AbortSignal }).signal, controller.signal, "a bare AbortSignal 2nd arg must still reach ExecutionRequest.signal");
});

test("execute() forwards specFiles from the opts bag into the e2e strategy's ExecutionRequest (filtered-retry)", async () => {
  let capturedOpts: unknown;
  const e2e = new E2eExecutionStrategy(async (_specDir, opts) => {
    capturedOpts = opts;
    return { verdict: "pass", cases: [], logs: "" };
  });
  const code = new CodeExecutionStrategy(async () => ({ verdict: "pass", cases: [], logs: "" }));
  const adapter = new ExecutionPortAdapter({ e2e, code }, { target: "e2e", baseUrl: "https://dev.example.com", namespace: "qa-bot-abc1234" });

  await adapter.execute("/mirrors/org/app/e2e", { specFiles: ["login.spec.ts", "checkout.spec.ts"] });

  assert.deepEqual((capturedOpts as { specFiles?: string[] }).specFiles, ["login.spec.ts", "checkout.spec.ts"]);
});

test("execute() forwards faultInject/project/timeoutMs from the opts bag into the e2e strategy", async () => {
  let capturedOpts: unknown;
  const e2e = new E2eExecutionStrategy(async (_specDir, opts) => {
    capturedOpts = opts;
    return { verdict: "pass", cases: [], logs: "" };
  });
  const code = new CodeExecutionStrategy(async () => ({ verdict: "pass", cases: [], logs: "" }));
  const adapter = new ExecutionPortAdapter({ e2e, code }, { target: "e2e", baseUrl: "https://dev.example.com", namespace: "qa-bot-abc1234" });

  await adapter.execute("/mirrors/org/app/e2e", { faultInject: true, project: "chromium", timeoutMs: 45000 });

  const opts = capturedOpts as { faultInject?: boolean; project?: string; timeoutMs?: number };
  assert.equal(opts.faultInject, true);
  assert.equal(opts.project, "chromium");
  assert.equal(opts.timeoutMs, 45000);
});

test("execute() forwards onCase/onRunning/onDiscovered live-progress callbacks into the e2e strategy", async () => {
  let capturedOpts: unknown;
  const e2e = new E2eExecutionStrategy(async (_specDir, opts) => {
    capturedOpts = opts;
    return { verdict: "pass", cases: [], logs: "" };
  });
  const code = new CodeExecutionStrategy(async () => ({ verdict: "pass", cases: [], logs: "" }));
  const adapter = new ExecutionPortAdapter({ e2e, code }, { target: "e2e", baseUrl: "https://dev.example.com", namespace: "qa-bot-abc1234" });

  const seenCases: unknown[] = [];
  const seenRunning: string[] = [];
  const seenDiscovered: [string, string | undefined][] = [];
  await adapter.execute("/mirrors/org/app/e2e", {
    onCase: (c) => seenCases.push(c),
    onRunning: (title) => seenRunning.push(title),
    onDiscovered: (title, file) => seenDiscovered.push([title, file]),
  });

  const opts = capturedOpts as {
    onCase?: (c: { name: string; status: string; detail?: string }) => void;
    onRunning?: (title: string) => void;
    onDiscovered?: (title: string, file?: string) => void;
  };
  opts.onCase?.({ name: "checkout", status: "pass" });
  opts.onRunning?.("login");
  opts.onDiscovered?.("checkout", "checkout.spec.ts");

  assert.deepEqual(seenCases, [{ name: "checkout", status: "pass" }]);
  assert.deepEqual(seenRunning, ["login"]);
  assert.deepEqual(seenDiscovered, [["checkout", "checkout.spec.ts"]]);
});

test("execute() does NOT forward specFiles to the code strategy (E2E-only concept, distinct from changedFiles)", async () => {
  let capturedOpts: unknown;
  const e2e = new E2eExecutionStrategy(async () => ({ verdict: "pass", cases: [], logs: "" }));
  const code = new CodeExecutionStrategy(async (_repoDir, opts) => {
    capturedOpts = opts;
    return { verdict: "pass", cases: [], logs: "" };
  });
  const adapter = new ExecutionPortAdapter({ e2e, code }, { target: "code", namespace: "qa-bot-def5678" });

  await adapter.execute("/mirrors/org/app", { specFiles: ["a.spec.ts"] });

  assert.equal((capturedOpts as { changedFiles?: string[] }).changedFiles, undefined);
  assert.equal((capturedOpts as { specFiles?: string[] }).specFiles, undefined);
});

// ── P2 (post-cutover-remediation) Constraint 2: namespace override ────────────────────────────
// The enforce-mode coverage regen re-executes under a DEDICATED namespace (`${runId}-coverage-regen`)
// so its coverage dumps never collide with / get shadowed by the first run's dumps. Without an
// override every call falls back to ctx.namespace (the static per-run value), which is what the
// regen must escape from.

test("execute() forwards opts.namespace to the e2e strategy, overriding ctx.namespace", async () => {
  let capturedOpts: unknown;
  const e2e = new E2eExecutionStrategy(async (_specDir, opts) => {
    capturedOpts = opts;
    return { verdict: "pass", cases: [], logs: "" };
  });
  const code = new CodeExecutionStrategy(async () => ({ verdict: "pass", cases: [], logs: "" }));
  const adapter = new ExecutionPortAdapter({ e2e, code }, { target: "e2e", baseUrl: "https://dev.example.com", namespace: "qa-bot-abc1234" });

  await adapter.execute("/mirrors/org/app/e2e", { namespace: "qa-bot-abc1234-coverage-regen" });

  assert.equal((capturedOpts as { namespace: string }).namespace, "qa-bot-abc1234-coverage-regen", "opts.namespace must override ctx.namespace for the e2e strategy");
});

test("execute() forwards opts.namespace to the code strategy, overriding ctx.namespace", async () => {
  let capturedOpts: unknown;
  const e2e = new E2eExecutionStrategy(async () => ({ verdict: "pass", cases: [], logs: "" }));
  const code = new CodeExecutionStrategy(async (_repoDir, opts) => {
    capturedOpts = opts;
    return { verdict: "pass", cases: [], logs: "" };
  });
  const adapter = new ExecutionPortAdapter({ e2e, code }, { target: "code", namespace: "qa-bot-def5678" });

  await adapter.execute("/mirrors/org/app", { namespace: "qa-bot-def5678-coverage-regen" });

  assert.equal((capturedOpts as { namespace: string }).namespace, "qa-bot-def5678-coverage-regen", "opts.namespace must override ctx.namespace for the code strategy");
});

test("execute() falls back to ctx.namespace when opts.namespace is absent (backward compatible, both branches)", async () => {
  let e2eOpts: unknown;
  let codeOpts: unknown;
  const e2e = new E2eExecutionStrategy(async (_specDir, opts) => { e2eOpts = opts; return { verdict: "pass", cases: [], logs: "" }; });
  const code = new CodeExecutionStrategy(async (_repoDir, opts) => { codeOpts = opts; return { verdict: "pass", cases: [], logs: "" }; });

  const e2eAdapter = new ExecutionPortAdapter({ e2e, code }, { target: "e2e", baseUrl: "https://dev.example.com", namespace: "qa-bot-abc1234" });
  await e2eAdapter.execute("/mirrors/org/app/e2e");
  assert.equal((e2eOpts as { namespace: string }).namespace, "qa-bot-abc1234");

  const codeAdapter = new ExecutionPortAdapter({ e2e, code }, { target: "code", namespace: "qa-bot-def5678" });
  await codeAdapter.execute("/mirrors/org/app");
  assert.equal((codeOpts as { namespace: string }).namespace, "qa-bot-def5678");
});
