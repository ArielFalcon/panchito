# Technical Design — foundation-upgrade-and-grounding-fix

Status: design (HOW). Companion to the approved design doc
`2026-06-14-foundation-upgrade-and-grounding-fix-design.md` and the spec phase. This document is the
implementation-ready architecture: concrete algorithms, signatures, file:line touch points, and the
DI/test plan, following the repo's `*Deps`/`default*Deps` pattern, pure-core unit testing, colocated
`*.test.ts`, English, comments-describe-final-state.

Anchors verified against source (spike-corrected via engram #557/#559): `better-sqlite3 → 12.10.1`
(12.11.0 does not exist), Node 24 = ABI v137 (linux-x64 prebuilt confirmed), `ariaSnapshot()` on
Playwright 1.60.0 grammar verified.

---

## 1. `parseAriaSnapshot(yaml) → {role, name}[]` (replaces `flattenAccessibilityTree`)

**File:** `src/qa/dom-snapshot.ts`. New exported pure function; `flattenAccessibilityTree`
(`dom-snapshot.ts:147`) is removed once its sole production caller (`:229`) migrates.

### 1.1 Grammar (spike-verified, engram #559)

Line shape: `<indent>- <role>[ "<name>"][ [attr…]][: <inline value | text>]`, 2-space-indent nesting.

### 1.2 Algorithm (line-based, NOT a YAML lib)

A real YAML parser is rejected (see Decision D1). Parse line by line:

```
parseAriaSnapshot(yaml: string): { role: string; name?: string }[]
  for each raw line:
    skip blank lines and any line whose trimmed content starts with "/" (the `/url:` family — directives)
    require the trimmed line to start with "- "; else skip (defensive: stray YAML scalars)
    body = trimmed.slice(2)
    role = body up to the first space / `"` / `[` / `:`   (first token)
    if role not in KEEP set → skip   (same keep-set as today, §1.3)
    name:
      if a double-quoted segment follows the role → name = unescape(that quoted string)   // accessible name
      else if a same-line `: <value>` exists AND role ∈ CONTENT_ROLES (text, listitem)
            → name = the post-colon value trimmed                                          // content IS the name
      else if role ∈ STRUCTURAL (table, grid, list, row) → name = "(present)"              // bare marker
      else → name = undefined
    push { role, name }
```

Key rule (from the spike): a **bare trailing `:`** introduces indented children → NOT a value. A
`: <text>` with content on the same line is the node VALUE; only for the nameless content roles
(`text`, `listitem`) is that value adopted as the name (matches what the author must select on).
`[level=…]/[checked]/[disabled]/[selected]` brackets are state — captured-but-ignored for the
`{role,name}` record (kept only so the regex correctly delimits the name).

### 1.3 Role keep-set (unchanged from `flattenAccessibilityTree:156-159`)

`link, button, heading, textbox, combobox, checkbox, radio, tab, menuitem, option, columnheader,
rowheader, cell, gridcell, listitem, row, table, grid, list`. `structural = {table, grid, list, row}`
emits `(present)` when nameless. **Output identity is the contract**: each record renders to the same
`"<role>: <name>"` string `flattenAccessibilityTree` produced, so `formatDomSnapshot` is unchanged.

### 1.4 `formatDomSnapshot` compatibility (`dom-snapshot.ts:78`)

No signature change. It consumes `RouteSnapshot.nodes?: string[]`. The only adapter needed: the parent
maps `parseAriaSnapshot(yaml)` records to `"<role>: <name>"` lines before building `RouteSnapshot`
(the same lines `flattenAccessibilityTree` returned). `PRIORITY_ROLES`/`isPriorityNode` (`:74-75`) and
the `MAX_NODES_PER_ROUTE` compaction (`:87-99`) keep working byte-for-byte.

### 1.5 `capture.cjs` child-script change (`dom-snapshot.ts:193-211`)

- Line 206 `out.push({ route, snap: await page.accessibility.snapshot() })`
  → `out.push({ route, yaml: await page.locator('body').ariaSnapshot() })`.
- The script still `require`s the e2e project's Playwright (the `require(playwright)` line is unchanged;
  `chromium` is still used). The untrusted-input-via-env pattern (`PW_CAPTURE_INPUT`, `:196`) is unchanged.
- Parent close-handler (`:228-229`): `raw` items become `{ route; yaml?; error? }`; the non-error branch
  is `{ route: r.route, nodes: linesFrom(parseAriaSnapshot(r.yaml)) }`. The JSON-tree walk is gone.

---

## 2. Failure-capture path (Lever 1)

### 2.1 Seed fixture `test.afterEach` — `config/e2e/fixtures.ts`

Appended after `export { expect }` (`fixtures.ts:187`), marker-delimited (see §3). System-owned,
"do not edit" — same convention as `_coverage`/`_faultInject` (`:104-184`). Dumb by design: capture +
write only; the orchestrator owns parse/flatten.

```ts
// >>> qa-failure-capture (system-owned: do not edit) >>>
test.afterEach(async ({ page }, testInfo) => {
  const dir = process.env.QA_FAILURE_CAPTURE_DIR;
  if (!dir) return;                                  // degrade to no-op when the orchestrator didn't ask
  if (testInfo.status === testInfo.expectedStatus) return;  // only on unexpected status (a real failure)
  try {
    const yaml = await page.locator("body").ariaSnapshot();   // the REAL post-failure page
    const safe = testInfo.titlePath.join("-").replace(/[^a-z0-9]+/gi, "-").slice(0, 80);
    require("node:fs").writeFileSync(
      require("node:path").join(dir, `${safe}__${testInfo.retry}.json`),  // key by retry → no clobber
      JSON.stringify({ title: testInfo.titlePath, yaml }),
    );
  } catch { /* page may be closed on a nav-crash — best-effort, never fail the run */ }
});
// <<< qa-failure-capture <<<
```

Filename sanitizer mirrors the existing `_coverage` slug (`fixtures.ts:130`) so executor-side matching
is symmetric.

### 2.2 Executor wiring — `src/qa/execute.ts`

- **Env injection.** `ExecuteDeps.runSuite` arg type (`execute.ts:126-135`) gains `failureCaptureDir?: string`.
  `defaultExecuteDeps.runSuite` (`:365`) mints a fresh `mkdtempSync(join(tmpdir(), "qa-fail-"))` and adds
  `QA_FAILURE_CAPTURE_DIR: failureCaptureDir` to the spawn env (`:377`, additive to the existing block).
  `runE2E` (`:185`) plumbs the dir into the `runSuite` call.
- **Post-run harvest.** In `runE2E` (`:245`, right after `parsePlaywrightReport`), for each case with
  `status === "fail"`: compute the same slug from `case.name`, read `<dir>/<slug>__*.json` (lowest retry
  preferred), `parseAriaSnapshot` + `formatDomSnapshot`, set `case.failureDom`. A new pure helper
  `matchFailureDumps(caseName, files) → filename | null` (slug match) is unit-tested; the FS read is the
  uncovered boundary.
- **`errorContext` harvest (1.60).** Surface `result.errors[].errorContext` from the JSON report (§2.3)
  alongside `detail`; when present and no fixture dump exists, `failureDom` falls back to it. (Playwright
  auto-captures the receiver's aria snapshot on `expect()` failures — covers the most common case for
  free; the fixture covers click/navigation timeouts where no `errorContext` is emitted.)
- **Loud gap.** If a failed case yields neither a dump nor an `errorContext`, `console.warn` a WARNING
  (never swallow a grounding gap — existing invariant, mirrors `dom-snapshot.ts:117`).

### 2.3 Report schema — `src/qa/playwright-report.ts`

`PwResult` (`:26-29`) gains `errors?: Array<{ message?: string; errorContext?: string }>` (1.60 adds the
`errors[]` array + `errorContext` per `TestResultError`). `PwCase` (`:10-14`) gains `errorContext?: string`.
A new `firstErrorContext(spec)` mirrors `firstError` (`:137`). `parsePlaywrightReport` sets
`case.errorContext` when present. Backward-compatible: `errors?` absent on pre-1.60 reports → `undefined`.

### 2.4 Type — `src/types.ts`

`QaCase` (`:74-82`) gains `failureDom?: string`. Purely additive. `PwCase[]` already assigns to
`QaCase[]` structurally (`runE2E` returns `parsed.cases` directly), so the harvest writes onto those
same objects before returning.

---

## 3. `ensureFailureCapture` — `src/qa/setup.ts`

Exact `ensureSpecDir` pattern (`setup.ts:33` interface member, `:104` default impl, `:44` call site).

- **Interface.** `SetupDeps` (`:26-34`) gains `ensureFailureCapture?(e2eDir: string): void` (optional → test
  stubs omit it; `defaultSetupDeps` always provides it). Called in `setupE2eProject` (`:44`, right after
  `ensureSpecDir`), so it runs every setup including the install-cached early return (`:45-48`).
- **`defaultSetupDeps.ensureFailureCapture` (`:102`).** Idempotent, marker-guarded, **append-only**:
  ```
  path = join(e2eDir, "fixtures.ts")
  if !existsSync(path) → return                       // a fresh onboard gets it from the seed copy already
  src = readFileSync(path)
  if src.includes(">>> qa-failure-capture") → return  // already present (seed OR prior injection)
  appendFileSync(path, "\n" + AFTER_EACH_BLOCK)       // never rewrites existing lines (no agent edits clobbered)
  ```
- **Two paths, both covered:** new onboards get the block from the seed `bootstrap` copy
  (`config/e2e/fixtures.ts` → repo); existing repos that predate this change get it injected into the
  **watched repo's** `e2e/fixtures.ts` (NOT the seed). The marker is the single idempotency key for both.
- **Test:** running it twice over a buffer appends exactly once; an existing buffer with the marker is
  untouched; a buffer with agent-added lines keeps them (append-only proven). Pure over an injected
  read/write pair.

---

## 4. `selector-check.ts` — Lever 2 (new pure module)

**File:** `src/qa/selector-check.ts`. No pipeline deps; fully standalone-testable.

### 4.1 `extractProposedSelectors(specSrc) → ProposedSelector[]`

`ProposedSelector = { kind: "role"|"text"|"label"; role?: string; name?: string; exact?: boolean; regex?: boolean }`.
Regex over the spec source (same line-by-line, skip-comment discipline as `extractTargetRoutes`,
`dom-snapshot.ts:52-54`):

- `getByRole("<role>"[, { name: <name>, exact: <bool> }])` → role + optional name. `<name>` is a quoted
  string (literal) or a `/…/flags` regex (set `regex: true`, keep the source pattern).
- `getByText(<name>[, { exact }])` → `kind:"text"`, role implicitly `text`/any.
- `getByLabel(<name>[, { exact }])` → `kind:"label"` (matched against `textbox`/`combobox`/`checkbox` names).
- `{ exact: true }` → `exact`.

### 4.2 `selectorPresent(sel, tree, opts) → boolean`

`tree` = the parsed `{role,name}[]` (the SAME representation the agent was shown — required for soundness).
Accname rule (verbatim from the design §1.5):

```
normalize(s): replace [\r\n\t\f]+ and whitespace runs with one space; trim
role match: case-insensitive exact token (text/label kinds match a role family, not a literal token)
name '' / undefined: role-only → any node of that role matches
default:    lowercase(normalize(actual)).includes(lowercase(normalize(expected)))   // ci substring
exact:true: normalize(actual) === normalize(expected)                                // whole-string, still trimmed
regex name: regex.test(normalize(actual))                                            // no lowercase, no substring
```

### 4.3 `selectorUnique(sel, tree) → boolean`

Exactly one node satisfies §4.2 — proactively catches strict-mode ambiguity (the post-creation
duplicate the snapshot surfaces).

### 4.4 Pipeline verdict (consumed by §5, not a hard block)

For each proposed selector on the captured failure route: **present+unique** → ok; **absent** →
UNVERIFIABLE (snapshot prunes differently than `getByRole`; never `invalid`) → fold
"this role:name does not exist; present roles: …" into the next regeneration AND skip the wasted
re-execute; **non-unique** → flag ambiguity (push `.filter({hasText: <namespace>})`, not `.first()`).
Reject regenerations that delete/weaken assertions (patch-overfitting guard — diff the assertion count).

---

## 5. Fix-loop + progress gate — `src/pipeline.ts`

### 5.1 Config-drive `MAX_RETRIES` (`pipeline.ts:1406`)

`const MAX_RETRIES = app.qa.fixLoop?.maxRetries ?? 2;` Schema (§5.4). Default 2 (was hard 1). Loop header
(`:1407`) unchanged except the bound.

### 5.2 Thread `failureDom` at the retry (`pipeline.ts:1417`)

```
const domSnapshot = buildFailureDom(failed);   // join failed[].failureDom into one fenced block
result = await generateAndReview(baseGenInput({ fixCases: failed, domSnapshot }));
```

`baseGenInput` already spreads `domSnapshot` into `GenerateInput` (`:1101`, `:1122`). Today the retry
(`:1417`) passes none. `buildFailureDom` is a tiny pure helper (concatenate per-case `failureDom`,
labelled by case name) — unit-tested.

### 5.3 Progress gate as a pure function (`decideProgress`)

New pure export (own module `src/qa/progress-gate.ts` + colocated test, or in `pipeline` helpers):

```ts
interface RoundResult { failingNames: Set<string>; failingCount: number; absentSelectors: Set<string>; lever2Flips: number; }
interface GateDecision { spend: boolean; reason: string; }
function decideProgress(prev: RoundResult | null, cur: RoundResult): GateDecision
```

Decision (deterministic, fail-closed — design §1.5b):

- `prev === null` (first retry) → `{ spend: true }` (round 1 always allowed under the cap).
- **Regression guard:** `cur.failingCount > prev.failingCount` → caller keeps the **best** round, gate
  returns `spend:false` (`reason: "regression"`). Never ship a regression.
- **Real-bug branch:** all proposed selectors resolve **uniquely** (not a selector problem) AND failure is
  an assertion **value mismatch** (not locator/timeout) → `spend:false` (`reason:"likely real bug → Issue"`).
  A **timeout** with resolving selectors → a round IS allowed (add a wait).
- **Spend iff ≥1 holds:** (A) `cur.failingCount < prev.failingCount`; (B)
  `cur.failingNames ≠ prev.failingNames`; (C) `cur.lever2Flips > 0` (an absent→present flip this round).
- **None hold** (same count, same set, identical selectors still absent) → `spend:false`
  (`reason:"no progress — agent ignored ground truth"`). Fail-closed.
- **Hard cap = MAX_RETRIES** in the loop header regardless of the gate.

**Lever-2 short-circuit counts against the same budget:** when §4.4 returns absent, the loop performs a
regeneration WITHOUT re-executing, but still increments `retry` — so "absent → regenerate" can never loop
past the cap. The gate is consulted at the top of each iteration using the prior round's
`RoundResult`; the classification inputs (assertion-value-mismatch vs timeout vs locator) come from the
case `detail`/`errorContext` strings (regex, same family as `PLAYWRIGHT_INFRA_RE`, `execute.ts:102`).

### 5.4 Schema — `src/orchestrator/schemas.ts`

Add to the `qa` object (`schemas.ts:39-69`, alongside `changeCoverage`):

```ts
fixLoop: z.object({ maxRetries: z.number().int().min(0).max(5).optional() }).optional(),
```

`max(5)` bounds cost; `min(0)` allows disabling. Read at `pipeline.ts:1406`.

---

## 6. Prompts + Q2 — `src/integrations/prompts.ts`, `opencode-client.ts`, `agents/opencode.json`

### 6.1 "GROUND TRUTH AT FAILURE" block — `prompts.ts`

The fix path already renders `domBlock` from `input.domSnapshot` (`prompts.ts:284-298`) and the `fixBlock`
(`:254-278`). With §5.2 now feeding `domSnapshot` from real failure captures, replace the
`fixBlock` steps 2-3 (which tell the agent to `browser_navigate + browser_snapshot`, `:266-275`) with a
distinct authoritative block placed at the **prompt edge** (top, before `buildTask` — `:304-309` already
puts `domBlock` near the top; keep it first when failure-sourced). Framing (design §1.7, evidence-backed):

- **Source-framing:** "the tree below is the page AT THE FAILURE POINT — the ONLY source of truth; do not
  use general knowledge of what tables/forms usually contain."
- **Counterfactual:** "tables commonly expose `columnheader`, but THIS tree does not — trust the tree, not
  the convention." (Neutralizes the columnheader knowledge-conflict.)
- **Quote-then-assert:** "cite the exact `role: name` line each locator relies on; an unquotable locator is
  rejected." A boolean `input.failureSourced?: boolean` (new on `OpencodeRunInput`/`GenerateInput`)
  switches `domBlock`'s heading from "Live DEV accessibility tree" to "GROUND TRUTH AT FAILURE" and adds
  the counterfactual/quote lines. (Lever 2 is the deterministic check that runs FIRST, §4.4 — the prompt
  is the backstop.)

### 6.2 `buildWorkerPrompt` Q2 rewrite — `prompts.ts:24-37, 56-71`

Workers lose the Playwright MCP (§6.4). Rewrite the `needsUi` rules branch (`:25-31`) to remove
`browser_navigate`/`browser_snapshot` and the explore-then-write instruction: workers TRANSCRIBE the
injected tree, never navigate. The `domSnapshot` block (`:60-71`) already says "you do NOT need to
navigate" — strengthen it to "you have NO browser; the tree below is your ONLY source." Drop the
`- LIVE DEV URL` line for workers (`:56`) and the `baseUrl`-less fallback (`:28`) becomes "transcribe the
injected tree; if none was injected, derive from the brief and mark selectors unverified in a comment."

### 6.3 `buildPlanPrompt` Lever-3 route declaration — `prompts.ts:91`, `opencode-client.ts:1136`

The planner (`qa-generator`, keeps the Playwright MCP) already emits `brief.routes[]` (`prompts.ts:151`
example carries `routes:[{path,verified:false}]`; orchestrator renders them via
`opencode-client.ts:1202-1209` → `captureRoutesDom`). The CHANGE is prompt-only: instruct the planner to
USE the MCP during planning to navigate interaction flows and **discover + verify post-interaction landing
routes** (e.g. owner-register → `/#!/owners/{id}`), declaring them in `routes[]` with `verified:true`
alongside the literal `page.goto` routes. Single-agent (the plan session, `opencode-client.ts:1136`) → no
concurrency. The orchestrator render path and worker injection are unchanged.

### 6.4 `qa-worker` MCP removal — `agents/opencode.json:72`

`"mcp": ["serena", "playwright"]` → `"mcp": ["serena"]`. One line. `qa-generator` (`:24`,
`["serena","engram","playwright"]`) KEEPS playwright (Lever 3). `qa-worker-code` (`:82`) already
`["serena"]` — now `qa-worker` matches it. Description (`:67`) updated: workers transcribe the injected
tree, no navigation.

---

## 7. Phase 0 — Dockerfile (foundation)

### 7.1 Orchestrator `Dockerfile`

- **Base (`:7`):** `mcr.microsoft.com/playwright:v1.50.0-jammy` → `:v1.60.0-noble` (browsers↔runner
  lockstep; OS → Ubuntu 24.04).
- **Explicit Node 24 layer** (new, after the base): the 1.60 image still ships Node 20, which is below the
  floors of `undici@8.4.1` (needs ≥22.19) and `better-sqlite3` 12.10.1's prebuild matrix (no Node-20
  prebuild → would compile from source). Add NodeSource 24 or copy from `node:24` — explicit, pinned.
