# migration-tier-4c — Decisions of Record

Date: 2026-07-14. Change: `migration-tier-4c` (branch `fix/migration-tier-4c`, based on tier-4b).
Scope: `src/integrations/opencode-client.ts` (1985 ln) + `src/integrations/prompts.ts` (1879 ln) +
`prompts.test.ts` (1631 ln) + `opencode-client.test.ts` (3060 ln) decomposition — the Tier-4 cluster
named "unstarted, 2 known live bugs" in `docs/superpowers/2026-07-09-src-qa-engine-migration-triage.md`
§4. Design: `sdd/migration-tier-4c/design` (engram #1312, **Rev 2** — amended after a fresh-context
gate FAILed the Rev-1 "transport+SSE stay shell wholesale" claim). Spec: `sdd/migration-tier-4c/spec`
(engram #1311). Tasks: `sdd/migration-tier-4c/tasks` (engram #1314).

---

## 1. In-scope migrated (7 slices, 9 work-unit commits)

| # | Slice | Destination | Commit(s) |
|---|---|---|---|
| 1 | Dead-surface deletion (5 test files + fan-out/plan family, ~3925 net deleted lines) | — (deleted) | `e29457e` |
| 2 | Session-transport split: `circuit-breaker.ts`/`stall-watchdog.ts` + `defaultAgentDeps` open/prompt POLICY | `qa-engine/.../generation/infrastructure/{agent-transport-policy.ts,resilience/}` | `38ff328` |
| 3 | SSE split: `EventStreamManager` lifecycle + `reexplore`/`activity-mapper`/`agent-activity` | `qa-engine/.../generation/infrastructure/sse/event-stream.ts` | `e5e9645` |
| 4 | Chat shell split: `askAssistant`/`getOpenSessionCount(s)` declared permanent shell (comment-only) | — (unchanged, documented) | `20839a4` |
| 5a | Prompt builders relocation: 5 builders + `prompts.test.ts` + widened-scope co-movers | `qa-engine/.../generation/infrastructure/prompt-builders/` | `eea7aea` |
| 5b | model-window-catalog D-4c-6 fix + qa-worker budget fix + 2nd-known-bug fix | (same, in place) | `ba5bf4e`, `cc0a4b6`, `a062844` |
| 6 | Parity retirement: `generation-ports-parity.test.ts` deleted, seam-parity (a)/(b) removed, orphaned decls deleted | — (deleted) | `beaf774` |
| 7 | Closeout (this doc, CLAUDE.md, triage doc, deferral register) | (docs only) | this commit |

`opencode-client.ts` ends this tier at 493 ln (from 1985): a thin shell holding ONLY the raw
`@opencode-ai/sdk` I/O closure (client construction, `session.create/prompt/abort/delete`,
`event.subscribe`) plus the permanent D1-family control-plane wrappers (`askAssistant`,
`getOpenSessions`/`getOpenSessionCount`). `prompts.ts` (+ its riders `context-assembler.ts`,
`model-window-catalog.ts`, `skill-exemplar.ts`, `structural-pattern.ts`) lives entirely in
`qa-engine/src/contexts/generation/infrastructure/prompt-builders/`. `npm run arch:check` stayed at
0 violations throughout (191 modules, 492 dependencies at HEAD, up from 179/466 at tier-4b's own
Slice-1 checkpoint).

---

## 2. THE KEY DECISION — the design's Rev-2 amendment (two-tier transport/SSE split)

Design **Rev 1** claimed transport (`defaultAgentDeps`) and SSE (`EventStreamManager`) should stay
shell WHOLESALE, reasoning from CLAUDE.md's "one HTTP boundary (`src/integrations/opencode-client.ts`
↔ `opencode serve`)" sentence. A fresh-context gate review FAILed this: that sentence describes the
PRE-migration process split and lists `opencode-client` alongside `repo-mirror`/`validate`/`execute`/
`setup` — files THIS PROGRAM already migrated — so citing it to justify NOT migrating opencode-client
is circular. The gate's correction, adopted as **Rev 2** (the design actually applied):

- **(i) genuinely-raw SDK primitives stay SHELL, injected as lowered primitives** — client
  construction, `session.create/prompt/abort`, `event.subscribe`. Legitimate D1-family edge (the same
  category `src/agent-runtime/*` already occupies).
