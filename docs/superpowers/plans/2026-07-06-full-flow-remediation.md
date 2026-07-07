# Plan: Full-Flow Remediation (2026-07-06 audit)

Source: adversarial audit of the diff-mode run flow (E2E + code) at HEAD `62b6bb4`, persisted
in engram topic `audit/2026-07-full-flow-logic` (#1114). Every problem detected is addressed
below. Each item states the problem (with evidence anchor), the chosen solution, **why that
solution is correct** (argued against alternatives), and its **trade-offs**.

## Ground rules (invariants this plan must not break)

- `unknown` coverage NEVER blocks; `DecideCoverageService.blocks()` stays the single source.
- Sequential queue; one run at a time.
- LLM agents stay read-only on watched repos; only the orchestrator writes git.
- Root-cause, app-agnostic fixes only — nothing shaped to make a configured app pass.
- Anti-Goodhart: LLM authors candidate rules only; promotion is objective-signal-only.
- Approved + zero specs = valid `skipped`.
- Every slice lands with a pinning test (strict TDD where the harness supports it) and must
  keep `npm test` + `npm run typecheck` green.

Priorities: **P0** = trust-critical (the system lies about its own state), **P1** = value
leaks (correct data computed, wrong/no consumer), **P2** = quality improvements, **P3** =
hygiene/docs.

---

## WS1 — Learning governance (P0)

The flywheel injects rules but cannot learn from consequences. Until this workstream lands,
rule injection runs ungoverned; that inverts the anti-Goodhart design.

### 1.1 Fold id/trigger mismatch (fold is a silent no-op)

**Problem.** `run-qa.use-case.ts:476` persists `rulesRetrieved` as trigger TEXT (`RetrievedRule`
at `ports/index.ts:399-405` has no `id`); the factory fold (`rewritten-engine-factory.ts:248,258`)
treats each element as a rule ID; `history.ts:705-706` misses every row and returns silently.
`outcomeCount` is frozen at 0 forever — promotion/demotion never fire.

**Solution.** Add `id: string` to `RetrievedRule`; persist rule IDs in `RunOutcome.rulesRetrieved`
(keep the field name; change content to IDs, matching the legacy `retrievedRuleIds` contract the
inline comment already claims). Fix the misleading comment at `:464-469`. Update
`rewritten-engine-factory.test.ts:728`-area tests to feed the SAME shape the use-case actually
produces (one integration-honest test that walks retrieve→persist→fold across the real seam).
Add a telemetry `console.warn` in `recordRuleOutcome` when a folded ID misses (should be rare
post-fix; today it is 100% and silent).

**Why this is correct.** The alternative — make the fold look up by trigger text — builds
governance on a non-unique, non-stable key (WS1.3 shows trigger text currently has NO dedup, so
two rules can share a trigger; text also changes under normalization). IDs are the ledger's
primary key; the projection dropping them was the bug, not the fold's key choice. The proof:
`incrementRuleUsage` works today precisely because it uses IDs captured before the projection
(`learning-port.adapter.ts:63-68`).

**Trade-offs.** Historical `RunOutcome` rows hold trigger text; the fold already tolerates
misses, so mixed history is inert (old rows simply never fold — same as today). No migration
needed; document the semantic change in the field's doc comment.

### 1.2 Reflect-on-green (reflector fires on every clean pass)

**Problem.** `shouldDistillLearning(false,"pass",undefined) === true` and the reflect gate
(`run-qa.use-case.ts:1506-1514`) only excludes flaky/E-INFRA/E-FLAKY. Every green run burns a
reflector session against a failure-framed prompt ("why this run failed") and mints an
unfalsifiable `errorClass:""` candidate. With newest-first ranking these crowd the 20-slot
injection budget. The `toReflectionInput` comment (":1596-1602") claims a non-null class for
every reachable verdict — false for `pass`.

**Solution.** Add `mainlineOutcome.errorClass != null && mainlineOutcome.errorClass !== ""` to
the reflect gate (both fold sites' reflect blocks; the terminal site is already
`invalid`-gated). Add the missing `pass` row to the suppression-matrix tests. Fix the false
invariant comment. Do NOT touch fold-on-green (prevention credit on clean runs is the designed
promotion signal).

**Why this is correct.** Reflection is failure-reflection by contract (the adapter's prompt is
built exclusively around failure evidence). Gating on "a qualifying failure class exists" is the
minimal predicate that excludes green runs while keeping every failure class the matrix already
pins (E-STATIC/invalid keeps teaching). Gating on verdict alone (`verdict !== "pass"`) would be
wrong the other way: a `pass` after FixLoop retries still has no terminal failure class, and a
future verdict type could silently leak again — the errorClass predicate is the actual semantic.

**Trade-offs.** If legacy genuinely reflected on green too, this diverges from legacy parity —
deliberately: green reflections are unfalsifiable noise (`preventionOutcome` can never score an
empty class), so parity would preserve a defect. Declare the divergence in the commit message.

### 1.3 Reflector save bypasses the distiller (no dedup / normalization / caps)

**Problem.** `reflector-port.adapter.ts:182-198` builds rules inline; `distillReflection`
(`src/qa/learning/distiller.ts:74-98`) has zero callers. Lost with it: exact-text `ruleKey`
dedup, the anti-respawn guard (dedup against deprecated/superseded — a demoted pattern can
respawn as a fresh candidate, defeating demotion), `normalizeTrigger`, and the 400-char field
caps (unbounded LLM text flows into SQLite and future prompts).

**Solution.** Port the distiller's pure logic (`ruleKey`, `normalizeTrigger`, field caps,
anti-respawn check against ALL statuses including deprecated/superseded) into
`qa-engine/src/contexts/cross-run-learning/domain/` as a `distill-rule.ts` domain service
(byte-faithful port + parity test against the legacy module, same pattern as `rule-fold.ts`),
and route `ReflectorPortAdapter`'s save through it. The repository gains a
`findByRuleKey(app, key)` lookup (or reuse `listLearningRules` with an in-adapter filter — pick
whichever avoids widening the port for one caller; the adapter already receives the repo).

**Why this is correct.** The logic already exists, is battle-tested, and is exactly what the
"known limitation: exact-text ruleKey" memory assumed was still active. Reimplementing dedup
fresh would re-derive the same edge cases (respawn-after-demotion) the legacy already solved.
Porting (not cross-importing) respects the qa-engine-first boundary.

**Trade-offs.** Exact-text dedup remains weak against paraphrase (two wordings of one root
cause coexist) — accepted, documented; semantic dedup stays a follow-up. Anti-respawn means a
genuinely-new lesson that happens to normalize onto a deprecated rule's key is suppressed —
correct bias: demotion must be sticky.

### 1.4 Attribution smearing (prerequisite for enabling promotion safely)

**Problem.** With 1.1 fixed, the fold credits/blames ALL ~20 retrieved rules equally.
`attributableRules` (`rule-fold.ts:108`) has zero callers and `archetype` is always null
(`reflector-port.adapter.ts:187`), so archetype filtering would be a universal keep. With
`PREVENTION_HELD_SCORE === PROMOTE_RATE (0.6)`, three clean runs promote ANY co-retrieved rule.

