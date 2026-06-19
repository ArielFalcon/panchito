# Implementation Plan v2 — Test-Generation Quality (diff & manual modes)

> Status: **DRAFT for review (v2, post adversarial review)**. Consolidated final-state picture of
> the design discussion, refined after a two-judge adversarial pass. Each phase states the problem,
> the **current state of the code** (to avoid re-building what exists), the final-state solution, its
> integration points (cited by symbol/function — line numbers drift), dependencies, and a verifiable
> done-criterion. Phases are ordered by dependency.
>
> **v2 changelog (what the adversarial review changed):** budget restated in bytes + token-approx
> (no tokenizer exists); `section_sizes` moved Fase 0→1; Fase 0 honestly threads `{runId,role,
> objective}` through `open()` (touches call-sites); DOM kept as **deterministic push of the relevant
> slice** (not on-demand artifact pull, not a new `query_dom` MCP); the explore-first contradiction
> tracked across `AGENTS.md`+skill, not just `prompts.ts`; reviewer phase narrowed to stateful+severity
> (DOM grounding already exists); coverage phase re-scoped (mapping already exists; lever is ops +
> governance); learning phase corrected (keep the candidate exploration floor, strip its *authority*,
> not its existence); iteration-budget split into an early counter (6a) + dimensioned budget (6b);
> complete/exhaustive protected via a shared-surface inventory + regression gate; traceability table
> annotated with current state; file:line replaced by symbol references.

## 0. Guiding principles

1. **Project-agnostic.** No decision tuned to a specific watched app. Must serve trivial single-repo
   and complex multi-repo/microservice systems equally. Only E2E requirement: a DEV env serving
   **unbundled / source-mapped** code. `portfolio`/`petclinic` are fixtures, never design drivers.
