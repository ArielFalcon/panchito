# QA Engine — Plan 4: Wrap + Supporting Contexts

> **Sub-skill:** `superpowers:writing-plans` → executed via `superpowers:executing-plans`.
> Each task is TDD: write a failing test → run it (see it fail) → minimal impl → run it (see it pass) → commit.
> Conventional commits, **NO `Co-Authored-By`**. One logical change per commit.

## Goal

Build five bounded contexts in `qa-engine/src/contexts/` by **wrapping** the already-correct
`src/` runtime (strangler pattern), not rewriting it. Plan 2 shipped every port *interface*;
Plan 4 ships the *infrastructure* (adapters) and the *domain* (aggregates / pure services) that
implement them, plus the small set of pure decision cores lifted by copy+parity:

1. **test-execution** — `E2eExecutionStrategy` + `CodeExecutionStrategy` adapters wrapping
   `src/qa/execute.ts` + `src/qa/code-runner.ts`; the static-gate adapters; pure decision cores
   (`AdjudicateService`, `ProgressGateService`, `SelectorCheckService`, `NavGateService`) and the
   `AppDefect` VO that collapses the three names for "app is broken".
2. **objective-signal** (THE KEYSTONE) — `decideCoverage`/`blocksPublish` carried **VERBATIM**
   into a pure `DecideCoverageService`; a real `CoverageCollectorPort` (the missing DI seam) with
   `C8`/`JaCoCo`/`Lcov`/`V8Browser` adapters; `ValueOraclePort` with `StrykerMutationOracleAdapter`
   + `FaultInjectionOracleAdapter`.
3. **workspace-and-publication** — `WriteConfinementService` (ports `parseStatusOutput`/`isE2eStray`/
   `isCodeDenied`/`isDangerousPath`); `PublishService` (decide PR vs Issue vs shadow vs quarantine
   vs no-op); the `VcsWritePort` adapter; `GitHubPrAdapter`/`GitHubIssueAdapter`; `ShadowLogAdapter`;
   `MirrorGcAdapter`. **This is the ONLY context that holds `VcsWritePort`** (the Plan-2 arch-lint
   enforces it).
4. **app-catalog** — the `App` aggregate (config invariants as domain rules), `RepoResolutionService`
   (SHA → App + RepoRole), `YamlAppConfigAdapter` wrapping `config-loader.ts`. App-specificity lives
   ONLY here.
5. **cross-run-learning** (STUBBED in v1, off-path) — `SqliteLearningRepository` inverting the
   `history.ts` two-way coupling (ranking truth moves to a pure `RuleGovernanceService`; the SQL
   `ORDER BY` is dropped); the `'pending'→'candidate'` back-compat map on the read path; and a
   no-op `StubLearningRepository` the v1 composition wires (it never gates publish).

**Non-negotiable invariants this plan preserves:**
- The LLM agent stays read-only on watched repos — `VcsWritePort` is structurally confined to
  workspace-and-publication.
- `unknown` coverage NEVER blocks; `signal` mode never blocks; learning is off-path and never gates
  publish (fail-open by contract).
- Wrap-then-replace: adapters **delegate** to the verified `src/` functions. We do NOT rewrite
  Playwright/runner/Stryker logic. The `src/` runtime is touched in **zero** files.

## Architecture

```
qa-engine/src/contexts/
  test-execution/
    domain/            ← pure decision cores + AppDefect (copy+parity from src/)
    infrastructure/    ← strategy + static-gate adapters (WRAP src/qa/execute, code-runner, validate)
  objective-signal/
    domain/            ← DecideCoverageService (decideCoverage/blocksPublish VERBATIM)
    infrastructure/    ← CoverageCollector adapters + ValueOracle adapters (WRAP src/qa/*)
  workspace-and-publication/   ← THE ONLY context with VcsWritePort
    domain/            ← WriteConfinementService, PublishDecisionService
    infrastructure/    ← VcsWriteAdapter, GitHubPr/Issue, ShadowLog, MirrorGc (WRAP src/integrations/*)
  app-catalog/
    domain/            ← App aggregate, RepoResolutionService
    infrastructure/    ← YamlAppConfigAdapter (WRAP src/orchestrator/config-loader)
  cross-run-learning/  ← STUBBED off-path
    domain/            ← RuleGovernanceService (ranking truth)
    infrastructure/    ← SqliteLearningRepository, StubLearningRepository
```

**Dependency rule.** Adapters depend inward on the ports (Plan 2) and on the kernel (`@kernel/*`).
Parity tests import the legacy `src/` original as the oracle and are excluded from qa-engine
typecheck (the established pattern — they run via `tsx` at runtime). The legacy originals are
deleted at Plan 7 cutover, not here.

## Tech Stack

- TypeScript, `tsx` runtime (no build step), `node:test` + `node:assert/strict`, colocated under
  `qa-engine/test/` mirroring `qa-engine/src/`.
- `@kernel/*` → `qa-engine/src/shared-kernel/*`, `@contexts/*` → `qa-engine/src/contexts/*`
  (root `tsconfig.json` + `qa-engine/tsconfig.json` paths). Import the kernel/ports with explicit
  `.ts` extensions (`allowImportingTsExtensions`); import sibling context files by relative path
  with `.ts` (matches `git-mirror-read.adapter.ts`).
- Tests run via the root script: `node --import ./test-setup.mjs --import tsx --test "qa-engine/test/**/*.test.ts"`.
- Adapters inject their wrapped fn (constructor seam) so adapter tests run **without** Playwright /
  git / Stryker / SQLite binaries. Parity tests run the real `src/` pure functions (no binaries).

## File Structure

New files (all under `qa-engine/`):

```
src/contexts/test-execution/
  domain/app-defect.ts
  domain/adjudicate.service.ts
  domain/progress-gate.service.ts
  domain/selector-check.service.ts
  domain/nav-gate.service.ts
  infrastructure/e2e-execution.strategy.ts
  infrastructure/code-execution.strategy.ts
  infrastructure/static-gate.adapter.ts
src/contexts/objective-signal/
  domain/decide-coverage.service.ts
  infrastructure/c8-coverage.adapter.ts
  infrastructure/jacoco-coverage.adapter.ts
  infrastructure/lcov-coverage.adapter.ts
  infrastructure/v8-browser-coverage.adapter.ts
  infrastructure/coverage-collector.adapter.ts        (composite: dispatches per-ecosystem)
  infrastructure/stryker-mutation-oracle.adapter.ts
  infrastructure/fault-injection-oracle.adapter.ts
src/contexts/workspace-and-publication/
  domain/write-confinement.service.ts
  domain/publish-decision.service.ts
  infrastructure/vcs-write.adapter.ts
  infrastructure/github-pr.adapter.ts
  infrastructure/github-issue.adapter.ts
  infrastructure/shadow-log.adapter.ts
  infrastructure/mirror-gc.adapter.ts
src/contexts/app-catalog/
  domain/app.aggregate.ts
  domain/repo-resolution.service.ts
  infrastructure/yaml-app-config.adapter.ts
src/contexts/cross-run-learning/
  domain/rule-governance.service.ts
  infrastructure/sqlite-learning-repository.adapter.ts
  infrastructure/stub-learning-repository.adapter.ts
```

Each `src/...` file has a `test/...` mirror. Parity tests live next to the unit test and import the
legacy `src/` original; they are added to `qa-engine/tsconfig.json`'s `exclude` list.

---

## Task 0 — Re-verify against HEAD (the user edits `src/` in parallel)

> Run BEFORE writing any code. The user has WIP in `src/integrations/opencode-client.ts`,
> `src/integrations/prompts.ts`, and several `src/qa/*` files (selector-check, dom-snapshot,
> context-pack, changed-elements). **None of those are in Plan 4's wrap set except
> `selector-check.ts`** (we lift the pure core by copy+parity — re-verify its current shape).
> `opencode-client`/`prompts` are OUT (Plan 5).

- [ ] Confirm the wrapped exports still match (grep, not line numbers):
  ```bash
  cd /Users/arielyumn/Desktop/TRABAJO/ai-pipeline
  rg -n "export function (runE2E|runCodeTests|detectCodeProject|coverageCommand|parsePorcelain)" src/qa/execute.ts src/qa/code-runner.ts
  rg -n "export (interface|function) (ExecuteDeps|CodeExecuteDeps|RunOutput|CodeRunOutput)" src/qa/execute.ts src/qa/code-runner.ts
  rg -n "export function (decideCoverage|blocksPublish|defaultCollectCoverage|parseLcov|parseIstanbulJson|parseJacocoXml|parseV8Coverage|collectNativeBranchCoverage)" src/qa/change-coverage.ts
  rg -n "export (function|const) (runMutationOracle|realMutationDeps|runFaultInjectionOracle|defaultFaultInjectionDeps)" src/qa/learning/mutation-code.ts src/qa/learning/fault-injection-e2e.ts
  rg -n "export (function|interface) (publishE2e|publishCode|publishContext|PublishDeps|defaultPublishDeps|PublishResult)" src/integrations/publish.ts
  rg -n "export const github|openIssue|createPullRequest|enableAutoMerge|mergePullRequest" src/integrations/github.ts
  rg -n "export (function|interface) (runConfinement|parseStatusOutput|isE2eStray|isCodeDenied|isDangerousPath|ConfinementResult|ConfineDeps)" src/qa/confinement.ts
  rg -n "export (function|interface|type) (loadAppConfig|loadAppConfigsByRepo|listAppConfigs|RepoMatch|RepoRole|AppConfig)" src/orchestrator/config-loader.ts
  rg -n "export type RuleStatus|applyOutcome|export function (rowToRule|listLearningRules)" src/qa/learning/learning-rule.ts src/server/history.ts
  rg -n "listRulesStmt|ORDER BY" src/server/history.ts | rg "success_rate"
  ```
- [ ] Confirm the legacy `selector-check.ts` pure core (the user is editing it):
  ```bash
  rg -n "export (function|interface|type)" src/qa/selector-check.ts | head -20
  ```
  Note its **current** signatures — the lifted copy + parity test in Task 1.3 must match HEAD,
  not the snapshot.
