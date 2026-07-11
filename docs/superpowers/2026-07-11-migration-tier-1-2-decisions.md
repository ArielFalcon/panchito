# migration-tier-1-2 — Decisions of Record

Date: 2026-07-11. Change: `migration-tier-1-2` (branch `fix/migration-tier-1-2`, chained on
`fix/migration-wiring-phase-2`). Scope: structural relocation of 4 modules (the objective-signal
oracle cluster + the commit-classify type) from `src/` to `qa-engine/`, plus machine-enforcement of
the qa-engine→src import boundary. Zero observable behavior change — every src deletion is preceded
by a frozen parity pin in the same commit (Phase-2 precedent, `error-class-parity.test.ts`).

Source re-verification: `sdd/migration-tier-1-2/reverify` (discovery, engram id #1240) re-checked
all 15 triage §4 Tier-1/Tier-2 modules against HEAD post migration-remediation + migration-wiring-
phase-2. Only 4 migrate cleanly today; the other 11 defer with recorded evidence — see §2.

---

## 1. In-scope migrated (4 modules)

| # | Module | Destination | Commit | HEAD evidence |
|---|---|---|---|---|
| 1 | `src/qa/learning/fault-injection-e2e.ts` | `qa-engine/src/contexts/objective-signal/{domain/fault-injection-score.ts, infrastructure/fault-injection-oracle.adapter.ts}` | `68f92b8` | `runFaultInjectionOracle`'s orchestration absorbed into `FaultInjectionOracleAdapter.measure()` (new ctor: `runCorrupted`/`countInjected`/`baseUrl`); pure `computeFaultInjectionScore`/`isFlowBreak` moved to a new domain module. Factory (`rewritten-engine-factory.ts`) builds the two effectful collaborators locally instead of importing the legacy module. Parity pin (`fault-injection-oracle-parity.test.ts`) re-pointed to frozen literals in the SAME commit as the src deletion. |
| 2 | `src/qa/learning/mutation-code.ts` | `qa-engine/src/contexts/objective-signal/infrastructure/stryker-mutation-oracle.adapter.ts` | `06444c2` (parity test, Slice 1) + `8cabc58` (body-move + deletion, Slice 3) | All node-stdlib/Stryker helpers (`selectMutateTargets`, `writeStrykerConfig`, `parseStrykerReport`, `resolveStrykerCommand`, `cleanupStryker`, `killTree`, `sourceGlobs`) plus `runMutationOracle`'s orchestration absorbed; new ctor injects one `{spawn, detectCodeProject, scrubEnv}` bundle. This oracle had NO parity test before this change — `stryker-mutation-oracle-parity.test.ts` was written FIRST (Slice 1, wrapping the still-live legacy function), then re-pointed to frozen literals in the SAME commit as the src deletion (Slice 3). |
| 3 | `src/qa/learning/oracle-types.ts` (split) | `ValueOracleResult` → reuses the existing `qa-engine/src/contexts/objective-signal/application/ports/index.ts` copy (byte-identical, confirmed against HEAD before deletion). `OracleInput` → dissolved, no shared home. | `3e4668d` | See §4 for the full D3 rationale. `Scorecard`/`ScorecardEntry`/`updateScorecard` were left UNTOUCHED in `src/qa/learning/oracle-types.ts` — zero import diff for `history.ts`, `signals-view.ts`, `intelligence-view.ts` (spot-checked directly against HEAD). |
| 4 | `src/qa/commit-classify.ts` (reduction) | `CommitIntent`/`CommitType` → already declared in `qa-engine/src/contexts/generation/application/ports/generation-ports.ts` (structural aliases); the two importers flipped their import there. | `3e4668d` | The runtime was already dead — the live classifier is `qa-engine/src/contexts/change-analysis/domain/commit-classification.ts::classifyRange`. `src/integrations/opencode-client.ts:17` was a VALUE import (`import { CommitIntent } from "../qa/commit-classify"`, confirmed against HEAD — not `import type` as an earlier design draft assumed) despite `CommitIntent` only ever being used as a type annotation there; flipped to `import type` pointing at `generation-ports.ts`. `src/integrations/prompts.ts:18` was already `import type`, same flip. `commit-classification-parity.test.ts` re-pointed to frozen `CommitClassification` literals, captured by running the legacy `classifyCommit`/`classifyRange` against the test's own fixture matrix immediately before deletion. |

Boundary machine-enforcement (not a module migration, but part of this change): commit `35b8bcd`
adds a `no-src-import-in-qa-engine` forbidden dependency-cruiser rule
(`qa-engine/.dependency-cruiser.cjs`) plus a sibling `node:test` arch test
(`qa-engine/test/arch/no-src-import.test.ts`) that shells `depcruise` and asserts clean on HEAD. A
synthetic-violation sub-test (throwaway probe under `qa-engine/src/`, removed via `try/finally`,
never committed) proves the rule actually fires — this closes the boundary requirement's prior
manual-audit-only gap. The probe is placed as a sibling of `contexts/` (directly under
`qa-engine/src/`) rather than inside `contexts/`: the sibling `vcs-write-confinement.test.ts`'s own
`depcruise` scan targets `qa-engine/src/contexts` specifically, and `node:test` runs separate test
files concurrently by default — a probe placed inside `contexts/` was observed (during this
change's own apply) to be caught mid-write by that concurrent scan, producing a flaky cross-file
failure; moving it out of the overlapping scan target eliminated the race.

---

## 2. Deferral register (11 modules)

Re-verified against HEAD (`sdd/migration-tier-1-2/reverify`, discovery #1240) — the 2026-07-09
triage's Tier-1/Tier-2 lists were candidates, not facts; the tree changed under
`migration-remediation` and `migration-wiring-phase-2`. No import direction for any of these 11
changed in this migration.

| Module | Sole HEAD consumer | Class | Evidence | Revisit condition |
|---|---|---|---|---|
| `src/integrations/verdict-parse.ts` | `opencode-client.ts`/`prompts.ts` monolith (Tier-4) | DEFER-Tier-4 | Twin + parity test (`verdict-parser.adapter-parity.test.ts`) already exist; migrating now would only relocate import churn ahead of the Tier-4 monolith decomposition it depends on | Revisit when the `opencode-client.ts` (2100-LOC) decomposition (triage §4 Tier-4) starts |
| `src/qa/exploration-brief.ts` | `opencode-client.ts`/`prompts.ts` monolith (Tier-4) | DEFER-Tier-4 | Twin + parity test (`exploration-brief.adapter-parity.test.ts`) already exist; generation-parse cluster, same rationale as verdict-parse | Revisit alongside verdict-parse and context-assembler as one cluster move |
| `src/qa/context-assembler.ts` | `opencode-client.ts`/`prompts.ts` monolith (Tier-4) | DEFER-Tier-4 | Twin + parity test (`context-assembler.adapter-parity.test.ts`) already exist; generation-parse cluster | Revisit alongside verdict-parse and exploration-brief as one cluster move |
| `src/integrations/circuit-breaker.ts` | `opencode-client.ts`/`prompts.ts` monolith (Tier-4) | DEFER-Tier-4 | Sole consumer is the Tier-4 monolith itself | Revisit when the Tier-4 monolith decomposition starts |
| `src/integrations/model-window-catalog.ts` | `opencode-client.ts`/`prompts.ts` monolith (Tier-4) | DEFER-Tier-4 | Sole consumer is the Tier-4 monolith; triage §4 also flags a known C4 split-brain config bug to fix in the same future slice | Revisit when the Tier-4 monolith decomposition starts; fix the split-brain config bug in the same slice |
| `src/qa/context.ts` | `opencode-client.ts`/`prompts.ts` monolith (Tier-4) | DEFER-Tier-4 | `ArchitectureContext` structural alias already declared in `generation-ports.ts` (same pattern as `CommitIntent` was before Slice 4 of this change); sole consumer is the Tier-4 monolith | Revisit when the Tier-4 monolith decomposition starts |
| `src/agent-runtime/codex-circuit-breaker.ts` | `src/agent-runtime/*` (shell survivor) | DECLARE-SHELL-SURVIVOR | `src/agent-runtime` was declared the PERMANENT shell survivor in `migration-remediation` Slice 8.D (commit `2f614e4`) — this module lives inside that survivor tree, so it is not a migration candidate at all, by prior decision | None — permanent, unless the `src/agent-runtime` survivor decision itself is reopened |
| `src/qa/metadata.ts` | `src/qa/validate.ts` (Tier-3) | DEFER-Tier-3 | Sole consumer is `validate.ts`, itself deferred to Tier-3 (medium domain logic) pending a `StaticGateAdapter` overlap check | Revisit alongside `validate.ts`/`code-validate.ts` once the `StaticGateAdapter` overlap is resolved |
| `src/qa/test-data.ts` | `src/server/runner.ts` (shell) | DEFER-shell | Sole consumer is `runner.ts`, a control-plane shell module (never migrates per triage §4's shell-forever list) | Only if `runner.ts`'s ownership of this fixture-data concern changes |
| `src/qa/learning/taxonomy.ts` | `errorClassFromCorrections` already ported to `qa-engine`'s `error-class.ts` helper; `ErrorClass` union has shell-forever + Tier-3 consumers; `GRAVE_TAGS`'s only consumer is `verdict-validate.ts` | DEFER | The qa-engine port deliberately keeps a WIDE-ALIAS decoupling from the legacy union (an intentional design choice, not an oversight) — migrating the remaining src copy would need to reconcile that decoupling first | Revisit if the wide-alias decoupling is ever converged, or if `verdict-validate.ts` migrates |
| `src/qa/learning/curriculum.ts` | `src/server/history.ts` + CLI + chat surfaces | DEFER | D8 learning-store entanglement (`migration-remediation` decisions doc D8): `history.ts` and `SqliteLearningRepository` remain two separate stores by deliberate decision, not silent drift; `curriculum.ts` is entangled with the `history.ts` side | Revisit only if/when D8's learning-store duality is converged |

---

## 3. Triage-vs-HEAD corrections

The 2026-07-09 triage doc (`docs/superpowers/2026-07-09-src-qa-engine-migration-triage.md`) listed
`commit-classify.ts`, `taxonomy.ts`, `exploration-brief.ts`, `learning/fault-injection-e2e.ts`,
`context-assembler.ts` as Tier 1, and `oracle-types.ts`, `test-data.ts`, `metadata.ts`,
`circuit-breaker.ts`, `codex-circuit-breaker.ts`, `model-window-catalog.ts`, `context.ts`,
`learning/curriculum.ts`, `learning/mutation-code.ts` as Tier 2 — 15 modules total, all listed as
migration candidates without a HEAD re-check at time of writing.

`sdd/migration-tier-1-2/reverify` (discovery #1240) re-verified every one of those 15 against the
actual HEAD state post `migration-remediation` + `migration-wiring-phase-2`. Only 4 (fault-
injection-e2e, mutation-code, oracle-types, commit-classify) still migrate cleanly with a
low-risk, self-contained consumer graph; the other 11 have HEAD-verified sole consumers that are
themselves not yet migration-ready (Tier-3/Tier-4 monolith pieces, a declared shell survivor, or a
deliberately-unconverged design split) — see §2. The triage doc's tier tables are updated in the
same commit as this doc to reflect the DONE/DEFERRED split (see
`docs/superpowers/2026-07-09-src-qa-engine-migration-triage.md`, §4).

---

## 4. `ValueOracleResult` already existed + `OracleInput` dissolves (D3)

Per design decision D3 (`sdd/migration-tier-1-2/design`), re-verified directly against HEAD before
Slice 4's deletion:

- **`ValueOracleResult`** was ALREADY declared, byte-identical, in
  `qa-engine/src/contexts/objective-signal/application/ports/index.ts` — confirmed field-for-field
  against the `src/qa/learning/oracle-types.ts` copy before deleting the latter. There was never a
  need to "migrate" this type; the src copy was purely redundant once its only two consumers
  (the fault-injection and mutation oracles) moved into qa-engine in Slices 2-3. The qa-engine port
  copy is now the ONE home.
- **`OracleInput`** does NOT get a shared qa-engine home. HEAD showed its only consumers were the
  two oracle modules being deleted (plus their own tests) — and the two qa-engine adapters already
  used genuinely divergent local structural types (`FaultInjectionInputLike`: `target: "e2e"`,
  `e2eDir`, `baseUrl`, `baselineCases`, vs `OracleInputLike`: `target: "code"`, `repoDir`,
  `changedFiles`, no `baseUrl`). Introducing a shared `OracleInput` type in qa-engine would have
  been fabricated — a union wide enough to cover both shapes serves neither adapter's actual needs.
  Each adapter instead consolidated its own existing `*InputLike` locally (`stryker-mutation-
  oracle.adapter.ts`'s `OracleInputLike` widened with `ecosystem?/signal?/timeoutMs?/onProgress?`
  to preserve the absorbed orchestration's parameter surface — see that adapter's own header note
  on why those fields are structurally present but never populated via the public
  `ValueOraclePort.measure()` contract, matching the pre-migration wiring's own limitation).
- **`Scorecard`/`ScorecardEntry`/`updateScorecard`** stayed in `src/qa/learning/oracle-types.ts`
  (D8 learning-store boundary) — the file is REDUCED (survives as a shell-only module), not
  deleted. Zero importer churn for `history.ts`, `signals-view.ts`, `intelligence-view.ts`.
