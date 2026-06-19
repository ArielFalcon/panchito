# Plan — eliminate the per-retry re-exploration cost

**Status:** reviewed (judgment-day round 1 applied; corrections verified against source)
**Scope:** generic engine only (`src/` orchestration + `agents/`+`agent/` prompts).
**No app-coupled logic** — the cause is attacked in the engine, never in a watched app's config.
**Priority frame:** the repo's order is *stable → reliable → deterministic → features*. The
prompt-only fixes here are low-risk; the one architectural fix (session reuse) is explicitly
gated behind measurement because a long-lived session is a determinism/reliability risk.

> **Judgment-day note.** This plan's first draft mis-located the proximate cause and proposed
> an infeasible telemetry tap. The corrected diagnosis below was verified directly against the
> code (every claim is cited). Key corrections: the dominant driver is the **orchestrator's own
> prompt text commanding navigation** (not just the agent's static role doc); the failure-retry
> "do-not-navigate" framing is **conditional** and inverts to a navigate-*command* when no failure
> DOM was captured; the activity stream **cannot see tool names** as built; and the Codex role
> doc must be **ported**, not mirrored.

---

## 1. Problem

A manual run over petclinic took **~34 minutes** and produced a single spec file. The fix-loop
kept re-entering its retry phase, and **each cycle (~7–8 min) re-did the whole orientation**: it
re-entered the DEV app in a browser, re-snapshotted the DOM, and re-read source files — work it
had already done. The run was correctly *bounded* (the progress gate stopped it at retry 2/2; it
did not hang), but the wall-clock per cycle is dominated by redundant re-exploration.

> The "~34 min / ~7–8 min per cycle / run5" numbers are from a live observation, not a committed
> artifact. **Action item (V0 below): capture and commit that baseline** before claiming any win.

This plan targets the redundant re-exploration. It does **not** target the run's real failures
(a backend `500`, a fragile `toHaveURL` on a hash route) — those are app/spec issues, out of
scope (see §7).

---

## 2. Root cause

### What is genuinely already optimal (verified)
Re-exploration is **not** caused by missing grounding — the grounding pipeline is build-once and
re-injected:
- The **explorer runs once**; regeneration passes inherit the brief and do not re-run it
  ([pipeline.ts:1563](../src/pipeline.ts); the `isReGen` guard in `maybeExplore`,
  [opencode-client.ts:587](../src/integrations/opencode-client.ts)).
- The **Context Pack is built once**, not rebuilt on regeneration ([pipeline.ts:1440-1447](../src/pipeline.ts)),
  and `baseGenInput` forwards it to **every** generation call, including retries
  ([pipeline.ts:1476](../src/pipeline.ts)).
- When a brief is present the generator is already told *"the brief above distilled the blast
  radius — do NOT re-read that code"* ([prompts.ts:535](../src/integrations/prompts.ts)), and an
  `isReGen` flag already exists ([prompts.ts:939](../src/integrations/prompts.ts)).

So the distilled grounding is in the prompt on every retry. Two causes make the agent re-explore
anyway — and the dominant one is in the prompt text itself, not the agent.

### Cause B (proximate, most fixable) — the orchestrator's own prompts COMMAND re-navigation
This is the corrected, verified core. The orchestrator's regeneration prompts **actively instruct
the agent to navigate**, and on some paths do so unconditionally:

- **Reviewer-corrections / static-fix path:** the corrections block says *"re-verify it against the
  live DOM with the Playwright MCP before editing"* ([prompts.ts:656](../src/integrations/prompts.ts)).
  Both the reviewer-reject in-loop regen ([pipeline.ts:1417](../src/pipeline.ts), inside
  `reviewGenerated`) and the static-fix loop ([pipeline.ts:1791-1793](../src/pipeline.ts), which
  routes through `reviewCorrections`) hit this text.
- **First-write / no-pack path:** *"Playwright MCP is AVAILABLE and you MUST use it BEFORE writing
  any test: browser_navigate … browser_snapshot"* ([prompts.ts:498-499](../src/integrations/prompts.ts)).
- **Failure-retry path is CONDITIONAL, and inverts:** only when `failureSourced` is true does the
  prompt remove the browser steps and treat the injected tree as ground truth
  ([prompts.ts:603](../src/integrations/prompts.ts)). `failureSourced` is set only when
  `buildFailureDom(failed)` returns a non-empty string ([pipeline.ts:2018,2033](../src/pipeline.ts)),
  and `buildFailureDom` returns `undefined` when no failed case carried a captured a11y tree
  ([pipeline.ts:2353](../src/pipeline.ts)). When it is **false**, the prompt falls to the else branch
  that explicitly says *"Use browser_navigate + browser_snapshot to see the ACTUAL page structure"*
  ([prompts.ts:631-639](../src/integrations/prompts.ts)). A **backend-500 failure has no element to
  capture** → no failure DOM → `failureSourced` false → the fix-loop was *commanding* navigation.
  This is very likely what happened on the motivating run (its failures were a `500` + a URL
  assertion, neither of which yields a failure-point a11y tree).

> What already ships and limits RE-1's true delta: the **Context-Pack** case already says *"do NOT
> use browser_navigate or browser_snapshot on routes already covered in the pack"*
> ([prompts.ts:492-494](../src/integrations/prompts.ts)), and `AGENTS.md` already says *"TRANSCRIBE
> selectors from the pack … do NOT re-navigate those routes."* So RE-1's genuinely-new surface is:
> (a) unify the failure-retry heading so it triggers the same suppression, (b) **condition the
> navigate-commands at prompts.ts:656 and :498 on grounding-present**, and (c) add the directive to
> the coverage-enforce prompt. It is NOT a broad new rule.

### Cause A (contributing, architectural — a hypothesis, not a verified fact)
Every generation call opens a **fresh OpenCode session** and disposes it at the end: `open()` calls
`client.session.create(...)` ([opencode-client.ts:1484](../src/integrations/opencode-client.ts));
`runOpencode` disposes per call ([opencode-client.ts:767-768](../src/integrations/opencode-client.ts)).
The fix-loop, static-fix loop, coverage-enforce pass, and the **reviewer-reject in-loop regen** each
call `deps.generate` again ([pipeline.ts:2028](../src/pipeline.ts), [1791](../src/pipeline.ts),
[2175](../src/pipeline.ts), [1417](../src/pipeline.ts)), so **each cycle starts a brand-new agent with
zero working memory**.

The *structural* fact (fresh session per cycle) is verified. The *behavioral* claim — that a
stateless agent re-derives orientation even with the grounding in-prompt, out of "instinct" — is a
**hypothesis**. RE-2 telemetry, not this prose, decides whether Cause A is large enough to justify
the architectural fix (RE-3). If RE-1 removes the prompt's navigate-commands and the agent stops
re-exploring, Cause A was minor; if it keeps re-exploring despite no instruction to, Cause A is real.

### Cause C (measurement gap) — true, but the existing stream is the wrong tap
There is no per-cycle count of `browser_navigate` / `browser_snapshot` / serena calls. The orchestrator
*does* observe agent activity, but **the existing stream cannot distinguish these tools**:
`kindForTool` collapses every tool into a 4-value enum (`analyzing | writing | command | subagent`),
and `browser_navigate`, `browser_snapshot`, `find_referencing_symbols`, `activate_project` and ordinary
file reads **all** fall into the `analyzing` catch-all ([activity-mapper.ts:33-38](../src/integrations/activity-mapper.ts));
the other router (`agent-activity.ts`) only surfaces file/shell tools and drops the rest
([agent-activity.ts:44-45,72-100](../src/integrations/agent-activity.ts)); the contract event carries no
raw tool field. So Cause C is real but the first draft's "the activity router publishes all tools" was
**overstated** — the stream carries an activity *kind* + a display *title*, not the tool name.

### Already mitigated (shipped in `24a4038`)
The reviewer's corrective regeneration **inside the execution-retry loop** was removed: the fix-loop
validates+executes first and runs **one** independent review only after the fixed suite passes
([pipeline.ts:2123-2126](../src/pipeline.ts)). Note this did **not** touch the *initial-pass*
reviewer-reject loop ([pipeline.ts:1417](../src/pipeline.ts)), which still regenerates with fresh
sessions up to `MAX_REVIEW_ROUNDS` — RE-1 and RE-3 must both cover it.

---

## 3. Fix plan (sequenced cheap→safe first, architectural last)

### RE-1 — stop the prompts from commanding re-exploration when grounding is present (prompt-layer, low-risk) — DO FIRST
The genuinely-new surface (Cause B), keyed on *grounding present in the prompt*:

1. **`prompts.ts` (the proximate driver):**
   - At [:656](../src/integrations/prompts.ts) (reviewer-corrections) and the failure-retry **else**
     branch at [:631-639](../src/integrations/prompts.ts): when a `Context Pack → Live DOM` section or
     an injected DOM/`GROUND TRUTH` tree covers the relevant route, **replace** "re-verify against the
     live DOM with the Playwright MCP" / "Use browser_navigate" with "resolve against the injected tree;
     do NOT navigate." Keep the navigate instruction ONLY when no grounding covers the route.
   - Unify the failure-retry heading so the agent's Case-A suppression triggers on it too (the role doc
     keys "do not navigate" on `Context Pack → Live DOM`; the retry uses `GROUND TRUTH AT FAILURE`).
   - Add the same "grounding is authoritative; do not navigate covered routes" directive to the
     **coverage-enforce** prompt (which today carries no navigation guidance either way).
   - Extend the planner's already-shipped *"do NOT re-activate serena / do NOT re-run
     find_referencing_symbols"* wording ([prompts.ts:234,310](../src/integrations/prompts.ts), from
     `24a4038`) to the **generator regen** prompt, gated on the existing `isReGen` flag
     ([prompts.ts:939](../src/integrations/prompts.ts)) — do not re-skim/re-read on a regen turn.
