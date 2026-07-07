# QA Engine — Plan 1: Foundation (scaffold + characterization net)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the parallel `qa-engine/` package and a characterization safety net that captures the current `runPipeline` behavior, so later plans can rewrite the engine behind it without regressing — with zero change to `src/` runtime behavior.

**Architecture:** A new `qa-engine/` package lives beside `src/` (branch-by-abstraction). It compiles under the root gate (`npm test` + `npm run typecheck`) via a test-glob addition and a TypeScript project reference. The characterization net is a structural-equivalence comparator plus a frozen set of `RunOutcome` goldens captured from the *legacy* `runPipeline`; later plans run the rewritten engine against the same goldens. Stryker proves the net actually kills mutants in the trust keystone (`decideCoverage`/`blocksPublish`).

**Tech Stack:** Node ≥22.19, TypeScript 5.6 (strict, `noUncheckedIndexedAccess`), `tsx`, `node:test` + `node:assert/strict`, `@stryker-mutator/core` (+ `node-test-runner`, `typescript-checker`).

This plan covers spec §7.2 Steps 0–3 and the first §11 checklist item. It does **not** build the kernel, contexts, the rewritten orchestrator, or the cutover (Plans 2–7).

---

## File Structure

**Created**
- `qa-engine/package.json` — the engine package manifest (name `@panchito/qa-engine`, `node:test`-based test script).
- `qa-engine/tsconfig.json` — strict config with path aliases (`@kernel/*`, `@contexts/*`, `@interface/*`); referenced by the root tsconfig.
- `qa-engine/src/.gitkeep` — holds the empty `src/` mirror root until Plan 2 fills it.
- `qa-engine/test/characterization/equivalence.ts` — the pure structural `RunOutcome` comparator (the net's core; no IO).
- `qa-engine/test/characterization/equivalence.test.ts` — unit tests for the comparator.
- `qa-engine/test/characterization/capture-goldens.ts` — captures sanitized `RunOutcome` goldens from the legacy `runPipeline` for the 10 canonical scenarios.
- `qa-engine/test/characterization/goldens/*.json` — the 10 frozen goldens (committed).
- `qa-engine/test/characterization/golden-parity.test.ts` — asserts each captured golden round-trips through the comparator (the Plan-6 hook compares the rewritten engine here).
- `qa-engine/stryker.conf.json` — Stryker config scoped to `src/qa/change-coverage.ts`.
- `src/contract/openapi-drift.test.ts` — drift-guard: fails if `contract/openapi.json` no longer matches a fresh generation (only if no such guard already exists).
- `docs/superpowers/plans/_verified-state.md` — the re-verified current-state facts (Task 1 output).

**Modified**
- `package.json` (root) — extend the `test` glob to include `qa-engine/test/**/*.test.ts`; extend `typecheck` to cover `qa-engine`.
- `tsconfig.json` (root) — add `references: [{ "path": "./qa-engine" }]`.

**Frozen (read-only for this whole migration — do NOT edit)**
- `src/pipeline.ts` `PipelineDeps` interface + `runPipeline` signature.
- `contract/openapi.json`.

---

## Task 1: Re-verify current-state facts vs HEAD

The spec's `file:line` references are from a stale snapshot; the code keeps moving (it was 3021 lines at re-analysis, 3162 now). Lock down today's reality before anything depends on it. This task writes no code — it records facts and commits them.

**Files:**
- Create: `docs/superpowers/plans/_verified-state.md`

- [ ] **Step 1: Run the verification commands**

```bash
cd /Users/arielyumn/Desktop/TRABAJO/panchito
rg -n 'export (async )?function runPipeline' src/pipeline.ts
wc -l src/pipeline.ts
echo "pipeline.test.ts runPipeline calls: $(rg -c 'runPipeline\(' src/pipeline.test.ts)"
echo "pipeline-codex.test.ts runPipeline calls: $(rg -c 'runPipeline\(' src/pipeline-codex.test.ts)"
rg -n 'export function (decideCoverage|blocksPublish)' src/qa/change-coverage.ts
rg -n 'export interface RunOutcome' src/types.ts
node --version
```

Expected (values may have drifted again — record whatever you get):
- `runPipeline` defined around `src/pipeline.ts:828`, file ≈3162 lines.
- `pipeline.test.ts` ≈184 `runPipeline` calls; `pipeline-codex.test.ts` = 4 → **≈188 characterization scenarios total**.
- `decideCoverage` ≈`:173`, `blocksPublish` ≈`:179`.
- `RunOutcome` interface present in `src/types.ts`.
- Node ≥ 22.19.

- [ ] **Step 2: Record the facts**

Write `docs/superpowers/plans/_verified-state.md`:

```markdown
# Verified current-state (HEAD as of implementation)

- runPipeline: src/pipeline.ts:<LINE> ; file <N> lines
- characterization scenarios: pipeline.test.ts <A> + pipeline-codex.test.ts <B> = <A+B>
- decideCoverage: src/qa/change-coverage.ts:<L1> ; blocksPublish: :<L2>
- RunOutcome: src/types.ts:<L3>
- node: <version>

These numbers supersede the spec's stale snapshot. Re-run Task 1's commands if more than a few days elapse.
```

Fill `<...>` with the Step 1 output.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/_verified-state.md
git commit -m "docs(qa-engine): record verified current-state facts for the rewrite"
```

---

## Task 2: Freeze the migration boundaries

The two immovable seams are `PipelineDeps` + `runPipeline` (the function seam) and `contract/openapi.json` (the external contract). The function seam is frozen by convention (no edits in Plans 1–6); the contract is frozen by a drift-guard test that fails CI if `openapi.json` is regenerated.

**Files:**
- Create: `src/contract/openapi-drift.test.ts` (only if no equivalent guard exists)
- Test: `src/contract/openapi-drift.test.ts`

- [ ] **Step 1: Check whether a drift-guard already exists**

```bash
cd /Users/arielyumn/Desktop/TRABAJO/panchito
rg -l 'openapi' src/contract/*.test.ts
cat package.json | rg 'contract:gen'
rg -n 'gen-openapi' scripts/ 2>/dev/null
```

Expected: `contract:gen` script is `tsx scripts/gen-openapi.ts`. If a test already asserts `openapi.json` matches a fresh generation, STOP this task (guard exists) and only add the freeze note in Step 4. Otherwise continue.

- [ ] **Step 2: Write the failing drift-guard test**

```typescript
// src/contract/openapi-drift.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// FREEZE GUARD (migration boundary): contract/openapi.json is frozen for the duration of the
// hexagonal rewrite. Regenerating it without a deliberate, versioned API change breaks every SDK
// consumer. This test regenerates the contract into a temp path and asserts it is byte-identical
// to the committed file. If you intentionally change the API, update the committed file and this
// test's expectation in the same commit.
test("openapi.json is frozen — committed contract matches a fresh generation", () => {
  const root = join(import.meta.dirname, "..", "..");
  const committed = readFileSync(join(root, "contract", "openapi.json"), "utf8");
  const fresh = execFileSync("npx", ["tsx", "scripts/gen-openapi.ts", "--stdout"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(fresh.trim(), committed.trim(), "openapi.json drifted — regenerate intentionally or revert");
});
```

- [ ] **Step 3: Run it; adapt to the generator's real interface**

Run: `node --import tsx --test src/contract/openapi-drift.test.ts`

If `scripts/gen-openapi.ts` does not support `--stdout`, read it (`cat scripts/gen-openapi.ts`) and either (a) compare against the file it writes, or (b) add a `--stdout` branch to the generator. Expected end state: PASS on the committed contract.

- [ ] **Step 4: Add the freeze note to the spec-adjacent doc and commit**

Append to `docs/superpowers/plans/_verified-state.md`:

```markdown

## Frozen boundaries (Plans 1–6)
- DO NOT edit `PipelineDeps` interface or `runPipeline` signature in src/pipeline.ts.
- DO NOT run `npm run contract:gen` unless making a deliberate, versioned API change.
```

```bash
git add src/contract/openapi-drift.test.ts docs/superpowers/plans/_verified-state.md
git commit -m "test(contract): freeze openapi.json with a drift-guard"
```

---

## Task 3: Scaffold the `qa-engine/` package

Create the empty parallel package with strict TS and path aliases. No engine code yet — just the shell that compiles and runs an empty test set.

**Files:**
- Create: `qa-engine/package.json`, `qa-engine/tsconfig.json`, `qa-engine/src/.gitkeep`, `qa-engine/test/.gitkeep`

- [ ] **Step 1: Create the package manifest**

```json
// qa-engine/package.json
{
  "name": "@panchito/qa-engine",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "Hexagonal QA engine — built in parallel to src/, switched in via PIPELINE_ENGINE.",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json"
  }
}
```

- [ ] **Step 2: Create the strict tsconfig with path aliases**

```json
// qa-engine/tsconfig.json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "types": ["node"],
    "baseUrl": ".",
    "paths": {
      "@kernel/*": ["src/shared-kernel/*"],
      "@contexts/*": ["src/contexts/*"],
      "@interface/*": ["src/interface/*"]
    }
  },
  "include": ["src", "test"]
}
```

> `composite: true` is required for the root project reference (Task 4). With `noEmit`, builds are typecheck-only; that is intentional — `tsx` runs the TS at runtime.

- [ ] **Step 3: Create the mirror roots**

```bash
cd /Users/arielyumn/Desktop/TRABAJO/panchito
mkdir -p qa-engine/src qa-engine/test/characterization/goldens
touch qa-engine/src/.gitkeep qa-engine/test/.gitkeep
```

- [ ] **Step 4: Verify the package typechecks standalone**

Run: `cd qa-engine && npx tsc -p tsconfig.json && cd ..`
Expected: no output, exit 0 (empty project typechecks clean).

- [ ] **Step 5: Commit**

```bash
git add qa-engine/package.json qa-engine/tsconfig.json qa-engine/src/.gitkeep qa-engine/test/.gitkeep
git commit -m "feat(qa-engine): scaffold parallel package with strict tsconfig + path aliases"
```

---

## Task 4: Integrate `qa-engine/` into the root gate

`npm test` and `npm run typecheck` must cover both trees, preserving `test-setup.mjs` per-process SQLite isolation (resolved from the repo root).

**Files:**
- Modify: `package.json` (root) — `test` and `typecheck` scripts
- Modify: `tsconfig.json` (root) — add `references`

- [ ] **Step 1: Add a trivial passing test so the glob has something to find**

```typescript
// qa-engine/test/scaffold.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

test("qa-engine scaffold: test runner discovers and runs qa-engine tests", () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 2: Extend the root `test` script glob**

In root `package.json`, change the `test` script from:

```
node --import ./test-setup.mjs --import tsx --test "src/**/*.test.ts" "packages/sdk/**/*.test.ts" "agents/**/*.test.mjs"
```

to (append the qa-engine glob; `--import ./test-setup.mjs` stays repo-root-relative):

```
node --import ./test-setup.mjs --import tsx --test "src/**/*.test.ts" "qa-engine/test/**/*.test.ts" "packages/sdk/**/*.test.ts" "agents/**/*.test.mjs"
```

- [ ] **Step 3: Add the project reference for typecheck coverage**

In root `tsconfig.json`, add a top-level `references` key (sibling of `compilerOptions`):

```json
  "include": ["src"],
  "references": [{ "path": "./qa-engine" }]
```

Then change the root `typecheck` script from `tsc --noEmit` to `tsc --build` (project references require build mode for the referenced project to be checked):

```
"typecheck": "tsc --build --force"
```

> `--force` keeps it a full check each run (no stale `.tsbuildinfo` masking errors); `--build` honors the reference so `qa-engine` is typechecked too.

- [ ] **Step 4: Run the full gate**

Run: `npm run typecheck`
Expected: exit 0, both `src` and `qa-engine` checked.

Run: `npm test 2>&1 | tail -20`
Expected: PASS, and the qa-engine scaffold test is included in the count.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json qa-engine/test/scaffold.test.ts
git commit -m "build(qa-engine): wire qa-engine into the root test + typecheck gate"
```

---

## Task 5: Build the structural-equivalence comparator

The net's core: a pure function that decides whether two `RunOutcome`s are behaviorally equivalent, ignoring per-invocation fields (`runId`, `at`). This is what later plans use to assert the rewritten engine matches legacy.

**Files:**
- Create: `qa-engine/test/characterization/equivalence.ts`
- Test: `qa-engine/test/characterization/equivalence.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// qa-engine/test/characterization/equivalence.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runOutcomeEquivalent, type ComparableOutcome } from "./equivalence.ts";

const base: ComparableOutcome = {
  runId: "r1",
  app: "demo",
  sha: "abc",
  mode: "diff",
  target: "e2e",
  verdict: "pass",
  errorClass: null,
  gateSignals: {
    static: true,
    coverageRatio: 0.8,
    valueScore: null,
    reviewerCorrections: [],
    reviewerApproved: true,
    flaky: false,
    retries: 0,
  },
  at: "2026-06-24T00:00:00.000Z",
};

test("equivalence: identical-except-runId/at outcomes are equivalent", () => {
  const other = { ...base, runId: "r2", at: "2026-06-25T12:00:00.000Z" };
  assert.equal(runOutcomeEquivalent(base, other).equal, true);
});

test("equivalence: a different verdict is NOT equivalent", () => {
  const other = { ...base, runId: "r2", at: "later", verdict: "fail" as const };
  const r = runOutcomeEquivalent(base, other);
  assert.equal(r.equal, false);
  assert.match(r.diff ?? "", /verdict/);
});

test("equivalence: a different coverageRatio is NOT equivalent", () => {
  const other = { ...base, gateSignals: { ...base.gateSignals, coverageRatio: 0.5 } };
  assert.equal(runOutcomeEquivalent(base, other).equal, false);
});

test("equivalence: reviewerRationale text is ignored (not behavioral)", () => {
  const a = { ...base, gateSignals: { ...base.gateSignals, reviewerRationale: "looks good" } };
  const b = { ...base, runId: "r2", gateSignals: { ...base.gateSignals, reviewerRationale: "approved, solid" } };
  assert.equal(runOutcomeEquivalent(a, b).equal, true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test qa-engine/test/characterization/equivalence.test.ts`
Expected: FAIL — `Cannot find module './equivalence.ts'`.

- [ ] **Step 3: Write the comparator**

```typescript
// qa-engine/test/characterization/equivalence.ts
// Structural equivalence for RunOutcome (spec §10): two outcomes are behaviorally equivalent when
// their decision-bearing fields match. Per-invocation fields (runId, at) and free-text reasoning
// (reviewerRationale) are NOT behavioral and are excluded. This is the contract the rewritten
// engine must satisfy against the legacy goldens.

export interface ComparableOutcome {
  runId: string;
  app: string;
  sha: string;
  mode: string;
  target: string;
  verdict: string;
  errorClass: string | null;
  gateSignals: {
    static: boolean;
    coverageRatio: number | null;
    valueScore: number | null;
    reviewerCorrections: string[];
    reviewerApproved?: boolean;
    reviewerRationale?: string;
    flaky: boolean;
    retries: number;
  };
  at: string;
}

// The fields that define behavior. Order is stable so the serialized form is deterministic.
function behavioralProjection(o: ComparableOutcome): Record<string, unknown> {
  return {
    app: o.app,
    sha: o.sha,
    mode: o.mode,
    target: o.target,
    verdict: o.verdict,
    errorClass: o.errorClass,
    static: o.gateSignals.static,
    coverageRatio: o.gateSignals.coverageRatio,
    valueScore: o.gateSignals.valueScore,
    reviewerCorrections: o.gateSignals.reviewerCorrections,
    reviewerApproved: o.gateSignals.reviewerApproved ?? null,
    flaky: o.gateSignals.flaky,
    retries: o.gateSignals.retries,
  };
}

export function runOutcomeEquivalent(
  a: ComparableOutcome,
  b: ComparableOutcome,
): { equal: boolean; diff?: string } {
  const pa = behavioralProjection(a);
  const pb = behavioralProjection(b);
  for (const key of Object.keys(pa)) {
    const va = JSON.stringify(pa[key]);
    const vb = JSON.stringify(pb[key]);
    if (va !== vb) return { equal: false, diff: `${key}: ${va} !== ${vb}` };
  }
  return { equal: true };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --import tsx --test qa-engine/test/characterization/equivalence.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add qa-engine/test/characterization/equivalence.ts qa-engine/test/characterization/equivalence.test.ts
git commit -m "feat(qa-engine): structural RunOutcome equivalence comparator"
```

---

## Task 6: Capture the 10 legacy goldens

Run the *legacy* `runPipeline` for the 10 canonical scenarios, sanitize each `RunOutcome` to JSON, and freeze them. The capture reuses the existing `pipeline.test.ts` stub pattern (build `PipelineDeps` via a stub, call `runPipeline`, read `d.savedOutcomes[0]`). Author NO new scenarios — each golden mirrors an existing test's setup.

> NOTE: the rewritten engine does not exist yet (Plan 6). In Plan 1 the harness captures legacy goldens and proves they round-trip through the comparator. Plan 6 adds the side that runs the rewritten engine against these same files.

**Files:**
- Create: `qa-engine/test/characterization/capture-goldens.ts`
- Create: `qa-engine/test/characterization/goldens/*.json` (10 files, generated then committed)
- Test: `qa-engine/test/characterization/golden-parity.test.ts`

- [ ] **Step 1: Identify the 10 source scenarios**

```bash
cd /Users/arielyumn/Desktop/TRABAJO/panchito
rg -n "^test\(" src/pipeline.test.ts | rg -i "pass|fail|flaky|skip|invalid|infra|code|cross|shadow|context" | head -40
```

Pick one existing test per scenario key: `green-pr`, `fail-issue`, `flaky-quarantine`, `no-op-skip`, `invalid-issue`, `infra-error`, `code-mode`, `cross-repo`, `shadow`, `context`. Record the chosen test name for each (used as the comment in the capture file).

- [ ] **Step 2: Write the capture harness**

```typescript
// qa-engine/test/characterization/capture-goldens.ts
// Captures legacy runPipeline RunOutcome goldens, sanitized (runId/at stripped), for the 10
// canonical scenarios. Run via: node --import ../../../test-setup.mjs --import tsx capture-goldens.ts
// It reuses the SAME stub shape pipeline.test.ts uses. Each scenario mirrors an existing test's
// deps; do NOT invent behavior. The output JSON is committed and becomes the parity baseline.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runPipeline, type PipelineDeps } from "../../../src/pipeline.ts";
import type { RunOutcome } from "../../../src/types.ts";
import { buildScenarioDeps, scenarioApp, type ScenarioKey } from "./scenarios.ts";

const KEYS: ScenarioKey[] = [
  "green-pr", "fail-issue", "flaky-quarantine", "no-op-skip", "invalid-issue",
  "infra-error", "code-mode", "cross-repo", "shadow", "context",
];

function sanitize(o: RunOutcome): Record<string, unknown> {
  const { runId: _r, at: _a, ...rest } = o;
  return rest;
}

const outDir = join(import.meta.dirname, "goldens");
mkdirSync(outDir, { recursive: true });

for (const key of KEYS) {
  const { app, sha, source, opts, deps } = buildScenarioDeps(key);
  await runPipeline(app, sha, deps, source, opts);
  const outcome = deps.savedOutcomes[0];
  if (!outcome) throw new Error(`scenario ${key}: no RunOutcome was saved`);
  writeFileSync(join(outDir, `${key}.json`), JSON.stringify(sanitize(outcome), null, 2) + "\n");
  console.log(`captured ${key}`);
}
```

- [ ] **Step 3: Write `scenarios.ts` mirroring the existing stub pattern**

Read the `deps(...)` helper and `app` stub at the top of `src/pipeline.test.ts` first (the builder that produces `PipelineDeps` with `savedOutcomes`, `execute`, `generate`, `review`, etc.). Then port the 10 scenarios into a typed builder. Define exactly the deps each scenario needs — green-pr wires an approving review + passing execute + a publish stub; fail-issue wires a failing execute + openIssue stub; etc. (one block per key). The file MUST compile against the real `PipelineDeps` type.

```typescript
// qa-engine/test/characterization/scenarios.ts
import type { PipelineDeps } from "../../../src/pipeline.ts";
import type { AppConfig } from "../../../src/orchestrator/config-loader.ts";
import type { RunOutcome } from "../../../src/types.ts";

export type ScenarioKey =
  | "green-pr" | "fail-issue" | "flaky-quarantine" | "no-op-skip" | "invalid-issue"
  | "infra-error" | "code-mode" | "cross-repo" | "shadow" | "context";

// Captures every saved outcome (mirrors pipeline.test.ts's d.savedOutcomes).
export interface CaptureDeps extends PipelineDeps { savedOutcomes: RunOutcome[]; }

export const scenarioApp: AppConfig = /* port the `app` stub from pipeline.test.ts here */;

export function buildScenarioDeps(key: ScenarioKey): {
  app: AppConfig; sha: string; source: "manual" | "webhook";
  opts: { mode: RunOutcome["mode"]; target?: RunOutcome["target"]; runId: string };
  deps: CaptureDeps;
} {
  // One case per key, each porting the matching pipeline.test.ts test's deps. Implement all 10.
  // Example shape (green-pr):
  // case "green-pr": return { app: scenarioApp, sha: "abc123", source: "manual",
  //   opts: { mode: "diff", runId: "golden-green-pr" },
  //   deps: makeDeps({ verdict: "pass", passed: true, review: [{ approved: true, corrections: [], parsed: true }] }) };
  throw new Error(`unimplemented scenario: ${key}`);
}
```

> This step is real porting work: copy each scenario's stub from the corresponding `pipeline.test.ts` test (Step 1's list), not a generic template. The acceptance check is Step 4 producing 10 non-empty JSON files with the expected verdicts.