- [ ] Confirm `git status --short` shows none of Plan 4's *new* `qa-engine/` files modified by the
  user and that `opencode-client`/`prompts` are the only WIP that overlaps later plans:
  ```bash
  git status --short | rg "qa-engine/"
  ```
  Expected: no output (the user's WIP is in `src/` and `agent*/`, not in qa-engine).
- [ ] Confirm the kernel does **NOT** already carry `decideCoverage`/`blocksPublish`
  (the task said "verify" — they are in `src/qa/change-coverage.ts`, NOT the kernel):
  ```bash
  rg -rn "decideCoverage|blocksPublish" qa-engine/src/shared-kernel
  ```
  Expected: no output → objective-signal must carry them (Task 2.1).
- [ ] Baseline green before any change:
  ```bash
  npm run typecheck && npm test 2>&1 | tail -5
  ```
  Expected: typecheck passes; test summary shows `0` failures.

---

## Group A — test-execution

### Task A.1 — `AppDefect` VO (collapse the three names for "app is broken")

The legacy code expresses "app is broken" three ways: `infra-error` verdict, a 5xx health probe,
and the `allFailuresAreRunnerInfra` reclassification. The VO unifies the *evidence* so the
adjudicator and the deploy gate speak one language. Pure, no src/ wrap.

**Files:** `src/contexts/test-execution/domain/app-defect.ts`,
`test/contexts/test-execution/domain/app-defect.test.ts`

- [ ] Write the failing test:
  ```ts
  // test/contexts/test-execution/domain/app-defect.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { AppDefect } from "@contexts/test-execution/domain/app-defect.ts";

  test("fromHttpStatus marks a 5xx as a defect with the status as evidence", () => {
    const d = AppDefect.fromHttpStatus(503);
    assert.equal(d.isDefect, true);
    assert.equal(d.httpStatus, 503);
    assert.match(d.evidence, /503/);
  });

  test("fromHttpStatus treats a 2xx as no defect", () => {
    const d = AppDefect.fromHttpStatus(200);
    assert.equal(d.isDefect, false);
    assert.equal(d.httpStatus, 200);
  });

  test("fromRunnerInfra marks a runner-infrastructure fault as a defect (no httpStatus)", () => {
    const d = AppDefect.fromRunnerInfra("browserType.launch failed");
    assert.equal(d.isDefect, true);
    assert.equal(d.httpStatus, null);
    assert.match(d.evidence, /browserType\.launch/);
  });

  test("none() is the no-defect singleton", () => {
    assert.equal(AppDefect.none().isDefect, false);
    assert.equal(AppDefect.none().httpStatus, null);
  });
  ```
- [ ] Run it, see it fail (module not found):
  ```bash
  node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/test-execution/domain/app-defect.test.ts"
  ```
  Expected: `Error: Cannot find module .../app-defect.ts`.
- [ ] Minimal impl:
  ```ts
  // src/contexts/test-execution/domain/app-defect.ts
  // "App is broken" as ONE value object. Collapses the three legacy expressions: the infra-error
  // verdict, the 5xx health probe, and allFailuresAreRunnerInfra reclassification (execute.ts).
  // Carries the 5xx httpStatus as evidence so the deploy gate and the adjudicator agree on one shape.
  export class AppDefect {
    private constructor(
      readonly isDefect: boolean,
      readonly httpStatus: number | null,
      readonly evidence: string,
    ) {}

    static none(): AppDefect {
      return new AppDefect(false, null, "");
    }

    // A 5xx from the DEV health probe (/version) is an app-side defect — never a test failure.
    static fromHttpStatus(status: number): AppDefect {
      const defect = status >= 500 && status <= 599;
      return new AppDefect(defect, status, defect ? `DEV returned HTTP ${status}` : "");
    }

    // A Playwright runner-infrastructure fault (browser could not launch): the run never
    // exercised the app, so it is infra, never `fail`. Mirrors PLAYWRIGHT_INFRA_RE intent.
    static fromRunnerInfra(detail: string): AppDefect {
      return new AppDefect(true, null, `runner-infra: ${detail}`);
    }
  }
  ```
- [ ] Run it, see it pass.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/test-execution/domain/app-defect.ts \
          qa-engine/test/contexts/test-execution/domain/app-defect.test.ts
  git commit -m "feat(test-execution): AppDefect VO collapsing the 3 app-broken names"
  ```

### Task A.2 — `AdjudicateService` (pure failure classification, copy+parity)

Lift the precedence-ordered runner-infra reclassification from `execute.ts`
(`allFailuresAreRunnerInfra` + `PLAYWRIGHT_INFRA_RE`) into a pure service. Parity-pinned against
the legacy predicate.

**Files:** `src/contexts/test-execution/domain/adjudicate.service.ts`,
`test/contexts/test-execution/domain/adjudicate.service.test.ts`,
`test/contexts/test-execution/domain/adjudicate-parity.test.ts`

- [ ] Write the failing unit test:
  ```ts
  // test/contexts/test-execution/domain/adjudicate.service.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { AdjudicateService } from "@contexts/test-execution/domain/adjudicate.service.ts";
  import type { QaCase } from "@kernel/qa-case.ts";

  const svc = new AdjudicateService();
  const c = (status: QaCase["status"], detail?: string): QaCase =>
    ({ name: "t", status, ...(detail ? { detail } : {}) }) as QaCase;

  test("a fail where EVERY failure is runner-infra adjudicates to infra-error", () => {
    const r = svc.adjudicate("fail", [c("fail", "browserType.launch: Executable doesn't exist")]);
    assert.equal(r.verdict, "infra-error");
    assert.equal(r.appDefect.isDefect, true);
  });

  test("a fail with a genuine assertion failure stays fail (one real failure poisons the infra reclassification)", () => {
    const r = svc.adjudicate("fail", [
      c("fail", "browserType.launch failed"),
      c("fail", "expect(locator).toBeVisible timed out"),
    ]);
    assert.equal(r.verdict, "fail");
    assert.equal(r.appDefect.isDefect, false);
  });

  test("a pass is passed through unchanged", () => {
    const r = svc.adjudicate("pass", [c("pass")]);
    assert.equal(r.verdict, "pass");
    assert.equal(r.appDefect.isDefect, false);
  });
  ```
- [ ] Run it, see it fail (module not found).
- [ ] Minimal impl:
  ```ts
  // src/contexts/test-execution/domain/adjudicate.service.ts
  // Pure, precedence-ordered failure classification — lifted from execute.ts
  // (allFailuresAreRunnerInfra + PLAYWRIGHT_INFRA_RE). Stateless computation over evidence:
  // a `fail` where EVERY failed case is a runner-infrastructure fault is reclassified to
  // infra-error (the run never exercised the app); a single genuine failure keeps it `fail`.
  import type { RunVerdict } from "@kernel/run-verdict.ts";
  import type { QaCase } from "@kernel/qa-case.ts";
  import { AppDefect } from "./app-defect.ts";

  // Carried VERBATIM from execute.ts PLAYWRIGHT_INFRA_RE (narrow launch/host signatures only;
  // "Target ... closed" is deliberately excluded — that is a real app crash the test must surface).
  export const PLAYWRIGHT_INFRA_RE =
    /browserType\.(?:launch|connect)|Executable doesn't exist|Failed to launch|missing dependencies to run browsers|Host system is missing dependencies/i;

  export interface AdjudicationResult {
    readonly verdict: RunVerdict;
    readonly appDefect: AppDefect;
  }

  export class AdjudicateService {
    // True when the run failed but EVERY failed case is a runner-infra fault. Carried from
    // execute.ts allFailuresAreRunnerInfra — conservative: a single genuine failure keeps `fail`.
    private allFailuresAreRunnerInfra(cases: readonly QaCase[]): boolean {
      const failed = cases.filter((c) => c.status === "fail");
      return failed.length > 0 && failed.every((c) => PLAYWRIGHT_INFRA_RE.test(c.detail ?? ""));
    }

    adjudicate(verdict: RunVerdict, cases: readonly QaCase[]): AdjudicationResult {
      if (verdict === "fail" && this.allFailuresAreRunnerInfra(cases)) {
        const first = cases.find((c) => c.status === "fail");
        return { verdict: "infra-error", appDefect: AppDefect.fromRunnerInfra(first?.detail ?? "") };
      }
      return { verdict, appDefect: AppDefect.none() };
    }
  }
  ```
- [ ] Run it, see it pass.
- [ ] Write the parity test (the strangler oracle — pins the lifted predicate to legacy):
  ```ts
  // test/contexts/test-execution/domain/adjudicate-parity.test.ts
  // PARITY: the lifted runner-infra classifier must match execute.ts byte-for-byte until Plan 7
  // deletes the legacy original. Imports from src/ (outside qa-engine rootDir) — excluded from
  // qa-engine typecheck (see qa-engine/tsconfig.json), runs via tsx at runtime.
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { AdjudicateService, PLAYWRIGHT_INFRA_RE } from "@contexts/test-execution/domain/adjudicate.service.ts";
  import {
    allFailuresAreRunnerInfra as legacyAllInfra,
    PLAYWRIGHT_INFRA_RE as LEGACY_RE,
  } from "../../../../../src/qa/execute.ts";
  import type { QaCase } from "../../../../../src/types.ts";

  test("PARITY: the regex source matches legacy execute.ts", () => {
    assert.equal(PLAYWRIGHT_INFRA_RE.source, LEGACY_RE.source);
    assert.equal(PLAYWRIGHT_INFRA_RE.flags, LEGACY_RE.flags);
  });

  test("PARITY: runner-infra classification matches legacy across a sample table", () => {
    const svc = new AdjudicateService();
    const samples: QaCase[][] = [
      [{ name: "a", status: "fail", detail: "browserType.launch: Executable doesn't exist" }],
      [{ name: "a", status: "fail", detail: "expect timed out" }],
      [
        { name: "a", status: "fail", detail: "Failed to launch" },
        { name: "b", status: "fail", detail: "assertion mismatch" },
      ],
      [{ name: "a", status: "pass" }],
    ];
    for (const cases of samples) {
      const legacy = legacyAllInfra(cases);
      const adjudged = svc.adjudicate("fail", cases as QaCase[]).verdict === "infra-error";
      // Direct comparison: the `&& cases.some(…)` conjunction masked divergences because it turned a
      // false legacyAllInfra result into false regardless of adjudged (the compound is always false when
      // legacy is false, hiding cases where adjudged and legacy actually disagree).
      assert.equal(adjudged, legacy, JSON.stringify(cases));
    }
  });
  ```
- [ ] Add the parity file to the typecheck exclude list:
  ```jsonc
  // qa-engine/tsconfig.json — append to "exclude"
  "test/contexts/test-execution/domain/adjudicate-parity.test.ts"
  ```
- [ ] Run both tests, see them pass:
  ```bash
  node --import ./test-setup.mjs --import tsx --test \
    "qa-engine/test/contexts/test-execution/domain/adjudicate.service.test.ts" \
    "qa-engine/test/contexts/test-execution/domain/adjudicate-parity.test.ts"
  ```
  Expected: all tests pass.
- [ ] Run typecheck (proves the parity exclude works):
  ```bash
  npm run typecheck
  ```
  Expected: passes.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/test-execution/domain/adjudicate.service.ts \
          qa-engine/test/contexts/test-execution/domain/adjudicate.service.test.ts \
          qa-engine/test/contexts/test-execution/domain/adjudicate-parity.test.ts \
          qa-engine/tsconfig.json
  git commit -m "feat(test-execution): AdjudicateService lifted from execute.ts with parity oracle"
  ```

### Task A.3 — `SelectorCheckService`, `ProgressGateService`, `NavGateService` (pure cores, copy+parity)

Lift the three remaining pure decision cores. `SelectorCheckService` wraps the user's
**currently-edited** `src/qa/selector-check.ts` — re-read its HEAD shape (Task 0) before copying.
`ProgressGateService` and `NavGateService` are small pure gates referenced by the fix-loop.

> RE-VERIFIED vs HEAD (2026-06-26): the user's "selector-fragility hardening" audit added a SECOND
> public export, `unscopedMultipleContradictions(specSources, trees, treeLabel?) → string[]` — the
> per-selector page-rooted MULTIPLE filter that `pipeline.ts:1821` calls via `ambiguousSelectorsNow`
> — plus the helpers `PAGE_ROOT_BEFORE_RE`, `isPageRootedAt`, `extractProposedSelectorsWithIndex`, and
> an `ARIA_STATE_STRIP_RE` allowlist now applied inside `parseLine`. A copy of only `checkSpecSelectors`
> would DROP these and REGRESS the hardening. The service MUST expose BOTH public functions, the copy
> MUST be of the CURRENT HEAD body, and the parity test (binding to both exports) is the guard.

**Files:** `src/contexts/test-execution/domain/selector-check.service.ts`,
`src/contexts/test-execution/domain/progress-gate.service.ts`,
`src/contexts/test-execution/domain/nav-gate.service.ts` (+ mirrored unit tests + a
`selector-check-parity.test.ts`).

- [ ] Re-read the legacy exports (must reflect HEAD, the user edits this file):
  ```bash
  rg -n "export (function|interface|type|const)" src/qa/selector-check.ts
  ```
- [ ] Write the failing unit test for `SelectorCheckService`. The real export is
  `checkSpecSelectors(specSources: string[], trees: string[][], treeLabel?: string): SpecSelectorFindings`
  with fields `contradictions`, `absentKeys`, `anyVerifiedPresent`, `anyNonExtractable`, `anyUnverifiable`.
  The service is a thin class delegate over that exact signature:
  ```ts
  // test/contexts/test-execution/domain/selector-check.service.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { SelectorCheckService } from "@contexts/test-execution/domain/selector-check.service.ts";

  const DOM_TREE = ["button: Submit"];

  test("flags a getByRole selector absent from the captured DOM (verifiable-absent contradiction)", () => {
    const svc = new SelectorCheckService();
    const findings = svc.check(
      [`await page.getByRole("button", { name: "Buy now" }).click();`],
      [DOM_TREE],
    );
    assert.ok(findings.contradictions.some((c) => /Buy now/.test(c)));
    assert.ok(findings.absentKeys.size > 0);
    assert.equal(findings.anyVerifiedPresent, false);
  });

  test("passes when every selector resolves against the DOM (no contradictions)", () => {
    const svc = new SelectorCheckService();
    const findings = svc.check(
      [`await page.getByRole("button", { name: "Submit" }).click();`],
      [DOM_TREE],
    );
    assert.deepEqual(findings.contradictions, []);
    assert.equal(findings.anyVerifiedPresent, true);
    assert.equal(findings.absentKeys.size, 0);
  });

  test("non-extractable locator sets anyNonExtractable (getByTestId)", () => {
    const svc = new SelectorCheckService();
    const findings = svc.check(
      [`await page.getByTestId("submit-btn").click();`],
      [DOM_TREE],
    );
    assert.equal(findings.anyNonExtractable, true);
  });
  ```
- [ ] Run it, see it fail.
- [ ] Minimal impl — class delegating to the copied pure body of `checkSpecSelectors`. The service
  re-exports the `SpecSelectorFindings` type so callers import from one seam:
  ```ts
  // src/contexts/test-execution/domain/selector-check.service.ts
  // Pure selector-vs-DOM gate, lifted from src/qa/selector-check.ts. The service is a thin class
  // delegate over checkSpecSelectors(specSources, trees, treeLabel?) → SpecSelectorFindings. The
  // algorithm is copied verbatim (parity-pinned); NO behavioral change.
  // SpecSelectorFindings fields: contradictions, absentKeys, anyVerifiedPresent,
  // anyNonExtractable, anyUnverifiable.
  export type { SpecSelectorFindings } from "./selector-check-types.ts";
  // <copy extractProposedSelectors, hasNonExtractableLocator, selectorPresent, selectorUnique,
  //  selectorKey, checkSpecSelectors verbatim from src/qa/selector-check.ts>

  export class SelectorCheckService {
    // Delegates to the verbatim-copied checkSpecSelectors.
    // specSources: spec file text strings; trees: per-snapshot "role: name" line arrays.
    check(
      specSources: string[],
      trees: string[][],
      treeLabel = "failure-point",
    ): SpecSelectorFindings {
      return checkSpecSelectors(specSources, trees, treeLabel);
    }

    // Pre-execution MULTIPLE-ambiguity filter, page-rooted selectors only (the per-selector scope
    // suppression the user's audit added). pipeline.ts (ambiguousSelectorsNow) calls this with the
    // "pre-write" tree label; Plan 6 wiring needs the same seam, so the service exposes it too.
    unscopedMultiple(
      specSources: string[],
      trees: string[][],
      treeLabel = "pre-write",
    ): string[] {
      return unscopedMultipleContradictions(specSources, trees, treeLabel);
    }
  }
  ```
  > Both public functions (`checkSpecSelectors` AND `unscopedMultipleContradictions`) are copied
  > verbatim from the CURRENT HEAD, including every helper: `parseLine` (with its `ARIA_STATE_STRIP_RE`
  > strip), `roleMatches`, `nameMatches`, `extractProposedSelectors`, `extractProposedSelectorsWithIndex`,
  > `hasNonExtractableLocator`, `selectorPresent`, `selectorUnique`, `selectorKey`, `extractNameOpts`,
  > `isPageRootedAt`, and the constants `STRUCTURAL_PRESENT_MARKER`, `ARIA_STATE_STRIP_RE`,
  > `TEXT_KIND_ROLES`, `LABEL_KIND_ROLES`, `NON_EXTRACTABLE_LOCATOR_RE`, `PAGE_ROOT_BEFORE_RE`,
  > `stripCommentsAndJoin`, `normalizeName`. The parity test (both exports) pins the copy to HEAD.
- [ ] Run it, see it pass.
- [ ] Write the parity test — call BOTH the service and the legacy `checkSpecSelectors` on a shared
  fixture table and `deepEqual` the results:
  ```ts
  // test/contexts/test-execution/domain/selector-check-parity.test.ts
  // PARITY vs src/qa/selector-check.ts (HEAD). Excluded from qa-engine typecheck; runs via tsx.
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { SelectorCheckService } from "@contexts/test-execution/domain/selector-check.service.ts";
  import { checkSpecSelectors, unscopedMultipleContradictions } from "../../../../../src/qa/selector-check.ts";

  const svc = new SelectorCheckService();
  const DOM_TREE = ["button: Submit", "button: Buy now", "textbox: Email"];
  const fixtures: Array<{ srcs: string[]; trees: string[][] }> = [
    { srcs: [`page.getByRole("button", { name: "Submit" }).click()`], trees: [DOM_TREE] },
    { srcs: [`page.getByRole("button", { name: "Missing" }).click()`], trees: [DOM_TREE] },
    { srcs: [`page.getByTestId("id")`], trees: [DOM_TREE] },
    { srcs: [], trees: [DOM_TREE] },
    { srcs: [`page.getByRole("button").click()`], trees: [["button: A", "button: B"]] },
    // ARIA-state-suffix: parseLine must strip the [disabled] token so role/name still match — pins the
    // user's ARIA_STATE_STRIP_RE behavior (a stale copy would treat the suffix as part of the name).
    { srcs: [`page.getByRole("button", { name: "Submit" }).click()`], trees: [["button: Submit [disabled]"]] },
    // page-rooted MULTIPLE next to a non-extractable locator: exercises unscopedMultipleContradictions'
    // suppression path (anyNonExtractable=true ⇒ only the page-rooted MULTIPLE survives).
    { srcs: [`page.getByRole("button").click(); page.getByTestId("x").click()`], trees: [["button: A", "button: B"]] },
  ];

  test("PARITY: SelectorCheckService.check matches checkSpecSelectors across the fixture table", () => {
    for (const { srcs, trees } of fixtures) {
      const legacy = checkSpecSelectors(srcs, trees);
      const svcResult = svc.check(srcs, trees);
      // deepEqual compares contradictions[], absentKeys (Set→Array), booleans
      assert.deepEqual(
        { ...svcResult, absentKeys: [...svcResult.absentKeys].sort() },
        { ...legacy, absentKeys: [...legacy.absentKeys].sort() },
        JSON.stringify({ srcs, treeLen: trees[0]?.length }),
      );
    }
  });

  test("PARITY: SelectorCheckService.unscopedMultiple matches unscopedMultipleContradictions", () => {
    for (const { srcs, trees } of fixtures) {
      assert.deepEqual(
        svc.unscopedMultiple(srcs, trees, "pre-write"),
        unscopedMultipleContradictions(srcs, trees, "pre-write"),
        JSON.stringify({ srcs, treeLen: trees[0]?.length }),
      );
    }
  });
  ```
  > Bind to `checkSpecSelectors` — the EXACT export name confirmed in Task 0.
- [ ] Add `selector-check-parity.test.ts` to the typecheck exclude list.
- [ ] Write `ProgressGateService` + `NavGateService` the same way (small pure gates). Each:
  failing test → impl → pass. If a legacy original exists, add a parity test; if the gate is new
  glue with no legacy original, a unit test alone suffices (note that in the commit body).
- [ ] Run the whole test-execution domain test set + typecheck:
  ```bash
  node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/test-execution/domain/**/*.test.ts"
  npm run typecheck
  ```
  Expected: all pass.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/test-execution/domain/{selector-check,progress-gate,nav-gate}.service.ts \
          qa-engine/test/contexts/test-execution/domain/ qa-engine/tsconfig.json
  git commit -m "feat(test-execution): SelectorCheck/ProgressGate/NavGate domain services with parity"
  ```

### Task A.4 — `E2eExecutionStrategy` adapter (WRAP `src/qa/execute.ts`)

Implements `ExecutionStrategyPort` by **delegating** to the verified `runE2E`. Injects a `runE2E`
fn (constructor seam) so the adapter test needs no Playwright. Maps `ExecutionRequest` → legacy
`runE2E(specDir, opts, deps)` and `QaRunResult` → `ExecutionResult`, then runs the result through
`AdjudicateService`.

**Files:** `src/contexts/test-execution/infrastructure/e2e-execution.strategy.ts`,
`test/contexts/test-execution/infrastructure/e2e-execution.strategy.test.ts`

- [ ] **First: extend the `ExecutionRequest` port to include the 5 fields the adapters read.**
  The Plan-2 stub omits `project`, `onCase`, `onRunning`, `onDiscovered` (used by the e2e strategy)
  and `changedFiles` (used by the code strategy). Without them the adapters will not typecheck.
  Edit the port barrel:
  ```ts
  // qa-engine/src/contexts/test-execution/application/ports/index.ts
  // Add the missing capability fields to ExecutionRequest. The e2e fields thread the full
  // ExecuteOptions set so no capability is silently dropped at the port boundary. changedFiles
  // is the CodeExecuteOptions.changedFiles diff-driven module scoping field.
  export interface ExecutionRequest {
    specDir: string;
    baseUrl?: string;        // absent for code target
    namespace: string;
    faultInject?: boolean;
    specFiles?: string[];
    signal?: AbortSignal;
    timeoutMs?: number;
    // e2e live-progress callbacks (ExecuteOptions capability set — no regression vs legacy):
    project?: string;                                          // Playwright --project filter
    onCase?: (c: { name: string; status: string; detail?: string }) => void;
    onRunning?: (title: string) => void;
    onDiscovered?: (title: string, file?: string) => void;
    // code target: diff-driven module scoping (CodeExecuteOptions.changedFiles):
    changedFiles?: string[];
  }
  ```
- [ ] Run `npx tsc --noEmit -p qa-engine/tsconfig.json` immediately after the port edit to confirm
  the change compiles cleanly before writing any adapter code:
  ```bash
  npx tsc --noEmit -p qa-engine/tsconfig.json
  ```
  Expected: exits 0. Fix any errors in the port barrel before continuing.
- [ ] Write the failing test (inject a fake `runE2E`):
  ```ts
  // test/contexts/test-execution/infrastructure/e2e-execution.strategy.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { E2eExecutionStrategy } from "@contexts/test-execution/infrastructure/e2e-execution.strategy.ts";
  import type { ExecutionRequest } from "@contexts/test-execution/application/ports/index.ts";

  // ExecutionRequest carries the full set of ExecuteOptions / CodeExecuteOptions fields so no
  // capability is silently dropped at the port boundary:
  //   e2e: project? (PW --project), onCase?, onRunning?, onDiscovered? (live progress callbacks)
  //   code: changedFiles? (diff-driven module scoping)
  const req: ExecutionRequest = { specDir: "/m/e2e", baseUrl: "https://dev", namespace: "qa-abc" };

  test("delegates to runE2E with the mapped opts and returns the verdict/cases/logs", async () => {
    let seen: { dir: string; baseUrl: string; namespace: string } | null = null;
    const strategy = new E2eExecutionStrategy(async (dir, opts) => {
      seen = { dir, baseUrl: opts.baseUrl, namespace: opts.namespace };
      return { sha: "abc", verdict: "pass", passed: true, cases: [{ name: "t", status: "pass" }], logs: "ok" };
    });
    const out = await strategy.run(req);
    assert.deepEqual(seen, { dir: "/m/e2e", baseUrl: "https://dev", namespace: "qa-abc" });
    assert.equal(out.verdict, "pass");
    assert.equal(out.cases.length, 1);
    assert.equal(out.logs, "ok");
  });

  test("runs the result through AdjudicateService — all-runner-infra fail becomes infra-error", async () => {
    const strategy = new E2eExecutionStrategy(async () => ({
      sha: "abc", verdict: "fail", passed: false,
      cases: [{ name: "t", status: "fail", detail: "browserType.launch: Executable doesn't exist" }],
      logs: "boom",
    }));
    const out = await strategy.run(req);
    assert.equal(out.verdict, "infra-error");
  });

  test("throws when baseUrl is absent (e2e requires a live DEV URL)", async () => {
    const strategy = new E2eExecutionStrategy(async () => ({ sha: "abc", verdict: "pass", passed: true, cases: [], logs: "" }));
    await assert.rejects(() => strategy.run({ specDir: "/m/e2e", namespace: "qa-abc" }), /baseUrl/);
  });
  ```
- [ ] Run it, see it fail.
- [ ] Minimal impl (delegate; do NOT reimplement Playwright):
  ```ts
  // src/contexts/test-execution/infrastructure/e2e-execution.strategy.ts
  // WRAP of src/qa/execute.ts runE2E (strangler: delegate, do not rewrite the runner). Maps the
  // typed ExecutionRequest onto the legacy opts and the legacy QaRunResult onto ExecutionResult,
  // then runs it through AdjudicateService so the runner-infra reclassification is centralized.
  // The runE2E fn is injected so this adapter is testable without Playwright.
  import type {
    ExecutionStrategyPort,
    ExecutionRequest,
    ExecutionResult,
  } from "../application/ports/index.ts";
  import { AdjudicateService } from "../domain/adjudicate.service.ts";

  // Structural shape of the legacy runE2E return (src/types.ts QaRunResult) — declared locally so
  // this file does not import from src/ (only the parity test may). Widened: optional fields ignored.
  interface LegacyRunResult { verdict: string; cases: { name: string; status: string; detail?: string }[]; logs: string; }
  type QaCase = { name: string; status: string; detail?: string };
  type RunE2eFn = (
    specDir: string,
    opts: {
      baseUrl: string;
      namespace: string;
      faultInject?: boolean;
      specFiles?: string[];
      signal?: AbortSignal;
      timeoutMs?: number;
      // Carries the full ExecuteOptions capability set — no regression vs the legacy seam:
      project?: string;                          // Playwright --project (PW_PROJECT_RE validated by runE2E)
      onCase?: (c: QaCase) => void;              // per-test completion (live bar / history)
      onRunning?: (title: string) => void;       // test started (focus card)
      onDiscovered?: (title: string, file?: string) => void; // full test list up-front
    },
  ) => Promise<LegacyRunResult>;

  export class E2eExecutionStrategy implements ExecutionStrategyPort {
    private readonly adjudicator = new AdjudicateService();
    constructor(private readonly runE2E: RunE2eFn) {}

    async run(req: ExecutionRequest): Promise<ExecutionResult> {
      if (!req.baseUrl) throw new Error("E2eExecutionStrategy requires a baseUrl (live DEV URL)");
      const result = await this.runE2E(req.specDir, {
        baseUrl: req.baseUrl,
        namespace: req.namespace,
        ...(req.faultInject !== undefined ? { faultInject: req.faultInject } : {}),
        ...(req.specFiles ? { specFiles: req.specFiles } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
        ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
        // Thread the full ExecuteOptions capability set — no capability regression vs legacy seam:
        ...(req.project !== undefined ? { project: req.project } : {}),
        ...(req.onCase ? { onCase: req.onCase } : {}),
        ...(req.onRunning ? { onRunning: req.onRunning } : {}),
        ...(req.onDiscovered ? { onDiscovered: req.onDiscovered } : {}),
      });
      const cases = result.cases.map((c) => ({ name: c.name, status: c.status as "pass" | "fail" | "flaky", ...(c.detail ? { detail: c.detail } : {}) }));
      const adjudged = this.adjudicator.adjudicate(result.verdict as ExecutionResult["verdict"], cases);
      return { verdict: adjudged.verdict, cases, logs: result.logs };
    }
  }
  ```
- [ ] Run it, see it pass.
- [ ] Add a tiny composition-wiring note in the file header comment: the real wiring (Plan 6)
  passes `(specDir, opts) => runE2E(specDir, opts, defaultExecuteDeps)`. No src/ import here.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.strategy.ts \
          qa-engine/test/contexts/test-execution/infrastructure/e2e-execution.strategy.test.ts
  git commit -m "feat(test-execution): E2eExecutionStrategy wrapping runE2E (injected, adjudicated)"
  ```

### Task A.5 — `CodeExecutionStrategy` adapter (WRAP `src/qa/code-runner.ts`)

Implements `ExecutionStrategyPort` for the code target by delegating to `runCodeTests` /
`detectCodeProject`. Exit-code classify, no browser, no flaky, no deploy gate. Inject the run fn.

**Files:** `src/contexts/test-execution/infrastructure/code-execution.strategy.ts`,
`test/contexts/test-execution/infrastructure/code-execution.strategy.test.ts`

- [ ] Write the failing test (inject a fake runner returning a `QaRunResult`-shaped value):
  ```ts
  // test/contexts/test-execution/infrastructure/code-execution.strategy.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { CodeExecutionStrategy } from "@contexts/test-execution/infrastructure/code-execution.strategy.ts";

  test("delegates to the injected code runner and passes through verdict/cases/logs", async () => {
    let seenDir = "";
    const strategy = new CodeExecutionStrategy(async (dir) => {
      seenDir = dir;
      return { verdict: "pass", cases: [{ name: "exit-0", status: "pass" }], logs: "ok" };
    });
    const out = await strategy.run({ specDir: "/m", namespace: "qa-abc" });
    assert.equal(seenDir, "/m");
    assert.equal(out.verdict, "pass");
    assert.equal(out.cases[0]?.status, "pass");
  });

  test("a non-zero exit is a fail (binary classify — no flaky)", async () => {
    const strategy = new CodeExecutionStrategy(async () => ({ verdict: "fail", cases: [{ name: "exit-1", status: "fail" }], logs: "exit 1" }));
    const out = await strategy.run({ specDir: "/m", namespace: "qa-abc" });
    assert.equal(out.verdict, "fail");
  });
  ```
- [ ] Run it, see it fail.
- [ ] Minimal impl (delegate to the runner; the runner already maps exit code → verdict):
  ```ts
  // src/contexts/test-execution/infrastructure/code-execution.strategy.ts
  // WRAP of the code target (src/qa/code-runner.ts runCodeTests + detectCodeProject): exit-code
  // classify, no browser, no flaky, no deploy gate. The run fn is injected so the adapter tests
  // run without installing the watched repo's deps. Delegates — does not reimplement detection.
  import type { ExecutionStrategyPort, ExecutionRequest, ExecutionResult } from "../application/ports/index.ts";

  interface LegacyCodeResult { verdict: string; cases: { name: string; status: string; detail?: string }[]; logs: string; }
  type RunCodeFn = (
    repoDir: string,
    opts: {
      namespace: string;
      signal?: AbortSignal;
      timeoutMs?: number;
      changedFiles?: string[]; // CodeExecuteOptions.changedFiles: diff-driven module scoping
    },
  ) => Promise<LegacyCodeResult>;

  export class CodeExecutionStrategy implements ExecutionStrategyPort {
    constructor(private readonly runCode: RunCodeFn) {}

    async run(req: ExecutionRequest): Promise<ExecutionResult> {
      const result = await this.runCode(req.specDir, {
        namespace: req.namespace,
        ...(req.signal ? { signal: req.signal } : {}),
        ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
        // Thread changedFiles for diff-driven module scoping (CodeExecuteOptions.changedFiles):
        ...(req.changedFiles ? { changedFiles: req.changedFiles } : {}),
      });
      const cases = result.cases.map((c) => ({ name: c.name, status: c.status as "pass" | "fail" | "flaky", ...(c.detail ? { detail: c.detail } : {}) }));
      return { verdict: result.verdict as ExecutionResult["verdict"], cases, logs: result.logs };
    }
  }
  ```
  > Plan-6 wiring adapts `runCodeTests`/`runCodeMode` to `RunCodeFn`; the exact legacy entrypoint
  > (and whether it returns a `QaRunResult` or a `CodeRunOutput` needing a small map) is resolved
  > there. The injected seam keeps this adapter binary-free.
  > `ExecutionRequest` (Plan-2 port) MUST include: `project?: string`, `onCase?`, `onRunning?`,
  > `onDiscovered?` (e2e live-progress callbacks) and `changedFiles?: string[]` (code module scoping)
  > so neither strategy silently drops a capability that the legacy `ExecuteOptions`/
  > `CodeExecuteOptions` exposed. Update the port barrel accordingly.
- [ ] Run it, see it pass.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/test-execution/infrastructure/code-execution.strategy.ts \
          qa-engine/test/contexts/test-execution/infrastructure/code-execution.strategy.test.ts
  git commit -m "feat(test-execution): CodeExecutionStrategy wrapping the exit-code code runner"
  ```

### Task A.6 — `StaticGateAdapter` (implements `StaticGatePort`, WRAP `src/qa/validate.ts`)

Implements the four-method static gate (typecheck/lint/listTests/checkManifest) by delegating to
the legacy validate functions. Inject each as a fn so no `tsc`/eslint/playwright spawn happens in
the test.

> RE-VERIFIED vs HEAD (2026-06-26): the user's audit added a FIFTH check inside `validateSpecs` —
> `checkZeroAssertionSpecs` (the zero-assertion gate scoped to `flows/`). It is NOT one of the four
> injected `ValidateDeps` methods; it is a hardcoded internal call. The WRAP inherits it for free
> (Plan-6 composition wires the real `defaultValidateDeps`/`validateSpecs`), so NO adapter code
> changes — but the gate is now five checks (four injected + one hardcoded), not four. The adapter
> test below stays as written: it exercises only the four delegating methods, which never touch the FS.

**Files:** `src/contexts/test-execution/infrastructure/static-gate.adapter.ts`,
`test/contexts/test-execution/infrastructure/static-gate.adapter.test.ts`

- [ ] Re-verify the legacy validate exports:
  ```bash
  rg -n "export (function|interface) " src/qa/validate.ts | head -20
  ```
- [ ] Write the failing test injecting four fake check fns returning `CheckResult`:
  ```ts
  // test/contexts/test-execution/infrastructure/static-gate.adapter.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { StaticGateAdapter } from "@contexts/test-execution/infrastructure/static-gate.adapter.ts";

  const ok = { ok: true, output: "" };
  test("each method delegates to its injected check and returns its CheckResult", async () => {
    const calls: string[] = [];
    const adapter = new StaticGateAdapter({
      typecheck: async (d) => { calls.push(`tc:${d}`); return ok; },
      lint: async (d) => { calls.push(`lint:${d}`); return ok; },
      listTests: async (d) => { calls.push(`list:${d}`); return ok; },
      checkManifest: async (d) => { calls.push(`mf:${d}`); return ok; },
    });
    await adapter.typecheck("/m");
    await adapter.lint("/m");
    await adapter.listTests("/m");
    await adapter.checkManifest("/m");
    assert.deepEqual(calls, ["tc:/m", "lint:/m", "list:/m", "mf:/m"]);
  });

  test("a failing typecheck surfaces ok:false with the output", async () => {
    const adapter = new StaticGateAdapter({
      typecheck: async () => ({ ok: false, output: "TS2345" }),
      lint: async () => ok, listTests: async () => ok, checkManifest: async () => ok,
    });
    const r = await adapter.typecheck("/m");
    assert.equal(r.ok, false);
    assert.match(r.output, /TS2345/);
  });
  ```
- [ ] Run it, see it fail.
- [ ] Minimal impl (a struct of four injected fns — a thin delegating adapter):
  ```ts
  // src/contexts/test-execution/infrastructure/static-gate.adapter.ts
  // WRAP of src/qa/validate.ts — the static gate (tsc / eslint-playwright / playwright --list /
  // manifest validity). Each check is injected so the adapter test runs without spawning tsc,
  // eslint, or playwright. Delegates — does not reimplement validation.
  import type { StaticGatePort, CheckResult } from "../application/ports/index.ts";

  export interface StaticGateChecks {
    typecheck(specDir: string): Promise<CheckResult>;
    lint(specDir: string): Promise<CheckResult>;
    listTests(specDir: string): Promise<CheckResult>;
    checkManifest(specDir: string): Promise<CheckResult>;
  }

  export class StaticGateAdapter implements StaticGatePort {
    constructor(private readonly checks: StaticGateChecks) {}
    typecheck(specDir: string): Promise<CheckResult> { return this.checks.typecheck(specDir); }
    lint(specDir: string): Promise<CheckResult> { return this.checks.lint(specDir); }
    listTests(specDir: string): Promise<CheckResult> { return this.checks.listTests(specDir); }
    checkManifest(specDir: string): Promise<CheckResult> { return this.checks.checkManifest(specDir); }
  }
  ```
- [ ] Run it, see it pass.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/test-execution/infrastructure/static-gate.adapter.ts \
          qa-engine/test/contexts/test-execution/infrastructure/static-gate.adapter.test.ts
  git commit -m "feat(test-execution): StaticGateAdapter delegating to the validate checks"
  ```

---

## Group B — objective-signal (THE KEYSTONE)

### Task B.1 — `DecideCoverageService` (carry `decideCoverage`/`blocksPublish` VERBATIM)

> **Base-fix / R2 guard.** `decideCoverage`/`blocksPublish` are pure and verified in
> `src/qa/change-coverage.ts`. They are NOT in the kernel (Task 0 confirmed). Carry them
> **byte-for-byte** into a domain service. A dedicated golden + parity test pins them. The keystone
> invariant — `unknown` NEVER blocks, `signal` never blocks — must survive verbatim.
> (Line numbers are omitted — names are stable, lines drift; the parity test is the guard.)

**Files:** `src/contexts/objective-signal/domain/decide-coverage.service.ts`,
`test/contexts/objective-signal/domain/decide-coverage.service.test.ts`,
`test/contexts/objective-signal/domain/decide-coverage-parity.test.ts`

- [ ] Write the failing golden test (the invariant pinned explicitly):
  ```ts
  // test/contexts/objective-signal/domain/decide-coverage.service.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import {
    DecideCoverageService,
    type ChangeCoverage,
    type CoveragePolicy,
  } from "@contexts/objective-signal/domain/decide-coverage.service.ts";

  const svc = new DecideCoverageService();
  const cc = (ratio: number, changedLines = 10, measured = true): ChangeCoverage =>
    ({ measured, overall: { changedLines, coveredChanged: Math.round(changedLines * ratio), ratio }, perFile: [], uncovered: [], branches: null });
  const enforce: CoveragePolicy = { mode: "enforce", minRatio: 0.7 };
  const signal: CoveragePolicy = { mode: "signal", minRatio: 0.7 };

  test("unmeasured coverage is unknown and NEVER blocks (the keystone invariant)", () => {
    assert.equal(svc.decide(null, enforce), "unknown");
    assert.equal(svc.decide(cc(0, 10, false), enforce), "unknown");
    assert.equal(svc.blocks("unknown", enforce), false);
  });

  test("zero changed lines is unknown", () => {
    assert.equal(svc.decide(cc(0, 0), enforce), "unknown");
  });

  test("ratio at/above minRatio passes; below fails", () => {
    assert.equal(svc.decide(cc(0.7), enforce), "pass");
    assert.equal(svc.decide(cc(0.69), enforce), "fail");
  });

  test("signal mode never blocks even on a fail", () => {
    assert.equal(svc.decide(cc(0.1), signal), "fail");
    assert.equal(svc.blocks("fail", signal), false);
  });

  test("enforce blocks ONLY on a measured fail", () => {
    assert.equal(svc.blocks("fail", enforce), true);
    assert.equal(svc.blocks("pass", enforce), false);
    assert.equal(svc.blocks("unknown", enforce), false);
  });
  ```
- [ ] Run it, see it fail.
- [ ] Minimal impl — copy the bodies VERBATIM, wrapped in a class:
  ```ts
  // src/contexts/objective-signal/domain/decide-coverage.service.ts
  // THE KEYSTONE GATE. decide() and blocks() are carried VERBATIM from src/qa/change-coverage.ts
  // (decideCoverage / blocksPublish). Do NOT "improve" the logic — a reimplementation that
  // starts blocking on `unknown` would freeze every cross-repo and unmeasured run (risk R2). The
  // parity test pins these to the legacy originals until Plan 7 deletes them.
  export type CoverageStatus = "pass" | "fail" | "unknown";
  export type CoverageMode = "off" | "signal" | "enforce";
  export interface CoveragePolicy { mode: CoverageMode; minRatio: number; }

  // ChangeCoverage read-model shape carried from change-coverage.ts (only the fields decide() reads
  // are required here; the full per-file/uncovered/branches fields are kept for the report).
  export interface ChangeCoverage {
    measured: boolean;
    overall: { changedLines: number; coveredChanged: number; ratio: number };
    perFile: { file: string; changed: number; covered: number; ratio: number }[];
    uncovered: { file: string; lines: number[] }[];
    branches: { changedBranches: number; takenBranches: number; ratio: number } | null;
  }

  export class DecideCoverageService {
    // VERBATIM from change-coverage.ts decideCoverage. Unmeasured/zero-changed → "unknown".
    decide(cc: ChangeCoverage | null, policy: CoveragePolicy): CoverageStatus {
      if (!cc || !cc.measured || cc.overall.changedLines === 0) return "unknown";
      return cc.overall.ratio >= policy.minRatio ? "pass" : "fail";
    }

    // VERBATIM from change-coverage.ts blocksPublish. Only "enforce" + "fail" blocks.
    blocks(status: CoverageStatus, policy: CoveragePolicy): boolean {
      return policy.mode === "enforce" && status === "fail";
    }
  }
  ```
- [ ] Run it, see it pass.
- [ ] Write the parity test against the legacy originals:
  ```ts
  // test/contexts/objective-signal/domain/decide-coverage-parity.test.ts
  // PARITY: the keystone gate must match src/qa/change-coverage.ts byte-for-byte (risk R2 pin).
  // Imports from src/ — excluded from qa-engine typecheck; runs via tsx.
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { DecideCoverageService } from "@contexts/objective-signal/domain/decide-coverage.service.ts";
  import { decideCoverage, blocksPublish } from "../../../../../src/qa/change-coverage.ts";

  const svc = new DecideCoverageService();
  test("PARITY: decide()/blocks() match legacy across the policy×ratio matrix", () => {
    const modes = ["off", "signal", "enforce"] as const;
    const ratios = [0, 0.5, 0.69, 0.7, 0.71, 1];
    for (const mode of modes) {
      const policy = { mode, minRatio: 0.7 };
      for (const ratio of ratios) {
        const cc = { measured: true, overall: { changedLines: 10, coveredChanged: Math.round(10 * ratio), ratio }, perFile: [], uncovered: [], branches: null };
        const status = svc.decide(cc, policy);
        assert.equal(status, decideCoverage(cc as never, policy as never), `${mode}/${ratio}`);
        assert.equal(svc.blocks(status, policy), blocksPublish(status, policy as never), `${mode}/${ratio} blocks`);
      }
      // null + unmeasured branches
      assert.equal(svc.decide(null, policy), decideCoverage(null, policy as never));
    }
  });
  ```
- [ ] Add `decide-coverage-parity.test.ts` to the typecheck exclude list.
- [ ] Run both + typecheck:
  ```bash
  node --import ./test-setup.mjs --import tsx --test \
    "qa-engine/test/contexts/objective-signal/domain/decide-coverage.service.test.ts" \
    "qa-engine/test/contexts/objective-signal/domain/decide-coverage-parity.test.ts"
  npm run typecheck
  ```
  Expected: all pass.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/objective-signal/domain/decide-coverage.service.ts \
          qa-engine/test/contexts/objective-signal/domain/ qa-engine/tsconfig.json
  git commit -m "feat(objective-signal): DecideCoverageService carrying decideCoverage/blocksPublish verbatim"
  ```

### Task B.2 — Coverage collector adapters (the missing DI seam — base-fix)

> **Base-fix.** `defaultCollectCoverage` (change-coverage.ts:447) hard-codes `readFileSync`/
> `readdirSync` with no `*Deps` — the keystone's one weak spot. We give it a real DI seam:
> `CoverageCollectorPort` per ecosystem. Each adapter **delegates to the verified pure parser**
> (`parseLcov`/`parseIstanbulJson`/`parseJacocoXml`/`parseV8Coverage`) but takes the file read as an
> injected fn, so the FS dependency is explicit and the adapter is testable without disk.

The port's `CoverageReport`/`CoveredLines` shapes (`{ file, lines: number[] }`) differ from the
legacy `Map<string, Set<number>>`. The adapter converts at the boundary.

**Files:** `src/contexts/objective-signal/infrastructure/lcov-coverage.adapter.ts`,
`.../c8-coverage.adapter.ts`, `.../jacoco-coverage.adapter.ts`, `.../v8-browser-coverage.adapter.ts`,
`.../coverage-collector.adapter.ts` (composite) + mirrored tests.

- [ ] Write the failing test for the lcov adapter (inject a `readFile` returning fixture lcov text):
  ```ts
  // test/contexts/objective-signal/infrastructure/lcov-coverage.adapter.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { LcovCoverageAdapter } from "@contexts/objective-signal/infrastructure/lcov-coverage.adapter.ts";

  const LCOV = ["SF:src/svc.ts", "DA:1,3", "DA:2,0", "DA:3,5", "end_of_record"].join("\n");

  test("parses injected lcov text into a CoverageReport (only hit lines)", async () => {
    const adapter = new LcovCoverageAdapter(
      async () => [{ path: "/m/coverage/lcov.info", text: LCOV }],   // injected file reader
      "/m",
    );
    const report = await adapter.collect("/m/e2e", "qa-abc");
    const file = report.covered.find((c) => c.file === "src/svc.ts");
    assert.ok(file);
    assert.deepEqual(file!.lines.sort((a, b) => a - b), [1, 3]); // line 2 had 0 hits → excluded
  });

  test("returns an empty report when no lcov files are found (never throws — fail-open)", async () => {
    const adapter = new LcovCoverageAdapter(async () => [], "/m");
    const report = await adapter.collect("/m/e2e", "qa-abc");
    assert.deepEqual(report.covered, []);
  });
  ```
- [ ] Run it, see it fail.
- [ ] Minimal impl (delegate to the verified `parseLcov` pure parser — but DON'T import it from
  src/; copy the conversion at the boundary using an injected reader). Because the parser is pure
  and we must not duplicate it, the adapter takes an injected `parse` fn defaulting to the carried
  copy. Simplest: inject BOTH the reader and parser; the composition (Plan 6) binds the real
  `parseLcov`. Here the adapter just orchestrates read → parse → convert:
  ```ts
  // src/contexts/objective-signal/infrastructure/lcov-coverage.adapter.ts
  // CoverageCollectorPort over lcov. The missing DI seam: the file read is injected (no hard-coded
  // readFileSync), so this is unit-testable without disk and fail-open by contract (no files → empty
  // report, never a throw). The lcov→CoveredLines parse is injected too (defaults to the verified
  // src/qa/change-coverage.ts parseLcov via the Plan-6 composition) — this adapter does not rewrite
  // the parser; it adapts Map<string,Set<number>> to the port's CoveredLines[] shape.
  import type { CoverageCollectorPort, CoverageReport } from "../application/ports/index.ts";

  export interface CoverageFile { path: string; text: string; }
  type ReadLcovFiles = (specDir: string, namespace: string) => Promise<CoverageFile[]>;
  // repoDir is passed from the constructor; the injected default handles it as optional so this type
  // also accepts parseLcov from src/qa/change-coverage.ts (which declares repoDir?: string).
  type ParseLcov = (text: string, repoDir?: string) => Map<string, Set<number>>;

  export class LcovCoverageAdapter implements CoverageCollectorPort {
    constructor(
      private readonly readFiles: ReadLcovFiles,
      private readonly repoDir: string,
      private readonly parse: ParseLcov = defaultParseLcov,
    ) {}

    async collect(specDir: string, namespace: string): Promise<CoverageReport> {
      const files = await this.readFiles(specDir, namespace);
      const merged = new Map<string, Set<number>>();
      for (const f of files) {
        for (const [file, lines] of this.parse(f.text, this.repoDir)) {
          const set = merged.get(file) ?? new Set<number>();
          for (const ln of lines) set.add(ln);
          merged.set(file, set);
        }
      }
      return { covered: [...merged].map(([file, lines]) => ({ file, lines: [...lines] })) };
    }
  }

  // Verbatim-carried lcov parser (SF/DA/end_of_record, hits>0). Copied VERBATIM from
  // change-coverage.ts parseLcov — including the `end_of_record` reset (file = null) AND the
  // normalizeRepoPath call on the SF: path. Kept local so the adapter has a self-contained default;
  // the parity test pins it to the legacy original.
  // CRITICAL: end_of_record MUST reset `file` to null so a second SF block in the same text does
  // not inherit the previous file's Set (the real parseLcov does this; omitting it causes DA lines
  // from block 2 to be attributed to the last file of block 1).
  // CRITICAL: the SF: path MUST pass through normalizeRepoPath(raw, repoDir) — the real parseLcov
  // does this to strip the absolute repoDir prefix so coverage paths and diff paths intersect on
  // the same repo-relative POSIX keys. Omitting it causes every absolute SF path to miss the diff
  // intersection (visible in the parity fixture — see the test below).
  function normalizeRepoPath(p: string, repoDir?: string): string {
    let out = p.replace(/\\/g, "/").trim();
    if (repoDir) {
      const root = repoDir.replace(/\\/g, "/").replace(/\/+$/, "");
      if (out.startsWith(root + "/")) out = out.slice(root.length + 1);
    }
    return out.replace(/^\.\//, "").replace(/^\/+/, "");
  }

  export function defaultParseLcov(text: string, repoDir?: string): Map<string, Set<number>> {
    const out = new Map<string, Set<number>>();
    let file: string | null = null;
    for (const line of text.split("\n")) {
      if (line.startsWith("SF:")) {
        file = normalizeRepoPath(line.slice(3).trim(), repoDir);
        if (!out.has(file)) out.set(file, new Set());
      } else if (line.startsWith("DA:") && file) {
        const [lnStr, hitsStr] = line.slice(3).split(",");
        const ln = Number(lnStr); const hits = Number(hitsStr);
        if (Number.isFinite(ln) && hits > 0) out.get(file)!.add(ln);
      } else if (line.startsWith("end_of_record")) {
        file = null;
      }
    }
    return out;
  }
  ```
- [ ] Run it, see it pass.
- [ ] Add a parity test pinning `defaultParseLcov` to the legacy `parseLcov`. The fixture MUST
  include a multi-record lcov (two `SF` blocks) to exercise the `end_of_record` reset — this is
  NON-OPTIONAL, because a parser without the reset silently attributes lines from block 2 to file 1:
  ```ts
  // test/contexts/objective-signal/infrastructure/lcov-coverage-parity.test.ts
  // PARITY: defaultParseLcov must match parseLcov from src/qa/change-coverage.ts.
  // Excluded from qa-engine typecheck; runs via tsx.
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { parseLcov } from "../../../../../src/qa/change-coverage.ts";

  // Import the private defaultParseLcov via a re-export added to lcov-coverage.adapter.ts
  // (export it as a named export for testability — the Plan-6 wiring only uses the class).
  import { defaultParseLcov } from "@contexts/objective-signal/infrastructure/lcov-coverage.adapter.ts";

  // Two-SF-block fixture: exercises end_of_record reset. Without the reset, block-2 lines
  // would be appended to the block-1 file's Set.
  const REPO_DIR = "/workspace/myapp";

  const TWO_BLOCK_LCOV = [
    "SF:src/a.ts", "DA:1,2", "DA:2,0", "end_of_record",
    "SF:src/b.ts", "DA:5,1", "DA:6,3", "end_of_record",
  ].join("\n");

  const SINGLE_BLOCK_LCOV = ["SF:src/svc.ts", "DA:1,3", "DA:2,0", "DA:3,5", "end_of_record"].join("\n");

  // Absolute-path fixture: exercises the normalizeRepoPath stripping — the divergence between the old
  // defaultParseLcov (which did NOT strip absolute paths) and parseLcov (which does). Without the fix,
  // this fixture would produce "/workspace/myapp/src/svc.ts" as the map key instead of "src/svc.ts",
  // and the diff intersection (which uses repo-relative keys) would yield zero covered lines.
  const ABSOLUTE_PATH_LCOV = [
    `SF:${REPO_DIR}/src/svc.ts`, "DA:1,3", "DA:2,0", "DA:3,5", "end_of_record",
  ].join("\n");

  const fixtures: Array<{ lcov: string; repoDir?: string }> = [
    { lcov: TWO_BLOCK_LCOV, repoDir: REPO_DIR },
    { lcov: SINGLE_BLOCK_LCOV, repoDir: REPO_DIR },
    { lcov: ABSOLUTE_PATH_LCOV, repoDir: REPO_DIR }, // parity on absolute SF: path normalization
    { lcov: "" },
  ];

  test("PARITY: defaultParseLcov matches parseLcov across fixtures (including two-block multi-record and absolute SF paths)", () => {
    for (const { lcov, repoDir } of fixtures) {
      const legacy = parseLcov(lcov, repoDir);
      const local = defaultParseLcov(lcov, repoDir);
      // Convert both Maps to a plain comparable object for deepEqual
      const toObj = (m: Map<string, Set<number>>) =>
        Object.fromEntries([...m].map(([k, v]) => [k, [...v].sort((a, b) => a - b)]));
      assert.deepEqual(toObj(local), toObj(legacy), `fixture: ${lcov.slice(0, 40)}`);
    }
  });
  ```
  Add the parity file to the typecheck exclude list. Export `defaultParseLcov` from the adapter file.
- [ ] Build `c8-coverage.adapter.ts`, `jacoco-coverage.adapter.ts`, `v8-browser-coverage.adapter.ts`
  the same way — each delegates to the matching legacy parser (`parseIstanbulJson` for c8/istanbul,
  `parseJacocoXml` for JVM, `parseV8Coverage` for browser dumps) behind an injected reader; each
  has a unit test + a parity test; each is fail-open (no files → empty report). For JaCoCo and V8,
  the parser needs the `changedFiles` list — pass it through the adapter constructor.
- [ ] Build the composite `CoverageCollectorAdapter` that dispatches to the right ecosystem
  collector (node→c8/v8, jvm→jacoco, generic→lcov) and merges; fail-open: an unknown ecosystem
  yields an empty report (→ `unknown` → never blocks). Unit-test the dispatch with stub collectors.
  ```ts
  // src/contexts/objective-signal/infrastructure/coverage-collector.adapter.ts
  // Composite CoverageCollectorPort: dispatches to the per-ecosystem collector and merges. An
  // ecosystem with no collector yields an empty report → DecideCoverageService returns "unknown" →
  // NEVER blocks (the keystone invariant lives in the decide service; this stays fail-open).
  import type { CoverageCollectorPort, CoverageReport } from "../application/ports/index.ts";

  // Default per-collector timeout (ms). A slow ecosystem collector must not hang the sequential
  // queue — the pipeline is single-run-at-a-time and a stuck collector would block indefinitely.
  // A timed-out collector degrades to an empty CoverageReport (→ "unknown" → NEVER blocks),
  // consistent with the keystone invariant: coverage unknown never blocks publish.
  const COLLECTOR_TIMEOUT_MS = 30_000;

  // Wraps a single collector call with a bounded AbortSignal timeout so a stuck collector degrades
  // gracefully to an empty report rather than hanging Promise.all (which would freeze the queue).
  async function collectWithTimeout(
    collector: CoverageCollectorPort,
    specDir: string,
    namespace: string,
    timeoutMs = COLLECTOR_TIMEOUT_MS,
  ): Promise<CoverageReport> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ covered: [] }), timeoutMs);
      collector.collect(specDir, namespace).then(
        (r) => { clearTimeout(timer); resolve(r); },
        () => { clearTimeout(timer); resolve({ covered: [] }); // error → empty (fail-open)
      );
    });
  }

  export class CoverageCollectorAdapter implements CoverageCollectorPort {
    constructor(
      private readonly collectors: readonly CoverageCollectorPort[],
      private readonly timeoutMs = COLLECTOR_TIMEOUT_MS,
    ) {}

    async collect(specDir: string, namespace: string): Promise<CoverageReport> {
      // Each collector runs with a bounded timeout. A slow/hanging collector degrades to an empty
      // report (→ DecideCoverageService returns "unknown" → NEVER blocks — the keystone invariant).
      const all = await Promise.all(
        this.collectors.map((c) => collectWithTimeout(c, specDir, namespace, this.timeoutMs)),
      );
      const merged = new Map<string, Set<number>>();
      for (const r of all) for (const c of r.covered) {
        const set = merged.get(c.file) ?? new Set<number>();
        for (const ln of c.lines) set.add(ln);
        merged.set(c.file, set);
      }
      return { covered: [...merged].map(([file, lines]) => ({ file, lines: [...lines] })) };
    }
  }
  ```
- [ ] Run the whole objective-signal infrastructure test set + typecheck:
  ```bash
  node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/objective-signal/infrastructure/**/*.test.ts"
  npm run typecheck
  ```
  Expected: all pass.
- [ ] Commit (one commit per adapter is cleaner — split if the diff exceeds ~200 lines):
  ```bash
  git add qa-engine/src/contexts/objective-signal/infrastructure/ \
          qa-engine/test/contexts/objective-signal/infrastructure/ qa-engine/tsconfig.json
  git commit -m "feat(objective-signal): CoverageCollectorPort adapters (the missing DI seam, fail-open)"
  ```

### Task B.3 — Value-oracle adapters (align the `ValueOracleResult` drift — base-fix)

> **Base-fix.** The Plan-2 port stub declares `ValueOracleResult` as `{ mutantCount, killedCount,
> score }` but the legacy oracle returns `{ valueScore, mutantCount, killedCount, details }`. Align
> the port to the legacy shape (rename `score`→`valueScore`, add `details`) so no field is silently
> dropped, then implement the two adapters by delegating to `runMutationOracle` /
> `runFaultInjectionOracle` (injected fns — no Stryker / no Playwright in the test).

**Files:** edit `src/contexts/objective-signal/application/ports/index.ts` (align the type);
`src/contexts/objective-signal/infrastructure/stryker-mutation-oracle.adapter.ts`,
`.../fault-injection-oracle.adapter.ts` + mirrored tests.

- [ ] **First fix the port types.** Edit the port barrel — two changes in one edit so the typecheck
  is run only once before any adapter code is written:
  ```ts
  // qa-engine/src/contexts/objective-signal/application/ports/index.ts
  //
  // Change 1: align ValueOracleResult to the legacy 4-field shape.
  // The Plan-2 stub had {mutantCount, killedCount, score}; renaming score→valueScore + adding details
  // prevents a silent field drop when the adapters wrap runMutationOracle / runFaultInjectionOracle.
  export interface ValueOracleResult {
    valueScore: number | null;
    mutantCount: number;
    killedCount: number;
    details: string;
  }
  //
  // Change 2: fix the ValueOraclePort.measure signature (was 2 params, adapters need 3).
  // The Plan-2 stub had measure(br, specDir) — 2 params. The adapters use measure(br, repoDir,
  // namespace) — 3 params — because repoDir maps to OracleInput.repoDir and namespace is per-run
  // (sha-scoped like "qa-bot-<sha>"), not a constructor-level static value. Align the port now so
  // the typecheck catches any implementation that still uses the old 2-param shape.
  export interface ValueOraclePort {
    measure(br: BlastRadius, repoDir: string, namespace: string): Promise<ValueOracleResult>;
  }
  ```
- [ ] Run `npx tsc --noEmit -p qa-engine/tsconfig.json` IMMEDIATELY after the port edit, before
  writing any adapter code. This confirms both port changes compile cleanly and catches any existing
  consumer that referenced the old `score` field or the old 2-param `measure` signature:
  ```bash
  npx tsc --noEmit -p qa-engine/tsconfig.json
  ```
  Expected: exits 0. Fix any `Property 'score' does not exist` or `Expected 2 arguments` errors
  in the port barrel before proceeding.
- [ ] Write the failing test for the mutation adapter (inject a fake `runMutationOracle`).
  `namespace` is a per-run sha-scoped string like `qa-bot-<sha>` that comes from the `measure` call
  args (or the BlastRadius), NOT from the constructor. The param that maps to `OracleInput.repoDir`
  is named `repoDir` in `measure` (not `specDir`). Assert `r.details` so a missing field fails a test:
  ```ts
  // test/contexts/objective-signal/infrastructure/stryker-mutation-oracle.adapter.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { StrykerMutationOracleAdapter } from "@contexts/objective-signal/infrastructure/stryker-mutation-oracle.adapter.ts";
  import { BlastRadius } from "@kernel/blast-radius.ts";
  import { Sha } from "@kernel/sha.ts";

  const sha = Sha.of("abcdef1");
  const br = BlastRadius.of(sha, ["src/svc.ts"]);

  test("delegates to runMutationOracle with repoDir (not specDir) + changedFiles from BlastRadius", async () => {
    let seen: { repoDir: string; namespace: string; changedFiles?: string[] } | null = null;
    const adapter = new StrykerMutationOracleAdapter(async (input) => {
      seen = { repoDir: input.repoDir, namespace: input.namespace, changedFiles: input.changedFiles };
      return { valueScore: 0.8, mutantCount: 10, killedCount: 8, details: "8/10 killed" };
    });
    const r = await adapter.measure(br, "/m/repo", `qa-bot-${sha.value}`);
    assert.equal(seen!.repoDir, "/m/repo");
    assert.equal(seen!.namespace, `qa-bot-${sha.value}`);
    assert.deepEqual(seen!.changedFiles, ["src/svc.ts"]);
    assert.equal(r.valueScore, 0.8);
    assert.equal(r.killedCount, 8);
    assert.equal(typeof r.details, "string", "details field must be present — ValueOracleResult has 4 fields");
  });

  test("a non-JS ecosystem returns a null score with a details string (never gates — signal only)", async () => {
    const adapter = new StrykerMutationOracleAdapter(async () => ({ valueScore: null, mutantCount: 0, killedCount: 0, details: "ecosystem not supported" }));
    const r = await adapter.measure(br, "/m/repo", "qa-bot-abc");
    assert.equal(r.valueScore, null);
    assert.equal(typeof r.details, "string");
  });
  ```
- [ ] Run it, see it fail.
- [ ] Minimal impl. `namespace` comes from the `measure` call arg (per-run, sha-scoped) — NOT a
  fixed constructor arg. The param mapping to `OracleInput.repoDir` is named `repoDir`:
  ```ts
  // src/contexts/objective-signal/infrastructure/stryker-mutation-oracle.adapter.ts
  // ValueOraclePort for the CODE target — WRAP of src/qa/learning/mutation-code.ts runMutationOracle.
  // The runner is injected so the adapter test needs no Stryker binary.
  // IMPORTANT: `namespace` is per-run (sha-scoped like "qa-bot-<sha>") — it comes from the
  // `measure` call args, NOT from the constructor. `repoDir` maps to OracleInput.repoDir (not specDir).
  // Signal-only by contract: a null valueScore never gates publish.
  import type { ValueOraclePort, ValueOracleResult } from "../application/ports/index.ts";
  import type { BlastRadius } from "@kernel/blast-radius.ts";

  // OracleInput fields this adapter uses (local structural type — no src/ import at runtime).
  interface OracleInputLike { target: "code"; repoDir: string; namespace: string; changedFiles?: string[]; }
  type RunMutation = (input: OracleInputLike) => Promise<ValueOracleResult>;

  export class StrykerMutationOracleAdapter implements ValueOraclePort {
    constructor(private readonly runMutation: RunMutation) {}

    async measure(br: BlastRadius, repoDir: string, namespace: string): Promise<ValueOracleResult> {
      return this.runMutation({
        target: "code",
        repoDir,
        namespace,
        changedFiles: [...br.changedFiles],
      });
    }
  }
  ```
  > The port's `ValueOraclePort.measure` signature (Plan 2) must be updated to accept `(br, repoDir,
  > namespace)` — propagate this signature change to the port barrel and the FaultInjectionOracleAdapter.
  > `ValueOracleResult` now has 4 fields (`valueScore`, `mutantCount`, `killedCount`, `details`) per Fix 8.
- [ ] Run it, see it pass.
- [ ] Build `FaultInjectionOracleAdapter` wrapping `runFaultInjectionOracle` with the SAME 3-param
  `measure(br, repoDir, namespace)` signature from the updated port. Concrete class skeleton:
  ```ts
  // src/contexts/objective-signal/infrastructure/fault-injection-oracle.adapter.ts
  // ValueOraclePort for the E2E target — WRAP of src/qa/learning/fault-injection-e2e.ts
  // runFaultInjectionOracle. The runner is injected so the adapter test needs no Playwright.
  // Implements the 3-param measure(br, repoDir, namespace) signature (port-aligned in B.3 step 1).
  // Signal-only by contract: a null valueScore never gates publish.
  import type { ValueOraclePort, ValueOracleResult } from "../application/ports/index.ts";
  import type { BlastRadius } from "@kernel/blast-radius.ts";

  interface FaultInjectionInputLike {
    target: "e2e";
    e2eDir: string;         // maps to repoDir (the mirror working copy of the app)
    baseUrl: string;        // live DEV URL for the injected fault run
    namespace: string;      // per-run sha-scoped identifier
    baselineCases?: { name: string; status: string }[];
  }
  type RunFaultInjection = (input: FaultInjectionInputLike) => Promise<ValueOracleResult | null>;

  export class FaultInjectionOracleAdapter implements ValueOraclePort {
    constructor(
      private readonly runFaultInjection: RunFaultInjection,
      private readonly baseUrl: string,         // live DEV URL (from the App config at wiring time)
    ) {}

    async measure(br: BlastRadius, repoDir: string, namespace: string): Promise<ValueOracleResult> {
      const result = await this.runFaultInjection({
        target: "e2e",
        e2eDir: repoDir,
        baseUrl: this.baseUrl,
        namespace,
      });
      // null means no JSON intercepted (inapplicable ecosystem / no fault fired). Return a
      // signal-only zero-score result so the caller sees a defined shape, not null — the
      // ValueOraclePort contract always returns ValueOracleResult (never null at the port).
      return result ?? { valueScore: null, mutantCount: 0, killedCount: 0, details: "no fault data intercepted" };
    }
  }
  ```
  Unit-test the delegation (inject a fake runner returning a result) + the "no JSON intercepted →
  null" path (inject a runner returning `null` and assert `valueScore: null, details` present).
- [ ] Run the oracle test set + typecheck:
  ```bash
  node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/objective-signal/infrastructure/*oracle*.test.ts"
  npm run typecheck
  ```
  Expected: all pass (the port alignment compiles).
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/objective-signal/application/ports/index.ts \
          qa-engine/src/contexts/objective-signal/infrastructure/*oracle*.adapter.ts \
          qa-engine/test/contexts/objective-signal/infrastructure/*oracle*.test.ts
  git commit -m "feat(objective-signal): ValueOracle adapters + align ValueOracleResult to legacy shape"
  ```

---

## Group C — workspace-and-publication (THE ONLY VcsWritePort context)

### Task C.1 — `WriteConfinementService` (port the pure confinement classifiers, copy+parity)

Lift the pure confinement classifiers (`parseStatusOutput`, `isE2eStray`, `isCodeDenied`,
`isDangerousPath`, `classifyStrays`) into a domain service; keep the effectful revert behind the
injected `Git`. Parity-pinned against `src/qa/confinement.ts`.

**Files:** `src/contexts/workspace-and-publication/domain/write-confinement.service.ts`,
`test/.../domain/write-confinement.service.test.ts`,
`test/.../domain/write-confinement-parity.test.ts`

- [ ] Write the failing unit test for the pure classifiers:
  ```ts
  // test/contexts/workspace-and-publication/domain/write-confinement.service.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { WriteConfinementService } from "@contexts/workspace-and-publication/domain/write-confinement.service.ts";

  const svc = new WriteConfinementService();

  test("parseStatusOutput handles rename lines and quoted paths", () => {
    const parsed = svc.parseStatusOutput('R  old.ts -> new.ts\n?? "spa ced.ts"\n M e2e/a.spec.ts');
    assert.deepEqual(parsed.map((p) => p.path), ["new.ts", "spa ced.ts", "e2e/a.spec.ts"]);
  });

  test("isE2eStray flags anything outside e2e/", () => {
    assert.equal(svc.isE2eStray("src/x.ts"), true);
    assert.equal(svc.isE2eStray("e2e/a.spec.ts"), false);
    assert.equal(svc.isE2eStray("e2e"), false);
  });

  test("isCodeDenied flags the denylist (.env, Dockerfile, .github/, docker-compose*)", () => {
    assert.equal(svc.isCodeDenied(".env"), true);
    assert.equal(svc.isCodeDenied(".env.local"), true);
    assert.equal(svc.isCodeDenied("docker-compose.yml"), true);
    assert.equal(svc.isCodeDenied("src/app.ts"), false);
  });

  test("isDangerousPath flags secret files regardless of target", () => {
    assert.equal(svc.isDangerousPath(".env"), true);
    assert.equal(svc.isDangerousPath("secrets.env"), true);
    assert.equal(svc.isDangerousPath("e2e/a.spec.ts"), false);
  });
  ```
- [ ] Run it, see it fail.
- [ ] Minimal impl — copy the pure bodies VERBATIM from `confinement.ts` into a class (incl.
  `CONFINEMENT_DENYLIST`); leave the effectful `runConfinement` out of the domain (it belongs to
  the VcsWrite adapter wiring, Plan 6). Keep `classifyStrays` as a method too.
- [ ] Run it, see it pass.
- [ ] Write the parity test importing the legacy classifiers from `src/qa/confinement.ts` and
  asserting `deepEqual` across a representative path table (rename lines, quoted paths, `.env.*`,
  case-insensitive `DOCKERFILE`, suffix `*.env`). Add the parity file to the typecheck exclude list.
- [ ] Run both + typecheck, see them pass.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/workspace-and-publication/domain/write-confinement.service.ts \
          qa-engine/test/contexts/workspace-and-publication/domain/ qa-engine/tsconfig.json
  git commit -m "feat(workspace-and-publication): WriteConfinementService porting the confinement classifiers"
  ```

### Task C.2 — `VcsWriteAdapter` (implements `VcsWritePort` — the security seam)

> **Security invariant.** This is the ONLY adapter implementing `VcsWritePort`. The Plan-2 arch-lint
> (`qa-engine/test/arch/vcs-write-confinement.test.ts`) forbids any `generation/*` or
> `agent-runtime/*` module from importing it. Keep it here; never re-export it from a barrel that a
> generation module imports.

Implements `commit`/`push` by delegating to the injected `Git` fn (same `Git` type as
`repo-mirror.ts`). No raw git strings leak out; argv lives in the adapter.

**Files:** `src/contexts/workspace-and-publication/infrastructure/vcs-write.adapter.ts`,
`test/.../infrastructure/vcs-write.adapter.test.ts`

- [ ] Write the failing test (inject a fake `Git` recording argv):
  ```ts
  // test/contexts/workspace-and-publication/infrastructure/vcs-write.adapter.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { VcsWriteAdapter } from "@contexts/workspace-and-publication/infrastructure/vcs-write.adapter.ts";

  test("commit stages the files and commits with the message", async () => {
    const calls: string[][] = [];
    const adapter = new VcsWriteAdapter(async (args) => { calls.push(args); return ""; });
    await adapter.commit("/m", "test(e2e): qa", ["e2e/a.spec.ts"]);
    assert.deepEqual(calls[0], ["add", "--", "e2e/a.spec.ts"]);
    assert.ok(calls[1]?.includes("commit"));
    assert.ok(calls[1]?.includes("test(e2e): qa"));
  });

  test("push force-with-leases the branch to origin", async () => {
    const calls: string[][] = [];
    const adapter = new VcsWriteAdapter(async (args) => { calls.push(args); return ""; });
    await adapter.push("/m", "qa/e2e-abc");
    assert.ok(calls[0]?.includes("push"));
    assert.ok(calls[0]?.includes("--force-with-lease"));
    assert.ok(calls[0]?.includes("qa/e2e-abc"));
  });
  ```
- [ ] Run it, see it fail.
- [ ] Minimal impl (delegate to the injected `Git`; mirror publish.ts argv):
  ```ts
  // src/contexts/workspace-and-publication/infrastructure/vcs-write.adapter.ts
  // THE security seam: the ONLY implementation of VcsWritePort. The arch-lint gate forbids
  // generation/* and agent-runtime/* from importing this file or the port (agent-is-read-only).
  // Delegates to the injected Git fn (same boundary as repo-mirror.realGit); argv lives here.
  import type { VcsWritePort } from "../application/ports/index.ts";

  type Git = (args: string[], cwd?: string) => Promise<string>;

  export class VcsWriteAdapter implements VcsWritePort {
    constructor(private readonly git: Git) {}

    async commit(dir: string, message: string, files: readonly string[]): Promise<void> {
      await this.git(["add", "--", ...files], dir);
      await this.git(["commit", "-m", message], dir);
    }

    async push(dir: string, branch: string): Promise<void> {
      await this.git(["push", "--force-with-lease", "-u", "origin", branch], dir);
    }
  }
  ```
  > Plan-6 wiring injects `realGit` (which prepends `authHeaderArgs()` + hardening). The adapter
  > stays auth-agnostic so the test needs no token.
  >
  > Add this security comment to the adapter file so the Plan-6 composer cannot miss the requirement:
  > ```ts
  > // SECURITY: the injected git fn MUST prepend authHeaderArgs() before any network git operation
  > // (clone, fetch, push). The adapter itself is auth-agnostic (token-free, testable) — the
  > // real-wiring obligation is on the injector (Plan-6 composition root), not this class.
  > ```
- [ ] Run it, see it pass.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/workspace-and-publication/infrastructure/vcs-write.adapter.ts \
          qa-engine/test/contexts/workspace-and-publication/infrastructure/vcs-write.adapter.test.ts
  git commit -m "feat(workspace-and-publication): VcsWriteAdapter — the sole VcsWritePort implementation"
  ```

### Task C.3 — `GitHubPrAdapter` + `GitHubIssueAdapter` (WRAP `src/integrations/github.ts`)

Implement `GitHubPrPort.openWithAutoMerge` and `GitHubIssuePort.open` by delegating to the injected
`github` calls. The PR adapter does the open → enable-auto-merge → direct-merge-fallback dance
(carried from publish.ts), inject all three calls.

**Files:** `.../infrastructure/github-pr.adapter.ts`, `.../infrastructure/github-issue.adapter.ts`
+ mirrored tests.

- [ ] Write the failing test for the issue adapter:
  ```ts
  // test/contexts/workspace-and-publication/infrastructure/github-issue.adapter.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { GitHubIssueAdapter } from "@contexts/workspace-and-publication/infrastructure/github-issue.adapter.ts";

  test("open delegates to github.openIssue and maps the url", async () => {
    const adapter = new GitHubIssueAdapter(async (repo, title) => ({ url: `https://gh/${repo}/issues/1#${title}` }));
    const issue = await adapter.open("org/app", "E2E failed", "details");
    assert.match(issue.url, /org\/app\/issues\/1/);
    assert.equal(issue.number, 1); // parsed from url tail; throws if absent (FIX 13b — never silent 0)
  });
  ```
- [ ] Run it, see it fail.
- [ ] Minimal impl (the legacy `openIssue` returns only `{ url }`; the port wants `{ url, number }`
  — derive `number` from the url tail, default 0):
  ```ts
  // src/contexts/workspace-and-publication/infrastructure/github-issue.adapter.ts
  // WRAP of github.openIssue. The legacy call returns { url } only; the port wants { url, number }
  // — we parse the issue number from the url tail (best-effort, 0 when absent). Injected so the test
  // needs no GITHUB_TOKEN / network.
  import type { GitHubIssuePort, Issue } from "../application/ports/index.ts";

  type OpenIssue = (repo: string, title: string, body: string) => Promise<{ url: string }>;

  export class GitHubIssueAdapter implements GitHubIssuePort {
    constructor(private readonly openIssue: OpenIssue) {}
    async open(repo: string, title: string, body: string): Promise<Issue> {
      const { url } = await this.openIssue(repo, title, body);
      const match = url.match(/\/issues\/(\d+)/);
      // FIX 13b: never silently return number:0 — a sentinel 0 looks like a valid issue number
      // to callers and makes the issue unaddressable. Throw explicitly so the caller surface the
      // problem loudly (an issue URL without a number is a GitHub API contract violation).
      if (!match) throw new Error(`GitHubIssueAdapter: cannot parse issue number from URL: ${url}`);
      return { url, number: Number(match[1]) };
    }
  }
  ```
- [ ] Run it, see it pass.
- [ ] Write the failing test for the PR adapter (inject createPR + enableAutoMerge + mergePR;
  assert: success enables auto-merge; auto-merge throw → direct merge fallback):
  ```ts
  // test/contexts/workspace-and-publication/infrastructure/github-pr.adapter.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { GitHubPrAdapter } from "@contexts/workspace-and-publication/infrastructure/github-pr.adapter.ts";

  const pr = { url: "https://gh/pr/7", nodeId: "NODE", number: 7 };

  test("opens the PR and enables auto-merge on the happy path", async () => {
    const log: string[] = [];
    const adapter = new GitHubPrAdapter({
      createPullRequest: async () => pr,
      enableAutoMerge: async (id) => { log.push(`am:${id}`); },
      mergePullRequest: async () => { log.push("direct"); },
    });
    const out = await adapter.openWithAutoMerge("org/app", "qa/e2e-abc", "T", "B");
    assert.equal(out.url, pr.url);
    assert.equal(out.number, 7);
    assert.deepEqual(log, ["am:NODE"]); // direct merge NOT attempted
  });

  test("falls back to a direct merge when auto-merge is unavailable", async () => {
    const log: string[] = [];
    const adapter = new GitHubPrAdapter({
      createPullRequest: async () => pr,
      enableAutoMerge: async () => { throw new Error("auto-merge not allowed"); },
      mergePullRequest: async (repo, n) => { log.push(`direct:${repo}:${n}`); },
    });
    await adapter.openWithAutoMerge("org/app", "qa/e2e-abc", "T", "B");
    assert.deepEqual(log, ["direct:org/app:7"]);
  });
  ```
- [ ] Run it, see it fail.
- [ ] Minimal impl carrying the open→auto-merge→direct-merge fallback from publish.ts:
  ```ts
  // src/contexts/workspace-and-publication/infrastructure/github-pr.adapter.ts
  // WRAP of github.createPullRequest/enableAutoMerge/mergePullRequest. Carries the auto-merge →
  // direct-merge fallback from publish.ts (the "commit tests back" promise must not silently fail
  // when a repo lacks branch protection). All three calls injected — no GITHUB_TOKEN / network in tests.
  import type { GitHubPrPort, PullRequest } from "../application/ports/index.ts";

  export interface GitHubPrCalls {
    createPullRequest(repo: string, args: { title: string; head: string; base: string; body: string }): Promise<{ url: string; nodeId: string; number: number }>;
    enableAutoMerge(nodeId: string): Promise<void>;
    mergePullRequest(repo: string, number: number): Promise<void>;
  }

  export class GitHubPrAdapter implements GitHubPrPort {
    constructor(private readonly calls: GitHubPrCalls, private readonly base = "main") {}

    async openWithAutoMerge(repo: string, branch: string, title: string, body: string): Promise<PullRequest> {
      const pr = await this.calls.createPullRequest(repo, { title, head: branch, base: this.base, body });
      try {
        await this.calls.enableAutoMerge(pr.nodeId);
      } catch {
        // Auto-merge unavailable (no branch protection). The harness already proved this green and
        // the PR is test-only, so fall back to a direct merge. A direct-merge failure is left to the
        // caller (PR stays open, surfaced loudly) — we do not throw out of the publish path.
        try { await this.calls.mergePullRequest(repo, pr.number); } catch { /* leave open; caller logs */ }
      }
      return { url: pr.url, number: pr.number };
    }
  }
  ```
  > `base` should come from the App's `baseBranch` at wiring time (Plan 6). Default `"main"` keeps
  > the unit test simple.
- [ ] Run it, see it pass.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/workspace-and-publication/infrastructure/github-*.adapter.ts \
          qa-engine/test/contexts/workspace-and-publication/infrastructure/github-*.adapter.test.ts
  git commit -m "feat(workspace-and-publication): GitHubPr/GitHubIssue adapters wrapping github.ts"
  ```

