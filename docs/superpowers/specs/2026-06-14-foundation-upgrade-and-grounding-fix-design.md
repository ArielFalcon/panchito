# Foundation upgrade + deterministic grounding fix — design

**Date:** 2026-06-14
**Status:** approved (design), pending spec review → implementation plan
**Author:** Panchito iteration loop

## 1. Problem

The dominant execution-failure class of the AI-generated E2E suite is **selector failures**:
`getByRole("columnheader")` returning 0 on a Bootstrap table, and strict-mode ambiguity on
test-created data that appears twice. Root cause, in one sentence:

> The agent authors selectors against a page it never observed, and when they fail the only
> feedback is an error *string* — never the real page. So it guesses again.

Two compounding walls:

1. **Blind fix-loop.** The execution failure-retry (`src/pipeline.ts` ~1417) feeds the agent
   `fixCases` carrying only `name` + `detail` (the error string). It passes **no DOM**. The agent
   repairs blind to the post-interaction / post-creation page where the selector actually failed.
2. **Agent ignores ground truth.** Even when given the rendered DOM, the agent has demonstrably
   ignored it (it approved a `columnheader` assertion when the provided tree showed none). This is a
   textbook **knowledge-conflict** (the model trusts its "tables have column headers" prior over the
   provided context) compounded by reviewer **sycophancy**.

