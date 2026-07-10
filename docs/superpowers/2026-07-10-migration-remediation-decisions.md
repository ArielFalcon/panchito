# migration-remediation — Decisions of Record

Date: 2026-07-10. Scope: `sdd/migration-remediation` (Phase 1 stabilization of the
`src/` → `qa-engine/` migration triage, see
`docs/superpowers/2026-07-09-src-qa-engine-migration-triage.md`). Grounded against
live code at the time of writing: `src/server/rewritten-engine-factory.ts`,
`qa-engine/.../write-confinement.service.ts`, `src/qa/confinement.ts`,
`qa-engine/.../publication-port.adapter.ts`, `src/report/reporter.ts`,
`src/qa/learning/process-audit.ts`, `src/orchestrator/sanitizer.ts`,
`src/util/redact.ts`, `qa-engine/src/shared-kernel/ports/redaction.port.ts`,
`qa-engine/.../learning-port.adapter.ts`, `qa-engine/.../run-qa.use-case.ts`.

This document records the 7 architecture decisions (D1–D7) plus the
learning-store-duality decision made for this change, and the register of
triage DELETE items this change deliberately does not action.

## D1 — Publish-excludes correctness fix (D-P0a)

**Decision**: fix `E2E_PUBLISH_EXCLUDES` in `rewritten-engine-factory.ts` in one
array edit that does two things at once:

1. **Leak fix** — add `e2e/.qa/service-context/`. `src/server/service-context.ts`
   writes cross-repo service snapshots under `e2e/.qa/service-context/<slug>/`;
   neither `E2E_PUBLISH_EXCLUDES` nor `CODE_PUBLISH_EXCLUDES` excluded that path,
   so a cross-repo run could commit another repo's staged context into the suite
   PR. The spec requires this exclusion for **both** the e2e and code targets —
   `CODE_PUBLISH_EXCLUDES` gets the same entry, not just `E2E_PUBLISH_EXCLUDES`
   (a gap the design's D-P0a section did not spell out for the code array, since
   `CODE_PUBLISH_ADD = ["."]` stages the whole tree and would leak it too).
2. **Anchoring-bug fix** — the pre-existing entries `.qa/coverage/` and
   `.qa/measured.json` exclude **nothing**. Both patterns contain a slash that is
   not at the very end (a "mid-pattern slash"), and per gitignore-pattern rules a
   pattern with a mid-pattern slash is anchored to the directory of the exclude
   file itself — for `.git/info/exclude` that is the **repo root**, never `e2e/`.
   So `.qa/coverage/` looks for `<root>/.qa/coverage/`, while the real path is
   `<root>/e2e/.qa/coverage/`. Prefixing both entries with `e2e/` (matching how
   `CODE_PUBLISH_EXCLUDES` already correctly writes `e2e/.qa/coverage/`) fixes the
   anchoring.

`node_modules/` is intentionally left **unprefixed** — a pattern with no slash at
all (only a trailing one) is NOT anchored and matches at any depth, which is the
desired (and already-correct) behavior; prefixing it would narrow it to only
`e2e/node_modules/` at the top level and stop matching nested occurrences.

**Verification requirement**: proven with a real git-status/git-add fixture test
(throwaway repo, real untracked files, real `git status --porcelain`), not an
array-membership assertion — membership would have passed on the pre-fix
anchoring bug, since the (wrong) string was already present in the array.

**Rejected**: filtering in `VcsWriteAdapter` instead of the config arrays — the
arrays already model the e2e/code target split and are the natural single
source of truth for what each target excludes.

## D2 — Write-confinement wiring: fail-open posture + code-denylist mirror (D-P0b)

**Decision**: wire a new `ConfinementPort` (`enforce(mirrorDir, isCode, signal?)`)
as an optional `RunQaUseCaseDeps.confinement?` collaborator, backed by a new
`workspace-and-publication/infrastructure/write-confinement.adapter.ts` wrapping
the already-ported, unwired `WriteConfinementService` pure classifiers over an
injected Git + `realpathSync`/`lstatSync`. Constructed in
`rewritten-engine-factory.ts` (local git ops only, no auth decoration), called
**once**, immediately **before** the publish phase (git status is cumulative, so
one check after all agent + FixLoop turns catches everything).