### Task C.4 — `PublishDecisionService` + `ShadowLogAdapter` + `MirrorGcAdapter`

`PublishDecisionService` is the pure decision: given a verdict + reviewer approval + coverage-block
+ shadow flag + whether `e2e/` changed, decide the outcome (`pr` | `issue` | `shadow` | `quarantine`
| `noop`). This encodes the pipeline's decide step (CLAUDE.md §9) as pure logic — no I/O.
`ShadowLogAdapter` replaces every side effect with a log line (shadow mode). `MirrorGcAdapter`
implements `MirrorGcPort.prune`.

**Files:** `.../domain/publish-decision.service.ts`, `.../infrastructure/shadow-log.adapter.ts`,
`.../infrastructure/mirror-gc.adapter.ts` + mirrored tests.

- [ ] Write the failing test for the decision service (the truth table from CLAUDE.md §9):
  ```ts
  // test/contexts/workspace-and-publication/domain/publish-decision.service.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { PublishDecisionService } from "@contexts/workspace-and-publication/domain/publish-decision.service.ts";

  const svc = new PublishDecisionService();
  const base = { reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true };

  test("green + approved + not blocked + changes → pr", () => {
    assert.equal(svc.decide({ ...base, verdict: "pass" }).outcome, "pr");
  });
  test("green + approved but no e2e changes → noop", () => {
    assert.equal(svc.decide({ ...base, verdict: "pass", e2eChanged: false }).outcome, "noop");
  });
  test("green but reviewer rejected → issue", () => {
    assert.equal(svc.decide({ ...base, verdict: "pass", reviewerApproved: false }).outcome, "issue");
  });
  test("green but coverage enforce-blocks → issue (PR held)", () => {
    assert.equal(svc.decide({ ...base, verdict: "pass", coverageBlocks: true }).outcome, "issue");
  });
  test("fail or invalid → issue", () => {
    assert.equal(svc.decide({ ...base, verdict: "fail" }).outcome, "issue");
    assert.equal(svc.decide({ ...base, verdict: "invalid" }).outcome, "issue");
  });
  test("flaky → quarantine", () => {
    assert.equal(svc.decide({ ...base, verdict: "flaky" }).outcome, "quarantine");
  });
  test("infra-error → noop (no side effect; not a code bug)", () => {
    assert.equal(svc.decide({ ...base, verdict: "infra-error" }).outcome, "noop");
  });
  test("shadow mode overrides every side-effecting outcome to shadow", () => {
    assert.equal(svc.decide({ ...base, verdict: "pass", shadow: true }).outcome, "shadow");
    assert.equal(svc.decide({ ...base, verdict: "fail", shadow: true }).outcome, "shadow");
  });
  // FIX 13a: skipped must be a noop (the agent approved with zero specs — a clean exit,
  // not an error; opening an issue for a skipped run would be a false positive).
  test("skipped → noop (agent approved zero specs — clean exit, not an error)", () => {
    assert.equal(svc.decide({ ...base, verdict: "skipped" }).outcome, "noop");
  });
  // FIX 13a note: `infra-error` handling is deliberately kept minimal here (→ noop).
  // The full infra-error notification flow (alert channel, retry logic) is audited at
  // Plan-6 wiring where the full pipeline context is available. Do NOT add infra-error
  // side effects to PublishDecisionService before that audit.
  ```
