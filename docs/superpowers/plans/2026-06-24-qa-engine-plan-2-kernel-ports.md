# QA Engine — Plan 2: Kernel + Ports

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the `shared-kernel/` (cross-context vocabulary that depends on NOTHING downstream), the `shared-infrastructure/` process-sandbox helpers (the consolidated `killTree` + the moved `scrubEnv`), and the bounded-context **port interfaces only** (no adapters), plus an arch-lint gate that makes the VCS-write security invariant structural — all inside `qa-engine/src/`, parallel to `src/`, touching **no** existing `src/` runtime except a one-line typecheck-script fix. Plan 1's characterization comparator must keep passing: the kernel `RunOutcome` stays structurally compatible with the legacy `src/types.ts` `RunOutcome`.

**Architecture:** This implements spec §7.2 Step 3 (sever the `types.ts`→taxonomy/usage forward edge by *inversion* — the new kernel never re-creates it), Step 4 (define ALL bounded-context ports as pure interfaces), and the §8 R4 prerequisite (the `vcs-write-confinement` arch-lint gate, green **before** any context code is written in later plans). The kernel is a leaf: value objects, the closed `RunEvent` vocabulary, `Result<T,E>`, the `InfraError` taxonomy, the two NEW domain concepts `BlastRadius`/`Objective`, the kernel-resident `AgentRole`/`RoleAssignment` (because they appear in `AgentRuntimePort`'s signature — §5.1 P3), the frozen `contract/` re-export, and the two kernel ports (`RedactionPort`, `ClockPort`). `shared-infrastructure/` is a SIBLING of the kernel (concrete `child_process` code, not pure types). Ports are segregated interface stubs (`§5.3`) compiling against the kernel and nothing external; later plans (3-6) implement the adapters.

**Tech Stack:** TypeScript 5.6 (strict, `noUncheckedIndexedAccess`, `noEmit`), `tsx`, `node:test` + `node:assert/strict`, path aliases (`@kernel/*`, `@contexts/*`, `@interface/*`) from Plan 1's `qa-engine/tsconfig.json`, `dependency-cruiser` (new devDependency) for the arch-lint gate.

This plan covers spec §5.1 (principles), §5.2 (the kernel + shared-infrastructure tree), §5.3(1)-(10) (each context's ports + value objects, **interfaces only**), §7.2 Step 4/4b's port-lift list (minus the Seam-2 cycle break — deferred), and §8 R4 (arch-lint). It does **NOT** build any adapter/implementation (Plans 3-6), the rewritten orchestrator (Plan 6), or the cutover (Plan 7). It does **NOT** touch `src/qa/changed-elements.ts` (the user's stable file; Plan 3 consolidates it) and does **NOT** break the Seam-2 `opencode-client ⇄ prompts` cycle (DEFERRED to Plan 5 — the user edits those files live).

---

## File Structure

**Modified (the ONLY `src/`-adjacent change in this plan)**
- `package.json` (root) — `typecheck` script reverts from `tsc --build --force` (emits `.d.ts`/`.tsbuildinfo`) to a no-emit pair covering both trees.
- `package.json` (root) + `package-lock.json` — add `dependency-cruiser` devDependency (Task 12).

**Created — `shared-kernel/` (production)**
- `qa-engine/src/shared-kernel/sha.ts` — `Sha` hex-invariant value object (replaces the bare-string SHA).
- `qa-engine/src/shared-kernel/run-verdict.ts` — `RunVerdict` + `RunEngineStatus` + `engineStatus()` (carried VERBATIM from `src/types.ts`).
- `qa-engine/src/shared-kernel/run-mode.ts` — `RunMode`, `RUN_MODES`, `TestTarget`, `TriggerSource`.
- `qa-engine/src/shared-kernel/run-step.ts` — `RunStep` (the canonical pipeline-phase enum, mirrors `contract/events.ts` `RunStepSchema`).
- `qa-engine/src/shared-kernel/qa-case.ts` — `CaseStatus`, `QaCase`, `SpecMeta`, `SpecRecord`.
- `qa-engine/src/shared-kernel/result.ts` — `Result<T,E>` (explicit error flow) + `ok`/`err`/`isOk`/`isErr` constructors.
- `qa-engine/src/shared-kernel/domain-error.ts` — `InfraError`/`AgentUnavailableError`/`StalledAgentError` + `isInfraError`.
- `qa-engine/src/shared-kernel/blast-radius.ts` — **NEW** `BlastRadius` VO (promoted from scattered diff fields).
- `qa-engine/src/shared-kernel/objective.ts` — **NEW** `Objective` + `Flow` VOs (promoted from scattered planner fields).
- `qa-engine/src/shared-kernel/agent-role.ts` — `AgentRole` (8 members) + `RoleAssignment` (kernel-resident; §5.1 P3).
- `qa-engine/src/shared-kernel/run-event.ts` — `RunEvent` closed discriminated-union domain-event vocabulary (re-exported from contract).
- `qa-engine/src/shared-kernel/run-outcome.ts` — kernel-owned `RunOutcome` (structurally compatible with legacy `src/types.ts`).
- `qa-engine/src/shared-kernel/contract/index.ts` — re-export of the frozen wire surface (`events`/`commands`/`openapi`) from `src/contract/*`.
- `qa-engine/src/shared-kernel/ports/redaction.port.ts` — `RedactionPort` interface.
- `qa-engine/src/shared-kernel/ports/clock.port.ts` — `ClockPort` interface.
- `qa-engine/src/shared-kernel/ports/deploy-gate.port.ts` — `DeployGatePort` interface (cross-cutting infra port; owned by the kernel, consumed by both qa-run-orchestration and test-execution).
- `qa-engine/src/shared-kernel/process-sandbox/process-kill.port.ts` — `ProcessKillPort` interface (port lives in the kernel).

**Created — `shared-infrastructure/` (production)**
- `qa-engine/src/shared-infrastructure/process-sandbox/process-kill.adapter.ts` — the ONE consolidated `killTree` (`child_process`).
- `qa-engine/src/shared-infrastructure/process-sandbox/scrub-env.ts` — the moved `scrubEnv` (the env allowlist sandbox layer).
- `qa-engine/src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts` — the shared spawn wrapper interface + thin impl.

**Created — bounded-context ports (production, interfaces only)**
- `qa-engine/src/contexts/qa-run-orchestration/application/ports/index.ts` — the 13 driven/driving ports of the core.
- `qa-engine/src/contexts/change-analysis/application/ports/index.ts` — `VcsReadPort` + the 5 extractor ports.
- `qa-engine/src/contexts/generation/application/ports/index.ts` — `ManifestRepositoryPort`/`VerdictParserPort`/`PromptRenderingPort`/`DomGroundingPort`/`PromptBudgetPort`.
- `qa-engine/src/contexts/agent-runtime/application/ports/index.ts` — `AgentRuntimePort` + `AgentRuntimeStrategy`/`TransportPort`/`ModelCatalogPort`/`StallWatchdogPort`/`TurnTelemetrySink`.
- `qa-engine/src/contexts/test-execution/application/ports/index.ts` — `ExecutionStrategyPort`/`StaticGatePort` (`DeployGatePort` is kernel-resident; imported from `@kernel`).
- `qa-engine/src/contexts/objective-signal/application/ports/index.ts` — `CoverageCollectorPort`/`ValueOraclePort`/`SourceMapPort`.
- `qa-engine/src/contexts/cross-run-learning/application/ports/index.ts` — `LearningRepositoryPort`/`ReflectorPort`/`ProcessAuditPort`.
- `qa-engine/src/contexts/workspace-and-publication/application/ports/index.ts` — `VcsWritePort`/`WorkspaceVcsReadPort`/`GitHubPrPort`/`GitHubIssuePort`/`MirrorGcPort`.
- `qa-engine/src/contexts/app-catalog/application/ports/index.ts` — `AppRepositoryPort`/`RepoInfoPort`.

**Created — tests (mirror under `qa-engine/test/`)**
- `qa-engine/test/shared-kernel/sha.test.ts`
- `qa-engine/test/shared-kernel/run-verdict.test.ts`
- `qa-engine/test/shared-kernel/result.test.ts`
- `qa-engine/test/shared-kernel/domain-error.test.ts`
- `qa-engine/test/shared-kernel/blast-radius.test.ts`
- `qa-engine/test/shared-kernel/objective.test.ts`
- `qa-engine/test/shared-kernel/run-outcome.test.ts` — **the Plan-1-compatibility pin**: a kernel `RunOutcome` assigns to legacy `src/types.ts` `RunOutcome` and round-trips the Plan-1 comparator.
- `qa-engine/test/shared-kernel/run-event.test.ts`
- `qa-engine/test/shared-infrastructure/process-sandbox/scrub-env.test.ts`
- `qa-engine/test/shared-infrastructure/process-sandbox/process-kill.test.ts`
- `qa-engine/test/contexts/ports-compile.test.ts` — a single typecheck-only test that imports every port barrel (proves the interfaces compile against the kernel and nothing external).
- `qa-engine/test/arch/vcs-write-confinement.test.ts` — the `dependency-cruiser` security gate.
- `qa-engine/.dependency-cruiser.cjs` — the arch-lint rule config (Task 12).

**Frozen (do NOT edit — Plan 1 boundary)**
- `src/pipeline.ts` `PipelineDeps` + `runPipeline`, `src/types.ts` `RunOutcome`, `contract/openapi.json`, all of `src/` runtime (except the `package.json` typecheck script).

---

## Task 0: Re-verify reality vs HEAD

The user edits `src/` in parallel; the snapshot drifts. Lock today's facts before depending on them. No code — a checklist run, recorded inline.

**Files:** none (records findings in the task notes / commit message of Task 1 if anything diverged).

- [ ] **Step 1: Confirm the kernel forward-edge still exists (must, per the locked decision)**

```bash
cd /Users/arielyumn/Desktop/TRABAJO/panchito
rg -n 'qa/learning/taxonomy|qa/usage' src/types.ts
```
Expected: 4 hits — `export type { ErrorClass } from "./qa/learning/taxonomy"` (:214), `import("./qa/learning/taxonomy").ErrorClass` (:223 and :266), `import("./qa/usage").RunUsage` (:245). If they moved, the kernel `RunOutcome` (Task 7) still must NOT reproduce them: `ErrorClass` stays in cross-run-learning, `RunUsage` in agent-runtime.

- [ ] **Step 2: Confirm the duplicate primitives are still duplicated**

```bash
rg -n 'function killTree' src/
rg -n 'export function scrubEnv' src/
rg -c 'import .*scrubEnv' src/qa/*.ts src/qa/**/*.ts src/server/*.ts
```
Expected: 4 `killTree` definitions (`src/qa/learning/mutation-code.ts:10`, `src/qa/static-signal/exec.ts:6`, `src/qa/code-runner.ts:64`, `src/qa/execute.ts:64`), 1 `scrubEnv` definition (`src/qa/code-runner.ts:73`), and ~8 import sites. If counts differ, the consolidated adapter (Task 9) and the moved `scrub-env.ts` (Task 10) are still copies of the canonical body — record the new count; the plan does NOT update `src/` import sites (Plan 6 Step 6 does).

- [ ] **Step 3: Confirm the kernel-resident types' exact shapes**

```bash
rg -n 'export type AgentRole' src/agent-runtime/types.ts src/contract/commands.ts
rg -n 'export interface RunOutcome' src/types.ts
rg -n 'export function engineStatus|RUN_ENGINE_STATUSES' src/types.ts
rg -n 'export const RunStepSchema' src/contract/events.ts
```
Expected: `AgentRole` in `src/agent-runtime/types.ts:8` has **8** members (`primary | reviewer | chat | worker | workerCode | maintainer | reflector | explorer`); the contract `AgentRoleSchema` (`commands.ts:240`) carries only **6** (no `reflector`/`explorer`) — the kernel uses the **8-member** runtime union (the contract enum is a narrower wire subset, NOT the domain vocabulary). `RunOutcome` at `src/types.ts:216`; `engineStatus`/`RUN_ENGINE_STATUSES` present; `RunStepSchema` present. Record any divergence; the kernel definitions below must match what you find.

- [ ] **Step 4: Confirm Plan 1 landed and the gate is green**

```bash
ls qa-engine/src qa-engine/test/characterization/goldens/*.json | head
rg -n '"typecheck"|"test"' package.json
npm run typecheck && echo "TYPECHECK OK"
```
Expected: `qa-engine/` scaffold + 10 goldens present; `typecheck` is currently `tsc --build --force` (the emit bug Task 1 fixes); `npm run typecheck` exits 0. If the goldens or the `qa-engine/test/**/*.test.ts` glob are absent, STOP — Plan 1 is not done and Plan 2 has no foundation.

---

## Task 1: Make `typecheck` no-emit again

Plan 1 set the root `typecheck` script to `tsc --build --force`, which **emits** `.d.ts`/`.tsbuildinfo` for the composite `qa-engine` reference (gitignored but noisy, and a behavior change from the original `tsc --noEmit`). Restore no-emit while still typechecking **both** trees.

**Files:**
- Modify: `package.json` (root) — `typecheck` script

- [ ] **Step 1: Read the current script**

```bash
cd /Users/arielyumn/Desktop/TRABAJO/panchito
rg -n '"typecheck"' package.json
```
Expected: `"typecheck": "tsc --build --force"`.

- [ ] **Step 2: Replace it with a no-emit pair**

In root `package.json` `scripts`, change:
```
"typecheck": "tsc --build --force"
```
to:
```
"typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p qa-engine/tsconfig.json"
```

> `qa-engine/tsconfig.json` has `emitDeclarationOnly: true` (+ `outDir`/`composite`) from Plan 1; `tsc --noEmit -p` overrides emit at the CLI, so no `.tsbuildinfo`/`.d.ts` is written. The root `tsconfig.json` keeps its `references: [{ "path": "./qa-engine" }]` (harmless under `--noEmit -p`; the explicit second invocation is what actually checks qa-engine). Both trees are still covered — the original Plan-1 intent — without the emit side effect.

- [ ] **Step 3: Remove any previously emitted artifacts (MANDATORY)**

```bash
rm -f qa-engine/*.tsbuildinfo
find qa-engine -name '*.d.ts' -not -path '*/node_modules/*' -delete
```
These are stale outputs from `--build --force`. Remove them before running the gate so a false-green from cached artifacts cannot hide a real typecheck failure.

- [ ] **Step 4: Run the gate; confirm no emit**

```bash
npm run typecheck && echo "TYPECHECK OK"
git status --porcelain qa-engine | rg '\.tsbuildinfo|\.d\.ts' && echo "EMIT LEAK (bad)" || echo "no emit leak"
```
Expected: `TYPECHECK OK`, then `no emit leak`.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "build(qa-engine): make typecheck no-emit again across both trees"
```

---

## Task 2: `Sha` value object

Replace the bare-string SHA with a hex-invariant VO. A `Sha` cannot be constructed from a non-hex or empty string — the invariant is enforced at the boundary, so the rest of the domain never re-validates.

**Files:**
- Create: `qa-engine/src/shared-kernel/sha.ts`
- Test: `qa-engine/test/shared-kernel/sha.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// qa-engine/test/shared-kernel/sha.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";

test("Sha: accepts a full 40-char hex sha and exposes value + short", () => {
  const s = Sha.of("a".repeat(40));
  assert.equal(s.value, "a".repeat(40));
  assert.equal(s.short, "aaaaaaa"); // 7 chars
  assert.equal(String(s), "a".repeat(40));
});

test("Sha: accepts an abbreviated hex sha (>= 7 chars)", () => {
  assert.equal(Sha.of("abc1234").value, "abc1234");
});

test("Sha: rejects empty, non-hex, and too-short input", () => {
  assert.throws(() => Sha.of(""), /Sha/);
  assert.throws(() => Sha.of("xyz1234"), /Sha/);
  assert.throws(() => Sha.of("abc"), /Sha/); // < 7
});

test("Sha: equals compares by value", () => {
  assert.equal(Sha.of("abc1234").equals(Sha.of("abc1234")), true);
  assert.equal(Sha.of("abc1234").equals(Sha.of("def5678")), false);
});

test("Sha: tryOf returns null instead of throwing on bad input", () => {
  assert.equal(Sha.tryOf("nope"), null);
  assert.equal(Sha.tryOf("abc1234")?.value, "abc1234");
});
```

- [ ] **Step 2: Run it (expected FAIL)**

```bash
node --import tsx --test qa-engine/test/shared-kernel/sha.test.ts
```
Expected: FAIL — `Cannot find module '@kernel/sha.ts'`.

- [ ] **Step 3: Write the VO**

```typescript
// qa-engine/src/shared-kernel/sha.ts
// A git commit SHA as a value object: hex, at least 7 chars (the conventional abbreviation floor),
// validated once at construction so the rest of the domain treats it as already-correct. Replaces
// the bare `sha: string` that flowed unchecked through the legacy pipeline.

const HEX_SHA = /^[0-9a-f]{7,40}$/;

export class Sha {
  private constructor(readonly value: string) {}

  static of(raw: string): Sha {
    const v = raw.trim().toLowerCase();
    if (!HEX_SHA.test(v)) {
      throw new Error(`Sha: not a valid commit sha (expected 7-40 hex chars): ${JSON.stringify(raw)}`);
    }
    return new Sha(v);
  }

  static tryOf(raw: string): Sha | null {
    const v = raw.trim().toLowerCase();
    return HEX_SHA.test(v) ? new Sha(v) : null;
  }

  get short(): string {
    return this.value.slice(0, 7);
  }

  equals(other: Sha): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
```

- [ ] **Step 4: Run it (expected PASS)**

```bash
node --import tsx --test qa-engine/test/shared-kernel/sha.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add qa-engine/src/shared-kernel/sha.ts qa-engine/test/shared-kernel/sha.test.ts
git commit -m "feat(kernel): Sha hex-invariant value object"
```

---

## Task 3: Verdict / status / mode / step / case enums (the ubiquitous-language enums)

Carry the verdict policy enums and `engineStatus()` VERBATIM from `src/types.ts` (the kernel becomes their single source of truth; the legacy file stays untouched for Plan 1 parity). These are pure types + one pure function — group them so the plan stays proportionate, but each ships a real test.

**Files:**
- Create: `qa-engine/src/shared-kernel/run-verdict.ts`, `qa-engine/src/shared-kernel/run-mode.ts`, `qa-engine/src/shared-kernel/run-step.ts`, `qa-engine/src/shared-kernel/qa-case.ts`
- Test: `qa-engine/test/shared-kernel/run-verdict.test.ts`

- [ ] **Step 1: Write the failing test (verdict + engineStatus is the load-bearing logic)**

```typescript
// qa-engine/test/shared-kernel/run-verdict.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { engineStatus, RUN_ENGINE_STATUSES, type RunVerdict } from "@kernel/run-verdict.ts";
import { RUN_MODES } from "@kernel/run-mode.ts";

test("engineStatus: invalid and infra-error are ERROR; everything else is SUCCESS", () => {
  assert.equal(engineStatus("invalid"), RUN_ENGINE_STATUSES.ERROR);
  assert.equal(engineStatus("infra-error"), RUN_ENGINE_STATUSES.ERROR);
  for (const v of ["pass", "fail", "flaky", "skipped"] as RunVerdict[]) {
    assert.equal(engineStatus(v), RUN_ENGINE_STATUSES.SUCCESS);
  }
});

test("engineStatus: null/undefined is fail-safe ERROR (no verdict ⇒ did not succeed)", () => {
  assert.equal(engineStatus(null), RUN_ENGINE_STATUSES.ERROR);
  assert.equal(engineStatus(undefined), RUN_ENGINE_STATUSES.ERROR);
});

test("RUN_MODES lists exactly the five run modes", () => {
  assert.deepEqual([...RUN_MODES], ["diff", "complete", "exhaustive", "manual", "context"]);
});
```

- [ ] **Step 2: Run it (expected FAIL — module missing)**

```bash
node --import tsx --test qa-engine/test/shared-kernel/run-verdict.test.ts
```
Expected: FAIL — `Cannot find module '@kernel/run-verdict.ts'`.

- [ ] **Step 3: Write the four enum modules (verbatim from `src/types.ts`)**

```typescript
// qa-engine/src/shared-kernel/run-verdict.ts
// The six-verdict test outcome and the user-facing engine status derived from it. Carried VERBATIM
// from src/types.ts (this is now the single source of truth; the legacy copy stays during Phase-1
// parity). engineStatus answers "did the engine produce a TRUSTWORTHY result?", not "did every test
// pass?": a real bug found (fail → Issue) is SUCCESS; only an unrunnable/un-producible run is ERROR.

export type RunVerdict = "pass" | "fail" | "flaky" | "invalid" | "infra-error" | "skipped";

export const RUN_ENGINE_STATUSES = { SUCCESS: "success", ERROR: "error" } as const;
export type RunEngineStatus = (typeof RUN_ENGINE_STATUSES)[keyof typeof RUN_ENGINE_STATUSES];

// Fail-safe: a null/undefined verdict (never recorded, or a wire value that never arrived) is ERROR.
export function engineStatus(verdict: RunVerdict | null | undefined): RunEngineStatus {
  return verdict == null || verdict === "infra-error" || verdict === "invalid"
    ? RUN_ENGINE_STATUSES.ERROR
    : RUN_ENGINE_STATUSES.SUCCESS;
}
```

```typescript
// qa-engine/src/shared-kernel/run-mode.ts
// Run mode, target, and trigger source — the orthogonal axes a run is parameterized on. Carried from
// src/types.ts. Only `diff` runs classifyCommit; the others always generate (CLAUDE.md "Run modes").

export type TestTarget = "e2e" | "code";
export type TriggerSource = "webhook" | "manual";
export type RunMode = "diff" | "complete" | "exhaustive" | "manual" | "context";
export const RUN_MODES: readonly RunMode[] = ["diff", "complete", "exhaustive", "manual", "context"] as const;
```

```typescript
// qa-engine/src/shared-kernel/run-step.ts
// The canonical pipeline-phase vocabulary for the progress stepper. Mirrors contract/events.ts
// RunStepSchema exactly (an unknown raw step is omitted, never invented). One source of truth so the
// orchestrator's phase labels and the wire enum cannot drift.

export type RunStep =
  | "gate" | "classify" | "setup" | "generate" | "validate"
  | "health" | "execute" | "coverage" | "retry" | "decide" | "done";
export const RUN_STEPS: readonly RunStep[] = [
  "gate", "classify", "setup", "generate", "validate",
  "health", "execute", "coverage", "retry", "decide", "done",
] as const;
```

```typescript
// qa-engine/src/shared-kernel/qa-case.ts
// One executed test case and the structured per-spec metadata the agent emits. Carried from
// src/types.ts (QaCase / CaseStatus / SpecMeta / SpecRecord). Optional runtime-evidence fields
// (failureDom, httpStatus, finalUrl) follow the absent-warned best-effort contract: absent ⇒ the run
// degrades to string-only behaviour, never a guessed value.

export type CaseStatus = "pass" | "fail" | "flaky";

export interface QaCase {
  name: string;
  status: CaseStatus;
  detail?: string;
  flow?: string;
  objective?: string;
  reason?: string;
  durationMs?: number;
  failureDom?: string;
  file?: string;
  httpStatus?: number;
  finalUrl?: string;
}

export interface SpecMeta {
  file: string;
  flow: string;
  objective: string;
  targets: string[];
  sha256?: string;
}

export interface SpecRecord {
  name: string;
  objective?: string;
  flow?: string;
}
```

- [ ] **Step 4: Run it (expected PASS)**

```bash
node --import tsx --test qa-engine/test/shared-kernel/run-verdict.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add qa-engine/src/shared-kernel/run-verdict.ts qa-engine/src/shared-kernel/run-mode.ts qa-engine/src/shared-kernel/run-step.ts qa-engine/src/shared-kernel/qa-case.ts qa-engine/test/shared-kernel/run-verdict.test.ts
git commit -m "feat(kernel): RunVerdict/engineStatus, RunMode, RunStep, QaCase vocabulary"
```

---

## Task 4: `Result<T,E>` (explicit error flow)

The kernel's discriminated-union result type — the spine of the loud-throw-vs-typed-error discipline (§8 R3). Pure, zero dependencies.

**Files:**
- Create: `qa-engine/src/shared-kernel/result.ts`
- Test: `qa-engine/test/shared-kernel/result.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// qa-engine/test/shared-kernel/result.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ok, err, isOk, isErr, map, unwrapOr, type Result } from "@kernel/result.ts";

test("ok carries a value and is recognized by isOk", () => {
  const r: Result<number, string> = ok(42);
  assert.equal(isOk(r), true);
  assert.equal(isErr(r), false);
  if (isOk(r)) assert.equal(r.value, 42);
});

test("err carries an error and is recognized by isErr", () => {
  const r: Result<number, string> = err("boom");
  assert.equal(isErr(r), true);
  if (isErr(r)) assert.equal(r.error, "boom");
});

test("map transforms ok, passes err through untouched", () => {
  assert.deepEqual(map(ok(2), (n) => n * 10), ok(20));
  assert.deepEqual(map(err<number, string>("e"), (n) => n * 10), err("e"));
});

test("unwrapOr returns the value on ok and the fallback on err", () => {
  assert.equal(unwrapOr(ok(7), 0), 7);
  assert.equal(unwrapOr(err<number, string>("e"), 0), 0);
});
```

- [ ] **Step 2: Run it (expected FAIL)**

```bash
node --import tsx --test qa-engine/test/shared-kernel/result.test.ts
```
Expected: FAIL — module missing.

- [ ] **Step 3: Write the type**

```typescript
// qa-engine/src/shared-kernel/result.ts
// Explicit success/failure flow without exceptions for the EXPECTED-failure paths (typed degradation,
// fail-open extractors). Loud-throw discipline (§8 R3) still governs UNEXPECTED faults — a swallowed
// integration error once looked like a silent false no-op; Result is for modeled outcomes, not for
// hiding throws.

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T, E = never>(value: T): Result<T, E> {
  return { ok: true, value };
}

export function err<T = never, E = unknown>(error: E): Result<T, E> {
  return { ok: false, error };
}

export function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
  return r.ok;
}

export function isErr<T, E>(r: Result<T, E>): r is { ok: false; error: E } {
  return !r.ok;
}

export function map<T, U, E>(r: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return r.ok ? ok(fn(r.value)) : r;
}

export function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T {
  return r.ok ? r.value : fallback;
}
```

- [ ] **Step 4: Run it (expected PASS)**

```bash
node --import tsx --test qa-engine/test/shared-kernel/result.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add qa-engine/src/shared-kernel/result.ts qa-engine/test/shared-kernel/result.test.ts
git commit -m "feat(kernel): Result<T,E> for explicit error flow"
```

---

## Task 5: `InfraError` taxonomy

Carry the sealed infra-error taxonomy from `src/errors.ts` VERBATIM into the kernel `domain-error.ts` (the spec places `StalledAgentError` here explicitly). The name-fallback `isInfraError` must survive cross-realm `instanceof` failure.

**Files:**
- Create: `qa-engine/src/shared-kernel/domain-error.ts`
- Test: `qa-engine/test/shared-kernel/domain-error.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// qa-engine/test/shared-kernel/domain-error.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { InfraError, AgentUnavailableError, StalledAgentError, isInfraError } from "@kernel/domain-error.ts";

test("the taxonomy is a sealed hierarchy: agent errors are InfraErrors", () => {
  assert.ok(new AgentUnavailableError("x") instanceof InfraError);
  assert.ok(new StalledAgentError("x") instanceof InfraError);
  assert.equal(new AgentUnavailableError("x").name, "AgentUnavailableError");
  assert.equal(new StalledAgentError("x").name, "StalledAgentError");
});

test("isInfraError recognizes the taxonomy by instanceof", () => {
  assert.equal(isInfraError(new InfraError("x")), true);
  assert.equal(isInfraError(new AgentUnavailableError("x")), true);
  assert.equal(isInfraError(new StalledAgentError("x")), true);
  assert.equal(isInfraError(new Error("ordinary")), false);
});

test("isInfraError falls back to name + operator-cancel message across realms", () => {
  const crossRealm = new Error("oops");
  crossRealm.name = "StalledAgentError";
  assert.equal(isInfraError(crossRealm), true);
  assert.equal(isInfraError(new Error("run cancelled by operator")), true);
  assert.equal(isInfraError({ name: "InfraError" }), false); // not an Error instance
});

test("cause is preserved when provided", () => {
  const cause = new Error("root");
  assert.equal((new InfraError("x", { cause }) as { cause?: unknown }).cause, cause);
});
```

- [ ] **Step 2: Run it (expected FAIL)**

```bash
node --import tsx --test qa-engine/test/shared-kernel/domain-error.test.ts
```
Expected: FAIL — module missing.

- [ ] **Step 3: Write the taxonomy (verbatim from `src/errors.ts`)**

```typescript
// qa-engine/src/shared-kernel/domain-error.ts
// Sealed error taxonomy for the run pipeline. An error is classified by its TYPE, never by
// substring-matching the message. InfraError ⇒ the run was inconclusive because of the ENVIRONMENT
// (DEV down, deploy gate, git/network), not a code/test fault and not an orchestrator defect.
// Carried from src/errors.ts; the spec places StalledAgentError in the kernel InfraError taxonomy.

export class InfraError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "InfraError";
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

// The AI agent layer could not produce a result for a NON-code reason (provider rejected/rate-limited/
// length-limited/aborted/5xx). Its own type so the run surfaces an agent-specific operator message
// and is never mistaken for an orchestrator defect or a code/test verdict.
export class AgentUnavailableError extends InfraError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentUnavailableError";
  }
}

// The agent produced no activity for longer than the liveness-watchdog window — engine resilience,
// not the DEV environment. Still inconclusive (no verdict); distinct from AgentUnavailableError so
// alert routing can be specific.
export class StalledAgentError extends InfraError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StalledAgentError";
  }
}