2. **`diff` targets a PR, not a commit — but multi-commit ingestion is a precondition not yet wired.**
   The intended principal use case is a whole PR (possibly dozens of commits, many flows). Today
   `RunOptions.commits` defaults to 1 and the multi-commit window is opt-in; **PR-aware ingestion
   (compute a PR's full changed-file/commit range) is a prerequisite this plan assumes and must add**
   (Phase 3). Designs must scale from 1 flow to a large PR and **degrade gracefully to the n=1 common
   case** without a rewrite. We prioritize quality at small scope first.
3. **`diff` and `manual` are one engine**, differing only in *who defines scope* (commits vs a user
   prompt). `exhaustive`/`complete` are **out of scope**: not optimized, and explicitly **protected
   from regression** (they share code paths — see Phase 5).
4. **Transversal over local.** One robust abstraction adapted per stage, not a patch per call-site.
5. **English in the prompt scaffolding** (perf + tokens); user-provided content (manual guidance)
   travels verbatim. *Code-comment* language is a separate concern (CLAUDE.md already requires
   English) handled by a one-off sweep, NOT by the assembler.
6. **Measure, then change.** Phase 0 ships first. Per-phase done-criteria are checked against Phase-0
   data **as each phase lands**; the *holistic* cross-cutting evaluation is Phase 8.

---

## 1. Problem → solution traceability (annotated with current state)

| # | Problem | Current state in code (verified) | Net-new work | Phase |
|---|---|---|---|---|
| P1 | No prompt/output observability | prompts discarded; only a ~600-char output slice in `runs.logs`; turns not recorded | record full turns at the SDK boundary | **0** |
| P2 | Cache not attributable | `usage.ts` **already** sums `cacheRead/cacheWrite` run-wide; `total` excludes cache *by design* | attribute per role/turn (not "measure") | **0** |
| P3 | Prompt structure anti-optimal (volatile-first, DOM at top edge, no repeated critical instr.) | `buildPrompt` returns volatile-first array; DOM at edge by deliberate choice | canonical order via assembler | **1** |
| P4 | Non-English scaffold | role `.md` already English; **Spanish lives in code comments** (e.g. "Fase N") + this plan | assembler stamps prompt scaffold; *separate* comment sweep | **1** |
| P5 | Reviewer `corrections` uncapped free text | class-tag prefix exists; accumulation bounded by `MAX_REVIEW_ROUNDS=2`, so risk is modest | typed size cap (hygiene) | **1** |
| P6 | No global context budget; per-section caps uncoordinated; rules cap mis-scoped | caps are **bytes/chars**; no tokenizer; no per-model window map in `src/` | byte budget + token-approx + window catalog (config) | **2** |
| P7 | OpenCode auto-compaction evicts injected ground-truth | `compaction.auto`, `preserve_recent_tokens:16000`, `tail_turns:2`; 100KB/tool cap | tune compaction (NOT disable); push ground-truth near the write | **2** |
| P8 | Grounding is agentic-PULL; first pass un-grounded | DOM injected only on review/regen; first single-agent pass self-explores | deterministic push pack before first write | **3** |
| P9 | `capDiff` head-by-file can drop changed source; coverage uses raw diff vs capped | confirmed; only bites diffs > `MAX_PROMPT_DIFF_CHARS` (50KB) under enforce | relevance-ordered diff; same diff to gen+reviewer+coverage | **3** |
| P10 | DOM injection fixed 4×60 (~240 lines) — too small for complex apps; non-agnostic cap | `MAX_ROUTES=4`,`MAX_NODES_PER_ROUTE=60`; `capDomLines` prioritizes tables | push the **relevant slice**, sized by budget (no fixed cap) | **3** |
| P11 | "Use injected DOM" vs "you MUST browser_navigate" contradiction | lives in `prompts.ts` working-rules, `qa-generator.md`, **`AGENTS.md` (global)**, worker prompt | make explore-first conditional on "no grounded pack" in ALL copies | **3** |
| P12 | Reviewer doesn't converge | DOM grounding + "stay-in-lane" **already exist**; stateless rounds + binary zero-defect approval do not | stateful rounds + severity gate ONLY | **4** |
| P13 | diff/manual diverge; fan-out keyed on mode; lite workers depend on injected grounding | `shouldFanOut` keys on mode/flag; cardinality only known post-planner; all workers dispatched | plan-first→branch-on-count; per-objective grounding/fallback | **5** |
| P14 | Review/fix loops multiplicative; no shared budget; in-session repair re-prompts uncounted | 4 regen loops (`generateAndReview` re-invoked) + 2 contract-repair re-prompts | shared cycle budget incl. repairs | **6** |
| P15 | Learning self-poisons | exploration-floor is **deliberate** (candidates must run to promote); poison is the *authority framing* + raw-correction recirculation | strip authority/recirculation, KEEP the floor | **7** |
| P16 | Coverage as anchor | bundle→source **mapping already implemented**; `signal` by deliberate default | ops (source maps on DEV) + signal→enforce + a *specific* governance hook | **7** |

---

## 2. Resolved design decisions (the "final-state" the phases assume)

- **Grounding is PUSH.** Orchestrator pre-computes a **Context Pack** per objective and pushes the
  relevant content into the prompt; the agent transcribes. The "RAG we lack" is this push pack via
  Serena/LSP + DOM slice + OpenAPI — **not** a vector store. **Resolution (judge W8/W9):** the DOM is
  captured generously but what reaches the prompt is the **relevant slice, deterministically
  injected** (push) and positioned near the task (survives compaction). **No** on-demand artifact the
  agent must remember to read; **no** new `query_dom` MCP tool (it would break the deliberate
  no-MCP-worker decision). This satisfies both "don't bloat the prompt with a huge DOM" (the slice is
  relevant + budget-sized, not the whole tree, not a fixed 240-line cap) and "don't re-introduce pull".
- **Context Assembler** is the single authority for every boundary prompt: stages declare typed
  sections `{ id, role-in-structure, priority, maxBytes, content|producer, cacheable, overflow:
  summarize|drop, language: scaffold|verbatim }`; the assembler resolves byte-budget, canonical order,
  language, caps, and emits per-section sizes for telemetry.
- **Budget is byte-based with a token-approx.** No tokenizer exists for the opaque `opencode-go/*`
  models. Use bytes (what the code already uses) + a documented `chars≈4/token` approximation + a
  small per-role **model-window catalog in config** (sourced from `opencode models`), with a safety
  margin. Restating budgets in bytes is faithful to the codebase.
- **Reviewer:** add only **stateful rounds** (sees its prior corrections; approves once blocking ones
  are resolved) + **severity gate** (blocking vs advisory). DOM grounding and stay-in-lane already
  exist; the only grounding delta is sharing the **same** pack DOM the generator used.
- **Fan-out is plan-first, then branch on objective count** (not a `shouldFanOut` predicate —
  cardinality is unknown pre-planner). Generalize the existing `objectives.length < 2` fallback to the
  unified diff/manual path; large PR → fan-out lite workers fed per-objective pack slices; an
  ungrounded objective falls back to the strong agent (an explicit new heterogeneous-orchestration
  design item).
- **Learning:** keep the candidate exploration floor (the flywheel needs it for promotion); remove its
  **authoritative framing** to the generator and stop recirculating **raw** reviewer corrections
  unvalidated. Coverage stays the anti-Goodhart anchor; mapping already exists, so the work is ops +
  promotion governance.

---

## 3. Phased plan

### Phase 0 — Turn telemetry (foundation) — P1, P2

**Problem / current state.** No prompt is recoverable; output survives only as a ~600-char slice in
`runs.logs`; `usage` already captures `cacheRead/cacheWrite` but sums **run-wide** with no role
identity. We cannot evaluate later changes without per-turn attribution.

**Final-state solution.** Record every agent turn at the single SDK funnel — the `prompt()` closure in
`defaultAgentDeps.open()` (the same point `onUsage` already fires).
- New durable store `agent_turns` (mirrors `run_events`, 30-day retention): `run_id, session_id, role,
  round, is_repair, ts, objective, prompt_text, output_text, prompt_bytes, tokens{input,output,
  reasoning,cacheRead,cacheWrite}, cost`. **`round`/`is_repair` distinguish regeneration rounds from
  in-session contract-repair re-prompts** (judge B10) so convergence metrics aren't polluted.
- **Honest call-site cost (judge #1):** `open()` opts gain a `{ runId, role, objective }` descriptor.
  `role` is the existing `agent` arg, but `runId` (today threaded via `registerRunSession`) and
  `objective` are **not** at the boundary — so **every `open()` call-site (~10) is edited** to pass the
  descriptor. This is the real scope; the "single funnel" is for the *write*, not the *plumbing*.
- **No `section_sizes` here (judge #3):** per-section accounting needs the assembler; it lands in
  Phase 1. Phase 0 records the whole prompt + bytes + tokens + output only.
- **Sanitize `output_text` at persist** (judge S-B3): the prompt's diff is already sanitized in
  assembly; the agent's *reply* (which can echo DEV data) is the unsanitized surface.
- Read surface: `GET /api/runs/:id/turns` + a report view for offline analysis.

**Integration points.** `opencode-client.ts` (boundary `prompt()`, `open()` opts, all call-sites),
`server/history.ts` (schema + `saveAgentTurn`/`getAgentTurns`), `qa/usage.ts` (role/turn-tagged),
`orchestrator/sanitizer.ts` (output sanitize). Also wire the same descriptor in `codex-strategy.ts`.

**Depends on / enables.** Depends on nothing. Enables every later done-criterion.

**Done when.** For any run we retrieve, per role + per round (repairs flagged): exact prompt, prompt
bytes, output, tokens incl. cache. A CLI/dashboard shows prompt-size and cache-hit trends.

---

### Phase 1 — Context Assembler: structure, language, output caps — P3, P4, P5

**Problem / current state.** Prompts are assembled ad-hoc, volatile-first, DOM at the top edge, no
repeated critical instructions; reviewer corrections reinjected uncapped (though bounded by 2 rounds).

**Final-state solution.** A single `ContextAssembler` is the only producer of boundary prompts. Stages
submit a declarative section plan; the assembler enforces a **canonical structure** for every role:

```
[STABLE prefix]   role + working-rules + mode rules + (critical instructions ↑)
[SEMI-STABLE]     architecture map + contracts + diff scope
[VOLATILE]        context-pack DOM slice, reviewer prior-corrections, fix feedback
[TASK]            objective + acceptance criterion (END)
[CRITICAL recap]  the few non-negotiable rules, repeated at the END
```

Fixes P3 (stable-first → cacheable prefix; critical rules bracketed top+bottom → lost-in-the-middle;
task last), P4 (assembler stamps `scaffold` sections English; `verbatim` user content untouched —
**plus a separate one-off code-comment sweep**, since the assembler cannot touch comments), P5 (typed
`maxBytes` per section incl. a hard cap on reviewer corrections — hygiene, given the existing class-tag
+ 2-round bound).
- **Emits `section_sizes`** to Phase-0 telemetry (this is where sections first exist).
- **Precursor (judge #8/W10):** `reviewIndependently` builds its prompt **inline** in
  `opencode-client.ts` and is entangled with session lifecycle/repair. First extract its prompt
  assembly into a pure builder, *then* let the assembler own it. The other three builders
  (`buildPrompt`/`buildWorkerPrompt`/`buildPlanPrompt`) are already pure in `prompts.ts`.

**Integration points.** New `src/integrations/context-assembler.ts`; refactor `prompts.ts` builders to
declare sections; extract reviewer-prompt builder from `opencode-client.ts`.

**Depends on / enables.** Depends on Phase 0. Enables Phases 2–6.

**Done when.** Every boundary prompt comes from the assembler; telemetry shows canonical order +
per-section sizes; reviewer-correction sections never exceed cap; no non-English prompt scaffold;
`cacheRead` observed to rise on the stable prefix for repeated same-role calls (best-effort — see §6).

---

### Phase 2 — Byte budget + OpenCode compaction coordination — P6, P7

**Problem / current state.** No global budget; six byte/char caps stack uncoordinated; one mis-scoped.
OpenCode auto-compaction + 100KB/tool outputs evict injected ground-truth after the agent's own tool
results fill the window.

**Final-state solution.**
- **Byte budget with quotas (judge #2).** The assembler owns a per-role budget = the model's window
  (from a small config **model-window catalog**, since model identity lives only in `opencode.json`,
  opaque to `src/`) × safety margin, expressed in **bytes** with a documented `≈4 chars/token`
  approximation (no real tokenizer for the opaque models). Quotas by section priority; on overflow,
  summarize or drop per the section's policy, **logged** (no silent truncation). Replaces the six
  uncoordinated caps.
- **Compaction coordination (judge S-B2 — do NOT disable).** The assembler bounds only the *input
  prompt*; it cannot bound the agent's *accumulated tool outputs* mid-turn — that is the runtime's
  domain, and disabling auto-compaction risks hard context-overflow. So **keep auto-compaction** and
  tune `preserve_recent_tokens`/`tail_turns` (decided with Phase-0 window-pressure data) so the pushed
  ground-truth, placed in the VOLATILE band near the task, stays within the preserved-recent window at
  write time.
- **Session policy for cache.** Reviewer stays in its own session (independence invariant). Reusing
  the generator's session across its *own* regenerations is a measured option (validated via
  `cacheRead`), not a default.

**Integration points.** `context-assembler.ts` (budget), config (model-window catalog),
`agents/opencode.json` (compaction tuning), `opencode-client.ts` (session policy).

**Depends on / enables.** Depends on Phase 1. Enables Phase 3.

**Done when.** Telemetry shows prompt bytes bounded by the role budget on every call; ground-truth
provably in-window at write time (instrumented runs show no "invented selector despite grounding").

---

### Phase 3 — Grounding push: the Context Pack — P8, P9, P10, P11

**Problem / current state.** Grounding is agentic-pull; deterministic DOM arrives only on review/regen;
`capDiff` head-by-file can hide changed source; DOM block is a fixed too-small 4×60; the explore-first
mandate contradicts injected-DOM and **also lives in the global `AGENTS.md`**.

**Final-state solution.** The orchestrator builds a deterministic **Context Pack per objective**,
**before** the first write, and the agent transcribes:
- **PR-aware blast radius (principle 2).** Add PR-aware ingestion (union of changed files/symbols
  across the PR's commit range) and drive Serena/LSP **once on the orchestrator** over those symbols
  (callers/callees). LSP, not embeddings — precise for "what does this change affect". Multi-commit
  degrades to n=1.
- **Contracts.** Relevant OpenAPI operations the scope touches, microservice-aware via existing
  `services[]` + `context.json`.
- **DOM as pushed relevant slice (P10, judges W8/W9).** Capture the a11y tree of the scope's routes
  **generously** (no fixed 4×60; table/list priority preserved), then **push only the relevant slice**
  into the VOLATILE band of the prompt, sized by the Phase-2 budget. No on-demand artifact the agent
  must remember to read; no new MCP tool. For lite workers (no MCP) the pushed slice is the *only*
  viable grounding.
- **Diff relevance (P9).** Replace head-by-file `capDiff` with relevance ordering (changed-source
  hunks first by the PR's symbols; lockfiles/generated last/omitted) and feed generator + reviewer +
  coverage the **same** diff (kills the unsatisfiable-coverage-gap; note it only bites >50KB diffs).
- **Resolve P11 in ALL copies (judge #12/B5).** Make explore-first **conditional on "no grounded pack
  present"** in `prompts.ts` working-rules, `qa-generator.md`, the `playwright-authoring` skill, and
  the **global `AGENTS.md`** — otherwise the global rule overrides the transcribe framing and the
  contradiction merely relocates.

**Integration points.** New `src/qa/context-pack.ts` (orchestrator Serena/DOM/contract capture +
per-objective packaging); PR-aware ingestion in `index.ts`/repo-mirror; `dom-snapshot.ts` (generous
capture + slice selection); `sanitizer.ts`/`capDiff` (relevance); assembler (pack sections);
`AGENTS.md` + `qa-generator.md` + `qa-worker.md` + skill (conditional explore-first).

**Depends on / enables.** Depends on Phases 1–2. Enables Phases 4–6.

**Done when.** First-pass prompt carries the pack slice; zero self-navigation for grounded routes;
changed source always present in the diff seen by gen+reviewer+coverage; DOM scales past 240 lines for
a complex app within budget.

---

### Phase 4 — Convergent, severity-gated reviewer — P12

**Problem / current state.** The reviewer **already** gets an orchestrator-captured DOM snapshot and a
"stay-in-lane / judge UI facts only against the DOM" rule. What it lacks: memory across rounds and a
severity threshold (binary zero-defect approval → non-convergence).

**Final-state solution (narrowed to the real delta).**
- **Stateful rounds.** Reviewer receives its own prior corrections + rule: *approve once the prior
  blocking issues are resolved; don't invent new nits on resolved specs.* (Assembler carries the
  prior-corrections section.)
- **Severity gate.** `corrections` split **blocking** (false-positive / wrong-objective /
  missing-cleanup) vs **advisory** (style/robustness nits); only blocking fails the gate. Add a
  `severity` field to `ReviewerVerdictSchema`.
- **Share the pack DOM.** The reviewer judges UI facts against the **same** Context-Pack slice the
  generator used (today it captures its own), removing capture divergence. The existing stay-in-lane
  rule remains; an unconfirmable selector is **advisory: re-verify**, never blocking.

**Integration points.** `qa-reviewer.md` + extracted reviewer-prompt builder, `orchestrator/schemas.ts`
(severity), `pipeline.ts` (gate consumes blocking-only), assembler (prior-corrections + pack DOM).

**Depends on / enables.** Depends on Phase 3 + Phase 1. Enables Phase 6.

**Done when.** Telemetry shows reviewer corrections shrink round-over-round; blocking vs advisory
recorded; approve-rate on good suites rises without publishing worthless ones.

---

### Phase 5 — Unified diff/manual engine + plan-first scale fan-out — P13

**Problem / current state.** diff/manual diverge accidentally (exemplars only diff; archetype noise in
manual). Fan-out keys on **mode**; cardinality is unknown at `shouldFanOut`; all workers are dispatched
and an ungrounded worker guesses. These paths are **shared with `complete`/`exhaustive`**.

**Final-state solution.**
- **One engine, two scope sources.** Collapse diff/manual into one "scoped generation"; only objective
  derivation differs (commits vs guidance). Gate exemplars/archetypes by relevance to the scope shape,
  identically for both.
- **Plan-first, then branch on count (judge #7/B3).** Don't rekey `shouldFanOut` (it can't see
  cardinality). Generalize the existing `objectives.length < 2` fallback: always plan, then small scope
  → one strong agent; large PR with many objectives → fan-out.
- **Per-objective grounding + fallback (judge W7).** Each lite worker gets its objective's pack slice
  (DOM + blast radius) → transcribes real selectors. An objective with no grounded route is **not
  dispatched blind** — it falls back to the strong agent. This heterogeneous partial-fan-out is an
  **explicit new design item** (manifest consolidation, mixed-agent concurrency/timeout), not "the
  decision stays".
- **Protect out-of-scope modes (judge #11/B4).** `complete`/`exhaustive` reach fan-out through the
  **same** `shouldFanOut`/`runOpencodeParallel`/`generateParallel`/`buildWorkerPrompt`. Maintain a
  **shared-surface inventory** + a **regression-test gate** proving their behavior is unchanged.

**Integration points.** `opencode-client.ts` (plan-first branch, per-objective pack slices, mixed
fallback), `pipeline.ts` (unified scope front-end), `prompts.ts` (relevance gating), a regression test
for complete/exhaustive.

**Depends on / enables.** Depends on Phases 3–4. Enables large-PR scale.

**Done when.** Small scope → one agent; large PR → fan-out; one shared code path; manual carries no
diff-only/irrelevant sections; no worker dispatched ungrounded; complete/exhaustive regression-green.

---

### Phase 6 — Iteration budget — P14

**Problem / current state.** Four regen loops (review `for`, static-fix `while`, exec-fix `for`,
coverage-enforce single `if`) each re-invoke `generateAndReview`; plus **two in-session contract-repair
re-prompts** (generator + reviewer). Multiplicative cost → the ~20-min runs.

**Final-state solution — split for early relief (judge #13/W1).**
- **Phase 6a (early, near-independent):** a single **shared cycle counter** across all four loops +
  the contract-repair re-prompts (judge B6), bounding total model turns per run. This is mostly
  `pipeline.ts` plumbing and can land right after Phase 0 for immediate symptom relief, before the
  assembler/pack work.
- **Phase 6b (later):** dimension the budget by scope (needs Phase 2) and skip redundant work —
  fix-only rounds don't re-run exploration (the pack is present), and reviewer convergence (Phase 4)
  settles most runs in one round.

**Integration points.** `pipeline.ts` (`generateAndReview` + the four loops share a counter;
count repairs from `opencode-client.ts`), Phase-2 budget (6b).

**Depends on / enables.** 6a depends only on Phase 0. 6b depends on Phases 2 + 4. Enables the
wall-clock target.

**Done when.** Telemetry shows total turns/run bounded (repairs included) and median wall-clock
materially down, with no drop in published-suite quality.

---

### Phase 7 — De-poison learning + coverage anchor — P15, P16

**Problem / current state.** The exploration-floor is **deliberate** (candidates must run in the
generator to accumulate outcomes and promote); the poison is the **authoritative framing** + raw
reviewer-correction recirculation. Coverage bundle→source **mapping already exists**; it's `signal` by
default and the governance lever is hand-wavy.

**Final-state solution.**
- **Keep the floor, strip the authority (judge #4/C2).** Candidates keep being exercised by the
  generator (promotion path intact), but the prompt framing drops from "derived from real failures,
  apply them" to "experimental — consider". Do **not** recirculate **raw** reviewer corrections as
  generator instructions without validation. Archetypes relevance-gated to the scope.
- **Coverage anchor (judges #5/W4/B7) — ops + governance, not "make mappable".** Mapping is built;
  the levers are: (a) document/require source maps on DEV (already a stated requirement + already
  logged as remediation), and (b) a **specific governance hook**: gate candidate-rule *promotion* on
  coverage-confirmed credit where coverage is measured (lean on the non-circular signal, not rule
  volume). Coverage stays non-blocking where unmeasurable.

**Integration points.** `qa/learning/learning-rule.ts` (generator render framing — keep eligibility),
`qa/learning/distiller.ts` (no raw recirculation), `qa/learning/curriculum.ts` (relevance gating),
`qa/change-coverage.ts` + `pipeline.ts` (promotion-credit governance).

**Depends on / enables.** Depends on Phase 0 (measure rule value) + Phase 4. Final hardening.

**Done when.** Generator prompt carries proven+relevant rules (candidates clearly framed experimental,
not authoritative); promotion credit is coverage-anchored where measurable; no measurable degradation
from recirculated noise.

---

### Phase 8 — Holistic telemetry evaluation (after all phases)

Per-phase done-criteria are checked against Phase-0 data as each phase lands (judge S1). The **first
holistic** analysis happens here: pull `agent_turns` across representative diff/manual runs and assess
prompt sizes/structure, cache-hit, reviewer convergence, grounding presence at write time, turn
counts/wall-clock, and published-suite quality. Drives the next iteration.

---

## 4. Dependency graph (build order)

```
Phase 0 (telemetry)
   ├─> Phase 6a (shared cycle counter incl. repairs)  ← early symptom relief, near-independent
   └─> Phase 1 (assembler: structure, language, caps; emits section sizes)
          └─> Phase 2 (byte budget + compaction tuning + model-window catalog)
                 └─> Phase 3 (Context Pack: PR-aware blast radius + contracts + DOM slice + diff relevance + P11 in AGENTS.md)
                        ├─> Phase 4 (stateful + severity reviewer, shares pack DOM)
                        │      └─> Phase 6b (dimensioned iteration budget)
                        └─> Phase 5 (unified engine + plan-first fan-out + complete/exhaustive regression gate)
   Phase 7 (de-poison learning + coverage governance) ← depends on Phase 0 + Phase 4
Phase 8 (holistic evaluation) ← after all
```

## 5. Out of scope (explicit non-goals)

- Optimizing `exhaustive`/`complete` (but **protected from regression**, Phase 5).
- A vector/embeddings RAG of code or DOM (LSP + pushed DOM slice is the mechanism).
- A real per-model tokenizer (byte budget + `≈4 chars/token` approximation instead).
- Project-specific tuning.

## 6. Cross-cutting risks & mitigations

- **Provider-side caching is opaque (judge S2).** "cache-hit rises on a stable prefix" assumes the
  `opencode-go` gateway does prefix caching keyed on a stable lead — unverified, per-model. Treat
  cache-hit as a **best-effort** signal validated in Phase 0, **not** a hard phase gate.
- **Model roster (judge S-B1).** Generator + maintainer share `kimi-k2.7-code`; reviewer is
  `minimax-m3` (independence holds); workers/explorer/etc. share `deepseek-v4-flash`. Cache is
  model-scoped → workers sharing one model/prompt-shape may show cache benefit differently than the
  generator. Re-derive caching assumptions from `opencode.json`, not "3 distinct models".
- **Reorder vs attention.** Stable-first may move ground-truth off the top; mitigate with the
  end-recap + a top pointer; validate via Phase 0 (no rise in invented selectors).
- **DOM slice selection** must not drop the nodes the objective needs; reuse `capDomLines` table/list
  priority and log what was sliced out.
- **Compaction tuning is gateway-dependent;** decide with Phase-0 window-pressure data, never disable.
- **PR-aware ingestion is a new precondition** (principle 2); until wired, the engine runs the n=1
  path it has today.
