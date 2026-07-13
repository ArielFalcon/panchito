# migration-tier-4b — Decisions of Record

Date: 2026-07-12. Change: `migration-tier-4b` (branch `fix/migration-tier-4b`). Scope: the
`migration-tier-3` deferral register's `validate.ts`/`code-validate.ts`/`metadata.ts` DEFER-Tier-4
entry (`docs/superpowers/2026-07-11-migration-tier-3-decisions.md` §3), PLUS the `code-runner.ts`
Tier-4 candidate the same triage doc's §4 named as unstarted. Design: `sdd/migration-tier-4b/design`
(engram #1300, Rev 2 — amended after a fresh-gate FAIL; the manifest mechanism decision itself
PASSED unchanged). Spec: `sdd/migration-tier-4b/spec` (engram #1299).

---

## 1. In-scope migrated (4 slices, 4 work-unit commits)

| # | Slice | Destination | Commit |
|---|---|---|---|
| 1 | code-execution migration: `code-runner.ts` body (`runCodeTests`/`runCodeCoverage`/`detectCodeProject` + 12 helpers) + `setupCodeProject` + the privilege-drop `Sandbox` | `qa-engine/.../test-execution/infrastructure/{code-execution.runner.ts,code-setup.ts}`, `qa-engine/src/shared-infrastructure/process-sandbox/sandbox.ts` | `afbde70` |
| 2 | THE manifest reconciliation: one canonical zod schema replacing the two independently-maintained validators | `qa-engine/src/shared-kernel/manifest/manifest-entry.ts` | `f64b9f5` |
| 3 | validate cluster migration: `validate.ts` + `code-validate.ts` + `metadata.ts` bodies, PLUS the parity-test retirement (see §4 below — folded in, not deferred) | `qa-engine/.../test-execution/infrastructure/static-gate.checks.ts` | `038a8a3` |
| 4 | closeout: deferral register + triage doc update, this decisions doc | (docs only) | this commit |

`src/qa/code-runner.ts`, `src/qa/validate.ts`, `src/qa/code-validate.ts`, `src/qa/metadata.ts` and
their four `*.test.ts` files are all deleted. `npm run arch:check` stayed at 0 violations
throughout (180 modules, 468 dependencies after Slice 3, up from 172/428 at `migration-tier-3`'s
own baseline).

---

## 2. THE MANIFEST RECONCILIATION — mechanism CONFIRMED, union shape

Two independently-validated shapes existed for the same `e2e/.qa/manifest.json` file before this
change (full divergence table: `migration-tier-3-decisions.md` §4). The design evaluated three
mechanisms:

| Option | Verdict |
|---|---|
| (a) Canonical zod schema in qa-engine `shared-kernel/manifest/`; shell `schemas.ts` re-exports it | **CHOSEN** |
| (b) shared-kernel pure types + hand-rolled validation fn | REJECTED — re-hand-rolls Shape A's enum validation, the latent bug `manifest-fs.ts`'s `manifestEntryViolation` already had |
| (c) zod in shell + qa-engine structural twin + lockstep test | REJECTED — keeps TWO validators, the exact coupling this domain must dissolve |

Decisive evidence: qa-engine already depends on zod elsewhere (`shared-kernel/run-event.ts`,
`contract/{events,commands}.ts`) — a canonical zod schema in `shared-kernel` violates nothing
(`arch:check` forbids `src/` imports, not npm deps). The canonical shape is a UNION, not a lossy
intersection: it retains `file` (Shape B's field, load-bearing for `manifest-fs.ts`'s on-disk
phantom check) as OPTIONAL — Shape A's read gate never required it, and requiring it now would
reject pre-4b/hand-edited entries (forbidden widening) — AND retains every optional field Shape A
accepted (`useCase`/`criticality`/`owner`/`createdAt`/`coverage`/`sensitivity`/`stability`/
`ledger`/`merit`). `targets`/`changeRef` are now REQUIRED at BOTH the type and the runtime-check
level (closing the latent bug: Shape B's TYPE declared them optional while Shape A's runtime check
already required them). `src/orchestrator/schemas.ts`'s `ManifestEntrySchema`/`ManifestSchema`/
`ValidatedManifestEntry` are now THIN RE-EXPORTS of the canonical (`qa-engine/src/shared-kernel/
manifest/manifest-entry.ts`) — kept so `src/integrations/opencode-client.ts` (dead-but-compiled on
the qa-engine-driven production path, migrates in tier-4c) and this file's own `schemas.test.ts`
resolve with zero drift.

---

## 3. Gate corrections (design Rev 2 — the fresh-gate FAIL that amended the design)

The design's first pass FAILED a fresh-context gate review; the manifest mechanism decision (§2)
passed unchanged, but four defects/corrections were required before apply:

1. **DEFECT-1 — `checkManifest` strict read vs `readManifest` fail-open.** `checkManifest`
   (Filter B's read-path gate) does its OWN `readFileSync`+`JSON.parse` in a try/catch: missing/
   unreadable/corrupt → `ok:false` → verdict `invalid`. This is SEPARATE from generation's
   `manifest-fs::readManifest` (fail-open-to-`[]`, serving the reconcile MERGE, not the gate). The
   relocated `checkManifest` (Slice 3) keeps its own strict read UNCHANGED — never re-plumbed
   through the fail-open reader, which would have silently flipped a corrupt manifest from
   `invalid` to passing. Pinned by 4 new tests in `static-gate.checks.test.ts` (missing / corrupt /
   well-formed / enum-violation manifests).
2. **DEFECT-2 — `scrubEnv` is per-trust-domain, not one shared global allowlist.** The qa-engine
   `scrub-env.ts` twin's `ALLOWED_ENV_EXACT` included `CBM_CACHE_DIR` (for the codebase-memory-
   spawning consumer); `code-runner.ts`'s legacy copy did NOT. Naively re-pointing untrusted spawns
   to the twin would have silently widened the allowlist. Resolved: `scrubEnv({ extraExact?,
   extraAllowed? })` over a NARROW base (no `CBM_CACHE_DIR`); the codebase-memory consumer injects
   it via `extraExact` for its own spawn only. Migrated code-execution + re-pointed consumers
   (`execute.ts`, `maintainer-runtime.ts`) get exactly the narrow set.
3. **CORRECTION-3 — `merge-guard.ts` protected-path literals are the THREE new exact paths**, not a
   single renamed literal: `code-execution.runner.ts`, `code-setup.ts`, `sandbox.ts` (Slice 1).
4. **CORRECTION-4 — Slice 3's dependency is Slice 1 AND Slice 2**, not either alone:
   `code-validate.ts` needs `code-runner.ts`'s new qa-engine home (Slice 1: `detectCodeProject`/
   `realDetectDeps`/`resolveChangedModules`/`effectiveChangedFiles`/`gitWorkingChanges`/
   `DEFAULT_CODE_MODE_TIMEOUT_MS` + 3 types); `metadata.ts` needs the canonical manifest schema
   (Slice 2) to avoid importing `src/orchestrator/schemas.ts` from qa-engine.

