# E2E Remediation Plan — panchito (panchito)

> **Status:** Phase 0 (diagnosis + validation) COMPLETE. Keystone validated with real production data. Implementation of Phase 1 NOT yet started (one safe win applied).
> **Last updated:** 2026-06-22
> **Worktree:** `.claude/worktrees/e2e-remediation` on branch `worktree-e2e-remediation`, based on `main` @ `9e99501`.
> **Engram topic keys:** `architecture/e2e-root-cause-decoupled-oracle`, `architecture/e2e-definitive-plan`, `architecture/e2e-keystone-validation` (project `panchito`).

---

## ⏯️ RESUME HERE (read this first)

A fresh session can resume exactly by reading this section + the engram observations above.

**What this is:** a root-cause remediation of why panchito's generated E2E tests fail at execution on every real run (validated on `petclinic`). The diagnosis is finished and the keystone fix is validated with real data. The next action is to implement Phase 1.

**Immediate next action:** Implement **Phase 1.1 (bounded agent self-execution loop)** + its **data-isolation corollary**, with TDD, in the worktree. See [§ Phase 1](#phase-1--correctness-the-roi-core) and [§ Next steps](#-next-steps-exact).

**Environment state (verified 2026-06-22):**
- Docker is UP. Containers running: `panchito-orchestrator-1` (healthy), `panchito-agents-1` (healthy), full `spring-petclinic-*` microservice stack.
- **The real run history is in the Docker volume `panchito_qa-data`**, NOT in the repo. Re-access it with:
  ```bash
  mkdir -p /tmp/realqa && docker cp panchito-orchestrator-1:/app/data/panchito.db /tmp/realqa/
  docker cp panchito-orchestrator-1:/app/data/panchito.db-wal /tmp/realqa/ 2>/dev/null || true
  sqlite3 /tmp/realqa/panchito.db "SELECT app,target,mode,verdict,COUNT(*) FROM run_outcomes GROUP BY 1,2,3,4;"
  ```
  ⚠️ The repo-local `data/panchito.db` is POLLUTED with test fixtures (apps `tel-*`, sha `abc1234`) — DO NOT use it for analysis. Real data = Docker volume only.
- Green gate: `npm test` (900+ tests, tsx) + `npm run typecheck`. Both MUST stay green. Typecheck was green at baseline this session.
- `node_modules` in the worktree is a symlink to the parent checkout's `node_modules`.

**Open decision for the user:** whether to expand Phase 1 scope to include the data-isolation corollary now (recommended — see [§ Phase 1](#phase-1--correctness-the-roi-core)). The user chose "validate keystone first" and that is done.

---

## 1. The problem

panchito is an app-agnostic AI E2E test generator: an LLM agent writes Playwright specs into a watched repo's `e2e/`; the deterministic orchestrator (`src/`) runs them against a live DEV site and opens a PR (green) or Issue (red). The user has iterated for weeks on `petclinic` (a Spring microservices app); every run produces failing/useless tests after a long (~30 min) expensive cycle. Each "fix" patches a symptom and a new symptom appears elsewhere.

This is the systematic-debugging signature of **wrong architecture, not wrong fix** (3+ fixes, each revealing a new problem elsewhere).

## 2. Root cause (refined + validated)

**Original framing (overstated):** "the authoring agent is decoupled from the only oracle of E2E correctness — execution against the live DOM."

**Refined framing (after Judgment Day + real-data validation):** the agent is NOT blind to the DOM — the single-agent `qa-generator` has the Playwright MCP and a pre-exec strict-mode check (`ambiguousSelectorsNow`) already exists. The precise gap is that **the agent never EXECUTES the assembled spec**, so it cannot observe failures that only appear at runtime: assertion correctness, multi-step flow breakage, post-action DOM changes, and — the dominant one on petclinic — **runtime-state-dependent selector cardinality**.

### The validated mechanism (real data — see [§ Validation](#3-validation-real-data))

A selector is unique in the pre-write snapshot (so the static pre-exec check passes, `preExecAmbiguityCatches=0`), but at EXECUTION time — after the test CREATES data and/or against data ACCUMULATED from prior runs (PetClinic has **no delete UI**, so cleanup is "namespaced-and-left") — the same `getByRole` matches 2–3 elements → strict-mode violation. This is invisible to static DOM snapshots AND to `ambiguousSelectorsNow` (both operate on pre-write state). **Only executing the assembled test surfaces it.**

➡️ Therefore Phase-1.1 (execution feedback) is NOT a duplicate of the pre-exec check (it catches a class the check is architecturally blind to).

### Bonus killer insight — the retry loop self-sabotages create-flows

PetClinic has no delete UI, so the orchestrator fix-loop **retry re-creates the namespaced entity each attempt** (prior attempt's data persists) → cardinality GROWS each attempt → strict-mode guaranteed on the retry. This explains both the 30-min retry being counterproductive AND "every run a different problem."

## 3. Validation (real data)

Source: real `run_outcomes` + `runs.logs` from the Docker `qa-data` volume, 2026-06-08..21.

- **petclinic e2e: 0 pass.** 17 fail, 3 invalid (E-STATIC), 2 infra-error, 1 skip.
- **error_class dominant: `E-EXEC-FAIL` = 18** (passed static gate, executed vs DEV, failed).
- Failure-signature counts across petclinic fail/invalid logs (~230 KB): `strict mode violation` ×9, `resolved to N elements` ×5, Timeout/Test-timeout ×16, `expect(`/`toBeVisible` ×26/×22 (some vacuous assertions).
- The strict-mode violations are on **namespaced, test-created entities**:
  ```
  getByRole('link', { name: 'qa-bot-<sha>-<ns>-QA Verify' }) resolved to 2 elements
  getByRole('link', { name: 'Add Visit' })                  resolved to 3 elements
  getByRole('cell', { name: 'radiology' })                  resolved to 2 elements
  ```
- On real fails: `preExecAmbiguityCatches=0`, `deterministicSelectorBlocks=0` (the pre-exec check found nothing). The agent DID use the Playwright MCP (one run had 11 `.playwright-mcp/page-*.yml` snapshots). The reviewer praised the design ("full owner→pet→visit chain, explicit assertions, false-positive risk low") yet `reviewerApproved=false` + E-EXEC-FAIL.
- Phase timings (one run): explorer 176s, pack 3s, generator 643s (~11 min), reviewer 34s, validate 5s, execute 291s.

## 4. Judgment Day results (Round 1 — applied to the plan)

Two blind opus judges reviewed the plan. Verdict on the original plan: **ESCALATED** (confirmed CRITICAL). Confirmed corrections folded into this plan:

| Finding | Resolution |
|---|---|
| **1.4 `retries:0` on the classification execute** destroys the `flaky` verdict + quarantine (`retries:2` is the flakiness SIGNAL — `config/e2e/playwright.config.ts:21`; `types.ts` `RunVerdict`). | **DISCARDED.** Never touch retries on the classification execute. If cutting cost, only the fix-loop re-execute. |
| **1.4 removing the filtered-retry guard** corrupts coverage measurement (`pipeline.ts` `coverageWillMeasure`, true for any non-off mode). | **DISCARDED.** |
| **Root cause overstated** — DOM access already exists (Playwright MCP + `ambiguousSelectorsNow`). | **REFRAMED** (see §2) — and the real-data validation REFINES it: the gap is runtime-cardinality the pre-exec check is blind to. |
| **3.1** adjudicator is pure/no-I/O; `QaCase` lacks runtime-evidence fields; widening `app_defect` fights the asymmetric-safety rule. | **SPLIT**: capture-layer first, then adjudicate; do NOT blindly widen `app_defect`. |
| **1.1** needs a DEV-health probe (apps without `versionUrl` skip the gate) + the `timeout` binary is missing in the agents image. | **FOLDED into 1.1.** |
| **Codex mirror drift** real, cheapest highest-ROI. | **APPLIED this session** (safe win — see §6). |
| **1.2** too broad — kill only the browserless OVERFLOW fallback, keep grounded fan-out. | **NARROWED.** |
| **2.3** "never reaches planner" overstated (raw diff reaches it) — it's a low-cost parity add to BOTH diff+manual planner prompts. | **DEMOTED to parity.** |
| Suspect (Judge A only): `qa-worker.md` Playwright-MCP line is a dead conditional. | **NOT auto-applied** (suspect). Flagged for the user. |

## 5. The definitive plan (forced order)

**Sequencing principle (endorsed by both judges):** correctness is the precondition for value. Applying Phase-2 fail-closed gates before Phase 1 would convert "garbage published" into "nothing published."

### Phase 1 — Correctness (the ROI core)
- **1.1 [KEYSTONE — VALIDATED]** Give the generator a bounded self-execution step: during its own session, run its single spec against DEV (`--workers=1 --retries=0`, hard per-action timeout, wrapped in `timeout 90s`), read the failure, fix, repeat until green or budget exhausted, THEN emit the verdict. De-risk: gate on a DEV-health probe at session start (skip, don't fail, when DEV unverifiable); ship `coreutils`/`timeout` in the agents image (or use Playwright's `globalTimeout`). Respects the security boundary (running a local test is not a git write) and the sequential-DEV invariant (one spec at a time).
    - **Data-isolation corollary (NEW, from validation):** each execution attempt must use a FRESH namespace (no cross-attempt data reuse) so a retry/re-run never inflates selector cardinality on create-flows; and selectors on created entities must always scope (row/section) or `.first()`. Without this, retries keep adding duplicates → guaranteed strict-mode.
- **1.2** Keep E2E generation single-agent; remove ONLY the browserless OVERFLOW worker fallback (`opencode-client.ts` ~`1351-1358` "blind workers WITHOUT DOM"); keep grounded fan-out for complete/exhaustive.
- **1.3** One source of truth for role contracts; remove the dead conditional Playwright-MCP branch in `agents/agent/qa-worker.md:19` (SUSPECT — confirm with user first). Codex mirror sync already applied (§6).
- ~~1.4~~ **DISCARDED** (regression — see §4).

### Phase 2 — Value (ONLY after Phase 1)
- **2.1** Production policy `shadow | signal | strict` (default `signal`).
- **2.2** In `strict`, binding gates: diff → change-coverage `enforce` (needs working source maps; petclinic's Java backend lines stay `unknown`); manual → a lightweight objective-evidence check. NOT a large new QualityContract framework.
- **2.3** Wire the already-computed static-signal section into BOTH the diff and manual planner prompts (`prompts.ts` `buildPlanPromptAssembled`, ~line 178 — currently has no static-signal section). Low-cost parity.

### Phase 3 — Classification
- **3.1** First plumb runtime evidence (finalUrl, console/network errors, status, screenshot) onto `QaCase` via the execute boundary; THEN refine the adjudicator (`failure-adjudicator.ts`). Do NOT blindly widen `app_defect` (Rule 3 at ~`:132`; respect the asymmetric `break-needs-human` rule at ~`:161`).

## 6. Execution state (this session)

- ✅ Worktree `worktree-e2e-remediation` created; the native `EnterWorktree` branched from a stale origin default (`632bf46`), so it was **reset to local `main` @ `9e99501`** (the current state with the static-signal layer). `node_modules` symlinked from the parent. Typecheck baseline GREEN.
- ✅ **Codex mirror sync applied** (the only code change so far): `agent/skills/playwright-authoring/locators-and-waiting.md` received the `## ⚠ CRITICAL: getByRole matches the ACCESSIBILITY TREE, not the HTML tag` section, copied verbatim from the OpenCode mirror `agents/skill/playwright-authoring/locators-and-waiting.md:12-29`. This was the confirmed-by-both-judges, zero-risk, highest-ROI win.
- ⏳ Phase 1.1 + corollary: NOT started.
- ⏳ Phases 1.2, 1.3, 2.x, 3.1: NOT started.

## 7. Key code references (verified at `9e99501`)

| Concern | Location |
|---|---|
| Orchestration entry / run flow | `src/pipeline.ts` `runPipeline` (~821) |
| Exec-fix retry loop | `src/pipeline.ts` ~2189 (`for retry`), regen call ~2345 |
| `MAX_RETRIES` default 2 | `src/pipeline.ts` ~2150 (`app.qa.fixLoop?.maxRetries ?? 2`) |
| Filter C (execute) | `src/pipeline.ts` ~2132-2136 |
| Publish only on green | `src/pipeline.ts` ~2689 |
| Static-signal awaited pre-generate | `src/pipeline.ts` 1799 (before generate at 1809) |
| W1 pre-exec selector check | `src/pipeline.ts` ~1815 (`ambiguousSelectorsNow`) |
| Filter B (static only) | `src/qa/validate.ts` (tsc/eslint/`--list`/manifest, no DEV call) |
| Selector check core / non-extractable | `src/qa/selector-check.ts` `checkSpecSelectors` (324), `NON_EXTRACTABLE_LOCATOR_RE` (256) |
| Adjudicator narrowness | `src/qa/failure-adjudicator.ts` `app_defect` rule (~132), `break-needs-human` (~161) |
| Playwright retries:2 (flaky signal) | `config/e2e/playwright.config.ts:21` |
| Planner prompt (no static-signal) | `src/integrations/prompts.ts` `buildPlanPromptAssembled` (~178) |
| Worker has no browser (dynamic) | `src/integrations/prompts.ts` ~247 |
| Tool grants per role | `agents/opencode.json` (qa-generator: serena/engram/playwright; qa-worker: serena only ~72; qa-reviewer: none ~33) |
| Verdict taxonomy | `src/types.ts` `RunVerdict` (~91), gateSignals (~243) |

## 8. Next steps (exact)

1. **Implement Phase 1.1 with TDD** in the worktree:
    - Add a bounded single-spec run capability the generator invokes (e.g. a `verify:spec` script in the `config/e2e/` seed wrapping `playwright test <file> --workers=1 --retries=0` under `timeout`), gated on a DEV-health probe.
    - Update the agent prompts (`agents/agent/qa-generator.md` + the Codex mirror `agent/roles/qa-generator.md`) to run-fix-until-green BEFORE emitting the verdict (remove the current "do NOT run the suite" prohibition for the bounded single-spec case only).
    - Add `coreutils`/`timeout` to `agents/Dockerfile` if missing.
    - Implement the **data-isolation corollary**: fresh namespace per execution attempt + mandatory selector scoping on created entities.
    - Keep `npm test` + `npm run typecheck` green; run a fresh-context review before any commit/PR.
2. Then Phase 1.2 → review → Phase 2 → review → Phase 3 (each behind the green-gate + a fresh review).
3. Decide on 1.3's suspect `qa-worker.md` edit with the user.

## 9. Invariants to respect (from CLAUDE.md)
- The LLM agent is read-only on watched repos; only the orchestrator does git writes. (Running a local test is NOT a git write — 1.1 is compatible.)
- Sequential queue — one run at a time; never concurrent QA against DEV. (1.1 runs one spec at a time; 1.2 keeps E2E single-agent.)
- App-specificity only in `config/`; agents/models only in `agents/`; nothing app-specific in `src/`.
- Honor the agent's no-op decision (approved + zero specs = valid `skipped`).
- Everything in English; comments describe final state.