- **Go via upstream tarball** (replace apt `golang`, `:17`): `https://go.dev/dl/go1.26.4.linux-amd64.tar.gz`
  → `/usr/local/go`, add `/usr/local/go/bin` to PATH. apt on noble ships ~1.22 — too old.
- **Noble apt audit (`:13-21`):** verify each package name on 24.04 — `python3 python3-pip python3-venv`,
  `cargo rustc`, `maven`, `gradle`, `build-essential`. Noble ships Python 3.12 (jammy 3.10); confirm no
  rename. `golang` line is deleted (replaced by the tarball).
- **`better-sqlite3` 12.10.1 ABI note:** with the Node 24 layer present, the v137 linux-x64 prebuilt is
  fetched — NO source compile in the image. (Document this in a Dockerfile comment near the npm install.)

### 7.2 `package.json` pins (Phase 0)

`better-sqlite3 12.10.0 → 12.10.1`; `@opencode-ai/sdk 1.15.13 → 1.17.7`; `undici ^8.3.0 → ^8.4.1`
(floor documents the Node 22.19 requirement). `config/e2e/package.json`: `@playwright/test 1.50.0 → 1.60.0`
(EXACT, must equal the image tag — never `^`).

### 7.3 `agents/Dockerfile`

`FROM node:22-bookworm → node:24-bookworm` (`:3`), align with the orchestrator. `SERENA_VERSION`/
`ENGRAM_VERSION`/`@playwright/mcp` unchanged.