- [ ] Run it, see it fail.
- [ ] Minimal impl (pure decision; precedence: shadow > terminal verdicts):
  ```ts
  // src/contexts/workspace-and-publication/domain/publish-decision.service.ts
  // The pure decide step (CLAUDE.md §9): given the verdict + reviewer approval + coverage-block +
  // shadow + whether e2e/ changed, decide the outcome. No I/O — the adapters act on the outcome.
  // Shadow mode replaces every side effect with a log line, so it short-circuits to "shadow".
  import type { RunVerdict } from "@kernel/run-verdict.ts";

  export type PublishOutcome = "pr" | "issue" | "shadow" | "quarantine" | "noop";
  export interface PublishContext {
    verdict: RunVerdict;
    reviewerApproved: boolean;
    coverageBlocks: boolean;
    shadow: boolean;
    e2eChanged: boolean;
  }
  export interface PublishDecision { outcome: PublishOutcome; reason: string; }

  export class PublishDecisionService {
    decide(ctx: PublishContext): PublishDecision {
      if (ctx.shadow) return { outcome: "shadow", reason: "shadow mode — side effects replaced with logs" };
      switch (ctx.verdict) {
        case "pass":
          if (!ctx.reviewerApproved) return { outcome: "issue", reason: "green but reviewer rejected" };
          if (ctx.coverageBlocks) return { outcome: "issue", reason: "green but change-coverage enforce-blocks the PR" };
          if (!ctx.e2eChanged) return { outcome: "noop", reason: "green with no e2e/ changes — nothing to publish" };
          return { outcome: "pr", reason: "green, approved, covered — open PR with auto-merge" };
        case "flaky":
          return { outcome: "quarantine", reason: "flaky — quarantine, no PR" };
        case "infra-error":
          return { outcome: "noop", reason: "infra-error — DEV down, not a code bug; no side effect" };
        case "skipped":
          return { outcome: "noop", reason: "skipped — no work to publish" };
        case "fail":
        case "invalid":
        default:
          return { outcome: "issue", reason: `${ctx.verdict} — open an Issue` };
      }
    }
  }
  ```
