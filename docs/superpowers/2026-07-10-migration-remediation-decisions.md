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
| 11 | Judgment Day round 2 — escape-scan rename-awareness fix, quote-aware parser fix, docs register | `3802521`, `66adf3e`, `44894b3` |
| 12 | Judgment Day round 3 — C-style quote-decoding fix (non-ASCII silent bypass) | (this commit) |

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

### Judgment Day round 3

A third adversarial review (two independent blind judges, round-3 pass over
the round-2 fixes) found one CRITICAL reproduced defect confirmed by both
judges: `stripQuotes` (`write-confinement.service.ts`'s `parseStatusOutput`)
stripped only the surrounding `"` git adds under `core.quotePath` (ON by
default) — it never decoded the C-style escaping *inside* those quotes. Under
the default config, `git status --porcelain` octal-escapes every non-ASCII
byte (`café.spec.ts` → `"caf\303\251.spec.ts"`) and backslash-escapes an
embedded literal `"` or `\` in the filename itself. The undecoded escape
sequence was then handed straight to the revert git calls
(`git clean -f -- "caf\303\251-leak.ts"`, `git restore -- ...`), which match
NOTHING on disk — `enforce()` reported the stray as reverted while the file
silently survived: a security-boundary bypass, reachable with any accented
filename, under git's own default configuration. Reproduced end-to-end with
real git fixtures (an untracked non-ASCII stray at repo root, and a tracked
non-ASCII file inside `e2e/` staged-renamed out of it) before fixing — both
showed the revert git call throwing an unmatched-pathspec error or silently
no-opping while the stray remained on disk. Fixed by decoding the full
C-style quoting inside `stripQuotes`: accumulate raw bytes (a literal
character contributes its own byte, `\NNN` an octal byte, `\"`/`\\`/`\t`/
`\n`/`\r`/etc. their single-byte meaning) and interpret the resulting byte
sequence as UTF-8 via `Buffer` — matching how git itself constructs the
escapes, so multi-byte UTF-8 sequences reconstruct correctly[^round3-claim].
An unquoted path passes through unchanged. All three `stripQuotes` call
sites (both rename sides and the plain-path fallback) route through the
same function, so the fix covers every consumer with no additional wiring.
Judge A's round-3 pass separately flagged an embedded-literal-quote filename
(a different escape shape than the octal non-ASCII case — git
backslash-escapes the `"` itself rather than octal-escaping a byte) as a
variant of the same class; an end-to-end real-git fixture confirms it too
now reverts correctly with the decoded literal path.