- **(ii) policy / lifecycle / resilience logic MIGRATES to qa-engine**, consuming the injected
  primitives — `circuit-breaker.ts`, `stall-watchdog.ts`, the `defaultAgentDeps` open/prompt POLICY
  (fallback-model retry, circuit-breaker gating, turn/usage telemetry, sanitize-before-emit),
  `EventStreamManager`'s refcounted lifecycle, and the prompt builders.

This is the SAME split tier-4a's `github-pr.adapter.ts` already established (raw `fetch` stays shell;
auto-merge-fallback POLICY lives in qa-engine) — Rev 2 applies it consistently instead of carving out
an exception for this file. Net effect: NOTHING with domain/policy content stays "in exile" in shell;
opencode-client.ts's residue after 4c is provably just the raw I/O closure + declared thin shell
survivors, not a policy dump that never got migrated.

---

## 3. Dead-code deletion (Slice 1) — the ParallelWorkerInput escalation

A fresh per-symbol zero-real-caller grep (prod only) confirmed dead: `maybeExplore`, `runOpencode`,
`ReviewResult`, `reviewIndependently`, `generateParallel`, `runOpencodeParallel`, `shouldFanOut`,
the plan-parse family (`parsePlan`/`parsePlanResult`/`planNeedsRepair`, `PlanObjective`/`PlanResult`),
manifest helpers (`ManifestEntry`/`ManifestFs`/`realManifestFs`/`sha256File`/`upsertManifest`),
`MAX_STRONG_FALLBACK`, `buildPlanPromptAssembled`/`buildPlanPrompt`, and
`plan-parser.adapter.ts`'s `parsePlan` (+ its 2 test files, D-4c-4). Five whole test files deleted:
`generate-tests.characterization.test.ts`, `verdict-repair.test.ts`, `manifest-validate.test.ts`,
`reviewer-rules-prompt.test.ts`, plus `plan-parser.adapter.test.ts`/`-parity.test.ts`.

**ONE symbol was ESCALATED, not deleted**: the local `ParallelWorkerInput` interface in
`opencode-client.ts` had zero production callers (its only real consumers —
`generateParallel`/`runOpencodeParallel`/`shouldFanOut` — died in this same slice), but
`generation-ports-parity.test.ts`'s AssertNever key-drift gate still structurally imported it to
prove the canonical `generation-ports.ts` mirror hadn't dropped a field. Deleting it in Slice 1 would
have broken that test between commits — a never-commit-red violation. **Resolution**: restored as a
type-only declaration with an explanatory comment naming Slice 6 as its owner, alongside
`OpencodeRunInput`/`ReviewInput` (kept for the same parity-gate reason). **Escalation resolved in
Slice 6** (commit `beaf774`): `generation-ports-parity.test.ts` deleted wholesale, and
`OpencodeRunInput`/`ReviewInput`/`ParallelWorkerInput` deleted from `opencode-client.ts` in the SAME
commit as their last consumer's deletion — confirmed via a fresh grep immediately before deleting
(zero remaining references anywhere in `src/` or `qa-engine/` beyond historical comments).

---

## 4. D-4c-6 — the model-window-catalog split-brain fix (before/after)

**Before**: `roleWindowBytes(role)` resolved EVERY role's context-window budget solely from
`agents/opencode.json`'s static roster — even for the three VISIBLE roles (`qa-generator`,
`qa-reviewer`, `qa-assistant`) that a REAL run might have reassigned to a different model via
`AgentRuntimeConfig.assignments` (env/dual-mode aware, `src/agent-runtime/config.ts`). A dual-mode
run (reviewer on a different provider/model than opencode.json's roster) would silently budget the
reviewer prompt against the WRONG model's context window — a real "split-brain" between what actually
executes and what the budget check assumes.

**After**: `roleWindowBytes` resolves the three visible roles (`qa-generator`→primary,
`qa-reviewer`→reviewer, `qa-assistant`→chat — the SAME legacy-agent-name→role map
`src/agent-runtime/types.ts`'s `roleForLegacyAgent` already establishes, structurally mirrored locally
since qa-engine may not import that src/ file) from an INJECTED `RuntimeRoleModels` assignment FIRST,
via a new `setRuntimeRoleModels` module-level setter wired from `configFromEnv()` at
`opencode-client.ts`'s own module load (mirrors the `RawAgentTransport`/`RawEventStreamOpener`
late-bound-injection discipline Slices 2/3 established). Every OTHER role (workers, explorer,
maintainer, reflector — none has its own `AgentRuntimeConfig` assignment; `assignmentForRole` aliases
them to `primary`, which would be WRONG for budget purposes) keeps the pre-fix opencode.json-only
resolution, UNCHANGED. `warnFallbackOnce` now ALSO fires on a cross-source disagreement (assignments
resolved one model, opencode.json configures a different one for the same role), not only on a
config-read failure. TDD: 6 new tests (dual-mode reviewer resolution gpt-5.5/128K vs opencode.json's
minimax-m3/32K, env-override propagation, chat-role resolution, non-visible-role fallback preserved,
not-wired backward-compat, disagreement warning). Commit `ba5bf4e`.

