# migration-tier-4d — Decisions of Record (PROGRAM FINALE)

Date: 2026-07-15. Change: `migration-tier-4d` (branch `fix/migration-tier-4d`), the fourth and LAST
sub-change of `migration-tier-4` (`sdd/migration-tier-4/proposal` #1277), which closes the whole
`src/` → `qa-engine/` migration program started 2026-07-01. Design: `sdd/migration-tier-4d/design`
(engram #1331). Proposal: `sdd/migration-tier-4d/proposal` (engram #1328, gate-passed, owner-signed).

---

## 1. In-scope migrated / resolved (7 slices, 8 work-unit commits)

| # | Slice | Destination / disposition | Commit(s) |
|---|---|---|---|
| 1a | `playwright-report.ts` → qa-engine test-execution (pure, kernel types) | `qa-engine/.../test-execution/infrastructure/playwright-report.ts` | `59280ae` |
| 1b | `execute.ts` body-move (env injection, `recordAudit?`, `ProcessKillAdapter`) + seam-parity block (c) atomic retirement + `PROTECTED_PATHS` new home + stale local `.d.ts` cleanup | `qa-engine/.../test-execution/infrastructure/e2e-execution.runner.ts` | `b7300c4` |
| 2 | seam-parity (d)/(e) reclassification (already folded into 1b's atomic commit) + triage-doc correction (3 stale entries, not 2 — see §5) | docs only | `9d41d40` |
| 3 | Shell-survivor register: one-line "why shell" header on each declared permanent module | `rewritten-engine-factory.ts`, `run-history-sqlite-adapter.ts`, `opencode-client.ts`, `src/agent-runtime/index.ts`, `history.ts` (learning CRUD) | `0419460` |
| 4 | Residual register: capDiff deleted, createAgentDeps tested, restartProvider declared, warnFallbackOnce fixed (5 items — see §4) | `sanitizer.ts`, `agent-transport-policy.test.ts`, `agent-runtime.ts`, `model-window-catalog.ts` | `fd085c9`, `0e295ed`, `69647fa`, `96db247` |
| 6 | CLAUDE.md rewrite to the true final shape + qa-engine-first directive retirement | `CLAUDE.md`, triage doc | `9604614` |
| 7 | `run.aggregate.ts` 3-file sweep (module + test + `DECISION_PATH_FILES` entry) | deleted | `2aa4b23` |
| 5 | Inverse arch-rule out-of-scope record (D-4d-5) | this doc, §6 | this commit |

`src/qa/execute.ts`, `src/qa/execute.test.ts`, `src/qa/playwright-report.ts`,
`src/qa/playwright-report.test.ts`, `qa-engine/src/contexts/qa-run-orchestration/domain/run.aggregate.ts`
and its test are all deleted. `npm run arch:check` stayed at 0 violations throughout (193→192 modules,
506→504 dependencies after the `run.aggregate.ts` sweep). `npm test` grew from the pre-change baseline
of 3646 (3645 pass/1 skip) to 3634 (3633 pass/1 skip) net across the change — the arithmetic: Slice 1
moved ~52 execute/playwright-report tests into qa-engine unchanged; Slice 4 removed 6 dead capDiff
tests and added 9 new `createAgentDeps` tests (net +3); Slice 7 removed ~15 `run.aggregate.test.ts`
tests. All three gates (`npm test && npm run typecheck && npm run arch:check`) green after EVERY
commit, on Node v24.11.0 (better-sqlite3 ABI 137).

---

## 2. THE SLICE-1 EXECUTION MOVE — confirmed against the 4b template

`execute.ts`'s body-move mirrored `migration-tier-4b`'s `code-execution.runner.ts` migration exactly,
per the design's explicit instruction that 4b is not an analogy but THE template:

- `E2eExecutionStrategy` KEPT its injected `RunE2eFn` seam (D-4d-3a) — composition re-points the
  closure (`(specDir,opts)=>runE2E(specDir,opts,e2eExecuteDeps)`), it does not unwrap into a direct
  internal call. DI stays the testing strategy (CLAUDE.md): the strategy is Playwright-free in unit
  tests.
- `timeoutMs`/`actionTimeoutMs` are env-derived and INJECTED from the composition root (D-4d-3b),
  never read as `process.env` inside qa-engine — the `codeSandbox` precedent, exactly.
- `recordAudit` stays an optional injected sink (`E2eExecuteDeps.recordAudit?`, D-4d-3c) — no
  qa-engine twin; it is a shell-owned security boundary by declaration (`sanitize-text.ts`'s own
  header + `rewritten-engine-factory.ts:814` corroborate).
- `killTree` retired via `ProcessKillPort`/`ProcessKillAdapter` (D-4d-3e) — the last of the 4 named
  duplicate copies; Playwright's own spawn stays bespoke (NDJSON streaming + dual-reporter +
  `detached` group semantics `SandboxedBinaryRunnerAdapter` does not model).
- A SECOND, undocumented coupling was discovered beyond the design's briefed scope: `qa-engine/test/
  contexts/test-execution/domain/adjudicate-parity.test.ts` ALSO imported directly from
  `../../../../../src/qa/execute.ts` and was ALSO in `tsconfig.parity.json`'s include list. Deleted
  in the same atomic commit as block (c) (its own header said its job was "until Plan 7 deletes the
  legacy original" — that's now); both `PLAYWRIGHT_INFRA_RE`/`allFailuresAreRunnerInfra` copies
  (`AdjudicateService` + `e2e-execution.runner.ts`) keep independent behavioral coverage elsewhere.

---

## 3. Shell-survivor register — the declared, permanent end state

Per the design's `.dependency-cruiser.cjs` one-way rule (`qa-engine/src` never imports `src/`),
dissolving any of these into qa-engine is architecturally impossible, not merely undesirable. Each
carries a one-line header at its own file location (Slice 3); this table is the consolidated record.

| Module | Role | Why shell (scoped claim) |
|---|---|---|
| `src/server/rewritten-engine-factory.ts` (D-4d-1) | Composition root | Maps `AppConfig` → qa-engine `CompositionConfig`; `AppConfig`-shaped config loading is irreducibly host-specific. **Scoped, not "zero policy"**: `historyLearningStore.recordOutcome` (~lines 536-579) is a genuine off-path learning fold — branches oracle-vs-prevention scoring, derives `coverageCreditConfirmed`, loops `rulesRetrieved` — but qa-engine's own `LearningRepositoryPort` EXPECTS exactly this kind of injected-store fold to live shell-side. |
| `src/server/run-history-sqlite-adapter.ts` (D-4d-2) | Persistence bridge | Bridges the kernel `RunOutcome` into `history.ts`'s SQLite `run_outcomes` table; `history.ts` (1101 ln) was never proposed for migration. |
| `src/integrations/opencode-client.ts` (D1-family) | Raw SDK edge | Post-tier-4c residue is ONLY the genuinely-raw `@opencode-ai/sdk` I/O closure (client construction, `session.create/prompt/abort/delete`) — everything with independently-testable policy already migrated in tier-4c. |
| `src/agent-runtime/*` (D1) | Provider-selection facade | Decided permanent in `migration-remediation` Slice 8.D (commit `2f614e4`) — faithful WRAPs of these files were deleted from qa-engine then. Dispatches each role to the OpenCode/Codex runtime strategy; the policy each strategy delegates to already migrated. |
| `history.ts`'s learning CRUD (D8) | Shell half of a deliberate two-store duality | Coexists with qa-engine's own `SqliteLearningRepository` by documented decision (`migration-remediation` decisions doc D8), not silent drift — stays because it is the SAME durable SQLite database `history.ts` already owns for run_outcomes/trends. |

`qa-engine/test/contract/seam-parity.contract.test.ts`'s (d) PERSISTENCE and (e) COMPOSITION blocks
are the permanent boundary-contract tests pinning the two composition/persistence seams above; its
(a)/(b) blocks (`OpencodeRunInput`/`ReviewInput`) retired in tier-4c Slice 6, its (c) EXECUTION block
retired in this change's Slice 1b.

**Deliberately left gray-zone, NOT declared this slice** (the design does not name them for Slice 3,
so declaring them here would be undesigned scope creep): `src/qa/value-report.ts`, `src/orchestrator/
config-loader.ts`. Both remain open per the 2026-07-09 triage doc's "Gray-zone calls to make explicit"
list — a legitimate Phase-5 candidate, not a silent drop (see end-state item 11).

---

## 4. Residual register — 5 items resolved

| # | Item | Disposition |
|---|---|---|
| i | `scrubEnv`'s `/^DEV_/` widening | **RESOLVED in Slice 1** (record only, no new work): `config/e2e/playwright.config.ts:50-53` reads `DEV_ENV_USER`/`DEV_ENV_PASS` (Basic Auth guarding DEV) + `DEV_TEST_USER`/`PASS` (app login) — the trust domain is the Playwright child process, not the file's directory, so relocating `execute.ts` changes nothing about the widening's necessity. Closed by Slice 1b's `PROTECTED_PATHS` addition (the new `e2e-execution.runner.ts` home is now human-review-gated). |
| ii | `createAgentDeps` had no direct unit test | **FIXED**: 9 new characterization tests (`agent-transport-policy.test.ts`) against a fake `RawAgentTransport`, covering fallback-model retry on a transient fault, skip-on-abort, skip-on-infra-error, circuit-breaker gating (open-rejects / reset-recovers), telemetry assembly, sanitize-before-emit (the emitted turn event is redacted but the caller-facing return value stays raw), and the default persist-turn sink's present/absent-runId behavior. Discovered along the way: `node:assert`'s `assert.rejects` does not convert a synchronously-thrown error from its callback into a caught rejection — only `await`/try-catch handles both uniformly; `checkCircuit()`'s OPEN-circuit gate throws synchronously. Every real production caller already awaits `session.prompt()` inside an async function or a `new Promise` executor, both of which normalize the sync throw correctly — a test-authoring gotcha, not a production bug. |
| iii | `sanitizer.ts`'s orphaned `capDiff` | **DELETED** — zero remaining production callers (re-verified via `rg` across `src/` and `qa-engine/` before deleting); the real, wired diff capper is qa-engine's own `prompt-cap.ts` copy. `extractDiffFilePath`/`isLowRelevance`/`LOW_RELEVANCE_PATTERNS`/`MAX_PROMPT_DIFF_CHARS` deleted alongside it (verified no callers outside this file's own internals — the design's flagged hazard); its Slice-G tests deleted too. `capText`/`MAX_PROMPT_BODY_CHARS` are untouched (out of the design's named scope, though also orphaned — flagged below as a discovered follow-up, not actioned). Also cleaned up 3 stale, gitignored `.d.ts` build artifacts (`sanitizer.d.ts`, `execute.d.ts`, `playwright-report.d.ts`) that Slice 1's own cleanup pass missed because `fd` silently skips gitignored files by default — the exact stale-`.d.ts` hazard the design flagged, materialized once. |
| iv | `restartProvider`'s `Promise.all` ordering | **DECLARED, not fixed** — `applyConfig` commits `config = next` before the parallel restart settles; a failed restart leaves another still-in-flight restart detached with its outcome never reconciled. A real fix touches `applyConfig`'s rollback semantics (sequential restart + roll back on first failure, or reconcile per-provider outcomes) — recorded as a follow-up comment in `agent-runtime.ts`, deliberately out of scope here. |
| v | `warnFallbackOnce`'s misleading "DEFAULT window" text | **FIXED** — the D-4c-6 cross-source-disagreement call site never falls through to `DEFAULT_WINDOW_TOKENS`; it keeps using the runtime-resolved model's real window and only flags the mismatch. `warnFallbackOnce` now takes an optional `outcome` parameter so that call site says what actually happened; every other caller keeps the unchanged default message. |

**Discovered but NOT actioned (flagged for a future change, not silently dropped)**: `sanitizer.ts`'s
`capText`/`MAX_PROMPT_BODY_CHARS` are ALSO orphaned in production (only referenced by their own test
file; the wired copy is qa-engine's `prompt-cap.ts`) — found while investigating residual (iii), but
the design named only `capDiff` for deletion. Left in place per scope discipline; a follow-up change
can delete this sibling cluster the same way.

---

## 5. Triage-doc correction — 3 stale entries (design named 2, a 3rd found)

The 2026-07-09 triage doc's Tier-3/Tier-4 sections and its "Hard sequencing constraints" paragraph
still described `execute.ts`/`rewritten-engine-factory.ts`/`run-history-sqlite-adapter.ts` as a
"final step: dissolve" target and `playwright-report.ts` as pending tier-4d — both stale now that
Slice 1 landed. A third, unrelated stale entry was also found and fixed: `reexplore.ts` was actually
migrated in `migration-tier-4c` Slice 3 (commit `e5e9645`) but that tier's own closeout pass never
updated this line. All three corrected in commit `9d41d40`; the "Hard sequencing constraints"
paragraph is now marked RESOLVED (nothing left in `seam-parity.contract.test.ts` is "migrate LAST"
debt).

---

## 6. D-4d-5 — the inverse arch rule, DEFERRED, declared out of scope

**Decision**: building an inverse dependency-cruiser rule (`src/` never imports `qa-engine/src`
except through the declared composition-root/bridge seams) is DEFERRED to a Phase-5 candidate, not
built in this change.

**Evidence for the deferral** (≥3 carve-outs needed before such a rule could even be written without
immediately failing):
1. `rewritten-engine-factory.ts` — ~25 context-internal imports (it IS the composition root; this is
   its whole job).
2. `opencode-client.ts` — 6 `@contexts/generation/infrastructure` imports (itself a D1-family declared
   shell survivor per §3 above).
3. `repo-mirror.ts`, `index.ts`, `agent-runtime.ts` — each import qa-engine ports/adapters as part of
   their own declared bridge role.
4. **Unprecedented, previously undeclared**: 4 onboarding files (`src/server/onboarding/*`) import the
   `service-topology` DOMAIN layer directly — nobody has named or declared this carve-out before.

Net-new infrastructure would also be required: `arch:check` today only cruises `qa-engine/src`
(`depcruise --config qa-engine/.dependency-cruiser.cjs qa-engine/src`); an inverse rule needs its own
config cruising `src/` instead, with a fresh allowlist for every carve-out above. This satisfies
end-state item 7's "OR" (the item is satisfied by either a passing inverse rule or a recorded,
evidenced deferral — the deferral is what's recorded here).

---

## 7. THE END-STATE CHECKLIST — result (12 items)

**Mechanical (10)**

| # | Check | Result |
|---|---|---|
| 1 | `fd src/qa src/integrations` + per-file header grep | **PASS** — `src/qa/` retains 14 files and `src/integrations/` retains 7; every one is dispositioned in the 2026-07-09 triage doc (DEFERRED/D1/D8/descope-with-record) or this doc's §3 shell-survivor register. None is undocumented. |
| 2 | `fd execute.ts src/qa` = empty + qa-engine tests green | **PASS** — no `execute.ts` under `src/qa`; qa-engine's `e2e-execution.runner.test.ts` (52 tests, moved from `execute.test.ts`) green. |
| 3 | grep block (c) absent / (d)(e) header text | **PASS** — no `describe`/`ExecuteOptions` reference to block (c) remains (only historical prose); (d)/(e) header explicitly says "PERMANENT boundary-contract tests... not migration debt." |
| 4 | read `tsconfig.parity.json` | **PASS** — `adjudicate-parity.test.ts` entry removed (Slice 1); `seam-parity.contract.test.ts` entry stays, as designed. |
| 5-6 | grep declaration headers + triage doc | **PASS** — 5 shell-survivor headers added (Slice 3); triage doc's 3 stale entries corrected (§5) plus the qa-engine-first retirement note. |
| 7 | `arch:check` 0 violations + D-4d-5 record present | **PASS** — `npm run arch:check`: 0 violations (192 modules, 504 dependencies) after every commit; D-4d-5 recorded in §6 above. |
| 9 | engram directive marked superseded | **PASS** — engram #1150 (`qa-engine-first directive scopes to...`) updated to mark the directive RETIRED, pointing to the permanent boundary rule and this doc. |
| 10 | three gates green on Node v24.11.0 | **PASS** — `npm test && npm run typecheck && npm run arch:check` green after EVERY commit this batch, Node v24.11.0 (better-sqlite3 ABI 137). |
| 12 | engram archive entries exist | **PASS** — verified `migration-remediation`, `migration-wiring-phase-2`, `migration-tier-1-2`, `migration-tier-3`, `migration-tier-4a` (#1298), `migration-tier-4b` (#1307), `migration-tier-4c` (#1326/#1327) archive/DAG entries all exist in engram. This change's own archive-report will close item 12 for the finale once `sdd-archive` runs. |

**Human-read (2)**

| # | Check | Result |
|---|---|---|
| 8 | CLAUDE.md prose truly describes the settled shape, no in-progress-migration language | **PASS (judgment)** — Architecture section now states the permanent boundary rule and the four declared shell roles as settled fact, not an in-flight migration; two stale cross-references fixed (the deleted `src/qa/code-runner.ts` citation, the "diff→model both pass through sanitizer.ts" claim which tier-4c's decomposition made only half-true). "Current state" section explicitly says the migration program is complete. |
| 11 | every residual-register item carries a real rationale, none silently dropped | **PASS (judgment)** — all 5 Slice-4 items disposed with rationale (§4); the `capText` sibling discovery is flagged, not silently dropped; `value-report.ts`/`config-loader.ts` are explicitly named gray-zone, not silently declared or silently ignored (§3); D-4d-5's inverse rule deferral carries full evidence (§6). |

---

## 8. PROGRAM SUMMARY — all 8 changes, 2026-07-01 to 2026-07-15

The `src/` → `qa-engine/` migration program, run end-to-end as 8 SDD changes:

1. **`migration-remediation`** (2026-07-10) — Phase 1 stabilization: 6 immediate P0-P2 fixes (publish
   excludes closing a cross-repo data-leak, write-confinement mid-run wiring, Issue/PR rendering
   restore, process-audit self-healing reconnect, `RedactionPort` unification, `fitRulesToBudget`/
   context-mode verification) PLUS Slice 8's Tier-0 dead-code cleanup (6 batches, commits
   `9bef64c`..`34cb08c`) declaring `src/agent-runtime` and the nav-gate mitigation permanent (D9,
   D-Slice-8.D).
2. **`migration-wiring-phase-2`** (2026-07-10) — closed the 13-item deferred/blocked register Phase 1
   handed off: 7 deferred DELETE items + 4 newly-discovered blocked-in-place deletions executed;
   `app-catalog`/`mirror-gc` wired; `contextMap` read-back and the skill-exemplar catalog restored;
   `util/redact.ts` fully unified away.
3. **`migration-tier-1-2`** (2026-07-11) — the objective-signal oracle cluster (fault-injection,
   mutation-code) migrated with parity tests written FIRST; `commit-classify.ts` found redundant
   (already superseded) and removed; `oracle-types.ts` split (dead type deleted, live type kept
   shell-only).
4. **`migration-tier-3`** (2026-07-11) — `deploy-gate.ts` REDUCED (`shaMatches` relocated
   byte-identical, the rest was already-dead code); co-deferred the whole validate cluster pending
   `code-runner.ts`'s own migration.
5. **`migration-tier-4a`** (2026-07-11) — the heavy leaf-IO trio: `repo-mirror.ts` (write side,
   REDUCED not fully deleted — `index.ts`'s onboarding job kept thin wrappers), `github.ts` (adapters
   already existed; replaced closures), `setup.ts` — all DONE.
6. **`migration-tier-4b`** (2026-07-12) — `code-runner.ts` body-moved (closing tier-3's co-deferral);
   THE manifest reconciliation (one canonical zod schema replacing two independently-maintained
   validators); the `validate.ts`/`code-validate.ts`/`metadata.ts` cluster migrated into
   `static-gate.checks.ts`.
7. **`migration-tier-4c`** (2026-07-14) — the program's LARGEST change: `opencode-client.ts`/
   `prompts.ts` decomposed (2113→493 ln), not ported wholesale — a two-tier split (raw SDK closure
   stays shell; transport resilience, session policy, SSE lifecycle, and prompt builders all migrate)
   after a Rev-1 design FAILED a fresh gate for claiming "stay shell wholesale." Fixed the
   `model-window-catalog` D-4c-6 split-brain bug and one of two flagged "known live bugs" with
   certainty (the qa-worker/-code budget-role bug), the second as a flagged best-effort inference
   (`capDiff`'s oversized-first-file bug, engram #919). Retired seam-parity's (a)/(b) blocks.
8. **`migration-tier-4d`** (2026-07-15, **this change, THE FINALE**) — migrated the last genuine
   engine-logic-in-exile (`execute.ts`, mirroring 4b's own template exactly), retired seam-parity's
   remaining (c) block and reclassified (d)/(e) as permanent boundary-contract tests, declared the
   final shell-survivor register (composition root, persistence bridge, provider I/O edges,
   control-plane learning-store half), resolved all 5 outstanding residual-register items, deleted a
   dead DDD-checklist artifact (`run.aggregate.ts`), deferred the inverse arch rule to Phase-5 with
   full evidence, and rewrote CLAUDE.md to describe the TRUE settled shape — retiring the
   qa-engine-first directive that guided all 8 changes, replaced by the permanent boundary rule
   `.dependency-cruiser.cjs` now enforces mechanically.

**The program's net effect**: `qa-engine/` is now the engine — every genuine unit of QA-run pipeline
domain/application logic lives there, unit-tested against hexagonal ports, with zero imports back
into `src/`. `src/` is the declared, permanent shell: composition root, control plane, provider I/O
edges, and persistence — nothing left pending a future migration slice. The next architectural
frontier (per D-4d-5) is the INVERSE direction — constraining what `src/` is allowed to reach INTO
`qa-engine/` — deferred with evidence to a Phase-5 candidate, not silently dropped.
