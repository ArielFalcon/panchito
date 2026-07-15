# src/ ↔ qa-engine/ migration triage — disposition matrix

Date: 2026-07-09. Method: module-level reachability (madge from the real entry
points `src/index.ts` / `src/cli.ts` / `rewritten-engine-factory.ts`), per-module
`rg` verification of every import specifier, `git log --follow` / pickaxe history
per candidate, and cross-checking against the rewrite plan documents
(`docs/superpowers/specs/2026-06-24-qa-engine-hexagonal-rewrite-design.md`,
plans 1–7, `2026-07-02-qa-engine-audit-remediation.md`,
`qa-engine-phase2-quality-backlog.md`).

Governing boundary (from `2026-07-08-add-project-wizard-design.md:48-51`): the
qa-engine-first directive covers the **QA-run pipeline** (`src/qa/`,
`src/orchestrator/` and the collaborators they pull in). The control-plane
server and TUI (`src/server/*`, `client/*`) are **shell-forever** — they never
migrate. The C4/"Sub-Plan 7.2bis" inventory that was supposed to enumerate every
bridge collaborator before cutover was never produced; Plan 7.6 shipped anyway,
deleting only `src/pipeline.ts`. This document is that missing inventory.

---

## 1. Orphaned `src/` modules — delete vs regression (Q1)

### DELETE — superseded, live equivalent verified (high confidence)

| Module | Live equivalent |
|---|---|
| `src/qa/catalog-gate.ts` | inlined in `qa-run-orchestration/domain/pre-exec-grounding.service.ts::catalogCorrections` (deliberate, hexagonal-boundary comment) |
| `src/qa/context-pack.ts` | `generation/infrastructure/context-pack.ts` via `PreGenerationGroundingPortAdapter` (contracts sub-component inert — see contextMap DECIDE) |
| `src/qa/progress-gate.ts` | `qa-run-orchestration/domain/helpers/progress-gate.ts` via `fix-loop.aggregate.ts` (verbatim port) |
| `src/qa/selector-check.ts` | `qa-run-orchestration/domain/helpers/selector-check.ts` (verbatim port; canonical dependency of the other live gates) |
| `src/qa/source-map.ts` | inlined verbatim in `objective-signal/infrastructure/v8-browser-coverage.adapter.ts`, parity-pinned (OS-04) |
| `src/qa/measured.ts` | stability half superseded by a better mechanism (`trends-view.ts::computeFlows` + SQLite `flow` column); coverage-file-list half had no identified consumer |
| `src/qa/learning/labeler.ts` | regression suspicion REFUTED: `run-qa.use-case.ts::toRunOutcome` + `helpers/error-class.ts` rebuild the full `RunOutcome` (richer than legacy); `error-class-parity.test.ts` pins it |
| `src/qa/learning/distiller.ts` | `cross-run-learning/domain/distill-rule.ts` (verbatim, wired) |
| `src/qa/learning/reflector.ts` | `cross-run-learning/infrastructure/reflector-port.adapter.ts` (verbatim, wired) |
| `src/qa/learning/retrieval.ts` | `RuleGovernanceService.topRules` + bridged `incrementUsage`. **Verify first**: `fitRulesToBudget` char-budget trim has no confirmed live equivalent |
| `src/qa/learning/best-effort.ts` | contract reproduced ad hoc at each off-path boundary (`onFoldError`, `onReflectError`) |
| `src/qa/learning/structural-pattern.ts` | `distill-rule.ts::detectArchetype` (same regex set, wired) |
| `src/qa/static-signal/*` (10 files) | superseded in intent by the qa-engine extractor port — which is itself dead (see §2.3); deleting the src originals loses nothing not already lost |
| `src/integrations/publish.ts` | git mechanics ported into `buildVcsPublish` / `VcsWriteAdapter` / `GitHubPrAdapter.openWithAutoMerge` — but see the two publish gaps in §3 |