Pre-write grounding (rendering a route's a11y tree before the agent writes) cannot reach the states
that dominate failures: pages reached via **interaction** (post-submit redirects) and **post-creation
data** (a namespaced record the test itself created, appearing twice → strict-mode ambiguity).

## 2. Goals / Non-goals

**Goals**
- Close the fix-loop with **real page truth at the point of failure** (the post-interaction /
  post-creation state, where pre-write grounding cannot see).
- Add a **deterministic, non-LLM gate** that catches when the agent ignored ground truth, *before*
  paying for a re-run.
- Ground the **first write** in interaction-reached routes, not just literal `page.goto()` targets.
- Do all of the above on a **modern, supported toolchain** (the current pin builds new infra on a
  Playwright API that no longer exists upstream).

**Non-goals (explicit)**
- Replacing the agent loop with the official Playwright Agents (they are a local dev tool — §1.7 mines
  their prompts, it never adopts them wholesale).
- The TypeScript 6 / ESLint 10 / c8 11 majors (separate backlog track — see "Deferred" at the end).
- Post-creation *data* ambiguity at *first write* (not pre-knowable; handled at failure time by
  Component A — §1.3, §1.6).
- 100% closing the compliance wall (Lever 2 is advisory/bounded; the executor stays the final oracle).

## 3. Decisions already made

| Fork | Decision | Why |
|---|---|---|
| Scope | Levers 1 + 2 + 3 (full root fix) | user choice |
| Capture mechanism | orchestrator-owned auto-fixture (in-process), dump to env-provided dir | maintainer-endorsed; reporters cannot access the live page |
| a11y API | `locator.ariaSnapshot()` (YAML), **not** `page.accessibility.snapshot()` | the latter was **removed in Playwright 1.57**; ariaSnapshot is the AI-tuned format used by Playwright MCP / Healer |
| Fix-loop budget | **2** grounded retries, gated by a deterministic **progress gate** (§1.5b); configurable | round-2 in-run reuses warm context (≪ a full cold re-run); the gate bounds waste on stuck/unfixable cases |
| Live MCP exploration | **the planner** (`qa-generator` plan phase) does it ×1, not the workers | ×N worker exploration is expensive + concurrent DEV pressure; planner is single-agent |
| Worker config | **Q2: No Playwright MCP + pro** (brute transcribers of the orchestrator-rendered tree) | user direction (dumb workers); prior lite failure (1/7) was Q3 (lite **with** the navigation burden) — not applicable once navigation is removed |
| Plan shape | Phase 0 (foundation) → Phase 1 (grounding), majors as separate backlog | Phase 0 enables Phase 1 |

### Agent roster (clarification — the "planner" is not a new agent)

One primary brain — **`qa-generator`** (pro) — wears phase hats: in a fan-out run it first **plans**
(`buildPlanPrompt` → objectives; the "planner"), in a small run it writes directly, and in all
re-generation it is the single-agent fixer. **`qa-worker`/`qa-worker-code`** (pro) are the brute parallel
writers (one spec each — the parallelism mechanism for scale, not extra intelligence). **`qa-reviewer`**
(minimax-m3) is the independent judge. Cheap helpers: **`qa-explorer`** (blast-radius brief),
**`qa-reflector`** (ledger rule), **`qa-assistant`** (TUI chat). **`qa-maintainer`** self-repairs *this*
repo only. Confirmed: the fan-out plan session opens `qa-generator` ([opencode-client.ts:1136](../../../src/integrations/opencode-client.ts)).

---

# Phase 0 — Foundation upgrade

Phase 1 builds on this; it lands first, with its own smoke, so an infra bump is never conflated with
logic changes (clean bisect if something breaks).

## 0.1 What changes

| Tool | From | To | Notes |
|---|---|---|---|
| Docker base (`Dockerfile:7`) | `playwright:v1.50.0-jammy` | `playwright:v1.60.0-noble` | browsers + runner lockstep; OS → Ubuntu 24.04 |
| `@playwright/test` (`config/e2e/package.json`) | `1.50.0` | `1.60.0` | exact, must equal the image tag |
| Node (orchestrator) | 20 (inherited) | **24 LTS** (explicit layer) | the PW 1.60 image *still ships Node 20* — must add an explicit Node 24 layer |
| Go (orchestrator, `Dockerfile:17`) | apt `golang` ≈ 1.18 | **1.26.x upstream tarball** | apt (even on noble = 1.22) is too old; pin the official tarball |
| `better-sqlite3` (`package.json`) | `12.10.0` | `12.10.1` | native; **spike-confirmed** Node 24 (ABI v137) linux-x64 prebuilt exists (12.11.0 does **not** exist on npm — audit error); Node-20 prebuild dropped → another reason for Node 24 |
| `@opencode-ai/sdk` (`package.json`) | `1.15.13` | `1.17.7` | our runtime boundary; re-test against `opencode serve` |
| agents container Node (`agents/Dockerfile:3`) | `node:22-bookworm` | `node:24-bookworm` | align with orchestrator |

Already current — no action: `zod`, `undici` (8.4.1 via `^`, **but needs Node ≥22.19** → another reason
Node 24 is forced), `tsx`, Serena `v1.5.3`, `@stryker-mutator/core`, `typescript-eslint`,
`openapi-typescript`, `@playwright/mcp` (floats, fast-moving 0.0.x — independent of `@playwright/test`).

## 0.2 The cascade (sequenced)

Bumping the base image is **not** one line. Order of operations:

1. **Base image → `v1.60.0-noble`.** Audit *every* `apt-get install` line against noble (24.04):
   package names/versions shift vs jammy (e.g. noble ships Python 3.12 vs jammy 3.10 — verify Serena's
   `--python 3.11` pin still resolves; check `golang`/`maven`/`gradle`/`-dev` package names).
2. **Explicit Node 24 layer** in the orchestrator Dockerfile (the image's Node 20 is below the
   floors of `undici@8.4.1` and `better-sqlite3`'s prebuilds).
3. **Go via upstream tarball** (`https://go.dev/dl/go1.26.x.linux-amd64.tar.gz`), replacing
   `apt-get install golang`.
4. **`@playwright/test` → 1.60.0** in the seed (lockstep with the image).
5. **`better-sqlite3` → 12.10.1** (latest; 12.11.0 does not exist), **`@opencode-ai/sdk` → 1.17.7**.

## 0.3 Risks & mitigations

- **Version skew runner↔browsers** → keep `@playwright/test` *exactly* equal to the image tag; never
  loosen to `^`. (Existing invariant.)
- **jammy→noble apt drift** → audit each install line; the baked code-mode runtimes
  (Java/Python/Go/Rust/Maven/Gradle) are the most likely to rename or change default version.
- **better-sqlite3 ABI** → spike-confirmed: `12.10.1` ships a Node 24 (ABI v137) **linux-x64 prebuilt**
  → no source compile in the image; resolved by step 2. (Node 20 has no prebuild — staying on 20 would
  compile from source.)
- **opencode SDK behavior** (1.15→1.17) → re-run the opencode-client integration tests against a live
  `opencode serve` before merging.

## 0.4 Verification (the gate for Phase 0)

- `npm test` + `npm run typecheck` green.
- Docker image builds; `node --version` inside the orchestrator image == 24.x; `go version` == 1.26.x;
  Playwright reports 1.60.0.
- A full smoke run against PetClinic (shadow mode) reaches execution and produces a JSON report — i.e.
  the runner↔browser pairing works on the new image.

Phase 0 is **done** only when that smoke is green. Phase 1 starts on the upgraded base.

---

# Phase 1 — Deterministic grounding fix

## 1.1 Architecture — the three levers

```
            ┌─ Lever 3: PRE-WRITE grounding ──────────────┐
            │  PLANNER (qa-generator) explores live via MCP│  ← fewer first-write failures
            │  ×1, declares interaction-reached routes;    │
            ▼  orchestrator renders them via ariaSnapshot  │
   brute WORKERS (Q2: no MCP) transcribe the rendered tree ┘   (workers never drive the
            │                                                   browser → no ×N cost, no
            │                                                   concurrent DEV access)
   spec FAILS in execution
            │
            ▼
   ┌─ Lever 1: CAPTURE-ON-FAILURE ───────────────────────────────────┐
   │  in-process afterEach dumps the REAL a11y tree at the failure    │  ← the post-interaction /
   │  point (ariaSnapshot YAML) → executor reads → QaCase.failureDom  │     post-creation page
   │  (+ for expect() failures, harvest TestInfoError.errorContext)   │     pre-write can't see
   └─────────────────────────────────────────────────────────────────┘
            │
            ▼
   fix-loop regenerates with failureDom as AUTHORITATIVE ground truth
   (source-framing + counterfactual + quote-then-assert prompting)
            │
            ▼
   ┌─ Lever 2: DETERMINISTIC PRE-CHECK ──────────────────────────────┐
   │  parse proposed selectors; does each role:name exist UNIQUELY    │  ← closes the
   │  in the captured tree? absent → UNVERIFIABLE → next round (§1.5b) │     compliance wall
   │  reject assertion-weakening                                       │
   └─────────────────────────────────────────────────────────────────┘
            │
            ▼
   re-execute (executor is the final oracle; change-coverage is the held-out value signal)
```

## 1.2 Shared core — `parseAriaSnapshot` (replaces `flattenAccessibilityTree`)

Both grounding paths (orchestrator render + failure capture) move to `locator('body').ariaSnapshot()`
(YAML). A new pure function **`parseAriaSnapshot(yaml) → {role, name}[]`** flattens the YAML tree to the
same `role: name` records `flattenAccessibilityTree` produced, preserving the table/list priority logic
in `formatDomSnapshot`. This unification is **required**: Lever 2's check must run against the exact
representation the agent was shown.

- `src/qa/dom-snapshot.ts`: `defaultCaptureDomDeps.render` calls `ariaSnapshot()` instead of
  `page.accessibility.snapshot()`; `parseAriaSnapshot` replaces `flattenAccessibilityTree`.
- Keep `formatDomSnapshot`'s compaction (priority roles kept past `MAX_NODES_PER_ROUTE`).

**Verified grammar (spike — `ariaSnapshot()` on Playwright 1.60.0, the pinned version):**

```yaml
- heading "Owners" [level=1]
- navigation "Main":
  - link "HOME":
    - /url: /
- table:
  - rowgroup:
    - row "Name Address":
      - columnheader "Name"
      - columnheader "Address"
- text: layout cell only            # ← a role="presentation" table collapses to TEXT — NO columnheader
- list "Features":
  - listitem: Item one
- textbox "Owner name": qa-bot-Dog   # quoted = accessible name; the post-colon token is the VALUE
- checkbox "Subscribe" [checked]
- combobox "Pet type":
  - option "Cat" [selected]
- button "Cancel" [disabled]
```

`parseAriaSnapshot` line grammar: `<indent>- <role>[ "<name>"][ [attr…]][: <inline value | text>]`.
Rules: (a) **role** = first token; (b) **name** = the double-quoted string when present (the accessible
name to match against); (c) a **trailing `:` with nothing after it** introduces indented children; a
`: <value>` with content on the same line is the node's VALUE/text (NOT a child) — for nameless content
roles (`text`, `listitem`) that inline value *is* the name; (d) `[attr=value]` / `[flag]` brackets carry
state (`level`/`checked`/`disabled`/`selected`); (e) `/url:`-style lines are directives → skip.
**Spike validation:** the `role="presentation"` table emitted `text:` with **no `columnheader`** — the
exact Bootstrap failure this design targets, now visible in the snapshot the agent is shown.

## 1.3 Component A — failure-time capture

- **`config/e2e/fixtures.ts`** (seed): a *system-owned* `test.afterEach` that, when
  `testInfo.status !== testInfo.expectedStatus`, captures `await page.locator('body').ariaSnapshot()`
  (wrapped in try/catch — the page may be closed on a nav-crash) and writes the YAML to
  `$QA_FAILURE_CAPTURE_DIR/<sanitized-title>__<retry>.json`. **Dumb by design**: capture + write only;
  the orchestrator owns parsing/flattening. Key by `testInfo.retry` so retries don't clobber. Degrades
  to no-op if the env var is unset.
- **`src/qa/setup.ts`**: `ensureFailureCapture(e2eDir)` in `SetupDeps` — idempotent, marker-guarded,
  **append-only** injection of the afterEach block into existing repos' `fixtures.ts` (the exact pattern
  `ensureSpecDir` established). New onboards get it from the seed. Never clobbers agent edits.
- **`src/qa/execute.ts`**: pass `QA_FAILURE_CAPTURE_DIR` (fresh temp dir) into `runSuite` env. After the
  run, for each **failed** case, read the matching dump, run `parseAriaSnapshot` + `formatDomSnapshot`,
  attach to `QaCase.failureDom`. **Also** (on the 1.60 base) harvest `result.errors[].errorContext`
  (Playwright auto-captures the receiver's aria snapshot on `expect()` failures — free, covers the most
  common case; the fixture covers the rest, e.g. click/navigation timeouts). Surface a loud WARNING if a
  failed case yields no capture (never swallow a grounding gap — existing invariant).
- **`src/types.ts`**: `QaCase.failureDom?: string`.

## 1.4 Component B — thread into the fix-loop

- **`src/pipeline.ts`** (~1417): build `domSnapshot` from the failed cases' `failureDom` and pass it via
  `baseGenInput({ fixCases: failed, domSnapshot })`. Today it passes none. Now the fix-loop regenerates
  with the real page at the failure point.
- **`src/integrations/prompts.ts`**: a new "GROUND TRUTH AT FAILURE" block, evidence-framed (§1.7),
  distinct from pre-write grounding because it is *authoritative* — this is exactly where the selector
  broke.

## 1.5 Component C — Lever 2 deterministic pre-check

- **New `src/qa/selector-check.ts`** (pure):
  - `extractProposedSelectors(specSrc) → {role, name?, exact?, route?}[]` — regex over
    `getByRole/getByText/getByLabel` (+ `{exact:true}`, regex names).
  - `selectorPresent(sel, tree, opts)` — implements the **accname matching rule exactly**:
    ```
    normalize(s): replace [\r\n\t\f]+ and whitespace runs with one space; trim.
    role match: case-insensitive exact token.
    name '' / undefined: role-only → match any node of that role.
    default: lowercase(normalize(actual)).includes(lowercase(normalize(expected)))   // substring, ci
    exact:true: normalize(actual) === normalize(expected)                            // whole-string, cs (still trimmed)
    regex name: test the regex against normalize(actual) (no lowercase/substring).
    ```
  - `selectorUnique(sel, tree)` — exactly one match (proactively catches strict-mode ambiguity).
- **`src/pipeline.ts`**: after the fix-loop regenerates, **before** re-execute, check selectors on the
  captured route against the failure tree:
  - role:name **present and unique** → proceed.
  - **absent** → treat as **UNVERIFIABLE, not invalid** (the snapshot prunes hidden/"uninteresting"
    nodes differently than `getByRole`); **skip the wasted re-execution** and fold an explicit
    "this role:name does not exist in the captured page; present roles: …" contradiction into the next
    regeneration (which counts against the fix-loop budget §1.5b). Never a hard block.
  - **non-unique** → flag the ambiguity for the regenerated round (push toward `.filter({hasText})`
    scoped by the test's unique namespace value, not `.first()`).
  - reject regenerations that **delete/weaken assertions** to force green (patch-overfitting guard).
- The executor remains the final oracle. Lever 2's verdict is one input to the progress gate (§1.5b).

## 1.5b The fix-loop budget & progress gate (the economically load-bearing part)

The execution fix-loop runs **up to 2 grounded retries** (config `qa.fixLoop.maxRetries`, default 2). A
2nd in-run retry reuses warm context (working copy, context map, the captured failure DOM) — far cheaper
than letting the run fail → Issue → a full **cold** re-run on the next deploy. But a 2nd round is pure
waste on a stuck/unfixable case, so retry N+1 fires **only when there is deterministic evidence that
retry N made progress**. This gate is the weakest link if done naively — so it is built on **robust,
deterministic signals and never on fragile raw-DOM equality** (the failure DOM is for *grounding the fix*,
not for *measuring progress*).

**Spend the next retry iff at least one holds (all deterministic):**
- **(A) Failing count decreased** vs the previous round (some tests went green — robust aggregate).
- **(B) The set of failing test names changed** (the fix resolved one failure and surfaced another —
  compares test identities, not DOM).
- **(C) Lever 2 flipped a selector absent→present** (the agent corrected a missing selector; progress on
  the grounded dimension even if execution still fails for another reason — a deterministic check).

**Stop → Issue/quarantine when NONE hold** (same failing count, same failing set, and the *identical*
selectors still absent — the agent ignored ground truth again): the loop is stuck; spend no further pro
generation. **Fail-closed.** A Lever-2 short-circuit (absent → regenerate without re-executing) counts
against the same budget — so "absent → regenerate" cannot loop more than the cap.

**Guardrails:**
- **Hard cap = 2** (no unbounded loop) regardless of the gate.
- **Regression guard:** if the failing count *increased*, keep the **best** round's result (fewest
  failures); never ship a regression.
- **Real-bug detection (Healer-style):** if Lever 2 says the proposed selectors resolve **uniquely**
  (not a selector problem) AND the failure is an assertion **value mismatch** (not a locator error or
  timeout) → likely a real app bug → stop and file an Issue rather than burning a round "fixing" a real
  defect. A *timeout* with resolving selectors may be timing → a round is allowed to add a wait.

Robust because the decision combines three deterministic signals (aggregate count + test-name set +
Lever-2 verdict), none depends on raw-DOM diffing, and it fails closed — so the worst case is **one**
wasted pro generation, only when evidence of progress existed.

## 1.6 Component D — Lever 3 pre-write interaction-route grounding (+ Q2 workers)

The grounding split: **the planner explores live ×1; the workers are brute transcribers of a
deterministically-rendered tree.**

- **Planner (`qa-generator` plan phase, already has the Playwright MCP):** during planning it uses the
  MCP to navigate interaction flows and **discover + verify post-interaction landing routes** (e.g.
  owner-register lands on `/#!/owners/{id}`), declaring them in each objective's `brief.routes[]`
  alongside the existing `page.goto` routes. Single-agent, so no concurrency.
  - `src/integrations/opencode-client.ts` (`buildPlanPrompt`): extend the prompt to declare
    interaction-reached routes; the example JSON already carries `routes[]`.
- **Orchestrator renders the declared routes deterministically** via `captureDomForRoutes` (migrated to
  `ariaSnapshot`/`parseAriaSnapshot`) and injects the tree into each worker. Degrades safely: a route
  that renders empty is logged, never blocks.
- **Workers — Q2 (No Playwright MCP + pro):** `agents/opencode.json` `qa-worker` drops the `playwright`
  MCP (keeps `serena`). The worker no longer navigates; it transcribes the injected real tree into a
  spec. This is the "dumb worker" direction: less judgment, no ×N live exploration, no concurrent DEV
  access. The prior lite failure (1/7) was **Q3** (lite *with* the navigation burden) — not evidence
  against a no-MCP worker.
- **Honest limit:** covers interaction-reached *routes*, not post-creation *data* (the duplicated record
  doesn't exist until the test creates it). That ambiguity is handled by Component A (failure capture
  surfaces the duplicate) + `formatDomSnapshot`'s existing duplicate-surfacing.
- **Deferred experiment (Q4):** once Lever 1/2/3 are in and the worker's job is proven simple, measure a
  **lite** worker (no MCP + flash) gated on the static-gate/Lever-2 first-pass rate. Adopt only if quality
  holds (the repair loops are pro — a lite worker that triggers many repairs is a false economy). Not in
  this spec's core.

## 1.7 Prompting (evidence-backed) — the fix for the columnheader incident

The "GROUND TRUTH AT FAILURE" block (and the worker grounding block) adopt techniques with empirical
support (Context-Faithful Prompting, EMNLP 2023; Lost in the Middle, TACL 2024):

1. **Deterministic check first** (Lever 2) — not a prompt; the strongest lever.
2. **Source-framing**: "the tree below is the ONLY source of truth; do not use general knowledge about
   what tables/forms usually contain."
3. **Counterfactual framing**: "tables commonly expose `columnheader`, but THIS tree does not — trust
   the tree, not the convention." (Directly neutralizes the knowledge-conflict that caused the incident.)
4. **Placement**: ground truth at the **top or bottom** of the prompt, never buried mid-context.
5. **Minimize + delimit**: short tree, fenced; strip distractors (context-rot mitigation).
6. **Quote-then-assert**: the agent must cite the exact `role: name` line each locator relies on; an
   unquotable locator is rejected.

We also **mine the official Playwright Healer/Generator agent definitions** (`npx playwright init-agents
--loop=opencode`) for their grounding + repair discipline and fold the structure into our `qa-generator`
and fix-pass prompts (re-mined on each Playwright upgrade). We do **not** adopt their control flow (they
write files directly, violating our read-only-agent invariant).

## 1.8 Connection to the value keystone

Executor-green is a **weak** oracle (a red→green repair can pass by retargeting to a wrong-but-present
element or weakening an assertion — patch-overfitting literature; VON Similo LLM's 10 new regressions).
The held-out signal that keeps repair honest is **change-coverage** (`src/qa/change-coverage.ts`) — the
existing keystone. The new work plugs into it; it does not bypass it.

## 1.9 Data flow

```
spec fails → afterEach dumps ariaSnapshot YAML to $QA_FAILURE_CAPTURE_DIR
          → executor parseAriaSnapshot + (errorContext for expect-fails) → QaCase.failureDom
          → fix-loop passes failureDom as authoritative domSnapshot
          → agent regenerates (source-framed, counterfactual, quote-then-assert)
          → Lever 2 checks proposed selectors present+unique vs the same tree
          → re-execute → change-coverage as held-out value signal
```

## 1.10 Error handling

Every new step is best-effort / degradation-safe (consistent with existing grounding): no capture dir /
no dump / parse failure / page closed → falls back to today's blind fix, with a **loud WARNING** (never a
silent swallow). Bounded budgets everywhere: the fix-loop runs ≤2 grounded retries gated by the progress
gate (§1.5b, fail-closed); the planner's live MCP exploration is bounded by its plan-phase step budget.

## 1.11 Testing strategy (DI-consistent)

Pure cores are unit-tested; real integration boundaries stay deliberately uncovered (the repo's DI
strategy):
- `selector-check.ts`: accname normalization, substring/exact/regex, role-only, uniqueness.
- **progress gate**: the 3-signal decision (count↓ / failing-set changed / Lever-2 flip), fail-closed,
  regression guard, real-bug-vs-timeout branch — pure given two rounds' results.
- `parseAriaSnapshot`: YAML → records, table/list priority preserved.
- `ensureFailureCapture`: idempotency, marker-guard, append-only (never modifies existing lines).
- executor capture-dir read/match (the parse, not the spawn).
- prompt blocks (the new framing is present and placed at the edge).
- Uncovered boundaries: the afterEach in a real browser, the executor env threading, the MCP calls.

## 1.12 Risks & known limits (honest)

1. The compliance wall is **not** 100% closed — Lever 2 is advisory/bounded; a wrong-but-*present*
   selector can still pass. Mitigated by uniqueness + intent-consistency + change-coverage; the executor
   is the final oracle.
2. The **first** run still fails before failure-capture can help (inherent — capture is post-failure).
   The win is convergence in **1 grounded round** instead of N blind ones.
3. Lever 3 does not cover post-creation *data* (inherent — Component A covers it at failure time).
4. Snapshot pruning differs from `getByRole`'s tree → "absent" is *unverifiable*, never a hard block
   (designed in; required for soundness).

## 1.13 Success metric (measurable vs the saved baseline)

- Regeneration rounds per run ↓ (baseline: 2 review rounds + a blind retry).
- Tests that **PASS** ↑ (not tests *written*).
- `grounding: captured` appears on failed cases; the fix-loop closes in a single grounded round when
  the failure was a selector/ambiguity issue.

---

# Deferred — separate backlog tracks (not in this spec)

- **Majors**: TypeScript 5.6→6.0, ESLint 9→10, c8 10→11 (c8 on the change-coverage path — validate
  output before bumping). Each its own focused PR; `npm test`/`typecheck` are the gate.
- **Phase-2 grounding hardening** (after the core lands and we've measured): stable ref-IDs as the
  grounding primitive end-to-end (MCP `e5` / Stagehand `[7]`), viewport filtering (Playwright issue
  #39955 — off-screen nodes mislead the agent; our flatten has the same bug), objective-aware trimming
  over the blunt `MAX_NODES_PER_ROUTE` cap, table→JSON extraction (~93% size cut).

# Evidence base (load-bearing citations)

- **Playwright API**: `page.accessibility.snapshot()` removed in **v1.57**; `locator.ariaSnapshot()`
  since v1.49; `TestInfoError.errorContext` v1.60; verified against Playwright source v1.55 + release
  notes. `getByRole` name = case-insensitive substring default / `{exact:true}` whole-string, both
  whitespace-collapsed+trimmed.
- **accname / ARIA-in-HTML (W3C)**: accessible-name precedence + whitespace flat-string; `<th>` →
  `columnheader` *only if* the ancestor table is exposed as `role=table` (Bootstrap `role=presentation`
  breaks it — our failures are spec-correct).
- **Deterministic gate > LLM review**: Huang et al. (DeepMind, ICLR 2024) — LLMs can't self-correct
  without external feedback; Sharma et al. (Anthropic 2023) — sycophancy; FlakyDoctor (ISSTA 2024) —
  "LLMs alone not good enough," deterministic components carry 12–31%.
- **Failure-grounded repair converges**: Semter (ESEC/FSE 2023) 84% via real execution state;
  FeedbackEval — gains driven by executable feedback; VON Similo LLM (STVR 2024) — LLM-on-deterministic
  cut failures 70→40 but added 10 new regressions (→ the pre-check's purpose).
- **Knowledge-conflict / context-faithfulness**: Xu et al. (EMNLP 2024); Zhou et al. Context-Faithful
  Prompting (EMNLP 2023); Liu et al. Lost in the Middle (TACL 2024).
- **Bounded rounds**: SELF-REFINE (NeurIPS 2023), FeedbackEval, debugging-decay (Nature Sci. Rep. 2025)
  — gains plateau by round 2–3.
- **Playwright Agents** (Planner/Generator/Healer, v1.56, Oct 2025) + Playwright MCP `browser_snapshot`
  (a11y tree + stable refs) — official prior art to mine, not adopt wholesale.