- [ ] **Step 4: Generate the goldens**

Run:
```bash
cd qa-engine/test/characterization
node --import ../../../test-setup.mjs --import tsx capture-goldens.ts
```
Expected: prints `captured <key>` ×10; `goldens/` has 10 JSON files. Spot-check `green-pr.json` has `"verdict": "pass"` and `fail-issue.json` has `"verdict": "fail"`.

- [ ] **Step 5: Write the parity test**

```typescript
// qa-engine/test/characterization/golden-parity.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runOutcomeEquivalent, type ComparableOutcome } from "./equivalence.ts";

// Each committed golden must round-trip through the comparator against itself (sanity: the
// comparator accepts real captured shapes). Plan 6 extends this file to compare the REWRITTEN
// engine's output for the same scenario against the golden.
const dir = join(import.meta.dirname, "goldens");

test("goldens: all 10 canonical scenarios are captured", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 10, `expected 10 goldens, found ${files.length}`);
});

for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  test(`golden ${file}: round-trips through the equivalence comparator`, () => {
    const golden = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const asComparable: ComparableOutcome = { runId: "x", at: "y", ...golden };
    assert.equal(runOutcomeEquivalent(asComparable, asComparable).equal, true);
  });
}
```

- [ ] **Step 6: Run the parity test**