2. **`agents/agent/qa-generator.md`:** subordinate step-2 Case B to injected grounding (don't navigate a
   covered route; Case-B exploration applies only to a route with NO grounding anywhere in the prompt).
3. **`agent/roles/qa-generator.md` (Codex) — a PORT, not a mirror (prerequisite):** this doc's step 2 is
   currently *"Explore the live page (Playwright MCP — MANDATORY) … You MUST explore the page before
   writing ANY test"* with **no Context-Pack / Case A/B structure at all**
   ([agent/roles/qa-generator.md:68-70](../agent/roles/qa-generator.md)). RE-1 must FIRST port the
   pack-aware Case A/B structure into it, THEN apply the suppression — otherwise the Codex runtime
   re-explores regardless and "both runtimes behave identically" stays false. Treat as a rewrite.

Risk: an instruction (LLM-compliance) change, not a hard guarantee — that is why RE-2 measures
compliance. Adds **no** LLM proxy and no quality logic; only removes redundant work. Fully reversible.

### RE-2 — per-cycle re-exploration telemetry (src/-layer, low-risk) — DO SECOND
**Corrected mechanism:** the existing kind-collapsed stream cannot see tool names, so RE-2 must add a
**raw tool-name counter at the SSE ingestion point — before `mapOpencodeEvent`/`kindForTool` collapse
it** — reading `part.tool` off the `message.part` events. Aggregate per generation cycle: counts of
`browser_navigate`, `browser_snapshot`, serena `activate_project` / `find_*`. Record on the run
telemetry; emit a `log()` warning when the agent navigates a route the Context Pack already covered.
Pure objective signal (the doctrine the repo follows) — no LLM proxy.