- [ ] Run it, see it pass.
- [ ] Define `ShadowPublicationPort` in the workspace-and-publication ports barrel BEFORE writing
  the adapter. The adapter must implement a named port so the swap boundary is type-safe and
  visible to the arch-lint. Either:
  - Add `ShadowPublicationPort` as a distinct interface (preferred — explicit, arch-lint visible):
    ```ts
    // qa-engine/src/contexts/workspace-and-publication/application/ports/index.ts
    // The shadow-mode swap boundary. ShadowLogAdapter implements this port; at composition
    // time (Plan 6) the DI container selects ShadowLogAdapter when qa.shadow=true and the
    // real adapters otherwise. Implementing a union of GitHubPrPort & GitHubIssuePort &
    // VcsWritePort & MirrorGcPort here (or as a distinct named interface) makes the arch-lint
    // capable of forbidding shadow-mode from leaking into the generation context.
    export interface ShadowPublicationPort {
      openPr(repo: string, branch: string, title: string, body: string): Promise<void>;
      openIssue(repo: string, title: string, body: string): Promise<void>;
      commit(dir: string, message: string, files: readonly string[]): Promise<void>;
      push(dir: string, branch: string): Promise<void>;
      prune(mirrorDir: string): Promise<void>;
    }
    ```
  - OR declare explicitly that `ShadowLogAdapter` implements the union
    `GitHubPrPort & GitHubIssuePort & VcsWritePort & MirrorGcPort` behind an injected `log` fn, with
    a comment making the swap boundary intent clear. Either approach; the chosen one must be documented
    in the file header so the Plan-6 composer knows what to inject.
  > Run `npx tsc --noEmit -p qa-engine/tsconfig.json` after adding the port; fix any errors before
  > writing the adapter.
