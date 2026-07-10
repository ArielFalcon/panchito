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
`rewritten-engine-factory.ts` (local git ops only, no auth decoration).

**Amended for multi-point enforcement** (the original design called `enforce()`
once, immediately before publish, on the assumption that `git status` is
cumulative and one check after all agent + FixLoop turns catches everything —
that single-point call has since been superseded by the shipped behavior
below and this paragraph documents the actual, current contract, not the
earlier draft). `RunQaUseCaseDeps.confinement.enforce()` is now invoked after
EVERY agent-write-capable turn — after the initial `generate()` call, after the
W1 corrective regen, after each static-fix repair round, after each FixLoop
regeneration round, after the enforce-mode coverage-gap regen, and after the
reviewer-correction regen — **in addition to** immediately before both publish
sites (e2e and code). Each call's result is merged (summed counts, concatenated
`reverted` list) into one `gateSignals.confinement` for the run
(`confinementAcc` in `run-qa.use-case.ts`), so the reported signal still
reflects the run's cumulative confinement activity even though enforcement now
runs at many points instead of one.

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

**Sanitize placement**: `render-publication.ts` is PURE and has no sanitizer
dependency — every field it composes markdown from is caller-supplied,
already-untrusted text. The caller (`publication-port.adapter.ts`) sanitizes
the WHOLE composed body string returned by `renderIssue`/`renderPrBody` in one
pass before it reaches GitHub, rather than threading a sanitize callback
through every render helper — this satisfies the spec's "every rendered field
passes the injected sanitizer" requirement while keeping the domain file
testable with zero collaborators.

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

## D9 — nav-gate triage DECIDE resolved as DELETE (Slice 8.C)

**Decision**: resolves triage doc §1's nav-gate DECIDE item. Accept the
`reexploreNavigations` threshold mitigation already live in
`qa-run-orchestration/domain/pre-exec-grounding.service.ts` as sufficient
coverage, and delete both legacy nav-gate copies — `src/qa/nav-gate.ts` and
the qa-engine `test-execution/domain/nav-gate.service.ts` — with no
canonical `qa-run-orchestration/domain/helpers/nav-gate.ts` port needed.
Unlike progress-gate/selector-check, nav-gate has no helpers/ successor
because the mitigating logic already lives in `pre-exec-grounding.service.ts`
rather than a standalone gate module. Retires `nav-gate-parity` (the
test-execution/domain pin) from `tsconfig.parity.json`.

**Deviation discovered while executing Slice 8.C**: the design's Batch C plan
assumed `src/qa/progress-gate.ts` and `src/qa/selector-check.ts` could be
deleted while their **canonical** `qa-run-orchestration/domain/helpers/
{progress-gate,selector-check}-parity.test.ts` pins "STAY" — but those
surviving canonical parity tests themselves import the legacy `src/qa/
{progress-gate,selector-check}.ts` files as their byte-for-byte comparison
target (`legacyProgressGate`/legacy selector-check exports). Deleting the
legacy files would have broken the very pins the design says must survive.
Resolution: `src/qa/progress-gate.ts` and `src/qa/selector-check.ts` (plus
their colocated tests) are **not deleted** in this batch — only the OLD
qa-engine `test-execution/domain/{progress-gate,selector-check}.service.ts`
copies and their own OLD parity/unit tests are removed, matching what the
design actually intends by "consolidate to canonical helpers/ copies." A
future cleanup can re-point `helpers/{progress-gate,selector-check}-parity
.test.ts` onto an inline/frozen legacy snapshot (or retire them once nothing
else needs the byte-for-byte guarantee) before deleting the `src/qa/` files.
`src/qa/selector-check.ts` has a second, independent reason to survive:
`src/qa/execute.test.ts` imports `selectorPresent` from it directly.

## D10 — src/report/reporter.ts survives Slice 8.F (deviation)