// True when a thrown error is genuine infrastructure. The name fallbacks cover cross-realm cases where
// `instanceof` fails (e.g. an SDK loaded in two module realms); the message check covers operator cancel.
export function isInfraError(err: unknown): boolean {
  if (err instanceof InfraError) return true;
  if (err instanceof Error && (err.name === "InfraError" || err.name === "AgentUnavailableError" || err.name === "StalledAgentError" || err.name === "DeployTimeoutError")) return true;
  if (err instanceof Error && /\brun cancelled by operator\b/i.test(err.message)) return true;
  return false;
}
```

- [ ] **Step 4: Run it (expected PASS)**

```bash
node --import tsx --test qa-engine/test/shared-kernel/domain-error.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add qa-engine/src/shared-kernel/domain-error.ts qa-engine/test/shared-kernel/domain-error.test.ts
git commit -m "feat(kernel): InfraError taxonomy (Infra/AgentUnavailable/StalledAgent)"
```

---

## Task 6: `BlastRadius`, `Objective` + `Flow` (the NEW domain concepts)

These do NOT exist as types today — the kernel CREATES them, promoted from scattered fields (the diff/changed-files that flow through classify+coverage become `BlastRadius`; the planner's per-objective `{flow, objective, targets}` become `Objective`). They are immutable read-models with light invariants.

**Files:**
- Create: `qa-engine/src/shared-kernel/blast-radius.ts`, `qa-engine/src/shared-kernel/objective.ts`
- Test: `qa-engine/test/shared-kernel/blast-radius.test.ts`, `qa-engine/test/shared-kernel/objective.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// qa-engine/test/shared-kernel/blast-radius.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";