**Solution.** Two parts (promotion must not go live without them). NOTE ON SCOPE (judgment-day,
both judges): part (b) is NOT a pure-function tweak — `nextStatus`/`applyOutcome` (`rule-fold.ts`)
are stateless single-call functions and `LearningRule` (`cross-run-learning/application/ports/
index.ts:26-40`) carries no memory of whether any past outcome was oracle-scored. Gating
candidate→active on "≥1 oracle-scored outcome ever" therefore requires a NEW persisted per-rule
flag: a `learning_rules` column (`src/server/history.ts`, `ALTER TABLE ADD COLUMN` — the same
migration pattern already used twice for `outcome_count`/`archetype`), threaded through
`recordRuleOutcome` → `applyOutcome`/`nextStatus`. This makes 1.4 its OWN PR-sized slice under the
400-line budget, NOT folded into 1.1. Sequencing is unchanged (1.1 still blocks 1.4).
(a) `preventionOutcome` credit only applies to rules whose `errorClass` is non-empty (ties into
1.2 — empty-class rules can neither earn nor lose); (b) once the flag exists, gate the
candidate→active transition on it being set (an oracle-scored outcome, `valueScore !== null`
path) — prevention-only evidence can raise confidence but never flip status. Add a test pinning
the constant relationship (`PREVENTION_HELD_SCORE` alone < promotion bar without the oracle flag).
Wire `attributableRules` into the factory fold once archetypes exist (1.5) — until then the
errorClass match inside `preventionOutcome` is the attribution filter.

**Why this is correct.** "Promotion is objective-signal-only" is the project's own stated
invariant; prevention credit is a *derived* signal (absence of a failure class), not an
objective observation of the rule working. Requiring one oracle observation before `active`
makes the reviewer-visible tier evidence-based by construction. The alternative — lowering
`PREVENTION_HELD_SCORE` below the rate bar — is a magic-number fix that silently breaks the
day someone retunes either constant.

**Trade-offs.** Apps where the value oracle rarely runs (non-node code apps; e2e runs where
fault-injection is off) will accumulate high-confidence candidates that never promote — the
reviewer never sees them. Accepted: `active` is a privilege tier; candidates still reach the
generator. Slower flywheel spin-up is the cost of a trustworthy `active` set.

### 1.5 Reviewer-corrections learning channel dead + archetype always null

**Problem.** `gateSignals.reviewerCorrections` is hardcoded `[]` (`run-qa.use-case.ts:1699`;
documented gap in `error-class.ts:18-23`), so E-FALSE-POSITIVE/E-WRONG-OBJECTIVE/
E-FRAGILE-SELECTOR/E-NO-CLEANUP/E-REVIEWER-REJECTED are underivable and the reflection prompt's
reviewer-corrections section never renders. `distillReviewerCorrections` has zero callers.

**Solution.** Thread the review loop's final `reviewResult.corrections` (already in scope in
the mainline path) into `gateSignals.reviewerCorrections` when the reviewer rejected. Derive
`archetype` from the resulting error class (legacy mapping in `distiller.ts` /
`learning-rule.ts` — port alongside 1.3). Route reviewer-rejection outcomes through the ported
distiller's corrections channel (same governance: candidate/low only).

**Why this is correct.** Reviewer rejections are the highest-precision teaching signal the
system has (a second model with independent grounding naming the exact defect). The error-class
derivation infrastructure already branches on these classes; the data is computed and discarded
one function away from its consumer — the audit's core pattern. Closing it via the existing
legacy channel (ported) inherits its tested semantics.

**Trade-offs.** Slightly couples the review phase to learning (one field threaded). Corrections
text is LLM output — the distiller's caps/normalization (1.3) bound it. No promotion-path
change: these rules still earn `active` only via 1.4's oracle gate.

### 1.6 Terminal fold dead weight (minor)

**Problem.** Terminal outcomes always carry `rulesRetrieved: []` (`:1721,:1992`), so the
terminal `learning.fold()` is a structural no-op (factory early-returns on empty).

**Solution.** Thread `retrievedRuleTriggers`→IDs (post-1.1) into terminal outcomes the same way
the mainline does — an `invalid` run in which retrieved rules failed to prevent E-STATIC is
legitimate fold evidence.

**Why.** Consistency: the suppression matrix already declares `invalid` teachable; today it
teaches reflection but not the fold, which is an accidental (not designed) asymmetry.
**Trade-off.** None meaningful — same guard rails as mainline.

### 1.7 engram self-memory bypasses governance

**Problem.** `qa-generator` writes free-form lessons to engram (no status/outcome/veto); a
vetoed ledger rule can live on as an agent memory. Reviewer/reflector/assistant engram access
also contradicts their independence framing (see WS8).

**Solution.** (a) WS8 removes engram from reviewer/reflector/assistant at the tool layer.
(b) For the generator, keep engram (it is the designed cross-run agent memory) but tighten the
prompt contract in `agents/AGENTS.md` + `qa-generator.md`: engram is for operational context
(routes, auth quirks, app topology), NEVER for test-authoring rules (selector/assertion/skip
patterns) — those belong exclusively to the governed ledger; add the rule to the reviewer's
reject-on-sight awareness so ledger-bypassing "learned habits" in spec comments get flagged.

**Why this is correct.** Removing generator engram entirely would delete real value (app
topology memory demonstrably reduces re-exploration) to close a soft channel; the governed
ledger already owns the *rule* concept, so the fix is scoping, not amputation. A prompt-level
boundary is honest here because the generator's engram writes are advisory context, not gates.

**Trade-offs.** Prompt-level discipline is soft — a residual bypass remains and is documented
as such. Periodic human review of engram content is the backstop (out of scope to automate).

---

## WS2 — Code-mode restoration (P0)

Code-mode cannot produce a genuine verdict since the cutover. The engine's docs sell code-mode
as working; this is the largest truth gap in the system.

### 2.1 specDir wiring (code runs get `<mirror>/e2e` everywhere legacy used `mirrorDir`)

**Problem.** `rewritten-engine-factory.ts:346` hardcodes `e2eRelDir = "e2e"` unconditionally;
`WorkspacePortAdapter.prepare` (`workspace-port.adapter.ts:38-41`) returns
`${mirrorDir}/e2e` for every app; setup (`:404`), validate (`:720`), execute (`:932`) all
consume it; `ExecutionPortAdapter` forwards verbatim to `runCodeTests(repoDir=...)`. Legacy
passed `mirrorDir` for code setup/execute (`git show 1228ea7~1:src/pipeline.ts:1299,2497`).
panchito (the only `code: true` app) has no `e2e/` dir → code runs die in setup/validate and
can never reach `pass`. Masked by parity tests that stub `validate()` uniformly.

**Solution.** Make the workspace target-aware at the adapter:
`WorkspacePortStaticContext` gains `specRelDir: string` computed in the factory as
`isCode ? "" : "e2e"`, and `prepare()` returns `specRelDir ? \`${mirrorDir}/${specRelDir}\` :
mirrorDir`. Pin with a per-target adapter test AND one factory-level test asserting the
composed specDir for a `code: true` app config (the seam the stubbed parity suite missed).

**Why this is correct.** The alternative — branching inside every consumer (setup/validate/
execute) — spreads target-awareness across N sites; the workspace is the single owner of "where
does this run's work happen", so the split belongs there. Keeping `e2eRelDir` as the e2e name
and deriving an empty rel for code matches legacy semantics exactly (code target = repo root).

**Trade-offs.** Touches an adapter every e2e run also uses — regression risk bounded by the new
per-target tests and the unchanged e2e expression. `OpencodeRunInput.e2eRelDir` (prompt-side)
keeps meaning "the e2e folder" for e2e and is already unused by `buildCodeTask` — verify with a
grep-test, don't assume.

### 2.2 Filter B must not run for code target; port the legacy compile gate