Tier-0 additions found by the deeper per-export pass (previously misclassified
as live bridges — re-verify import specifiers before deleting):
`src/qa/route-catalog.ts` (ported to `generation/infrastructure/route-catalog.ts`,
zero live callers), `src/qa/changed-elements.ts` (ported to
`shared-kernel/diff-parser/changed-element.ts`; src copy referenced only by dead
files), `src/qa/diff-hunks.ts` (reachable only via dead files). Most of
`src/qa/dom-snapshot.ts` is dead too — only `normalizeRoutes`, `MAX_ROUTES`,
`parseAriaSnapshot` are still consumed; the capture pipeline lives src-free in
qa-engine.

**Deletion caveat**: several of these files are pinned as parity **oracles** by
`qa-engine/tsconfig.parity.json` tests (`*-parity.test.ts`). Retire or re-point
each parity test in the same change that deletes its oracle.

### REGRESSION — capability lost in the rewrite (reimplement in qa-engine)

1. **`src/qa/confinement.ts` — security regression, highest severity.**
   Legacy ran `runConfine()` ~10×/run: `git status --porcelain` on the mirror,
   classify strays (e2e allowlist / code denylist incl. `.env*`), **revert** them
   (`git restore` / `git clean -f`), and detect symlinks whose realpath escapes
   the mirror. Live path has NONE of this mid-run; only a weaker publish-time
   staging allowlist (`buildVcsPublish` add/exclude) survives. The pure
   classifiers were ported (`workspace-and-publication/domain/write-confinement.service.ts`,
   unwired); the effectful half was explicitly deferred to "Plan 6"
   (`2026-06-24-qa-engine-plan-4-wrap-supporting.md:1524-1526`) and never done.
   Fix: wire `WriteConfinementService` + revert into `VcsWriteAdapter` /
   post-turn hook, including the symlink-escape check.
2. **`src/report/reporter.ts` — Issue/PR rendering regression, confirmed.**
   Live `publication-port.adapter.ts::renderBody` shares ONE body between PR and
   Issue, embeds raw sanitized logs first (explicitly against the original design
   note), and "What was tested" is structurally unreachable (no `tested` field on
   `PublicationPort.publish` input). Lost: verdict headline, failing-case
   distillation (`oneLineCause`), flaky-quarantine section, PR-specific body,
   `parentRunId` provenance. Gained (keep): engine-adjudication and
   reviewer-unavailable sections. Fix: thread generation spec metadata through
   `RunQaInput`/`PublicationPort` and restore split, distilled rendering.
3. **Publish gaps in the replacement** (the dead `publish.ts` is still DELETE):
   - `E2E_PUBLISH_EXCLUDES`/`CODE_PUBLISH_EXCLUDES` in
     `rewritten-engine-factory.ts:184-204` omit legacy's
     `e2e/.qa/service-context/` exclude while `src/server/service-context.ts`
     still writes there → a cross-repo run can commit ANOTHER repo's staged
     context into the suite PR (data-leak / PR-bloat). Small, urgent fix.
   - Context-mode publish lost its dedicated `e2e/.qa/context.json`-only
     variant; a context-mode "pr" outcome would fall through to the whole-`e2e/`
     branch (medium confidence — trace one real context-mode run to confirm).

### MIGRATE — valuable, never ported

- **`src/qa/learning/process-audit.ts` — highest-value gap.** Deterministic
  post-run self-audit (recurring-error-class / noise-rule / review-churn
  findings → engine-fix incident, ledger-heal, context-heal, observe). Ran after
  EVERY legacy run; its downstream sinks are still live and idle
  (`recordIncident` in `src/server/maintainer.ts`, `context_stale` table +
  `markContextStale` in `history.ts`). Reconnect as a post-run hook (likely a
  qa-engine port with the shell providing the incident sink).
- **`src/qa/learning/skill-exemplar.ts` — prompt-quality regression.** The
  concrete authoring-template catalog injected per detected archetype was
  reduced to a one-line label (`diffArchetypes` hint). Re-port the catalog into
  generation's prompt assembly if generation quality on form/auth/data-list
  flows matters (it was live in production).

### KEEP-AS-TOOL

