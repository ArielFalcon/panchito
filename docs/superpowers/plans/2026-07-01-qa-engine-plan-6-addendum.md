# Plan 6 — HEAD Reconciliation Addendum (2026-07-01)

**Corrects:** `2026-06-24-qa-engine-plan-6-orchestrator.md` and `_verified-state.md`, which drifted
from HEAD after the DOM/selector-grounding work, **feature B** (browser runtime-error → `app_defect`,
adjudicator Rule 2.6), and the Playwright `actionTimeout` landed in `src/`.

**Scope discipline (unchanged, restated):** Plan 6 is a **behavior-identical** port. **GATE A**
(10/10 goldens + full-scenario parity) before any domain code is trusted. *"Do not improve logic
here."* Bugs found are **registered, not fixed in place**; fixes ship as separate declared changes
with their own tests.

## 1. Corrected factual anchors

- `runPipeline`: **`src/pipeline.ts:855`** (was `:828`). File length **3351** lines (was 3179).
- **Scenario counts are all stale and mutually inconsistent** — `_verified-state.md`=188, plan
  header=186, a raw `rg 'test('`≈212. **Do NOT copy any cited number.** Task 0 MUST re-derive the
  count by RUNNING the actual harness (`golden-outcome.harness.ts` replaying `pipeline.test.ts` +
  `pipeline-codex.test.ts`) and record the number it actually replays — never a grep count.
- `qa-run-orchestration/` today = **the ports barrel only** (no `domain/`, `infrastructure/`,
  `composition/`). Slices A/B/C not started. `parity-allowlist.json` + the side-effects probe do
  not yet exist.

## 2. Port-completeness gaps (new pre-flight / dependencies)

All verified at HEAD. Each slots into the existing slice plan.

### G1 (HIGH) — kernel `QaCase` missing `runtimeErrors`
- `src/types.ts` has `QaCase.runtimeErrors` (feature B); `qa-engine/src/shared-kernel/qa-case.ts`
  does NOT (grep: 1 vs 0).
- **Impact:** any characterization scenario exercising Rule 2.6 (runtime-error → `app_defect`)
  cannot reproduce through the port → a **false-green surface INSIDE the safety net**.
- **Action:** widen the kernel `QaCase` VO with `runtimeErrors?: { type: string; text: string }[]`
  as an **explicit dependency of Task D.4** (FixLoop evidence assembly), before D.4 builds.

### G2 (MED) — `catalogGate*` telemetry blind in the comparator
- `catalogGateInWindow` / `catalogGateAdvisory` / `catalogGateFailClosed` set 9× in `pipeline.ts`
  but 0× in `qa-engine/test/characterization/equivalence.ts` (`behavioralProjection`).
- **Impact:** same silent-mismatch class the plan already flags for `preExecAmbiguityCatches` /
  `deterministicSelectorBlocks` / `rulesRetrieved` — a rewrite could drop Pillar-2 catalog-gate
  telemetry undetected.
- **Action:** add the three `catalogGate*` fields to `behavioralProjection` using the existing
  `0`-not-`undefined` normalization pattern (Task D.5/D.7).

### G3 (MED) — `foldRunLearning` is a closure, not an exportable helper
- `pipeline.ts:2126` `const foldRunLearning = async (...) => {...}` — defined INSIDE `runPipeline`
  (captures local scope), called at `:2290` / `:2451` / `:3234`.
- **Impact:** the plan's "re-home `foldRunLearning` → cross-run-learning" assumes a verbatim copy;
  impossible while it closes over `runPipeline` locals.
- **Action:** Task C.2 must first **EXTRACT** it to a top-level function with explicit params
  (behavior-identical), characterize it, THEN re-home. It is a **4th** non-obvious helper alongside
  the 5 module-scope ones (`shouldDistillLearning`, `resolveTestIdAttribute`, `deriveCycleBackstop`,
  `foldValueLearning`, `buildFailureDom`).

### G4 (MED) — specTriage dual-publish decide-path
- `pipeline.ts:3000-3147` — the `specTriage` dual-publish path is a decide branch not in the plan's
  "≥6 verdict branches" catalog for Task D.3.
- **Action:** inventory this branch in Task D.3's `RunDecisionService.decide()` verdict catalog, or
  apps with `qa.specTriage:true` diverge post-cutover.

### W1 (watch, Slice D) — context-mode golden is partly synthesized
- Context mode returns early WITHOUT calling `saveOutcome`, so there is no full `RunOutcome` to
  capture; the harness + the `LegacyPipelineAdapter` both build one via `synthesizeContextOutcome`
  (`legacy-pipeline.adapter.ts`). The parity therefore validates the REAL `verdict` (from
  `runPipeline`) but SYNTHESIZES the non-verdict fields (mode does not produce them) — so the context
  golden is trivially satisfied on those fields.
- **Action (Slice D):** the rewritten context path must reproduce the same early-return + verdict.
  Do NOT rely on the context golden to catch a non-verdict divergence there — assert the early-return
  behavior directly.

## 3. Bug/logic register protocol (Deliverable B)

The explore phase verified the plan but did NOT deep-hunt logic bugs in the 3351-line body. The
register is therefore built **incrementally**: each port slice (C/D) that reads a phase's real logic
closely appends findings to `sdd/plan-6-core-orchestrator/bug-register` (engram) + a `## Bug register`
section in this file. Each entry: `file:line`, why-suspect, severity, and classification —
**behavior-neutral** (may pull-forward as a declared slice) vs **behavior-changing** (separate
declared remediation change, own test, NEVER inside the byte-identical port). The port is the
magnifying glass; fixing during the port defeats parity — register now, fix declared-and-tested later.

## 4. Corrected Task 0 pre-flight checklist (additions)

Before Slice A, Task 0 must additionally assert:

- [ ] Scenario count **re-derived by RUNNING the harness** (not grep); actual replayed count recorded.
- [ ] `runPipeline` line + file length re-grepped and recorded.
- [ ] **G1** — kernel `QaCase` VO widened with `runtimeErrors` (or explicitly scheduled as a D.4 dependency).
- [ ] **G2** — `catalogGate*` fields added to `behavioralProjection`.
- [ ] **G3** — `foldRunLearning` extraction task added to Slice C.
- [ ] **G4** — specTriage branch added to the D.3 verdict catalog.