**Failure semantics — fail-open, but only where a real deterministic guard backs
it up.** Confinement is fault-isolated best-effort: a git error during
enforcement is logged loudly, recorded in `gateSignals.confinement`, and **never**
changes the run verdict. This posture is sound for the e2e target because
`E2E_PUBLISH_ADD = ["e2e"]` is a true hard commit-time allowlist — a swallowed
confinement failure still can't stage anything outside `e2e/`. It is **not**
automatically sound for the code target: `CODE_PUBLISH_ADD = ["."]` stages the
whole tree, so a swallowed confinement failure with no downstream guard could
land `.github/`, `Dockerfile`, `docker-compose*`, `.gitattributes`, or
`.gitmodules` writes straight into a code-target PR. **Resolution**: extend
`CODE_PUBLISH_EXCLUDES` to mirror the write-confinement code denylist
(`CONFINEMENT_DENYLIST` from `write-confinement.service.ts`) so the commit-time
allowlist is actually true for the code target too — confinement's fail-open
posture then becomes genuine defense-in-depth over a real deterministic guard,
not the only guard. This is D1's `CODE_PUBLISH_EXCLUDES` change and D2's
confinement wiring landing together as one coherent guarantee (D1 lands first in
Slice 2; D2's wiring lands in Slice 3, depending on D1's guard being in place).

**Rejected**: pre-stage filtering inside `VcsWriteAdapter` (misses any run that
never reaches a publish terminal); per-agent-turn enforcement (heavy — FixLoop is
a separate aggregate, and a single pre-publish check already covers the
cumulative git status). **Rejected**: an adapter inside `qa-run-orchestration`
(arch-lint forbids that context from importing `WriteConfinementService`
directly — the adapter must live in `workspace-and-publication`, the one context
allowed VCS writes).

## D3 — Publication rendering + tested-metadata sourcing (D-P1a)

**Decision**: restore split, distilled Issue/PR rendering as pure functions in a
new `workspace-and-publication/domain/render-publication.ts` (ported from
`src/report/reporter.ts`), consumed by `publication-port.adapter.ts` in place of
today's verbatim `sanitize(logs)` embed. `PublicationPort.publish` gains an
optional `tested?: {flow; objective}[]` (plus `isCode`, `parentRunId`);
`GenerationPort.generate()` gains an optional `specMetas?: {flow; objective}[]`
return.

**Resolves the design's open question on `tested` staleness**: `tested` is
sourced from the FixLoop's **final** `specMetas` when a regeneration happened
this run, falling back to the **initial** `GenerateTestsUseCase` `specMetas`
otherwise. A FixLoop regeneration can change which specs actually shipped, so
using the initial (possibly stale) `specMetas` would print a "Covers:" section
that no longer matches what was published. Preferring the final metas when a
regen occurred keeps the "Covers:" section truthful without adding a new IO read
(the FixLoop already holds its own final `specMetas` in memory at the publish
call site).

**Rejected**: reading `manifest.json` at publish time — that needs a brand-new IO
port for something the agent's already-produced `specMetas` already gives us
(and is what legacy used). Rendering stays pure-in-domain (unit-testable
without a fake adapter) rather than inline in the adapter.

## D4 — Process-audit reconnect call sites (D-P1b)

**Decision**: port the pure `auditProcess`/`applyAudit` functions into a new
`cross-run-learning/domain/process-audit.ts`, expose a new
`ProcessAuditPort.audit(outcome): Promise<void>` co-located with the existing
`ReflectorPort`, and call it at **both** fold call sites in
`run-qa.use-case.ts` — the same two places `learning.fold()` already runs, right
after the fold completes (mirroring how the reflector is invoked today). The
adapter self-sources `recent` outcomes and `rules`, and dispatches its three
sinks — all injected from `src/server` via the factory:
`engine-fix → maintainer.recordIncident`, `ledger-heal → history` (deprecate the
rule), `context-heal → history.markContextStale`. `observe` only records, no
sink call. The audit is fault-isolated and timeout-capped in the adapter; the
use-case awaits it with no additional guard, matching the reflector's existing
contract.