**Decision**: `src/qa/confinement.ts` is deleted as designed (superseded by
Slice 3's `write-confinement.adapter.ts`; its only pin,
`write-confinement-parity.test.ts`, is retired in the same commit). But
`src/report/reporter.ts` — the other file Batch F's plan called for deleting
— is **not deleted**. `src/integrations/publish.ts` (itself dead code: no
importers anywhere, confirmed in the "Deferred deletions" register below)
still has a real, compiled import: `import { renderPrBody, type TestedItem }
from "../report/reporter"`. `publish.ts` is explicitly out of this change's
scope (deferred to the same follow-up migration-cleanup change as the other
six items below) — deleting `reporter.ts` while leaving `publish.ts` in the
tree would break `npm run typecheck` on a dangling import, violating the
"never commit red" rule. `src/report/reporter.test.ts` stays for the same
reason. `sanitize-text-parity` is unaffected either way (it does not pin
`reporter.ts`). The follow-up cleanup change should delete `publish.ts` and
`reporter.ts`/`reporter.test.ts` together, in that dependency order.

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

## Outcome (Slice 9 closeout, 2026-07-10)

### What landed

**Commit count correction**: this section previously claimed "18 commits" —
`git rev-list --count main..HEAD` at the end of Slice 9 (before the Judgment
Day round documented below) actually counts **17**. With the 2 fix commits
from the Judgment Day round 1 review appended, the branch stood at
**19 commits** on `remediation/migration-phase-1`. With the 2 fix commits +
this docs commit from the Judgment Day round 2 review (below) appended, the
branch now stands at **22 commits**, every one gated green independently
(`npm test` + `npm run typecheck`, Node v24.11.0):

| Slice | Content | Commit(s) |
|---|---|---|
| 1 | This decisions doc (D1-D8) | `5568f2b` |
| 2 | Publish-excludes leak + anchoring fix (D1) | `b0cf28f` |
| 3 | Write-confinement wiring (D2) | `8f8a9f3`, `2d937d1` |
| 4 | Publication rendering restore + `tested` metadata (D3) | `895180e` |
| 5 | Process-audit reconnect (D4, D5) | `edebb92` |
| 6 | RedactionPort unification, canonical `[REDACTED]` (D6, D7) | `b775fd9` |
| 7 | `fitRulesToBudget` parity + context-mode publish scope | `3632e3c`, `3bae1b2` |
| 8 | Tier-0 dead-code cleanup, 6 batches (A1/A2 split, B, C, D, E, F) | `9bef64c`, `5b423f9`, `3b59b90`, `c3f6d3f`, `2f614e4`, `989e401`, `34cb08c` |
| 9 | Closeout — CLAUDE.md accuracy pass, triage doc status flips, this section | `c367b8d` |
| 10 | Judgment Day round 1 — rename over-revert fix + docs/tsconfig cleanup | `04a2f42`, `74524bf` |
| 11 | Judgment Day round 2 — escape-scan rename-awareness fix, quote-aware parser fix, docs register | `3802521`, `66adf3e`, (this commit) |

### Judgment Day round 1

An adversarial review (two independent judges + `sdd-verify`) found one
CRITICAL, reproduced defect and a confirmed documentation/cleanup batch:

- **Staged-rename over-revert** (CRITICAL): `write-confinement.service.ts`'s
  `parseStatusOutput` collapsed a `git status --porcelain` rename/copy line
  (`R  old -> new`) into ONE record keeping only the new path.
  `write-confinement.adapter.ts`'s `enforce()` then reverted only that path,
  and since HEAD has no `<new>`, the staged rename degraded into an orphaned
  staged DELETION of `<old>` — the legitimate file vanished from disk and
  would have been committed as deleted by the next publish. Reproduced with a
  real git fixture (`git mv e2e/foo.spec.ts stray.spec.ts` → `enforce()` →
  `D  e2e/foo.spec.ts`, file missing from disk). Fixed by emitting BOTH sides
  of a rename as independent, cross-referenced records and reverting them as a
  unit when either side is a stray (commit `04a2f42`).
- **Documentation/cleanup batch**: stale illustrative comments
  (`[REDACTED_SECRET].java` → `[REDACTED].java`), a present-tense
  `containsSecret` doc claim with no production call site, dead `tsconfig.json`
  exclude entries for deleted parity tests, and the corrections recorded
  throughout this section (D2 multi-point enforcement, the `parentRunId`
  producer gap, the commit-count recount, the D3 sanitize-placement note).

Test count: 4303/4304 pass (1 pre-existing skip) at the end of Slice 7 →
3853/3854 pass (1 skip) at the end of Slice 8 — net -450 dead tests retired
alongside their dead source, consistent with the volume of Slice 8 deletions.
Never committed red at any point; every deviation below was caught by `rg`
pre-checks or `npm run typecheck` before the commit, not after.