---

## 4. Deviation: parity-test retirement folded into Slice 3, not deferred to a separate slice

The design's own slice narrative described Slice 4 as "parity retirement + closeout" — a slice
AFTER Slice 3's deletion of `src/qa/validate.ts`. The spec's own static-gate-validate-parity
requirement, however, is a hard MUST: "retire this parity pin in the SAME SLICE that deletes
`src/qa/validate.ts` — never a dangling broken import." Deleting `validate.ts` in Slice 3 while
`static-gate-validate-parity.test.ts` still imported it directly (`../../../../../src/qa/
validate.ts`) would have broken `npm test` between the Slice 3 and Slice 4 commits — violating the
never-commit-red gate. Resolution: the parity-test retirement (deleting the old parity file, and
its `qa-engine/tsconfig.json` exclude + `qa-engine/tsconfig.parity.json` include entries) landed IN
Slice 3's commit (`038a8a3`), not as a separate Slice 4 step. Its WF-02 zero-assertion regression
coverage (the reason the parity test existed at all — proving the REAL, non-stubbed
`validateSpecs` still catches a Plan-6-style no-op `validateAll` wiring) is preserved: the
consolidated `static-gate.checks.test.ts`'s "B2 RED"/"B2 GREEN" tests already exercise the same
real, non-stubbed zero-assertion scan against real temp-dir fixtures — there is no cross-boundary
import left to retire, since the checks are now qa-engine-native. Slice 4 (this commit) is
docs-only: the deferral register and this decisions record.

