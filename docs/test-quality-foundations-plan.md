# Action plan v3 — foundational test-quality generation

## 0. Implementation status (IMPLEMENTED — TDD, uncommitted working tree)

W1 + W2 are implemented in 5 TDD increments; `npm test` (1740) + `npm run typecheck` green.
- **Inc 1** — pure `checkSpecSelectors` in `src/qa/selector-check.ts` (+ moved `selectorKey`); fix-loop refactored to call it.
- **Inc 2** — `captureRouteTrees` in `src/qa/dom-snapshot.ts` + `PipelineDeps.captureRouteTrees` dep; pre-execution invocation in the MAIN flow (independent of `needsReview`).
- **Inc 3** — one bounded corrective regen via the existing `selectorContradictions` channel before execution.
- **Inc 4** — deterministic block (W2): a persistent ambiguity folds into the static gate → existing `invalid` path holds the run pre-execution.
- **Inc 5** — `gateSignals.preExecAmbiguityCatches` / `deterministicSelectorBlocks` (types.ts + persistOutcome).
- **W3** (feed reviewer facts) — INTENTIONALLY NOT IMPLEMENTED: W2's deterministic gate is authoritative, so injecting the same facts into the LLM reviewer would add a redundant proxy (the value/trust section warns against this).
- **W4** (post-action grounding) — DEFERRED per §7: conditional on measured need; carries the DEV-pollution risk and is not required now that W1+W2 close the strict-mode-ambiguity class.

Status: PROPOSAL (2 rounds of adversarial review applied). v3 keeps v2's correct direction
(promote the EXISTING deterministic selector check; do not rebuild it) and adds the precise
wiring the round-2 judges demanded: exact call site, exact reused functions, no fused-union,
no schema surgery. Changelogs: §10 (round 1), §12 (round 2).

## 1. Problem, restated honestly (four axes, not one root)

4 live runs produced `generated_test_defect` (the test, not the app, was wrong) and never
converged. The deterministic detection for the main axis already exists; the gaps are WHERE
it runs and whether it can BLOCK.

- **Axis 1 — the deterministic ambiguity check runs too LATE.** `selectorUnique()`
  (`src/qa/selector-check.ts`) detects strict-mode ambiguity per `role:name`, but is invoked
  ONLY in the post-failure fix loop (`pipeline.ts:2088-2135`). The first execution always eats
  the violation (D4: `getByRole('heading',{name:'Owners'})` on the owners-list route — a route
  the pre-write grounding already renders).
- **Axis 2 — no deterministic BLOCK for a confirmed-ambiguous selector.** `effectiveSeverity`
  (`verdict-validate.ts`) force-blocks `GRAVE_TAGS`, but `fragile-selector` is the one excluded
  `RECOVERABLE_TAG` (`taxonomy.ts:59`), so a confirmed ambiguity can advisory-pass the gate
  (`pipeline.ts:1497`: `review.approved && blockingCount === 0`).
- **Axis 3 — transcription / "agent ignored ground truth."** In D4 the regen prompt already
  carried the Lever-2 contradiction and the agent reproduced the ambiguous locator
  (`spend=false`). A model-instruction-following limit, not a missing-data one.
- **Axis 4 — post-action state coverage.** States that exist only after the test's own
  mutations are not in the pre-write grounding. Guarded/optional (§7), not the keystone.

## 2. What ALREADY exists (reuse, do NOT duplicate — verified in code)

