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

---

### Judgment Day round 1

An adversarial review of `sdd/migration-tier-1-2` (two independent blind judges) found two
confirmed defects (both judges agreed on each) and fixed both on `fix/migration-tier-1-2`, gated
green after every commit (`npm test` + `npm run typecheck`, Node v24.11.0), never committed red:

- **Mutation-oracle timeout/abort testability regression** (confirmed by both judges — one
  coherent fix covering two related defects): Slice 3 (`8cabc58`) privatized `runMutationOracle`
  and hardcoded `measure()`'s input, closing the seam that let a test inject a short
  `timeoutMs`/`AbortSignal`. This silently dropped ALL coverage of the `setTimeout`/`killTree`/
  abort branches — live production paths (a hanging Stryker run must still resolve, not hang the
  whole QA run forever) — with zero test replacement. **This was a previously-undocumented
  deviation**: the apply-progress record (engram `sdd/migration-tier-1-2/apply-progress`) noted the
  dropped "timeout" fixture as "not a regression" because `timeoutMs` was "structurally
  unreachable via the adapter's public `measure()` surface" — true, but that framing never made it
  into this decisions doc, and it elided that the coverage LOSS itself (not just the fixture) was
  real: the hang/timeout code path stayed live in production with no test exercising it at all.
  Separately, the adapter's local `killTree` was a byte-copy of the one
  `qa-engine/src/shared-kernel/process-sandbox/process-kill.port.ts` explicitly names as a
  consolidation target (the last of 4 duplicates), while `ProcessKillAdapter` was already live
  elsewhere (`sandboxed-binary-runner.adapter.ts`). **RESOLVED**: `MutationOracleDeps` now carries
  a required `processKill: ProcessKillPort` (wired to the real `ProcessKillAdapter` in
  `rewritten-engine-factory.ts`, local `killTree` deleted) and an optional ctor-level `timeoutMs`
  override (defaulting to `DEFAULT_MUTATION_TIMEOUT_MS`), restoring a real "returns null valueScore
  on timeout, delegates to the injected ProcessKillPort" test against the actual adapter. The
  "aborts on signal" seam was deliberately NOT restored — `ValueOraclePort.measure()` takes no
  per-call cancellation token, and the composition factory builds this adapter's deps bundle
  BEFORE the run's real `AbortSignal` exists in the `engineFactory(...)`/`RunQaUseCase.run(signal)`
  call chain, so a ctor-level `signal` field would never be populated by real production wiring —
  a test for it would cover dead code, not real behavior. Commit `cf2851c`.
- **depcruise `baseDir` cwd-fragility** (confirmed by both judges, reproduced): both forbidden
  rules in `qa-engine/.dependency-cruiser.cjs` (`no-src-import-in-qa-engine`, added this change's
  Slice 5, and the pre-existing `no-vcs-write-in-agent-contexts`) resolve their `from`/`to` path
  regexes against module ids that default to being relative to `process.cwd()`. Invoking depcruise
  from `cwd=qa-engine/` (a plausible mistake — e.g. `cd qa-engine && npx depcruise --config
  .dependency-cruiser.cjs src`) either silently reported zero violations (the patterns, anchored to
  `"qa-engine/src/"`/`"^src/"`, never matched cwd-relative ids like `"src/foo.ts"`) or errored
  outright looking for a directory that doesn't exist — both a silent boundary-gate no-op,
  reproduced directly against a synthetic violation probe before the fix. **RESOLVED**: pinned
  `options.baseDir` to the repo root (`path.resolve(__dirname, "..")`), making the same
  baseDir-relative target (`"qa-engine/src"`) resolve identically regardless of invocation cwd.
  `qa-engine/test/arch/no-src-import.test.ts` extended with a `cwd=qa-engine/` synthetic-violation
  regression; `vcs-write-confinement.test.ts` re-verified green (unaffected — same rule mechanism,
  same fix). Commit `170bdd2`.

Docs/hygiene cleanup in the same round (no behavior change): `CLAUDE.md`/`AGENTS.md`'s single-test
command example referenced the deleted `src/qa/commit-classify.test.ts` (removed in this change's
own Slice 4) — replaced with the still-live `src/server/webhook-routing.test.ts`; `AGENTS.md`'s
file-map table's `src/qa/commit-classify.ts` row removed for the same reason.
`qa-engine/tsconfig.parity.json` pruned 2 stale entries (`commit-classification-parity.test.ts`,
`fault-injection-oracle-parity.test.ts`) — both dropped their `src/` import in Slice 4/Slice 2
respectively and are already covered by `qa-engine/tsconfig.json`'s normal include, so listing them
in the parity config double-typechecked them for no reason (`stryker-mutation-oracle-parity.test.ts`
was NOT pruned — same absorption happened in Slice 3, but it was never added to
`tsconfig.parity.json` in the first place, only to `qa-engine/tsconfig.json`'s own exclude list
pre-Slice-3). `objective-signal/application/ports/index.ts`'s header comment referencing the
dissolved `OracleInput.repoDir` (§4 above) updated to point at each adapter's own local
`*InputLike` type instead.