**Rejected**: a single shared call site for both fold locations — the two fold
sites are genuinely separate execution points in the use-case (initial run vs.
regeneration), and the reflector already establishes the "call at both sites"
precedent this change follows for consistency.

## D5 — Two-layer gating divergence (deliberate improvement, D-P1b)

**Decision**: gate the process-audit reconnect with **two independent layers**,
and record this explicitly as a deliberate improvement over legacy, not silent
drift:

1. **External current-run gate** (same as the reflector's):
   `shouldDistillLearning && verdict !== "flaky" && errorClass ∉ {E-INFRA,
   E-FLAKY}`. Necessary because `auditProcess` itself has no internal verdict
   discrimination beyond one `o.verdict !== "pass"` check inside its
   review-churn finding — it will happily process a flaky/infra run if fed one.
2. **Streak-input gate**: the factory-injected `recent`-history read that feeds
   `auditProcess`'s recurring-error-class streak calculation (`recurringCls`
   over a 3-run window) must **also** exclude flaky/infra-class outcomes before
   the streak calculation ever sees them — otherwise a genuine recurring
   engine-defect streak could be polluted (or manufactured) by infra noise,
   defeating the finding's purpose.

Legacy called `auditProcess` unconditionally on every run against an unfiltered
recent-history window. This design tightens **both** the trigger and the streak
input feeding it. That is a deliberate correctness improvement over legacy
behavior, recorded here so it is never mistaken for an accidental behavior
change during future parity review.

## D6 — RedactionPort scope narrowing: egress-only (D-P2)

**Decision**: build a `RedactionPort` adapter in `src/`, wrapping
`src/orchestrator/sanitizer.ts`'s `sanitizeText`/`containsSecrets` (the superset
pattern set), and repoint the qa-engine twin
`generation/infrastructure/sanitize-text.ts` onto the same port — removing the
lockstep-duplicate. Scope is the **two egress boundaries only**: diff → model and
execution-logs → Issue.

`src/util/redact.ts` (`redactSecrets`/`redactError`, `[REDACTED_CREDENTIAL]`
placeholder, env-**value**-driven detection, ~12 shell-control-plane consumers:
`runner.ts`, `api.ts`, `maintainer-runtime.ts`, `agent-runtime.ts`,
`onboarding/*`, `repo-mirror.ts`, `index.ts`) is a **different mechanism** and is
explicitly **deferred to a Phase 2 follow-up**. None of its consumers touch the
diff→model or logs→Issue boundaries, so deferring the unification does not
regress protection at either egress boundary today — it only leaves the
duplicate mechanism (and its distinct env-value detection) unconverged for one
more phase.

## D7 — Canonical placeholder collapse to `[REDACTED]` (D-P2)

**Decision**: collapse **every** sanitizer/egress placeholder to the single
canonical `[REDACTED]`, per `redaction.port.ts`'s `REDACTED` constant — including
`[REDACTED_HOST]` and `[REDACTED_PII]`, not just `[REDACTED_SECRET]`. No
tier-preservation open question remains in this change; if host/PII-tier
semantics are ever wanted again, that is a note for the deferred
`util/redact.ts` follow-up (D6), not this change. 8 test files assert the old
placeholders and are updated in the same unit as the collapse (Slice 6); the
`[REDACTED_CREDENTIAL]` test files that pin `util/redact.ts` are **not** touched
(out of scope, D6).

## D8 — Learning-store duality: document the split, do not converge