Run: `node --import tsx --test qa-engine/test/characterization/golden-parity.test.ts`
Expected: PASS — "all 10 captured" + 10 round-trip tests.

- [ ] **Step 7: Commit**

```bash
git add qa-engine/test/characterization/scenarios.ts qa-engine/test/characterization/capture-goldens.ts qa-engine/test/characterization/goldens qa-engine/test/characterization/golden-parity.test.ts
git commit -m "feat(qa-engine): capture 10 legacy RunOutcome goldens + parity test"
```

---

## Task 7: Prove the net with Stryker (mutation testing)

Verify the characterization net actually kills mutants in the trust keystone (`decideCoverage`/`blocksPublish`). A green test suite that survives mutations is a false safety net — this is the §7.2 Step 2 non-negotiable gate.

**Files:**
- Create: `qa-engine/stryker.conf.json`
- Modify: root `package.json` (add a `mutate:keystone` script + dev deps)

- [ ] **Step 1: Read the existing Stryker pattern**

```bash
cd /Users/arielyumn/Desktop/TRABAJO/panchito
rg -n "stryker|testRunner|mutate" src/qa/learning/mutation-code.ts | head -20
```

Note the existing `testRunner: "command"` usage; the keystone gate uses the `node-test-runner` + `typescript-checker` plugins instead, for semantically-valid mutations.