test("BlastRadius: groups changed files under a Sha and is immutable", () => {
  const br = BlastRadius.of(Sha.of("abc1234"), ["src/a.ts", "src/b.ts"]);
  assert.equal(br.sha.value, "abc1234");
  assert.deepEqual(br.changedFiles, ["src/a.ts", "src/b.ts"]);
  assert.equal(br.isEmpty, false);
  assert.throws(() => { (br.changedFiles as string[]).push("x"); }); // frozen
});

test("BlastRadius: dedupes and sorts changed files for a deterministic identity", () => {
  const br = BlastRadius.of(Sha.of("abc1234"), ["src/b.ts", "src/a.ts", "src/b.ts"]);
  assert.deepEqual(br.changedFiles, ["src/a.ts", "src/b.ts"]);
});

test("BlastRadius: empty changed-file set is reported as empty", () => {
  assert.equal(BlastRadius.of(Sha.of("abc1234"), []).isEmpty, true);
});
```

```typescript
// qa-engine/test/shared-kernel/objective.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Objective, Flow } from "@kernel/objective.ts";

test("Flow: is a non-empty named user flow", () => {
  assert.equal(Flow.of("login").name, "login");
  assert.throws(() => Flow.of("  "), /Flow/);
});

test("Objective: binds a Flow to an acceptance criterion + targets", () => {
  const o = Objective.of({ flow: "login", objective: "user can sign in", targets: ["/login", "AuthForm"] });
  assert.equal(o.flow.name, "login");
  assert.equal(o.objective, "user can sign in");
  assert.deepEqual(o.targets, ["/login", "AuthForm"]);
});

test("Objective: rejects an empty objective and freezes targets", () => {
  assert.throws(() => Objective.of({ flow: "login", objective: "", targets: [] }), /Objective/);
  const o = Objective.of({ flow: "login", objective: "x", targets: ["a"] });
  assert.throws(() => { (o.targets as string[]).push("b"); });
});
```

- [ ] **Step 2: Run them (expected FAIL)**

```bash
node --import tsx --test qa-engine/test/shared-kernel/blast-radius.test.ts qa-engine/test/shared-kernel/objective.test.ts
```
Expected: FAIL — modules missing.

- [ ] **Step 3: Write the VOs**

```typescript
// qa-engine/src/shared-kernel/blast-radius.ts
// NEW kernel concept: the set of files a commit changed, keyed by its Sha — the unit the analyze and
// coverage phases reason over. Promoted from the bare diff/changed-files strings that flowed
// untyped through the legacy pipeline. Immutable, deterministic identity (deduped + sorted).

import { Sha } from "./sha.ts";

export class BlastRadius {
  private constructor(readonly sha: Sha, readonly changedFiles: readonly string[]) {}

  static of(sha: Sha, changedFiles: readonly string[]): BlastRadius {
    const normalized = Object.freeze([...new Set(changedFiles)].sort());
    return new BlastRadius(sha, normalized);
  }

  get isEmpty(): boolean {
    return this.changedFiles.length === 0;
  }
}
```

```typescript
// qa-engine/src/shared-kernel/objective.ts
// NEW kernel concept: one planned generation objective — a named user Flow + the acceptance criterion
// + the symbols/routes it exercises. Promoted from the planner's scattered {flow, objective, targets}
// fields so fan-out and manifest reconciliation share one typed unit instead of loose strings.

export class Flow {
  private constructor(readonly name: string) {}
  static of(name: string): Flow {
    const n = name.trim();
    if (n.length === 0) throw new Error("Flow: name must be non-empty");
    return new Flow(n);
  }
}

export class Objective {
  private constructor(
    readonly flow: Flow,
    readonly objective: string,
    readonly targets: readonly string[],
  ) {}

