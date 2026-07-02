# qa-engine Audit Remediation Implementation Plan (Plan 7-R)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every problem the 2026-07-01 adversarially-verified audit confirmed in the NEW architecture — in-tree qa-engine regressions, port-boundary evidence loss, the unmigrated grounding suite (with the six flaky-selector leaks fixed at port time, never re-inherited), and the surviving prompt/config assets — so the Plan 7 cutover ships an engine that is *better* than legacy, not a faithful copy of its bugs.

**Architecture:** This plan is a companion to `docs/superpowers/plans/2026-07-02-qa-engine-plan-7-cutover.md` (Plan 7). It never duplicates Plan 7 items; it (a) fixes defects already inside qa-engine (Track A — executable now, non-destructive), (b) fixes surviving assets in `agent/`, `config/`, `src/agent-runtime` that outlive the cutover (Track D — executable now), (c) expands Sub-Plan 7.4 into per-module slices with the audit fixes baked in as **declared behavior changes** (Track B), and (d) adds the sub-plans Plan 7 is missing: regen-input threading, evidence/learning integrity, prompts/agent-runtime re-home, and new 7.6 preconditions (Track C).

**Tech Stack:** TypeScript (strict, `tsx`), `node:test` + `node:assert/strict`, Playwright, hexagonal/DDD, parity-pinning per the established `*-parity.test.ts` + `parity-allowlist.json` protocol.

---

## Execution status (2026-07-02, Tracks A + D executed subagent-driven)

- **A1 ✅** 773b10d · **A2 ✅** cbd0f61 + 5baff53 · **A3 ✅** e410366 (qa-engine) + uncommitted legacy hunks in `src/qa/execute.ts`/`execute.test.ts` · **A4 ✅** da2abe5 · **A5 ✅** already satisfied by the parallel session's 3a71f7d (identity tests included; nothing to do) · **A6 ⏸ deferred** by user decision until the Plan 7.3 tree quiets (7.3 landed as 8ebbac5/9ba7359 — A6 is now unblocked, run it next).
- **D1 ✅** dab92a1 + uncommitted lock growth in `prompt-sync.test.ts` · **D2 ✅** uncommitted (NUL removed from the working-tree seed — the hunk collapsed against HEAD, so it is invisible in the diff — + byte-twin guard test in `setup.test.ts`) · **D3+D4 ✅** uncommitted seed/config edits · **D5 ✅** uncommitted `ensurePlaywrightEnvKeys` + seed ownership marker.
- Extra: 233b4ed fixes the typecheck script (stale `.tsbuild` made the gate fail spuriously).
- All uncommitted edits deliberately ride with the user's feature-B WIP (their files carried pre-existing uncommitted work; nothing was mixed into batch commits). Final whole-batch review: READY (typecheck 0, 3386/3386 tests).

## Execution status — Tracks B + C (2026-07-02, second batch)

- **B3 ✅** 84401f9 + 8a76d35 (authenticated capture; pageerror/console + degraded empty/redirected routes; catalog-gate advisory invariant proven end-to-end). Follow-up chip: align DEV_ENV_* guards capture↔runner.
- **B6 ✅** absorbed by the user's session (b772b48 GenerationEnrichment through the port + closure fix). **C1 ✅** a75e8b8 (regen prompts render httpStatus/finalUrl/≤3 runtimeErrors at both render sites).
- **B5 ✅** 8e15004 + 068fd32 + b07942b (idiom-aware canonical selector-check + catalog extractors; pre-exec-grounding.service with per-spec route pairing; wired W1/W2 into RunQaUseCase with real counters; allowlist cb712ccb69d2959b retired; w2-preexec-block dual-engine converges). Note: b07942b physically carries some W3 learning wiring (attribution chip filed). Kernel RunOutcome gained catalogGate* fields (the plan's "already done via G2" claim was wrong — only the comparator had them).
- **C4 ✅** 742354c (prompt contract: test-id-only hint rule ×3 sites + getByText-only failure fallback) + 3b1fa89 (primary default aligned to opencode.json; validateAgentRuntimeConfig enforces reviewer≠primary) + 78f1172 (same hint fix across BOTH role-prompt trees + the pinned playwright-authoring skill pair — 6 md files). Re-homes (prompts.ts / agent-runtime / prompt-sync.test.ts relocation) remain 7.6 preconditions, unstarted.
- **C3 ✅ (by the user's W3)**: f2a288b wires real SQLite-backed learning in rewritten-engine-factory. **C2 → chip** for the W3 workstream (thread adjudication verdict into fold; avoid racing their files).
- **A6 ✅** 591f36e/29fcace/0669032/4ce31db/cd5470e — parity include ≡ exclude (50=50), 4 latent type errors fixed. Found pre-existing timestamp flake in rewritten-orchestrator.adapter.test (chip filed).
- Still user-owned: commit feature-B + service-topology (clean-clone red persists); W4 in-flight WIP transiently breaks combined-tree typecheck — re-run the gate when W4 lands.

## Ground rules (carried from Plans 6/7 — every task must preserve)

- **Strict TDD**: failing test → run → minimal code → run → commit. Full gate after every task: `npm run typecheck` (3 tsconfigs) exit 0 + `npm test` 0 fail.
- **Declared changes, never silent patches**: any behavior divergence from legacy inside a parity-pinned module goes through `parity-allowlist.json` (`{scenarioFingerprint, divergenceDescription, approver}`) or a deliberate golden update — never a quiet edit (Plan 6 addendum scope discipline).
- **Safe-direction invariant**: a grounding gate may only *weaken a proxy* (feed the one-shot repair channel), never turn a valid spec `invalid`. Degraded/unsettled/unknown capture ⇒ advisory, never fail-closed.
- **Strangler rule**: only parity/characterization test files may import `src/`; each such file goes in `qa-engine/tsconfig.json` `"exclude"` AND is typechecked via `qa-engine/tsconfig.parity.json`.
- Run single files from the repo root (path aliases resolve from root tsconfig): `node --import ./test-setup.mjs --import tsx --test <file>`.
- Conventional commits, no AI attribution.

## Sequencing

```
Track A (in-tree qa-engine fixes)  ──┐  independent, start NOW, any order
Track D (surviving assets)         ──┤  independent, start NOW, any order
                                     ├─► Track B (7.4 expansion: grounding port + leak fixes)
Plan 7.2 items 2–5 / 7.3 (theirs)  ──┘        │
                                              ▼
                            Track C (C1–C4 + new 7.6 preconditions) ─► 7.5 shadow proof ─► 7.6
```

Track B slices B0–B2 (pure modules) need nothing from 7.2/7.3 and can also start now; B3+ should follow 7.2 (process-sandbox primitives) and 7.3 (static-signal/contract in kernel).

---

# Track A — In-tree qa-engine defects (fix now)

### Task A1: Re-sync the drifted comment-strip in `selector-check.service.ts`

The test-execution copy predates commits c0ce44e/b3a218c: it joins all lines into ONE string and then applies a blanket `//`-strip, so the `//` inside any URL string (`page.goto("https://…")` — virtually every spec) erases the rest of the spec from extraction. Its parity pin passes 2/2 today only because no fixture contains a URL: **the sync and the discriminating fixture must land in the same commit.**

**Files:**
- Modify: `qa-engine/src/contexts/test-execution/domain/selector-check.service.ts:196-206`
- Test: `qa-engine/test/contexts/test-execution/domain/selector-check-parity.test.ts`

- [ ] **Step 1: Write the failing parity fixture**

```ts
// append to qa-engine/test/contexts/test-execution/domain/selector-check-parity.test.ts
test("PARITY: a URL inside a string is not mistaken for a comment", () => {
  const spec = [
    `import { test, expect } from "@playwright/test";`,
    `test("nav", async ({ page }) => {`,
    `  await page.goto("https://dev.example.com/account/register");`,
    `  await page.getByRole("button", { name: "Save" }).click();`,
    `});`,
  ].join("\n");
  const tree = ['- button "Save"'];
  const svc = new SelectorCheckService();
  assert.deepEqual(svc.check([spec], [tree]), checkSpecSelectors([spec], [tree]));
  assert.deepEqual(svc.unscopedMultiple([spec], [tree]), unscopedMultipleContradictions([spec], [tree]));
});
```

- [ ] **Step 2: Run — verify it FAILS** (the stale copy extracts zero selectors after the URL; legacy sees the button → findings differ)

Run: `node --import tsx --test qa-engine/test/contexts/test-execution/domain/selector-check-parity.test.ts`
Expected: FAIL on `deepEqual` (e.g. `anyVerifiedPresent: false !== true`).

- [ ] **Step 3: Replace `stripCommentsAndJoin` with the legacy string-aware version** (verbatim from `src/qa/selector-check.ts:206-237`)

```ts
function stripTrailingLineComment(line: string): string {
  let quote: string | null = null; // the open quote char, or null when outside any string
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") { i++; continue; } // skip the escaped char inside a string
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === "`") {
      quote = c;
    } else if (c === "/" && line[i + 1] === "/") {
      return `${line.slice(0, i)} `; // real comment start (outside any string) → cut here
    }
  }
  return line;
}

