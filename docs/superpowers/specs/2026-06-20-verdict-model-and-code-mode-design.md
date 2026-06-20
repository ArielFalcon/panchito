# Design — Run-status model + code-mode robustness (definitive, post-judgment-day)

**Date:** 2026-06-20
**Author:** brainstorming session, hardened by **two** rounds of two-judge adversarial review
**Status:** definitive — ready for implementation planning

> This is the **definitive** version. Two blind judgment-day rounds reviewed it
> against the real code. Round 1 (against the first draft) found ~20 issues; the
> material catches were: the compile gate was unreliable run whole-reactor
> (cross-module errors poison the agent's feedback), Maven build output leaked
> secrets to the agent unsanitized, a code-mode real-bug `fail` would have poisoned
> the learning loop, a third `executeCode` call site was missed, and the Go gate
> did not compile test files. Round 2 (against the revision) confirmed those fixes
> landed and caught precision bugs — a wrong `JAVA_HOME` error string, an
> `engineStatus`-required-vs-optional tension, an unaddressed red `✗` glyph, a
> stale `listChangedSpecs` reference, and an over-large step 2. Every *real*
> finding from both rounds is folded in; the §6 changelog traces each.

## Objective

Two changes, one shared semantic:

1. **Run status ≠ test verdict.** A run that *executed correctly and produced a
   trustworthy result* must report **success** (exit 0) — green (→ PR) or a real
   bug found (→ Issue). Only a run where *the engine itself could not do its job*
   (infra fault, or it could not produce runnable tests) reports **error**
   (exit ≠ 0). Today a `fail` verdict (a real bug found → Issue → the engine did
   the right thing) exits non-zero, identical to a crash.

2. **Code-mode must be production-reliable on complex projects** (e.g. a
   Java/Spring Maven monorepo). Today code-mode has **no compile-feedback gate**
   and **runs the whole reactor**, so the agent's compile errors surface as an
   opaque whole-build failure with no structured, scoped feedback loop — the exact
   failure observed live on `spring-petclinic-microservices`.

The two are connected ([§3](#3-why-the-two-fixes-belong-together)): the compile
gate turns "the agent's test does not compile" into `invalid` (→ error), and "the
test compiles and a test fails" into `fail` (→ success → Issue) — exactly the
status semantics of fix #1.

---

## 1. Run status — `success | error` derived from the verdict

### 1.1 Current state (verified)

- `RunVerdict = "pass" | "fail" | "flaky" | "invalid" | "infra-error" | "skipped"`
  — [src/types.ts:88](../../../src/types.ts). A string union.
- The decide step maps verdict → action **correctly already**: `if (run.verdict !== "pass")`
  → `report()` (the `switch (run.verdict)` body lives in the `report()` function
  defined at [src/pipeline.ts:2445](../../../src/pipeline.ts), switch at ~2461)
  opens an Issue for `fail`/`invalid`, logs `infra-error`/`flaky`; the `pass`
  branch publishes a PR (or files an Issue when the reviewer rejected / coverage
  blocks) — [src/pipeline.ts:2304](../../../src/pipeline.ts). **This logic is not
  the problem and does not change.**
- The **exit code is the problem.** Both CLI paths compute success as
  `ok = verdict === "pass" || verdict === "skipped"` →
  [src/cli.ts:83](../../../src/cli.ts) (delegated) and
  [src/cli.ts:129](../../../src/cli.ts) (standalone). So `fail`, `flaky`,
  `invalid`, `infra-error` all exit 1 — a real-bug-found run is indistinguishable
  from an engine crash to anything consuming the code.

### 1.2 Design — one pure derivation, surfaced as a first-class field

`engineStatus` is a **pure function of the verdict** — no verdict's status is
ambiguous, so it is derived everywhere, never independently stored. It is
**surfaced as a contract field** (not just used for the CLI exit code) so
REST/automation consumers — not only the CLI — see it (judgment-day #9: a CI
polling `/api/v1/runs/:id` would otherwise still read `verdict:"fail"` as a broken
build). **Required on the `run.verdict` SSE event** (a verdict is always present
there); **optional on `RunRecordSchema`** — a run in `enqueued`/`running` has no
verdict yet, and a still-running run is not an "error", so the field is absent
until the run is `done` (Round-2 finding: a required field derived from the
then-`undefined` verdict would mislabel a live run as error).

Following the project's TypeScript const-types convention (judgment-day #13):

```ts
// src/types.ts
export const RUN_ENGINE_STATUSES = { SUCCESS: "success", ERROR: "error" } as const;
export type RunEngineStatus = (typeof RUN_ENGINE_STATUSES)[keyof typeof RUN_ENGINE_STATUSES];

// The engine SUCCEEDED when it ran and produced a trustworthy result + took the
// right action: green (→PR), real bug (→Issue), unstable (→quarantine), or
// nothing-to-do. It ERRORED when it could not do its job: an infrastructure
// fault, it could not produce runnable tests (specs never passed the static
// gate), or no verdict was recorded at all. The PR-vs-Issue distinction lives one
// level down, in the verdict — engineStatus does not replace it. null/undefined
// (never recorded, or a wire value that never arrived) is treated as error.
export function engineStatus(verdict: RunVerdict | null | undefined): RunEngineStatus {
  return verdict == null || verdict === "infra-error" || verdict === "invalid"
    ? RUN_ENGINE_STATUSES.ERROR
    : RUN_ENGINE_STATUSES.SUCCESS;
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

Only `fail` and `flaky` change exit behavior. The Issue/PR/quarantine *action* for
every verdict is untouched — `engineStatus` is orthogonal to *what artifact the
run produced*.

### 1.3 The one judgment call — `invalid` is `error`

`invalid` = the agent's generated specs never passed the static gate, so they were
**never executed** ([src/types.ts:82-83](../../../src/types.ts);
[src/pipeline.ts:1858](../../../src/pipeline.ts)). The engine did not produce a
trustworthy result — it produced broken tests → `error` (exit 1). It still opens
its informative Issue (Issue-filing is driven by the verdict in `report()`,
independent of `engineStatus`); the two coexist.

### 1.4 Change points (verified)

| # | File:line | Change |
|---|---|---|
| 1 | [src/types.ts:88](../../../src/types.ts) | Add `RUN_ENGINE_STATUSES` + `RunEngineStatus` + `engineStatus()`. |
| 2 | [src/cli.ts:83](../../../src/cli.ts), [src/cli.ts:129](../../../src/cli.ts) | Both paths → `engineStatus(...) === "success"`. Standalone: `engineStatus(record?.verdict)`. Delegated: the wire field is `string \| null` — **do not cast**; run it through `RunVerdictSchema.safeParse(result.verdict)` (importable from `contract/events.ts` — no layering violation, `cli.ts` already imports deeper `server/*`) and pass the parsed value (or `null` on miss) to `engineStatus` (judgment-day #13: an `as RunVerdict` cast would silently map an unknown string to success). |
| 3 | [src/contract/events.ts:18](../../../src/contract/events.ts),[:60](../../../src/contract/events.ts) | Add `RunEngineStatusSchema` and a **required** `engineStatus` on the `run.verdict` SSE event (verdict always present there). |
| 4 | [src/contract/commands.ts:54](../../../src/contract/commands.ts) | Add **optional** `engineStatus` to `RunRecordSchema` (absent while running; derived on read from `verdict` once `done`). |
| 5 | [src/server/runner.ts:196](../../../src/server/runner.ts) | On the terminal event/record set `engineStatus: engineStatus(run.verdict)`; omit it while the run is still in-flight. |
| 6 | [src/qa/value-report.ts:53](../../../src/qa/value-report.ts),[:84](../../../src/qa/value-report.ts),[:126](../../../src/qa/value-report.ts) | **Reframe `fail` across all three surfaces** so the CLI report is internally consistent with exit 0 (judgment-day #10 + Round-2): `verdictStyle` (`:53`, today red `✗`, same as `invalid`) → a distinct non-error glyph/color (e.g. amber `!` "real bug found"); `deriveAction` (`:84`) and `verdictGloss` (`:126`) → "real bug found → Issue filed (engine succeeded)". |

Deriving on read means **no `runs`-table column and no migration**. What does
**not** change: the decide branch logic ([pipeline.ts:2304](../../../src/pipeline.ts)),
`report()`, `reporter.ts`, `taxonomy.ts`, and the `events.test.ts` six-verdict
drift guard (the verdict union is unchanged).

**Operational notes (not code, but ship with the change):**
- [src/server/history.ts:1034](../../../src/server/history.ts) `approveRate` counts
  `verdict ∈ {pass, skipped}`. It is intentionally a *green-rate*, **not** an
  engine-success-rate — a `fail`→Issue run is `engineStatus=success` yet not
  "approved". Add a one-line code comment at that site stating this explicitly, so
  the next reader doesn't conflate `approveRate` with engine-success (judgment-day
  #5/A5 + Round-2).
- [src/index.ts:252](../../../src/index.ts) Prometheus emits
  `…_runs_total{verdict=…}`. Add an `engine_status` label (or a
  `…_engine_errors_total` counter) and note that existing alerts on `verdict="fail"`
  now fire on a *success* signal (a real bug found), so dashboards must migrate
  (judgment-day #B4).

### 1.5 Testing

- Unit-test `engineStatus()` for all six verdicts + `null`/`undefined` → the table.
- `cli.ts`: stub a record per verdict, assert the exit code (`fail`→0, `invalid`→1,
  …) and the `safeParse` miss path (garbage wire verdict → error/exit 1).
- Contract: the `run.verdict` event/record carries `engineStatus` matching the
  derivation. `events.test.ts` drift guard stays green.

---

## 2. Code-mode robustness (the emphasis)

### 2.1 Current state & root cause (verified)

Live failure: the agent wrote a clean-looking JUnit test; `mvn -B test` failed with
a compilation error (~9.3 s), other modules `SKIPPED`; the run was inconclusive.
Four verified gaps:

**Gap A — no compile-feedback gate.** Filter B is skipped wholesale for code mode:
`if (!isCode)` at [src/pipeline.ts:1813](../../../src/pipeline.ts). For an
*interpreted* language that is defensible; for a *compiled* one the agent's compile
error only ever surfaces as an opaque non-zero build exit with **no structured
error fed back**. e2e has a bounded static-fix loop that feeds the exact errors
back and re-validates ([src/pipeline.ts:1823-1841](../../../src/pipeline.ts)); code
mode has no equivalent — not on the first pass, and not in the retry loop (the code
branch re-runs the suite with **no** intervening validate:
[src/pipeline.ts:2111-2113](../../../src/pipeline.ts), vs the e2e re-validate at
[src/pipeline.ts:2117](../../../src/pipeline.ts)).

**Gap B — whole-reactor execution.** The Maven command is hardcoded
`{ cmd: "mvn", args: ["-B", "test"] }` ([src/qa/code-runner.ts:250](../../../src/qa/code-runner.ts)),
`cwd = mirrorDir` (repo root) → compiles and tests **every module**. No `-pl`
scoping; not configurable ([src/qa/code-runner.ts:192-260](../../../src/qa/code-runner.ts)).

**Gap C — the prompt is not code-aware.** `buildTask` has no code branch, so a code
run falls through to the **e2e diff task** ("Generate/update **E2E tests**…",
"explore ONLY the page(s)…") — [src/integrations/prompts.ts:1060](../../../src/integrations/prompts.ts).
The code working-rules block ([prompts.ts:483-497](../../../src/integrations/prompts.ts))
carries the real guidance but never tells the agent to compile-check before
finishing (the e2e role's `playwright test --list`, qa-generator.md step 4, has no
code-mode counterpart).

**Gap D — classification.** Given a clean compile the binary classifier is correct:
exit 0 → `pass`, exit ≠ 0 → `fail` ([code-runner.ts:501-510](../../../src/qa/code-runner.ts));
`spawnError` (ENOENT/timeout) → `infra-error` ([code-runner.ts:478](../../../src/qa/code-runner.ts));
`ranZeroTests` → `infra-error` ([code-runner.ts:491](../../../src/qa/code-runner.ts)).
The problem is upstream: a **compile** failure (the agent's fault, fixable) is
lumped into `fail` with only a 1500-char raw-output tail as the single synthetic
case's detail ([code-runner.ts:503-505](../../../src/qa/code-runner.ts)).

### 2.2 Design

> **Ordering decision (judgment-day #1, the single most important revision).**
> The compile gate is **unreliable when run whole-reactor**: at the reactor root,
> a pre-existing or cross-module compile error (in a module the agent never
> touched) pollutes the structured feedback, sending the agent to chase errors it
> cannot fix until it exhausts the repair budget → a false `invalid` on a run whose
> own generated code was correct; and it is slow. Therefore **module scoping
> (§2.2b) is a prerequisite of the gate, not a later step.** `scopeCommand` is
> built first and used by *both* the compile gate and the test run.

#### 2.2a Module-scoped command resolution — `scopeCommand` (built first)

A pure `scopeCommand(project, repoDir, changedFiles): Command` in `code-runner.ts`.
It resolves each changed file to its owning module and narrows the command:

| Ecosystem | Test run | Compile gate | Module = nearest ancestor… |
|---|---|---|---|
| maven | `mvn -B -pl <m…> -am test` | `mvn -B -pl <m…> -am test-compile` | `pom.xml` (or, if the changed file **is** a `pom.xml`, its own directory) |
| gradle | `./gradlew :<m>:test` | `./gradlew :<m>:testClasses` | `build.gradle[.kts]` |
| go | `go test ./<pkg>/...` | `go vet ./<pkg>/...` | the package dir of `go.mod` |
| node (workspace) | runner path-filter scoped to the package, **else root** | `tsc --noEmit` (project-wide) | workspace `package.json` |

**Safety + observability contract (judgment-day #4/#8):**
- Scope only when `changedFiles` is non-empty **and every** changed file resolves
  to a module unambiguously. Otherwise **fall back to the root command** — never a
  wrong scope.
- A changed file that **is** a module descriptor (`customers-service/pom.xml`,
  `build.gradle`) resolves to *its own directory's* module, not the parent (a
  common monorepo pattern: a per-service dependency bump).
- **Log every fallback with a reason that distinguishes the two cases** (Round-2):
  *expected* — non-diff mode (complete/exhaustive/manual) has no `changedFiles`
  (`intent` is only set in diff mode, [pipeline.ts:2280](../../../src/pipeline.ts)),
  so the root command is correct and normal; vs *scope-loss* — a **diff** run where
  a changed file did not resolve to a module (e.g. a root-aggregator `pom.xml`, a
  CI-config change alongside service files). Only the second is a missed
  optimization worth an operator's attention. Distinct log lines so a silent
  whole-reactor diff run is never mistaken for a scoped one. (Consequence,
  acknowledged: a common cross-cutting commit — a root `pom.xml` bump *plus* a
  service change — fails "every file resolves" and runs the full reactor; v1
  accepts this, the R3 hardening is to scope to the resolvable subset.)
- **Zero-test honesty under scoping (judgment-day #4/A3):** scoping *improves*
  `ranZeroTests`. Today a misplaced agent test runs nothing, yet a sibling module's
  tests print `Tests run: N` → `ranZeroTests` false → a **false `pass`** (green
  with the agent's test never executed). Scoped to the agent's module, no
  `Tests run` line → `ranZeroTests` true → honest `infra-error`. Add an explicit
  surefire "No tests were executed"/"No tests found" match alongside the absence of
  `Tests run: [1-9]` so the signal is unambiguous.

**Backward-compatible:** empty/ambiguous `changedFiles` (complete/exhaustive/manual,
cross-repo) → the root command, exactly as today.

**Known limitation, documented not hidden (judgment-day #1/B9/A11):** `-pl <m> -am`
builds **upstream** deps but neither tests nor isolates from pre-existing compile
errors in those upstream modules; and a test that *imports from a peer* module can
miss it. For the priority case (petclinic microservices — independent modules) this
is correct and fast. The deeper fix — *attribute each compile error to a file and
only feed the agent errors in files it generated* — is recorded as the next
hardening (R3), not v1. A future per-app `-amd` ("also make dependents") opt-in
covers tightly-coupled monorepos.

#### 2.2b Compile-feedback gate — `src/qa/code-validate.ts`

A **separate** module modeled on [src/qa/validate.ts](../../../src/qa/validate.ts):
same `{ ok, errors, infra }` return ([validate.ts:38-42](../../../src/qa/validate.ts)),
same `runCheck` spawn/kill-tree/infra-detection contract
([validate.ts:73-105](../../../src/qa/validate.ts)) — ENOENT/signal-kill/timeout →
`infra: true`, a non-zero exit → a real compile error.

**Explicitly (judgment-day #B6):** `validateCodeProject` returns a
`ValidationResult` and **never routes through `runCodeTests`/`ranZeroTests`** — so a
clean `mvn test-compile` (exit 0, no "Tests run") is *never* misread as "zero
tests". A unit test asserts `ranZeroTests` is never called with gate output.

Per-ecosystem compile commands are the **gate** column of §2.2a (Go is
`go vet ./...`, **not** `go build ./...`: judgment-day #2 — `go build` skips
`_test.go`, so it would be a no-op for the agent's output). Interpreted languages
(plain JS without `tsconfig`, python, unknown) are an honest **no-op** (`{ ok: true }`)
— the "the suite is the gate" rationale holds there.

**Go-gate caveats (Round-2):** `go vet` type-checks `_test.go` and exits non-zero on
a compile error — but it needs the module cache warm (it does not download deps).
The gate runs **after** `setupCodeProject` (which runs `go mod download`,
[code-runner.ts:236](../../../src/qa/code-runner.ts)) and **after** generation, so
the cache is warm by then — but the wiring must keep that order (gate at
[pipeline.ts:1813](../../../src/pipeline.ts), post-setup, post-generate). `go vet`
reliably catches ordinary type errors in agent test files; truly exotic cases
(external `_test` package importing an out-of-scope symbol) may differ from a `go build`
link error — acceptable, since the run itself is the final backstop for Go.

**Toolchain-misconfig → infra, not invalid (judgment-day #8 + Round-2):** a
present-but-broken toolchain (missing/incorrect `JAVA_HOME`, missing JDK, bad `M2`
settings) makes `mvn` exit non-zero *without compiling anything*. That must be
`infra-error` (inconclusive), **not** `invalid` (an Issue blaming the agent).
`code-validate.ts` matches the toolchain-failure signatures and routes them to the
`infra: true` path. **The signature strings must match the REAL launcher output**
(Round-2 caught the draft's `"JAVA_HOME is not defined"` as wrong): use a
case-insensitive regex over the actual messages — `mvn`:
`The JAVA_HOME environment variable is not correctly set`; `mvnw`:
`Error: JAVA_HOME is not set and could not be found`; javac/compiler-plugin:
`No compiler is provided in this environment`, `Unable to locate the Javac Compiler`,
`Perhaps you are running on a JRE rather than a JDK`. Pattern-matching stderr is
inherently best-effort/fragile, so it is the **secondary** defense — the
**primary** guarantee is the §2.2e step-0 image-runtime check, which removes the
misconfig before any run. (Residual risk: a watched repo whose own legitimate
compile error text happens to contain one of these phrases → false `infra-error`,
i.e. inconclusive rather than a wrong Issue — the safe direction.)

**Secret-safe feedback (judgment-day #6, CLAUDE.md "sanitize data leaving the
system"):** real Maven output can contain `pom.xml` `<properties>` (endpoints,
passwords), local-repo paths, profile values. e2e is safe because tsc/eslint output
is clean; code-mode is not. The gate's `errors` are passed through
`sanitizeText` ([src/orchestrator/sanitizer.ts](../../../src/orchestrator/sanitizer.ts))
**before** they reach the `reviewCorrections` payload.

**Wiring (mirrors e2e, with the code-mode corrections above):**

- New DI dep on `PipelineDeps`:
  `validateCode?(repoDir, opts: { changedFiles?: string[] }): Promise<ValidationResult>`,
  wired in `defaultPipelineDeps` to `validateCodeProject(...)`.
- **Insertion point:** the current `if (!isCode) { … }` at
  [pipeline.ts:1813](../../../src/pipeline.ts) gains an `else if (deps.validateCode)`
  branch. **Only the static-gate lines (1813-1868) are mirrored** — the e2e
  health-pre-flight at [pipeline.ts:1870-1880](../../../src/pipeline.ts) stays
  e2e-only (code mode has no `versionUrl`, so `devHealthy()` is trivially true)
  (judgment-day #A6: stated so an implementer doesn't hoist the health check).
  The branch runs the **same bounded static-fix loop** as e2e
  ([pipeline.ts:1823-1841](../../../src/pipeline.ts)): feed *sanitized*
  `validation.errors` back via `reviewCorrections` (single-agent), re-validate,
  `MAX_STATIC_FIX_ROUNDS` cap. The `reviewCorrections` text **includes an explicit
  "re-compile with `<gate command>` and confirm exit 0 before finishing"**
  instruction, not just the raw errors (judgment-day #A10). On a still-failing
  gate: `infra` → `infra-error`, real compile error → `invalid` + `foldRunLearning`.
- **Generation-guard for code mode (judgment-day #12/A4 + Round-2):** the e2e loop
  guard `(result?.specs.length ?? 0) > 0` ([pipeline.ts:1826](../../../src/pipeline.ts))
  assumes the agent populates `result.specs`. In code mode the agent may report
  `specs: []` while having written test files (the manifest write is skipped for
  `target !== "code"`). Note `listChangedSpecs` is **not** usable here — it returns
  early for code mode (`if (isCode || !deps.listChangedSpecs) return r;`,
  [pipeline.ts:1247](../../../src/pipeline.ts)). The code branch instead guards on
  the **write-confinement scan** (which *does* run for code mode and already walks
  the working copy for agent-written files): fire the gate whenever the confinement
  result shows generation touched any file under the repo.
- **Retry-loop symmetry:** the code branch at
  [pipeline.ts:2111-2113](../../../src/pipeline.ts) gains a `validateCode` call
  (scoped) before re-`executeCode`.
- **Coverage-enforce path — all THREE call sites (judgment-day #5):** the
  `executeCode` re-run at [pipeline.ts:2228](../../../src/pipeline.ts) is a **third**
  call site (besides 1889 and 2113) that must carry `changedFiles`; and
  [pipeline.ts:2224](../../../src/pipeline.ts)'s `okStatic = isCode ? {ok:true} : …`
  becomes `isCode ? (await deps.validateCode?.(mirrorDir, { changedFiles }) ?? { ok: true }) : …`.
- **`staticOk` at BOTH persist sites (judgment-day #3):** `persistOutcome`
  ([pipeline.ts:2381](../../../src/pipeline.ts)) **and** `foldRunLearning`
  ([pipeline.ts:2385](../../../src/pipeline.ts)) hardcode `staticOk: !isCode && generating`.
  Both become `generating && (isCode ? codeValidated : e2eValidated)`, where
  `let codeValidated = true` is initialized optimistically (so an absent
  `deps.validateCode` does not record a false `staticOk:false`) and set from the
  gate result when it runs.
- **Breaking-change callout:** adding `changedFiles` to `CodeExecuteOptions`
  ([code-runner.ts:358-363](../../../src/qa/code-runner.ts)) and a new
  `validateCode` to `PipelineDeps` changes interfaces that existing tests stub —
  the stubs in `pipeline.test.ts` (and any `executeCode`/`PipelineDeps` fakes) must
  be updated.

#### 2.2c Classification + learning (Gap D)

- With the gate in front, the test **run** executes only on compiling code: exit ≠ 0
  = a genuine test failure = `fail` (real bug → success → Issue); exit 0 = `pass`.
  Compile errors are caught earlier as `invalid`. No change to the binary
  classifier.
- **Do not let a code-mode `fail` poison the learning loop (judgment-day #7/A14).**
  A code-mode `fail` means the agent's test *correctly* caught a real bug — the
  test must NOT become a "fix this test" learning rule. `foldRunLearning` has **two**
  distillation paths (Round-2 finding): `reflectAndDistill`
  ([pipeline.ts:1777](../../../src/pipeline.ts), the LLM-reflection preventive rule —
  a code `fail` is `E-EXEC-FAIL`, which currently passes the existing
  `E-INFRA`/`E-FLAKY` filter and *would* fire) **and** `distillCorrections`
  ([pipeline.ts:1726](../../../src/pipeline.ts), distilling reviewer corrections —
  the reviewer runs during generation in code mode, so its corrections can be
  non-empty even on a `fail`). Gate **both** with `if (!(isCode && v.verdict === "fail"))`
  so the flywheel never learns to "repair" a correct, bug-finding test. (The `fail`
  still files its Issue and is recorded; only the distill-a-corrective-rule steps are
  suppressed.)

#### 2.2d Prompt + role tightening (Gap C)

- `buildTask` ([prompts.ts:1060](../../../src/integrations/prompts.ts)): add a
  `if (input.target === "code")` branch returning a code-framed task (commit intent
  + changed files; no "E2E"/"explore page"/`context.json` wording).
- **Trace the assembly to avoid contradiction (judgment-day #11/B12):** the
  existing `isCode` working-rules block ([prompts.ts:483-497](../../../src/integrations/prompts.ts))
  and the new `buildTask` branch both land in the same prompt. **Consolidate** the
  code-mode guidance so the two are additive, not conflicting — one code-mode voice.
  Add the **compile-before-finish** rule (the agent runs the ecosystem's compile
  command itself before its verdict — the code analogue of e2e's `--list`), and
  mirror it into [agents/agent/qa-generator.md](../../../agents/agent/qa-generator.md)
  step 4 and the Codex mirror [agent/roles/qa-generator.md](../../../agent/roles/qa-generator.md).

#### 2.2e Image-runtime verification — **step 0, blocking (judgment-day #8)**

Before any of the above ships, confirm `mvn`, the JDK, `gradle`, `go`, `cargo`,
`python3` actually run in the **orchestrator** image (root `Dockerfile` claims
them). If `mvn` is absent, *every* Java run is `infra-error` regardless of the
agent — and after §2.2b the gate's `infra: true` path would be indistinguishable
from the old behavior, so an implementer could ship steps and never notice the
runtime is broken. Verify out of band first:
`docker compose exec orchestrator sh -c 'mvn -v && javac -version && gradle -v && go version'`.
Promoted from "anytime" to **step 0**.

#### 2.2f Execution feedback for monorepos (judgment-day #14 — minimal, in-scope)

The single synthetic `QaCase`'s `detail` is `tail(sanitized.text, 1500)`
([code-runner.ts:503-505](../../../src/qa/code-runner.ts)). On a reactor the last
1500 chars are often a generic `BUILD FAILURE` summary that **misses** the actual
failing module — undermining "consistent, diagnosable results". Minimal fix
(correctness-adjacent, not full per-test parsing):
- Capture **head + tail** (first N + last N chars) so the failing-module section is
  not dropped; and
- extract the failing test identifier from surefire when present
  (`<<< FAILURE!` / `[ERROR] method(Class)`) into the case detail.
Full per-test Surefire parsing remains a non-goal (§2.3).

### 2.3 Non-goals (YAGNI)

- **No JVM/Go change-coverage.** `coverageCommand` stays node-only
  ([code-runner.ts:582-583](../../../src/qa/code-runner.ts)) → `unknown` → never
  blocks. Intentional.
- **No full per-test Surefire result model.** §2.2f does head+tail + a failing-class
  line; a structured per-method case list is a later observability improvement.
- **No compile-error-to-file attribution** in v1 (the deeper fix for cross-module
  feedback pollution) — documented as R3, after scope-first proves out.
- **No decide-logic rework** (it is correct).
- **No app-specific config** (the invariant: nothing app-specific in `src/`).

### 2.4 Testing

- `scopeCommand` unit tests: per-ecosystem scoped command; changed file IS a
  `pom.xml` → its own module; empty/ambiguous → root (+ a fallback log assertion);
  the surefire zero-test honesty match.
- `code-validate.ts` unit tests per ecosystem: compile-ok → `{ ok: true }`;
  compile-fail → `{ ok: false, infra: false }`; ENOENT/timeout → `infra: true`;
  a JDK-misconfig signature → `infra: true` (not a compile error); a secret in the
  output → sanitized before it appears in `errors`; **assert it never calls
  `runCodeTests`/`ranZeroTests`**.
- Pipeline integration (updated stubs): a code run whose first `validateCode` fails
  then succeeds → static-fix loop → `pass`; persistently failing → `invalid`;
  ENOENT → `infra-error`; a code-mode `fail` → Issue **and no corrective learning
  rule distilled**; `engineStatus` on the record is `success` for that `fail`.

---

## 3. Why the two fixes belong together

With both in place, failures are classified by *whose fault* they are, and the
status reflects whether the engine succeeded:

- Agent writes a test that **does not compile** → gate catches it (scoped,
  sanitized, with a re-compile instruction) → feedback loop → if unfixable,
  `invalid` → **error** (exit 1) + informative Issue.
- Agent writes a test that **compiles and a real assertion fails** → `fail` →
  **success** (exit 0) → Issue (a real bug; the engine did its job; no "fix this
  test" learning).
- Agent writes a test that **compiles and passes** → `pass` → **success** (exit 0)
  → PR.

Exactly the user's stated semantic: *success for both "found a real bug (→Issue)"
and "all green (→PR)"; error reserved for the engine failing to do its job.*

---

## 4. Sequencing (each its own green commit; `npm test` + `npm run typecheck` gate)

Step 2 is deliberately **split into three independently-reviewable green commits**
(Round-2 finding: a single commit bundling scoping + a new module + 5 pipeline edit
sites + learning + sanitization + stubs is unreviewable and against
"stable/reliable/deterministic"). Each commit keeps `npm test` green; they need not
be independently *releasable*, only individually reviewable and bisectable.

0. **Image-runtime verification** (blocking, no code): confirm mvn/JDK/gradle/go/
   cargo/python3 in the orchestrator image; Dockerfile fix only if broken.
1. **Fix #1 — run status** (small, independent): `RUN_ENGINE_STATUSES` +
   `engineStatus()` + cli.ts (safeParse) + the contract field (required on the
   event, optional on the record) + value-report reframing (all three surfaces) +
   tests.
2a. **`scopeCommand` (pure) + `changedFiles` plumbing**: the pure resolver + its
    unit tests + thread `changedFiles` through `CodeExecuteOptions` to all three
    `executeCode` sites (1889/2113/2228). No behavior change yet when `changedFiles`
    is empty (still root); stubs updated.
2b. **`code-validate.ts` + first-pass gate**: the new module (consuming
    `scopeCommand`, never routing through `runCodeTests`) + the `else if (deps.validateCode)`
    branch at 1813 (static-fix loop, sanitized feedback, toolchain→infra,
    filesystem generation-guard) + DI wiring + tests.
2c. **gate in the loops + learning correctness**: retry-loop `validateCode`,
    coverage-enforce `validateCode` (2224), both `staticOk` sites (2381/2385 with
    optimistic `codeValidated`), and the `reflectAndDistill`/`distillCorrections`
    suppression for `isCode && fail` + tests.
3. **Fix #2d — prompt/role** (pairs with 2b/2c; never ship standalone — the
   compile-before-finish instruction is meaningful only once the gate exists):
   `buildTask` code branch, consolidated with the working-rules block +
   compile-before-finish + role docs.
4. **Fix #2f — execution feedback**: head+tail + surefire failing-class extraction.

---

## 5. Risks & open questions

- **R1 — `flaky`/`invalid` mapping.** `flaky`→success, `invalid`→error are
  deliberate (§1.2-1.3); a one-line change in `engineStatus` flips either.
- **R2 — gate must be scope-first.** Resolved by making §2.2a a prerequisite of
  §2.2b; the whole-reactor gate is never shipped.
- **R3 — cross-module feedback pollution.** Even scoped, `-pl … -am` can surface a
  pre-existing **upstream** compile error or miss a **peer-module** import. v1
  scopes to the changed module (correct for independent-module monorepos like
  petclinic); the hardening is compile-error-to-file attribution (feed the agent
  only errors in files it generated) + an optional per-app `-amd`.
- **R4 — toolchain/image.** §2.2e (step 0) + the in-band toolchain→infra detection
  (§2.2b) together prevent a misconfigured JDK from filing `invalid` Issues on
  watched repos.
- **R5 — node-workspace scoping** falls back to root (documented), so node
  monorepos stay unscoped in v1 — acceptable (the priority is JVM); revisit if a
  node-monorepo app is onboarded.

---

## 6. Judgment-day revision log (draft → definitive)

Two blind judges reviewed the first draft against the real code. Folded-in real
findings:

- **#1 (CRITICAL)** Whole-reactor compile gate pollutes feedback / is slow →
  **module scoping is now a prerequisite of the gate** (§2.2, ordering decision),
  not a deferred step 4.
- **#2** `go build ./...` skips `_test.go` → gate command is **`go vet ./...`** (§2.2a/b).
- **#3** `staticOk` fix incomplete → covers `foldRunLearning:2385` too, with
  `codeValidated` optimistic init (§2.2b).
- **#4/#8** Module-scoping edges → pom.xml-as-changed-file, logged fallbacks,
  surefire zero-test honesty (§2.2a).
- **#5 (CRITICAL)** Missed third `executeCode` site (2228) + breaking stub
  signatures (§2.2b).
- **#6** Maven output leaked secrets to the agent → `sanitizeText` before
  `reviewCorrections` (§2.2b).
- **#7** Code-mode `fail` would poison the learning loop → `reflectAndDistill`
  suppressed for `isCode && fail` (§2.2c).
- **#8** Toolchain misconfig → `infra` not `invalid`; image verify promoted to
  **step 0** (§2.2b/e).
- **#9** `engineStatus` made a **required** contract field, not optional (§1.2/1.4).
- **#10** `value-report.ts` reframed so the CLI doesn't show "FAIL"+exit 0 (§1.4).
- **#11** `buildTask` code branch consolidated with the working-rules block (§2.2d).
- **#12** Code-mode generation guard switched to a filesystem check (§2.2b).
- **#13** `as RunVerdict` cast → `RunVerdictSchema.safeParse`; const-types pattern
  for `RunEngineStatus` (§1.2/1.4).
- **#14** Monorepo execution feedback → head+tail + surefire failing-class (§2.2f).
- Minor: citation corrected (`report()` at 2445/switch ~2461); `approveRate` and
  Prometheus operational notes added (§1.4).

### Round 2 (against the revision) — precision + structure

- **engineStatus required↔optional**: required on the SSE event, **optional** on
  `RunRecordSchema` (a still-running run has no verdict and is not an error) (§1.2/1.4).
- **`JAVA_HOME` string was wrong**: corrected to the real `mvn`/`mvnw`/javac
  messages via regex; step-0 image check is the primary defense (§2.2b).
- **`verdictStyle` red `✗`** for `fail` (same as `invalid`) would contradict exit
  0 → distinct glyph/color added as a third value-report surface (§1.4 row 6).
- **`listChangedSpecs` is unavailable for code mode** (early-returns at 1247) → the
  generation-guard uses the write-confinement scan instead (§2.2b).
- **Both** learning-distill paths gated for `isCode && fail` — `reflectAndDistill`
  *and* `distillCorrections` (the reviewer runs in code-mode generation) (§2.2c).
- **Step 2 split** into 2a/2b/2c independently-reviewable commits (§4).
- `go vet` caveats (warm cache via post-setup ordering; external-test-pkg nuance)
  documented (§2.2b); fallback log distinguishes non-diff vs diff-mode scope-loss
  (§2.2a); `approveRate` gets a code comment (§1.4).