  static of(input: { flow: string; objective: string; targets: readonly string[] }): Objective {
    const obj = input.objective.trim();
    if (obj.length === 0) throw new Error("Objective: acceptance criterion must be non-empty");
    return new Objective(Flow.of(input.flow), obj, Object.freeze([...input.targets]));
  }
}
```

- [ ] **Step 4: Run them (expected PASS)**

```bash
node --import tsx --test qa-engine/test/shared-kernel/blast-radius.test.ts qa-engine/test/shared-kernel/objective.test.ts
```
Expected: PASS (3 + 3 tests).

- [ ] **Step 5: Commit**

```bash
git add qa-engine/src/shared-kernel/blast-radius.ts qa-engine/src/shared-kernel/objective.ts qa-engine/test/shared-kernel/blast-radius.test.ts qa-engine/test/shared-kernel/objective.test.ts
git commit -m "feat(kernel): BlastRadius + Objective/Flow domain value objects"
```

---

## Task 7: kernel `RunOutcome` + `AgentRole`/`RoleAssignment` + `RunEvent` + `contract` re-export

The kernel-owned `RunOutcome` MUST stay **structurally compatible** with legacy `src/types.ts` `RunOutcome` so Plan 1's comparator works against both — but WITHOUT reproducing the forward edge: `errorClass` is a kernel-local string-literal `ErrorClass` alias (NOT imported from `qa/learning/taxonomy`), and `usage` is `unknown` (the real `RunUsage` stays in agent-runtime; the kernel never forward-depends on it). `AgentRole`/`RoleAssignment` are kernel-resident because `AgentRuntimePort.openSession()` takes them (§5.1 P3). `RunEvent`/`contract` re-export the frozen wire surface from `src/contract/*`.

**Files:**
- Create: `qa-engine/src/shared-kernel/agent-role.ts`, `qa-engine/src/shared-kernel/run-event.ts`, `qa-engine/src/shared-kernel/run-outcome.ts`, `qa-engine/src/shared-kernel/contract/index.ts`
- Test: `qa-engine/test/shared-kernel/run-outcome.test.ts`, `qa-engine/test/shared-kernel/run-event.test.ts`

- [ ] **Step 1: Write the failing compatibility test (the Plan-1 pin)**

```typescript
// qa-engine/test/shared-kernel/run-outcome.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunOutcome as KernelRunOutcome } from "@kernel/run-outcome.ts";
import type { RunOutcome as LegacyRunOutcome } from "../../../src/types.ts";
import { runOutcomeEquivalent, type ComparableOutcome } from "../characterization/equivalence.ts";

// Structural-compatibility pin (legacy → kernel only): a legacy RunOutcome must be assignable TO the
// kernel shape. The kernel fields are intentionally WIDE (errorClass: string | null, usage?: unknown,
// reflection?: unknown) so any legacy value satisfies the kernel type. The reverse (kernel → legacy)
// is NOT required: the kernel is a supertype, not an isomorphic copy, and the Plan-1 comparator works
// on a behavioral projection (ComparableOutcome) that does not read usage/reflection — so wide kernel
// types are fine. This test pins the direction that matters: legacy → kernel.
test("kernel RunOutcome is structurally assignable FROM legacy RunOutcome (legacy → kernel)", () => {
  const kernel: KernelRunOutcome = {
    runId: "r1", app: "demo", sha: "abc1234", mode: "diff", target: "e2e",
    verdict: "pass", errorClass: null,
    gateSignals: { static: true, coverageRatio: 0.8, valueScore: null, reviewerCorrections: [], reviewerApproved: true, flaky: false, retries: 0 },
    rulesRetrieved: [], at: "2026-06-24T00:00:00.000Z",
  };
  const asLegacy: LegacyRunOutcome = kernel as unknown as LegacyRunOutcome; // narrowing (legacy is a subtype of kernel)
  const asKernel: KernelRunOutcome = asLegacy; // legacy → kernel: legacy is a structural subtype, always assignable
  assert.equal(asKernel.verdict, "pass");

  // and the Plan-1 comparator accepts it
  const comparable: ComparableOutcome = { ...kernel };
  assert.equal(runOutcomeEquivalent(comparable, comparable).equal, true);
});
```

```typescript
// qa-engine/test/shared-kernel/run-event.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { RunEventSchema, type RunEvent, type AgentRole } from "@kernel/run-event.ts";

test("RunEvent re-exports the frozen wire schema and parses a valid envelope", () => {
  const ev: RunEvent = RunEventSchema.parse({
    seq: 0, runId: "r1", ts: 0,
    body: { type: "run.verdict", verdict: "pass", engineStatus: "success" },
  });
  assert.equal(ev.body.type, "run.verdict");
});

test("AgentRole carries all 8 runtime roles (kernel-resident vocabulary)", () => {
  // NOTE: this checks an array literal length, not the type union — it cannot catch a new member
  // added to the union but omitted from the array. For exhaustiveness at the type level, add a
  // `Record<AgentRole, true>` check:
  //   const _exhaustive: Record<AgentRole, true> = { primary: true, reviewer: true, ... };
  // That would cause a compile error if the union gains a member not in the object. Left as an
  // array check here since the kernel union is frozen for this plan; upgrade to the Record pattern
  // if AgentRole ever becomes extensible.
  const roles: AgentRole[] = ["primary", "reviewer", "chat", "worker", "workerCode", "maintainer", "reflector", "explorer"];
  assert.equal(roles.length, 8);
});
```

- [ ] **Step 2: Run them (expected FAIL)**

```bash
node --import tsx --test qa-engine/test/shared-kernel/run-outcome.test.ts qa-engine/test/shared-kernel/run-event.test.ts
```
Expected: FAIL — modules missing.

- [ ] **Step 3: Write `agent-role.ts`**

```typescript
// qa-engine/src/shared-kernel/agent-role.ts
// WHO the agent is (role) and WHICH provider+model serves it. Kernel-resident because
// AgentRuntimePort.openSession() takes `role: AgentRole` and `RoleAssignment` appears in the port
// surface — placing them here keeps the kernel from forward-depending on agent-runtime/ (§5.1 P3).
// The 8 roles are the runtime union (src/agent-runtime/types.ts); the contract AgentRoleSchema is a
// narrower 6-member WIRE subset, not the domain vocabulary.

export type AgentRole =
  | "primary" | "reviewer" | "chat" | "worker"
  | "workerCode" | "maintainer" | "reflector" | "explorer";

export type AgentProvider = "opencode" | "codex";

export interface RoleAssignment {
  provider: AgentProvider;
  model: string;
}

// What a role is structurally allowed to do — the provider-agnostic capability policy. The judge, the
// read-only chat, the one-shot reflector, and the explorer never mutate the workspace.
export interface RoleCapabilities {
  canWrite: boolean;
}

const READ_ONLY_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>(["reviewer", "chat", "reflector", "explorer"]);

export function capabilitiesForRole(role: AgentRole): RoleCapabilities {
  return { canWrite: !READ_ONLY_ROLES.has(role) };
}
```

- [ ] **Step 4: Write the `contract` re-export and `run-event.ts`**

```typescript
// qa-engine/src/shared-kernel/contract/index.ts
// The FROZEN external wire surface, re-exported from src/contract/* so the kernel owns one canonical
// reference to it without copying the zod schemas (which codegen the SDK; openapi.json is frozen by
// the Plan-1 drift-guard). The kernel re-exports; it does not redefine.
//
// SELECTIVE re-export only: AgentRole, AgentProvider, and RoleAssignment are EXCLUDED because the
// kernel owns canonical versions in agent-role.ts. Re-exporting the 6-member wire AgentRole from
// commands.ts would silently shadow the 8-member kernel union. Analytics view DTOs (TrendsViewSchema,
// ReportViewSchema, IntelligenceViewSchema) are excluded — they belong to the analytics surface.

// All events exports are safe (events.ts does not export AgentRole/AgentProvider/RoleAssignment).
export * from "../../../../src/contract/events.ts";

// Selective commands exports — only wire/run surface, excluding kernel-owned names and analytics DTOs.
export {
  AgentRoleSchema as ContractAgentRoleSchema,
  AgentProviderSchema,
  AgentRuntimeModeSchema,
  RunPipelineCommandSchema,
  // Excluded: AgentRole, AgentProvider, RoleAssignment (kernel owns canonical versions).
  // Excluded: TrendsViewSchema, ReportViewSchema, IntelligenceViewSchema (analytics surface).
} from "../../../../src/contract/commands.ts";
```

```typescript
// qa-engine/src/shared-kernel/run-event.ts
// The closed RunEvent domain-event vocabulary — re-exported from the frozen contract so the kernel
// exposes ONE import path for the live-stream events while the wire schema stays the single source of
// truth. Adding a variant means adding it to contract/events.ts, never here. AgentRole is re-exported
// alongside so kernel consumers import event + role vocabulary from one place.

export {
  RunEventSchema,
  RunEventBodySchema,
  type RunEvent,
  type RunEventBody,
  type RunEventType,
} from "./contract/index.ts";

export type { AgentRole, RoleAssignment, AgentProvider } from "./agent-role.ts";
```

- [ ] **Step 5: Write the kernel `RunOutcome`**

```typescript
// qa-engine/src/shared-kernel/run-outcome.ts
// The immutable record of a finished run — consumed from here by qa-run-orchestration AND
// cross-run-learning (neither depends on the other). Structurally COMPATIBLE with legacy
// src/types.ts RunOutcome in the legacy → kernel direction — but WITHOUT the forward edge:
// errorClass is `string | null` (the legacy ErrorClass string-literal union ⊆ string),
// usage is `unknown` (the real RunUsage stays in agent-runtime; §5.1 P3), and reflection
// is `unknown` (the real StructuredReflection stays in cross-run-learning). The kernel types
// are intentionally WIDE so any legacy value satisfies them. Do NOT import ErrorClass,
// RunUsage, or StructuredReflection from src/ — that re-introduces the kernel→downstream edge.

import type { RunMode, TestTarget } from "./run-mode.ts";
import type { RunVerdict } from "./run-verdict.ts";

// Wide kernel alias: string is a supertype of the legacy ErrorClass string-literal union,
// so legacy values always satisfy this type without importing from downstream contexts.
export type ErrorClass = string | null;

export interface RunOutcome {
  runId: string;
  app: string;
  sha: string;
  mode: RunMode;
  target: TestTarget;
  verdict: RunVerdict;
  errorClass: ErrorClass;
  gateSignals: {
    static: boolean;
    coverageRatio: number | null;
    valueScore: number | null;
    reviewerCorrections: string[];
    reviewerRationale?: string;
    reviewerApproved?: boolean;
    flaky: boolean;
    retries: number;
    confinement?: { strays: number; dangerous: number; reverted: string[] };
    // Wide: the real type is agent-runtime's RunUsage; `unknown` keeps the kernel
    // free of downstream dependencies. Adapters narrow at their boundary.
    usage?: unknown;
    phaseTimings?: Record<string, number>;
    preExecAmbiguityCatches?: number;
    deterministicSelectorBlocks?: number;
  };
  rulesRetrieved: string[];
  // Wide: the real type is cross-run-learning's StructuredReflection; `unknown` for the same reason.
  reflection?: unknown;
  at: string;
}
```

> **Compatibility direction.** The kernel fields are WIDE supertypes of their legacy counterparts: `errorClass: string | null` ⊇ legacy `ErrorClass | null` (string-literal union); `usage?: unknown` ⊇ legacy `usage?: RunUsage`; `reflection?: unknown` ⊇ legacy `reflection?: StructuredReflection`. This means `legacy → kernel` always assigns. The reverse (`kernel → legacy`) is NOT required and NOT tested — the kernel is a supertype, not an isomorphic copy. The Plan-1 comparator (`ComparableOutcome`) operates on a behavioral projection that does not read `usage`/`reflection`, so wide kernel types do not affect parity. Keep `import type` of `ErrorClass`/`RunUsage`/`StructuredReflection` out of this file.

- [ ] **Step 6: Run the tests (expected PASS) and the full typecheck**

```bash
node --import tsx --test qa-engine/test/shared-kernel/run-outcome.test.ts qa-engine/test/shared-kernel/run-event.test.ts
npm run typecheck && echo "TYPECHECK OK"
```
Expected: PASS (1 + 2 tests), then `TYPECHECK OK` (the kernel↔legacy assignability holds under strict).

- [ ] **Step 7: Commit**

```bash
git add qa-engine/src/shared-kernel/agent-role.ts qa-engine/src/shared-kernel/run-event.ts qa-engine/src/shared-kernel/run-outcome.ts qa-engine/src/shared-kernel/contract/index.ts qa-engine/test/shared-kernel/run-outcome.test.ts qa-engine/test/shared-kernel/run-event.test.ts
git commit -m "feat(kernel): RunOutcome (legacy-compatible), AgentRole, RunEvent + contract re-export"
```

---

## Task 8: kernel ports — `RedactionPort`, `ClockPort`, `DeployGatePort`, `ProcessKillPort`

The three kernel ports plus the `ProcessKillPort` interface (the interface lives in the kernel; its concrete adapter is in shared-infrastructure, Task 9). Interfaces only — no impl. A compile test pins the shapes.

`DeployGatePort` is a cross-cutting infrastructure port: the deploy gate is consumed by both `qa-run-orchestration` (the orchestrator must wait for DEV before running) and `test-execution` (the execution context also gates on deploy health). Because neither context exclusively owns the concept — and a port in one context cannot be imported from another at the port layer — it lives in the kernel alongside `RedactionPort` and `ClockPort`.

**Files:**
- Create: `qa-engine/src/shared-kernel/ports/redaction.port.ts`, `qa-engine/src/shared-kernel/ports/clock.port.ts`, `qa-engine/src/shared-kernel/ports/deploy-gate.port.ts`, `qa-engine/src/shared-kernel/process-sandbox/process-kill.port.ts`
- Test: covered by `qa-engine/test/contexts/ports-compile.test.ts` (Task 11); no behavior to assert on a bare interface.

- [ ] **Step 1: Write `redaction.port.ts`**

```typescript
// qa-engine/src/shared-kernel/ports/redaction.port.ts
// The ONE canonical secret-redaction seam. Replaces the two divergent src/ implementations
// (orchestrator/sanitizer.ts [REDACTED_SECRET] and util/redact.ts [REDACTED_CREDENTIAL]); the
// canonical placeholder in the rewrite is [REDACTED]. Everything leaving the system (diff → model,
// execution logs → Issue) passes through an adapter of this port. The adapter is wired in
// workspace-and-publication's egress sanitization (Plan 4); the port lives in the kernel.

export const REDACTED = "[REDACTED]";

export interface RedactionPort {
  // Returns text with every detected secret replaced by REDACTED. Pure and deterministic.
  redact(text: string): string;
  // True when the text still contains a detectable secret AFTER redaction would run — used by the
  // egress guard to fail loudly rather than ship a leak.
  containsSecret(text: string): boolean;
}
```

- [ ] **Step 2: Write `clock.port.ts`**

```typescript
// qa-engine/src/shared-kernel/ports/clock.port.ts
// Determinism seam for time. The legacy code calls Date.now()/new Date() inline, which makes
// outcomes non-reproducible and the characterization net flaky on `at` timestamps. The orchestrator
// reads time ONLY through this port; tests inject a fixed clock so RunOutcome.at is deterministic.

export interface ClockPort {
  nowMs(): number;        // epoch milliseconds
  nowIso(): string;       // ISO-8601, the format RunOutcome.at / RunRecord.at use
}
```

- [ ] **Step 3: Write `deploy-gate.port.ts`**

```typescript
// qa-engine/src/shared-kernel/ports/deploy-gate.port.ts
// Cross-cutting infra port for the deploy gate. Both qa-run-orchestration (the orchestrator waits
// for DEV before running any phase) and test-execution (the harness confirms DEV health before
// executing Playwright) consume this port. Neither context owns it exclusively — a port in one
// context cannot be imported at the port layer from another — so it lives in the kernel.
// [SWAP] absent for static sites and the code target (adapter returns ok(true) immediately).

import type { Result } from "@kernel/result.ts";
import type { InfraError } from "@kernel/domain-error.ts";
import type { Sha } from "@kernel/sha.ts";

export interface DeployGatePort {
  waitUntilServing(sha: Sha): Promise<Result<true, InfraError>>;
}
```

- [ ] **Step 4: Write `process-kill.port.ts`**

```typescript
// qa-engine/src/shared-kernel/process-sandbox/process-kill.port.ts
// The seam over the consolidated killTree (4 identical definitions today: execute.ts, code-runner.ts,
// static-signal/exec.ts, learning/mutation-code.ts). The interface lives in the kernel; the concrete
// child_process adapter lives in shared-infrastructure (a process-group kill is infra, not pure
// domain). Extracting this breaks the execute ⇄ dom-snapshot runtime cycle in later plans.

import type { ChildProcess } from "node:child_process";

export interface ProcessKillPort {
  // Kills a spawned process AND its descendants (process-group kill for detached children), falling
  // back to a direct kill if the group send fails.
  killTree(child: ChildProcess): void;
}
```

> `node:child_process` is a Node built-in (a TYPE import here), not a downstream context — the kernel-no-forward-dependency rule forbids depending on `contexts/*`, not on Node platform types. The `ChildProcess` type keeps the port signature honest; the impl is in shared-infrastructure.

- [ ] **Step 5: Typecheck (no test yet — interfaces compile via Task 11)**

```bash
npm run typecheck && echo "TYPECHECK OK"
```
Expected: `TYPECHECK OK`.

- [ ] **Step 6: Commit**

```bash
git add qa-engine/src/shared-kernel/ports/redaction.port.ts qa-engine/src/shared-kernel/ports/clock.port.ts qa-engine/src/shared-kernel/ports/deploy-gate.port.ts qa-engine/src/shared-kernel/process-sandbox/process-kill.port.ts
git commit -m "feat(kernel): RedactionPort, ClockPort, DeployGatePort, ProcessKillPort interfaces"
```

---

## Task 9: shared-infrastructure — the consolidated `process-kill` adapter + sandboxed runner

The ONE concrete `killTree` (consolidating the 4 identical `src/` definitions), behind `ProcessKillPort`, plus the shared spawn-wrapper interface. This is `child_process` code → it lives in `shared-infrastructure/`, NOT the kernel. It does NOT touch the 4 `src/` call sites (Plan 6 Step 6 migrates those imports).

**Files:**
- Create: `qa-engine/src/shared-infrastructure/process-sandbox/process-kill.adapter.ts`, `qa-engine/src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts`
- Test: `qa-engine/test/shared-infrastructure/process-sandbox/process-kill.test.ts`

- [ ] **Step 1: Write the failing test (a fake ChildProcess proves the group-then-fallback path)**

```typescript
// qa-engine/test/shared-infrastructure/process-sandbox/process-kill.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { ProcessKillAdapter } from "../../../src/shared-infrastructure/process-sandbox/process-kill.adapter.ts";
// Import depth: from qa-engine/test/shared-infrastructure/process-sandbox/ → qa-engine/src/ is 3 levels up
// (../../../). 4 levels would reach the repo root (panchito/src/), which is wrong.

function fakeChild(pid: number | undefined, killSpy: string[]): ChildProcess {
  return { pid, kill(sig?: string) { killSpy.push(`direct:${sig}`); return true; } } as unknown as ChildProcess;
}

test("killTree signals the whole process group when a pid is present", () => {
  const calls: Array<[number, string]> = [];
  const adapter = new ProcessKillAdapter((pid, sig) => { calls.push([pid, sig]); });
  adapter.killTree(fakeChild(1234, []));
  assert.deepEqual(calls, [[-1234, "SIGKILL"]]); // negative pid ⇒ process group
});

test("killTree falls back to a direct kill when the group send throws", () => {
  const spy: string[] = [];
  const adapter = new ProcessKillAdapter(() => { throw new Error("ESRCH"); });
  adapter.killTree(fakeChild(1234, spy));
  assert.deepEqual(spy, ["direct:SIGKILL"]);
});

test("killTree kills directly when there is no pid", () => {
  const spy: string[] = [];
  const adapter = new ProcessKillAdapter(() => { throw new Error("should not be called"); });
  adapter.killTree(fakeChild(undefined, spy));
  assert.deepEqual(spy, ["direct:SIGKILL"]);
});
```

- [ ] **Step 2: Run it (expected FAIL)**

```bash
node --import tsx --test qa-engine/test/shared-infrastructure/process-sandbox/process-kill.test.ts
```
Expected: FAIL — module missing.

- [ ] **Step 3: Write the adapter (the consolidated body; `process.kill` injected for testability)**

```typescript
// qa-engine/src/shared-infrastructure/process-sandbox/process-kill.adapter.ts
// The ONE killTree — consolidates the 4 identical src/ definitions (execute.ts:64, code-runner.ts:64,
// static-signal/exec.ts:6, learning/mutation-code.ts:10). Spawns are detached so the child leads its
// own process group; process.kill(-pid) signals the whole group (npm/mvn/gradle/playwright fork
// grandchildren a plain child.kill() would orphan). Falls back to a direct kill if the group send
// fails (e.g. the child already exited). process.kill is injected so the group path is unit-testable.

import type { ChildProcess } from "node:child_process";
import type { ProcessKillPort } from "../../shared-kernel/process-sandbox/process-kill.port.ts";

type KillFn = (pid: number, signal: NodeJS.Signals) => void;

export class ProcessKillAdapter implements ProcessKillPort {
  constructor(private readonly kill: KillFn = (pid, sig) => { process.kill(pid, sig); }) {}

  killTree(child: ChildProcess): void {
    try {
      if (child.pid) this.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }
}
```

- [ ] **Step 4: Write the sandboxed-binary-runner seam**

```typescript
// qa-engine/src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts
// The shared spawn wrapper: a single entry point for running an untrusted/external binary with a
// scrubbed env and a process-tree kill on timeout/abort. Consolidates the spawn-then-killTree pattern
// duplicated across execute/code-runner/static-signal. v1 ships the interface + a thin default; the
// rich impl (privilege-drop sandbox, failure-capture wiring) lands when callers migrate (Plan 6).

import type { ProcessKillPort } from "../../shared-kernel/process-sandbox/process-kill.port.ts";

export interface SandboxedRunRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;     // already scrubbed (see scrub-env.ts)
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SandboxedRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SandboxedBinaryRunner {
  run(req: SandboxedRunRequest): Promise<SandboxedRunResult>;
}

// Constructor seam only in v1: the concrete spawn body is intentionally deferred to the adapter plans
// so this file stays a stable contract. It declares the ProcessKillPort dependency the real runner
// will consume, keeping the wiring explicit.
export interface SandboxedBinaryRunnerDeps {
  processKill: ProcessKillPort;
}
```

- [ ] **Step 5: Run the test (expected PASS) + typecheck**

```bash
node --import tsx --test qa-engine/test/shared-infrastructure/process-sandbox/process-kill.test.ts
npm run typecheck && echo "TYPECHECK OK"
```
Expected: PASS (3 tests), `TYPECHECK OK`.

- [ ] **Step 6: Commit**

```bash
git add qa-engine/src/shared-infrastructure/process-sandbox/process-kill.adapter.ts qa-engine/src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts qa-engine/test/shared-infrastructure/process-sandbox/process-kill.test.ts
git commit -m "feat(infra): consolidated ProcessKill adapter + sandboxed-binary-runner seam"
```

---

## Task 10: shared-infrastructure — the moved `scrubEnv`

Move the `scrubEnv` env-allowlist sandbox layer (1 definition + ~8 import sites in `src/`) into shared-infrastructure. This is the import-migration target: the new canonical body lives here; `src/` callers migrate in Plan 6 (this plan does NOT edit them). Behavior must be byte-for-byte identical to `src/qa/code-runner.ts:73`.

**Files:**
- Create: `qa-engine/src/shared-infrastructure/process-sandbox/scrub-env.ts`
- Test: `qa-engine/test/shared-infrastructure/process-sandbox/scrub-env.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// qa-engine/test/shared-infrastructure/process-sandbox/scrub-env.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubEnv } from "../../../src/shared-infrastructure/process-sandbox/scrub-env.ts";
// NOTE: 3 leading ../ from qa-engine/test/shared-infrastructure/process-sandbox/ to qa-engine/src/

// Safe env restore: `process.env = orig` assigns Record<string,string|undefined> to NodeJS.ProcessEnv
// and fails strict typecheck. Use per-key save/restore instead: delete keys added during the test,
// then Object.assign to restore modified values.

test("scrubEnv drops secrets even if extraAllowed would match", () => {
  const added = ["GITHUB_TOKEN", "DOPPLER_TOKEN"] as const;
  const saved: Partial<Record<string, string>> = {};
  for (const k of added) { saved[k] = process.env[k]; process.env[k] = k === "GITHUB_TOKEN" ? "ghp_secret" : "dp_secret"; }
  try {
    const out = scrubEnv(/^GITHUB_/); // even though caller widens to GITHUB_*, secrets stay blocked
    assert.equal("GITHUB_TOKEN" in out, false);
    assert.equal("DOPPLER_TOKEN" in out, false);
  } finally {
    for (const k of added) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test("scrubEnv keeps OS + language essentials and forwards PLAYWRIGHT_BROWSERS_PATH", () => {
  const added = ["PATH", "PLAYWRIGHT_BROWSERS_PATH"] as const;
  const saved: Partial<Record<string, string>> = {};
  for (const k of added) saved[k] = process.env[k];
  try {
    process.env.PATH = "/usr/bin";
    process.env.PLAYWRIGHT_BROWSERS_PATH = "/ms-playwright";
    const out = scrubEnv();
    assert.equal(out.PATH, "/usr/bin");
    assert.equal(out.PLAYWRIGHT_BROWSERS_PATH, "/ms-playwright");
  } finally {
    for (const k of added) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test("scrubEnv honors an extra allow prefix for non-secret vars (e2e DEV_*)", () => {
  const key = "DEV_LOGIN_USER";
  const savedVal = process.env[key];
  try {
    process.env[key] = "alice";
    assert.equal(scrubEnv(/^DEV_/)[key], "alice");
    assert.equal(key in scrubEnv(), false); // dropped without the widening
  } finally {
    if (savedVal === undefined) delete process.env[key]; else process.env[key] = savedVal;
  }
});
```

- [ ] **Step 2: Run it (expected FAIL)**

```bash
node --import tsx --test qa-engine/test/shared-infrastructure/process-sandbox/scrub-env.test.ts
```
Expected: FAIL — module missing.

- [ ] **Step 3: Write `scrub-env.ts` (the body copied verbatim from `src/qa/code-runner.ts`)**

```typescript
// qa-engine/src/shared-infrastructure/process-sandbox/scrub-env.ts
// Builds a scrubbed environment for an UNTRUSTED spawn (the watched repo's own test/install commands,
// or agent-written specs). Drops the orchestrator's secrets, keeps OS + language vars. Moved from
// src/qa/code-runner.ts (1 definition + ~8 import sites) — the canonical home; src/ callers migrate
// in Plan 6. Body is byte-for-byte identical so the move is behavior-preserving.

// Secret FAMILIES that must never reach untrusted code (prefix match). Defense-in-depth: the allowlist
// is the real gate, but blocking secrets explicitly guards against an allowlist entry widening to one.
const BLOCKED_ENV_PREFIX = /^(?:GITHUB_TOKEN|GH_TOKEN|OPENCODE_API_KEY|WEBHOOK_SECRET|QA_API_TOKEN|DOPPLER_|AWS_|AZURE_|GCP_|GOOGLE_APPLICATION_CREDENTIALS|NPM_TOKEN|NODE_AUTH_TOKEN)/;

// Allowed exact var names (OS + language essentials that are single vars, not families).
const ALLOWED_ENV_EXACT = new Set([
  "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "TMPDIR", "TEMPDIR", "TMP", "TEMP",
  "NODE_ENV", "CI", "PYTHON", "VIRTUAL_ENV", "GOPATH", "GOROOT", "GOPRIVATE", "GOPROXY",
  "GONOSUMCHECK", "GOFLAGS", "GOCACHE", "JAVA_HOME", "M2_HOME", "M2_REPO", "M2", "NVM_DIR", "NODE_PATH", "NODE_OPTIONS",
  "DISPLAY", "SSH_AUTH_SOCK", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "DEBUG",
  "PKG_CONFIG_PATH", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH",
  // Playwright's browsers are baked at a NON-default path in the orchestrator image; without
  // forwarding it the child loses the path and every e2e run fails with "Executable doesn't exist".
  "PLAYWRIGHT_BROWSERS_PATH",
]);

// Allowed var FAMILIES (prefix match — npm/cargo/gradle/maven/locale config the toolchain needs).
const ALLOWED_ENV_PREFIX = /^(?:LC_|npm_config_|PIP_|CGO_|CARGO_|RUSTUP_|RUST_|GRADLE_|MAVEN_|PNPM_|YARN_|COREPACK_)/;

export function scrubEnv(extraAllowed?: RegExp): Record<string, string> {
  const env: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (BLOCKED_ENV_PREFIX.test(key)) continue; // secrets are blocked even if extraAllowed matches
    if (ALLOWED_ENV_EXACT.has(key) || ALLOWED_ENV_PREFIX.test(key) || (extraAllowed?.test(key) ?? false)) {
      env[key] = value;
    } else {
      dropped.push(key);
    }
  }
  if (dropped.length > 0) {
    console.warn(`[qa] scrubEnv dropped ${dropped.length} env var(s) not in allowlist: ${dropped.join(", ")}`);
  }
  return env;
}
```

- [ ] **Step 4: Run it (expected PASS) + typecheck**

```bash
node --import tsx --test qa-engine/test/shared-infrastructure/process-sandbox/scrub-env.test.ts
npm run typecheck && echo "TYPECHECK OK"
```
Expected: PASS (3 tests), `TYPECHECK OK`.

- [ ] **Step 5: Commit**

```bash
git add qa-engine/src/shared-infrastructure/process-sandbox/scrub-env.ts qa-engine/test/shared-infrastructure/process-sandbox/scrub-env.test.ts
git commit -m "feat(infra): move scrubEnv to shared-infrastructure (canonical home)"
```

---

## Task 11: Bounded-context port interfaces (all 9 contexts, interfaces only)

Define EVERY driven/driving port as a pure interface module compiling against the kernel and nothing external (§5.3, §7.2 Step 4). Lift the cleanest existing DI seams nearly as-is (`AgentRuntimeStrategy`, the extractor map, `ExecuteDeps`/`ValidateDeps`/`SetupDeps`/`CaptureDomDeps` shapes). NO adapters, NO impls. One compile-only test imports every barrel to prove they typecheck. **Excludes** the Seam-2 cycle break (Plan 5) and `VcsWritePort`'s adapter (only the interface here).

> **Worker guidance.** This is the largest task; do it in one commit but build the barrels context-by-context. Each port is a small interface; the load-bearing requirement is that every signature uses ONLY kernel types (`Sha`, `RunVerdict`, `QaCase`, `BlastRadius`, `Objective`, `RunOutcome`, `AgentRole`, `RoleAssignment`, `Result`, `CheckResult`-shaped locals) or Node built-ins — never a `src/` import and never a cross-context import.

**Files:**
- Create: the 9 `application/ports/index.ts` barrels listed in File Structure.
- Test: `qa-engine/test/contexts/ports-compile.test.ts`

- [ ] **Step 1: Write the compile-only test FIRST (it fails until all 9 barrels exist)**

```typescript
// qa-engine/test/contexts/ports-compile.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// Importing every port barrel forces tsc (via the npm run typecheck gate) to prove the interfaces
// compile against the kernel and nothing external. Port modules export only interfaces — no runtime
// side effects — but the binding exists at runtime so the namespace reference in the assertion below
// is valid. `import * as X` (NOT `import type * as X`) is required: `import type` is fully erased
// at runtime, so referencing the namespace would throw ReferenceError.
import * as Core from "@contexts/qa-run-orchestration/application/ports/index.ts";
import * as Analysis from "@contexts/change-analysis/application/ports/index.ts";
import * as Generation from "@contexts/generation/application/ports/index.ts";
import * as Runtime from "@contexts/agent-runtime/application/ports/index.ts";
import * as Execution from "@contexts/test-execution/application/ports/index.ts";
import * as Signal from "@contexts/objective-signal/application/ports/index.ts";
import * as Learning from "@contexts/cross-run-learning/application/ports/index.ts";
import * as Workspace from "@contexts/workspace-and-publication/application/ports/index.ts";
import * as Catalog from "@contexts/app-catalog/application/ports/index.ts";

test("every bounded-context port barrel compiles and is importable", () => {
  // Reference the namespaces so the imports are not elided. Port modules export interfaces only —
  // no runtime side effects — so importing them is safe. The count assertion confirms all 9 resolved.
  const names = [Core, Analysis, Generation, Runtime, Execution, Signal, Learning, Workspace, Catalog];
  assert.equal(names.length, 9);
});
```

- [ ] **Step 2: Run it (expected FAIL — barrels missing)**

```bash
node --import tsx --test qa-engine/test/contexts/ports-compile.test.ts
```
Expected: FAIL — `Cannot find module '@contexts/qa-run-orchestration/...'`.

- [ ] **Step 3: Write `qa-run-orchestration` ports (the core's 13 ports)**

```typescript
// qa-engine/src/contexts/qa-run-orchestration/application/ports/index.ts
// The core's segregated ports. The DRIVING seam (RunPipelinePort) is the strangler; the driven ports
// are the 10 capability seams the Run lifecycle composes, plus ObserverPort (replaces the 7 positional
// callbacks) and RunHistoryPort (inverts the leaky dynamic import() at pipeline.ts:487-619).
// Interfaces only — adapters arrive in Plan 6. Every type is kernel-resident; no cross-context import.

import type { Sha } from "@kernel/sha.ts";
import type { RunMode, TestTarget, TriggerSource } from "@kernel/run-mode.ts";
import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { RunStep } from "@kernel/run-step.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { Objective } from "@kernel/objective.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { RunEventBody } from "@kernel/run-event.ts";
import type { Result } from "@kernel/result.ts";
import type { InfraError } from "@kernel/domain-error.ts";

// The immovable strangler seam: a single input → a RunOutcome. Both LegacyPipelineAdapter and the
// RewrittenOrchestratorAdapter satisfy this (Plan 6).
export interface RunInput {
  app: string;
  sha: Sha;
  source: TriggerSource;
  mode: RunMode;
  target: TestTarget;
  guidance?: string;
  runId: string;
}
export interface RunPipelinePort {
  run(input: RunInput): Promise<RunOutcome>;
}

// ── Driven capability ports (one per orchestrated context) ────────────────────
export interface ChangeAnalysisPort {
  analyze(sha: Sha): Promise<BlastRadius>;
  classify(sha: Sha): Promise<{ action: "skip" | "regression" | "generate"; reason: string }>;
}
export interface GenerationPort {
  generate(objectives: readonly Objective[], specDir: string): Promise<{ specs: string[]; approved: boolean; note?: string }>;
}
export interface ReviewPort {
  review(specDir: string, cases: readonly QaCase[]): Promise<{ approved: boolean; corrections: string[]; rationale?: string }>;
}
export interface ValidationPort {
  validate(specDir: string): Promise<{ ok: boolean; errors: string[]; infra?: boolean }>; // infra optional: mirrors src/qa/validate.ts CheckResult
}
export interface ExecutionPort {
  execute(specDir: string): Promise<{ verdict: RunVerdict; cases: QaCase[]; logs: string }>;
}
export interface ObjectiveSignalPort {
  measure(br: BlastRadius, specDir: string): Promise<{ status: "pass" | "fail" | "unknown"; ratio: number | null }>;
}
export interface PublicationPort {
  publish(decision: { verdict: RunVerdict; cases: readonly QaCase[]; logs: string }): Promise<{ outcome: string }>;
}
export interface LearningPort {
  // Off-path by contract — a failure is logged and swallowed, never gates publish.
  fold(outcome: RunOutcome): Promise<void>;
  retrieve(sha: Sha): Promise<string[]>;
}
// DeployGatePort is a cross-cutting infra port; it is kernel-resident (Task 8) so neither context
// needs to import it from the other. Re-export it here so callers of this barrel get a single import.
export type { DeployGatePort } from "@kernel/ports/deploy-gate.port.ts";
export interface WorkspacePort {
  prepare(sha: Sha): Promise<{ specDir: string }>;
}
// Replaces the 7 positional callbacks (onStep/onCase/…) with one typed observer.
export interface ObserverPort {
  onStep(step: RunStep, detail?: string): void;
  onEvent(body: RunEventBody): void;
}
// Inverts the leaky dynamic import() into a port (pipeline.ts:487-619).
export interface RunHistoryPort {
  save(outcome: RunOutcome): Promise<void>;
}
```

- [ ] **Step 4: Write `change-analysis` ports (VcsReadPort + the 5 fail-open extractor ports)**

```typescript
// qa-engine/src/contexts/change-analysis/application/ports/index.ts
// Deterministic blast-radius analysis ports. VcsReadPort is the typed read side (no raw git argv
// leaks). The 5 extractor ports are an ALL-OPTIONAL fail-open map — each returns a typed degradation
// instead of an opaque `skipped` string (Result<…, ExtractorSkipped>). DiffParserService /
// SandboxedBinaryRunner / ProcessKillPort are consumed FROM the kernel/shared-infrastructure, not
// redefined here. [SWAP] on each adapter boundary.

import type { Sha } from "@kernel/sha.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { Result } from "@kernel/result.ts";

export interface ExtractorSkipped {
  extractor: string;
  reason: string;
}

export interface VcsReadPort {
  diff(sha: Sha, opts?: { baseSha?: Sha; commits?: number }): Promise<string>;
  message(sha: Sha): Promise<string>;
  blastRadius(sha: Sha, opts?: { baseSha?: Sha; commits?: number }): Promise<BlastRadius>;
}

export interface ChangedSymbol { name: string; kind: string; file: string; }
export interface RelationEdge { from: string; to: string; }
export interface ComplexityHotspot { file: string; symbol: string; score: number; }
export interface SemanticDiffEntry { file: string; change: string; }
export interface ChangePattern { name: string; files: string[]; }

export interface SymbolExtractorPort { extract(br: BlastRadius): Promise<Result<ChangedSymbol[], ExtractorSkipped>>; }
export interface RelationExtractorPort { extract(br: BlastRadius): Promise<Result<RelationEdge[], ExtractorSkipped>>; }
export interface ComplexityExtractorPort { extract(br: BlastRadius): Promise<Result<ComplexityHotspot[], ExtractorSkipped>>; }
export interface SemanticDiffExtractorPort { extract(br: BlastRadius): Promise<Result<SemanticDiffEntry[], ExtractorSkipped>>; }
export interface PatternExtractorPort { extract(br: BlastRadius): Promise<Result<ChangePattern[], ExtractorSkipped>>; }
```

- [ ] **Step 5: Write `generation` ports (lifts ManifestRepository/VerdictParser/PromptRendering/DomGrounding/PromptBudget)**

```typescript
// qa-engine/src/contexts/generation/application/ports/index.ts
// Generation ports: AgentRuntimePort is consumed FROM the kernel (decouples generation from
// agent-runtime; §5.2). PromptRenderingPort [SWAP] renders domain prompt objects to provider strings;
// DomGroundingPort [SWAP] is e2e-only and degraded to a NullDomGroundingAdapter for code-mode (the
// use-case ALWAYS receives a port, never undefined — absence handled at the adapter, not in branching).
// PromptBudgetPort is the GENERATION-side capDiff/capText concern (separate from kernel RedactionPort).
// Seam-2 (OpencodeRunInput/ReviewInput/ParallelWorkerInput cycle break) is DEFERRED to Plan 5.

import type { Objective } from "@kernel/objective.ts";
import type { QaCase } from "@kernel/qa-case.ts";

export interface ManifestEntry { id: string; file: string; flow: string; objective: string; }
export interface ManifestRepositoryPort {
  read(specDir: string): Promise<ManifestEntry[]>;
  reconcile(specDir: string, entries: readonly ManifestEntry[]): Promise<ManifestEntry[]>;
}

// Free-form LLM text → structured deliverable/judgment. Fail-closed on an unparseable verdict.
export interface GeneratorDeliverable { specs: string[]; note?: string; }
export interface ReviewJudgment { approved: boolean; corrections: string[]; rationale?: string; }
export interface VerdictParserPort {
  parseGenerator(text: string): GeneratorDeliverable;
  parseReview(text: string): ReviewJudgment;
}

export interface PromptSection { heading: string; body: string; }
export interface PromptRenderingPort {
  render(sections: readonly PromptSection[]): string;
}

// e2e: real grounding; code-mode: NullDomGroundingAdapter returns an empty context (§3 hard limit).
export interface DomGrounding { aria: string; routes: string[]; }
export interface DomGroundingPort {
  ground(objective: Objective): Promise<DomGrounding>;
}

// capDiff/capText prompt-budget capping — a generation concern, NOT redaction (§5.3(8)).
export interface PromptBudgetPort {
  capDiff(diff: string): string;
  capText(text: string): string;
}

export interface ContextPackResult { objective: Objective; sections: PromptSection[]; failureCases?: QaCase[]; }
```

- [ ] **Step 6: Write `agent-runtime` ports (lift `AgentRuntimeStrategy` nearly as-is + StallWatchdog Option B)**

```typescript
// qa-engine/src/contexts/agent-runtime/application/ports/index.ts
// Provider-agnostic session management ports. AgentRuntimePort is the kernel-facing seam (AgentRole +
// RoleAssignment are kernel-resident, §5.1 P3). AgentRuntimeStrategy [SWAP — one per provider] is
// lifted nearly verbatim from src/agent-runtime/types.ts. StallWatchdogPort is a SEPARATE port
// alongside the (Plan-5) ResilienceDecorator (Option B): the per-session attach/detach lifecycle is
// distinct from the breaker's retry loop and must not be coupled to it. ProcessKillPort is consumed
// FROM the kernel. RunUsage stays here (no kernel leak) — modeled as a local UsageSnapshot type.

import type { AgentRole, RoleAssignment, AgentProvider } from "@kernel/agent-role.ts";

export interface UsageSnapshot { inputTokens: number; outputTokens: number; provider: AgentProvider; }
export interface AgentTurnEvent { runId: string; role: AgentRole; objective?: string; }
export interface AgentSession {
  prompt(text: string): Promise<{ output: string }>;
  dispose(): Promise<void> | void;
}

export interface OpenSessionOpts {
  signal?: AbortSignal;
  timeoutMs?: number;
  model?: string;
  onUsage?: (u: UsageSnapshot) => void;
  onTurn?: (t: AgentTurnEvent) => void;
}

// The kernel-facing port generation depends on.
export interface AgentRuntimePort {
  openSession(role: AgentRole, cwd: string, opts?: OpenSessionOpts): Promise<AgentSession>;
}

export interface AgentProviderHealth { provider: AgentProvider; status: string; configured: boolean; error?: string; }
export interface AgentModelInfo { id: string; label?: string; provider?: AgentProvider; }

// [SWAP — one adapter per provider]. Lifted from src/agent-runtime/types.ts AgentRuntimeStrategy.
export interface AgentRuntimeStrategy extends AgentRuntimePort {
  provider: AgentProvider;
  health(): Promise<AgentProviderHealth>;
  listModels(): Promise<AgentModelInfo[]>;
  restart?(opts?: { apiKey?: string; reason?: string }): Promise<AgentProviderHealth>;
  dispose?(): void | Promise<void>;
}

// [SWAP] opencode serve HTTP / codex exec.
export interface TransportPort {
  send(payload: unknown): Promise<unknown>;
}
export interface ModelCatalogPort {
  models(provider: AgentProvider): Promise<AgentModelInfo[]>;
}
// Replaces the direct saveAgentTurn import in both strategies.
export interface TurnTelemetrySink {
  record(event: AgentTurnEvent): void;
}
// Option B: separate from the ResilienceDecorator. Per-session attach/detach liveness watchdog.
export interface StallWatchdogPort {
  attach(session: AgentSession, onStall: () => void): () => void; // returns detach
}
// Assignment resolution preserves the deliberate fallback (3 explicit roles, 5 via fallback).
export interface RoleAssignmentResolver {
  resolve(role: AgentRole): RoleAssignment;
}
```

- [ ] **Step 7: Write `test-execution` ports (lift `ExecuteDeps`/`ValidateDeps` shapes; two-adapter [SWAP])**

```typescript
// qa-engine/src/contexts/test-execution/application/ports/index.ts
// The deterministic harness ports. ExecutionStrategyPort [SWAP — two adapters: e2e/code] is lifted
// from execute.ts ExecuteDeps; the static gate from validate.ts ValidateDeps. DeployGatePort is
// kernel-resident (Task 8) — consumed here via @kernel, not defined locally. ProcessKillPort is
// consumed FROM the kernel (breaks the execute ⇄ dom-snapshot cycle). CheckResult is a local result
// type (mirrors src/qa CheckResult).

import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { QaCase } from "@kernel/qa-case.ts";

// DeployGatePort is a cross-cutting infra port defined in the kernel. [SWAP] adapter is absent for
// static sites and the code target (returns ok(true) immediately).
export type { DeployGatePort } from "@kernel/ports/deploy-gate.port.ts";

export interface CheckResult { ok: boolean; output: string; infra?: boolean; } // infra optional: mirrors src/qa/validate.ts CheckResult (infra?: boolean)
export interface ExecutionRequest {
  specDir: string;
  baseUrl?: string;        // absent for code target
  namespace: string;
  faultInject?: boolean;
  specFiles?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface ExecutionResult { verdict: RunVerdict; cases: QaCase[]; logs: string; }

// [SWAP — e2e (Playwright) vs code (exit-code)].
export interface ExecutionStrategyPort {
  run(req: ExecutionRequest): Promise<ExecutionResult>;
}
// Static gate (tsc/eslint-playwright/playwright --list/manifest) — lifted from ValidateDeps.
export interface StaticGatePort {
  typecheck(specDir: string): Promise<CheckResult>;
  lint(specDir: string): Promise<CheckResult>;
  listTests(specDir: string): Promise<CheckResult>;
  checkManifest(specDir: string): Promise<CheckResult>;
}
```

- [ ] **Step 8: Write `objective-signal` ports (the keystone's NEW CoverageCollectorPort seam)**

```typescript
// qa-engine/src/contexts/objective-signal/application/ports/index.ts
// THE TRUST KEYSTONE ports. CoverageCollectorPort [SWAP — NEW DI seam] fixes the one weak spot
// (defaultCollectCoverage hard-codes FS reads with no *Deps). ValueOraclePort [SWAP — one port, two
// adapters: Stryker mutation for code, fault-injection for e2e] replaces the pipeline.ts:564 ternary.
// SourceMapPort maps V8 byte offsets → original lines. The keystone invariant — unknown NEVER blocks
// — lives in the (Plan-6) DecideCoverageService, not in these ports.

import type { Sha } from "@kernel/sha.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";

export interface CoveredLines { file: string; lines: number[]; }
export interface CoverageReport { covered: CoveredLines[]; }
// [SWAP — NEW] per-ecosystem coverage collection (v8/c8/JaCoCo/lcov), injected (never FS-hardcoded).
export interface CoverageCollectorPort {
  collect(specDir: string, namespace: string): Promise<CoverageReport>;
}
export interface ValueOracleResult { mutantCount: number; killedCount: number; score: number | null; }
// [SWAP — one port, two adapters] mutation (code) vs fault-injection (e2e).
export interface ValueOraclePort {
  measure(br: BlastRadius, specDir: string): Promise<ValueOracleResult>;
}
export interface SourceMapPort {
  toOriginalLine(file: string, byteOffset: number): Promise<{ file: string; line: number } | null>;
}
// Used by the decide step (Plan 6); declared here as the read-model shape the collector feeds.
export interface ChangeCoverageInput { sha: Sha; changedLines: number; coveredLines: number; }
```

- [ ] **Step 9: Write `cross-run-learning` ports (LearningRepository inverts the SQLite coupling)**

```typescript
// qa-engine/src/contexts/cross-run-learning/application/ports/index.ts
// Off-path flywheel ports (stubbed in v1; never gates publish). LearningRepositoryPort [SWAP] inverts
// the two-way SQLite coupling (history.ts imports applyOutcome; distiller/retrieval import history)
// into one port, making RuleGovernance the single source of ranking truth. ReflectorPort uses
// AgentRuntimePort (consumed from the kernel via generation/agent-runtime, not redefined here).
// ErrorClass stays in THIS context (no kernel leak) — modeled as a local string-literal union.

import type { Sha } from "@kernel/sha.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";

export type ErrorClass = string; // the real owner; the kernel RunOutcome.errorClass widens to this.
export type RuleStatus = "candidate" | "active" | "deprecated" | "superseded";
export interface LearningRule {
  trigger: string; action: string; errorClass: ErrorClass; status: RuleStatus;
  confidence: "low" | "medium" | "high"; successRate: number | null;
}
// [SWAP] inverts the SQLite coupling; ranking truth lives in RuleGovernance, not in SQL ORDER BY.
export interface LearningRepositoryPort {
  save(rule: LearningRule): Promise<void>;
  topRules(sha: Sha, limit: number): Promise<LearningRule[]>;
  applyOutcome(outcome: RunOutcome): Promise<void>;
}
// Aligned to legacy src/types.ts StructuredReflection (8 fields). Field pruning, if any, is decided
// when porting the learning context (Plan 6), not here — do not silently truncate.
export interface StructuredReflection {
  goal: string;
  decision: string;
  assumption: string;
  errorClass: ErrorClass;   // uses the local ErrorClass alias (string)
  gateSignal: string;
  evidence: string;
  rootCause: string;
  preventiveRule: { trigger: string; action: string };
}
export interface ReflectorPort {
  reflect(outcome: RunOutcome): Promise<StructuredReflection | null>;
}
export interface ProcessFinding { kind: string; detail: string; }
export interface ProcessAuditPort {
  audit(outcome: RunOutcome): Promise<ProcessFinding[]>;
}
```

- [ ] **Step 10: Write `workspace-and-publication` ports (the security seam — interface only) and `app-catalog` ports**

```typescript
// qa-engine/src/contexts/workspace-and-publication/application/ports/index.ts
// The ONLY context that holds VcsWritePort — the security seam made structural (§2 G3). The arch-lint
// gate (Task 12) forbids any generation/* or agent-runtime/* module from importing VcsWritePort or a
// write adapter. WorkspaceVcsReadPort is the safe workspace read side (diff/status — distinct from
// change-analysis VcsReadPort which owns diff/message/blastRadius). RedactionPort is consumed FROM
// the kernel (egress sanitization), not redefined here. Interfaces only — no GitWriteAdapter.

import type { Sha } from "@kernel/sha.ts";
import type { RunVerdict } from "@kernel/run-verdict.ts";

// Named WorkspaceVcsReadPort (not VcsReadPort) to avoid a name collision with change-analysis's
// VcsReadPort — both are named "VcsRead" but have irreconcilable method sets. This context's read
// side covers workspace status (diff/status); change-analysis covers commit analysis (diff/message/blastRadius).
export interface WorkspaceVcsReadPort {
  diff(sha: Sha): Promise<string>;
  status(dir: string): Promise<string>;
}
// [SWAP — orchestrator-only; the security seam]. Only this context's adapters implement it.
export interface VcsWritePort {
  commit(dir: string, message: string, files: readonly string[]): Promise<void>;
  push(dir: string, branch: string): Promise<void>;
}
export interface PullRequest { url: string; number: number; }
export interface Issue { url: string; number: number; }
// [SWAP — typed, not raw fetch].
export interface GitHubPrPort {
  openWithAutoMerge(repo: string, branch: string, title: string, body: string): Promise<PullRequest>;
}
export interface GitHubIssuePort {
  open(repo: string, title: string, body: string): Promise<Issue>;
}
export interface MirrorGcPort {
  prune(repo: string): Promise<void>;
}
export interface PublishDecision { verdict: RunVerdict; outcome: string; }
export interface ConfinementResult { strays: number; dangerous: number; reverted: string[]; }
```

```typescript
// qa-engine/src/contexts/app-catalog/application/ports/index.ts
// Watched-app config + cross-repo routing ports. AppRepositoryPort [SWAP] loads/validates app config;
// RepoInfoPort talks to GitHub for repo metadata. App-specificity lives ONLY here (CLAUDE.md invariant).
// The App aggregate + RepoResolutionService are domain (Plan 4); these are the driven seams.

export interface ServiceConfig { repo: string; openapi?: string; versionUrl?: string; }
export type RepoRole = "primary" | "service";
export interface AppConfigSnapshot {
  name: string; repo: string; baseBranch: string;
  code: boolean; shadow: boolean; services: ServiceConfig[];
}
// [SWAP] — yaml today, swappable behind the port.
export interface AppRepositoryPort {
  load(name: string): Promise<AppConfigSnapshot>;
  list(): Promise<AppConfigSnapshot[]>;
  resolveByRepo(repoSlug: string): Promise<{ app: AppConfigSnapshot; role: RepoRole } | null>;
}
export interface RepoInfoPort {
  defaultBranch(repoSlug: string): Promise<string>;
}
```

- [ ] **Step 11: Run the compile test (expected PASS) + full typecheck**

```bash
node --import tsx --test qa-engine/test/contexts/ports-compile.test.ts
npm run typecheck && echo "TYPECHECK OK"
```
Expected: PASS (1 test), `TYPECHECK OK` — every barrel resolves and uses only kernel/Node types.

- [ ] **Step 12: Commit**

```bash
git add qa-engine/src/contexts qa-engine/test/contexts/ports-compile.test.ts
git commit -m "feat(contexts): bounded-context port interfaces (interfaces only)"
```

---

## Task 12: Arch-lint gate — VCS-write confinement (the structural security invariant)

Make the agent-is-read-only invariant **structural** (§2 G3, §8 R4): no module under `generation/*` or `agent-runtime/*` may import `VcsWritePort` or a write adapter. Backed by `dependency-cruiser` (explicit devDependency), run as part of `npm test`. This gate must be GREEN before any context adapter code is written in later plans.

**Files:**
- Create: `qa-engine/.dependency-cruiser.cjs`, `qa-engine/test/arch/vcs-write-confinement.test.ts`
- Modify: root `package.json` + `package-lock.json` — add `dependency-cruiser`

- [ ] **Step 1: Install dependency-cruiser**

```bash
cd /Users/arielyumn/Desktop/TRABAJO/panchito
npm install -D dependency-cruiser
rg -n 'dependency-cruiser' package.json
```
Expected: added to `devDependencies`.

- [ ] **Step 2: Write the cruiser config (the forbidden rule)**

```javascript
// qa-engine/.dependency-cruiser.cjs
// Structural security invariant (§8 R4): generation/* and agent-runtime/* are the agent-facing
// contexts; the agent is READ-ONLY on watched repos, so neither may reach the write seam. This rule
// forbids any module under those two contexts from importing ANYTHING from workspace-and-publication
// (barrel, port, or adapter) — catching VcsWritePort regardless of how it is re-exported.
// Known limitation: dependency-cruiser may miss dynamic import() — flagged for manual audit.
module.exports = {
  forbidden: [
    {
      name: "no-vcs-write-in-agent-contexts",
      severity: "error",
      comment: "generation/* and agent-runtime/* must never import from workspace-and-publication (agent-is-read-only). Matches barrel, ports, and any future adapter — not just the specific write adapter filename.",
      from: { path: "qa-engine/src/contexts/(generation|agent-runtime)/" },
      to: { path: "contexts/workspace-and-publication" },
    },
  ],
  options: {
    tsConfig: { fileName: "qa-engine/tsconfig.json" },
    doNotFollow: { path: "node_modules" },
    enhancedResolveOptions: { extensions: [".ts"] },
  },
};
```

- [ ] **Step 3: Write the arch test that runs the cruiser**

```typescript
// qa-engine/test/arch/vcs-write-confinement.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// The security gate (§2 G3 / §8 R4): assert NO module under generation/* or agent-runtime/* imports
// VcsWritePort or a write adapter. Runs depcruise with the dedicated config and fails on any
// violation. Must be green BEFORE any context adapter is written in later plans.
// Manual-audit note: depcruise may miss dynamic import()/barrel re-exports; if a new write path is
// added via either mechanism, audit it by hand — this static rule will not catch it.
test("no generation/* or agent-runtime/* module imports the VCS write seam", () => {
  const root = join(import.meta.dirname, "..", "..", "..");
  let out = "";
  try {
    out = execFileSync(
      "npx",
      ["depcruise", "--config", "qa-engine/.dependency-cruiser.cjs", "qa-engine/src/contexts"],
      { cwd: root, encoding: "utf8" },
    );
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: string | number };
    // Differentiate an install/ENOENT failure from an actual rule violation so the error message
    // is actionable. An ENOENT typically means `depcruise` is not installed or not on PATH.
    const combined = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    if (err.code === "ENOENT" || /Cannot find|not found|ENOENT/i.test(combined)) {
      assert.fail(`dependency-cruiser not found — run \`npm install\` (exit: ${err.code}):\n${combined}`);
    }
    assert.fail(`dependency-cruiser reported a VCS-write confinement violation:\n${combined}`);
  }
  // depcruise exits 0 with no error output when the rule holds.
  assert.doesNotMatch(out, /error no-vcs-write-in-agent-contexts/);
});
```

- [ ] **Step 4: Run the gate (expected PASS — no write adapter exists yet, so the rule holds vacuously but the wiring is proven)**

```bash
node --import tsx --test qa-engine/test/arch/vcs-write-confinement.test.ts
```
Expected: PASS. The rule currently holds because no adapter imports the write seam; the value is that the gate is WIRED and will fail the moment a future plan crosses the boundary.

- [ ] **Step 5: Prove the gate actually catches a violation (temporary, then revert)**

The probe imports from the `workspace-and-publication` ports barrel — the rule now matches the whole
context path (`contexts/workspace-and-publication`), so any import of that context fires the gate,
not just a specific vcs-write adapter filename. This makes the falsifiability probe genuine.

```bash
cd /Users/arielyumn/Desktop/TRABAJO/panchito
mkdir -p qa-engine/src/contexts/generation/infrastructure
printf '%s\n' \
  'import type { VcsWritePort } from "../../workspace-and-publication/application/ports/index.ts";' \
  'export const leak: VcsWritePort = {} as VcsWritePort;' \
  > qa-engine/src/contexts/generation/infrastructure/_leak-probe.ts
node --import tsx --test qa-engine/test/arch/vcs-write-confinement.test.ts || echo "GATE FIRED (expected)"
rm -f qa-engine/src/contexts/generation/infrastructure/_leak-probe.ts
rmdir qa-engine/src/contexts/generation/infrastructure 2>/dev/null || true
node --import tsx --test qa-engine/test/arch/vcs-write-confinement.test.ts && echo "GATE GREEN after revert"
```
Expected: `GATE FIRED (expected)` with the probe present (depcruise finds the `to.path` match on
`contexts/workspace-and-publication` and reports violation `no-vcs-write-in-agent-contexts`), then
`GATE GREEN after revert`. Confirm the probe file is gone:
`git status --porcelain qa-engine | rg _leak-probe || echo clean`.

- [ ] **Step 6: Wire the gate into `npm test`**

Confirm the gate is already picked up by the root `test` glob (`qa-engine/test/**/*.test.ts` from Plan 1) — `vcs-write-confinement.test.ts` matches it. Verify:

```bash
npm test 2>&1 | rg -i 'vcs-write-confinement|no generation'
```
Expected: the arch test appears in the run. No script change needed (the glob already covers `test/arch/`).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json qa-engine/.dependency-cruiser.cjs qa-engine/test/arch/vcs-write-confinement.test.ts
git commit -m "test(arch): dependency-cruiser gate forbidding VCS-write in agent contexts"
```