**Decision**: `src/server/history.ts` and qa-engine's native
`SqliteLearningRepository` remain **two separate learning stores** in one
composition, and this change does **not** converge them. `RunHistoryPort` is
narrowed to a write-only `save()`; the recent-outcomes **read** used by both the
reflector and (per D4) the process-audit reconnect is a factory-injected
function, not a port method. This is recorded as a **deliberate** decision, not
a silently deferred one (triage doc §5, item 6): converging the two stores is a
larger migration-shaped change (which store becomes canonical, what happens to
existing `learning_rules`/`history` data) that is out of scope for a
stabilization change whose job is to fix regressions and reconnect existing
sinks, not restructure persistence.

## Deferred deletions — triage DELETE items intentionally excluded from this change

This change's deletion batches (Slice 8, A–F) do **not** cover every item on the
triage doc's DELETE list (§1). The following seven modules are explicitly **out
of scope** for `migration-remediation` and are flagged as a follow-up
migration-cleanup change:

- `src/qa/source-map.ts`
- `src/qa/measured.ts`
- `src/qa/learning/labeler.ts`
- `src/qa/learning/reflector.ts`
- `src/qa/learning/retrieval.ts`
- `src/qa/learning/best-effort.ts`
- `src/integrations/publish.ts`

**Verified rationale (per-file, checked against the live test tree — not
uniformly restated)**: of these seven, only **one** is a genuine
compile-time-pinned parity oracle today:

- **`src/qa/learning/labeler.ts`** — directly imported by
  `qa-engine/test/contexts/qa-run-orchestration/domain/helpers/error-class-parity.test.ts`
  (`import { labelRunOutcome as legacyLabelRunOutcome } from
  "…/src/qa/learning/labeler.ts"`). This is a real, typechecked parity guard —
  deleting the file without first retiring or re-pointing that test breaks the
  build.

The other six are referenced only as **provenance commentary** (comments
documenting where ported logic came from), or in one case as a **verbatim
inline copy**, not a compiled import:

- **`src/qa/source-map.ts`** — inlined verbatim (not imported) into
  `objective-signal/infrastructure/v8-browser-coverage.adapter.ts`. No test
  imports the legacy file directly; per the Phase 2 quality backlog's own OS-04
  finding, this coverage path is **"completely unpinned — zero parity
  coverage"** today. It is *not* an active parity oracle; it is unguarded
  duplicated logic that happens to still exist.
- **`src/qa/measured.ts`** — no import, no comment reference, and no identified
  consumer anywhere in `qa-engine`. Per the triage doc's own assessment, its
  stability half was superseded and its coverage-file-list half had no
  identified consumer. Safe to delete on its own merits; simply not included in
  design's batch A–F file list for this change.
- **`src/qa/learning/reflector.ts`** — no import found anywhere in
  `qa-engine`, including its own named successor's test
  (`reflector-port.adapter.test.ts`), which does not reference it.
- **`src/qa/learning/retrieval.ts`** — referenced only in comments (in
  `learning-port.adapter.ts`, `learning-port.adapter.test.ts`,
  `sqlite-learning-repository.adapter.ts`, and the `RetrievePort` doc comment in
  `ports/index.ts`) documenting the off-path `incrementRuleUsage` contract's
  legacy provenance. No direct import anywhere.
- **`src/qa/learning/best-effort.ts`** — zero references anywhere in
  `qa-engine` (no import, no comment).
- **`src/integrations/publish.ts`** — referenced only in comments (in
  `vcs-write.adapter.test.ts` and `publication-port.adapter.test.ts`)
  documenting the legacy git-mechanics contract's provenance
  (`checkout -B → add → commit → push → createPullRequest`). No direct import
  anywhere.

**Correction of an earlier premise**: an earlier draft of this change's apply
instructions asserted all seven modules are "pinned as a parity/behavior oracle"
by four named test files. That claim is **only accurate for `labeler.ts`**
(confirmed above). The other six are excluded from this change's batches purely
because they fall outside the design's explicit Slice 8 (A–F) file list, not
because an active compiled guard blocks their deletion today. This distinction
matters for the follow-up change: `labeler.ts` needs its parity test
retired/re-pointed before deletion; the other six can be deleted directly once
someone confirms (as this document just did) that nothing imports them.