- `src/qa/learning/ledger-cli.ts` + `ledger-report.ts` — the ONLY human write
  path into the live `learning_rules` table (`setRuleStatusByHuman`). Operational
  CLI against live data, invoked ad hoc. Consider wiring a package.json script
  and documenting it.

### DECIDE (needs an explicit call)

- `src/qa/context-cache.ts` — rides on a documented, deliberate gap:
  `CompositionConfig.contextMap` is left absent in production, so `context.json`
  read-back doesn't happen at all in diff mode (this also inerts context-pack's
  contracts component). Decision: restore contextMap wiring (then re-port this
  38-line cache alongside) or drop the context.json-consumption feature and
  delete.
- `src/qa/nav-gate.ts` — **DECIDED (D9, `sdd/migration-remediation` Slice
  8.C, commit c3f6d3f)**: accepted the threshold mitigation
  (`progress-gate`'s `reexploreNavigations`) as sufficient coverage; no MCP
  proxy was built. Deleted both copies — `src/qa/nav-gate.ts` and the
  qa-engine `test-execution/domain/nav-gate.service.ts` — with no canonical
  `helpers/nav-gate.ts` successor needed, since the mitigation already lives
  in `pre-exec-grounding.service.ts`. Retired the `nav-gate-parity` pin. See
  `docs/superpowers/2026-07-10-migration-remediation-decisions.md` D9.

---

## 2. Orphaned qa-engine modules — wire vs delete (Q2)

### WIRE — promised by the plan, wiring never landed

| Cluster | Evidence |
|---|---|
| `contexts/app-catalog/**` (4 files) | **RESOLVED — `sdd/migration-wiring-phase-2` Slice 1 (commit `f0a77bf`)**: webhook cross-repo resolution now routes through `YamlAppConfigAdapter.resolveByRepo`; `config-loader.ts` stays the raw+`expandEnv` shell loader underneath it |
| `generation/infrastructure/{context-assembler,exploration-brief,plan-parser}.adapter.ts` | design doc §2.3 C4: "depth deferred... YAGNI until stage 2"; plan-parser feeds the reserved `workerId` parallel fan-out (documented in CLAUDE.md as future) — deferred by design, not abandoned. Still open — `migration-wiring-phase-2` did not action this cluster |
| `workspace-and-publication/domain/write-confinement.service.ts` | the Plan-6 wiring into VcsWriteAdapter never happened → this IS regression §1.1's fix vehicle |
| `workspace-and-publication/infrastructure/mirror-gc.adapter.ts` | **RESOLVED — `sdd/migration-wiring-phase-2` Slice 2 (commits `efddc19`, `bccd975`)**: injected as an optional `RunQaUseCaseDeps.mirrorGc`, fired once post-run against the real per-run `mirrorDir`, fault-isolated |
| `shared-kernel/ports/redaction.port.ts` | **RESOLVED — the adapter + both egress boundaries landed in Phase 1 (D6/D7, Slice 6, commit `b775fd9`); the full `util/redact.ts` unification named here (env-value detection, all ~12 shell consumers, deletion) completed in `sdd/migration-wiring-phase-2` Slice 7 (commits `e5c129a`..`7bd9b22`)** — `util/redact.ts` no longer exists, `[REDACTED_CREDENTIAL]` collapsed to the canonical `[REDACTED]` everywhere |

### DECIDE

| Cluster | Lean | Why |
|---|---|---|
| `contexts/agent-runtime/**` (9 files) | **DECIDED — src/agent-runtime/\* is the survivor** | audit-remediation Track C4 required "re-home OR declare `src/agent-runtime` survivor — decision recorded in Plan 7.6" and 7.6 shipped WITHOUT recording it. Files are faithful WRAPs of live `src/agent-runtime/*`. **Resolved in `sdd/migration-remediation` Slice 8.D (commit 2f614e4)**: declared `src/agent-runtime/*` the permanent survivor and deleted 8 of the 9 qa-engine WRAP files. Kept `agent-runtime/application/ports/index.ts` — a live compile-time dependency of `ports-compile.test.ts` and `agent-session-telemetry.port.test.ts`, unrelated to the 8 deleted adapters |
| `change-analysis/{application/analyze-change.use-case.ts, infrastructure/extractors/*}` (15) | **DECIDED — DELETE, executed** | doc said keep-as-fallback ≥2 release cycles, but NOTHING ever consumed the abstraction (not even pre-graph); the leaner `StructuralSignalPort`→codebase-memory route won in production. **Resolved in `sdd/migration-remediation` Slice 8.A1 (commit 9bef64c)**: deleted (17 files incl. 3 `.scm` grammars); the narrowed signal is formally accepted, not filed as a capability gap |
| `qa-run-orchestration/domain/run.aggregate.ts` | DELETE — **not actioned, still open** | built once (Plan 6) to satisfy the DDD checklist; zero references in the live use-case; the `RunRecord` it "replaces" is alive and central. Out of scope for `migration-remediation`'s Slice 8 batch list |
| `test-execution/domain/{nav-gate,progress-gate,selector-check}.service.ts` | **DECIDED — DELETE/consolidate, executed** | accepted "zero-value wrapper" residue (phase2-backlog TE-08); selector-check.service is an OLDER copy — a trap for future imports. **Resolved in `sdd/migration-remediation` Slice 8.C (commit c3f6d3f)**: consolidated onto the canonical `helpers/` copies, retired the 3 old-copy parity pins. The legacy `src/qa/{progress-gate,selector-check}.ts` *source* files themselves were NOT deleted (deviation) — see decisions doc D9 |
| `shared-kernel/ports/clock.port.ts` | DELETE — **not actioned, still open** | zero adapter/consumer, no traced urgency. Out of scope for `migration-remediation`'s Slice 8 batch list |

### NOT dead

- `shared-kernel/contract/*` — Plan 7.3 executed; `src/contract/*` are thin
  re-export shims by design.
- Stub adapters (`stub-mirror-registry`, `stub-resolver`, `stub-code-graph`) —
  test fixtures with real test importers.
- `seam-parity.contract.test.ts` — the boundary regression gate (see §4).

---

## 3. Immediate fix backlog (independent of migration sequencing)

| P | Fix | Size | Status |
|---|---|---|---|
| P0 | Add `e2e/.qa/service-context/` to publish excludes (data-leak into PRs) | tiny | done — Slice 2, commit b0cf28f |
| P0 | Wire write-confinement (mid-run stray revert + symlink-escape) into the live path | medium | done — Slice 3, commits 8f8a9f3, 2d937d1 |
| P1 | Restore Issue/PR rendering (split bodies, drop raw-log dump, thread `tested` metadata) | medium | done — Slice 4, commit 895180e |
| P1 | Reconnect process-audit self-healing loop (sinks already live) | medium | done — Slice 5, commit edebb92 |
| P2 | Implement `RedactionPort` adapter; unify the two sanitizers | small-medium | done — Slice 6, commit b775fd9 |
| P2 | Verify `fitRulesToBudget` parity (unbounded rules → prompt?) and context-mode publish scope | verify-first | done — Slice 7, commits 3632e3c, 3bae1b2 |

Note: all 6 rows landed via `sdd/migration-remediation` Slices 1-7 (Phase 1
stabilization, closed out 2026-07-10). Slice 8 additionally executed the Tier-0
dead-code cleanup batches (A1/A2/B/C/D/E/F, commits 9bef64c..34cb08c) from §1/§2
below, with 4 items discovered blocked-in-place along the way. Full decision
record, gate evidence, and the deferred/blocked register: see
`docs/superpowers/2026-07-10-migration-remediation-decisions.md` (D1-D10 plus
its Outcome section).

**Phase 2 update (`sdd/migration-wiring-phase-2`, closed out 2026-07-10)**: the
13-item deferred/blocked register that Phase 1 handed off is now closed —
all 7 originally-deferred DELETE items (`source-map.ts`, `measured.ts`,
`labeler.ts`, `reflector.ts`, `retrieval.ts`, `best-effort.ts`, `publish.ts`)
plus the 4 newly-discovered blocked-in-place deletions (`distiller.ts`,
`progress-gate.ts`, `selector-check.ts`, `reporter.ts`) are deleted; the
`parentRunId` producer gap and the unstaged-fs-level-rename pairing gap are
both closed; app-catalog and mirror-gc are wired; contextMap read-back and
the skill-exemplar catalog are restored (§2/§5 below, flipped to RESOLVED).
Full register, commit list, and one new follow-up discovered along the way
(a typed-declaration-initializer sanitizer gap): see
`docs/superpowers/2026-07-10-migration-remediation-decisions.md`'s
"migration-wiring-phase-2 — Outcome" section.

---

## 4. Remaining migration scope for LIVE src/ code (Q3/Q4)

Shell-forever (never migrates): `src/index.ts`, `src/cli*.ts`, all of
`src/server/*` (control-plane), `src/orchestrator/config-loader.ts` + schemas,
`src/util/*`, `client/*`, `agents/*`, `agent/*`, `config/*`.

Engine-logic-in-exile (migrates, tiered — full per-module table with LOC/tests/
twins in the audit transcripts; ordering rubric: dead cleanup → wiring finishes →
small pure ports → domain logic → heavy leaf-IO):

- **Tier 0 — cleanup**: §1 DELETE list + `route-catalog`, `changed-elements`,
  `diff-hunks`, dead bulk of `dom-snapshot`. Retire each parity oracle in the
  same commit.
- **Tier 1 — twin + parity test already exist, finish the wiring**:
  ~~`commit-classify.ts`~~ **DONE** (logic already redundant — live path uses
  `change-analysis/domain/commit-classification.ts::classifyRange`; the
  `CommitIntent` type re-homed to `generation-ports.ts`) and
  ~~`learning/fault-injection-e2e.ts`~~ **DONE** (body-moved into
  `objective-signal/{domain/fault-injection-score.ts,
  infrastructure/fault-injection-oracle.adapter.ts}`) — both migrated in
  `sdd/migration-tier-1-2` (commits `68f92b8`, `3e4668d`; decisions doc
  `2026-07-11-migration-tier-1-2-decisions.md`). ~~`context-assembler.ts`~~
  **DONE** — relocated whole to `generation/infrastructure/prompt-builders/`
  alongside `prompts.ts` (`sdd/migration-tier-4c` Slice 5a, commit `eea7aea`;
  the dormant `ContextAssemblerAdapter` twin gained a genuine internal caller
  in the same move). Remaining, re-verified **DEFERRED** against HEAD (same
  discovery #1240 register): `taxonomy.ts`, `exploration-brief.ts` (its
  render/parse/coerce functions are consumed by `prompts.ts` via a cross-
  boundary late-bound adapter setter, `setExplorationBriefCollaborators` —
  wired, but the file itself is deliberately NOT relocated; see
  `2026-07-14-migration-tier-4c-decisions.md`), and `verdict-parse.ts`
  (multi-consumer now — `codex-strategy.ts`, `verdict-validate.ts`,
  `rewritten-engine-factory.ts`, `exploration-brief.ts` — explicitly
  **descope-with-record**, not migrated in tier-4c; see that decisions doc's
  Open Questions).
- **Tier 2 — small, no twin yet**: ~~`oracle-types.ts`~~ **DONE (split)**
  (`OracleInput`/`ValueOracleResult` deleted — `ValueOracleResult` already had
  a byte-identical qa-engine home, `OracleInput` dissolved with no shared
  replacement; `Scorecard`/`ScorecardEntry`/`updateScorecard` stay shell-only,
  zero importer churn) and ~~`learning/mutation-code.ts`~~ **DONE** (the
  missing Stryker parity test was written FIRST, then the body moved into
  `stryker-mutation-oracle.adapter.ts`) — both migrated in
  `sdd/migration-tier-1-2` (commits `06444c2`, `8cabc58`, `3e4668d`; decisions
  doc `2026-07-11-migration-tier-1-2-decisions.md`). ~~`circuit-breaker.ts`~~
  **DONE** — this doc's own 2026-07-09 entry had CONFLATED it with
  `codex-circuit-breaker.ts` as both "inside the declared `src/agent-runtime`
  shell survivor"; that was never accurate for `circuit-breaker.ts` (it lived
  at `src/integrations/circuit-breaker.ts`, a distinct pure failure-count/
  cooldown state machine with zero SDK coupling — `codex-circuit-breaker.ts`
  is the unrelated file, a genuine D1 Codex-runtime primitive). Migrated whole
  to `generation/infrastructure/resilience/circuit-breaker.ts`
  (`sdd/migration-tier-4c` Slice 2, commit `38ff328`). ~~`model-window-
  catalog.ts`~~ **DONE** — relocated to `generation/infrastructure/prompt-
  builders/` and its known C4 split-brain config bug FIXED (D-4c-6:
  `roleWindowBytes` now resolves the three visible roles from injected
  runtime assignments first; `sdd/migration-tier-4c` Slice 5b, commit
  `ba5bf4e`). ~~`context.ts`~~ **DONE** — see `context-assembler.ts`'s entry
  in the Tier-1 bullet above (same file; this doc's own line-count estimate
  for it was stale, corrected in the tier-4c decisions doc). Remaining,
  re-verified **DEFERRED** against HEAD (same discovery #1240 register):
  `test-data.ts`, `codex-circuit-breaker.ts` (the genuine D1 Codex-runtime
  primitive, permanent shell — NOT a migration candidate, unlike
  `circuit-breaker.ts` above which this doc previously and wrongly lumped
  together with it), `learning/curriculum.ts` (D8 learning-store
  entanglement). `metadata.ts` moved OUT of this bullet — its authoritative
  classification is now the Tier-3 gate decision below (DEFER-Tier-4,
  co-deferred with the validate cluster).
- **Tier 3 — medium domain logic**: ~~`deploy-gate.ts`~~ **DONE (REDUCE)** —
  `shaMatches` relocated byte-identical to `qa-engine/src/shared-kernel/sha.ts`;
  the rest of the module (`waitForDeploy`/`DeployTarget`/`VersionInfo`/
  `DeployTimeoutError`/`GateDeps`/`defaultDeps`) was fully dead (the live gate
  was already `DeployGatePortAdapter.waitUntilServing`, its own independent
  poll loop — no new port was needed after all) and deleted along with its
  test. Migrated in `sdd/migration-tier-3` (commit `73ce0a1`; decisions doc
  `2026-07-11-migration-tier-3-decisions.md`). That change's own gate decision
  co-deferred the whole validate cluster (see that decisions doc §2) pending
  `code-runner.ts`'s migration + the manifest-shape reconciliation — both now
  DONE: ~~`validate.ts`~~/~~`code-validate.ts`~~/~~`metadata.ts`~~ **DONE**
  (`sdd/migration-tier-4b`, commit `038a8a3` — body-moved into qa-engine's
  `static-gate.checks.ts`; decisions doc
  `2026-07-12-migration-tier-4b-decisions.md`). ~~`playwright-report.ts`~~
  **DONE** — migrated alongside `execute.ts`'s own decomposition, Slice 1a
  (`sdd/migration-tier-4d`, commit `59280ae`; decisions doc
  `2026-07-15-migration-tier-4d-decisions.md`). ~~`reexplore.ts`~~ **DONE**
  (stale entry, corrected here) — it was actually migrated in
  `sdd/migration-tier-4c` Slice 3 alongside the SSE lifecycle split (commit
  `e5e9645`); that tier's own closeout pass over this doc never updated this
  line. Remaining **DEFER-Tier-4**: `learning/learning-rule.ts` (DEFER D8,
  learning-store duality).
- **Tier 4 — heavy leaf-IO, last**: ~~`repo-mirror.ts` (write side)~~,
  ~~`github.ts` (adapters exist; replace closures)~~, ~~`setup.ts`~~ — all
  three **DONE** (`sdd/migration-tier-4a`, commits `52eb2a2`/`096e42c`/
  `f467f71`; decisions doc `2026-07-11-migration-tier-4a-decisions.md`).
  `repo-mirror.ts` is a REDUCE, not a full delete — see that doc's §5 for
  the newly-discovered `src/index.ts` onboarding-job consumer that kept
  `ensureMirror`/`ensureMirrorAtBranch` as thin wrappers instead.
  ~~`code-runner.ts`~~ **DONE** (`sdd/migration-tier-4b`, commit `afbde70` —
  body-moved into `qa-engine/.../test-execution/infrastructure/
  {code-execution.runner.ts,code-setup.ts}` + `shared-infrastructure/
  process-sandbox/sandbox.ts`; decisions doc
  `2026-07-12-migration-tier-4b-decisions.md`). ~~`prompts.ts`~~/
  ~~`opencode-client.ts`~~ **DONE (decomposed, not ported wholesale, per this
  doc's own instruction)** — `sdd/migration-tier-4c` (7 commits across
  Slices 1-6; decisions doc `2026-07-14-migration-tier-4c-decisions.md`).
  This line's "2 known live bugs" claim gave no specifics beyond a count.
  ONE was reproduced and fixed (the `buildWorkerPromptAssembled` qa-worker/
  -code budget-role bug, Slice 5b commit `cc0a4b6` — distinct from the
  model-window-catalog D-4c-6 split-brain fix noted above). The SECOND is a
  **best-effort inference, not a certainty** — no second bug was ever named
  anywhere; Slice 5b identified and fixed engram bugfix #919 (`capDiff`
  silently dropping an oversized first/only diff file, commit `a062844`) as
  the strongest candidate found, flagged explicitly as inference in the
  decisions doc. `opencode-client.ts` decomposed into a thin raw-SDK-closure
  shell survivor — session transport/SSE policy, resilience, and prompt
  builders all migrated to qa-engine (see the decisions doc for the full
  two-tier split). Remaining: `src/agent-runtime/*` (DECIDED already — see §5
  item 1: declared the permanent survivor), `verdict-parse.ts`/
  `verdict-validate.ts` (open design question, explicitly descope-with-record
  in tier-4c — see the Tier-1 deferred bullet above). ~~`execute.ts`~~ **DONE**
  — body-moved into `qa-engine/.../test-execution/infrastructure/
  e2e-execution.runner.ts` (`sdd/migration-tier-4d` Slice 1b, commit
  `b7300c4`), retiring seam-parity's (c) EXECUTION block in the SAME atomic
  commit (block (c)'s own coverage re-forms qa-engine-internally, no src/
  import — see `qa-engine/test/contexts/qa-run-orchestration/infrastructure/
  bridges/execution-port.adapter.test.ts`). This doc's own "final step: dissolve
  `rewritten-engine-factory.ts` + `run-history-sqlite-adapter.ts`" framing was
  WRONG — the design corrected it (migration-tier-4d gate finding): `arch:check`'s
  one-way rule (qa-engine never imports src/) makes dissolving either
  architecturally impossible, not merely undesirable. Both are instead
  DECLARED permanent shell survivors (D-4d-1/D-4d-2, `sdd/migration-tier-4d`
  Slice 3; decisions doc `2026-07-15-migration-tier-4d-decisions.md`), so the
  (d)/(e) blocks of `seam-parity.contract.test.ts` are PERMANENT
  boundary-contract tests for those two declared survivors, not migration
  debt pending a future move — its (a)/(b) blocks (`OpencodeRunInput`/
  `ReviewInput`) were retired in tier-4c Slice 6.