---

## Task 13: Full-gate green check

Run the whole gate across both trees to confirm Plan 2 left everything green and Plan 1's parity net still holds.

**Files:** none.

- [ ] **Step 1: Full typecheck**

```bash
cd /Users/arielyumn/Desktop/TRABAJO/panchito
npm run typecheck && echo "TYPECHECK OK"
```
Expected: `TYPECHECK OK`, no `.tsbuildinfo`/`.d.ts` emitted (`git status --porcelain qa-engine | rg '\.d\.ts|tsbuildinfo' || echo clean`).

- [ ] **Step 2: Full test run (Plan 1 goldens + Plan 2 kernel/infra/ports/arch)**

```bash
npm test 2>&1 | tail -25
```
Expected: PASS. The Plan-1 golden-parity tests (10 goldens + comparator) still pass, the kernel/infra/ports/arch tests are included, and no regression in `src/`.

- [ ] **Step 3: Confirm the kernel has no forward edge (the cardinal invariant)**

```bash
rg -n "from \"\.\./\.\./contexts|@contexts/|qa/learning/taxonomy|qa/usage" qa-engine/src/shared-kernel || echo "KERNEL IS A LEAF (clean)"
```
Expected: `KERNEL IS A LEAF (clean)` — no kernel module imports any context, and it does NOT reproduce the legacy `qa/learning/taxonomy`/`qa/usage` forward edge.