- [ ] **Step 2: Install the Stryker plugins**

Run:
```bash
npm install -D @stryker-mutator/node-test-runner @stryker-mutator/typescript-checker
```
Expected: both added to `devDependencies`; `@stryker-mutator/core` already present.

- [ ] **Step 3: Write the Stryker config**

```json
// qa-engine/stryker.conf.json
{
  "$schema": "https://raw.githubusercontent.com/stryker-mutator/stryker-js/master/packages/api/schema/stryker-core.json",
  "packageManager": "npm",
  "reporters": ["clear-text", "progress"],
  "testRunner": "node-test",
  "nodeTest": {
    "testFiles": ["src/qa/change-coverage.test.ts"]
  },
  "checkers": ["typescript"],
  "tsconfigFile": "tsconfig.json",
  "mutate": ["src/qa/change-coverage.ts"],
  "thresholds": { "high": 90, "low": 80, "break": 80 },
  "concurrency": 2
}
```

> The config lives in `qa-engine/` but targets `src/qa/change-coverage.ts` by repo-relative path; run it from the repo root. It is separate from the config `mutation-code.ts` generates at runtime, so the two never collide.

- [ ] **Step 4: Add a script and run the gate**

In root `package.json` `scripts`, add:
```
"mutate:keystone": "stryker run qa-engine/stryker.conf.json"
```