Gray-zone calls to make explicit: `src/server/history.ts` (coexists with
qa-engine's native `SqliteLearningRepository` — two learning stores in one
composition), `activity-mapper.ts`/`agent-activity.ts` (engine telemetry vs
control-plane plumbing — lean shell), `value-report.ts`, `deploy-gate.ts`
placement, `config-loader.ts` composition-mapping tension.

**Hard sequencing constraints (updated post-tier-4d, RESOLVED)**: `seam-parity.contract.test.ts`
originally pinned `execute.ts`, `opencode-client.ts`, `run-history-sqlite-adapter.ts`,
`rewritten-engine-factory.ts` by literal relative path and full field lists,
requiring all four to migrate LAST in lockstep with the test. `opencode-client.ts`
was decomposed (tier-4c) and its own pin — the (a) GENERATION PROMPT / (b)
REVIEW blocks (`OpencodeRunInput`/`ReviewInput`) — retired in Slice 6.
`execute.ts` was body-moved (tier-4d Slice 1b), retiring the (c) EXECUTION
block in the same atomic commit. `run-history-sqlite-adapter.ts` and
`rewritten-engine-factory.ts` never migrate at all — both are DECLARED
permanent shell survivors (D-4d-1/D-4d-2) — so the (d)/(e) blocks they anchor
are PERMANENT boundary-contract tests, not a lockstep-migration pin waiting on
a future move. The sequencing constraint this paragraph named is therefore
fully discharged: nothing left in `seam-parity.contract.test.ts` is "migrate
LAST" debt.
`qa-engine/tsconfig.parity.json` is the registry of every boundary-straddling
file; anything crossing the boundary must be listed there or it is typechecked
by nothing.