### Judgment Day round 2

A second adversarial review (two independent blind judges, round-2 pass over
the round-1 fix) found one CRITICAL reproduced defect confirmed by BOTH
judges and one additional confirmed-by-both parser defect, plus a set of
pre-existing/deliberate items the judges surfaced that were investigated and
resolved as documentation, not code changes:

- **Escape-scan not renameCounterpart-aware** (CRITICAL, confirmed by both
  judges, reproduced): `write-confinement.adapter.ts`'s symlink-escape scan
  destructured only `{ xy, path }` from each parsed change, dropping the
  `renameCounterpart` field the round-1 fix added (`04a2f42`). When an
  escape-detected path was one side of a staged rename fully inside the
  allowed area (e.g. a committed symlink inside `e2e/` whose target escapes
  the mirror, staged-renamed to another name still inside `e2e/` —
  `classifyStrays` correctly leaves such a pair alone since neither side is a
  stray under the allowlist), the scan pushed ONLY the escape-detected path
  into the revert bucket. Reverting that one path orphaned the other side's
  staged half — the identical destructive pattern round 1 fixed, reopened via
  the escape scan's own separate code path. Reproduced with real git fixtures
  (a staged rename of an escaping symlink, both e2e- and code-target) and
  fixed by extracting `WriteConfinementService.revertUnit` as the single
  source of truth for "which paths revert together", shared by both
  `classifyStrays` and the escape scan so the two mechanisms cannot drift
  apart again (commit `3802521`).
- **Non-quote-aware rename-arrow parsing** (confirmed by both judges):
  `parseStatusOutput`'s `rest.indexOf(" -> ")` first-match split broke when
  the OLD path of a rename was itself C-style-quoted by git AND that quoted
  path literally contained `" -> "` (git quotes such a path specifically to
  disambiguate it from the porcelain rename separator — confirmed against
  real git output before fixing). The naive search split inside the quoted
  span instead of at the real separator after it, garbling both sides and
  producing an invalid pathspec at revert time. Fixed by making the split
  quote-aware: when the line opens with a quote, scan for its matching
  unescaped closing quote first (respecting backslash escapes), then require
  the arrow immediately after it (commit `66adf3e`).

**Items investigated and resolved as documentation (no code change; contradictions
resolved by orchestrator reproduction against a real git fixture, not by judge
consensus alone)**:

1. **KNOWN LIMITATION** (pre-existing, legacy-parity): an UNSTAGED fs-level
   rename — the shape the agent's own moves take, since it has no git access —
   surfaces as two independent porcelain lines (` D e2e/old.spec.ts` in-area,
   `?? stray.spec.ts` out-of-area) with no `renameCounterpart` to pair them.
   The out-of-area stray is correctly cleaned (content destroyed); the in-area
   unstaged deletion is NOT restored, so it survives to `git add -- e2e` at
   publish. Deliberately NOT fixed in this change: unconditionally restoring
   every in-area unstaged deletion would over-revert a legitimate agent
   deletion (exhaustive mode deliberately deletes stale specs) — pairing
   without git's own rename detection is guesswork, not a safe default.
   Registered as a Phase 2 DESIGN item below (options: content-similarity
   pairing, restore-then-let-reviewer-arbitrate, or publish-time deletion
   review) and documented in `write-confinement.service.ts`'s `classifyStrays`
   doc comment.
2. **DELIBERATE**: a reverse-direction stray rename (old side already an
   out-of-area stray, new side in-area) reverts BOTH sides, not just the old
   one — a conservative whole-transaction discard. Agent-authored in-area
   content is reconstructible by a re-run; committed content is not, so the
   asymmetry favors the side that can't be regenerated.
3. **DELIBERATE**: `strays`/`reverted` count BOTH halves of a reverted rename
   pair (2, not 1) — this is a telemetry-only field; no gate or decision logic
   reads it, so double-counting a rename's two filesystem effects is accurate
   bookkeeping, not a bug.
4. **INFO**: `C` (copy) status lines are unreachable under this deployment's
   default git config — no `status.renames=copies` setting exists anywhere in
   the codebase or Docker images. The unit-revert logic (`revertUnit`,
   `classifyStrays`) already covers `C` lines identically to `R` lines should
   that config ever be enabled; no action needed today.

