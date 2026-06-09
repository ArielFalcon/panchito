# F4 — Reviewer corrections → learning rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reviewer rejections stop being run-local: each correction is distilled into a candidate `LearningRule` (deduped, off-path, never blocking) so future runs retrieve it via the existing `retrieveRules` → `learnedRules` prompt injection.

**Architecture:** A new `distillReviewerCorrections()` in `src/qa/learning/distiller.ts` maps each correction string to a `RuleUpsert` (errorClass via the existing `errorClassFromCorrections`, falling back to a new `E-REVIEWER-REJECTED` class), dedupes against ALL rule statuses, and upserts. The pipeline calls it off-path after the final decision through an injected dep. Rules then flow through the existing governance (candidate → active via measured outcomes, src/qa/learning/learning-rule.ts:28–35). Spec §8. Independent of F1–F3.

**Tech Stack:** TypeScript strict, `node:test`, better-sqlite3 behind `server/history`.

---

### Task 1: `E-REVIEWER-REJECTED` in the taxonomy

**Files:**
- Modify: `src/qa/learning/taxonomy.ts` (lines 12–23)
- Test: extend `src/qa/learning/taxonomy.test.ts` (the file exists; if not, create it following the colocated pattern)

- [ ] **Step 1: Write the failing test**

```ts
test("E-REVIEWER-REJECTED is a valid ErrorClass", () => {
  assert.ok((ERROR_CLASSES as readonly string[]).includes("E-REVIEWER-REJECTED"));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test src/qa/learning/taxonomy.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `ERROR_CLASSES` (src/qa/learning/taxonomy.ts:12), add `"E-REVIEWER-REJECTED",` after `"E-NO-CLEANUP",` with the comment block updated:

```ts
//   - reviewer rejection with no recognizable anti-pattern → E-REVIEWER-REJECTED
```

- [ ] **Step 4: Run the test** — Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run typecheck && npm test
git add src/qa/learning/taxonomy.ts src/qa/learning/taxonomy.test.ts
git commit -m "feat(learning): E-REVIEWER-REJECTED error class (fallback for unmatched corrections)"
```

---

### Task 2: `distillReviewerCorrections`

**Files:**
- Modify: `src/qa/learning/distiller.ts`
- Test: extend `src/qa/learning/distiller.test.ts` (exists; follow its setup — it points `HISTORY_DB_PATH` at a temp file)

- [ ] **Step 1: Write the failing tests**

```ts
test("correctionToRuleUpsert classifies via the anti-pattern catalog and falls back to E-REVIEWER-REJECTED", () => {
  const fragile = correctionToRuleUpsert({ correction: "uses a fragile selector on the cart row", runId: "run-1" });
  assert.equal(fragile?.errorClass, "E-FRAGILE-SELECTOR");
  assert.equal(fragile?.action, "uses a fragile selector on the cart row");
  const generic = correctionToRuleUpsert({ correction: "the spec misnames the flow", runId: "run-1" });
  assert.equal(generic?.errorClass, "E-REVIEWER-REJECTED");
  assert.equal(correctionToRuleUpsert({ correction: "   ", runId: "run-1" }), null);
});

test("distillReviewerCorrections inserts one deduped candidate per distinct correction", () => {
  const first = distillReviewerCorrections({
    app: "shop-f4-test",
    runId: "run-aaaa1111",
    corrections: ["no real assertion on the outcome", "no real assertion on the outcome", "orphaned test data left behind"],
  });
  assert.equal(first.inserted.length, 2);
  // Re-distilling the same corrections must insert nothing (dedup against ALL statuses).
  const second = distillReviewerCorrections({
    app: "shop-f4-test",
    runId: "run-bbbb2222",
    corrections: ["no real assertion on the outcome"],
  });
  assert.equal(second.inserted.length, 0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test src/qa/learning/distiller.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement**

In `src/qa/learning/distiller.ts` (add `errorClassFromCorrections` to the imports from `./taxonomy`):

```ts
import { errorClassFromCorrections } from "./taxonomy";

// A reviewer correction distilled into a candidate rule: the correction text IS the
// action (what to check before finishing), classified by the anti-pattern catalog.
export function correctionToRuleUpsert(input: { correction: string; runId: string }): RuleUpsert | null {
  const text = input.correction.trim().slice(0, RULE_FIELD_MAX);
  if (!text) return null;
  const errorClass = errorClassFromCorrections([text]) ?? "E-REVIEWER-REJECTED";
  return {
    trigger: `generating specs prone to ${errorClass}`,
    action: text,
    errorClass,
    source: input.runId,
  };
}

// Off-path distillation of a rejection: every correction becomes a candidate rule,
// deduped against ALL statuses (a pattern already tried and demoted must not respawn).
// Same governance as oracle-born rules: candidates must EARN promotion via outcomes.
export function distillReviewerCorrections(input: {
  app: string;
  runId: string;
  corrections: string[];
}): { inserted: string[] } {
  const candidates = input.corrections
    .map((c) => correctionToRuleUpsert({ correction: c, runId: input.runId }))
    .filter((c): c is RuleUpsert => c !== null);
  if (candidates.length === 0) return { inserted: [] };

  const existing = listAllLearningRules(input.app, 200);
  const { toInsert } = deduplicateRules(candidates, existing);

  const inserted: string[] = [];
  for (const c of toInsert) {
    const ruleId = `rule-${input.runId.slice(-8)}-${randomBytes(3).toString("hex")}`;
    upsertLearningRule({ ...c, app: input.app, id: ruleId });
    inserted.push(ruleId);
  }
  return { inserted };
}
```

Note: `deduplicateRules` must also dedupe candidates against EACH OTHER within one call (the duplicated correction in the test). Check `src/qa/learning/learning-rule.ts:78` — if it only dedupes against `existing`, pre-dedupe locally:

```ts
  const unique = new Map(candidates.map((c) => [ruleKey(c), c]));
  const { toInsert } = deduplicateRules([...unique.values()], existing);