**Problem.** `validation.validate(workspace.specDir)` at `:720` is unconditional; legacy
explicitly skipped it for code ("running the repo's own suite IS the gate", legacy
`:2246-2251`) and had a DEDICATED code compile-feedback gate (`deps.validateCode`, legacy
`:2434-2490`) that was never ported — zero hits in qa-engine/factory.

**Solution.** Two steps in one slice: (a) gate the static-gate phase on `!cfg.isCode` in
`run-qa.use-case.ts` (with the static-fix loop inside it), restoring legacy semantics;
(b) port `validateCode` as a code-target branch of the validation phase: run the ecosystem's
compile/typecheck command (already derivable from `detectCodeProject`), feed failures back to
the agent via `fixCases`-shaped enrichment (bounded rounds, same MAX as static-fix), map
toolchain-missing errors to `infra-error`. Re-point the `codemode-infra-toolchain` parity
scenario at the restored behavior (its "known declared divergence" comment cites
`parity-allowlist.json` / `golden-outcome.test.ts` — **neither file exists in the tree**; fix
the comment to reference the real pinning test, or create the missing characterization).
FIRST STEP (judgment-day): resolve the comment-vs-test contradiction empirically before writing
any code — `run-qa.use-case.ts:786-789`'s comment claims `infra:true` still maps to `"invalid"`
as an open allowlisted gap, but `run-decision-parity.test.ts:212`'s `codemode-infra-toolchain`
scenario already asserts `"infra-error"`. Determine which is truth (does a real toolchain-missing
code run currently produce `invalid` or `infra-error`?): if the divergence was already silently
closed, this WS only fixes a stale comment; if the test is aspirational, WS2.2's `infra-error`
mapping must land WITH the test, not collide with it.

**Why this is correct.** Running tsc/eslint(playwright)/`--list` against a code repo is a
category error (the repo isn't a Playwright suite); the exit-code run is Filter C, and the
compile gate is the code-mode Filter B. Porting rather than inventing keeps parity arguable.
Skipping (a) without (b) would leave code-mode with NO pre-execution feedback at all — worse
than legacy.

**Trade-offs.** The code compile gate spawns the repo's own toolchain pre-run (cost, and a
second place a broken toolchain surfaces — mapped to infra, consistent with `ranZeroTests`).
Context-mode's validate-as-proxy branch (`:774-792`) must be preserved — the gate change is
target-scoped, not mode-scoped.

### 2.3 Code-mode mutation oracle unscoped