### Consolidated deferred/blocked register (13 items, all flagged for the same follow-up `migration-cleanup` change)

**7 originally-deferred DELETE items** (triage §1 DELETE list, intentionally
excluded from this change's Slice 8 batch list — see the register above):
`src/qa/source-map.ts`, `src/qa/measured.ts`, `src/qa/learning/labeler.ts`
(the one genuine parity-pinned oracle — needs `error-class-parity.test.ts`
retired/re-pointed before deletion), `src/qa/learning/reflector.ts`,
`src/qa/learning/retrieval.ts`, `src/qa/learning/best-effort.ts`,
`src/integrations/publish.ts`.

**4 newly-discovered blocked-in-place deletions** (Slice 8's task list called
for deleting these; each survived with a documented reason found while
executing):

1. `src/qa/learning/distiller.ts` (Slice 8.B) — kept; `src/qa/learning/
   ledger-report.ts` imports `isWellFormedTrigger` from it via a same-directory
   relative import, invisible to a cross-file substring grep. Not previously
   assigned a D-number; recorded here.
2. `src/qa/progress-gate.ts` (Slice 8.C) — kept; the surviving canonical
   `helpers/progress-gate-parity.test.ts` pin imports it as its legacy
   comparison target. See D9.
3. `src/qa/selector-check.ts` (Slice 8.C) — kept; same canonical-pin reason as
   #2, plus `src/qa/execute.test.ts` imports `selectorPresent` from it
   directly. See D9.
4. `src/report/reporter.ts` (Slice 8.F) — kept; `src/integrations/publish.ts`
   (deferred item #7 above) has a real compiled import of it. See D10.

**Dependency note for the follow-up change**: deleting `publish.ts` (deferred)
unblocks `reporter.ts` (blocked) — delete them together, `publish.ts` first,
so `npm run typecheck` never sees a dangling import mid-sequence.

**1 newly-identified producer gap** (not a deletion — a wiring gap surfaced
while auditing D3 for this closeout):

5. `parentRunId` has a consumer but no producer. `render-publication.ts` and
   `PublicationPort.publish()` (`qa-run-orchestration/application/ports/
   index.ts`) both accept an optional `parentRunId` for continuation
   provenance, and `publication-port.adapter.ts` forwards it when present —
   but `RunQaInput` carries no `parentRunId` field today, so nothing upstream
   ever sources one; every call site passes it as omitted (see the "KNOWN GAP"
   comments at `run-qa.use-case.ts` and `ports/index.ts`, legacy parity:
   `src/report/reporter.ts`'s `PrBodyInput.parentRunId`, `src/server/
   runner.ts`'s own parentRunId chain). Wiring a real producer (deriving or
   threading a parent run's ID into `RunQaInput` for regeneration/continuation
   runs) is follow-up scope, not this change's.

**1 newly-identified pairing gap** (Judgment Day round 2, investigated and
deliberately not fixed in this change — see that section's item 1 above):

6. Unstaged fs-level renames (the shape the agent's own moves take, since it
   has no git access) are not paired by `classifyStrays`: they surface as an
   independent in-area unstaged deletion plus an out-of-area untracked stray,
   with no `renameCounterpart`. The out-of-area stray is cleaned; the in-area
   deletion survives to `git add -- e2e` at publish. Candidate approaches for
   the follow-up change: content-similarity pairing, restore-then-let-
   reviewer-arbitrate, or publish-time deletion review — not decided here,
   since a wrong default risks over-reverting a legitimate agent deletion
   (e.g. exhaustive mode's deliberate stale-spec cleanup).

### Phase 2 roadmap pointer

The remaining migration scope for live `src/` code (triage doc §4, Tiers 1-4)
and the still-open items in §5 (`context-cache`/contextMap read-back,
`run.aggregate.ts`, skill-exemplar catalog) — plus the 13-item deferred/blocked
register above — are the input backlog for a future `migration-cleanup` (Phase
2) SDD change. This stabilization change's job was fixing the P0-P2 regression
backlog and reconnecting existing sinks (done, table above); restructuring
persistence, finishing the Tier 1-4 migration, or reopening the still-open
`src/` DECIDE items is deliberately out of scope here (see D8's reasoning,
which generalizes to the rest of this register).