> `qa-engine/src/shared-kernel/contract/index.ts` re-exports from `../../../../src/contract/*` — this is the ONE deliberately documented kernel→src dependency. It is a re-export of the frozen wire surface (not a downstream context import) and is expected to appear if you run a broader import scan. The check above uses `@contexts/` and `qa/learning/taxonomy|qa/usage` as the forbidden patterns; `src/contract` is excluded because the contract re-export is the controlled, named exception.

- [ ] **Step 4: Commit (only if Step 1-3 surfaced a fixup; otherwise nothing to commit)**

```bash
git status --short
# If a fixup was needed: git add … && git commit -m "fix(qa-engine): <what>"
```

---

## Self-Review

**1. Spec coverage (Plan-2 scope):**
- §5.2 shared-kernel tree (sha, run-verdict, run-mode, run-step, qa-case, result, domain-error, blast-radius, objective, agent-role, run-event, run-outcome, contract re-export, the three kernel ports — redaction, clock, deploy-gate — process-kill.port) → Tasks 2-8. ✅
- §5.2 shared-infrastructure (process-kill.adapter, sandboxed-binary-runner, scrub-env) → Tasks 9-10. ✅
- §5.3(1)-(10) ports, interfaces only (all 9 context barrels + the lifted DI seams `AgentRuntimeStrategy`/extractor-map/`ExecuteDeps`/`ValidateDeps`/`SetupDeps`-shaped/`CaptureDomDeps`-shaped) → Task 11. ✅
- §7.2 Step 4 ports-only + §7.2 typecheck-mechanism fix → Tasks 1, 11. ✅
- §8 R4 / §2 G3 arch-lint gate (dependency-cruiser, run in `npm test`, proven falsifiable) → Task 12. ✅
- Kernel-no-forward-edge by inversion (`ErrorClass`/`RunUsage` NOT reproduced) → Tasks 7, 13 Step 3. ✅
- NEW concepts `BlastRadius`/`Objective`/`Flow` created (do not exist today) → Task 6. ✅
- `AgentRole`/`RoleAssignment` kernel-resident (§5.1 P3) → Task 7. ✅
- **Correctly OUT of scope:** Seam-2 cycle break (Plan 5 — noted in generation ports + scope); all adapter impls (Plans 3-6); `changed-elements.ts` untouched; the rewritten orchestrator/cutover (Plans 6-7). The shared-infrastructure does NOT migrate the 4 `killTree` / 8 `scrubEnv` `src/` import sites — Plan 6 Step 6 does (stated in Tasks 9-10).

