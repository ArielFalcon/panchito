# Design — Run-status model + code-mode robustness

**Date:** 2026-06-20
**Author:** brainstorming session (data-backed; every claim cites `file:line`)
**Status:** approved-for-judgment-day

## Objective

Two changes, one shared semantic:

1. **Run status ≠ test verdict.** A run that *executed correctly and produced a
   trustworthy result* must report **success** (exit 0) — whether the suite was
   green (→ PR) or found a real bug (→ Issue). Only a run where *the engine itself
   could not do its job* (infra fault, or it could not produce runnable tests)
   reports **error** (exit ≠ 0). Today a `fail` verdict (a real bug found → Issue
   filed → the engine did exactly the right thing) exits non-zero, identical to a
   crash.

2. **Code-mode must be production-reliable on complex projects** (e.g. a
   Java/Spring Maven monorepo). Today code-mode has **no compile-feedback gate**
   and **runs the whole reactor**, so the agent's compile errors surface as an
   opaque whole-build failure with no structured feedback loop — the exact failure
   observed live on `spring-petclinic-microservices`.

The two are connected (see [§3](#3-why-the-two-fixes-belong-together)): the
compile gate turns "the agent's test does not compile" into `invalid` (→ error),
and "the test compiles and a test fails" into `fail` (→ success → Issue) — which
is precisely the status semantics of fix #1.

---

## 1. Run status — `success | error` derived from the verdict

### 1.1 Current state (verified)

- `RunVerdict = "pass" | "fail" | "flaky" | "invalid" | "infra-error" | "skipped"`
  — [src/types.ts:88](../../../src/types.ts). A string union, not an enum.
- The decide step maps verdict → action **correctly already**: `if (run.verdict !== "pass")`
  → `report()` opens an Issue for `fail`/`invalid`, logs `infra-error`/`flaky`;
  the `pass` branch publishes a PR (or files an Issue when the reviewer rejected /
  coverage blocks) — [src/pipeline.ts:2304](../../../src/pipeline.ts) and the
  `report()` switch at [src/pipeline.ts:2443](../../../src/pipeline.ts). **This
  logic is not the problem and does not change.**
- The **exit code is the problem.** Both CLI paths compute success as
  `ok = verdict === "pass" || verdict === "skipped"` →
  [src/cli.ts:82-84](../../../src/cli.ts) (delegated path) and
  [src/cli.ts:128-130](../../../src/cli.ts) (standalone path). So `fail`,
  `flaky`, `invalid`, `infra-error` all exit 1 — a real-bug-found run is
  indistinguishable from an engine crash to any CI/automation consuming the code.

### 1.2 Design — one pure derivation, no new persisted state

`engineStatus` is a **pure function of the verdict** — there is no verdict whose
status is ambiguous, so it is *derived everywhere*, never stored. No DB migration,
no drift.

```ts
// src/types.ts
export type RunEngineStatus = "success" | "error";

// The engine SUCCEEDED when it ran and produced a trustworthy result + took the
// right action: green (→PR), real bug (→Issue), unstable (→quarantine), or
// nothing-to-do. It ERRORED when it could not do its job: an infrastructure
// fault, it could not produce runnable tests (the generated specs never passed
// the static gate), or no verdict was recorded at all. The PR-vs-Issue
// distinction lives one level down, in the verdict — engineStatus does not
// replace it. Accepts null/undefined (a never-recorded verdict, or a wire value
// that never arrived) and treats it as error — fail-safe.
export function engineStatus(verdict: RunVerdict | null | undefined): RunEngineStatus {
  return verdict == null || verdict === "infra-error" || verdict === "invalid"
    ? "error"
    : "success";
}
```

| Verdict | Action taken (unchanged) | `engineStatus` | exit | Today |
|---|---|---|---|---|
| `pass` | suite PR (auto-merge) | success | 0 | 0 ✓ |
| `fail` | Issue (real bug found) | **success** | **0** | 1 ✗ |
| `flaky` | quarantine (no PR/Issue) | **success** | **0** | 1 ✗ |
| `skipped` | nothing | success | 0 | 0 ✓ |
| `invalid` | Issue (couldn't validate tests) | error | 1 | 1 ✓ |
| `infra-error` | inconclusive (no action) | error | 1 | 1 ✓ |

Only `fail` and `flaky` change exit behavior. The Issue/PR/quarantine action for
every verdict is untouched — `engineStatus` is orthogonal to *what artifact the
run produced*.

### 1.3 The one judgment call — `invalid` is `error`

`invalid` = the agent's generated specs never passed the static gate, so they were
**never executed** ([src/types.ts:82-83](../../../src/types.ts);
[src/pipeline.ts:1858](../../../src/pipeline.ts)). The engine did not produce a
trustworthy result — it produced broken tests. Under the objective ("success = ran
correctly **and** produced a trustworthy result"), that is **not** success →
`error` (exit 1). It still opens its informative Issue (Issue-filing is driven by
the verdict in `report()`, independent of `engineStatus`); the two coexist. A CI
consumer reading exit≠0 learns "the engine could not give you a usable answer —
investigate," which is correct.

### 1.4 Change points (verified, minimal)

| # | File:line | Change |
|---|---|---|
| 1 | [src/types.ts:88](../../../src/types.ts) | Add `RunEngineStatus` + `engineStatus()` next to `RunVerdict`. |
| 2 | [src/cli.ts:83](../../../src/cli.ts), [src/cli.ts:129](../../../src/cli.ts) | Replace both `ok = verdict === "pass" \|\| "skipped"` with `engineStatus(...) === "success"`. Standalone path: `engineStatus(record?.verdict)` (already `RunVerdict \| undefined`). Delegated path: `engineStatus(result.verdict as RunVerdict \| null)` (the wire field is typed `string \| null` but is always one of the six). |
| 3 | [src/contract/events.ts:60](../../../src/contract/events.ts) | Add optional `engineStatus` to the `run.verdict` SSE event (derived at emit). |
| 4 | [src/contract/commands.ts:54](../../../src/contract/commands.ts) | Add optional `engineStatus` to `RunRecordSchema` (derived on read from `verdict`). |
| 5 | [src/server/runner.ts:196](../../../src/server/runner.ts) | When emitting the `run.verdict` event, set `engineStatus: engineStatus(run.verdict)`. |

The TUI/headline surfacing (#3-#5) is recommended but optional: deriving on read
means **no `runs`-table column and no migration**. If we defer the TUI surface,
#1-#2 alone fix the exit-code semantics the user reported.

What does **not** change: the decide branch logic ([pipeline.ts:2304](../../../src/pipeline.ts)),
`report()`, `reporter.ts`, `value-report.ts`, `taxonomy.ts`, the analytics views,
the Prometheus verdict list, and the `events.test.ts` six-verdict drift guard. The
verdict keeps its exact meaning and wire shape.

### 1.5 Testing

- Unit-test `engineStatus()` for all six verdicts → the table above.
- `cli.ts`: stub a record per verdict, assert the exit code (`fail`→0, `invalid`→1, …).
- Contract: assert the `run.verdict` event carries `engineStatus` matching the
  derivation. The existing `events.test.ts` drift guard stays green (verdict union
  unchanged).

---

## 2. Code-mode robustness (the emphasis)

### 2.1 Current state & root cause (verified)

The live failure: the agent wrote a clean-looking JUnit test; `mvn -B test` failed
with a compilation error (~9.3 s) and other modules `SKIPPED`; the run was
classified inconclusive. Four verified gaps explain it:

**Gap A — no compile-feedback gate.** Filter B (the static gate) is skipped
wholesale for code mode: `if (!isCode)` at
[src/pipeline.ts:1813](../../../src/pipeline.ts), with the comment "running the
repo's own suite IS the gate." For an **interpreted** language that is defensible;
for a **compiled** one it means the agent's compile error only ever surfaces as an
opaque non-zero build exit, with **no structured error fed back**. e2e, by
contrast, has a bounded static-fix loop that feeds the exact `tsc/eslint` errors
back to the agent and re-validates ([src/pipeline.ts:1823-1841](../../../src/pipeline.ts)).
Code mode has no equivalent — not on the first pass, and not in the retry loop
(the code branch re-runs the suite with **no** intervening validate:
[src/pipeline.ts:2111-2113](../../../src/pipeline.ts), vs the e2e branch's
re-validate at [src/pipeline.ts:2117](../../../src/pipeline.ts)).

**Gap B — whole-reactor execution.** The Maven command is hardcoded
`{ cmd: "mvn", args: ["-B", "test"] }` at
[src/qa/code-runner.ts:250](../../../src/qa/code-runner.ts), run with `cwd =
mirrorDir` (the repo root). For a reactor POM that compiles **and tests every
module**. The agent's one test in `customers-service` drags in the whole reactor;
any module's compile error fails the lot, and an unrelated module's failing test
would wrongly read as the agent's fault. There is no `-pl` scoping and no
`code.testCommand` override in the YAML — the command is computed, not configurable
([src/qa/code-runner.ts:192-260](../../../src/qa/code-runner.ts)).

**Gap C — the prompt is not code-aware.** `buildTask` has no code branch, so a
code run falls through to the **e2e diff task** ("Generate/update **E2E tests**…",
"explore ONLY the page(s)…", "if `e2e/.qa/context.json` exists…") —
[src/integrations/prompts.ts:1060](../../../src/integrations/prompts.ts). The
code-mode working-rules block ([prompts.ts:483-497](../../../src/integrations/prompts.ts))
carries the real guidance, but **nowhere is the agent told to compile-check before
finishing** — the e2e role step "verify discoverable: `playwright test --list`"
([agents/agent/qa-generator.md](../../../agents/agent/qa-generator.md) step 4, and
its Codex mirror [agent/roles/qa-generator.md](../../../agent/roles/qa-generator.md))
has no code-mode counterpart.

**Gap D — classification.** The binary classifier is correct *given* a clean
compile: exit 0 → `pass`, exit ≠ 0 → `fail`
([src/qa/code-runner.ts:501-510](../../../src/qa/code-runner.ts)); `spawnError`
(ENOENT/timeout) → `infra-error` ([code-runner.ts:478](../../../src/qa/code-runner.ts));
`ranZeroTests` → `infra-error` ([code-runner.ts:491](../../../src/qa/code-runner.ts)).
The problem is upstream: a **compile** failure (the agent's fault, fixable) is
lumped into `fail` (a real-bug verdict) with only 1500 chars of raw build output
as the single synthetic case's `detail` ([code-runner.ts:503-505](../../../src/qa/code-runner.ts)).
With the compile gate it becomes `invalid` *before* the run, with structured
feedback.

### 2.2 Design

#### 2.2a Compile-feedback gate — `src/qa/code-validate.ts` (the keystone)

A new module modeled exactly on [src/qa/validate.ts](../../../src/qa/validate.ts):
same `{ ok, errors, infra }` return ([validate.ts:38-42](../../../src/qa/validate.ts)),
same `runCheck` spawn/kill-tree/infra-detection contract
([validate.ts:73-105](../../../src/qa/validate.ts)) — an ENOENT/signal-kill/timeout
is `infra: true`, a non-zero exit is a real compile error.

The gate **compiles without running tests**, per ecosystem. It targets the
ecosystems where a pre-run compile catches the agent's errors; for interpreted
languages it is an honest no-op (the existing "the suite is the gate" rationale
holds there):

| Ecosystem | Compile-gate command | Notes |
|---|---|---|
| maven | `mvn -B test-compile` | compiles main + **test** sources, runs no tests; the priority case |
| gradle | `./gradlew testClasses` (or `gradle testClasses`) | language-agnostic test compile |
| node (TS) | `npx tsc --noEmit` **iff** `tsconfig.json` present | else no-op (plain JS has no compile step) |
| rust | `cargo check --tests` | type-checks tests without running |
| go | `go build ./...` | main packages; test-file compile errors still surface at run (Go compiles fast) |
| python / unknown / JS-no-tsconfig | no-op (`{ ok: true }`) | interpreted → errors surface at run, as today |

**Wiring (mirrors e2e exactly):**

- New DI dep on `PipelineDeps`: `validateCode?(repoDir, opts?): Promise<ValidationResult>`,
  wired in `defaultPipelineDeps` to `validateCodeProject(repoDir, defaultCodeValidateDeps)`,
  where `defaultCodeValidateDeps` picks the command from `detectCodeProject`.
- **Insertion point:** a symmetric block guarded `if (isCode && generating && deps.validateCode)`
  at [src/pipeline.ts:1813](../../../src/pipeline.ts) (the current `if (!isCode)`
  becomes `if (!isCode) { … } else if (deps.validateCode) { … }`), running the
  **same bounded static-fix loop** as e2e ([pipeline.ts:1823-1841](../../../src/pipeline.ts)):
  feed `validation.errors` back via `reviewCorrections` (single-agent), re-validate,
  `MAX_STATIC_FIX_ROUNDS` cap. On a still-failing gate: `infra` → `infra-error`
  ([pipeline.ts:1850](../../../src/pipeline.ts) path), real compile error →
  `invalid` ([pipeline.ts:1858](../../../src/pipeline.ts) path) + `foldRunLearning`.
- **Retry-loop symmetry:** the code branch at [pipeline.ts:2111-2113](../../../src/pipeline.ts)
  gains a `validateCode` call before re-`executeCode` (matching the e2e re-validate
  at [pipeline.ts:2117](../../../src/pipeline.ts)).
- **Coverage-enforce path:** [pipeline.ts:2224](../../../src/pipeline.ts) currently
  hardcodes `okStatic = isCode ? { ok: true } : validate(...)`; it becomes
  `isCode ? await deps.validateCode?.(mirrorDir) ?? { ok: true } : validate(...)`.
- **`persistOutcome` `staticOk`:** [pipeline.ts:1860](../../../src/pipeline.ts) and
  the green-path persist ([pipeline.ts:2381](../../../src/pipeline.ts)) set
  `staticOk: !isCode && generating`; once the code gate exists this becomes
  `generating && (isCode ? codeValidated : e2eValidated)` so the learning layer
  records the truth.

#### 2.2b Module scoping — diff-driven, safe fallback

Thread the already-available `intent.changedFiles`
([pipeline.ts:1556](../../../src/pipeline.ts), already in the generator prompt) to
`executeCode` **and** the compile gate, via a new `scopeCommand` in
`code-runner.ts`. It resolves each changed file to its owning module (nearest
ancestor `pom.xml` / `build.gradle` / `go.mod` / workspace `package.json`) and
narrows the command:

| Ecosystem | Scoped form | Blast-radius note |
|---|---|---|
| maven | `mvn -B -pl <m1>,<m2> -am test` (and `… test-compile` for the gate) | `-am` builds upstream deps so a clean checkout compiles |
| gradle | `./gradlew :<module>:test` | per-project task |
| go | `go test ./<pkgdir>/...` | the changed packages |
| node (workspace) | runner path-filter scoped to the changed package, **else root** | workspace layouts vary → conservative |

**Safety contract:** scoping is applied **only** when (a) `changedFiles` is
non-empty (diff mode) **and** (b) every changed file resolves to a module
unambiguously. Otherwise it falls back to the current root command — never a
wrong-scope. This keeps complete/exhaustive/manual and cross-repo runs on the full
command, exactly as today. (`CodeExecuteOptions` gains `changedFiles?: string[]`,
passed at both `executeCode` sites — [pipeline.ts:1889](../../../src/pipeline.ts),
[pipeline.ts:2113](../../../src/pipeline.ts).)

**Known trade-off (documented, not silently chosen):** scoping to the changed
module(s) tests the change's *own* module. In a tightly-coupled monorepo a change
in module A could be covered by a test in module B; pure `-pl A` would miss it.
The blast-radius answer is `-amd` ("also make dependents"), but that can explode to
the whole downstream set. For the priority case (petclinic microservices — modules
are independent) `-pl <module> -am` is correct and fast. We adopt `-pl … -am` and
record `-amd` as a future per-app opt-in rather than a default; module scoping is
**priority 2**, sequenced after the gate, so we can validate the gate's win first.

#### 2.2c Prompt + role tightening (pairs with 2a)

- `buildTask` ([prompts.ts:1060](../../../src/integrations/prompts.ts)): add a
  `if (input.target === "code")` branch returning a code-framed task (commit
  intent + changed files; **no** "E2E"/"explore page"/`context.json` wording).
- Working-rules ([prompts.ts:483-497](../../../src/integrations/prompts.ts)): add a
  **compile-before-finish** rule — the agent runs the ecosystem's compile check
  itself before emitting its verdict (the code-mode analogue of e2e's
  `playwright test --list`). Belt-and-suspenders with 2a: the agent fixes most
  errors itself; the gate catches the rest with the feedback loop.
- Role docs: add the code-mode compile step to
  [agents/agent/qa-generator.md](../../../agents/agent/qa-generator.md) step 4 and
  the Codex mirror [agent/roles/qa-generator.md](../../../agent/roles/qa-generator.md).

#### 2.2d Classification — falls out of 2a

No change to the binary classifier. With the gate in front, the test **run** only
executes on compiling code, so exit ≠ 0 = a genuine test failure = `fail` (real
bug → success → Issue), exit 0 = `pass`. Compile errors are caught earlier as
`invalid`. The `infra-error` cases (`spawnError`, `ranZeroTests`) are unchanged and
correct.

#### 2.2e Image verification (pre-flight, not a code change unless broken)

Confirm `mvn`, the JDK, `gradle`, `go`, `cargo`, `python3` actually run in the
**orchestrator** image (the root `Dockerfile` claims Maven/Gradle/Go/Rust/Python).
If `mvn` is absent/broken, every Java code run is `infra-error` regardless of the
agent — a Dockerfile fix, independent of the logic above. Verify with a one-off
`docker compose exec orchestrator mvn -v` (and peers) before trusting code-mode on
JVM.

### 2.3 Non-goals (YAGNI)

- **No JVM/Go change-coverage.** `coverageCommand` stays node-only
  ([code-runner.ts:582-583](../../../src/qa/code-runner.ts)) → `unknown` → never
  blocks. Intentional.
- **No per-test-case Maven surefire parsing.** The single synthetic case stays;
  richer `parseTestCounts` for surefire is observability, not correctness —
  optional follow-up.
- **No decide-logic rework** (it is correct).
- **No app-specific config.** Generic engine fixes only (per the invariant: nothing
  app-specific in `src/`).

### 2.4 Testing

- `code-validate.ts` unit tests per ecosystem: compile-ok → `{ ok: true }`;
  compile-fail → `{ ok: false, errors, infra: false }`; ENOENT/timeout →
  `infra: true`. Same stub pattern as `validate.test.ts`.
- `scopeCommand` unit tests: changedFiles → expected scoped command per ecosystem;
  empty/ambiguous → root command (fallback).
- Pipeline integration (stubs): a code run whose first `validateCode` fails then
  succeeds → static-fix loop runs once → `pass`; persistently failing → `invalid`;
  ENOENT → `infra-error`. Mirrors the existing e2e static-gate pipeline tests.

---

## 3. Why the two fixes belong together

With both in place, the agent's output is classified by *whose fault* a failure is,
and the status reflects whether the engine succeeded:

- Agent writes a test that **does not compile** → gate catches it → feedback loop →
  if unfixable, `invalid` → **error** (exit 1) + informative Issue.
- Agent writes a test that **compiles and a real assertion fails** → `fail` →
  **success** (exit 0) → Issue (a real bug, the engine did its job).
- Agent writes a test that **compiles and passes** → `pass` → **success** (exit 0)
  → PR.

That is exactly the user's stated semantic: *success for both "found a real bug
(→Issue)" and "all green (→PR)"; error reserved for the engine failing to do its
job.*

---

## 4. Sequencing (each its own green commit; `npm test` + `npm run typecheck` gate)

1. **Fix #1 — run status** (small, independent, low-risk): `engineStatus()` +
   `cli.ts` exit codes + contract surface + tests. Ships first.
2. **Fix #2a — compile gate** (the keystone): `code-validate.ts` + pipeline wiring
   (first pass + retry + coverage-enforce + `staticOk`) + tests.
3. **Fix #2c — prompt/role** (pairs with 2a): `buildTask` code branch +
   compile-before-finish + role docs.
4. **Fix #2b — module scoping** (after the gate proves out): `scopeCommand` +
   threading + tests.
5. **Fix #2e — image verification** (anytime): confirm runtimes; Dockerfile fix
   only if broken.

---

## 5. Risks & open questions

- **R1 — `flaky`/`invalid` mapping.** `flaky`→success and `invalid`→error are
  deliberate (§1.2-1.3). If a stakeholder wants `flaky` to remain exit-1
  (treat instability as a soft failure), it is a one-line change in `engineStatus`.
- **R2 — Maven `test-compile` reactor scope.** Before module scoping (step 4) the
  gate compiles the whole reactor — still a big win (catches the agent's error with
  feedback, no test run) but slower on large monorepos. Step 4 narrows it.
- **R3 — module resolution correctness.** The safety contract (scope only on
  unambiguous resolution, else root) is the guard; the tight-coupling trade-off
  (§2.2b) is the one place to watch — covered by the conservative `-pl … -am`
  default and the `-amd` future opt-in.
- **R4 — image runtimes.** §2.2e must pass before code-mode-on-JVM is trustworthy;
  it is the most likely explanation for the live `infra-error` and is verified out
  of band.