**Problem.** Both `objectiveSignal.measure()` calls pass `BlastRadius.of(input.sha, [])`
(`run-qa.use-case.ts:1122,1179`); `StrykerMutationOracleAdapter` forwards `br.changedFiles`
into `selectMutateTargets` — scoping never engages; code-mode valueScore is measured unscoped
(slow, diluted — and it feeds WS1.4's promotion gate).

**Solution.** Thread `runBlastRadius` (already computed at `:518` from the real diff) into both
`measure()` calls instead of the empty literal. Keep the cross-repo diff-starving unchanged
(the adapter's diff-presence guard — the local `n` in `objective-signal-port.adapter.ts`, not a
symbol literally named `willAssemble` — is orthogonal and correct).

**Why.** The data exists 600 lines above the call; the empty literal was a placeholder that
became load-bearing. Scoped mutation = faster oracle runs AND a valueScore that actually
measures the changed code — directly strengthens the objective signal WS1 leans on.
**Trade-offs.** None — e2e's fault-injection oracle ignores `br`; behavior change is
code-target-only and strictly narrowing.

### 2.4 Code-mode review framing + anti-mock rubric

**Problem.** `ReviewPortAdapter` never sets `target` → code reviews are framed "E2E tests"
(`prompts.ts:1597`); the reviewer's entire anti-pattern catalog is Playwright-shaped; no
anti-mock rule exists anywhere for code-mode (`code-runner.ts` has zero mock awareness) — a
fully-mocked tautological test passes generation, review, and exit-code execution.

**Solution.** (a) Thread `target` through `ReviewPortStaticContext` → code reviews render the
code framing. (b) Add an `isCode` section to `qa-reviewer.md` + `test-value-review` skill (both
mirrors): reject tests that mock the unit under test, assert only on mock interactions, or
duplicate the implementation as the expectation. (c) Do NOT build a deterministic mock-density
gate.

**Why (c).** A deterministic mock detector is per-ecosystem, per-framework (jest.mock/sinon/
Mockito/monkeypatch/…), brittle, and gameable — exactly the "another proxy" CLAUDE.md warns
against. The objective gate for mocked-out tautologies is change-coverage: mocked-away changed
lines don't execute, so the ratio exposes them — and WS2.1/2.2 make code-mode coverage
reachable again (the collector path `runCodeCoverage`→lcov already works for node). The LLM
rubric covers what coverage can't see (assertion quality); the keystone covers what the rubric
can't verify (execution truth).

**Trade-offs.** Non-node ecosystems degrade to `unknown` coverage (never blocks) — for them
the rubric is the only mock defense. Accepted and documented; adding per-ecosystem coverage
producers is the future lever (JaCoCo already read if the repo's build emits it).

### 2.5 Code-mode adjudication depth (P2, evidence-first)

**Problem.** `app_defect` is structurally unreachable for `isCode` (5 of 6 adjudicator rules
gated off); a genuine source bug burns the whole retry budget as `generated_test_defect/low`.
Unused evidence exists (`parseTestCounts`, per-case failure text).

**Solution.** Signal-first, never gate-first (mirrors the coverage keystone's rollout): add a
code-mode evidence extractor that classifies the failing output into
{compile-error | assertion-failure | unhandled-exception-in-source} and RECORDS the class on
the case detail + run outcome (no behavior change to the loop). Only after observing real runs,
consider letting `unhandled-exception-in-source` reach `app_defect/low → break-needs-human`
(never auto-Issue on first implementation).

**Why.** Code-mode failure text is far less structured than browser evidence (5xx/pageerror);
heuristics here have a real false-positive cost (an Issue blaming the app for a bad test
destroys trust). The system's own precedent — signal → observe → enforce — is the correct
maturation path.
**Trade-offs.** Code-mode bug-vs-bad-test stays degraded short-term; the retry budget still
burns on real bugs until enforcement is earned. Honest about the limit instead of guessing.

---

## WS3 — Evidence-to-consumer threading (P0/P1)

The adjudicator's verdict and execution evidence are computed and then dropped at the exact
boundaries where they would create trust.

### 3.1 Adjudication → Issue body (P0 — cheapest, highest leverage)

**Problem.** `publication.publish()` (`run-qa.use-case.ts:1407-1414` →
`publication-port.adapter.ts:98-171`) receives no adjudication; `renderBody` builds the Issue
from raw cases+logs. The human re-derives the diagnosis the engine already made
("App defect: backend returned 503, high confidence") and threw away.

**Solution.** Add optional `adjudication?: { class, confidence, reason }` to the publish
payload; thread `fixLoopResult.lastAdjudicatorVerdict` (a local in the same method); render an
"Engine adjudication" section in `renderBody`, passed through the SAME injected sanitizer as
logs (reason strings can embed page errors). Shadow mode inherits it for free (shadow logs the
payload).

**Why.** Zero new computation, zero LLM involvement, single-seam change; converts every Issue
from "raw failure dump" to "pre-triaged report". The alternative (rendering adjudication only
into run history/TUI) hides it from the consumer who acts on failures — the repo owner reading
the Issue.
**Trade-offs.** Issue bodies grow slightly; a LOW-confidence adjudication could anchor a human
wrongly — mitigate by rendering confidence explicitly and wording low-confidence classes as
"engine guess".

### 3.2 Fix-prompt "this might be the app's fault" branch (P1)

**Problem.** `prompts.ts:748-807` frames every failure as a test defect; evidence lines
(5xx/runtimeErrors) are shown but never interpreted; for the residual classes the deterministic
net doesn't break on (4xx, degraded-but-200), the agent is structurally biased to force a pass.

**Solution.** When `renderFixCaseEvidenceLines` emitted an `httpStatus >= 400` or any
`runtimeErrors` entry, append one instruction block: "If the evidence indicates the APP failed
(server error, page crash), do NOT weaken assertions to force a pass — keep the honest failing
assertion and state the suspected app defect in the verdict `note`, citing the evidence line."
Also thread the adjudicator's own class into the fix enrichment when it decided `CONTINUE`
(the agent sees "engine classified this generated_test_defect/high (absent selector)").

**Why.** The deterministic rules (2.5/2.6) already own the clear cases; this covers the gray
zone where only judgment exists, and it aligns the generator's incentive with the reviewer's
("prove value", not "go green"). Passing the adjudicator's class is strictly more information
with no new trust surface (it already gates the loop).
**Trade-offs.** An agent could over-claim "app defect" to dodge work — bounded because the
claim only lands in the note (a human-facing annotation), never changes the verdict path, and
the reviewer still judges the spec.

### 3.3 executionResult → reviewer (P1)

**Problem.** `ReviewInput.executionResult`'s render section exists (`prompts.ts:1710-1730`)
but `ReviewEnrichment` has no field and run-qa never threads it — a 5xx observed on a GREEN run
(weak-assertion false-green, the exact class the system exists to catch) is invisible to the
reviewer.

**Solution.** Add `executionResult` (per-case name/status/httpStatus/runtimeErrors, sanitized)
to `ReviewEnrichment`; thread `run.cases` at the review call (`:1280`). The renderer already
handles it; add the reviewer-prompt instruction line referencing the section (both mirrors).

**Why.** This is the strongest objective circularity-breaker available to the reviewer — real
runtime behavior vs the spec's claims. The renderer surviving the rewrite proves intent; the
enrichment field was simply never added.
**Trade-offs.** Reviewer prompt grows (bounded: cases are few on review, evidence lines are
short). None otherwise.

---

## WS4 — Fix-loop evidence starvation (P1)

The highest-frequency regen path runs on error strings alone. Three wiring fixes, one file.

### 4.1 Thread `failureDomSnapshot` + `initialSpecSources` into `fixLoop.run()`

**Problem.** The call site (`run-qa.use-case.ts:1032-1044`) omits both; per-case `failureDom`
is captured on every failing case and never delivered; `checkSpecSelectors([], trees)` runs
against nothing.

**Solution.** Pass `initialSpecSources` (from the initial generation result — the port already
produces `specSources` via the wired `readSpecSource`) and the failure-point DOM from the run's
cases into `FixLoopInput`. Return `specSources` from the fix-loop generation closure (`:1007`
currently drops it) so Lever-2 re-arms every round.

**Why.** The entire deterministic post-failure selector-contradiction machinery (Lever-2) was
built, tested, and wired on the production path EXCEPT these two call-site omissions — this is
completion, not redesign. The pre-exec W1/W2 gate (which re-reads from disk) proves the
end-to-end value of the same evidence class.
**Trade-offs.** None. This was task B6+C1/W5's intent; the plan adds the integration test that
would have caught the omission (a FixLoop round asserting non-empty `specSources` reach
`selectorCheck`).

### 4.2 Wire `revalidate` for e2e retries

**Problem.** `FixLoopDeps.revalidate` never wired (`:1013-1017`); a regenerated spec with a
compile error goes straight to execution (burns a Playwright run to discover what tsc knows).

**Solution.** Wire `revalidate: () => this.deps.validation.validate(workspace.specDir)` into
the FixLoop deps (e2e target only — code-mode revalidation becomes the 2.2 compile gate).

**Why.** The seam exists, the port exists, the aggregate already no-ops gracefully — one line
plus a test. Cheaper failure detection strictly dominates.
**Trade-offs.** Adds a tsc/eslint pass per retry round (~seconds) — trivially worth it against
a wasted DEV execution.

### 4.3 Static-fix loop must carry the errors (and say it's a repair)

**Problem.** `run-qa.use-case.ts:739` regenerates with bare `baseEnrichment` — the tsc/eslint
errors are console-logged and never enter the prompt; the agent isn't even told it's a repair
round (the stale comment at `:709-713` claims no feedback field exists; `fixCases` does).

**Solution.** Thread `validation.errors` (bounded: first N errors, capped chars) as
`fixCases`-shaped enrichment (`{ name: "static-gate", detail: <errors> }`) or a dedicated
`staticGateErrors` field rendered under the existing fix framing — pick `fixCases` reuse to
avoid a new section (judges: verify the fix renderer doesn't imply an execution failure in a
misleading way; if it does, the dedicated field is worth the new section).

**Why.** Two blind rounds are near-pure token burn; the enrichment channel already exists.
**Trade-offs.** Slight semantic stretch of `fixCases` (a compile error isn't an executed case)
— acceptable if framing reads "failing gate", else use the dedicated field.

---

## WS5 — Prompt budget & grounding (P1)

### 5.1 Cap the diff at render boundaries (`capDiff` is wired and dead)

**Problem.** `PromptBudgetPort` is declared in `GenerateTestsUseCase` deps and never called;
the raw diff (task band, `shedAs: semi-stable`) can evict the ENTIRE volatile band (DOM,
learned rules, fix evidence, coverage gap) before shedding itself. `buildExplorerPrompt` and
`buildCodeTask` embed the raw diff with no assembler budget at all.

**Solution.** Call `capDiff` inside the three renderers that embed diff text
(`buildDiffSection`, `buildCodeTask`, `buildExplorerPrompt`), appending an explicit
"diff truncated at N bytes — full diff via `git show <sha>`" marker. Remove the dead `budget`
dep from `GenerateTestsUseCase` (single owner: the render layer owns presentation budget).

**Why render-layer, not use-case.** The diff has non-prompt consumers that need it whole
(coverage assembler derives changedFiles; adjudication) — capping at the source would corrupt
them. The render boundary is the only place where "too big for a prompt" is the right concept,
and it covers all three prompt shapes in one policy. Keeping the dead port "for later" violates
the audit's own lesson (dormant seams rot into lies).
**Trade-offs.** A tail-truncated 50KB diff may cut relevant hunks on giant commits — mitigated
by the truncation marker (the agent is told to `git show`) and by 7.1 (range diffs make this
more likely, so the marker matters). Reordering hunks by relevance is future work, explicitly
out of scope.

### 5.2 Coverage-gap must survive its own regen prompt

**Problem.** The `coverage-gap` section is volatile p5 — first to shed — and nothing at
`:1152-1192` checks it survived assembly; a shed gap silently converts the enforce-mode
one-shot regen into a repeat of the original prompt (diff is also empty on regens).

**Solution.** During the coverage-regen generate call, promote the section: render coverage-gap
with `shedAs: "critical-recap"` when the enrichment carries `coverageGap` (it is the regen's
entire payload; by the pack's own precedent, unrecoverable-for-this-turn content gets the top
band). Belt-and-braces: log an explicit error if the assembler's `droppedIds` ever contains
`coverage-gap` on that call.

**Why.** The regen prompt is structurally thin (no fixCases/reviewCorrections co-occur), so
promoting one small section (≤10 files, source-capped) is nearly free; a survival check alone
(without promotion) would detect but not prevent the defeat.
**Trade-offs.** None meaningful — the section is bounded at source.

### 5.3 Context Pack is structurally empty in production

**Problem.** The explorer pass is never wired (`renderExplorer` zero callers; the grounding
bridge leaves `brief` undefined by design) and the factory never supplies `contextMap`
(`:643-655`) — so `buildContextPack` assembles from ∅+∅ and the most-protected section in the
prompt is empty on every run. The deterministic push-grounding for the AUTHOR is dormant; the
generator self-grounds via MCP each run (cost + variance). `renderArchitectureContext` and the
arch-map section are equally dead.

**Solution (decision with recommendation).** Three options:
- (a) Wire the qa-explorer LLM pass — restores the design, adds an LLM session (+240s cap) and
  a new nondeterminism source per run.
- (b) Delete the pack machinery and accept MCP self-grounding as the strategy — honest but
  abandons determinism where the system's own value thesis demands it, and leaves W1/W2's
  "trusted catalog" as the only deterministic grounding.
- (c) **Recommended:** feed the pack DETERMINISTICALLY — populate `candidateRoutes` from the
  same route-catalog capture the pre-exec/review grounding already uses (config `baseUrl` +
  bounded shallow crawl, no LLM), plus `[CHANGED]` markers from the classified diff. The
  explorer stays unwired.
Precondition (CONFIRMED necessary, judgment-day): `buildContextPack` today populates candidate
routes ONLY from a brief — both `briefRoutePaths` (`input.brief?.routes`) and `contextMapRoutes`
(gated on `input.brief?.feBe`) require it (`context-pack.ts:236-252`). There is no brief-less
route path, so option (c) MUST add a thin `routes` input to `buildContextPack` rather than
fabricating a fake brief — treat this as a required sub-step, not a contingency.

**Why (c).** It matches the project priority ("stable, reliable, deterministic" above
features): grounding quality comes from the capture pipeline (which the audit rated the
system's best asset), not from another LLM turn. It reuses proven machinery; cost is one
bounded capture before generation (already paid later for W1/W2 anyway — opportunity to reuse
one capture for both).
**Trade-offs.** Shallow crawl < LLM-guided exploration for deep flows behind interactions —
the generator's MCP tools remain available for those. If capture fails, pack degrades to empty
exactly as today (fail-open), with the existing "no grounding → explore via MCP" prompt switch.

### 5.4 Sanitizer: two-tier policy + fail-closed publication default

**Problem.** (a) `api-key-assignment` redacts code like `password: string` / `token =
getToken()` — auth-flow diffs (the commits whose behavior most needs testing) lose their key
lines. (b) `PublicationPortAdapter`'s `sanitize` defaults to identity — a future composition
that forgets the injection silently publishes unsanitized Issue bodies. (c) Inconsistent DOM
sanitization (failure/review DOM embedded raw; context-pack DOM sanitized).

**Solution.** (a) Narrow the assignment pattern for the **diff→model** path only: require the
value side to be a quoted literal or high-entropy token (exclude type annotations and bare
call expressions); keep the aggressive pattern for **logs→Issue** (public surface). Implement
as a mode flag on the shared pattern set, twin-synced with the existing byte-parity test
extended to both modes. (b) Make the publication adapter's sanitizer REQUIRED (constructor
throws if absent) — fail-closed. (c) Route the raw DOM embeds through the qa-engine twin (same
as context-pack) for consistency.

**Why.** Model-bound and public-bound surfaces have different threat models; one knob for both
forces the wrong trade somewhere. The publication default-to-identity is a textbook latent
fail-open on the system's most public output.
**Trade-offs.** (a) accepts marginally higher model-exposure of code-shaped pseudo-secrets on
the diff path (model-bound, ephemeral) to preserve testing signal — argued acceptable; the
Issue path keeps maximum scrubbing. (b) is a breaking constructor change caught at compile
time — trivial.

### 5.5 Minor render fixes

- **(added post-WS4)** fixCases framing for static-gate entries: WS4.3 threads static-gate errors
  as a `fixCases` entry named `"static-gate"`, but `prompts.ts`'s fixCases section frames all
  entries as "tests FAILED during execution against DEV" — misleading for a compile/lint failure
  (nothing executed). When prompts.ts is editable, make the framing conditional: a case named
  `static-gate` renders under a "failing gate" framing instead. One conditional, no new section.

- Unimpacted service links beyond MAX_LINKS: append "…and N more links" marker (observability,
  one line).
- Regen prompts render "Cross-check against the diff" while the diff section is empty: make the
  instruction conditional on the diff section actually rendering.
- Manifest metadata unused for dedup: render `flow`+`objective` (one line each) alongside
  `existingSpecFiles` in the existing-suite section, sourced from the manifest the orchestrator
  already reads. Why: dedup by filename alone invites duplicate flows as suites grow; the data
  is on disk and already trusted. Trade-off: a few hundred bytes of semi-stable content.

---

## WS6 — Timeouts & operational observability (P1)

### 6.1 Reviewer (and per-role) prompt deadlines on the live path

**Problem.** `ReviewPortAdapter.review()` passes no `timeoutMs` → the reviewer inherits
`dispatcherTimeoutMs` (~25.5min) instead of `REVIEWER_TIMEOUT_MS` (6min);
`reviewIndependently` (which applied it) has zero callers. A hung reviewer holds the
sequential queue 25-50min. Generator inherits the same coarse ceiling (acceptable — it equals
the generator budget) but explorer/planner budgets are equally dead if ever rewired.

**Solution.** Thread `timeoutMs` through `ReviewPortStaticContext` (factory supplies
`REVIEWER_TIMEOUT_MS`, env-tunable as today) into `openSession`. Map a reviewer timeout to a
loud `infra-error`-style review failure (thrown, logged, run continues to Issue with
"reviewer unavailable") rather than an uncaught crash of the whole run — this respects
"surface integration errors loudly" while not letting one hung reviewer kill the run's
already-computed execution evidence. Delete `reviewIndependently` (orphaned) with a pointer in
the commit message.

**Why.** The 6-minute budget was a deliberate, documented design ("must never inherit the
generator's 25-minute worst-case"); restoring it at the adapter is the minimal faithful fix.
Mapping timeout→structured failure is a (declared) improvement over legacy's propagate-up.
**Trade-offs.** A legitimately slow reviewer on a huge suite hits 6min — env-tunable knob
already exists. Deleting dead code removes the "reference implementation" — the test pinning
the adapter's timeout replaces it.

### 6.2 Stall watchdog + usage sink + session registration died at cutover

**Problem.** `withStallWatchdog`/`withUsageSink` have zero production callers (the factory gets
raw `agentRuntime.facade().deps()`); `registerRunSession` is never called on the rewritten
path — no 180s inactivity protection, no cost telemetry, no live SSE activity, and the
qa-engine comments claiming otherwise are wrong.

**Solution.** Wrap the facade deps at the single composition point (`src/index.ts:128-137` /
factory boundary) with the existing `withUsageSink(withStallWatchdog(deps))`; call
`registerRunSession` inside the rewritten `open()` bridge using the descriptor's runId (the
descriptor already carries it). Fix the stale comments. Codex: see 9.3 for its self-timing.

**Why.** These are tested, existing wrappers whose composition call was simply dropped — the
same completion-not-redesign class as WS4. The alternative (rebuilding telemetry inside
qa-engine ports) duplicates working code across the boundary for no gain.
**Trade-offs.** The watchdog can kill a legitimately silent long turn (model thinking without
tool calls) — same risk profile the legacy accepted, env-tunable, and strictly better than
unbounded hangs.

### 6.3 Reflect latency off the critical path (follow-up telemetry note from #1100)

**Problem.** `reflect()` is awaited inline — up to 60s per qualifying run on a sequential queue.

**Solution.** Keep it awaited (determinism: the run's persisted outcome must include the
reflection back-fill before the run closes) but add duration telemetry to the existing run
events so the cost is visible; revisit only if observed p95 hurts.
**Why.** Fire-and-forget would race `updateRunOutcomeReflection` against run finalization and
the next run's retrieval — correctness first; measure before optimizing.
**Trade-offs.** Accepts the latency for now, with 1.2 already removing the green-run majority
of reflect calls.

---

## WS7 — Blast-radius fidelity (P1/P2)

### 7.1 Multi-commit range restoration (P1)

**Problem.** `baseSha`/`commits` are accepted at webhook/CLI/RunRequest and die before the
engine (`RunInput` lacks the field; `classify()` calls `vcs.diff(sha)` single-commit). A push
of N commits tests only the head — silent coverage hole in the core promise; the capability
existed pre-cutover (an unused range-union helper survives in `repo-mirror.ts`).

**Solution.** Thread `baseSha?` through `RunInput` → `ChangeAnalysisPort.classify(sha, {baseSha})`
→ `vcs.diff(base..head)` (range union). Classification over a range: compute per-commit
classifications and take the MAX-severity action (skip < regression < generate); intent =
head commit's, with the escalation cross-check run against the UNION diff. Fallback when
absent: `sha^..sha` exactly as today (backward compatible).

**Why max-severity + union diff.** The action must reflect the worst change in the range (a
`feat` buried under a `chore` head must generate); the union diff is what DEV actually now runs,
so grounding/coverage measure against it is honest. The alternative — classify only the head —
is today's bug; classifying the squashed range as one "unknown" throws away real intent data.
**Trade-offs.** Union diffs are bigger (5.1's cap + truncation marker becomes important);
per-commit classify costs N cheap parses (no LLM). CI contract: senders that already POST
`baseSha` start getting range behavior — announce in the changelog as a fix, not a break.

### 7.2 Restore `regression` semantics (P1, decision)

**Problem.** The engine hardcodes `generating = true` (`:388`); `regression` (perf/refactor →
run existing suite, publish nothing new) collapsed into full generation — token overspend on
every refactor plus a dead decision branch (`run-decision.service.ts:119`), undeclared.

**Solution.** Honor `cls.action === "regression"`: set `generating = false`, skip generation
phases, run the existing suite, and let the already-existing `!ev.generating` decision branch
work. Pin with a characterization test (regression commit → no generate call, suite executed,
fail → Issue).

**Why.** The three-way taxonomy is the classifier's whole point; the diff cross-check ALREADY
escalates any refactor that adds real logic, so the remaining regression class is genuinely
"behavior-preserving per both message AND diff" — generating tests for it contradicts the
system's own classification. Cost matters at fleet scale.
**Trade-offs.** A refactor that changes behavior in ways the heuristics miss (7.3's blind
spots) now gets NO new tests instead of possibly-aimed ones — mitigated by 7.3 landing in the
same workstream, and the existing suite still runs (regression's purpose). This is a behavior
change vs current production; flag it to the user in the PR.

### 7.3 `looksLikeLogic` blind spots (P2, conservative expansion)

**Problem.** Template files (`.html`) are not in `SOURCE_EXT`; removal-only diffs never
escalate (only added lines counted); `.sql` migrations invisible; constant-value changes
(`timeout: 5000→10000`) don't match the logic heuristics. All under skip-typed messages → zero
runs.

**Solution.** Three conservative moves, one decision: (a) add the genuinely-missing framework
template extensions to `SOURCE_EXT` — **premise correction (judgment-day): `.vue` and `.svelte`
are ALREADY present** (`commit-classification.ts:108`); only `.html` and `.astro` are actually
missing (JSX/TSX already covered). For an E2E engine, template changes ARE behavior; (b) count
REMOVED logic lines symmetrically
(`genuinelyRemovedLogic`, same relocation subtraction) and escalate removal-heavy skip-typed
commits to **regression** (run the suite — stale specs surface) rather than generate;
(c) add `.sql` + migration-path globs to the behavior-config class → regression. (d) Constant-
value changes: DECISION — recommend NOT auto-escalating (a value-diff heuristic on arbitrary
source is high-noise; the cost of false generates at fleet scale is real); document as a known
limit instead.

**Why regression (not generate) for (b)/(c).** Removals/migrations invalidate existing
expectations more than they create new surfaces; running the suite is the cheap, targeted
response, and a red result then flows through the normal fix/Issue machinery.
**Trade-offs.** (a) increases generate volume for template-heavy repos (that is the point);
(d) accepts a real blind spot to avoid noise — revisit with telemetry if skip-then-fail
incidents show up.

### 7.4 Classifier explanation → prompt (P2)

**Problem.** `classification.reason`, `contradiction`, `hasLogicChange` are computed and
dropped at the adapter/use-case; the generator is never told "the message claims no behavior
change but the diff adds logic HERE" — the highest-value aiming hint for escalated commits.

**Solution.** Thread `reason` + `contradiction` through the enrichment into the task section
(one line each, sanitized).
**Why.** Cheap, already computed, directly improves aiming on exactly the commits where the
message misleads. **Trade-offs.** None meaningful.

### 7.5 structuralSignal on cross-repo runs queries the wrong graph (P1)

**Problem.** The adapter is pinned to the PRIMARY repo root at composition (`composition-root.ts:493`)
and the use-case has no `triggerRepo` guard (`:523-529`) — cross-repo runs query the primary
graph with service-repo paths: usually empty, worst-case FALSE coupling bullets from
convention-coincident paths (`src/main/java/...`).

**Solution.** Gate: skip the structural-signal phase when `input.triggerRepo` is set, with an
explicit log line ("structural signal skipped: cross-repo run — graph is primary-scoped").
Follow-up (separate, optional): per-call mirror resolution following `crossRepoImpact`'s
pattern.
**Why gate-first.** A wrong signal is worse than no signal (it aims the agent falsely with
`[coupling]` authority); the honest-empty fix is one guard. Re-pointing needs per-service graph
indexes — real scope, own slice.
**Trade-offs.** Cross-repo runs lose an aiming signal they never correctly had; `crossRepoImpact`
(Tier 1/2) remains their real cross-repo signal.

### 7.6 Cross-repo prompt parity work parked in stash (coordination)

**Problem.** At HEAD, the `## Cross-repo change (microservice)` prompt section's feed
(`triggerService` → `OpencodeRunInput.service`) is uncommitted working-tree/stash material
(user's parallel session; engram: stash@{0} "unit3-isolate-parallel-session-wip") — cross-repo
prompts have no service framing.

**Solution.** Coordination item, not new build: land the user's parked work (selective restore,
never blind-pop, per the standing rule), then verify the section renders on a cross-repo run
fixture.
**Why.** Building it fresh would collide with existing WIP — the audit's role is to rank it:
this is the missing half of cross-repo aiming (with 7.5 and coverage=unknown, cross-repo runs
are currently the least-aimed runs in the system).
**Trade-offs.** Depends on user coordination; explicitly sequenced before any other prompts.ts
slice to avoid conflicts.

### 7.7 Minor blast-radius hygiene (P3)

- `ChangeAnalysisPort.analyze()` + `VcsReadPort.blastRadius`: zero callers → delete (dead port
  surface invites false confidence).
- Slice B/C telemetry (4 persisted fields, zero readers): keep (cheap, forward-looking
  calibration data) but add them to the run-detail TUI/API response so they have ONE reader —
  or document explicitly as write-for-later.
- Merge-commit messages parse as `unknown` → generate: leave (fail-toward-testing is the right
  default), documented.

---

## WS8 — Tool-surface reality (P0, security posture)

### 8.1 Per-agent MCP/steps config is fiction at OpenCode 1.17.7

**Problem.** Verified against the pinned SDK types: `AgentConfig` supports `tools`
(per-tool booleans), `maxSteps`, `permission` — there is NO per-agent `mcp` key, and
`steps` is not a field (`maxSteps` is). Precision correction (judgment-day): `qa-reviewer` and
`qa-reflector` carry NO per-agent `mcp` array at all today (`mcp_key=False` on direct parse);
`qa-generator`/`qa-maintainer`/`qa-assistant`/`qa-worker*`/`qa-explorer` do carry one, but it is
inert (the SDK ignores it). So the claim is NOT "the JSON grants all three tools to
reviewer/reflector" — it is that **nothing at the runtime layer restricts them**: the top-level
`mcp` block registers serena/engram/playwright process-wide, and whether an agent with no
per-agent restriction can invoke them is OpenCode 1.17.7's DEFAULT-availability behavior — which
the in-slice empirical probe (below) must SETTLE, not assume. Either way, qa-reviewer's
independence, qa-reflector's "tool-less by design" guarantee, and qa-assistant's read-only claim
are enforced only by prompt etiquette, not the runtime. Every `steps` cap is inert; the built-in
`tools.{write,edit,bash,read}` booleans ARE honored (real), but the per-agent MCP-server allowlist
that `agent-tool-surface.test.ts` asserts against is the inert/fictional field — that portion of
the test certifies the fiction.

**Solution.** Rewrite `agents/opencode.json` per-agent using the REAL mechanism:
`tools: { "serena*": false, "engram*": false, "playwright*": false }` wildcards (verify the
actual registered MCP tool-name prefixes at 1.17.7 IN-SLICE — first implementation step, not
an assumption) for reviewer/reflector/assistant; keep generator's full set; replace `steps`
with `maxSteps`; delete the dead top-level `compaction`/`tool_output` keys. Rewrite
`agent-tool-surface.test.ts` to (a) validate the config against the SDK's `AgentConfig` type
(compile-time import) and (b) assert the wildcard denials + `maxSteps` presence per role.
If wildcard tool-matching turns out unsupported at 1.17.7, fall back to enumerating the exact
tool names (deterministic, verifiable from a running server via `/config`), NOT to upgrading
the OpenCode pin (execution-path pin rule — an upgrade is its own risk decision for the user).

**Why.** The reviewer's independence, the reflector's isolation, and the assistant's
toollessness are load-bearing design claims (independent judgment; anti-Goodhart "pure
transform"; read-only Q&A). They must be enforced by the runtime, not by prompt etiquette. The
test must pin the real mechanism or it is worse than no test.
**Trade-offs.** Tool-name enumeration (fallback) is brittle across MCP server updates —
mitigated by the smoke test failing loudly. Denying playwright to the reviewer removes its
ability to "verify live" claims — by design (its DOM evidence comes from the orchestrator;
that independence is the point).

### 8.2 Vestigial `"mode": "subagent"` label (P3)

**Solution.** Set qa-reviewer to the mode the orchestrator actually uses (direct prompt) and
delete the misleading label; one-line comment pointing at `ReviewPortAdapter` as the invoker.
**Why/Trade-offs.** Doc-truth only; none.

---

## WS9 — Provider parity: Codex (P2)

### 9.1 Amnesiac repair re-prompts

**Problem.** Codex spawns a fresh `codex exec` per `prompt()` (no resume); the bounded
contract-repair sends "your previous response did not end with a valid verdict JSON — re-emit
it" to a process that never saw a previous response — it can only fabricate.

**Solution.** Two steps: (a) verify whether the pinned codex CLI supports `codex exec resume
<session-id>` (it exists in newer releases) — if yes, thread the session id through
`CodexExecTransport` and use it for repair turns only; (b) regardless, make the repair prompt
SELF-CONTAINED as the provider-agnostic fallback: include the tail of the prior response
(bounded, e.g. last 4KB) + the format contract, so a fresh process can genuinely re-emit.
Prefer (a)+(b): resume when available, self-contained always.

**Why.** (b) fixes the correctness bug for both providers at once (OpenCode merely tolerates
the current prompt because its server remembers); (a) restores full-context repairs where the
runtime allows. Disabling repair on Codex (alternative) throws away recoverable runs.
**Trade-offs.** Bigger repair prompts (bounded); resume support adds a Codex-only code path
(guarded behind a capability probe, so OpenCode is untouched). If neither the CLI resume nor a
reliable prior-response tail is available at the pinned Codex version, the honest fallback is to
NOT send a bare "re-emit" to Codex and instead treat the first parse-miss as a rejection round
(fail-closed) — worse recovery, but never a fabricated verdict.

### 9.2 Skills never reach Codex

**Problem.** `withCodexRolePreamble` (`codex-strategy.ts:480-494`) injects only `AGENTS.md` +
`roles/<role>.md`; nothing ships `agent/skills/` into a codex turn (the agents image copies only
the supervisor). Yet the shared role prompts say "Consult the `playwright-authoring` skill" — a
dangling reference on Codex. The deep craft layer (locators/auth/storage patterns, the
"examples are ILLUSTRATIVE never literal" guard) exists only for OpenCode.

**Solution.** Make skill delivery provider-symmetric: when a role prompt references a skill,
inline that skill's `SKILL.md` into the Codex role preamble (the same assembly point that
already inlines `AGENTS.md`), bounded by the same budget the OpenCode side pays implicitly.
Gate the two skill mirrors under `prompt-sync.test.ts` (today it waives `SKILL.md` and skips
`test-value-review` entirely) so the OpenCode/Codex skill content cannot drift.

**Why.** A dangling "consult the skill" instruction is worse than none — it implies grounding
the agent cannot reach. Inlining at the preamble reuses the existing Codex assembly seam rather
than inventing a skill-loader for `codex exec` (which has no MCP-style skill mechanism). Pinning
the mirrors closes the drift the audit found (`test-value-review`'s stale unconditional
no-cleanup rule would make Codex's reviewer reject valid namespaced-and-left tests).

**Trade-offs.** Codex preambles grow by the referenced skills' size (bounded, and only the
skills a role actually references). Full skill parity means the Codex reviewer becomes as strict
as OpenCode's — desired, but it changes Codex reviewer behavior the day it lands; call it out.

### 9.3 Codex prompt has no deadline and no stall watchdog on the live path

**Problem.** `CodexExecTransport` arms a timeout only if `input.timeoutMs` is set
(`codex-strategy.ts:382-385`); the rewritten path passes none, and the stall watchdog skips
Codex (`selfTimed`, `facades.ts:30,70`). A wedged `codex exec` generator/reviewer/chat is
unbounded except by external abort.

**Solution.** Give `CodexExecTransport` a default deadline equal to the same per-role budget
WS6.1 restores for OpenCode (diff=5min generator, 6min reviewer, etc.), derived from the same
constants so the two providers share one budget policy; SIGKILL the `codex exec` child on
expiry (Codex is self-timed by design — the watchdog cannot see its internal activity, so a hard
wall-clock kill is the correct mechanism, not the inactivity watchdog). Surface the kill as the
same structured timeout failure WS6.1 defines.

**Why.** Provider choice must not change whether a hung turn can stall the sequential queue
forever. A wall-clock kill (vs OpenCode's inactivity watchdog) is the right tool because Codex
gives no mid-turn activity signal — matching the mechanism to the observability the runtime
actually offers.
**Trade-offs.** A legitimately long Codex turn is killed at the budget (same env-tunable knob);
no partial-output recovery from a killed `codex exec` (acceptable — a timed-out turn had no
usable verdict anyway).

### 9.4 Minor Codex asymmetries (P3)

- `extractCodexLastMessage` takes only the LAST agent_message vs OpenCode's concatenate-all —
  a verdict emitted before a trailing remark is lost on Codex only. Solution: extract the last
  message that CONTAINS a parseable verdict block, not merely the last message. Trade-off: one
  extra scan of bounded output.
- `FALLBACK_MODELS` "Config A" roster comment names models `opencode.json` no longer has, and
  would reject the real default primary if it ever fired. Solution: sync the fallback roster to
  the live config; it only fires when `opencode.json` is unreadable, but then it must not reject
  the default. Trade-off: none.
- `roleToAgentName` maps `explorer → "qa-generator"` (acknowledged CHIP) — inert while the
  explorer is unwired; if WS5.3(c) stays deterministic (no explorer LLM), delete the mapping
  rather than fix it. Trade-off: none.

---

## Sequencing & delivery

**Dependency order (hard edges):**

- WS1.1 (fold id-fix) **blocks** WS1.4 (promotion gate) — promotion must not go live over a
  broken fold. WS1.3 (ported distiller) is a prerequisite for WS1.5 (archetype/corrections).
  Land WS1 as one coherent chain: 1.1 → 1.3 → {1.2, 1.6} → 1.4 → 1.5 → 1.7. This is the P0
  trust workstream; nothing else in the plan depends on it, so it can go first and alone.
- WS2.1 (specDir) **blocks** WS2.2 (compile gate) and WS2.3/2.4 (which only matter once code
  runs reach `pass`). WS2 is internally ordered 2.1 → 2.2 → {2.3, 2.4} → 2.5.
- WS3.1 (adjudication→Issue) is independent and the single highest leverage-per-line item —
  ship it first as a standalone PR to bank trust value immediately.
- WS4 (fix-loop threading) is independent of WS1/2/3; three call-site fixes + tests in one file.
- WS5.3 (Context Pack) carries a **user decision** (options a/b/c) — do not implement before the
  decision. WS5.4 (sanitizer) is independent.
- WS6 (timeouts/watchdog) is independent and touches the composition boundary + one adapter.
- WS7.1 (range) and WS7.2 (regression) are **behavior changes vs current production** — each
  needs an explicit user go-ahead and a changelog line; 7.2 depends on 7.3 landing together
  (else regression widens blind spots). WS7.6 depends on **user coordination** (parked stash).
- WS8 (tool-surface) is independent and security-critical; its first in-slice step is an
  empirical probe of the running OpenCode 1.17.7 tool-name namespace — no code until that is
  known. WS9 (Codex) is independent and lowest priority.

**PR strategy.** Each numbered item is a work-unit commit with its own pinning test; group by
workstream into reviewable PRs (WS1 as one stacked chain given its internal dependencies; WS2 as
one; WS3/WS4/WS6/WS8 each standalone; WS5/WS7/WS9 split by decision boundaries). Every PR keeps
`npm test` + `npm run typecheck` green and runs under `nvm use 24`. Hot-path PRs (WS1, WS2, WS6,
WS8 — learning/security/execution) get the 4R review fan-out; the rest get the single readability
lens.

**What this plan deliberately does NOT do:**

- No new LLM proxy for "quality" — every quality lever leans on the objective signals (coverage
  keystone, value oracle) or deterministic gates, per CLAUDE.md's own warning. The one new
  rubric text (2.4 anti-mock) is explicitly paired with the coverage gate that objectively
  catches what it can't.
- No OpenCode/Codex version bump (execution-path pin rule) — WS8/WS9 fixes work within 1.17.7.
- No semantic rule dedup (WS1.3 keeps exact-text) — flagged as the standing follow-up.
- No app-shaped branches in `src/` — every fix is root-cause and target/mode-scoped, never
  app-scoped.

## Open decisions — RESOLVED by the user (2026-07-07)

1. **WS5.3 Context Pack** → **(c)**: deterministic route-catalog feed; explorer stays unwired.
2. **WS7.2 regression semantics** → **restore** run-suite-only for regression commits, landing
   together with WS7.3's blind-spot closures (hard pairing, per the plan's own sequencing).
3. **WS7.1 multi-commit range** → **approved**; changelog line announces the contract fix.
4. **WS7.6 parked stash** → **deferred** until cross-repo prompt work is next touched; the stash
   label must be re-verified fresh at that time (judgment-day residual).
5. **Delivery mode** → **workstream-grouped work-unit commits on the current branch**, in order:
   WS3.1 → WS4 → WS1 (chain) → WS2 (chain) → WS6 → WS8 → WS5 → WS7 → WS9. Hot-path
   workstreams (WS1/WS2/WS6/WS8) get a fresh adversarial review before each commit; the rest get
   a readability pass. Every unit lands gated (typecheck + full tests green, strict TDD).

---

## Judgment-day refinement log (2026-07-06, round 1)

Two blind judges reviewed this plan against the live tree (HEAD moved past the audit baseline
`62b6bb4`). Both returned CHANGES REQUIRED; neither found a CRITICAL or a fix aimed at a
non-problem. ~20+ load-bearing anchors were independently re-verified and held (WS1.1, WS1.2,
WS1.3, WS2.1, WS2.2, WS2.3, WS3.1, WS3.3, WS4.1, WS5.1, WS6.1, WS6.2, WS7.2, WS7.3(b), WS8.1 SDK
types, WS9.3). Changes applied this round:

- **WS1.4 (both judges, WARNING real)** — made explicit that the promotion oracle-gate needs a NEW
  persisted `learning_rules` column + migration; it is its own PR-sized slice, not folded into 1.1.
- **WS7.3(a) (Judge A, premise partially false)** — corrected: `.vue`/`.svelte` are already in
  `SOURCE_EXT`; only `.html`/`.astro` are missing.
- **WS8.1 (Judge A precision; judge contradiction resolved by direct parse)** — reviewer/reflector
  carry no per-agent `mcp` array; the runtime simply does not restrict them, and default MCP
  availability at 1.17.7 is the in-slice probe's job to settle.
- **WS2.2 (Judge A suggestion)** — added an empirical first step to resolve the stale-comment vs
  parity-test contradiction before writing code.
- **WS5.3 (Judge B)** — upgraded the brief precondition from contingency to CONFIRMED-required.
- **WS2.3 (Judge B, cosmetic)** — corrected the guard's identifier name.

Residual (verify in-slice, unchanged): WS7.6's parked-stash reference must be re-resolved fresh
before restore (Judge A could not confirm the label still resolves). No re-judgment round was run:
every confirmed WARNING is resolved in-text and the remainder is suggestion/INFO level.

**Judgment: APPROVED (refinements applied).**