> **Boundary:** RE-2 is **observability only**. A high navigation count is an efficiency datum, not a
> quality defect — do **not** feed it into the learning ledger (that is a separate, separately-justified
> decision) or it would re-couple efficiency to the de-poisoned quality flywheel.

**Decision gate:** after RE-1+RE-2, re-run the petclinic baseline (§6). If the per-retry navigation
counts drop to ~0 and per-cycle time falls materially, **stop — RE-3 is not needed.** Only if the agent
still re-explores despite no instruction to do so (Cause A confirmed) do we invest in RE-3.

### RE-3 — generator session continuity across a run's cycles (architectural, higher-risk) — GATED on RE-2
Keep **one** generator session alive across a run's regeneration cycles instead of create→dispose per
call, so the agent retains its serena activation, file reads and prior reasoning and resumes instead of
re-orienting. This is deferred and must be DESIGNED before it is built, because the first draft
under-specified the landmines the code makes concrete:

- **Session-level deadline (the missing design).** Today the only wall-clock bound is **per-`prompt()`**
  (`withTimeout(prompt, agentTimeout(mode))`); there is **no** deadline covering the gap *between*
  prompts. A reused session stays open across `validate` + `execute` (Filters B/C run the Playwright
  suite against live DEV — **minutes**) with nothing bounding it. RE-3 MUST introduce an
  orchestrator-owned wall-clock deadline spanning create→final-dispose, distinct from the per-prompt one.
