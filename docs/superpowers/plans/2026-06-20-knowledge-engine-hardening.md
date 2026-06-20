# Knowledge-Engine Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the cross-run learning engine reliable, fast, deterministic and self-contained — a best-effort piece that, when it fails, never breaks the surrounding pipeline.

**Architecture:** All fixes keep the engine's pure/impure split intact and add NO new persistence, schema, index or DB round-trip. Governance math and selection stay pure functions; the only new module is an in-memory `bestEffort` boundary. Behavior-changing constants are isolated and pinned by invariant tests.

**Tech Stack:** TypeScript via `tsx`, `node:test` + `node:assert/strict`, colocated `*.test.ts`. Test runner: `node --import tsx --test <file>`. Gate: `npm test` and `npm run typecheck` must stay green.

**Design constraints (from the request):**
- Best-effort, non-blocking; losing a folded outcome in a rare crash is acceptable — do NOT add durability/retry queues.
- No coupling to persistence/DB; fixes are pure or dependency-injected.
- Priorities: robustness, bug removal, efficiency, determinism, fault isolation.

**Repo test conventions (AUTHORITATIVE — these override any code snippet below that conflicts):**
- Tests import `{ describe, it } from "node:test"` and put each case in `it(...)`. NEVER write a bare `test(...)` — it is not imported anywhere in this repo (verified: `learning-rule.test.ts:1`, `distiller.test.ts:1`).
- The project is native ESM (`tsconfig: "module": "ESNext"`). NEVER use `require(...)` — use static top-of-file `import` or `await import(...)`. (`src/qa/setup.test.ts` pins this: `require` is a `ReferenceError` here.)
- `learning-rule.test.ts` already declares a `rule(overrides: Partial<LearningRule>)` factory (line 15). Name any NEW local factory `mkRule` to avoid a duplicate-identifier collision, or reuse the existing `rule()`.
- Tests that need the store use REAL-DB integration with a unique app name per test (the `distiller.test.ts` pattern: static imports of `upsertLearningRule`/`listLearningRules`/`recordRuleOutcome`, seed rows, isolate by app). Do NOT mock the history module (`t.mock.method` cannot intercept named ESM imports and is used nowhere in this repo).
- `tsconfig.json` has `strict` + `noUncheckedIndexedAccess` but NOT `noUnusedLocals` — delete dead consts (e.g. `MAX_LEARNED_RULES_CHARS`) for hygiene, NOT because typecheck would fail (it won't).
- When a size threshold must actually fire in a test (e.g. the 5000-char `fitRulesToBudget` drop), size fixtures so the total comfortably exceeds it (≈8 rules × 600+ chars), not barely — `renderRulesForPrompt` adds ~80 chars of header per rule, so 8 × 400 ≈ 3.9k stays UNDER 5k and would not drop anything.

**Scope — seven fixes, ordered by the request's north star (fault-isolation first):**
1. Task 1 — `bestEffort` isolation boundary (the engine never throws into the pipeline).
2. Task 2 — deterministic char-budget fit (kills phantom `usageCount`/attribution).
3. Task 3 — deterministic `selectForRetrieval` (safe splice + stable tie-break).
4. Task 4 — prevention score below promote rate (anti-Goodhart hardening).
5. Task 5 — remove `memory-heal` dead code.
6. Task 6 — dedup-window saturation visibility.
7. Task 7 — context-directed oracle attribution (higher-risk; gated).

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `src/qa/learning/best-effort.ts` (new) | Pure isolation wrapper: run a fn, swallow+log any throw, return a fallback. Sync + async. | 1 |
| `src/qa/learning/best-effort.test.ts` (new) | Behavioral tests for the wrapper. | 1 |
| `src/qa/learning/learning-rule.ts` | Add `DEFAULT_RULES_CHAR_BUDGET`, `fitRulesToBudget`; make `selectForRetrieval` deterministic; lower `PREVENTION_HELD_SCORE`; add `attributableRules`. | 2,3,4,7 |
| `src/qa/learning/learning-rule.test.ts` | Tests for budget-fit, determinism, attribution. | 2,3,7 |
| `src/qa/learning/learning-rule.invariants.test.ts` | Update the pinned prevention/promote invariant. | 4 |
| `src/qa/learning/retrieval.ts` | Apply `fitRulesToBudget`; increment usage only on the fitted set. | 2 |
| `src/qa/learning/retrieval.test.ts` (new if absent) | Test that usage tracks the fitted set, not the selected set. | 2 |
| `src/qa/learning/process-audit.ts` | Remove `memory-heal` disposition + `flagMemoryHeal` dep + case. | 5 |
| `src/qa/learning/process-audit.test.ts` | Drop the synthetic `memory-heal` test and `flagMemoryHeal` dep from `applyAudit ROUTES` test. | 5 |
| `src/qa/learning/distiller.ts` | Log when the dedup window saturates. | 6 |
| `src/pipeline.ts` | Remove manual char cap; wrap engine side-effects in `bestEffort`; extend `ValueLearningInput` with `retrievedRules: LearningRule[]`; pass it at the call-site (line ≈2288); thread attribution context; remove `flagMemoryHeal:` from `applyAudit` call. | 1,2,5,7 |

---

### Task 1: `bestEffort` isolation boundary

The engine's side-effects (retrieval, governance fold, reflection, audit, curriculum save) must be uniformly fault-isolated: any throw is logged loudly and swallowed, never propagated. Today the `try/catch` blocks are ad-hoc and inconsistent. This task centralizes the boundary so "the engine never breaks the pipeline" is a guarantee, not a per-site habit.

**Files:**
- Create: `src/qa/learning/best-effort.ts`
- Test: `src/qa/learning/best-effort.test.ts`
- Modify: `src/pipeline.ts` (replace ad-hoc engine `try/catch` with the wrapper)

- [ ] **Step 1: Write the failing test**

```typescript
// src/qa/learning/best-effort.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { bestEffort, bestEffortAsync } from "./best-effort";

test("bestEffort returns the fn result when it succeeds", () => {
  const logs: string[] = [];
  const out = bestEffort("label", (l) => logs.push(l), () => 42, -1);
  assert.equal(out, 42);
  assert.equal(logs.length, 0);
});

test("bestEffort swallows a throw, logs once, returns the fallback", () => {
  const logs: string[] = [];
  const out = bestEffort("retrieval", (l) => logs.push(l), () => {
    throw new Error("boom");
  }, "FALLBACK");
  assert.equal(out, "FALLBACK");
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /retrieval/);
  assert.match(logs[0]!, /boom/);
  assert.match(logs[0]!, /non-blocking/);
});

test("bestEffortAsync swallows a rejected promise and returns the fallback", async () => {
  const logs: string[] = [];
  const out = await bestEffortAsync("reflect", (l) => logs.push(l), async () => {
    throw new Error("async-boom");
  }, null);
  assert.equal(out, null);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /reflect/);
  assert.match(logs[0]!, /async-boom/);
});

test("bestEffortAsync returns the awaited result on success", async () => {
  const out = await bestEffortAsync("ok", () => {}, async () => "done", "fb");
  assert.equal(out, "done");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/qa/learning/best-effort.test.ts`
Expected: FAIL — `Cannot find module './best-effort'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/qa/learning/best-effort.ts
// In-memory fault-isolation boundary for the knowledge engine. Every engine side-effect runs
// THROUGH this wrapper so a failure is logged loudly and swallowed, never propagated into the
// pipeline. No persistence, no retry: per the engine's best-effort contract a lost outcome on a
// rare crash is acceptable; a thrown error that aborts the run is NOT.
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function bestEffort<T>(label: string, log: (line: string) => void, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    log(`[learn] ${label} failed (non-blocking): ${describe(err)}`);
    return fallback;
  }
}

export async function bestEffortAsync<T>(
  label: string,
  log: (line: string) => void,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    log(`[learn] ${label} failed (non-blocking): ${describe(err)}`);
    return fallback;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/qa/learning/best-effort.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Apply the wrapper at the engine's pipeline call-sites**

Replace each ad-hoc engine `try/catch` in `src/pipeline.ts` with `bestEffort`/`bestEffortAsync`. Add the import at the top with the other `./qa/learning/*` imports:

```typescript
import { bestEffort, bestEffortAsync } from "./qa/learning/best-effort";
```

Convert the retrieval block (`src/pipeline.ts:1539-1567`) — the outer `try/catch` becomes:

```typescript
    if (deps.retrieveRules && generating) {
      const retrieval = await bestEffortAsync("retrieval", log, async () => {
        let lastErrorClass: string | null = null;
        if (deps.recentErrorClass) {
          lastErrorClass = await bestEffortAsync("recent-error-class", log, () => deps.recentErrorClass!(app.name), null);
        }
        const diffArchetypes = detectStructuralPatterns(diff, intent?.changedFiles ?? []).map((p) => p.kind);
        return deps.retrieveRules!(app.name, lastErrorClass, diffArchetypes);
      }, null);
      if (retrieval?.promptSection) {
        learnedRules = retrieval.promptSection;
        retrievedRuleIds = retrieval.rules.map((r) => r.id);
        retrievedRules = retrieval.rules;
        log(`[qa] retrieval: injected ${retrievedRuleIds.length} learning rule(s) into the agent prompt`);
      }
    }
```

Apply the same treatment to the remaining engine side-effects, each wrapped so a throw cannot escape:

- **Governance fold** (`src/pipeline.ts:1759-1776`) — this block is inside `foldRunLearning` (the closure around line 1759), NOT inside `foldValueLearning`. Wrap it:
  `bestEffort("governance", log, () => { …existing for-loop body… }, undefined)`

- **Reflection dispatch** (`src/pipeline.ts:1777-1783`) — already `.catch`-guarded; replace with:
  `void bestEffortAsync("reflect-distill", log, () => deps.reflectAndDistill!({…}), null)`
  The `void` prefix retains fire-and-forget (NOT awaited) so reflection never blocks the pipeline.

- **Curriculum save** (`src/pipeline.ts:1786-1791`) → `bestEffort("curriculum-save", log, () => saveCurriculum(curriculum!), undefined)`.

- **Process audit** (`src/pipeline.ts:1798-1806`) → `bestEffortAsync("process-audit", log, () => deps.auditProcess!({…}), undefined)`.

- **Value-fold attribution** (`src/pipeline.ts:704-714`) — this loop is inside `foldValueLearning` (the function defined at line 622). Wrap the `for` loop body:
  `bestEffort("attribution", log, () => { for (const ruleId of retrievedRuleIds) …; log(…); }, undefined)`
  (it already has a local `try/catch`; replace it with the wrapper).

> NOTE: `foldValueLearning` (line 622) and the governance fold (≈1759) are TWO SEPARATE call-sites in different scopes. `foldValueLearning` is the oracle + attribution path; the governance fold (prevention signal) is in the `foldRunLearning`-equivalent closure. Do not conflate them.

- [ ] **Step 6: Run the full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS — no behavioral change, only uniform isolation. Existing pipeline tests stay green.

- [ ] **Step 7: Commit**

```bash
git add src/qa/learning/best-effort.ts src/qa/learning/best-effort.test.ts src/pipeline.ts
git commit -m "feat(learn): add bestEffort isolation boundary for engine side-effects"
```

---

### Task 2: Deterministic char-budget fit (kill phantom usage/attribution)

Today `retrievedRuleIds`/`retrievedRules` are fixed from the full selected set (`pipeline.ts:1560-1561`) and `incrementRuleUsage` already ran on that full set inside `retrieveRules` — but the prompt string is truncated afterwards (`pipeline.ts:1571-1574`). Rules whose text was cut still count as "used" and still receive folded outcomes. Fix: make the char budget part of selection so the returned set == the rendered set. Pure, deterministic, no DB.

**Files:**
- Modify: `src/qa/learning/learning-rule.ts` (add `DEFAULT_RULES_CHAR_BUDGET`, `fitRulesToBudget`)
- Modify: `src/qa/learning/retrieval.ts` (fit, then increment usage on the fitted set)
- Modify: `src/pipeline.ts` (remove the manual cap at 1569-1574)
- Test: `src/qa/learning/learning-rule.test.ts`, `src/qa/learning/retrieval.test.ts`

- [ ] **Step 1: Write the failing test (budget fit)**

```typescript
// append to src/qa/learning/learning-rule.test.ts
import { fitRulesToBudget, DEFAULT_RULES_CHAR_BUDGET, type LearningRule } from "./learning-rule";

function rule(id: string, action: string, status: "active" | "candidate" = "active"): LearningRule {
  return {
    id, trigger: "Applies when the diff adds a form", action, errorClass: "E-FALSE-POSITIVE",
    confidence: "medium", usageCount: 0, outcomeCount: 3, successRate: 0.6,
    lastVerified: null, source: "test", status, at: "2026-01-01T00:00:00.000Z",
  };
}

test("fitRulesToBudget returns all rules when they fit and renders exactly them", () => {
  const rules = [rule("a", "x"), rule("b", "y")];
  const out = fitRulesToBudget(rules, DEFAULT_RULES_CHAR_BUDGET);
  assert.equal(out.included.length, 2);
  assert.equal(out.rendered.length <= DEFAULT_RULES_CHAR_BUDGET, true);
});

test("fitRulesToBudget drops lowest-ranked rules from the tail to fit the budget", () => {
  const big = "z".repeat(400);
  const rules = [rule("a", big), rule("b", big), rule("c", big)];
  const out = fitRulesToBudget(rules, 900);
  // The fitted set never exceeds the budget and is a HEAD-prefix of the input ranking.
  assert.equal(out.rendered.length <= 900, true);
  assert.deepEqual(out.included.map((r) => r.id), rules.slice(0, out.included.length).map((r) => r.id));
  assert.equal(out.included.length < 3, true);
});

test("fitRulesToBudget renders only the included rules (no phantom rule IDs)", () => {
  const big = "z".repeat(400);
  const rules = [rule("a", big), rule("b", big), rule("c", big)];
  const out = fitRulesToBudget(rules, 900);
  for (const r of rules) {
    const present = out.rendered.includes(r.action);
    assert.equal(present, out.included.some((i) => i.id === r.id));
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/qa/learning/learning-rule.test.ts`
Expected: FAIL — `fitRulesToBudget` / `DEFAULT_RULES_CHAR_BUDGET` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/qa/learning/learning-rule.ts` (after `renderRulesForPrompt`):

```typescript
// The char budget for the rendered learning-rules prompt section. Lived in pipeline.ts as a
// post-hoc string truncation that left retrievedRuleIds referencing rules whose text was cut —
// inflating usageCount and folding outcomes onto rules the generator never saw. Centralized here
// so the budget is part of SELECTION: the returned set is exactly the rendered set.
export const DEFAULT_RULES_CHAR_BUDGET = 5000;

// Greedily drop the lowest-ranked rules (the tail — `rules` arrives ranked by selectForRetrieval)
// until renderRulesForPrompt fits the budget. Pure and deterministic: same input → same fitted set.
// Cuts at a whole-rule boundary, never mid-rule. n ≤ maxRules (≤ 8) so the O(n²) render is trivial.
export function fitRulesToBudget(
  rules: LearningRule[],
  maxChars: number,
): { included: LearningRule[]; rendered: string } {
  let included = [...rules];
  let rendered = renderRulesForPrompt(included);
  while (included.length > 0 && rendered.length > maxChars) {
    included = included.slice(0, -1); // drop the lowest-ranked rule and re-render
    rendered = renderRulesForPrompt(included);
  }
  return { included, rendered };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/qa/learning/learning-rule.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing retrieval integration test**

> **Design constraint:** `retrieval.ts` uses named ESM imports (`import { listLearningRules, incrementRuleUsage } from "../../server/history"`). `t.mock.method` cannot intercept named imports and is not used anywhere in this repo. The test must be a REAL-DB integration test following the repo's established pattern (see `distiller.test.ts`): seed rows via `upsertLearningRule`, isolate by unique app name per test, read back with `listLearningRules`.
>
> **Also note:** `PipelineDeps.retrieveRules` does NOT need signature changes — `maxChars` is an optional field internal to `retrieveRules` with a default, invisible at the call-site.

```typescript
// src/qa/learning/retrieval.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { upsertLearningRule } from "../../server/history";

test("retrieveRules increments usage only on the budget-fitted set (real-DB integration)", () => {
  // Unique app name per run so repeated test invocations never collide on DB state.
  const app = `retrieval-budget-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const big = "z".repeat(400);

  // Seed 8 active rules with 400-char actions. 8 × ~400 chars >> the 5000-char budget,
  // so fitRulesToBudget must drop tail rules before incrementing usage.
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) {
    const id = `rule-budget-${i}`;
    ids.push(id);
    upsertLearningRule({
      id,
      app,
      trigger: `Applies when the diff adds a form (case ${i})`,
      action: big,
      errorClass: "E-FALSE-POSITIVE",
      source: "test",
    });
    // Promote to active so all 8 are equally ranked and the budget alone determines the cut.
    const { recordRuleOutcome } = require("../../server/history");
    for (let j = 0; j < 3; j++) recordRuleOutcome(id, 0.9);
  }

  const { retrieveRules } = require("./retrieval");
  const out = retrieveRules({ app, maxRules: 8 });

  // The fitted set must be smaller than 8 (budget exceeded with 400-char actions × 8).
  assert.ok(out.rules.length < 8, `expected fewer than 8 rules, got ${out.rules.length}`);

  // usage was incremented (usageCount went from 0+3 outcomes to 3+1) only for the returned set.
  // Verify by re-reading all rules: only out.rules IDs should have usageCount > 0.
  const { listLearningRules } = require("../../server/history");
  const allAfter = listLearningRules(app, 50);
  const fittedIds = new Set(out.rules.map((r: { id: string }) => r.id));
  for (const r of allAfter) {
    if (fittedIds.has(r.id)) {
      assert.ok(r.usageCount > 0, `fitted rule ${r.id} must have usageCount > 0`);
    } else {
      assert.equal(r.usageCount, 0, `dropped rule ${r.id} must still have usageCount === 0`);
    }
  }

  // out.rules matches out.promptSection (no phantom rules rendered beyond the returned set).
  for (const r of out.rules) {
    assert.ok(out.promptSection.includes(r.action), `rendered section must include action of fitted rule ${r.id}`);
  }
});
```

- [ ] **Step 6: Implement the retrieval change**

Replace the body of `retrieveRules` in `src/qa/learning/retrieval.ts`. Add `maxChars` to the existing `RetrievalInput` interface and add the `fitRulesToBudget` import:

```typescript
import type { ErrorClass } from "./taxonomy";
import type { LearningRule } from "./learning-rule";
import { selectForRetrieval, fitRulesToBudget, DEFAULT_RULES_CHAR_BUDGET } from "./learning-rule";
import { listLearningRules, incrementRuleUsage } from "../../server/history";

export interface RetrievalInput {
  app: string;
  errorClass?: ErrorClass | null;
  archetypes?: string[]; // the current diff's structural shapes — biases retrieval toward matching rules
  maxRules?: number;
  maxChars?: number; // defaults to DEFAULT_RULES_CHAR_BUDGET inside retrieveRules; invisible at the PipelineDeps call-site
}

export interface RetrievalResult {
  rules: LearningRule[];
  promptSection: string;
}

export function retrieveRules(input: RetrievalInput): RetrievalResult {
  const all = listLearningRules(input.app, 50);
  const selected = selectForRetrieval(all, {
    app: input.app,
    errorClass: input.errorClass ?? null,
    archetypes: input.archetypes,
    maxRules: input.maxRules,
  });

  // Budget-fit BEFORE recording usage so usageCount and the retrieved-IDs set reflect exactly
  // what the generator will see — no phantom "used" rules that were truncated out of the prompt.
  const { included, rendered } = fitRulesToBudget(selected, input.maxChars ?? DEFAULT_RULES_CHAR_BUDGET);

  if (included.length > 0) {
    incrementRuleUsage(included.map((r) => r.id));
  }

  return { rules: included, promptSection: rendered };
}
```

- [ ] **Step 7: Remove the now-redundant manual cap in the pipeline**

Delete `src/pipeline.ts:1569-1574` (the `MAX_LEARNED_RULES_CHARS` block):

```typescript
// DELETE these 4 lines (1569-1574):
    // Cap learned rules to prevent context window exhaustion
    const MAX_LEARNED_RULES_CHARS = 5000;
    if (learnedRules && learnedRules.length > MAX_LEARNED_RULES_CHARS) {
      log(`[qa] WARNING: learnedRules truncated from ${learnedRules.length} to ${MAX_LEARNED_RULES_CHARS} chars (cap exceeded)`);
      learnedRules = learnedRules.substring(0, MAX_LEARNED_RULES_CHARS) + "\n...[truncated]";
    }
```

`learnedRules` already arrives within budget from `retrieveRules`, and `retrievedRuleIds`/`retrievedRules` (set at 1560-1561) now equal the rendered set. Removing the block also eliminates the `const MAX_LEARNED_RULES_CHARS` that would otherwise produce a `noUnusedLocals` typecheck error once `learnedRules` is always pre-trimmed.

> **Important:** `noUnusedLocals` is strict in this repo. Deleting the entire block (both the `const` and the `if`) is required — leaving just the `const` without its `if` body would fail typecheck.

- [ ] **Step 8: Run tests + typecheck**

Run: `node --import tsx --test src/qa/learning/learning-rule.test.ts && node --import tsx --test src/qa/learning/retrieval.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/qa/learning/learning-rule.ts src/qa/learning/learning-rule.test.ts src/qa/learning/retrieval.ts src/qa/learning/retrieval.test.ts src/pipeline.ts
git commit -m "fix(learn): budget-fit rules in selection to stop phantom usage and attribution"
```

---

### Task 3: Deterministic `selectForRetrieval` (safe splice + stable tie-break)

Two determinism defects in `selectForRetrieval` (`learning-rule.ts:201-218`): (a) `scored.sort` has no tie-break, so equal-score rules order by input position — non-deterministic across store reads; (b) `picked.splice(limit - slots, slots, …)` appends instead of replaces when `picked.length < limit`, silently changing the result count.

**Files:**
- Modify: `src/qa/learning/learning-rule.ts:201-218`
- Test: `src/qa/learning/learning-rule.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// append to src/qa/learning/learning-rule.test.ts
import { selectForRetrieval } from "./learning-rule";

test("selectForRetrieval breaks score ties deterministically by id", () => {
  const mk = (id: string): LearningRule => ({
    id, trigger: "Applies when x", action: "do y", errorClass: "E-FALSE-POSITIVE",
    confidence: "medium", usageCount: 0, outcomeCount: 3, successRate: 0.6,
    lastVerified: null, source: "test", status: "active", at: "2026-01-01T00:00:00.000Z",
  });
  const forward = selectForRetrieval([mk("c"), mk("a"), mk("b")], { app: "d", maxRules: 2 });
  const reversed = selectForRetrieval([mk("b"), mk("a"), mk("c")], { app: "d", maxRules: 2 });
  assert.deepEqual(forward.map((r) => r.id), reversed.map((r) => r.id));
});

test("selectForRetrieval never grows the result beyond maxRules when the exploration floor fires", () => {
  const active = (id: string): LearningRule => ({
    id, trigger: "t", action: "a", errorClass: "E-FALSE-POSITIVE", confidence: "high",
    usageCount: 0, outcomeCount: 3, successRate: 0.9, lastVerified: null, source: "t",
    status: "active", at: "2026-01-01T00:00:00.000Z",
  });
  const candidate = (id: string): LearningRule => ({ ...active(id), status: "candidate", successRate: 0.1, confidence: "low" });
  // 2 active + 3 candidates, limit 4: exploration floor must REPLACE, not append.
  const out = selectForRetrieval([active("a1"), active("a2"), candidate("c1"), candidate("c2"), candidate("c3")], { app: "d", maxRules: 4 });
  assert.equal(out.length, 4);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/qa/learning/learning-rule.test.ts`
Expected: FAIL — tie-break test returns different orders; (the floor test may already pass, it pins the invariant).

- [ ] **Step 3: Implement the deterministic fix**

Replace `learning-rule.ts:201-219` with:

```typescript
  const scored = eligible.map((r) => ({ rule: r, score: score(r) }));
  // Stable, deterministic order: by score desc, ties broken by id asc so the same store contents
  // always yield the same retrieval regardless of row read order.
  scored.sort((a, b) => b.score - a.score || a.rule.id.localeCompare(b.rule.id));

  const limit = opts.maxRules ?? 8;
  const picked = scored.slice(0, limit).map((s) => s.rule);

  // Exploration floor: once `limit` ACTIVE rules exist, the +100 exploit bonus would shut
  // candidates out of retrieval forever. Reserve the last slots for the NEWEST candidates not
  // already selected. Only replace when picked is actually FULL — splicing past the end would
  // append and grow the result beyond `limit`.
  if (eligible.length > limit && picked.length >= limit) {
    const pickedIds = new Set(picked.map((r) => r.id));
    const freshCandidates = eligible
      .filter((r) => r.status === "candidate" && !pickedIds.has(r.id))
      .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
    const slots = Math.min(EXPLORATION_SLOTS, freshCandidates.length);
    if (slots > 0) picked.splice(limit - slots, slots, ...freshCandidates.slice(0, slots));
  }
  return picked;
```

> **Note:** `EXPLORATION_SLOTS` is already declared at `learning-rule.ts:223` (`export const EXPLORATION_SLOTS = 2`). It is referenced above the replacement block; do NOT re-declare it or move it — the fix only replaces lines 201-219.
>
> **Test note:** The "never grows beyond maxRules" test (`selectForRetrieval never grows the result beyond maxRules when the exploration floor fires`) is a REGRESSION/invariant guard — it may already pass pre-fix with the current code. The TIE-BREAK test (`selectForRetrieval breaks score ties deterministically by id`) is the TRUE red-green test that fails before the fix and passes after.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test src/qa/learning/learning-rule.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the invariants + full suite**

Run: `node --import tsx --test src/qa/learning/learning-rule.invariants.test.ts && npm test`
Expected: PASS — no regression in retrieval ranking.

- [ ] **Step 6: Commit**

```bash
git add src/qa/learning/learning-rule.ts src/qa/learning/learning-rule.test.ts
git commit -m "fix(learn): deterministic retrieval ordering and safe exploration-floor splice"
```

---

### Task 4: Prevention score below promote rate (anti-Goodhart hardening)

`PREVENTION_HELD_SCORE = 0.6 == PROMOTE_RATE = 0.6` (`learning-rule.ts:107`, `48`): a rule that merely sits in retrieval during clean runs accrues 0.6 each time and converges to exactly the promote threshold, so it can reach `active` having prevented nothing measurable. Lowering it to `0.55` keeps such a rule ALIVE at the medium band but never promotes it to `active` without at least one stronger (oracle) outcome — high confidence already requires 0.7.

> Behavior change — confirm before merge: in oracle-OFF apps a candidate that only ever "holds" will now stay `candidate` indefinitely instead of reaching `active`. This is the intended anti-Goodhart tightening, but it is a product decision. (Judgment-day should weigh whether oracle-off apps must still be able to promote.)

**Files:**
- Modify: `src/qa/learning/learning-rule.ts:104-107` (constant + comment)
- Modify: `src/qa/learning/learning-rule.invariants.test.ts` (re-pin the invariant)
- Test: `src/qa/learning/learning-rule.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// append to src/qa/learning/learning-rule.test.ts
import { PREVENTION_HELD_SCORE, applyOutcome } from "./learning-rule";

test("prevention-only rule plateaus below the promote rate and never reaches active", () => {
  assert.equal(PREVENTION_HELD_SCORE < 0.6, true); // strictly below PROMOTE_RATE
  let r: LearningRule = {
    id: "p", trigger: "t", action: "a", errorClass: "E-FALSE-POSITIVE", confidence: "low",
    usageCount: 0, outcomeCount: 0, successRate: null, lastVerified: null, source: "t",
    status: "candidate", at: "2026-01-01T00:00:00.000Z",
  };
  for (let i = 0; i < 10; i++) r = applyOutcome(r, PREVENTION_HELD_SCORE);
  assert.equal(r.status, "candidate"); // prevention alone keeps it alive but unproven
  assert.equal(r.confidence, "medium");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/qa/learning/learning-rule.test.ts`
Expected: FAIL — with `0.6` the rule promotes to `active`.

- [ ] **Step 3: Implement the constant change**

In `src/qa/learning/learning-rule.ts`, change line 107 and its comment (104-106):

```typescript
// PREVENTION_HELD_SCORE sits just BELOW PROMOTE_RATE: a rule that consistently holds is kept alive
// at the medium band over many runs but is NEVER promoted to `active` on prevention alone — only a
// stronger oracle outcome can lift its running mean across the promote threshold. This closes the
// Goodhart hole where a rule that merely sat in retrieval during clean runs earned `active` status.
export const PREVENTION_HELD_SCORE = 0.55;
```

- [ ] **Step 4a: Update `learning-rule.test.ts` — the test that asserts prevention-only promotion to `active`**

In `src/qa/learning/learning-rule.test.ts`, the test at lines 61-68 currently asserts `r.status === "active"` after 5 prevention-held outcomes. With `PREVENTION_HELD_SCORE = 0.55`, the running mean after 5 outcomes equals `0.55` — below `PROMOTE_RATE (0.6)` — so the rule stays `candidate`. Update:

```typescript
// BEFORE (lines 61-68 approximately):
  it("a rule that consistently holds is promoted to active, but plateaus at medium", () => {
    let r = rule({ status: "candidate", errorClass: "E-FRAGILE-SELECTOR" });
    for (let i = 0; i < 5; i++) {
      const s = preventionOutcome(r.errorClass, null);
      if (s !== null) r = applyOutcome(r, s);
    }
    assert.equal(r.status, "active", "held across runs → promoted");
    assert.equal(r.confidence, "medium", "proxy-only promotion never reaches high");
  });

// AFTER: prevention-only keeps the rule alive at medium but never promotes it
  it("a rule that consistently holds stays candidate below the promote rate (anti-Goodhart)", () => {
    let r = rule({ status: "candidate", errorClass: "E-FRAGILE-SELECTOR" });
    for (let i = 0; i < 5; i++) {
      const s = preventionOutcome(r.errorClass, null);
      if (s !== null) r = applyOutcome(r, s);
    }
    // With PREVENTION_HELD_SCORE (0.55) < PROMOTE_RATE (0.6), the running mean plateaus at 0.55:
    // the rule is kept alive at "medium" but never earns "active" on prevention alone.
    assert.equal(r.status, "candidate", "prevention-only rule must not promote (held score is below promote rate)");
    assert.equal(r.confidence, "medium", "proxy-only rule caps at medium — never high");
  });
```

- [ ] **Step 4b: Update `learning-rule.invariants.test.ts` — re-pin BOTH affected invariants**

Two locations need updating in `src/qa/learning/learning-rule.invariants.test.ts`:

**Location 1** (line ≈52-55): the test currently asserts `held.status === "active"`. Replace it:

```typescript
// BEFORE (lines 51-55 approximately):
  it("PREVENTION_HELD_SCORE plateaus exactly at promote-to-active but caps at 'medium'", () => {
    const held = fold(seedRule(), Array(5).fill(PREVENTION_HELD_SCORE));
    assert.equal(held.status, "active", "consistent prevention earns promotion to active");
    assert.equal(held.confidence, "medium", "but never lifts past medium without the oracle");
  });

// AFTER: anti-Goodhart tightening — prevention-only stays candidate
  it("PREVENTION_HELD_SCORE (0.55) sits strictly below promote rate — prevention-only never reaches active", () => {
    const held = fold(seedRule(), Array(5).fill(PREVENTION_HELD_SCORE));
    // Running mean of all-0.55 outcomes is 0.55 < PROMOTE_RATE (0.6): rule survives (mean > DEMOTE_RATE)
    // but is never promoted.
    assert.equal(held.status, "candidate", "prevention-only rule must stay candidate (held score < promote rate)");
    assert.equal(held.confidence, "medium", "but never lifts past medium without the oracle");
  });
```

**Location 2** (line ≈47): the mixed-array literal `[0.6, 0, 0.6, 0.6, 0, 0.6, 0.6, 0.6, 0.6, 0.6]` hardcodes the old constant value `0.6`. Update the literal to use `PREVENTION_HELD_SCORE` so the test tracks the constant, not the stale number:

```typescript
// BEFORE (line ≈47):
    const mixed = fold(seedRule(), [0.6, 0, 0.6, 0.6, 0, 0.6, 0.6, 0.6, 0.6, 0.6]);

// AFTER:
    const mixed = fold(seedRule(), [PREVENTION_HELD_SCORE, 0, PREVENTION_HELD_SCORE, PREVENTION_HELD_SCORE, 0, PREVENTION_HELD_SCORE, PREVENTION_HELD_SCORE, PREVENTION_HELD_SCORE, PREVENTION_HELD_SCORE, PREVENTION_HELD_SCORE]);
```

Also update the neighbouring comment at line ≈41 if it states "running mean of any sequence drawn from {0, 0.6}" — change `0.6` to `PREVENTION_HELD_SCORE` to match the import.

- [ ] **Step 5: Run tests + full suite**

Run: `node --import tsx --test src/qa/learning/learning-rule.invariants.test.ts && npm test`
Expected: PASS — after the two test updates above, no remaining test asserts that prevention-only promotes to `active`. Verify by searching: `rg "status.*active" src/qa/learning/learning-rule*.test.ts` should not return any assertion that fires solely after prevention-score loops.

- [ ] **Step 6: Commit**

```bash
git add src/qa/learning/learning-rule.ts src/qa/learning/learning-rule.invariants.test.ts src/qa/learning/learning-rule.test.ts
git commit -m "fix(learn): keep prevention-only rules below the promote threshold"
```

---

### Task 5: Remove `memory-heal` dead code

`memory-heal` is a `Disposition` with a router case (`process-audit.ts:208-213`) and an optional `flagMemoryHeal` dep (line 172), but NO detector in `auditProcess` ever produces it. Dead code that lies about a capability the engine does not have. Remove it (YAGNI); re-add with a real detector if ever needed.

**Files:**
- Modify: `src/qa/learning/process-audit.ts`
- Modify: `src/qa/learning/process-audit.test.ts`
- Modify: `src/pipeline.ts` (remove the `flagMemoryHeal:` property passed to `applyAudit` at lines 516-517)

- [ ] **Step 1: Update the test first (drop the synthetic `memory-heal` fixture)**

In `src/qa/learning/process-audit.test.ts`, the test `"applyAudit ROUTES by disposition"` (line 80) currently builds a `{ kind: "corrupt-memory", disposition: "memory-heal" }` finding (line 85) and asserts `applied.memoryFlagged === 1` (line 104) and `memFlagged[0]!.kind === "corrupt-memory"` (line 105). Remove that finding from the `findings` array and all related assertions. Also remove the `const memFlagged: ProcessFinding[] = []` variable (line 91) and the `flagMemoryHeal: (f) => memFlagged.push(f)` dep (line 97) from the test's `AuditRouterDeps` object.

The updated test should look like:

```typescript
test("applyAudit ROUTES by disposition — DATA heals autonomously, only an engine-code defect becomes a PR", () => {
  const findings: ProcessFinding[] = [
    { kind: "noise-rule", disposition: "ledger-heal", severity: "warn", summary: "noise", evidence: "e", ruleIds: ["n1", "n2"] },
    { kind: "recurring-error-class", disposition: "engine-fix", severity: "error", summary: "defect", evidence: "e" },
    { kind: "recurring-ui-mismatch", disposition: "context-heal", severity: "warn", summary: "stale map", evidence: "e" },
    { kind: "review-churn-no-gain", disposition: "observe", severity: "warn", summary: "churn", evidence: "e" },
  ];
  const deprecated: string[] = [];
  const incidents: ProcessFinding[] = [];
  let contextReason = "";
  const deps: AuditRouterDeps = {
    log: () => {},
    deprecateRule: (id) => deprecated.push(id),
    recordEngineIncident: (f) => incidents.push(f),
    invalidateContext: (reason) => { contextReason = reason; return true; },
  };
  const applied = applyAudit(findings, deps);
  assert.deepEqual(deprecated, ["n1", "n2"]); // ledger noise self-healed (no PR)
  assert.equal(incidents.length, 1); // ONLY the engine-code defect became an incident → human-gated PR
  assert.equal(applied.contextInvalidated, 1); // stale map rebuilt autonomously (no PR)
  assert.match(contextReason, /stale map/);
  assert.equal(applied.observed, 1);
});
```

Also add a documentation test asserting the closed disposition set:

```typescript
test("Disposition closed set — memory-heal was removed (no detector ever produced it)", () => {
  // Documents the invariant: auditProcess can only emit these four dispositions.
  const validDispositions = ["engine-fix", "ledger-heal", "context-heal", "observe"];
  assert.equal(validDispositions.includes("memory-heal"), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/qa/learning/process-audit.test.ts`
Expected: FAIL — `memory-heal` is still in the `Disposition` union and `AuditRouterDeps` still has `flagMemoryHeal`.

- [ ] **Step 3: Remove the dead disposition from `process-audit.ts`**

In `src/qa/learning/process-audit.ts`:
- **Line 24**: change `export type Disposition = "engine-fix" | "ledger-heal" | "context-heal" | "memory-heal" | "observe";` to `export type Disposition = "engine-fix" | "ledger-heal" | "context-heal" | "observe";` (drop `"memory-heal"`).
- **Line 172**: delete `flagMemoryHeal?: (finding: ProcessFinding) => void;` from `AuditRouterDeps`.
- **Lines 179, 187**: drop `memoryFlagged` from `AppliedAudit` interface and from its initializer in `applyAudit`.
- **Lines 208-214**: delete the entire `case "memory-heal":` block from the `switch` in `applyAudit`.

- [ ] **Step 4: Remove `flagMemoryHeal` from the `pipeline.ts` `applyAudit` call**

In `src/pipeline.ts`, lines 516-517 pass `flagMemoryHeal` to `applyAudit`:

```typescript
// DELETE these two lines from the AuditRouterDeps object literal (lines 516-517):
        flagMemoryHeal: (f) =>
          recordIncident({ source: "process-audit", severity: "warn", summary: `engram memory may be corrupt: ${f.summary}`, detail: `${f.evidence} — engram is agent-owned; an agent-layer cleanup is required (the orchestrator does not write engram).` }),
```

After removal the `deps` object passed to `applyAudit` has only `log`, `deprecateRule`, `recordEngineIncident`, and `invalidateContext` — matching the narrowed `AuditRouterDeps`.

- [ ] **Step 5: Run tests + typecheck**

Run: `node --import tsx --test src/qa/learning/process-audit.test.ts && npm run typecheck`
Expected: PASS — the `switch` stays exhaustive over the narrowed union (`noUncheckedSwitchCases`/`noImplicitReturns` are satisfied by the remaining four cases); `rg "flagMemoryHeal|memoryFlagged|memory-heal" src/` returns nothing.

- [ ] **Step 6: Commit**

```bash
git add src/qa/learning/process-audit.ts src/qa/learning/process-audit.test.ts src/pipeline.ts
git commit -m "refactor(learn): remove memory-heal disposition (no detector, dead code)"
```

---

### Task 6: Dedup-window saturation visibility

`distiller.ts` dedups new rules against `listAllLearningRules(app, 200)`. Above 200 rules the oldest fall out of the window and duplicates slip in silently. Per the no-DB-coupling constraint we do NOT add a unique index; instead we make the loss VISIBLE (the request accepts loss, not silent loss) and name the cap.

**Files:**
- Modify: `src/qa/learning/distiller.ts`
- Test: `src/qa/learning/distiller.test.ts`

- [ ] **Step 1: Write the failing test**

> **Design constraint:** `distiller.ts` uses named ESM imports (`import { upsertLearningRule, listAllLearningRules } from "../../server/history"`). `t.mock.method` cannot intercept named imports and is not used anywhere in this repo. The test must be a REAL-DB integration test following the repo's established pattern (see the existing `distillReviewerCorrections` tests in `distiller.test.ts` which use `Date.now() + Math.random()` suffixed app names and seed via `upsertLearningRule`).

Append to `src/qa/learning/distiller.test.ts`:

```typescript
describe("distillReviewerCorrections — dedup-window saturation logging", () => {
  it("logs a warning when the dedup window is at capacity (real-DB integration)", () => {
    // Seed exactly DEDUP_WINDOW (200) rules for a fresh app. The 201st distillation call
    // must emit the saturation warning via the optional log parameter.
    const app = `dedup-sat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Seed 200 distinct rules into the DB for this app.
    for (let i = 0; i < 200; i++) {
      upsertLearningRule({
        id: `sat-rule-${i}`,
        app,
        trigger: `Applies when scenario ${i} arises`,
        action: `check condition ${i}`,
        errorClass: "E-FALSE-POSITIVE",
        source: "seed",
      });
    }

    const logs: string[] = [];
    // This correction is DISTINCT from all 200 seeded rules, so listAllLearningRules returns 200
    // before any insert. The saturation check must fire before the dedup comparison.
    distillReviewerCorrections({
      app,
      runId: "run-sat-1",
      corrections: ["[false-positive] asserts nothing meaningful"],
      log: (l: string) => logs.push(l),
    });

    assert.ok(
      logs.some((l) => /dedup window saturated/i.test(l)),
      `expected a saturation warning; got: ${JSON.stringify(logs)}`,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/qa/learning/distiller.test.ts`
Expected: FAIL — `distillReviewerCorrections` does not accept `log`, and no saturation warning is emitted.

- [ ] **Step 3: Implement the visibility log in `distiller.ts`**

Add an optional `log` parameter to `distillReviewerCorrections` and introduce the `DEDUP_WINDOW` named constant:

In `src/qa/learning/distiller.ts`, change the `distillReviewerCorrections` input interface and the `listAllLearningRules` call site:

```typescript
// Change the function signature (add optional log):
export function distillReviewerCorrections(input: {
  app: string;
  runId: string;
  corrections: string[];
  archetype?: string | null;
  log?: (line: string) => void;  // ADD this optional field
}): { inserted: string[] } {
```

At the `listAllLearningRules` call site in `distillReviewerCorrections` (≈ line 132 in the current file), introduce the named cap constant and add the saturation check:

```typescript
  const DEDUP_WINDOW = 200; // newest-N dedup window; above this, older duplicates may slip (accepted, but visible)
  const existing = listAllLearningRules(input.app, DEDUP_WINDOW);
  if (existing.length >= DEDUP_WINDOW) {
    input.log?.(`[learn] WARNING: dedup window saturated at ${DEDUP_WINDOW} rules for ${input.app} — duplicate candidates beyond the window may not be detected`);
  }
  const { toInsert } = deduplicateRules([...unique.values()], existing);
```

Apply the same `DEDUP_WINDOW` constant + saturation check at the `listAllLearningRules(input.app, 200)` call site inside `distillReflection` (≈ line 73). `distillReflection` does not need a `log` parameter — it can use `console.warn` for the saturation warning since it has no caller-supplied log:

```typescript
  const DEDUP_WINDOW = 200;
  const existing = listAllLearningRules(input.app, DEDUP_WINDOW);
  if (existing.length >= DEDUP_WINDOW) {
    console.warn(`[learn] WARNING: dedup window saturated at ${DEDUP_WINDOW} rules for ${input.app}`);
  }
```

Extract `DEDUP_WINDOW` to a module-level constant (one declaration) if both call sites share it.

- [ ] **Step 4: Wire `log` into the production `distillCorrections` call**

Adding `log?` to `distillReviewerCorrections` is invisible in production unless forwarded. In `src/pipeline.ts`:

Update the `distillCorrections` dep at line 527 to forward the pipeline's `log`:

```typescript
// BEFORE (line 527):
    distillCorrections: (input) => distillReviewerCorrections(input),

// AFTER: forward the caller-supplied log so saturation warnings appear in run output
    distillCorrections: (input) => distillReviewerCorrections({ ...input, log: console.log }),
```

> Note: the `PipelineDeps.distillCorrections` type signature accepts `input` without a `log` field today. The implementation spreads it and adds `log`; this is transparent to callers. Alternatively, if `PipelineDeps.distillCorrections` is typed as `(input: Parameters<typeof distillReviewerCorrections>[0]) => ...`, it will need the type updated to match the new optional `log` field — verify the exact type before implementing.

- [ ] **Step 5: Run tests + typecheck**

Run: `node --import tsx --test src/qa/learning/distiller.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/qa/learning/distiller.ts src/qa/learning/distiller.test.ts src/pipeline.ts
git commit -m "fix(learn): surface dedup-window saturation instead of silent duplicate loss"
```

---

### Task 7: Context-directed oracle attribution (higher-risk — gated)

The oracle path (`pipeline.ts:704-714`) folds the SAME `valueScore` onto EVERY retrieved rule, regardless of relevance — attribution noise. This task adds a pure, deterministic filter so the oracle outcome only folds onto rules whose `archetype` matches the current diff's shapes (the signal already computed as `diffArchetypes`). Rules that didn't match are left untouched (neither promoted nor demoted), exactly as `preventionOutcome` already does with `null`.

> Higher risk: this REDUCES the number of folded outcomes, slowing promotion for archetype-untagged rules. It trades learning speed for signal cleanliness. Keep behind the existing oracle path (only fires when `valueScore !== null`, i.e. oracle-enabled apps). If judgment-day deems it premature, defer it — the other six tasks stand alone.

**Files:**
- Modify: `src/qa/learning/learning-rule.ts` (add pure `attributableRules`)
- Modify: `src/pipeline.ts:704-714` (filter before folding; thread `retrievedRules` + `diffArchetypes`)
- Test: `src/qa/learning/learning-rule.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// append to src/qa/learning/learning-rule.test.ts
import { attributableRules } from "./learning-rule";

test("attributableRules keeps rules whose archetype matches the diff shapes", () => {
  const mk = (id: string, archetype: string | null): LearningRule => ({
    id, trigger: "t", action: "a", errorClass: "E-FALSE-POSITIVE", archetype,
    confidence: "medium", usageCount: 0, outcomeCount: 3, successRate: 0.6,
    lastVerified: null, source: "t", status: "active", at: "2026-01-01T00:00:00.000Z",
  });
  const rules = [mk("form", "form"), mk("api", "api-call"), mk("untagged", null)];
  const kept = attributableRules(rules, { diffArchetypes: ["form"] });
  assert.deepEqual(kept.map((r) => r.id), ["form"]);
});

test("attributableRules keeps everything when no diff archetypes are known (fail-open)", () => {
  const mk = (id: string): LearningRule => ({
    id, trigger: "t", action: "a", errorClass: "E-FALSE-POSITIVE", archetype: "form",
    confidence: "medium", usageCount: 0, outcomeCount: 3, successRate: 0.6,
    lastVerified: null, source: "t", status: "active", at: "2026-01-01T00:00:00.000Z",
  });
  const rules = [mk("a"), mk("b")];
  assert.deepEqual(attributableRules(rules, { diffArchetypes: [] }).map((r) => r.id), ["a", "b"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/qa/learning/learning-rule.test.ts`
Expected: FAIL — `attributableRules` not exported.

- [ ] **Step 3: Implement the pure filter**

Add to `src/qa/learning/learning-rule.ts`:

```typescript
// Context-directed attribution: fold an oracle outcome only onto rules whose structural shape
// matches the current diff, so a global suite-quality score is not smeared across rules that
// could not have influenced it. Fail-open: with no known diff archetypes, keep every rule
// (no signal to discriminate on → preserve the prior uniform behavior). Pure and deterministic.
export function attributableRules(rules: LearningRule[], ctx: { diffArchetypes: string[] }): LearningRule[] {
  if (ctx.diffArchetypes.length === 0) return rules;
  const shapes = new Set(ctx.diffArchetypes);
  return rules.filter((r) => r.archetype != null && shapes.has(r.archetype));
}
```

- [ ] **Step 4a: Extend `ValueLearningInput` with `retrievedRules`**

The attribution loop at `pipeline.ts:704-714` is inside `foldValueLearning` (defined at line 622). `foldValueLearning` receives its inputs via `ValueLearningInput` (lines 594-614). Currently `ValueLearningInput` carries `retrievedRuleIds: string[]` (line 608) but NOT `retrievedRules: LearningRule[]` — so `attributableRules(retrievedRules, …)` cannot compile.

Add the field to the interface (after line 608):

```typescript
// In ValueLearningInput (src/pipeline.ts:594-614), add after retrievedRuleIds:
  retrievedRules: LearningRule[];
```

Import `LearningRule` at the top of `pipeline.ts` alongside the other learning imports (or as a type-only import):

```typescript
import type { LearningRule } from "./qa/learning/learning-rule";
```

- [ ] **Step 4b: Pass `retrievedRules` at the `foldValueLearning` call-site**

The call at `pipeline.ts:2288-2293` currently passes `retrievedRuleIds` but not `retrievedRules`. Add it:

```typescript
// BEFORE (pipeline.ts:2288-2293):
  const valueLearned = await foldValueLearning({
    deps, app, run, isCode, generating, mode, mirrorDir, e2eDir, ns, diff, sha,
    runId: opts.runId, signal, retrievedRuleIds, curriculum,
    changedFiles: intent?.changedFiles ?? [],
    ccForPersistence, specMetas: result?.specMetas, log,
  });

// AFTER: add retrievedRules (already in scope — set at pipeline.ts:1561)
  const valueLearned = await foldValueLearning({
    deps, app, run, isCode, generating, mode, mirrorDir, e2eDir, ns, diff, sha,
    runId: opts.runId, signal, retrievedRuleIds, retrievedRules, curriculum,
    changedFiles: intent?.changedFiles ?? [],
    ccForPersistence, specMetas: result?.specMetas, log,
  });
```

`retrievedRules` is already declared and populated in scope at `pipeline.ts:1561`.

- [ ] **Step 4c: Thread the filter into the oracle attribution path**

In `foldValueLearning`, the value-fold step at lines 704-714 currently iterates `retrievedRuleIds`. Update it to iterate the attributable subset of `retrievedRules` (which carries `archetype`), using `diffArchetypes` from the run's diff. Also destructure `retrievedRules` from `input` in the function body (it is now in scope via the extended interface):

```typescript
  // Update the destructure at line 625 to include retrievedRules:
  const { deps, app, run, isCode, generating, mode, mirrorDir, e2eDir, ns, diff, sha, runId, signal, retrievedRuleIds, retrievedRules, changedFiles, ccForPersistence, specMetas, log } = input;
```

Replace the attribution block (`pipeline.ts:704-714`):

```typescript
  if (retrievedRules.length > 0 && valueScore !== null) {
    const coverageMeasured = ccForPersistence?.measured ?? false;
    const coverageCreditConfirmed = coverageMeasured ? ccForPersistence!.overall.ratio > 0 : null;
    const diffArchetypes = detectStructuralPatterns(diff, changedFiles).map((p) => p.kind);
    const targets = attributableRules(retrievedRules, { diffArchetypes });
    const { recordRuleOutcome } = await import("./server/history");
    bestEffort("attribution", log, () => {
      for (const r of targets) recordRuleOutcome(r.id, valueScore, coverageCreditConfirmed);
      log(`[qa] attribution: recorded outcome (valueScore=${(valueScore * 100).toFixed(0)}%, coverageCredit=${coverageCreditConfirmed ?? "unmeasured"}) for ${targets.length}/${retrievedRules.length} attributable rule(s)`);
    }, undefined);
  }
```

> Note: `retrievedRuleIds` can remain in `ValueLearningInput` (it is used elsewhere in `foldValueLearning`) — do NOT remove it.

- [ ] **Step 5: Run tests + full suite**

Run: `node --import tsx --test src/qa/learning/learning-rule.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/qa/learning/learning-rule.ts src/qa/learning/learning-rule.test.ts src/pipeline.ts
git commit -m "feat(learn): context-directed oracle attribution to cut credit-assignment noise"
```

---

## Self-Review

**Spec coverage:**
- Fault isolation / "doesn't break the rest" → Task 1 (`bestEffort` at every engine call-site; `void bestEffortAsync` preserves fire-and-forget for reflection).
- Phantom `usageCount` + attribution (#1) → Task 2 (budget-fit in selection; `MAX_LEARNED_RULES_CHARS` const+block removed from pipeline.ts).
- Determinism (#A) → Task 3 (tie-break + safe splice; `EXPLORATION_SLOTS` const stays in place at line 223).
- Prevention 0.6 == promote (#3) → Task 4 (two test files updated: `learning-rule.test.ts` and `learning-rule.invariants.test.ts`; hardcoded `0.6` literal in mixed-array replaced with `PREVENTION_HELD_SCORE`).
- `memory-heal` dead code (#6) → Task 5 (`process-audit.ts`, `process-audit.test.ts`, AND `pipeline.ts:516-517` `flagMemoryHeal` property).
- Dedup-window silent loss (#5) → Task 6 (real-DB integration test; `log?` wired through `pipeline.ts` distillCorrections call).
- Uniform attribution (#2) → Task 7 (gated; requires `ValueLearningInput` extension with `retrievedRules: LearningRule[]`, `LearningRule` import, and call-site update at line ≈2288).
- Reflection fire-and-forget (#4) → deliberately NOT changed for durability; Task 1 replaces the `.catch` guard with `void bestEffortAsync(…)` to guarantee it cannot throw, while keeping it unblocking.
- `coverageCreditConfirmed = ratio > 0` → deliberately NOT changed: documented design decision (FIX 1b), not a bug.
- `labeler` `valueScore: null` → deliberately NOT changed: re-injected at pipeline.ts:1779; a comment may be added but no behavior change.

**No-DB-coupling check:** No new table, column, index or query. `fitRulesToBudget`, `attributableRules`, the determinism fix and the constant change are pure. `bestEffort` is in-memory. The dedup change only adds a log. PASS.

**Determinism check:** Task 3 removes the only non-deterministic ordering; Tasks 2/4/7 are pure functions of their inputs. PASS.

**Type consistency:** `fitRulesToBudget` returns `{ included, rendered }` (used identically in Task 2). `attributableRules(rules, { diffArchetypes })` signature matches Task 7's call-site. `Disposition` narrows consistently in Task 5 (exhaustive switch over the remaining four cases). `ValueLearningInput` now carries `retrievedRules: LearningRule[]` alongside the retained `retrievedRuleIds: string[]`. PASS.

**noUnusedLocals check:** Removing the `MAX_LEARNED_RULES_CHARS` const+block together (not just the `if`) is required — leaving the `const` declaration without use would fail the strict typecheck. PASS (confirmed in Task 2 Step 7).

## Risks & open decisions for judgment-day
1. Task 4 changes promotion behavior for oracle-off apps — confirm this is desired vs. keeping the flywheel turning everywhere.
2. Task 7 reduces folded outcomes — confirm the learning-speed trade-off, or defer.
3. Task 1's call-site rewrite touches `pipeline.ts` broadly — the diff must be reviewed for any side-effect whose fallback value changes control flow (e.g. retrieval returning `null` must leave `learnedRules` unset, not crash downstream).