**2. Placeholder scan:** No "TBD"/"add the rest similarly"/test-less steps. Every VO, the `Result` type, `engineStatus()`, `Sha` validation, the `InfraError` taxonomy, the consolidated `killTree`, `scrubEnv`, and all 9 port barrels carry full real code. The `sandboxed-binary-runner` is a deliberate interface-only seam (its rich impl is YAGNI until a caller migrates — §2.3 C4) but it is a COMPLETE interface, not a stub-with-holes. Task 12 Step 5 is a real falsifiability proof, not a placeholder.

**3. Type consistency — kernel `RunOutcome` vs legacy:** Task 7 pins the `legacy → kernel` direction with a compile-time assignment test and runs Plan-1's `runOutcomeEquivalent` against a kernel-shaped fixture. The kernel fields are intentionally WIDE supertypes (`errorClass: string | null` ⊇ legacy string-literal union; `usage?: unknown` ⊇ `RunUsage`; `reflection?: unknown` ⊇ `StructuredReflection`) so any legacy value satisfies the kernel type. The `kernel → legacy` direction is NOT asserted and NOT required — the kernel is a supertype, not an isomorphic copy. The Plan-1 comparator (`ComparableOutcome`) never reads `usage`/`reflection`, so behavioral parity holds on the decision-bearing set. The kernel does NOT import `ErrorClass`/`RunUsage`/`StructuredReflection` from downstream — verified in Task 13 Step 3.