[^round3-claim]: **Correction (round 4 below):** this claim held only for
the octal-escaped path (`\NNN`); the literal-character branch still pushed
`ch.charCodeAt(0)` — a raw UTF-16 code unit as one byte — which is invalid
standalone UTF-8 for any non-ASCII character. A fourth adversarial pass
found this reachable under `core.quotePath=false` (git still quotes a path
for other reasons, e.g. an embedded space, but leaves non-ASCII bytes
literal inside the quotes instead of octal-escaping them), reproducing the
same revert-matches-nothing silent bypass. Fixed by encoding the literal
branch's real UTF-8 bytes (code-point-safe, so a surrogate pair isn't split
into two invalid lone-surrogate pushes); the "multi-byte UTF-8 sequences
reconstruct correctly" claim above is now actually unconditional. The
adjacent unrecognized-escape fallback (previously a silent best-effort byte
push, "never reached against real git output") was also converted to a
thrown, descriptive error per the CLAUDE.md "surface integration errors
loudly" invariant — `enforce()`'s existing fault-isolation catch
(`run-qa.use-case.ts`'s `enforceConfinement`) already logs it loudly and
records it in `gateSignals` without blocking the run. Regression tests: a
real-git fixture (`core.quotePath=false`, a stray needing quoting for an
embedded space plus a literal non-ASCII char) proving the file is actually
deleted from disk, plus parser unit tests for a literal non-ASCII char, a
literal 4-byte/astral character, and the unrecognized-escape throw.

Test count: 3873/3874 pass (1 pre-existing skip) after round 3;
3877/3878 after round 4's four additional tests — 4 new unit tests
(octal decode, embedded-quote/backslash decode, unquoted-unchanged, rename
sides decoded independently) plus 3 new real-git-fixture end-to-end tests
(untracked non-ASCII stray, tracked non-ASCII rename-out-of-`e2e/`, and the
embedded-quote judge-A variant). Never committed red: the new tests were
written and confirmed failing against the pre-fix `stripQuotes` first
(reproducing the exact silent-survival bug), then the fix turned them green,
per this branch's Strict TDD gate.

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

Executed as `sdd/migration-wiring-phase-2` — see the outcome register below.

## migration-wiring-phase-2 — Outcome (closeout, 2026-07-10)

The Phase 2 roadmap pointer above named its input backlog: this change
(`sdd/migration-wiring-phase-2`, branch `fix/migration-wiring-phase-2`)
worked that backlog down to 9 slices, 25 commits, gated green (`npm test` +
`npm run typecheck`, Node v24.11.0) after every commit, never committed red.

### Slices landed

| Slice | Content | Commit(s) |
|---|---|---|
| 1 | App-catalog wiring — webhook cross-repo resolution routed through `YamlAppConfigAdapter.resolveByRepo` (D-A) | `f0a77bf` |
| 2 | Mirror-gc — per-run bounded `git gc --auto` wired post-run (D-B) | `efddc19`, `bccd975` |
| 3 | contextMap read-back — per-run `e2e/.qa/context.json` read in `PreGenerationGroundingPortAdapter.ground()`, un-inerting the contracts component (D-C) | `0cc096d` |
| 4 | Skill-exemplar catalog restored into the generation prompt (D-E) | `8379da0`, rider `9e825a2` |
| 5 | `parentRunId` producer — threaded from `/continue`'s `RunRequest.parentRunId` into `publish()` (D-F) | `e16cf62` |
| 6 | `containsSecrets` made mode-aware (AMENDMENT 1) + both egress guards (diff→model, logs→Issue) wired | `0b4ae8d`, `9e825a2`, `e9cd6d8` |
| 7 | Redaction migration — env-value detection ported to the canonical adapter, all ~12 `util/redact.ts` shell consumers migrated, `redact.ts` deleted (D-D) | `e5c129a`, `f7472ea`, `f08e940`, `e075e30`, `7bd9b22` |
| 8 | Dead-code deletions — 22 files removed across 6 sub-batches (direct delete, re-point-then-delete, import-unblock-then-delete) | `381edef`, `33082dc`, `9f56e12`, `a3e522f`, `43d1332`, `c29c0e8`, `70e97d8` |
| 9 | Unstaged fs-level rename pairing (D-G, AMENDMENT 2) — closes the Judgment Day round 2 KNOWN LIMITATION | `518df70` |

### The security-gate round (post-apply adversarial pass, landed between Slice 7 and Slice 8)

A post-apply security review over the redaction migration's own surface
(Slice 7) surfaced and fixed one CRITICAL:

- **File-aware diff redaction (CRITICAL, fixed)**: `cappedDiffText` applied
  "model" mode's code-shape narrowing (`modelSkip`, WS5.4a) to the WHOLE
  diff, not per file. A diff touching a config file (`docker-compose.yml`,
  `.env`, CI YAML) alongside code files let unquoted lowercase-key
  credentials in the config hunk (`password: hunter2`, `token=Str0ng!Pass`)
  silently escape redaction that "issue" mode's aggressive, unnarrowed
  pattern would have caught. Fixed by splitting the capped diff at each
  `diff --git` header and picking the sanitize mode per file: "model" only
  for a known code extension, "issue" for everything else — each section
  guarded by `assertNoSecretLeak` under its own mode. `extractDiffFilePath`
  exported from `sanitizer.ts` so `prompts.ts` keys the mode off the same
  file-path parsing `capDiff` already does. Commit `f7ad67d`.
- **SecretLeakError swallow fix**: the best-effort explorer wrapper was
  catching and discarding every thrown error uniformly, including a thrown
  `SecretLeakError` from the egress guard (Slice 6) — silently laundering
  the exact fail-loud signal that guard exists to produce. Fixed to
  re-throw `SecretLeakError` specifically, never treating a blocked-secret
  event as an ordinary best-effort failure. Commit `924f2a4`.
- Doc correction: a stale `containsSecret` doc comment claimed no production
  call site existed — no longer true once Slice 6 wired it. Commit `55a612b`.

### Deferred-deletions completion

Both registers this document flagged as deferred/blocked-in-place at the
Phase 1 closeout are now **fully closed** by Slice 8:

- **7 originally-deferred DELETE items** (triage §1 DELETE list): `src/qa/
  source-map.ts`, `src/qa/measured.ts`, `src/qa/learning/labeler.ts` (parity
  test re-pointed to a frozen fixture snapshot before deletion, per its
  documented requirement), `src/qa/learning/reflector.ts`, `src/qa/learning/
  retrieval.ts`, `src/qa/learning/best-effort.ts`, `src/integrations/
  publish.ts` — all deleted.
- **4 newly-discovered blocked-in-place deletions**: `src/qa/learning/
  distiller.ts` (re-pointed — `isWellFormedTrigger` re-homed into `ledger-
  report.ts`), `src/qa/progress-gate.ts` (re-pointed — 13-sample fixture
  snapshot, fully retired from the parity tsconfig), `src/qa/selector-
  check.ts` (re-pointed — 39 samples across TWO independent parity pins, a
  third live importer discovered mid-batch beyond the documented one,
  flagged `size:exception`), `src/report/reporter.ts` (deleted after
  `publish.ts` unblocked it, per the documented dependency order) — all
  deleted/re-pointed.

Net: 22 files deleted, 9 files modified for re-pointing, 4580 lines removed /
224 inserted, 228 dead tests retired alongside their dead source
(3947→3719 passing, both gates green after every sub-batch).

### Register items — closed vs still open

**Closed by Phase 2**:
- Triage §2 WIRE: `contexts/app-catalog/**` (Slice 1), `workspace-and-
  publication/infrastructure/mirror-gc.adapter.ts` (Slice 2).
- Triage §5 open item 4: contextMap read-back (Slice 3) — the `context-pack`
  contracts component is no longer permanently inert.
- Triage §5 open item 7: skill-exemplar catalog (Slice 4).
- This document's "1 newly-identified producer gap" (item 5, `parentRunId`,
  Slice 5).