Run: `npm run mutate:keystone`
Expected: Stryker mutates `change-coverage.ts`, runs `change-coverage.test.ts` per mutant, and reports a mutation score ≥ 80% (break threshold). If score < 80%, the net has holes — add the missing assertions to `src/qa/change-coverage.test.ts` (do NOT touch `change-coverage.ts`) until survivors are killed, then re-run.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json qa-engine/stryker.conf.json
git commit -m "test(qa-engine): Stryker gate proving the change-coverage net kills mutants"
```

---

## Self-Review

**1. Spec coverage (Plan-1 scope = §7.2 Steps 0–3 + §11 re-verify):**
- Step 0 freeze → Task 2 (openapi drift-guard + freeze note). ✅
- §11 re-verify reality → Task 1. ✅
- Steps 1+3 scaffold + root-gate (glob + project references + test-setup preserved) → Tasks 3, 4. ✅
- Step 1 characterization net (comparator + 10 goldens + parity test, structural equivalence excluding runId/at) → Tasks 5, 6. ✅
- Step 2 Stryker verification (node-test-runner + typescript-checker, scoped to change-coverage, break=80) → Task 7. ✅
- NOT in scope (correctly deferred): kernel/contexts (Plan 2–5), rewritten orchestrator + LegacyPipelineAdapter (Plan 6), cutover + panchito rename (Plan 7).

**2. Placeholder scan:** One deliberate porting step remains in Task 6 Step 3 (`scenarios.ts`) — it is explicitly described as real porting from named `pipeline.test.ts` tests with a concrete acceptance check (Step 4 producing 10 goldens with expected verdicts), not a vague "fill in". All other steps carry full code and exact commands. No "TBD"/"add error handling"/test-less steps.

**3. Type consistency:** `ComparableOutcome`/`runOutcomeEquivalent` (Task 5) are reused verbatim in Task 6's parity test. `RunOutcome` fields (runId, app, sha, mode, target, verdict, errorClass, gateSignals.{static,coverageRatio,valueScore,reviewerCorrections,reviewerApproved,reviewerRationale,flaky,retries}, at) match `src/types.ts`. `CaptureDeps extends PipelineDeps` with `savedOutcomes`, matching the `pipeline.test.ts` stub convention.

**Open follow-ups for later plans (not Plan-1 gaps):** Plan 6 extends `golden-parity.test.ts` to run the rewritten engine against these goldens; Plan 7 handles the `data/panchito.db` → panchito rename (C1).