---

## 5. Open decisions (owner call required)

1. **RESOLVED** — `src/agent-runtime` declared the permanent shell survivor;
   the qa-engine WRAPs deleted (`sdd/migration-remediation` Slice 8.D, commit
   2f614e4).
2. **RESOLVED** — change-analysis extractor pipeline deleted; the narrowed
   structural signal (codebase-memory route) formally accepted
   (`sdd/migration-remediation` Slice 8.A1, commit 9bef64c).
3. **RESOLVED** — nav-gate: accepted the `reexploreNavigations` threshold,
   deleted both copies, no MCP-proxy block built (`sdd/migration-remediation`
   Slice 8.C, commit c3f6d3f; decisions doc D9).
4. **RESOLVED (partially — read-back only)** — contextMap read-back: the
   `e2e/.qa/context.json` per-run read now lives in
   `PreGenerationGroundingPortAdapter.ground()`, un-inerting context-pack's
   contracts component (`sdd/migration-wiring-phase-2` Slice 3, commit
   `0cc096d`; decisions doc D-C). The `context-cache.ts` re-port itself was
   deliberately **descoped** — `context.json` is committed to the app repo's
   `e2e/` in context-mode PRs, so a normal `git checkout` restores it for
   free; the cache would only help shadow apps, and the recommendation is to
   measure residual shadow-rebuild waste before building it.