```

(`ruleKey` is already imported in this file.)

- [ ] **Step 4: Run the tests** — Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run typecheck && npm test
git add src/qa/learning/distiller.ts src/qa/learning/distiller.test.ts
git commit -m "feat(learning): distill reviewer corrections into candidate rules"
```

---

### Task 3: pipeline wiring (off-path, injected)

**Files:**
- Modify: `src/pipeline.ts` (`PipelineDeps` lines 80–127, `defaultPipelineDeps()`, end of `runPipeline` near line 1011)
- Test: extend `src/pipeline.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test("reviewer rejection distills corrections into rules (off-path)", async () => {
  let distilled: { app: string; corrections: string[] } | undefined;
  const deps = makeDeps({
    generate: async () => ({ output: "", specs: ["flows/a.spec.ts"], reviewed: true, approved: true }),
    review: async () => ({ approved: false, corrections: ["no real assertion on the outcome"] }),
    distillCorrections: (input: { app: string; runId: string; corrections: string[] }) => {
      distilled = input;
      return { inserted: ["rule-1"] };
    },
  });
  const app = makeApp({ qa: { needsReview: true, testDataPrefix: "qa", shadow: true } });
  await runPipeline(app, "a1b2c3d", deps, "webhook", { mode: "diff", runId: "r1" });
  assert.equal(distilled?.app, "shop");
  assert.deepEqual(distilled?.corrections, ["no real assertion on the outcome", "no real assertion on the outcome"]);
});

test("a distiller crash never fails the run", async () => {
  const deps = makeDeps({
    generate: async () => ({ output: "", specs: ["flows/a.spec.ts"], reviewed: true, approved: true }),
    review: async () => ({ approved: false, corrections: ["x"] }),
    distillCorrections: () => { throw new Error("db locked"); },
  });
  const app = makeApp({ qa: { needsReview: true, testDataPrefix: "qa", shadow: true } });
  const r = await runPipeline(app, "a1b2c3d", deps, "webhook", { mode: "diff", runId: "r1" });
  assert.notEqual(r.verdict, "infra-error");
});
```

(Note on the first test: with `MAX_REVIEW_ROUNDS = 2` and a reviewer that always rejects, the same correction accumulates twice in `reviewerCorrections` — once per round. The assertion reflects that real behavior; `distillReviewerCorrections` dedupes downstream.)

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test src/pipeline.test.ts`
Expected: FAIL — `distillCorrections` is not a known dep.

- [ ] **Step 3: Implement**

1. `PipelineDeps` — add after `reflectAndDistill`:

```ts
  // Reviewer→learning: distill this run's reviewer corrections into candidate rules.
  // Off-path: a failure is a warning, never a verdict change. Absent ⇒ skipped.
  distillCorrections?(input: { app: string; runId: string; corrections: string[] }): { inserted: string[] };
```

2. `defaultPipelineDeps()` — wire it (the static import of `distillReflection` at line 27 already pulls in the distiller module; extend that import):

```ts
import { distillReflection, distillReviewerCorrections } from "./qa/learning/distiller";
```

```ts
    distillCorrections: (input) => distillReviewerCorrections(input),
```

3. In `runPipeline`, right before the `persistOutcome(run, ...)` call at line 1011, add:

```ts
  // Reviewer→learning: rejections persist as candidate rules so the next run is
  // born knowing what this reviewer already rejected. Off-path, never blocks.
  if (reviewerCorrections.length > 0 && opts.runId && deps.distillCorrections) {
    try {
      const distilled = deps.distillCorrections({ app: app.name, runId: opts.runId, corrections: reviewerCorrections });
      if (distilled.inserted.length > 0) {
        log(`[qa] learning: distilled ${distilled.inserted.length} candidate rule(s) from reviewer corrections`);
      }
    } catch (err) {
      log(`[qa] WARNING: reviewer-corrections distillation failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
```

- [ ] **Step 4: Run the tests** — Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run typecheck && npm test
git add src/pipeline.ts src/pipeline.test.ts
git commit -m "feat(learning): pipeline distills reviewer rejections into rules (off-path)"
```

---

### Task 4: docs

**Files:**
- Modify: `docs/learning-layer.md` (the rules-lifecycle section)

- [ ] **Step 1: Document the new source**

Add to the rules-lifecycle section:

```markdown
### Reviewer rejections as a rule source

When the independent reviewer rejects a generation, each correction is distilled into a
candidate `LearningRule` (`distillReviewerCorrections`): the correction text is the rule's
action, classified by the anti-pattern catalog (`errorClassFromCorrections`) with
`E-REVIEWER-REJECTED` as fallback. Candidates follow the SAME governance as oracle-born
rules — they must earn promotion through measured outcomes and are deduped against all
statuses, so a rejected-and-demoted pattern cannot respawn. Off-path: a distillation
failure logs a warning and never affects the verdict.
```

- [ ] **Step 2: Full gate + commit**

```bash
npm run typecheck && npm test
git add docs/learning-layer.md
git commit -m "docs(learning): reviewer rejections as a rule source"
```

---

### F4 exit criteria

- `npm test` + `npm run typecheck` green.
- A run with a reviewer rejection leaves candidate rules in SQLite (`listLearningRules`) that the NEXT run's `retrieveRules` injects into the generator prompt.
- Distiller failures are warnings only; verdicts never change.