- **Handle lifetime + guaranteed dispose.** Today the session is created and disposed entirely inside one
  `runOpencode` call and `AgentResult` exposes no session id. RE-3 must put the handle in a
  `try/finally` (or `using`) scope spanning the whole retry loop in `runPipeline`, disposing on **every**
  exit path — terminal, ceiling, progress-gate stop, error, timeout, and abort. The abort wiring that
  deletes the session on cancel ([opencode-client.ts:1494-1498](../src/integrations/opencode-client.ts))
  must be reconciled with a reused handle.
- **Held-HTTP vs resumable-by-id.** Decide whether the session is *idle-but-open* (one held HTTP request
  — collides with the undici long-held-request gotcha across more turns) or *re-attached by id per turn*.
  These are very different undici/queue risk profiles; the plan must pick one.
- **Sequential-queue exposure.** A reused session extends the window in which one run pins the single-run
  queue; the session-level deadline above is what bounds it.
- **Coverage of all regen paths.** Continuity must also span the reviewer-reject loop at
  [pipeline.ts:1417](../src/pipeline.ts) (inside `reviewGenerated`, not the top-level call sites).
- **Codex.** `codex exec` continuation semantics differ; either match them or keep Codex on the
  fresh-session path (RE-3 becomes OpenCode-only) — decide explicitly.
- **Fallback:** any continuation error falls back to today's fresh-session path — no regression.

---

## 4. Why not the obvious alternatives
- **Re-inject more grounding on retries** — already done ([pipeline.ts:1476](../src/pipeline.ts)); the
  problem is the prompt then *tells the agent to navigate anyway*, not missing grounding.
- **An app-config "skip exploration" flag** — rejected: app-coupling violates *"nothing app-specific in
  `src/`"* and the rule never to fix on the app under test.
- **A second agent to police re-navigation** — rejected: the LLM-proxy pattern the repo warns against.
  RE-2 uses an objective tool-call signal instead.

---

## 5. Touch list

| Fragment | Files |
|---|---|
| RE-1 | `src/integrations/prompts.ts` (the navigate-commands at :498, :631-639, :656 + coverage prompt + generator `isReGen` wording), `agents/agent/qa-generator.md`, `agent/roles/qa-generator.md` (**port Case A/B first**), `agents/AGENTS.md` (align if needed) |
| RE-2 | `src/integrations/opencode-client.ts` (raw `part.tool` tap at the SSE ingestion point, before `mapOpencodeEvent`), run telemetry/persistence, tests |
| RE-3 (gated) | `src/integrations/opencode-client.ts`, `src/agent-runtime/` facades, `src/pipeline.ts` generate interface + session-scope, Codex path, tests |

---

## 6. Validation
- **V0 (prerequisite):** capture and commit the run5 baseline (cycle count + per-cycle wall-time, and the
  RE-2 counts once RE-2 lands) as a referenceable artifact — there is nothing to compare against today.
- **Per fragment:** `npm test` + `npm run typecheck` stay green; each fragment lands as its own
  gate-green commit.
- **Empirical (RE-1/RE-2):** because an LLM run varies run-to-run, do **not** rely on a single before/after
  number. Run **N≥3** per arm and compare the **distribution** of RE-2's per-cycle navigation/serena counts
  (target: ~0 re-navigation of grounded routes on retries). RE-2's aggregated counts — not one wall-clock
  figure — are the acceptance signal. Verdict parity must hold (efficiency must not change correctness).

---

## 7. Out of scope (real failures, not efficiency)
- The backend **`500`** (`Expected 201 Received 500`) — app behavior the engine correctly surfaces.
- The **`toHaveURL` fragility on hash routes** — a spec-robustness issue; track separately.
- **Parallel-diff workers are browserless** (they have no Playwright MCP and transcribe an
  orchestrator-injected per-objective tree — *"Do NOT attempt to navigate … you have no Playwright MCP"*,
  [prompts.ts:84](../src/integrations/prompts.ts)), so the first parallel pass is **not** a
  re-exploration vector; scope is the single-agent regen paths.

---

## 8. Open questions for review
1. Is RE-1 enough on its own (Cause B dominant), or is the fresh-session orientation cost (Cause A) large
   enough that RE-3 is required regardless? **RE-2 answers this empirically** — that is the decision gate.
2. For RE-2's raw tap: confirm the SSE `message.part` events expose `part.tool` with stable tool ids for
   the Playwright-MCP and serena tools (the kind-collapsed stream does not — that is the corrected design).
3. For RE-3, can `codex exec` continue a session at all, or must Codex stay on the fresh-session path
   (making RE-3 OpenCode-only)?