- This document's "1 newly-identified pairing gap" (item 6, unstaged
  fs-level rename pairing, Slice 9) — see `write-confinement.service.ts`'s
  `classifyStrays` doc comment, now updated to describe the fix.
- D6's deferred `util/redact.ts` unification (Slice 7) — the duplicate
  mechanism no longer exists; every consumer migrated to the canonical
  `RedactionPortAdapter`, placeholder collapsed to `[REDACTED]` per D7.

**Annotation (judgment-day round 1, scoping the "no detection class lost"
claim)**: `sanitizer.ts`'s comment above `envSecretValues`/
`MIN_ENV_SECRET_LEN` ("nothing redact.ts already caught is lost when a
consumer migrates") is accurate **only** for the env-value-driven mechanism
it describes — env-value stripping catches an own-process secret verbatim
regardless of length, matching `redact.ts`'s `MIN_SECRET_LEN` floor exactly
(6). It does **not** extend to the STRUCTURAL bare-token patterns in
`NAMED_SECRET_PATTERNS`: `github-token`/`github-token-fg` require `{36,}`
chars where `redact.ts`'s equivalent patterns required only `{10,}`, and
`llm-api-key` requires `{20,}` where `redact.ts` required `{10,}`
(`slack-token` is unchanged at `{10,}`). This narrowing is deliberate, not
accidental: every real GitHub token is 40 chars and every real OpenAI/
Anthropic key is far longer than 20, so the wider floors keep the patterns
off short hyphenated identifiers that would otherwise false-positive.
Nothing is lost for any real token of either class — the only thing the
structural pattern no longer flags is the theoretical space of
implausibly-short 10–19-char strings that happen to start with `ghp_`/`sk-`
but match no real credential shape either provider issues. Env-value
stripping remains the floor-independent backstop for the migrated shell
consumers' own-process tokens of any length, so the egress boundary is not
weakened — only the structural pattern's blast radius for hypothetical
short strings is narrower than `redact.ts`'s, by design.

**Still open (out of Phase 2's scope, unchanged)**:
- Triage §2 DECIDE: `qa-run-orchestration/domain/run.aggregate.ts` (DELETE,
  not actioned) and `shared-kernel/ports/clock.port.ts` (DELETE, not
  actioned).
- Triage §2 WIRE: `generation/infrastructure/{context-assembler,
  exploration-brief,plan-parser}.adapter.ts` — still gated on the reserved
  `workerId` parallel fan-out (documented in CLAUDE.md as future, not
  abandoned); Phase 2 did not touch this cluster.
- D8 — learning-store duality (`src/server/history.ts` vs. qa-engine's
  native `SqliteLearningRepository`) remains two separate stores by
  deliberate decision; Phase 2 did not converge them.
- Triage doc §4 Tiers 1-4 (the bulk of remaining `src/` migration scope) —
  entirely out of Phase 2's scope, which targeted wiring gaps and
  Tier-0-adjacent cleanup, not the tiered migration itself.
- `context-cache.ts` (the 38-line read-back cache) — design D-C deliberately
  descoped re-porting it: `context.json` is committed to the app repo's
  `e2e/` in context-mode PRs, so a normal `git checkout` already restores it
  for free; the cache only helps shadow apps where `context.json` is never
  committed. Recommendation stands: measure residual shadow-rebuild waste
  before re-porting a speculative cache.

**New follow-up flagged (not fixed in Phase 2 — docs-only closeout, no code
change)**:

- **Typed-declaration-initializer sanitizer gap**. `NAMED_SECRET_PATTERNS`'s
  `api-key-assignment` pattern (`sanitizer.ts`) is `(?:api[_-]?key|token|
  secret|password|passwd|pwd)[\"']?\s*[:=]\s*\S+`, global. On a TypeScript
  typed declaration with an initializer on ONE line — e.g.
  `const secret: string = "hunter2ActualSecretValue123";` — the match
  consumes only up through the type token (`secret: string`), since `\S+`
  stops at the first whitespace; the regex engine's `lastIndex` then resumes
  scanning AFTER that match, and the real initializer (`= "hunter2..."`)
  is never re-matched because no keyword immediately precedes it. Verified
  empirically against the live adapter: in `"issue"` mode, the (harmless)
  type-annotation span is redacted to `[REDACTED]` while the actual secret
  value survives verbatim in the output text; in `"model"` mode, `modelSkip`
  additionally recognizes `string` as a type (not a secret value) and skips
  the match entirely, leaving the WHOLE line — secret included — completely
  untouched. The Slice 6 post-redaction `containsSecrets` egress guard does
  **not** catch this either: it re-runs the identical pattern set against
  the already-redacted text, and the leaked value has no adjacent keyword
  left to re-trigger the pattern (confirmed:
  `containsSecrets(sanitizeText(line, "issue").text, "issue")` returns
  `false` even though the raw secret is present verbatim in that text).
  Scope for the fix: extend the pattern (or add a dedicated typed-
  declaration-initializer pattern) to also scan past a type annotation for
  a trailing `= <value>` on the same match, in both `sanitizeText` and
  `containsSecrets` so they stay symmetric. Flagged here as a follow-up for
  the next `migration-cleanup`-class change — not actioned in this
  docs-only closeout slice.

### Judgment Day round 1

An adversarial review of `sdd/migration-wiring-phase-2` (two independent
blind judges) found two confirmed defects (both judges agreed on each) and
fixed both on `fix/migration-wiring-phase-2`, gated green after every
commit (`npm test` + `npm run typecheck`, Node v24.11.0), never committed
red:

- **Mirror-gc coverage gap** (confirmed by both judges): Slice 2's
  `pruneMirrorIfWired` wiring covered the mainline exit, the
  `terminalResult()`-routed exits (invalid/infra-error), and both skip
  exits (classify-skip, agent-no-op) — but every POST-prepare
  `abortedResult()` exit (10 call sites throughout `run()` — a cancelled
  run, `cancelTrackedRun` is a documented feature, can be observed mid-run
  at ANY phase-boundary `signal?.aborted` check) and the two bare
  `infraErrorResult()` exits (setup failure, empty/unparseable generation)
  never pruned their mirror, even though `workspace.prepare()` had already
  checked it out by the time they fire. Fixed by threading an optional
  trailing `mirrorDir` through both `abortedResult()`/`infraErrorResult()`,
  mirroring `terminalResult()`'s existing pattern: every POST-prepare call
  site now threads `workspace.mirrorDir`; the two genuinely PRE-prepare call
  sites (the already-aborted-before-start short-circuit, the deploy-gate
  infra-error) correctly stay excluded — their mirror was never touched.
  4 new TDD tests (`run-qa.use-case.test.ts`, "mirrorGc wiring (batch 3)").
  Commit `ad2d567`.
- **Webhook robustness gap** (confirmed by both judges, two independent
  sub-findings): (a) `src/index.ts`'s `req.on("end")` handler awaited
  `resolveWebhookDispatch` with no try/catch — a throw became an unhandled
  rejection inside the listener, `res` never ended, and GitHub's webhook
  delivery hung to its own timeout with zero runs enqueued (the adjacent
  per-dispatch `enqueueApiRun` call already had this error boundary; the
  dispatch-resolution call one line earlier did not). (b)
  `YamlAppConfigAdapter.resolveByRepo`'s `configs.map(App.fromConfig)` had
  no per-config fault isolation — one config failing the `App` aggregate's
  own invariants (which `app.aggregate.ts`'s own RIDER 3 comment documents
  can drift from the mirrored zod refine rules, and the adapter's
  `ConfigLoaders` interface has no compiler guarantee every implementation
  even routes through zod) threw for the ENTIRE catalog, blocking webhook
  dispatch for every OTHER, healthy app — the layer above
  `config-loader.ts`'s existing per-FILE isolation had none of its own.
  Fixed (a) by wrapping the dispatch resolution in a try/catch mirroring
  the adjacent `enqueueApiRun` pattern (log + 500 + return); (b) by
  isolating `App.fromConfig` per-config inside `resolveByRepo` with an
  injected skip-and-log callback (`ConfigSkipLogger`, defaulting to a
  qa-engine-local `console.warn` since qa-engine cannot import `src/`),
  mirroring `config-loader.ts`'s own per-file skip-and-log posture one
  layer up. 2 new TDD tests (`yaml-app-config.adapter.test.ts`). The HTTP
  500 path added in `src/index.ts` itself has no test coverage — `index.ts`
  runs side effects at import time (HTTP server creation, API-token file
  writes) and has never had test coverage for exactly that reason (see
  `webhook-routing.ts`'s own header comment, which is why the dispatch
  *resolution* logic was already extracted into a separately-testable
  module before this fix). Commit `3bf85a6`.