---

## 5. Minor simplification: `QaTestMeta` dropped, not ported

`src/qa/metadata.ts` exported a `QaTestMeta` interface documenting the per-test manifest-entry
shape. A repo-wide sweep found zero importers of `QaTestMeta` outside `metadata.ts` itself (not
even `schemas.ts`, which already had its own independent `ManifestEntrySchema`). The canonical
`ManifestEntry` type (`qa-engine/src/shared-kernel/manifest/manifest-entry.ts`, Slice 2) already
documents the identical field set via `z.infer`. Porting `QaTestMeta` verbatim would have
reintroduced exactly the kind of duplicate-shape drift this change exists to dissolve, for a type
nothing consumes. Dropped rather than forked; if a future caller needs a plain-interface view of
the manifest entry, it should import `ManifestEntry` from the canonical module, not reintroduce a
second declaration.

---

## 6. Deferral register (reconciled against `migration-tier-3-decisions.md` §3)

| Module | Status | Revisit condition |
|---|---|---|
| `src/qa/code-runner.ts` | **DONE** (`afbde70`, Slice 1) | — |
| `src/qa/validate.ts` | **DONE** (`038a8a3`, Slice 3) | — |
| `src/qa/code-validate.ts` | **DONE** (`038a8a3`, Slice 3) | — |
| `src/qa/metadata.ts` | **DONE** (`038a8a3`, Slice 3) | — |
| `src/qa/playwright-report.ts` | DEFER-Tier-4 | revisit with `src/qa/execute.ts` decomposition — tier-4d (seam-pinned, migrates LAST per `seam-parity.contract.test.ts`) |
| `src/integrations/reexplore.ts` | DEFER-Tier-4 | revisit with `src/integrations/opencode-client.ts` decomposition — tier-4c (2100-LOC monolith, decompose don't port wholesale) |
| `src/qa/learning/learning-rule.ts` | DEFER (D8) | D8 learning-store duality converges (`history.ts`/`SqliteLearningRepository` remain two separate stores by deliberate decision) |

Unaffected, still deferred per prior triage classification (`docs/superpowers/
2026-07-09-src-qa-engine-migration-triage.md` §4): `test-data.ts`, `circuit-breaker.ts`,
`codex-circuit-breaker.ts` (inside the declared `src/agent-runtime` shell survivor — not a
migration candidate at all), `model-window-catalog.ts` (known C4 split-brain config bug, unfixed),
`context.ts`, `learning/curriculum.ts` (D8 entanglement), `generation-parse` cluster
(`verdict-parse.ts`, `taxonomy.ts`, `exploration-brief.ts`, `context-assembler.ts` — each has a
HEAD-verified sole consumer that is itself not yet migration-ready). The seam-pinned four
(`execute.ts`, `opencode-client.ts`, `run-history-sqlite-adapter.ts`,
`rewritten-engine-factory.ts`) migrate LAST, each move in lockstep with
`seam-parity.contract.test.ts`, per that test's own literal-path/field-list pins.

The triage doc's §4 Tier-3/Tier-4 prose is updated in the same commit as this doc: `code-runner.ts`
moves to the Tier-4 DONE list (`migration-tier-4b`, `afbde70`); `validate.ts`/`code-validate.ts`/
`metadata.ts` move from the Tier-3-deferral DEFER-Tier-4 register to DONE (`migration-tier-4b`,
`038a8a3`); `playwright-report.ts`/`reexplore.ts`/`learning/learning-rule.ts` stay DEFER-Tier-4/D8
with their revisit conditions restated above.

---

## 7. Final gate status (all four slices, combined HEAD)

`npm run typecheck`: GREEN (5 programs: qa-engine build, root, qa-engine noEmit, parity, scripts).
`npm test`: 3759 pass / 0 fail / 1 skipped (net -3 vs the batch-1 checkpoint of 3762 — the three
legacy `*.test.ts` files' redundant smoke assertions collapsed into the consolidated
`static-gate.checks.test.ts` plus the retired parity file's own smoke test; every behavioral
assertion this change touches is preserved, none deleted without an equivalent). `npm run
arch:check`: GREEN, 0 violations (180 modules, 468 dependencies cruised).