**Deviation, documented**: wired in `opencode-client.ts`, NOT `rewritten-engine-factory.ts` as the
tasks artifact's literal wording named — `opencode-client.test.ts` independently re-exercises the
budget-role path via `"./opencode-client"`, and Node's ESM module cache is per-test-file, not shared,
so wiring only at the composition root left that test file's own module graph unwired. Moving the
wiring to `opencode-client.ts`'s own module load (mirroring its existing `setRawEventStreamOpener`
precedent) covers every real production AND test entry point in one place.

---

## 5. The qa-worker budget bug fix (Slice 5b, commit `cc0a4b6`)

`buildWorkerPromptAssembled` selected the fan-out worker's context-window budget via a HARDCODED
`roleWindowBytes("qa-worker")`, regardless of whether the worker actually ran as `qa-worker` (UI,
`needsUi: true`) or `qa-worker-code` (code-only, `needsUi: false`) — two DIFFERENT roles the
session-open call site (`rewritten-engine-factory.ts`'s `worker`/`workerCode` mapping) already
distinguishes. Fixed: the budget role now derives from `w.needsUi` (`"qa-worker"` when true,
`"qa-worker-code"` when false), matching the session-open mapping exactly. This bug was SILENT in
production because the real roster happens to assign both roles the same model today — TDD used a
temp `opencode.json` with deliberately DIFFERENT catalog windows per role to prove the call site picks
the correct budget for each `needsUi` value.

---

## 6. The capDiff fix (Slice 5b, commit `a062844`) — flagged as a BEST-EFFORT INFERENCE

The 2026-07-09 triage doc's Tier-4 line named `prompts.ts` as carrying "2 known live bugs" but gave
**ZERO specifics beyond the count** — no second bug is named anywhere in the proposal, design, spec,
or that triage doc itself. Task 5b.5 required re-deriving this fresh against HEAD. An exhaustive
search of engram + docs for any concretely-documented "known bug" on prompts.ts's own hot path found
exactly ONE candidate that predates the triage note: engram bugfix #919 ("`sanitizer.ts capDiff`
silently drops first-file diff section when oversized"), registered 2026-07-02 — one week before the
triage note — sitting directly on prompts.ts's diff-capping path (`cappedDiffText` → `capDiff`), with
its own root-cause trace and proposed fix already written down, governed by this project's own
bug-register protocol ("fixes ship as separate declared changes with their own tests").

**This identification is explicitly NOT a certainty.** No stronger candidate existed anywhere
searched, and the model-window-catalog split-brain bug (§4 above) already accounts for ONE of the "2
known" bugs with full confidence (it was named and reproduced at design time), while the qa-worker
budget bug (§5) was ALSO fixed as a genuinely distinct, additional defect found during this tier — so
the "2 known live bugs" count may in fact already be satisfied by those two, making bugfix #919 a
THIRD, independently-real defect rather than necessarily "the" second one the triage note meant. It
was fixed anyway because it is a real, live, well-documented defect on prompts.ts's own hot path
regardless of which count it satisfies.

**The fix itself**: `diff.split(/^(?=diff --git )/m)` always treated `rawSections[0]` as an
unconditional preamble, even when a real git diff's first section IS the first file's own section
(not a preamble) — i.e., whenever it itself starts with `diff --git `. Two compounding failure modes:
(1) an oversized first file in a multi-file diff vanished with zero trace while a smaller second file
survived "for free"; (2) a genuinely single-file diff over budget produced ONLY the truncation marker
with zero real content, falsely claiming "0 file(s) omitted" (the degenerate hard-truncate fallback
never fired because `fileSections` stayed empty). Fixed: `rawSections[0]` now folds into
`fileSections` (subject to relevance-sort/budget-check/omission-naming) whenever it starts with its
own header; only a TRUE preamble stays unconditionally kept. TDD: replaced the 3 existing "KNOWN BUG"
approval tests with fixed-behavior assertions.

**Deliberate divergence**: this fix intentionally diverges qa-engine's `prompt-cap.ts` from the
now-inert `src/orchestrator/sanitizer.ts` copy of `capDiff` (zero remaining production callers after
Slice 5a's relocation — prompts.ts was its last one; no parity test pins the two together for this
function, unlike `sanitizeText` which has its own dedicated `-parity.test.ts`). See §9 below — the
inert `sanitizer.ts` `capDiff` export is a residual cleanup item deferred to 4d.

---

## 7. Twin wiring — two different mechanisms, chosen by whether a cross-boundary need survived

Two dormant adapter "twins" needed a genuine production call path once prompts.ts relocated:

- **`ContextAssemblerAdapter`**: wired INTERNALLY within the relocated `context-assembler.ts` (its
  internal `assemble`/`section` implementations renamed to `assembleImpl`/`sectionImpl`; the public
  `assemble`/`section` exports now delegate through one module-level constructed adapter instance).
  Chosen because `context-assembler.ts` relocated WHOLESALE alongside `prompts.ts` — both now live in
  qa-engine as siblings, so there is NO cross-boundary need left to bridge. Zero risk to prompts.ts's
  30+ existing call sites (none needed to change).
- **`ExplorationBriefAdapter`**: wired via a NEW late-bound module-level setter
  (`setExplorationBriefCollaborators`), called once at `opencode-client.ts`'s own module load. Chosen
  because `src/qa/exploration-brief.ts` genuinely STAYS in shell (its `renderExplorationBrief` is a
  VALUE import prompts.ts needs, but qa-engine may not import src/ directly) — a real cross-boundary
  need survives the relocation, so the heavier late-bound-injection mechanism is required.

**The lesson for future slices**: check which case applies BEFORE assuming a dormant twin needs the
heavier cross-boundary mechanism — a wholesale co-relocation often dissolves the need entirely.

---

## 8. Slice 5a's widened scope (a fresh dependency audit, not a plan gap)

Per this program's own "fresh grep, don't trust the tasks artifact's cached file list" discipline, a
dependency audit run BEFORE moving `prompts.ts` found MORE src/-resident dependencies than either
slice's task list named:

1. `../orchestrator/sanitizer` (VALUE imports `sanitizeText`/`assertNoSecretLeak`/`capText`/
   `capDiff`/`extractDiffFilePath`) — `sanitizeText`/`capText`/`capDiff` already had qa-engine ports;
   `containsSecrets`/`assertNoSecretLeak` did NOT (`sanitize-text.ts`'s own header had explicitly
   deferred them). Ported verbatim with parity tests. `extractDiffFilePath` was module-private in
   `prompt-cap.ts` — exported (no logic change).
2. `../qa/context`'s `ArchitectureContext` and `../types`'s `QaCase` (both type-only, but STILL count
   under qa-engine's `tsPreCompilationDeps: true` dependency-cruiser setting) — re-pointed to their
   EXISTING canonical qa-engine mirrors.
3. `../qa/exploration-brief`'s `renderExplorationBrief` — see §7 above.
4. `../qa/learning/skill-exemplar` and `../qa/learning/structural-pattern` — BOTH have prompts.ts as
   their ONLY production value-consumer (fresh-grep confirmed) — relocated as RIDERS, mirroring Slice
   1/3's "riders move with the file they serve" precedent.

None of this changed the design's END STATE (prompts.ts lives in qa-engine, byte-identical output) —
it is the necessary connective tissue the design's file list under-specified, resolved with existing
canonical mirrors where one existed, riders where a file's only production consumer was prompts.ts
itself, and the twin-wiring/late-bound-injection pattern where a genuine cross-boundary need
remained.

---

## 9. Deferral register — residual items explicitly deferred to tier-4d

| Item | Why deferred | Revisit condition |
|---|---|---|
| `scrubEnv`'s per-call-site `extraAllowed` widening vector | Each of `execute.ts` (2 call sites), `dom-snapshot.ts`, `setup.adapter.ts` independently passes `extraAllowed: /^DEV_/` — a tier-4b DEFECT-2 design decision (scrubEnv is per-trust-domain, not one shared global allowlist), correctly scoped per call site today, but with NO central audit trail enumerating every widening regex in one place. | Revisit if a new call site widens the allowlist without an equivalent trust-domain justification, or when `execute.ts` itself migrates (tier-4d, seam-pinned). |
| `createAgentDeps` has no DIRECT unit test | `agent-transport-policy.test.ts` (this tier's own new home) covers `withStallWatchdog`/`withSessionRegistration`/`parseModelRef`/`withTimeout`/`agentErrorToInfra` individually, but the composition function itself (fallback-model retry-on-transient-fault, circuit-breaker gating, turn/usage telemetry assembly, sanitize-before-emit, all wired together) has no test exercising it as a whole. This gap PRE-DATES tier-4c (the equivalent shell code was never directly unit-tested either) but is NOW testable in isolation since it lives in qa-engine with injected raw primitives. | Write a `createAgentDeps`-level test in 4d or as a standalone hardening pass — not blocking, since every sub-collaborator it composes is independently pinned. |
| `src/orchestrator/sanitizer.ts`'s orphaned `capDiff` export | Zero remaining production callers (prompts.ts, its last consumer, moved to qa-engine's own `prompt-cap.ts` copy in Slice 5a) — only `sanitizer.test.ts` still imports it, testing dead code. The qa-engine copy diverged from it in Slice 5b (§6 above), so they are no longer even meant to be identical. | Delete `capDiff` from `sanitizer.ts` + its dedicated tests in tier-4d, alongside that tier's other sanitizer cleanup (if any). |

`verdict-parse.ts`/`verdict-validate.ts` remain **descope-with-record** (open design question,
explicitly NOT actioned in tier-4c — now multi-consumer: `codex-strategy.ts`, `verdict-validate.ts`,
`rewritten-engine-factory.ts`, `exploration-brief.ts`, plus `opencode-client.ts`'s own re-export).
`execute.ts`, `src/agent-runtime/*`, `run-history-sqlite-adapter.ts`, `rewritten-engine-factory.ts`
remain the seam-pinned tier-4d cluster — `seam-parity.contract.test.ts`'s surviving (c)/(d)/(e) blocks
still pin them by literal path/field-list; Slice 6 retired only its (a)/(b) blocks (see §1 above and
the triage doc's updated §4/§5).

---

## 10. Security invariants re-verified

`scrubEnv`/raw `process.env` negative grep inside every migrated qa-engine module
(`agent-transport-policy.ts`, `resilience/*.ts`, `sse/*.ts`, `prompt-builders/*.ts`): **zero real
hits** across all slices (a small number of comment-only references explaining the deliberate
env-read-confinement exclusion). Sanitize call sites verified: `sanitizeText`/`capDiff`/`capText`/
`containsSecrets`/`assertNoSecretLeak` all resolve to qa-engine-native ports post-Slice-5a; no prompt
assembly path reads an un-sanitized diff/log.

---

## 11. Final gate status (all 9 commits, combined HEAD)

`nvm use v24.11.0 && npm test && npm run typecheck && npm run arch:check`:

- `npm test`: 3649 pass / 0 fail / 1 skipped (pre-existing, unrelated). Net change across the whole
  tier vs the tier-4b baseline: dead-surface deletion (Slice 1) removed far more than it added; Slice
  6's parity retirement removed 8 tests (3 `generation-ports-parity.test.ts` + 5 `seam-parity`
  (a)/(b)); every behavioral assertion this tier's migrated code still needs is preserved in its new
  qa-engine home (moved, not dropped).
- `npm run typecheck`: GREEN (5 programs: qa-engine build, root, qa-engine noEmit, parity, scripts).
- `npm run arch:check`: GREEN, 0 violations, 191 modules / 492 dependencies cruised (up from 179/466
  at the Slice-1 checkpoint).