function stripCommentsAndJoin(specSrc: string): string {
  // Block comments FIRST, on the RAW multi-line source (dotall — a /* … */ may span lines, and a `//`
  // inside it must not be mistaken for a line comment). Each block collapses to a single space.
  const noBlocks = specSrc.replace(/\/\*[\s\S]*?\*\//g, " ");
  return noBlocks
    .split("\n")
    .filter((rawLine) => {
      const trimmed = rawLine.trimStart();
      return !(trimmed.startsWith("//") || trimmed.startsWith("*")); // full-line // or block-body *
    })
    .map(stripTrailingLineComment)
    .join(" ");
}
```

- [ ] **Step 4: Run the parity file → PASS. Full gate** (`npm run typecheck` + `npm test`).
- [ ] **Step 5: Commit** — `fix(qa-engine): re-sync test-execution selector-check comment-strip with c0ce44e/b3a218c + URL fixture`

> Note: do NOT import the catalog-gate family into this copy here — module consolidation is Task B0's job. This task only removes the false-green regression.

---

### Task A2: Stop dropping runtime evidence in `E2eExecutionStrategy`

The adapter re-projects each case to `{name, status, detail}` (`e2e-execution.strategy.ts:24-25,62`), discarding `failureDom`, `httpStatus`, `finalUrl`, `runtimeErrors`, `file`, `durationMs`, `flow`, `objective`, `reason` — the exact fields the kernel `QaCase` was widened to carry (addendum G1) and that `fix-loop.aggregate.ts:231/285-287` reads for adjudicator Rules 2.5/2.6 and Lever-2. Constraint (file header `:22-23`): this file must not import from `src/` — the widened shape stays a locally-declared structural type; `ExecutionResult.cases` is already kernel `QaCase[]`, so the typed side needs no change.

**Files:**
- Modify: `qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.strategy.ts`
- Test: `qa-engine/test/contexts/test-execution/infrastructure/e2e-execution.strategy.test.ts`
- Test (new): `qa-engine/test/contexts/qa-run-orchestration/infrastructure/execution-evidence-flow.test.ts`

- [ ] **Step 1: Write the failing strategy test**

```ts
test("evidence fields survive the strategy boundary (G1 kernel widening)", async () => {
  const evidenceCase = {
    name: "checkout shows total", status: "fail" as const, detail: "expect(received).toBe",
    flow: "checkout", objective: "verify totals", reason: "assertion",
    durationMs: 812, failureDom: '- button "Pay"', file: "e2e/checkout.spec.ts",
    httpStatus: 500, finalUrl: "https://dev.example.com/cart",
    runtimeErrors: [{ type: "pageerror", text: "NG0303: unregistered icon" }],
  };
  const strategy = new E2eExecutionStrategy(async () => ({ verdict: "fail", cases: [evidenceCase], logs: "" }));
  const res = await strategy.run({ specDir: "/tmp/x", baseUrl: "http://dev", namespace: "ns" });
  assert.deepEqual(res.cases[0], evidenceCase); // every field, not a 3-field projection
});
```

- [ ] **Step 2: Run — verify it FAILS** (`node --import tsx --test qa-engine/test/contexts/test-execution/infrastructure/e2e-execution.strategy.test.ts`).
- [ ] **Step 3: Widen the local structural types and pass cases through**

```ts
// widen the locally-declared shapes (NO src/ import — mirror kernel QaCase structurally):
type EvidenceCase = {
  name: string; status: string; detail?: string; flow?: string; objective?: string;
  reason?: string; durationMs?: number; failureDom?: string; file?: string;
  httpStatus?: number; finalUrl?: string; runtimeErrors?: { type: string; text: string }[];
};
interface LegacyRunResult { verdict: string; cases: EvidenceCase[]; logs: string; }
```

and in `run()` replace the 3-field re-projection with a status-narrowing pass-through:

```ts
const cases = result.cases.map((c) => ({ ...c, status: c.status as "pass" | "fail" | "flaky" }));
```

- [ ] **Step 4: Write the failing end-to-end evidence test** — `ExecutionPortAdapter` → `E2eExecutionStrategy` with a stubbed `runE2E` emitting `httpStatus: 503` + `runtimeErrors`; assert the cases returned by `ExecutionPort.execute()` still carry both fields (this is what re-arms Rules 2.5/2.6 through the rewritten engine).
- [ ] **Step 5: Run both files → PASS. Full gate.**
- [ ] **Step 6: Commit** — `fix(qa-engine): E2eExecutionStrategy passes runtime evidence through the port (re-arms adjudicator 2.5/2.6, Lever-2)`

---

### Task A3: Thread `testIdAttribute` to the Playwright run (both engines)

The audit's worst leak: everything upstream validates the app's test-id convention (e.g. `data-cy`) and the runner never receives it — `PW_TEST_ID_ATTRIBUTE` is never set for the verdictual run, so every approved `getByTestId` fails at execution on non-default-convention apps. qa-engine has ZERO `testIdAttribute` references on the execution path. The legacy side is a 2-line fix and is **the one legacy exception this plan makes**: legacy is still the live engine, and its runs feed the goldens and the learning ledger that the migration itself depends on — leaving it broken poisons the migration evidence.

**Files:**
- Modify: `qa-engine/src/contexts/test-execution/application/ports/index.ts` (`ExecutionRequest`)
- Modify: `qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.strategy.ts` (`RunE2eFn` opts + forwarding)
- Modify: `qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/execution-port.adapter.ts` (static ctx)
- Modify: `qa-engine/src/contexts/qa-run-orchestration/composition/composition-root.ts` (`CompositionConfig` → strategy wiring)
- Modify (legacy exception): `src/qa/execute.ts:73-87` (`ExecuteOptions`) + `:229-240` (runSuite call)
- Test: `qa-engine/test/contexts/test-execution/infrastructure/e2e-execution.strategy.test.ts`, `src/qa/execute.test.ts`

- [ ] **Step 1: Failing qa-engine test** — strategy forwards the attribute:

```ts
test("testIdAttribute reaches the runner opts", async () => {
  let seen: Record<string, unknown> = {};
  const strategy = new E2eExecutionStrategy(async (_dir, opts) => { seen = opts; return { verdict: "pass", cases: [], logs: "" }; });
  await strategy.run({ specDir: "/tmp/x", baseUrl: "http://dev", namespace: "ns", testIdAttribute: "data-cy" });
  assert.equal(seen.testIdAttribute, "data-cy");
});
```

- [ ] **Step 2: Run — FAIL** (field does not exist on `ExecutionRequest`).
- [ ] **Step 3: Widen the port + strategy**: add `testIdAttribute?: string;` to `ExecutionRequest` (with the comment `// injected as PW_TEST_ID_ATTRIBUTE so playwright.config.ts resolves getByTestId against the app's convention`), add it to `RunE2eFn`'s opts type, and spread it in the strategy's `runE2E` call. Run → PASS.
- [ ] **Step 4: Surface it in the bridge + composition**: add `testIdAttribute?: string` to `ExecutionPortAdapter`'s static per-run context (next to `namespace`/`baseUrl`) and to `CompositionConfig`, defaulting from the app config exactly like legacy `resolveTestIdAttribute` (`config.e2e?.testIdAttribute ?? "data-testid"`). Test: composition-root test asserting the strategy receives it.
- [ ] **Step 5: Failing legacy test** (in `src/qa/execute.test.ts`): stub `deps.runSuite`, capture args, call `runE2E(dir, { baseUrl, namespace, testIdAttribute: "data-cy" }, deps)`, assert `args.testIdAttribute === "data-cy"`. Run → FAIL.
- [ ] **Step 6: Legacy fix**: add `testIdAttribute?: string;` to `ExecuteOptions` and `testIdAttribute: opts.testIdAttribute,` to the `deps.runSuite` call in `runE2E`. (`ExecuteDeps.runSuite` already accepts it and already injects `PW_TEST_ID_ATTRIBUTE` at `:646`; the pipeline already passes it at `pipeline.ts:2513/2835/2955` — this closes the one dropped hop.) Run → PASS.
- [ ] **Step 7: Full gate. Commit** — `fix(qa): thread testIdAttribute to the verdictual Playwright run (execute boundary + qa-engine ExecutionRequest)`

---

### Task A4: Wake the 25-scenario characterization harness in CI

`golden-outcome.harness.ts` (47 assertions incl. the B2 decide-branch scenarios and the dual-engine comparisons — verified ~325 ms, no network) is dormant: the root `npm test` glob only matches `*.test.ts`.

**Files:**
- Rename: `qa-engine/test/characterization/golden-outcome.harness.ts` → `qa-engine/test/characterization/golden-outcome.test.ts`
- Modify: `qa-engine/tsconfig.json` (exclude entry `test/characterization/golden-outcome.harness.ts` → new name)
- Modify: every comment referencing the old filename (grep: `rg -l "golden-outcome.harness" qa-engine src docs` — e.g. `run-decision-parity.test.ts` cites it repeatedly)

- [ ] **Step 1: Verify current dormancy**: `npm test 2>&1 | rg "186-harness"` → no output.
- [ ] **Step 2: `git mv qa-engine/test/characterization/golden-outcome.harness.ts qa-engine/test/characterization/golden-outcome.test.ts`**, update the tsconfig exclude entry and comment references.
- [ ] **Step 3: Run `npm test` → the harness's 47 tests now execute and pass** (`rg "186-harness"` in output shows them). Full gate.
- [ ] **Step 4: Commit** — `test(qa-engine): run the golden-outcome characterization harness under npm test (was dormant)`

> Mark it as **cutover-removal scaffolding**: it imports legacy `runPipeline` via `LegacyPipelineAdapter` and dies at 7.6 — same lifecycle as every `*-parity.test.ts` (already the declared plan).

---

### Task A5: Forward `AbortSignal` through the two real bridges (7.1 residual)

Plan 7.1 threaded the signal to phase boundaries, but `GenerationPortAdapter.generate(_objectives, specDir)` never passes `opts.signal` to `GenerateTestsUseCase` (which supports it) and `ExecutionPortAdapter.execute(specDir)` ignores the port's optional signal — in-flight generation/execution is not interruptible on the rewritten path.

**Files:**
- Modify: `qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/generation-port.adapter.ts:62`
- Modify: `qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/execution-port.adapter.ts:29`
- Test: colocated adapter tests under `qa-engine/test/contexts/qa-run-orchestration/infrastructure/`

- [ ] **Step 1: Failing tests** — each adapter with a stubbed use-case/strategy that records the received signal; call with an `AbortController().signal`; assert identity.
- [ ] **Step 2: Fix**: `generate(objectives, specDir, signal?)` → pass `{ signal }` in `GenerateOpts`; `execute(specDir, signal?)` → include `signal` in the `ExecutionRequest`.
- [ ] **Step 3: Run → PASS. Full gate. Commit** — `fix(qa-engine): forward AbortSignal through generation/execution bridges (Plan 7.1 residual)`

---

### Task A6: Widen the parity type-gate coverage (staged)

`qa-engine/tsconfig.json` excludes ~40 `src/`-importing files; `tsconfig.parity.json` includes only 2 — 38 files are never typechecked anywhere.

- [ ] **Step 1:** List the gap: `jq -r '.exclude[]' qa-engine/tsconfig.json` vs `jq -r '.include[]' qa-engine/tsconfig.parity.json`.
- [ ] **Step 2 (repeat in batches of ~5 files):** add a batch to `tsconfig.parity.json` `include` → `npm run typecheck`. If a file surfaces latent type errors: fix trivial ones inline; register non-trivial ones (engram `sdd/plan-6-core-orchestrator/bug-register`) and keep the file included with a targeted `// @ts-expect-error` + comment only when a registered fix is scheduled. Never silently drop the file back out.
- [ ] **Step 3:** Finish when include-list ≡ exclude-list (every excluded file typechecked by the parity project). Full gate. Commit per batch — `chore(qa-engine): widen parity type-gate coverage (batch N)`

---

# Track D — Surviving assets (fix now; these files outlive 7.6)

### Task D1: Sync `agent/AGENTS.md` (Codex mirror) with the rewritten grounding contract — and lock it

`agent/AGENTS.md:25-27` still orders "Always explore the live DEV page before writing any test" and `:100-103` keeps the old "Mandatory cleanup … A test that dirties DEV without cleaning up is invalid" — both superseded in `agents/AGENTS.md` (`:25-33` TRANSCRIBE contract; `:104-112` cleanup via UI or namespaced-and-left, NEVER a fabricated API call). On any Codex-run generator this resurrects re-navigation waste and fabricated DELETE cleanup (a guaranteed reviewer-rejection round). The drift survived because `prompt-sync.test.ts:101` pins only `["Global rules"]`.

**Files:**
- Modify: `agent/AGENTS.md` (sections at `:25-27` and `:100-103`)
- Modify: `src/agent-runtime/prompt-sync.test.ts:101`
- Run: `node --import tsx --test src/agent-runtime/prompt-sync.test.ts`

- [ ] **Step 1 (TDD on the guard): grow the allowlist first** — `const AGENTS_MUST_MATCH_SECTIONS = ["Global rules", "Execution context", "Protocols"];` (use the exact H2 titles of the two divergent sections as they appear in `agents/AGENTS.md` — verify with `rg "^## " agents/AGENTS.md agent/AGENTS.md`). Run → FAIL (divergence now detected).
- [ ] **Step 2:** Port the two blocks from `agents/AGENTS.md` into `agent/AGENTS.md` verbatim (TRANSCRIBE contract + Protocol 4 rewrite). Run → PASS.
- [ ] **Step 3:** Full gate. Commit — `fix(agent): sync Codex AGENTS.md with TRANSCRIBE grounding + cleanup contract; lock sections in prompt-sync`

> Follow-up registered inside Task C4: `prompt-sync.test.ts` lives in `src/agent-runtime/` — the guard protects two survivor trees and must be re-homed before 7.6 deletes its current location.

### Task D2: Remove the literal NUL byte from the fixtures seed + byte-level twin assertion

`config/e2e/fixtures.ts:307` contains a raw `0x00` inside the dedup key template (`` `${e.type}\x00${text}` `` written as a *literal byte*, making the file read as binary for many tools), and the injected twin in `src/qa/setup.ts` `FAILURE_CAPTURE_BLOCK:135` already uses a space — the twins have drifted.

- [ ] **Step 1 (failing test):** in `src/qa/setup.test.ts`, assert the seed file's capture block is byte-identical to `FAILURE_CAPTURE_BLOCK` (read `config/e2e/fixtures.ts`, slice between the block markers, `assert.equal`). Run → FAIL.
- [ ] **Step 2:** Replace the NUL byte in `config/e2e/fixtures.ts:307` with a space (matching setup.ts). Verify: `python3 -c "print(open('config/e2e/fixtures.ts','rb').read().count(b'\x00'))"` → `0`. Run → PASS.
- [ ] **Step 3:** Full gate. Commit — `fix(config): de-binarize e2e fixtures seed (NUL → space) + byte-level twin guard`

### Task D3: Make the seed run desktop-only (grounding is desktop-only)

`config/e2e/playwright.config.ts:57-62` runs every spec under BOTH `desktop` and `mobile` projects while ALL grounding (DOM capture, selector catalog, prompts) is desktop-only — the mobile pass doubles runtime and manufactures failures against ungrounded viewports.

- [ ] **Step 1:** Remove the `mobile` project from the seed's `projects` array; add the comment `// grounding (DOM capture/selector catalog) is desktop-only today — a mobile project would execute ungrounded`. Register "mobile grounding capture" as future work (engram bug-register), a config knob when it comes, never an app branch.
- [ ] **Step 2:** Full gate (seed has no direct tests; setup.test.ts field checks must stay green). Commit — `fix(config): seed runs desktop-only until grounding captures mobile viewports`

### Task D4: Document `e2e.testIdAttribute` in the example app config

Schema supports it (`src/orchestrator/schemas.ts:109`); `config/apps/example.yaml` never mentions it — onboarding an app with a custom convention (the flagship case) requires reading engine source.

- [ ] **Step 1:** Add to `config/apps/example.yaml` next to the `qa:` block:

```yaml
# e2e:
#   # The app's test-id convention (Playwright getByTestId + DOM capture + selector catalog).
#   # Defaults to "data-testid". jhipster apps typically use "data-cy".
#   testIdAttribute: "data-cy"
```

- [ ] **Step 2:** Full gate. Commit — `docs(config): document e2e.testIdAttribute in example.yaml`

### Task D5: Seed-sync for already-onboarded repos (managed block) — legacy-side, gated

`src/qa/setup.ts:172` bootstraps the seed only when `e2e/` is missing — `actionTimeout` and the `PW_TEST_ID_ATTRIBUTE` resolution never reach repos onboarded before those fixes. Fix pattern exists: the marker-guarded `ensureFailureCapture` (`setup.ts:246-252`).

- [ ] **Step 1 (failing test):** `setup.test.ts` — given an existing `e2e/playwright.config.ts` without the managed keys, setup repairs them via a marker-guarded managed block (env-passthrough only — never overwrite agent-maintained config outside the markers).
- [ ] **Step 2:** Implement `ensurePlaywrightEnvKeys` following the `ensureFailureCapture` pattern. Run → PASS. Full gate.
- [ ] **Step 3:** Commit — `fix(qa): sync managed playwright.config env keys into already-onboarded repos`

> **Sequencing rule (same as D3):** this changes `src/qa/setup.ts` behavior that 7.4/7.6 will port — land it BEFORE the corresponding port slice so parity pins the fixed behavior (Plan 7.4:122's own instruction).

---

# Track B — Sub-Plan 7.4 expanded: grounding migration with the leak fixes baked in

**Rule for every B slice:** port the CURRENT `src/qa` behavior parity-pinned FIRST (verbatim step), then apply the declared fix as a SEPARATE commit in the same slice with its own tests and (where goldens shift) a parity-allowlist entry. Never fold a fix into the verbatim-port commit. Every parity test importing `src/` → tsconfig exclude + parity include (Task A6 keeps them typechecked).

### B0: One canonical selector-check domain module

Today there are TWO partial qa-engine copies (`test-execution/domain/selector-check.service.ts` — drifted pre-A1, no catalog family; `qa-run-orchestration/domain/helpers/selector-check.ts` — no catalog family, no `unscopedMultipleContradictions`). Any fix landing in one copy re-diverges.

- [ ] Port the FULL current `src/qa/selector-check.ts` surface (607 LOC, zero imports — pure) into `qa-engine/src/contexts/qa-run-orchestration/domain/helpers/selector-check.ts`, adding the missing exports: `unscopedMultipleContradictions`, `extractCatalogSelectors`, `confidentWindowEnd`, `extractTestIdSelectorsWithIndex`, `firstGotoRoute`, `CatalogSelectors`, plus the existing surface. Parity test: one fixture table driving `assert.deepEqual(engine.fn(x), legacy.fn(x))` for every exported function (extend `selector-check-parity.test.ts`; keep the URL-in-string + block-comment fixtures).
- [ ] Re-point `test-execution`'s `SelectorCheckService` at a re-export of the canonical helpers (context-boundary rule: `test-execution` may not import `qa-run-orchestration` domain — if dependency-cruiser rejects the re-export, keep the copy but add a **byte-parity test** between the two files so drift is structurally impossible: `assert.equal(read(copyA), read(copyB))` modulo header).
- [ ] Commit(s) — `feat(qa-engine): canonical selector-check domain module (full current legacy surface)` / `test(qa-engine): byte-parity guard between selector-check copies`

### B1: Port `route-catalog` + `catalog-gate` (pure, verbatim)

- [ ] `src/qa/route-catalog.ts` (74 LOC) → `qa-engine/src/contexts/qa-run-orchestration/domain/route-catalog.ts`; `src/qa/catalog-gate.ts` (49 LOC) → `.../domain/catalog-gate.ts` (imports `confidentWindowEnd`/`extractTestIdSelectorsWithIndex` from B0's canonical module and `RouteCatalog` locally). Port their test files (129 LOC combined) + add a parity test against the legacy originals.
- [ ] Commit — `feat(qa-engine): port route-catalog + catalog-gate (Pillar 2, parity-pinned)`

### B2: Port `changed-elements` + declared fix: configured test-id family

- [ ] Verbatim port `src/qa/changed-elements.ts` (341 LOC, pure except `parseDiffHunks` — port that helper or re-home per 7.3's change-analysis layout) into `qa-engine/src/contexts/change-analysis/domain/changed-elements.ts` + tests + parity pin.
- [ ] **Declared fix (audit):** `extractChangedElements` hardcodes the test-id attribute family (`data-cy|data-testid|data-test`); parameterize it on the configured `testIdAttribute` (defaulting to the current family for compatibility) so custom conventions get `[CHANGED]` test-id markers. Failing test: a diff adding `<button data-qa="save">` with `testIdAttribute: "data-qa"` yields a ChangedElement with `testId: "save"`. Separate commit.
- [ ] Commits — `feat(qa-engine): port changed-elements (parity-pinned)` / `fix(qa-engine): changed-elements honors the configured testIdAttribute family`

### B3: Port `dom-snapshot` + THREE declared capture fixes (audit leaks 4 & 5)

Split: pure parsers (`parseAriaSnapshot`, `parseAriaSnapshotWithState`, `mergeAttrs`, `capDomLines`, `formatDomSnapshot`, `buildChangedMarker`, `normalizeRoutes`, `extractTargetRoutes`) → domain; the child-process Playwright renderer (`defaultCaptureDomDeps`) → `qa-engine/src/contexts/generation/infrastructure/dom-capture.adapter.ts` (built on 7.2's process-sandbox primitives; preserve env-var passing — routes/baseUrl are untrusted, never source-interpolated).

- [ ] Verbatim port + parity pins (fixture tables over the pure functions; the adapter gets a behavioral test with a stubbed child).
- [ ] **Declared fix 1 — authenticated capture (leak 4):** the child launches a bare `newContext()`; the `DEV_*` env vars are already passed (`scrubEnv(/^DEV_/)`) but never consumed, so auth-gated routes ground on the login page and the catalog gate emits FALSE "fabricated test-id" corrections. Mirror `config/e2e/playwright.config.ts:42-46` in the child:

```ts
const user = process.env.DEV_ENV_USER; const pass = process.env.DEV_ENV_PASS;
const context = await browser.newContext(
  user && pass ? { httpCredentials: { username: user, password: pass } } : {},
);
```

  Failing test first: stub child env → capture with credentials present asserts `httpCredentials` reaches `newContext` (inject a context factory in the adapter port for testability).
- [ ] **Declared fix 2 — broken-render detection (leak 5):** register `page.on("pageerror")` + `page.on("console", msg => msg.type() === "error" …)` in the child; add `runtimeErrors?: { type: string; text: string }[]` to `RouteSnapshot`; a route with `nodes.length === 0` OR captured `pageerror` ⇒ `status: "degraded"` in `buildRouteCatalog` (safe direction: degraded ⇒ catalog gate goes ADVISORY, never fail-closed) and `formatDomSnapshot` renders `(route rendered empty — possibly broken; verify live)` instead of a bare header. Reuse the Feature-B signature set (`pageerror` any, `NG\d+`, `ERROR Error:`, `Uncaught`, `Unhandled Promise rejection` — NO bare `Error:`, same false-positive rationale as adjudicator Rule 2.6).
- [ ] **Declared fix 3 — redirected capture is degraded:** record the child's `page.url()` after settle; origin/path mismatch vs the requested route ⇒ `degraded` (catches login redirects that fix 1's basic-auth doesn't cover).
- [ ] Commits — `feat(qa-engine): port dom-snapshot (parity-pinned)` / `fix(qa-engine): authenticated DOM capture (DEV_ENV_* httpCredentials)` / `fix(qa-engine): capture pageerror/console + degrade empty or redirected routes`

### B4: Port `context-pack` (application assembler, generation context)

- [ ] `src/qa/context-pack.ts` (311 LOC; `ContextPackDeps` is already port-shaped) → `qa-engine/src/contexts/generation/application/context-pack.ts`, consuming B3's capture port + the kernel sanitizer home (7.2 item 4 / 7.3). Tests ported; parity pin on `buildContextPack` output for fixed inputs.
- [ ] Commit — `feat(qa-engine): port context-pack assembler (parity-pinned)`

### B5: Pre-exec grounding gate as a domain service — wired into `RunQaUseCase` (fixes leaks 3, 6 + claims allowlist gap)

This is the slice that closes parity-allowlist entry `cb712ccb69d2959b` ("RunQaUseCase has no pre-exec ambiguity gate — Slice E port-gap") AND fixes the two false-block leaks, as declared changes:

- [ ] **Verbatim step:** extract legacy's closure logic (`capturePreExecSnaps` `pipeline.ts:1943-1952`, `ambiguityContradictionsFrom` `:1960-1963`, `ambiguousSelectorsNow` `:1968-1971`, `catalogCorrectionsFrom` `:1981-2007`, W1 one-shot repair `:2166-2188`, W2 deterministic block `:2288-2299`) into `qa-engine/src/contexts/qa-run-orchestration/domain/pre-exec-grounding.service.ts` composing B0/B1/B3 modules. Emit the full telemetry: `preExecAmbiguityCatches`, `deterministicSelectorBlocks`, `catalogGateInWindow/Advisory/FailClosed` — **kernel change:** add the three `catalogGate*` optional numbers to `RunOutcome.gateSignals` (`run-outcome.ts:26-42`; legacy `src/types.ts:267-269` already has them; the comparator's `behavioralProjection` already expects them — addendum G2 done).
- [ ] **Declared fix — per-spec route pairing (leak 6b):** the ambiguity check must stop cross-producting ALL specs × ALL captured trees. Pair each spec to its own route trees using `firstGotoRoute`/`extractTargetRoutes` (exactly the pairing `catalogCorrectionsFrom` already does via `catalogByRoute`): a selector is MULTIPLE only within a tree of a route that spec itself targets. Failing test: spec A (route `/list`, 5 "Edit" buttons) + spec B (route `/detail`, 1 "Edit" button) ⇒ zero contradictions for spec B. Safe direction: pairing only NARROWS blocking.
- [ ] **Declared fix — idiom-aware extraction (leak 6a):** in the canonical selector-check, selectors followed by `.first(`/`.nth(`/`.filter(` or preceded by an extractable scope chain are INDETERMINATE for the MULTIPLE check (suppressed, like non-extractable locators already are), and the `unscopedMultipleContradictions` fast path must apply page-rooted suppression even when the spec set contains no non-extractable locator. Failing tests: `page.getByRole("row").first().click()` against a 3-row tree ⇒ no contradiction; `page.getByRole("table").getByRole("row", { name: "x" })` ⇒ no contradiction.
- [ ] **Wiring + leak 3:** replace the hardcoded zeros in `run-qa.use-case.ts` (`:526-527, :584-585, :611-612, :625, :713-714`) with the service's real counters, and invoke the gate **after every spec-producing pass** — initial generation, static-fix repair rounds, FixLoop regens, coverage regen — feeding corrections into the regen channel (Task C1's input shape). W2's deterministic block stays ambiguity-only (catalog corrections NEVER block — the established safe-direction split).
- [ ] **Bookkeeping:** retire allowlist entry `cb712ccb69d2959b`; update the `w2-preexec-block` scenario's expected values (its golden was captured against the unwired use-case); goldens re-captured via `capture-goldens-b2.ts` and the diff reviewed, not hand-edited.
- [ ] Commits — `feat(qa-engine): pre-exec grounding gate service (W1/W2 + catalog gate, telemetry)` / `fix(qa-engine): pair ambiguity checks to each spec's own routes` / `fix(qa-engine): idiom-aware MULTIPLE suppression (.first/.nth/.filter, role chaining)` / `feat(qa-engine): gate every spec-producing pass in RunQaUseCase`

### B6: Regen-input threading through the generation port (leak 2)

Legacy's corrective regen misroutes because `isReGen` (`pipeline.ts:364`, dup at `:396`) omits `selectorContradictions`, and the fan-out path can't render corrections at all. In qa-engine the equivalent defect is structural: every `generation.generate([], specDir, signal)` call is shape-identical — `GenerationPortAdapter` builds `OpencodeRunInput` with NO `fixCases/reviewCorrections/selectorContradictions/coverageGap`, so through the real bridge every regen renders as a first-pass prompt and the FixLoop's Lever-2 is behaviorally inert.

- [ ] **Port change:** widen `GenerationPort.generate` to accept a regen context object: `generate(objectives, specDir, opts?: { signal?: AbortSignal; fixCases?: FixCase[]; reviewCorrections?: string[]; selectorContradictions?: string[]; coverageGap?: CoverageGap })` (types re-homed from the canonical `generation-ports.ts`).
- [ ] **Bridge:** `GenerationPortAdapter` maps every field onto `OpencodeRunInput`; add `selectorContradictions?: string[]` to the canonical `ParallelWorkerInput` (`generation-ports.ts:200-218`) — the legacy duplicate at `opencode-client.ts:1153-1171` stays in sync until 7.6 (or is re-pointed at the canonical import like `prompts.ts:22` already does).
- [ ] **Shared predicate:** export `isReGenInput(input): boolean` from the canonical ports module testing ALL four channels (fixes the legacy omission by construction — one definition, no duplicated sites); `RunQaUseCase`/dispatch uses it to route corrective regens single-agent.
- [ ] **Failing test:** FixLoop round with `selectorContradictions` present ⇒ the stub generation port receives them AND `isReGenInput` is true (renders as regen, not first-pass).
- [ ] Commits — `feat(qa-engine): regen inputs flow through GenerationPort (fixCases/review/selector/coverage)` / `fix(qa-engine): single isReGen predicate includes selectorContradictions`

**Track B acceptance gate (extends 7.4's):** every grounding module has a qa-engine home + parity pin; the six audit leaks each have a red-first regression test IN qa-engine; gate telemetry flows into `RunOutcome.gateSignals`; allowlist entry 1 retired; `npm run typecheck` + `npm test` green.

---

# Track C — Evidence & learning integrity + the missing sub-plans (new 7.6 preconditions)

### C1: Regen prompts receive the runtime evidence the system already captures

Legacy's fix-loop regen prompt shows only failure text — `runtimeErrors`, `httpStatus`, `finalUrl` never reach it (`prompts.ts:667` area). With A2 the evidence now crosses the port; this task renders it: extend the fixCases rendering (wherever prompt assembly lands per C4) so each failing case shows `httpStatus`, `finalUrl` and up to 3 `runtimeErrors` lines, sanitized. Failing test: a `FixCase` with `runtimeErrors` renders them in the regen prompt section. **Depends on:** A2, C4 (prompt home). Commit — `feat(qa-engine): regen prompts carry runtime evidence (httpStatus/finalUrl/runtimeErrors)`

### C2: Learning must see the adjudication verdict (stop poisoning the ledger)

Audit: a run whose failure adjudicates `app_defect` (the test CORRECTLY caught a broken app) still folds as a plain failure — reflection distills a bogus "preventive rule" against the very test that worked, and prevention demotes healthy rules. Fix at the contract level NOW (the learning adapter is still a stub — cheap today, expensive later):

- [ ] Kernel: add `adjudication?: { class: string; confidence: string; action: string }` to `RunOutcome` (optional — goldens unaffected; legacy never emits it).
- [ ] `RunQaUseCase`: populate it from the FixLoop's `AdjudicatorVerdict`.
- [ ] `LearningPort.fold` contract (doc + stub behavior + test): `class === "app_defect"` ⇒ no reflection/distillation, prevention signal `null` (mirrors the existing `shouldDistillLearning` code+fail suppression).
- [ ] Commit — `feat(qa-engine): RunOutcome carries the adjudication verdict; learning fold skips app_defect distillation`

### C3: NEW Sub-Plan 7.7 — port the cross-run learning engine (7.6 precondition)

Plan 7 has NO learning sub-plan; 7.6 deletes `src/` — executing it today kills the flywheel (`src/qa/learning/*`, retrieval, promotion/decay, reflection) with only a `StubLearningRepository` behind the port. **This plan does not detail 7.7's tasks** (own plan when it becomes the next slice, per the roadmap convention); it fixes 7.7's scope and gate:

- Scope: port labeler/reflector/distiller/curriculum/retrieval + the promotion/decay governance behind `LearningPort`, including the Phase-1 hardening already implemented on `claude/reexplore-re3-gate` (do not re-derive it — merge/port that work), with C2's `app_defect` suppression.
- **Gate added to 7.6's preconditions:** 7.6 MUST NOT run while `LearningPort` is stub-backed, OR the user explicitly accepts losing cross-run learning at cutover (recorded decision).

### C4: NEW Sub-Plan 7.2bis — re-home the injected-but-unscheduled collaborators (7.6 precondition)

Grep-proof gap: `prompts.ts` and `src/agent-runtime/*` are consumed via INJECTION (wrapped by `prompt-rendering.adapter.ts`, `config.adapter.ts`, `opencode-runtime.strategy.ts` — "delegates, does NOT reimplement"), so 7.3's import-grep never sees them, no 7.2 item ports them, and 7.6's `buildProduction` needs them injected — **deleting `src/` without re-homing them breaks composition.** Same class: `src/qa/execute.ts` (the Playwright runner leaf `runE2E`/`runCleanup` behind `RunE2eFn`), `src/qa/setup.ts` (seed bootstrap behind `WorkspacePort`), `src/qa/publish.ts`, `src/integrations/opencode-client.ts`, `src/orchestrator/sanitizer.ts` (partially: 7.2 item 4).

- [ ] **Inventory task (do first, cheap):** enumerate every collaborator `CompositionConfig`/`shadow-run.operator.ts` injects from `src/`, with its target home (qa-engine infra adapter vs surviving `src/server`-style module) — recorded as a table in the Plan 7 doc. The only real mapping to crib from is `buildCompositionConfig` (`shadow-run.operator.ts:183-313`).
- [ ] Re-home `src/integrations/prompts.ts` builders into `qa-engine/src/contexts/generation/infrastructure/prompt-builders/` — and land the two audit prompt fixes with it as declared changes (red-first):
  - `:558` — the selector-priority rule fires `getByTestId` on ANY `-> [attr]` hint, but `buildAttrHint` also emits `id=`/`name=`/`href`/`type=` hints. Fix: rule (1) applies only when the hint is a test-id hint.
  - `:612-615` — the GROUND-TRUTH-AT-FAILURE escape licenses "a scoped CSS/**data-testid** locator" for unquotable selectors — a fabrication license contradicting Pillar 3. Fix: the only permitted fallback is `getByText` quoted from the failure tree.
- [ ] Re-home `src/agent-runtime` (or explicitly declare it a survivor outside the deletion set — decision recorded in Plan 7.6's file list) — and land the two audit config fixes:
  - `config.ts:27` split-brain: `DEFAULT_MODELS.opencode.primary` says `kimi-k2.7-code` while `agents/opencode.json:21` runs `deepseek-v4-pro` for qa-generator. Fix: align + add the primary-model equality guard mirroring the existing reviewer guard in `model-config.test.ts`.
  - `config.ts:91` `validateAgentRuntimeConfig` never enforces `reviewer.model !== primary.model` (the independence invariant is unit-test-only). Fix: enforce in both modes at runtime; failing test first.
  - Re-home `prompt-sync.test.ts` (guards `agent/` + `agents/`, both survivors — D1's lock must not die with `src/agent-runtime`).
- [ ] **Gate added to 7.6's preconditions:** zero injected collaborators sourced from files in the deletion set.

### C5: Register the two remaining rewritten-path capability gaps as explicit 7.5/7.6 decisions

Not fixed here — surfaced so the cutover decision is honest (each needs either a port or a recorded acceptance):

1. **parallelDiff fan-out:** the rewritten path is single-agent only (`GenerationPortAdapter.generate(_objectives, …)` ignores objectives; `ChangeAnalysisPort.analyze` never called). Multi-objective diffs will behaviorally diverge in the 7.5 shadow proof — either port objective planning/fan-out pre-7.5 or declare single-agent-at-cutover and pick shadow SHAs accordingly.
2. **ObserverPort:** no adapter exists and it is absent from `RunQaUseCaseDeps` — the rewritten path drops all step/case telemetry (TUI/SSE dark). Needs an adapter before the default flips, or a recorded acceptance for the soak window.

---

## What this plan deliberately does NOT include (and why)

- **Cross-repo resolver activation** (service-topology producer + `CROSS-REPO LINKS` prompt rendering + real `MirrorRegistryPort`): NEW behavior legacy never had — post-cutover feature work, must not ride a behavior-identical migration (its own plan, after 7.6).
- **Legacy-only pipeline bugs beyond the six leaks** (e.g. the `ccForPersistence` stale binding — already a PERMANENT declared divergence in the allowlist; the fixed behavior is the rewritten side's).
- **Plan 7 items already scheduled** (7.2 items 2–5, 7.3, 7.5, 7.6 entrypoint wiring) — referenced, never duplicated.
- **codebase-memory-mcp integration**: orthogonal to this remediation (it improves cross-repo blast radius, not selector grounding); its CodeGraphPort work proceeds on its own doc.

## Self-Review

1. **Audit coverage:** all 6 flaky-selector leaks land red-first in qa-engine (A3=leak 1, B6=leak 2, B5=leaks 3+6, B3=leaks 4+5); in-tree regressions A1/A2/A4/A5/A6; ledger poisoning C2; regen evidence C1; prompt contradictions D1+C4; config/seed D2–D5; split-brain + independence C4; learning port C3; dormant harness A4. Findings deliberately excluded are listed with reasons above. ✓
2. **No placeholders:** every now-executable task (A, D) carries code/commands; B/C slices follow Plan 7's accepted roadmap convention with concrete files, fix specs, and red-first test definitions — the two conventions this repo already executes. ✓
3. **Type consistency:** `ExecutionRequest.testIdAttribute` (A3) matches the strategy forwarding and composition wiring; `RouteSnapshot.runtimeErrors` (B3) feeds `buildRouteCatalog` degradation (B1's ported type); `RunOutcome.gateSignals.catalogGate*` (B5) matches `src/types.ts:267-269` and the comparator's existing projection; `isReGenInput` (B6) is the single shared predicate. ✓
4. **Plan 7 fit:** A/D touch nothing 7.2–7.6 owns; B expands 7.4 exactly where 7.4:116-122 asked; C adds 7.2bis/7.7 and three new 7.6 preconditions (C3 gate, C4 gate, C5 decisions). ✓