- [ ] Write `ShadowLogAdapter` (a thin adapter implementing the side-effect ports' shape by logging
  via an injected `log` fn; unit-test that it logs instead of acting) and `MirrorGcAdapter`
  (implements `MirrorGcPort.prune` by delegating to an injected git/gc fn; unit-test delegation).
  Each: failing test → impl → pass.
- [ ] Run the workspace-and-publication test set + typecheck:
  ```bash
  node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/workspace-and-publication/**/*.test.ts"
  npm run typecheck
  ```
  Expected: all pass.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/workspace-and-publication/domain/publish-decision.service.ts \
          qa-engine/src/contexts/workspace-and-publication/infrastructure/{shadow-log,mirror-gc}.adapter.ts \
          qa-engine/test/contexts/workspace-and-publication/
  git commit -m "feat(workspace-and-publication): PublishDecisionService + Shadow/MirrorGc adapters"
  ```

---

## Group D — app-catalog (app-specificity lives ONLY here)

### Task D.1 — `App` aggregate (config invariants as domain rules)

The `App` aggregate enforces the same invariants the zod `AppConfigSchema` refinements do
(`dev` required unless `code: true`; service repos unique and different from the primary) — as
domain rules, so the rest of the engine depends on a validated aggregate, not a raw config.

**Files:** `src/contexts/app-catalog/domain/app.aggregate.ts`,
`test/contexts/app-catalog/domain/app.aggregate.test.ts`

- [ ] Write the failing test:
  ```ts
  // test/contexts/app-catalog/domain/app.aggregate.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { App } from "@contexts/app-catalog/domain/app.aggregate.ts";

  const e2e = { name: "portfolio", repo: "org/portfolio", baseBranch: "main", code: false, shadow: true, services: [], dev: { versionUrl: "https://dev/version" } };

  test("an e2e app requires a dev block", () => {
    assert.throws(() => App.fromConfig({ ...e2e, dev: undefined }), /dev is required/);
  });

  test("a code app does NOT require dev and rejects services", () => {
    assert.doesNotThrow(() => App.fromConfig({ name: "lib", repo: "org/lib", baseBranch: "main", code: true, shadow: false, services: [] }));
    assert.throws(() => App.fromConfig({ name: "lib", repo: "org/lib", baseBranch: "main", code: true, shadow: false, services: [{ repo: "org/svc" }] }), /services are only valid for e2e/);
  });

  test("service repo must not equal the primary (distinct error message)", () => {
    // FIX 13c: two distinct invariants → two distinct messages so operators can diagnose the violation.
    assert.throws(() => App.fromConfig({ ...e2e, services: [{ repo: "org/portfolio" }] }), /circular dependency/);
  });
  test("service repos must be unique among themselves (distinct error message)", () => {
    assert.throws(() => App.fromConfig({ ...e2e, services: [{ repo: "org/svc" }, { repo: "org/svc" }] }), /unique/);
  });

  test("a valid e2e app exposes its repos", () => {
    const app = App.fromConfig({ ...e2e, services: [{ repo: "org/svc" }] });
    assert.equal(app.name, "portfolio");
    assert.equal(app.primaryRepo, "org/portfolio");
    assert.deepEqual(app.serviceRepos, ["org/svc"]);
  });
  ```
- [ ] Run it, see it fail.
- [ ] Minimal impl (invariants in the factory; throw `DomainError`-shaped messages mirroring the
  zod refinements):
  ```ts
  // src/contexts/app-catalog/domain/app.aggregate.ts
  // The App aggregate: the watched-app config invariants (today the zod AppConfigSchema refinements)
  // expressed as DOMAIN RULES, so the engine depends on a validated aggregate, not a raw config.
  // App-specificity lives ONLY in this context (CLAUDE.md invariant).
  export interface AppServiceConfig { repo: string; openapi?: string; versionUrl?: string; }
  export interface AppConfigInput {
    name: string; repo: string; baseBranch: string;
    code: boolean; shadow: boolean;
    services: AppServiceConfig[];
    dev?: { versionUrl?: string } | undefined;
  }

  export class App {
    private constructor(private readonly cfg: AppConfigInput) {}

    static fromConfig(cfg: AppConfigInput): App {
      // Invariant 1: dev required unless code mode (code apps have no web environment).
      if (!cfg.code && cfg.dev === undefined) {
        throw new Error("dev is required unless code: true (code mode has no web environment)");
      }
      // Invariant 2: services are e2e-only.
      if (cfg.code && cfg.services.length > 0) {
        throw new Error("services are only valid for e2e apps (code-mode apps have no E2E suite)");
      }
      // Invariant 3a: no service repo may equal the primary repo.
      const serviceRepoSet = cfg.services.map((s) => s.repo);
      if (serviceRepoSet.includes(cfg.repo)) {
        throw new Error(`service repo "${cfg.repo}" must not equal the primary repo (circular dependency)`);
      }
      // Invariant 3b: service repos must be unique among themselves.
      if (new Set(serviceRepoSet).size !== serviceRepoSet.length) {
        throw new Error("service repos must be unique — duplicate service repo found");
      }
      return new App(cfg);
    }

    get name(): string { return this.cfg.name; }
    get primaryRepo(): string { return this.cfg.repo; }
    get baseBranch(): string { return this.cfg.baseBranch; }
    get isCode(): boolean { return this.cfg.code; }
    get isShadow(): boolean { return this.cfg.shadow; }
    get serviceRepos(): string[] { return this.cfg.services.map((s) => s.repo); }
  }
  ```
- [ ] Run it, see it pass.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/app-catalog/domain/app.aggregate.ts \
          qa-engine/test/contexts/app-catalog/domain/app.aggregate.test.ts
  git commit -m "feat(app-catalog): App aggregate enforcing config invariants as domain rules"
  ```