5. `run.aggregate.ts` — still open. Not actioned by `migration-remediation`
   or `migration-wiring-phase-2`.
6. **RESOLVED (documented, not converged)** — learning-store duality:
   `history.ts` and `SqliteLearningRepository` remain two separate stores by
   deliberate decision, not silent drift (`sdd/migration-remediation`
   decisions doc D8). Unchanged by `migration-wiring-phase-2`.
7. **RESOLVED** — skill-exemplar catalog: restored into the generation
   prompt as a budgeted "Skill exemplars" section, keyed off
   `detectStructuralPatterns`'s `StructuralPattern[]` (`sdd/migration-wiring-
   phase-2` Slice 4, commit `8379da0`, rider `9e825a2`; decisions doc D-E).
8. **RESOLVED** — the `opencode-client.ts`/`prompts.ts` cluster (this doc's
   §4 Tier-4 "named C4 target" line) is DONE: decomposed across
   `sdd/migration-tier-4c`'s 7 commits (Slices 1-6), not ported wholesale.
   Two-tier split (raw SDK closure stays shell; policy/lifecycle/prompt
   builders migrate to qa-engine), the local `ParallelWorkerInput` interface
   escalation raised in Slice 1 (kept type-only, zero production callers,
   solely for `generation-ports-parity.test.ts`'s AssertNever gate) resolved
   in Slice 6 by deleting both together, `model-window-catalog.ts`'s C4
   split-brain bug fixed (D-4c-6), and one of the "2 known live bugs" fixed
   with certainty + one fixed as a flagged best-effort inference (see item
   above and `2026-07-14-migration-tier-4c-decisions.md`). `verdict-parse.ts`/
   `verdict-validate.ts` remain explicitly descoped-with-record, not part of
   this closure.