**Verified facts used that differed from the snapshot:**
- `AgentRole` has **8** members in `src/agent-runtime/types.ts:8` (`primary|reviewer|chat|worker|workerCode|maintainer|reflector|explorer`) but only **6** in the contract `AgentRoleSchema` (`commands.ts:240`, no `reflector`/`explorer`). The plan uses the **8-member runtime union** as the kernel `AgentRole` (the contract enum is a narrower wire subset) — a discrepancy the prompt's "8 members" matches the runtime, not the contract.
- All **4** `killTree` definitions are byte-identical (confirmed: `execute.ts:64`, `code-runner.ts:64`, `static-signal/exec.ts:6`, `learning/mutation-code.ts:10`) — one adapter consolidates them safely.
- `scrubEnv` is **1** definition (`code-runner.ts:73`) with the exact `BLOCKED_ENV_PREFIX`/`ALLOWED_ENV_EXACT`/`ALLOWED_ENV_PREFIX` constants copied verbatim into the moved module.
- The kernel forward-edge is at the EXACT snapshot lines (`types.ts:214,223,245,266`) — unchanged at HEAD.
- The legacy `RunOutcome` (`types.ts:216-260`) fields are reproduced exactly in the kernel copy. The kernel uses WIDE types (`errorClass: string | null`, `usage?: unknown`, `reflection?: unknown`) so no downstream type is imported.
- Plan 1 set `typecheck` to `tsc --build --force` (emits with `emitDeclarationOnly: true` in qa-engine/tsconfig.json) — Task 1 reverts it to a no-emit CLI pair; Plan 1's `references` stays harmless.
- `src/qa/validate.ts` `CheckResult` has `infra?: boolean` (optional) — the kernel port mirror uses `infra?: boolean` to preserve structural compatibility.
- Legacy `StructuredReflection` has **8** fields (goal, decision, assumption, errorClass, gateSignal, evidence, rootCause, preventiveRule) — all 8 are present in the `cross-run-learning` port.
- `DeployGatePort` is defined ONCE in the shared-kernel (`ports/deploy-gate.port.ts`, Task 8). Both `qa-run-orchestration` and `test-execution` re-export it from `@kernel/ports/deploy-gate.port.ts`; no `@contexts/` cross-context import exists at any port barrel.
- `workspace-and-publication` VcsReadPort renamed to `WorkspaceVcsReadPort` to avoid collision with `change-analysis` VcsReadPort (irreconcilable method sets).
- `contract/index.ts` uses selective named exports, excluding `AgentRole`/`AgentProvider`/`RoleAssignment` (kernel owns canonical versions) and analytics view DTOs.

**Spec gaps found (carried, not blocking Plan 2):**
- The contract `AgentRoleSchema` (6 members) vs runtime `AgentRole` (8 members) drift is real and NOT called out in the spec. The kernel uses the 8-member union; if a later plan needs the wire enum to grow to 8, that is a versioned contract change gated by the openapi drift-guard — flagged here for Plan 4/Plan 7.
- The spec's §5.2 tree lists `scrub-env.ts` as "kernel-adjacent (no child_process)" but also says "concrete spawn adapters → shared-infrastructure/". `scrubEnv` reads `process.env` only (no `child_process`), so it could live in either. This plan places it in `shared-infrastructure/process-sandbox/` (alongside the spawn wrapper that consumes it) for cohesion; if a reviewer insists on the literal kernel-adjacent reading, it can move to `shared-kernel/process-sandbox/scrub-env.ts` with no behavior change.