| Mechanism | File | What it already does |
|---|---|---|
| Lever-2 selector verification | `src/qa/selector-check.ts` | `extractProposedSelectors`, `selectorPresent` (present/absent/**verifiable**), `selectorUnique` (per-`role:name`), `hasNonExtractableLocator` (the `.locator(parent)` guard). Pure. |
| **Per-route** pre-write grounding | `src/qa/dom-snapshot.ts` | `captureDomByRoute(routes)` → `RouteSnapshot[]` with raw `.nodes[]` per route; `extractTargetRoutes(specContents)`. Already wired at `pipeline.ts:327` (explorer) and the fused `captureDom` at `pipeline.ts:1419-1425` (reviewer). |
| Lever-2 invocation template (post-failure) | `src/pipeline.ts:2088-2135` | the EXACT per-tree (never fused) loop: extract → `selectorPresent`/`selectorUnique` per tree → `selectorContradictions` ("matches MULTIPLE nodes…") → folded into regen. Tracks `anyNonExtractableLocator`, `anyUnverifiableSelector`. |
| Reviewer gate (pre-execution) | `src/pipeline.ts:1497` (inside `reviewGenerated`) | `gateApproves = review.approved && blockingCount === 0`. Runs BEFORE execute, so a block here saves the first execution. |
| Deterministic severity backstop | `verdict-validate.ts` `effectiveSeverity` + `taxonomy.ts` `GRAVE_TAGS` | force-blocks grave tags; `fragile-selector` excluded by name. |
| Failure-point capture | `config/e2e/fixtures.ts` afterEach (`body.ariaSnapshot()`) → `buildFailureDom`/`buildFailureDomLines` | whole-body post-failure DOM (no scoped subtree). |

## 3. Invariants to preserve (regression guards)

1. DEV execution serial. 2. No agent self-executes the suite. 3. Regen single-agent.
4. Fan-out generation-only. 5. LLM agent read-only on watched repos. 6. **GOLDEN RULE —
agnostic to the app AND the technology under test**: no framework / routing / rendering /
app-specific logic or assumptions anywhere in the design or in `src/`. Every decision must hold
for any stack under test; if a finding is framed around a specific tech, generalize it to the
property it instances. 7. Lever-2's "absent → UNVERIFIABLE, never hard-block"
rule preserved. 8. **Never mutate the `role: name` grounding string** — cardinality is read
via the `selectorUnique` VERDICT, never by annotating the string. 9. Strict TDD; `npm test`
+ `npm run typecheck` green. 10. New blocking fires ONLY on `present && !unique && verifiable`
AND only when the spec has no non-extractable (scoped/`.locator`) locator — never on a guess,
an absent/pruned node, or a scoped locator Lever-2 cannot see.

## 4. Decision on "unify generate + execute": NO (unchanged)

Opposite concurrency semantics; merging regresses the serial-DEV invariant under fan-out and
reintroduces the session-hang. Keep parallel-generation / serial-execution.

## 5. Workstreams v3 — precise wiring

### W1 — Run the EXISTING Lever-2 loop pre-execution, per-route (Axis 1) — keystone
- **Call site:** inside `reviewGenerated` (`pipeline.ts:1401-1497`), where the pre-write
  grounding is already fetched — switch that fetch from the fused `captureDom` string to
  `captureDomByRoute(extractTargetRoutes(specContents))` so each spec's selectors are checked
  **per target route's `RouteSnapshot.nodes[]`**, never a fused union (mirrors the per-case
  discipline at `pipeline.ts:2090-2095`). Reuse the loop body verbatim from `pipeline.ts:2118-2135`
  (`extractProposedSelectors` → `selectorPresent`/`selectorUnique` per route-tree →
  `selectorContradictions`), including the `hasNonExtractableLocator` guard (line 2121) so a
  `.locator(parent).getByRole(...)` spec is skipped, never falsely flagged.
- **No new DEV calls:** `captureDomByRoute` is the same per-route render already wired at
  `pipeline.ts:327`; the reviewer already pays one grounding render — this reuses it.
- **Scope honesty (agnostic):** signals only for e2e apps with `app.dev.baseUrl`; code-mode /
  no-`dev` apps are a no-op. **Pre-write per-route grounding has VARIABLE coverage across apps**
  (shared-shell SPAs, client-rendered or auth-gated routes can yield empty/partial trees) — so
  W1 is BEST-EFFORT and safely degrades to no-op via Lever-2's absent→unverifiable rule. It never
  depends on the grounding being populated and contains NO framework/routing-specific logic
  (Invariant 6). Post-action-only states (Axis 4) are not covered here.
- **The deterministic guarantee does NOT rest on W1.** It is anchored on the always-available,
  tech-agnostic **post-failure live-DOM `ariaSnapshot` (`failureDom`)** — the real rendered DOM
  regardless of the app's stack — where the SAME pure check (the shared function below, used by
  W2) already runs. W1 is the opportunistic early-catch; the post-failure path is the floor that
  holds for any technology under test.
- **Shared pure function (the reusable core, agnostic to tree source):** extract the existing
  inline Lever-2 loop (`pipeline.ts:2118-2152`) into a pure
  `checkSpecSelectors(specSources: string[], trees: string[][])` in `src/qa/selector-check.ts`.
  It is agnostic to WHERE `trees` came from (pre-write grounding OR post-failure capture). The
  fix-loop and W1 both call it; per-tree, never fused.
- **TDD:** unit test — per-route tree with a duplicated `role:name` ⇒ contradiction; a scoped
  (`.locator`) spec ⇒ skipped; an absent/post-login selector ⇒ no contradiction.

### W2 — Deterministic BLOCK ANDed into the EXISTING local gate (Axis 2) — keystone
- **Attachment point (resolved):** W1 runs in the SAME closure as the gate, so extend the
  existing local line `gateApproves = review.approved && blockingCount === 0` (`pipeline.ts:1497`)
  to `&& deterministicSelectorBlocks === 0`, where `deterministicSelectorBlocks` counts W1
  findings that are `present && !unique && verifiable` on a spec with NO non-extractable locator.
  No hoisting, no new gate, no reviewer-schema change, no mutation of the reviewer's
  `blockingCount` (it stays the LLM's count). On block, the EXISTING reviewer-rejection regen
  path runs with the `selectorContradictions` as corrections (the agent gets a deterministic fix
  signal pre-execution); persistence after the capped `MAX_REVIEW_ROUNDS` → the EXISTING hold/
  `invalid`/Issue path. No execution is spent on an ambiguity-confirmed spec.
- **Why this respects the original design:** `fragile-selector` was made recoverable because an
  LLM-flagged fragility is a *guess*. A Lever-2 `present && !unique && verifiable` verdict is
  computed from the same tree the agent saw — not a guess. Blocking on it honors Invariant 10
  and closes the round-1 hole without re-blocking LLM guesses.
- **No false rejection:** block only on present+non-unique+verifiable AND extractable; absent/
  unverifiable/scoped stays advisory (Invariants 7, 10). Per-`role:name` counting means a
  role-scoped locator that is unique for its role is not blocked even if the bare name recurs.
- **TDD:** unit test on the gate predicate — present+non-unique+verifiable+extractable ⇒
  `deterministicSelectorBlocks>0` ⇒ `gateApproves=false`; any other combination ⇒ no block.

### W3 — Carry W1's facts into the reviewer prompt (Axis 2, explanatory)
- **Change:** add `selectorContradictions?: string[]` to `ReviewInput` (and the `deps.review`
  signature) and render them in BOTH reviewer prompts (`agents/agent/qa-reviewer.md`,
  `agent/roles/qa-reviewer.md`) as orchestrator-computed FACTS (reusing the existing
  "App-specific reject-on-sight rules" injection channel), so the reviewer's rationale aligns
  with the deterministic verdict. **The gate decision is W2 (deterministic), not the reviewer
  text** — so the two reviewer files' differing contracts cannot change the block outcome.
- **Regression guard:** additive field; absent ⇒ unchanged behavior.

### W4 — (Guarded, OPTIONAL, last) Post-action state grounding (Axis 4)
- Only if W1-W3 do not close the gap. Requires an **orchestrator-injected unique explore
  sub-namespace** (`qa-bot-<sha>-explore-<n>`, distinct from the per-attempt execution
  namespace) so authoring data cannot collide with the run (closes round-1 A3/B3), and a HARD
  per-flow MCP-call cap enforced in the prompt (closes round-1 A4 — runs already breach soft
  budgets). Demoted from v1's keystone; gated on measured need.

### Transcription (Axis 3) — explicit consequence, not a cure
W2 prevents the silent advisory-pass and feeds the deterministic contradiction into regen; if
the agent still cannot produce a unique selector after the capped rounds, the EXISTING
`break-needs-human` path fires sooner (correct — a real model-capability limit, out of
grounding's reach). v3 does not claim to cure transcription; §9 measures the residual.

## 6. Sequencing

```
W1 (per-route Lever-2 in reviewGenerated) ──► W2 (AND into local gate) ──► W3 (reviewer facts)
                                                       └► measure ──► W4 only if needed
```

## 7. Why W4 / "ground post-action during authoring" is risky

Authoring mutations create DEV data under the run-level prefix (not the per-attempt execution
namespace, which only exists in `testInfo` at run time) — on a no-delete app this reintroduces
the namespace collision and pollutes DEV. Viable ONLY with an injected explore sub-namespace +
a hard MCP budget. Hence guarded and last.

## 8. — n/a

## 9. Success metrics (instrumentable + falsifiable)

Add to `RunOutcome.gateSignals` (`src/types.ts`) AND the `persistOutcome` `overrides` object
(`pipeline.ts:907`) AND `labelRunOutcome`:
- `preExecAmbiguityCatches?: number` — W1 findings (present+non-unique) per run.
- `deterministicSelectorBlocks?: number` — times W2 force-blocked.

Populate at the `reviewGenerated` site. Falsifiable primary metric: **3 consecutive runs of the
same app at the same SHA and mode reach `pass` (or real-bug `fail`) with NO agent-prompt edits**,
read from `RunOutcome.verdict` + `RunOutcome.sha` in `src/server/history`. Axis-3 residual:
`generated_test_defect` runs with `spend=false` fall as W1+W2 land. No-regression: `npm test`
(900+) + `npm run typecheck` green.

## 10. Changelog — round 1 (11 findings)
1. "additive payload" false → string annotation dropped (Inv. 8); use the `selectorUnique` verdict.
2. Workstream-D wrong file / fictional container-subtree → removed; failure path correctly attributed (§2).
3. No deterministic backstop → W2 blocks on the Lever-2 verdict, not the tag.
4. W-B namespace isolation false → W4 needs an injected explore sub-namespace; demoted.
5. per-name vs per-`role:name` → reuse `selectorUnique` (already per-`role:name`).
6. W-E duplicated Lever-2 → removed; W1 reinvokes the existing loop.
7. root-cause overfit / transcription → four axes; Axis 3 named, handled via W2 + escalation.
8. gate citation → `pipeline.ts:1497`.
9. two reviewer files differ → W3 injects facts to both; gate is W2.
10. metrics unfalsifiable → §9 fields + a named falsifiable target.
11. "fixed this session" → see §11.

## 11. Session-applied changes (context, not part of this proposal)
This session also applied three working-tree changes (not yet committed), unrelated to the W1-W4
proposal: `repo-mirror.ts` `hardenGitArgs` (git `safe.directory=*`), `config/e2e/fixtures.ts`
per-attempt namespace, and the AGENTS.md value-grounding rule. They are listed only as context;
this proposal stands independent of them.

## 12. Changelog — round 2 (resolutions)
- **W1 "captureDom lines" was a string, not per-route `string[]` (CRITICAL ×2):** W1 now uses
  `captureDomByRoute` → `RouteSnapshot.nodes[]` per route; no fused union (§5/W1).
- **W2 "blockingCount contribution" had no attachment point (CRITICAL ×2):** W2 is now an AND
  into the EXISTING local `gateApproves` in the same closure as W1 (§5/W2) — no hoisting, no
  schema change.
- **`gateSignals` fields don't exist (CRITICAL ×2):** §9 specifies the exact additions (types.ts
  + `persistOutcome` overrides + populate site).
- **scoped `.locator(parent)` false-block (real ×2):** W1 reuses the existing
  `hasNonExtractableLocator` guard; W2 blocks only on extractable selectors (Inv. 10).
- **W1 timing / "no new DEV calls" (real ×2):** W1 runs inside `reviewGenerated` (pre-execution,
  reusing the grounding render); a block there saves the first execution.
- **W1 no-op for code-mode/no-`dev` apps (real):** scope note added (§5/W1).
- **authenticated routes / pre-write vs runtime state (real):** W2 blocks only on present+non-unique,
  never on absent → post-login-absent selectors never block (§5/W2, Inv. 7).
- **`MAX_ROUTES`/`MAX_NODES` caps (real/theoretical):** run against raw `.nodes[]`; cap noted (§5/W1).
- **`ReviewInput` field unspecified (theoretical):** §5/W3 names the field + signature change.
- **§10/11 git-diff was ephemeral (theoretical):** §11 drops the git claim; self-contained context note.
- **Axis-3 framing overstated (suggestion):** §5 "Transcription" now says accelerate-escalation, not cure.
- **primary metric loose (suggestion):** §9 names app+SHA+mode+run-count.

## 13. Explicitly rejected
Unify generate+execute (§4); mutate the `role: name` string (Inv. 8); rebuild Lever-2 (reuse it);
block on the LLM's `[fragile-selector]` guess (block only on the deterministic verdict); any
test-app-specific coupling; treat post-action grounding as the keystone (Axis 4 is guarded/last).