---

## 8. Test plan + sequencing

### 8.1 Per-module (DI-consistent)

| Module | Pure core unit-tested | Uncovered boundary |
|---|---|---|
| `dom-snapshot.ts` | `parseAriaSnapshot` (YAML→records, table/list priority, presentation-table→text, quoted vs content name); `formatDomSnapshot` unchanged tests | the `capture.cjs` child render (real browser) |
| `selector-check.ts` | `extractProposedSelectors`, `selectorPresent` (ci-substring/exact/regex/role-only/normalize), `selectorUnique` | — (fully pure) |
| `progress-gate.ts` | `decideProgress`: 3-signal spend, fail-closed, regression guard, real-bug-vs-timeout, first-retry | — (pure given two rounds) |
| `setup.ts` | `ensureFailureCapture`: marker-guard, append-only, idempotent, seed-vs-existing | real `npm ci`, real FS copy |
| `execute.ts` | `matchFailureDumps` (slug match), `buildFailureDom` | runSuite spawn, env threading, the `afterEach` in a real browser |
| `playwright-report.ts` | `firstErrorContext` + `errorContext` surfaced on a sample 1.60 report | — (pure) |
| `prompts.ts` | "GROUND TRUTH AT FAILURE" framing present + edge-placed; worker Q2 text has no `browser_navigate`; plan prompt declares verified routes | the MCP calls themselves |