### Task D.2 — `RepoResolutionService` (SHA → App + RepoRole)

Pure service: given a repo slug, find the App that owns it and whether the slug is the `primary`
repo or a `service` repo (cross-repo microservice trigger). Mirrors `loadAppConfigsByRepo`'s match
logic but over `App` aggregates, decoupled from the filesystem.

**Files:** `src/contexts/app-catalog/domain/repo-resolution.service.ts`,
`test/contexts/app-catalog/domain/repo-resolution.service.test.ts`

- [ ] Write the failing test:
  ```ts
  // test/contexts/app-catalog/domain/repo-resolution.service.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { App } from "@contexts/app-catalog/domain/app.aggregate.ts";
  import { RepoResolutionService } from "@contexts/app-catalog/domain/repo-resolution.service.ts";

  const app = App.fromConfig({ name: "portfolio", repo: "org/portfolio", baseBranch: "main", code: false, shadow: true, services: [{ repo: "org/api" }], dev: { versionUrl: "https://dev" } });
  const svc = new RepoResolutionService([app]);

  test("a primary-repo slug resolves with role primary", () => {
    const r = svc.resolve("org/portfolio");
    assert.equal(r?.app.name, "portfolio");
    assert.equal(r?.role, "primary");
  });
  test("a service-repo slug resolves the owning app with role service", () => {
    const r = svc.resolve("org/api");
    assert.equal(r?.app.name, "portfolio");
    assert.equal(r?.role, "service");
  });
  test("an unknown slug resolves to null (never throws)", () => {
    assert.equal(svc.resolve("org/unknown"), null);
  });
  ```
- [ ] Run it, see it fail.
- [ ] Minimal impl:
  ```ts
  // src/contexts/app-catalog/domain/repo-resolution.service.ts
  // Resolves a repo slug to the owning App + its role (primary vs service) for cross-repo
  // microservice triggers. Pure — over App aggregates, not the filesystem. Returns null for an
  // unknown slug (the webhook is for an unwatched repo) — never throws.
  import type { App } from "./app.aggregate.ts";

  export type RepoRole = "primary" | "service";
  export interface RepoResolution { app: App; role: RepoRole; }

  export class RepoResolutionService {
    constructor(private readonly apps: readonly App[]) {}
    resolve(repoSlug: string): RepoResolution | null {
      for (const app of this.apps) {
        if (app.primaryRepo === repoSlug) return { app, role: "primary" };
        if (app.serviceRepos.includes(repoSlug)) return { app, role: "service" };
      }
      return null;
    }
  }
  ```
- [ ] Run it, see it pass.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/app-catalog/domain/repo-resolution.service.ts \
          qa-engine/test/contexts/app-catalog/domain/repo-resolution.service.test.ts
  git commit -m "feat(app-catalog): RepoResolutionService mapping a repo slug to App + RepoRole"
  ```

### Task D.3 — `YamlAppConfigAdapter` (implements `AppRepositoryPort`, WRAP `config-loader.ts`)

Implements `load`/`list`/`resolveByRepo` by delegating to the injected `loadAppConfig` /
`listAppConfigs` and constructing `App` aggregates, returning the port's `AppConfigSnapshot` shape.

**Files:** `src/contexts/app-catalog/infrastructure/yaml-app-config.adapter.ts`,
`test/contexts/app-catalog/infrastructure/yaml-app-config.adapter.test.ts`

- [ ] Write the failing test (inject fake loaders returning legacy-config-shaped objects):
  ```ts
  // test/contexts/app-catalog/infrastructure/yaml-app-config.adapter.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { YamlAppConfigAdapter } from "@contexts/app-catalog/infrastructure/yaml-app-config.adapter.ts";

  const raw = { name: "portfolio", repo: "org/portfolio", baseBranch: "main", code: false, qa: { shadow: true }, services: [{ repo: "org/api" }], dev: { versionUrl: "https://dev" } };

  test("load maps a legacy config to an AppConfigSnapshot", async () => {
    const adapter = new YamlAppConfigAdapter({ load: (n) => ({ ...raw, name: n }), list: () => [raw] });
    const snap = await adapter.load("portfolio");
    assert.equal(snap.name, "portfolio");
    assert.equal(snap.repo, "org/portfolio");
    assert.equal(snap.shadow, true);
    assert.deepEqual(snap.services.map((s) => s.repo), ["org/api"]);
  });

  test("resolveByRepo finds the owning app + role across all configs", async () => {
    const adapter = new YamlAppConfigAdapter({ load: () => raw, list: () => [raw] });
    assert.equal((await adapter.resolveByRepo("org/api"))?.role, "service");
    assert.equal((await adapter.resolveByRepo("org/portfolio"))?.role, "primary");
    assert.equal(await adapter.resolveByRepo("org/nope"), null);
  });
  ```
- [ ] Run it, see it fail.
- [ ] Minimal impl (delegate to the injected loaders; map `qa.shadow`→`shadow`; build `App` for
  validation, then project to `AppConfigSnapshot`):
  ```ts
  // src/contexts/app-catalog/infrastructure/yaml-app-config.adapter.ts
  // WRAP of src/orchestrator/config-loader.ts. Delegates to the injected loadAppConfig/listAppConfigs
  // (so the adapter test needs no config/ files), validates via the App aggregate, and projects to the
  // port's AppConfigSnapshot. App-specificity stays HERE.
  import type { AppRepositoryPort, AppConfigSnapshot, RepoRole } from "../application/ports/index.ts";
  import { App } from "../domain/app.aggregate.ts";
  import { RepoResolutionService } from "../domain/repo-resolution.service.ts";

  // Structural shape of the legacy ValidatedAppConfig fields this adapter reads (declared locally so
  // the adapter does not import from src/; the real loaders are injected at wiring time).
  interface LegacyConfig {
    name: string; repo: string; baseBranch?: string; code?: boolean;
    qa?: { shadow?: boolean }; services?: { repo: string; openapi?: string; versionUrl?: string }[];
    dev?: { versionUrl?: string };
  }
  export interface ConfigLoaders {
    load(name: string): LegacyConfig;
    list(): LegacyConfig[];
  }

  function toSnapshot(cfg: LegacyConfig): AppConfigSnapshot {
    const app = App.fromConfig({
      name: cfg.name, repo: cfg.repo, baseBranch: cfg.baseBranch ?? "main",
      code: cfg.code ?? false, shadow: cfg.qa?.shadow ?? false,
      services: cfg.services ?? [],
      dev: cfg.dev,
    });
    return {
      name: app.name, repo: app.primaryRepo, baseBranch: app.baseBranch,
      code: app.isCode, shadow: app.isShadow,
      services: (cfg.services ?? []).map((s) => ({ repo: s.repo, ...(s.openapi ? { openapi: s.openapi } : {}), ...(s.versionUrl ? { versionUrl: s.versionUrl } : {}) })),
    };
  }

  export class YamlAppConfigAdapter implements AppRepositoryPort {
    constructor(private readonly loaders: ConfigLoaders) {}

    async load(name: string): Promise<AppConfigSnapshot> {
      return toSnapshot(this.loaders.load(name));
    }

    async list(): Promise<AppConfigSnapshot[]> {
      return this.loaders.list().map(toSnapshot);
    }

    async resolveByRepo(repoSlug: string): Promise<{ app: AppConfigSnapshot; role: RepoRole } | null> {
      // Call list() ONCE into a local const to avoid the double FS scan and the non-null-assertion
      // race where the second list() call could return a different set (e.g. a file was added between
      // the two calls, or the loader is a test double that mutates state).
      const configs = this.loaders.list();
      const apps = configs.map((c) => App.fromConfig({
        name: c.name, repo: c.repo, baseBranch: c.baseBranch ?? "main",
        code: c.code ?? false, shadow: c.qa?.shadow ?? false, services: c.services ?? [], dev: c.dev,
      }));
      const resolution = new RepoResolutionService(apps).resolve(repoSlug);
      if (!resolution) return null;
      // Find from the same local const — no second FS scan, no race.
      const cfg = configs.find((c) => c.name === resolution.app.name)!;
      return { app: toSnapshot(cfg), role: resolution.role };
    }
  }
  ```
- [ ] Run it, see it pass.
- [ ] Run the app-catalog test set + typecheck:
  ```bash
  node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/app-catalog/**/*.test.ts"
  npm run typecheck
  ```
  Expected: all pass.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/app-catalog/infrastructure/yaml-app-config.adapter.ts \
          qa-engine/test/contexts/app-catalog/infrastructure/yaml-app-config.adapter.test.ts
  git commit -m "feat(app-catalog): YamlAppConfigAdapter wrapping config-loader"
  ```

---

## Group E — cross-run-learning (STUBBED off-path)

### Task E.1 — `RuleGovernanceService` (ranking truth — base-fix: kill the duplicate SQL ORDER BY)

> **Base-fix.** The legacy two-way coupling: `history.ts` imports `applyOutcome` from
> `learning-rule.ts`, AND distiller/retrieval import `history.ts`. Worse, ranking truth is
> DUPLICATED — once in `applyOutcome` (promotion logic) and once in the SQL `ORDER BY` at
> `history.ts:297` (`(status='active') DESC, success_rate DESC, at DESC`). We make
> `RuleGovernanceService` the SINGLE source of ranking truth; the SQLite adapter (Task E.2) does a
> plain unordered `SELECT` and lets the service rank. This is pure, off-path, and never gates publish.

**Files:** `src/contexts/cross-run-learning/domain/rule-governance.service.ts`,
`test/contexts/cross-run-learning/domain/rule-governance.service.test.ts`

- [ ] **First: extend the `LearningRule` port to the full legacy shape.** The Plan-2 stub only has
  `{ trigger, action, errorClass, status, confidence, successRate }`. The `rowToRule` mapper (E.2)
  and the test fixtures in both E.1 and E.2 use the full 9-field legacy shape (`id`, `archetype`,
  `usageCount`, `outcomeCount`, `lastVerified`, `source`, `at`). Without them the typecheck will
  fail. Edit the port barrel:
  ```ts
  // qa-engine/src/contexts/cross-run-learning/application/ports/index.ts
  // Extended to the full legacy LearningRule shape (src/qa/learning/learning-rule.ts).
  // The Plan-2 stub had only 6 fields; rowToRule and the ranking service both need the
  // remaining 7 (id, archetype, usageCount, outcomeCount, lastVerified, source, at).
  export interface LearningRule {
    id: string;
    trigger: string;
    action: string;
    errorClass: ErrorClass;
    archetype: string | null;
    status: RuleStatus;
    confidence: "low" | "medium" | "high";
    usageCount: number;
    outcomeCount: number;
    successRate: number | null;
    lastVerified: string | null;
    source: string;
    at: string;              // ISO-8601 timestamp — the 3rd SQL sort key (at DESC tiebreak)
  }
  ```
- [ ] Run `npx tsc --noEmit -p qa-engine/tsconfig.json` immediately after the port edit to confirm
  the expanded interface compiles cleanly before writing any service code:
  ```bash
  npx tsc --noEmit -p qa-engine/tsconfig.json
  ```
  Expected: exits 0. Fix any type errors (likely a `StubLearningRepository.save` stub or the
  `ReflectorPort` that references `LearningRule`) before continuing.
- [ ] Write the failing test for ranking (the order that was hard-coded in SQL):
  ```ts
  // test/contexts/cross-run-learning/domain/rule-governance.service.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { RuleGovernanceService } from "@contexts/cross-run-learning/domain/rule-governance.service.ts";
  import type { LearningRule } from "@contexts/cross-run-learning/application/ports/index.ts";

  // `at` is required: the full legacy LearningRule includes it (history.ts ORDER BY ... at DESC).
  const rule = (status: LearningRule["status"], successRate: number | null, trigger: string, at = "2026-01-01T00:00:00.000Z"): LearningRule =>
    ({ id: trigger, trigger, action: "a", errorClass: "E-X", archetype: null, status, confidence: "medium", usageCount: 0, outcomeCount: 0, successRate, lastVerified: null, source: "oracle", at });

  const svc = new RuleGovernanceService();

  test("rank: active before candidate, then by successRate desc (the former SQL ORDER BY, now pure)", () => {
    const ranked = svc.rank([
      rule("candidate", 0.9, "c-high"),
      rule("active", 0.5, "a-low"),
      rule("active", 0.8, "a-high"),
    ]);
    assert.deepEqual(ranked.map((r) => r.trigger), ["a-high", "a-low", "c-high"]);
  });

  test("rank: a null successRate sorts as 0 (COALESCE(success_rate, 0))", () => {
    const ranked = svc.rank([rule("active", null, "a-null"), rule("active", 0.1, "a-0.1")]);
    assert.deepEqual(ranked.map((r) => r.trigger), ["a-0.1", "a-null"]);
  });

  test("rank: at DESC tiebreak when status and successRate are identical (3rd SQL sort key)", () => {
    const ranked = svc.rank([
      rule("active", 0.5, "older", "2026-01-01T00:00:00.000Z"),
      rule("active", 0.5, "newer", "2026-06-01T00:00:00.000Z"),
    ]);
    assert.deepEqual(ranked.map((r) => r.trigger), ["newer", "older"]);
  });

  test("topRules: only active+candidate are retrievable, deprecated/superseded excluded", () => {
    const top = svc.topRules([rule("deprecated", 0.9, "dep"), rule("active", 0.5, "act"), rule("superseded", 0.9, "sup")], 5);
    assert.deepEqual(top.map((r) => r.trigger), ["act"]);
  });
  ```