### 8.2 Atomic-PR sequencing (review-budget-aware; 400-line guard)

- **Unit 1 = Phase 0 + Phase 1a together** (mandatory pairing). `page.accessibility.snapshot()` was removed
  in 1.57 (`dom-snapshot.ts:206`) — bumping to 1.60 (Phase 0) BREAKS the render unless `parseAriaSnapshot`
  + the `ariaSnapshot()` migration (1a) land in the SAME PR. Gate: `npm test` + `typecheck` green +
  PetClinic shadow smoke reaches execution and produces a JSON report on the new image.
- **Unit 2 = Phase 1 b+c** (Lever 1 plumbing + Lever 2 pure module): `QaCase.failureDom`, the seed
  `afterEach`, `ensureFailureCapture`, `execute.ts` capture-dir + harvest, `playwright-report.ts`
  `errorContext`, and `selector-check.ts`. `errorContext` REQUIRES the 1.60 base (absent on 1.50) → after
  Unit 1. Self-contained (no fix-loop changes yet); each piece DI-tested.
- **Unit 3 = Phase 1 d+e+f** (fix-loop + prompts + Q2): `MAX_RETRIES`→config + schema, `failureDom`
  threading at `:1417`, `decideProgress`, the "GROUND TRUTH AT FAILURE" block, `buildPlanPrompt` Lever-3,
  `buildWorkerPrompt` Q2, `agents/opencode.json` worker MCP removal. Depends on Unit 2 (`failureDom`,
  `selector-check`). The schema change (`qa.fixLoop`) MUST ride with the `pipeline.ts:1406` change (same PR).