- [ ] Run it, see it fail.
- [ ] Minimal impl (the ranking that was in SQL, now pure):
  ```ts
  // src/contexts/cross-run-learning/domain/rule-governance.service.ts
  // The SINGLE source of ranking truth. The legacy ranking was DUPLICATED: once in applyOutcome's
  // promotion logic and once in the SQL ORDER BY in history.ts. The SqliteLearningRepository now
  // does a plain unordered SELECT and defers to THIS service — deleting the duplicate ORDER BY.
  // Pure, off-path, never gates publish.
  import type { LearningRule } from "../application/ports/index.ts";

  const RETRIEVABLE: ReadonlySet<LearningRule["status"]> = new Set(["active", "candidate"]);

  export class RuleGovernanceService {
    // Carries the former SQL ORDER BY verbatim:
    //   (status='active') DESC, COALESCE(success_rate, 0) DESC, at DESC
    // Three-key sort: status (active wins), then successRate (higher first, null→0),
    // then at (newer timestamp wins) — matches history.ts listRulesStmt exactly.
    rank(rules: readonly LearningRule[]): LearningRule[] {
      return [...rules].sort((a, b) => {
        const activeDelta = Number(b.status === "active") - Number(a.status === "active");
        if (activeDelta !== 0) return activeDelta;
        const rateDelta = (b.successRate ?? 0) - (a.successRate ?? 0);
        if (rateDelta !== 0) return rateDelta;
        return b.at.localeCompare(a.at); // at DESC: newer ISO string > older ISO string
      });
    }

    // Retrieval gate: only active+candidate rules are eligible (matches history.ts listRulesStmt's
    // `status IN ('active', 'candidate')`), then ranked and capped.
    topRules(rules: readonly LearningRule[], limit: number): LearningRule[] {
      return this.rank(rules.filter((r) => RETRIEVABLE.has(r.status))).slice(0, limit);
    }
  }
  ```
- [ ] Run it, see it pass.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/cross-run-learning/domain/rule-governance.service.ts \
          qa-engine/test/contexts/cross-run-learning/domain/rule-governance.service.test.ts
  git commit -m "feat(cross-run-learning): RuleGovernanceService as the single ranking source (kills the duplicate SQL ORDER BY)"
  ```

### Task E.2 — `SqliteLearningRepository` (invert the coupling + `'pending'→'candidate'` base-fix)

> **Critical base-fix (§11).** The read path must map legacy `'pending'` rows → `'candidate'` BEFORE
> typing. The kernel port's `RuleStatus` dropped `'pending'` (it is `candidate|active|deprecated|
> superseded`), but `learning-rule.ts:12` still carries it for back-compat with rows an older build
> wrote. The adapter's `rowToRule` must coerce `'pending'`→`'candidate'` so no row violates the port
> type. Ranking is delegated to `RuleGovernanceService` (Task E.1) — the SELECT is unordered.

The adapter delegates SQL to an injected `db`-like interface (prepared-statement runner) so the test
needs no SQLite. It inverts the coupling: `applyOutcome` governance is consumed via an injected fn,
not imported from `history.ts`.

**Files:** `src/contexts/cross-run-learning/infrastructure/sqlite-learning-repository.adapter.ts`,
`test/contexts/cross-run-learning/infrastructure/sqlite-learning-repository.adapter.test.ts`

- [ ] Write the failing test (inject a fake row store; assert the `'pending'` coercion + ranking
  delegation):
  ```ts
  // test/contexts/cross-run-learning/infrastructure/sqlite-learning-repository.adapter.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { SqliteLearningRepository } from "@contexts/cross-run-learning/infrastructure/sqlite-learning-repository.adapter.ts";
  import { Sha } from "@kernel/sha.ts";

  // A legacy row with status 'pending' (an older build wrote it). The read path MUST coerce it.
  // Column names mirror the real `learning_rules` schema: trigger_text, action_text, error_class,
  // plus the full set of fields rowToRule maps (id, archetype, usage_count, outcome_count,
  // last_verified, source, at).
  const rows = [
    { id: "r1", trigger_text: "t1", action_text: "a1", error_class: "E-X", archetype: null, status: "pending", confidence: "low", usage_count: 0, outcome_count: 0, success_rate: 0.9, last_verified: null, source: "oracle", at: "2026-01-01T00:00:00.000Z" },
    { id: "r2", trigger_text: "t2", action_text: "a2", error_class: "E-Y", archetype: null, status: "active", confidence: "high", usage_count: 2, outcome_count: 5, success_rate: 0.5, last_verified: null, source: "oracle", at: "2026-01-02T00:00:00.000Z" },
  ];

  test("maps a legacy 'pending' row to 'candidate' before typing (§11 back-compat)", async () => {
    const repo = new SqliteLearningRepository({ selectRules: () => rows, upsert: () => {}, recordOutcome: () => {} });
    const top = await repo.topRules(Sha.of("abcdef1"), 10);
    const t1 = top.find((r) => r.trigger === "t1");
    assert.ok(t1, "the pending row must survive as a candidate, not be dropped");
    assert.equal(t1!.status, "candidate"); // coerced from 'pending'
  });

  test("topRules ranks via RuleGovernanceService — active before the coerced candidate", async () => {
    const repo = new SqliteLearningRepository({ selectRules: () => rows, upsert: () => {}, recordOutcome: () => {} });
    const top = await repo.topRules(Sha.of("abcdef1"), 10);
    assert.deepEqual(top.map((r) => r.trigger), ["t2", "t1"]); // active(0.5) before candidate(0.9)
  });

  test("save delegates to the injected upsert (no SQLite in the test)", async () => {
    const calls: string[] = [];
    const repo = new SqliteLearningRepository({ selectRules: () => [], upsert: (r) => calls.push(r.trigger), recordOutcome: () => {} });
    // upsert receives a full LearningRule; assert trigger passes through
    await repo.save({ id: "r3", trigger: "new", action: "a", errorClass: "E-Z", archetype: null, status: "candidate", confidence: "medium", usageCount: 0, outcomeCount: 0, successRate: null, lastVerified: null, source: "oracle", at: new Date().toISOString() });
    assert.deepEqual(calls, ["new"]);
  });
  ```
- [ ] Run it, see it fail.
- [ ] Minimal impl (coerce `'pending'`; rank via the governance service; inject the store):
  ```ts
  // src/contexts/cross-run-learning/infrastructure/sqlite-learning-repository.adapter.ts
  // LearningRepositoryPort over SQLite — inverts the legacy two-way coupling (history.ts imported
  // applyOutcome; distiller/retrieval imported history). The store is injected (no SQLite binary in
  // tests); ranking is delegated to RuleGovernanceService (the SELECT is UNORDERED — the duplicate
  // SQL ORDER BY is gone). Off-path: a failure here never gates publish.
  //
  // §11 BASE-FIX: legacy rows may carry status 'pending' (retired in the port's RuleStatus). The read
  // path coerces 'pending' → 'candidate' BEFORE typing so no row violates the port type and no rule
  // is silently dropped.
  import type { LearningRepositoryPort, LearningRule, RuleStatus } from "../application/ports/index.ts";
  import type { Sha } from "@kernel/sha.ts";
  import type { RunOutcome } from "@kernel/run-outcome.ts";
  import { RuleGovernanceService } from "../domain/rule-governance.service.ts";

  // Column names mirror the real `learning_rules` schema (history.ts). The DB uses trigger_text and
  // action_text (NOT trigger/action). All fields rowToRule reads are declared here so the adapter
  // test can supply a full-fidelity fake row without hitting SQLite.
  export interface LearningRow {
    id: string;
    trigger_text: string;
    action_text: string;
    error_class: string;
    archetype: string | null;
    status: string;
    confidence: string;
    usage_count: number;
    outcome_count: number;
    success_rate: number | null;
    last_verified: string | null;
    source: string;
    at: string;
  }
  export interface LearningStore {
    // §11 doc: selectRules MUST run the production-query path: `status IN ('active', 'candidate')`.
    // The 'pending'→'candidate' coercion in rowToRule is back-compat defense for rows inserted by
    // an older build on an unfiltered read path (e.g. listAllLearningRules). On the filtered path it
    // is dead-but-harmless; it is kept because the adapter cannot guarantee what the injected store
    // returns in tests.
    selectRules(): LearningRow[];                 // UNORDERED — ranking is the service's job
    upsert(rule: LearningRule): void;
    recordOutcome(outcome: RunOutcome): void;
  }

  // §11: 'pending' (retired) maps to 'candidate'. Any unknown status also falls back to 'candidate'
  // (safe default — retrievable but unpromoted) rather than throwing on a malformed legacy row.
  function coerceStatus(raw: string): RuleStatus {
    if (raw === "active" || raw === "deprecated" || raw === "superseded") return raw;
    return "candidate"; // 'pending' and anything unexpected → candidate
  }

  // Maps a real DB row (trigger_text/action_text columns) to the full LearningRule port type.
  // Mirrors history.ts rowToRule exactly so no field is silently dropped.
  function rowToRule(row: LearningRow): LearningRule {
    return {
      id: row.id,
      trigger: row.trigger_text,
      action: row.action_text,
      errorClass: row.error_class as import("@kernel/error-class.ts").ErrorClass,
      archetype: row.archetype ?? null,
      status: coerceStatus(row.status),
      confidence: (row.confidence === "low" || row.confidence === "high") ? row.confidence : "medium",
      usageCount: row.usage_count,
      outcomeCount: row.outcome_count ?? 0,
      successRate: row.success_rate,
      lastVerified: row.last_verified,
      source: row.source,
      at: row.at,
    };
  }

  export class SqliteLearningRepository implements LearningRepositoryPort {
    private readonly governance = new RuleGovernanceService();
    constructor(private readonly store: LearningStore) {}

    async save(rule: LearningRule): Promise<void> {
      this.store.upsert(rule);
    }

    async topRules(_sha: Sha, limit: number): Promise<LearningRule[]> {
      const rules = this.store.selectRules().map(rowToRule);
      return this.governance.topRules(rules, limit);
    }

    async applyOutcome(outcome: RunOutcome): Promise<void> {
      // Off-path governance fold. The promotion math lives in the injected store's recordOutcome
      // (which wraps the legacy applyOutcome at wiring time) — never imported from history.ts here.
      this.store.recordOutcome(outcome);
    }
  }
  ```
- [ ] Run it, see it pass.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/cross-run-learning/infrastructure/sqlite-learning-repository.adapter.ts \
          qa-engine/test/contexts/cross-run-learning/infrastructure/sqlite-learning-repository.adapter.test.ts
  git commit -m "feat(cross-run-learning): SqliteLearningRepository inverts the coupling + maps legacy 'pending'->'candidate'"
  ```

### Task E.3 — `StubLearningRepository` (the v1 wiring — never gates publish)

The v1 composition wires this no-op so learning is entirely off-path. It returns no rules, swallows
saves/outcomes, and provably never blocks anything.

**Files:** `src/contexts/cross-run-learning/infrastructure/stub-learning-repository.adapter.ts`,
`test/contexts/cross-run-learning/infrastructure/stub-learning-repository.adapter.test.ts`

- [ ] Write the failing test:
  ```ts
  // test/contexts/cross-run-learning/infrastructure/stub-learning-repository.adapter.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { StubLearningRepository } from "@contexts/cross-run-learning/infrastructure/stub-learning-repository.adapter.ts";
  import { Sha } from "@kernel/sha.ts";

  test("topRules always returns [] (no rules ever influence the prompt in v1)", async () => {
    const repo = new StubLearningRepository();
    assert.deepEqual(await repo.topRules(Sha.of("abcdef1"), 10), []);
  });

  test("save and applyOutcome are no-ops that never throw (off-path, fail-open)", async () => {
    const repo = new StubLearningRepository();
    await assert.doesNotReject(repo.save({ id: "r1", trigger: "t", action: "a", errorClass: "E-X", archetype: null, status: "candidate", confidence: "low", usageCount: 0, outcomeCount: 0, successRate: null, lastVerified: null, source: "oracle", at: new Date().toISOString() }));
    await assert.doesNotReject(repo.applyOutcome({} as never));
  });
  ```
- [ ] Run it, see it fail.
- [ ] Minimal impl:
  ```ts
  // src/contexts/cross-run-learning/infrastructure/stub-learning-repository.adapter.ts
  // The v1 wiring: learning is OFF-PATH. This no-op never returns rules (so generation is never
  // influenced) and swallows saves/outcomes — provably never gates publish. Swap for
  // SqliteLearningRepository post-cutover (SPEC OQ3: ship stubbed, fill adapters later).
  import type { LearningRepositoryPort, LearningRule } from "../application/ports/index.ts";
  import type { Sha } from "@kernel/sha.ts";
  import type { RunOutcome } from "@kernel/run-outcome.ts";

  export class StubLearningRepository implements LearningRepositoryPort {
    async save(_rule: LearningRule): Promise<void> { /* off-path no-op */ }
    async topRules(_sha: Sha, _limit: number): Promise<LearningRule[]> { return []; }
    async applyOutcome(_outcome: RunOutcome): Promise<void> { /* off-path no-op */ }
  }
  ```
- [ ] Run it, see it pass.
- [ ] Commit:
  ```bash
  git add qa-engine/src/contexts/cross-run-learning/infrastructure/stub-learning-repository.adapter.ts \
          qa-engine/test/contexts/cross-run-learning/infrastructure/stub-learning-repository.adapter.test.ts
  git commit -m "feat(cross-run-learning): StubLearningRepository — the off-path v1 wiring"
  ```

---

## Final verification (run before declaring Plan 4 done)

- [ ] Full typecheck (both projects):
  ```bash
  npm run typecheck
  ```
  Expected: `tsc` exits 0 for root AND qa-engine (the parity test excludes keep src/-importing
  files out of the qa-engine compile).
- [ ] Full test suite:
  ```bash
  npm test 2>&1 | tail -8
  ```
  Expected: `0` failures; the new context tests appear in the count; the Plan-2 arch-lint
  (`vcs-write-confinement.test.ts`) still passes (no generation/agent-runtime module imports
  `VcsWritePort`).
- [ ] Confirm zero `src/` runtime files changed by this plan:
  ```bash
  git diff --name-only main -- src/ | rg -v "\.test\.ts$" || echo "no src/ runtime changes"
  ```
  Expected: `no src/ runtime changes` (the user's parallel WIP in `src/` is theirs, not ours — Plan
  4 touches only `qa-engine/`).
- [ ] Confirm the arch-lint invariant by inspection: `VcsWritePort`/`vcs-write.adapter.ts` are
  imported ONLY under `workspace-and-publication`:
  ```bash
  rg -rn "VcsWritePort|vcs-write.adapter" qa-engine/src | rg -v "workspace-and-publication" || echo "VcsWritePort confined"
  ```
  Expected: `VcsWritePort confined`.

---

## Self-Review

Before handing off, verify each claim against the running code, not memory:

1. **Wrap, don't rewrite.** Every infrastructure adapter delegates to an injected fn that the
   Plan-6 composition binds to the verified `src/` original (`runE2E`, `runCodeTests`,
   `parseLcov`/`parseIstanbulJson`/`parseJacocoXml`/`parseV8Coverage`, `runMutationOracle`,
   `runFaultInjectionOracle`, `github.*`, `realGit`, `loadAppConfig`/`listAppConfigs`). No
   Playwright/runner/Stryker/SQLite logic is reimplemented. Confirm: no adapter spawns a process or
   reads a file without an injected seam.
2. **Keystone verbatim.** `DecideCoverageService.decide`/`.blocks` are byte-for-byte the
   `change-coverage.ts` `decideCoverage`/`blocksPublish` bodies (line numbers omitted — names are
   stable, lines drift), pinned by `decide-coverage-parity.test.ts`. `unknown` and `signal`
   provably never block. Confirm the parity test is in the typecheck exclude list and passes.
3. **Security seam structural.** `VcsWritePort` is implemented ONLY in
   `workspace-and-publication/infrastructure/vcs-write.adapter.ts`; the final-verification rg
   confirms no other context imports it. The Plan-2 arch-lint stays green.
4. **Base-fixes landed:**
   - Coverage DI seam: `CoverageCollectorPort` adapters take an injected reader — no hard-coded
     `readFileSync`/`readdirSync` (fixes `defaultCollectCoverage`'s weak spot). Fail-open: no files →
     empty report → `unknown` → never blocks.
   - Learning coupling inverted: `RuleGovernanceService` is the single ranking source; the
     `SqliteLearningRepository` SELECT is unordered (the duplicate SQL `ORDER BY` at `history.ts:297`
     is dropped in the new path).
   - `'pending'→'candidate'` migration: `coerceStatus` maps the retired status before typing (§11);
     a legacy `pending` row survives as a `candidate`, never dropped, never a type violation.
   - `ValueOracleResult` drift: the port was realigned to the legacy 4-field shape
     (`valueScore`/`mutantCount`/`killedCount`/`details`) — no silent field drop.
   - `AppDefect`: the three names for "app is broken" collapse to one VO.
5. **Fail-open discipline.** Learning is off-path (StubLearningRepository wired in v1, never returns
   rules, never gates publish). The value oracle is signal-only (null score never gates). Coverage
   `unknown` never blocks. Confirm no adapter throws on the "no data" path.
6. **Conventions.** `@kernel`/`@contexts` aliases with `.ts` extensions; `node:test` +
   `node:assert/strict`; `src`↔`test` mirror; parity tests excluded from qa-engine typecheck;
   conventional commits with NO `Co-Authored-By`. Confirm `git log --oneline` shows clean
   `feat(<context>): …` messages.
7. **Out of scope respected.** No `opencode-client`/`prompts` (Plan 5), no agent-runtime, no
   generation, no Seam-2 cycle-break, no core orchestrator (Plan 6), no cutover (Plan 7), zero `src/`
   runtime changes.