Each unit has a clear start/finish, autonomous scope, `npm test`+`typecheck` gate, and a clean rollback
(revert the PR). The hard dependency (1.57 removal) is what forces Unit 1's pairing — it is not optional.

---

## Decisions (ADR-style)

| # | Decision | Alternatives rejected | Rationale |
|---|---|---|---|
| D1 | `parseAriaSnapshot` is a **line-based parser**, not a YAML library | js-yaml / yaml dep | The grammar is a strict line shape (spike-verified); a full YAML parser adds a dependency and mis-handles the `: value` vs bare-`:` child distinction we must encode anyway. Zero new deps; the indentation carries no semantics we keep (we flatten). |
| D2 | Capture via an **orchestrator-owned `afterEach`** dumping to an env-provided dir | a custom Playwright reporter; trace parsing | Reporters cannot reach the live `page` (maintainer-confirmed); the trace is heavy/late. The fixture sees `page` at the failure point. Dumb-by-design keeps parsing in the orchestrator. |
| D3 | Progress gate on **3 deterministic aggregate signals**, never raw-DOM equality | DOM-diff between rounds; LLM "did it improve?" | Raw-DOM equality is fragile; an LLM judge re-introduces the proxy the keystone exists to avoid. Count + name-set + Lever-2-flip are robust and fail-closed (worst case: one wasted pro generation). |
| D4 | Lever 2 "absent" is **UNVERIFIABLE, never a hard block** | reject the spec as invalid | The snapshot prunes hidden/uninteresting nodes differently than `getByRole`; a hard block would false-positive. Skipping the wasted re-execute + folding a contradiction into the next round is sound; the executor stays the final oracle. |
| D5 | Workers **lose the Playwright MCP** (Q2); only the planner explores live ×1 | every worker explores (status quo); lite worker now | ×N worker exploration is expensive + concurrent DEV pressure; the prior lite failure (1/7) was Q3 (lite WITH navigation) — not applicable once navigation is removed. Lite worker is deferred (Q4) until the simplified job is proven. |
| D6 | **Unit 1 pairs Phase 0 + 1a**; majors deferred | bump base alone; one big PR | The 1.57 `accessibility.snapshot()` removal makes the base bump break the render unless 1a rides with it. TS6/ESLint10/c8-11 are a separate backlog track (own gate). |

## Open questions

- Exact `errors[].errorContext` field name/shape in the 1.60 JSON report (string vs nested) — confirm
  against a real 1.60 report during Unit 2; the `PwResult` shape (§2.3) may need a one-line adjust.
- Noble package-name drift for `cargo`/`rustc`/`maven`/`gradle` — resolved empirically at Unit 1 build.
