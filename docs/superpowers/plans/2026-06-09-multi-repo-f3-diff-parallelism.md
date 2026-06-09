# F3 — Diff-mode parallel generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With `qa.parallelDiff: true`, a diff run plans the commit's blast radius into objectives and fans out to parallel `qa-worker`s (reusing `runOpencodeParallel`); with < 2 objectives it falls back to the single-agent path.

**Architecture:** A new exported pure function `shouldFanOut()` centralizes the routing decision (today inlined at src/pipeline.ts:166–170); `buildPlanPrompt` gets a diff-scoped variant (plan ONLY the commit's blast radius, diff included); `runOpencodeParallel` falls back to `runOpencode` when a diff plan yields fewer than 2 objectives. Re-generation passes (fixCases / reviewCorrections / coverageGap) always stay single-agent. Spec §7. **Depends on F1** (the `service` field exists on `OpencodeRunInput`; cross-repo diff runs may also fan out — the planner receives the service section).

**Tech Stack:** TypeScript strict, `node:test`, Zod v4.

---

### Task 1: `qa.parallelDiff` in the schema

**Files:**
- Modify: `src/orchestrator/schemas.ts` (the `qa` object, lines 23–39)
- Test: extend `src/orchestrator/schemas.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("qa.parallelDiff parses and defaults to undefined", () => {
  const on = AppConfigSchema.parse({ ...base, qa: { ...base.qa, parallelDiff: true } });
  assert.equal(on.qa.parallelDiff, true);
  const off = AppConfigSchema.parse(base);
  assert.equal(off.qa.parallelDiff, undefined);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test src/orchestrator/schemas.test.ts`
Expected: FAIL (`parallelDiff` stripped → `undefined !== true`).

- [ ] **Step 3: Implement**

In the `qa` object of `AppConfigSchema`, after `shadow`:

```ts
      // Diff-mode fan-out: when true, a diff run plans the blast radius into objectives
      // and dispatches parallel qa-workers (>=2 objectives; single-agent otherwise).
      // Default off: protects cost/determinism for simple apps.
      parallelDiff: z.boolean().optional(),
```

- [ ] **Step 4: Run the test** — Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run typecheck && npm test
git add src/orchestrator/schemas.ts src/orchestrator/schemas.test.ts
git commit -m "feat(config): qa.parallelDiff opt-in flag"
```

---

### Task 2: `shouldFanOut` — one pure routing decision

**Files:**
- Modify: `src/integrations/opencode-client.ts` (new export, place right above `runOpencodeParallel` line 614)
- Modify: `src/pipeline.ts` (`GenerateInput` lines 58–78, `defaultPipelineDeps().generate` lines 139–174, `baseGenInput` line 581)
- Test: extend `src/integrations/opencode-client.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test("shouldFanOut: complete/exhaustive e2e fan out; diff only with parallelDiff", () => {
  const base = { target: "e2e" as const, mode: "complete" as const };
  assert.equal(shouldFanOut(base), true);
  assert.equal(shouldFanOut({ ...base, mode: "exhaustive" }), true);
  assert.equal(shouldFanOut({ ...base, mode: "diff" }), false);
  assert.equal(shouldFanOut({ ...base, mode: "diff", parallelDiff: true }), true);
});

test("shouldFanOut: never for code target, re-generation passes, or context mode", () => {
  assert.equal(shouldFanOut({ target: "code", mode: "complete" }), false);
  assert.equal(shouldFanOut({ target: "e2e", mode: "diff", parallelDiff: true, fixCases: [{ name: "t", status: "fail" }] }), false);
  assert.equal(shouldFanOut({ target: "e2e", mode: "diff", parallelDiff: true, reviewCorrections: ["fix x"] }), false);
  assert.equal(shouldFanOut({ target: "e2e", mode: "diff", parallelDiff: true, coverageGap: "lines 1-3" }), false);
  assert.equal(shouldFanOut({ target: "e2e", mode: "context" }), false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test src/integrations/opencode-client.test.ts`
Expected: FAIL — `shouldFanOut` not exported.

- [ ] **Step 3: Implement**

In `src/integrations/opencode-client.ts`:

```ts
// The single routing decision between the single-agent path (runOpencode) and the
// plan→workers fan-out (runOpencodeParallel). Re-generation passes (fix/review/coverage)
// are always single-agent: they carry feedback context the worker prompts cannot hold.
export function shouldFanOut(input: {
  target?: TestTarget;
  mode: RunMode;
  parallelDiff?: boolean;
  fixCases?: QaCase[];
  reviewCorrections?: string[];
  coverageGap?: string;
}): boolean {
  if ((input.target ?? "e2e") !== "e2e") return false;
  if (input.fixCases?.length || input.reviewCorrections?.length || input.coverageGap) return false;
  if (input.mode === "complete" || input.mode === "exhaustive") return true;
  return input.mode === "diff" && input.parallelDiff === true;
}
```

In `src/pipeline.ts`:
1. `GenerateInput` — add `parallelDiff?: boolean; // qa.parallelDiff: diff-mode fan-out opt-in`.
2. `baseGenInput` — add `parallelDiff: app.qa.parallelDiff,`.
3. `defaultPipelineDeps().generate` — add `parallelDiff: input.parallelDiff,` to `ocInput`, import `shouldFanOut`, and replace the inline `useParallel` expression (lines 166–170) with:

```ts
      const useParallel = shouldFanOut(input);
      return useParallel
        ? runOpencodeParallel(ocInput, oc, { signal, onProgress })
        : runOpencode(ocInput, oc, { signal, onProgress });
```

4. `OpencodeRunInput` — add `parallelDiff?: boolean;` (used by `agentTimeout`? No — only carried for symmetry; the fan-out decision happens in the pipeline. If nothing inside opencode-client reads it, do NOT add it to `OpencodeRunInput` — keep the field only on `GenerateInput` and drop it before building `ocInput`.) **Decision: keep it OFF `OpencodeRunInput`; `shouldFanOut` is called with the `GenerateInput` in the pipeline.** Adjust step 3 accordingly: do not add `parallelDiff` to `ocInput`.

- [ ] **Step 4: Run the tests** — Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run typecheck && npm test
git add src/integrations/opencode-client.ts src/integrations/opencode-client.test.ts src/pipeline.ts
git commit -m "feat(parallel): shouldFanOut routing — diff mode fans out behind qa.parallelDiff"
```

---

### Task 3: diff-scoped planning prompt

**Files:**
- Modify: `src/integrations/opencode-client.ts` (`buildPlanPrompt` lines 707–734)
- Test: extend `src/integrations/opencode-client.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
const diffPlanInput = {
  repo: "org/shop-front", sha: "a1b2c3d", diff: "diff --git a/cart.ts b/cart.ts\n+ bulkDiscount()",
  mirrorDir: "/m/front", e2eRelDir: "e2e", namespace: "qa-1", needsReview: false,
  target: "e2e" as const, mode: "diff" as const, appName: "shop",
  intent: { type: "feat", action: "generate" as const, reason: "", contradiction: false, breaking: false, message: "feat: bulk discount", changedFiles: ["cart.ts"] },
};

test("buildPlanPrompt in diff mode plans ONLY the commit blast radius and includes the diff", () => {
  const text = buildPlanPrompt(diffPlanInput);
  assert.match(text, /blast radius of commit a1b2c3d/i);
  assert.match(text, /bulkDiscount/);
  assert.match(text, /feat: bulk discount/);
  assert.doesNotMatch(text, /WHOLE repository/);
  assert.match(text, /"objectives"/);
});

test("buildPlanPrompt complete/exhaustive variants are unchanged", () => {
  const text = buildPlanPrompt({ ...diffPlanInput, mode: "complete" });
  assert.match(text, /WHOLE repository/);
  assert.doesNotMatch(text, /blast radius of commit/i);
});
```

(If the exact `CommitIntent` shape differs, import it from `src/qa/commit-classify` and satisfy it — the fields above mirror `classifyCommit`'s return.)

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test src/integrations/opencode-client.test.ts`
Expected: FAIL — the diff variant does not exist.

- [ ] **Step 3: Implement**

In `buildPlanPrompt`, branch on diff mode first:

```ts
export function buildPlanPrompt(input: OpencodeRunInput): string {
  if (input.mode === "diff") {
    return [
      `Plan E2E test objectives for the blast radius of commit ${input.sha} of ${input.repo}.`,
      ``,
      `## Phase 1 of 2 — PLANNING ONLY. Do NOT write any .spec.ts in this phase.`,
      `1. Activate serena (activate_project). Read the commit intent and diff below; derive the`,
      `   affected user flows (use find_referencing_symbols to widen from the changed symbols).`,
      `2. Plan one objective per INDEPENDENT affected flow. Do NOT plan flows the commit does not`,
      `   touch; if everything fits one flow, return a single objective.`,
      `   Each objective is a concrete acceptance criterion in given/when/then form, with the code`,
      `   symbols it exercises. Set "needsUi": true when the flow involves page navigation or DOM`,
      `   interaction, and "needsUi": false for pure logic.`,
      ``,
      `## Change intent (Conventional Commits)`,
      `- Type: ${input.intent?.type ?? "unknown"}${input.intent?.breaking ? " (BREAKING)" : ""}`,
      `- Message: ${sanitizeText(input.intent?.message ?? "").text}`,
      `- Changed files: ${input.intent?.changedFiles.join(", ") || "(unknown)"}`,
      ``,
      `## Commit diff`,
      "```diff",
      sanitizeText(input.diff).text,
      "```",
      ...(input.service
        ? [
            ``,
            `## Cross-repo change (microservice)`,
            `The commit belongs to the microservice ${input.service.repo} (read-only working copy at`,
            `${input.service.mirrorDir}). Plan objectives for the FRONTEND flows that exercise the`,
            `changed service behavior through the UI.`,
          ]
        : []),
      ``,
      `## Output — end with ONLY this JSON (no spec files):`,
      `{"objectives":[{"flow":"checkout","objective":"given a cart with >10 items, when paying, then the bulk discount is applied and the order is created","symbols":["CheckoutService.pay"],"needsUi":true}]}`,
      `If the commit's change is not testable through a user flow, output {"objectives":[]}.`,
    ].join("\n");
  }
  const exhaustive = input.mode === "exhaustive";
  // ... existing complete/exhaustive body, unchanged ...
}
```

- [ ] **Step 4: Run the tests** — Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run typecheck && npm test
git add src/integrations/opencode-client.ts src/integrations/opencode-client.test.ts
git commit -m "feat(parallel): diff-scoped planning prompt (blast radius, not whole repo)"
```

---

### Task 4: single-agent fallback for thin diff plans

**Files:**
- Modify: `src/integrations/opencode-client.ts` (`runOpencodeParallel`, right after `parsePlan` at line 638)
- Test: extend `src/integrations/opencode-client.test.ts`

- [ ] **Step 1: Write the failing test**

The file already stubs `OpencodeDeps` for `runOpencodeParallel` tests (sessions whose `prompt()` returns canned text) — follow that pattern:

```ts
test("diff fan-out falls back to the single agent when the plan has <2 objectives", async () => {
  const prompts: string[] = [];
  const deps = {
    open: async () => ({
      id: "s1",
      prompt: async (text: string) => {
        prompts.push(text);
        // First call: the planner returns ONE objective. Second call: the single-agent
        // generation returns a normal closing verdict.
        return prompts.length === 1
          ? `{"objectives":[{"flow":"checkout","objective":"o","symbols":[],"needsUi":true}]}`
          : `done {"approved":true,"specs":["flows/checkout.spec.ts"]}`;
      },
      dispose: async () => {},
    }),
  };
  const result = await runOpencodeParallel(
    { repo: "r", sha: "a1b2c3d", diff: "+x", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "n",
      needsReview: false, target: "e2e", mode: "diff", appName: "a" },
    deps,
  );
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /Generate\/update E2E tests/); // the full single-agent prompt, not a worker prompt
  assert.deepEqual(result.specs, ["flows/checkout.spec.ts"]);
});

test("diff fan-out with >=2 objectives dispatches workers (no fallback)", async () => {
  const agents: string[] = [];
  const deps = {
    open: async (agent: string) => ({
      id: "s",
      prompt: async (text: string) =>
        agent === "qa-generator"
          ? `{"objectives":[{"flow":"a","objective":"oa","symbols":[],"needsUi":true},{"flow":"b","objective":"ob","symbols":[],"needsUi":true}]}`
          : `{"spec":"${text.includes("flows/a.spec.ts") ? "flows/a.spec.ts" : "flows/b.spec.ts"}"}`,
      dispose: async () => {},
    }),
  } as OpencodeDeps;
  const wrapped: OpencodeDeps = { open: async (agent, cwd, o) => { agents.push(agent); return deps.open(agent, cwd, o); } };
  const fakeFs = { read: () => null, write: () => {} };
  const result = await runOpencodeParallel(
    { repo: "r", sha: "a1b2c3d", diff: "+x", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "n",
      needsReview: false, target: "e2e", mode: "diff", appName: "a" },
    wrapped, undefined, fakeFs,
  );
  assert.deepEqual(agents.filter((a) => a.startsWith("qa-worker")), ["qa-worker", "qa-worker"]);
  assert.equal(result.specs.length, 2);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test src/integrations/opencode-client.test.ts`
Expected: the first test FAILS (today a 1-objective diff plan would fan out one worker, so `prompts[1]` is a worker prompt).

- [ ] **Step 3: Implement**

In `runOpencodeParallel`, right after the `objectives.length === 0` early-return (line 643), add:

```ts
  // A diff plan with a single objective gains nothing from fan-out and would LOSE the
  // single-agent prompt's full context (diff, fix/review blocks). Fall back.
  if (input.mode === "diff" && objectives.length < 2) {
    opts?.onProgress?.(`[qa] plan: ${objectives.length} objective(s) — falling back to the single-agent path`);
    return runOpencode(input, deps, opts);
  }
```

- [ ] **Step 4: Run the tests** — Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run typecheck && npm test
git add src/integrations/opencode-client.ts src/integrations/opencode-client.test.ts
git commit -m "feat(parallel): diff plans with <2 objectives fall back to the single agent"
```

---

### Task 5: docs

**Files:**
- Modify: `config/apps/example.yaml` (the `qa:` block)
- Modify: `CLAUDE.md` (run-modes section)

- [ ] **Step 1: Document the flag**

`config/apps/example.yaml`, inside `qa:` after `testDataPrefix`:

```yaml
  # parallelDiff: true     # diff runs plan the blast radius and fan out parallel workers
                           # (>=2 independent objectives). Default off; recommended for
                           # apps with services[] or large blast radii.
```

`CLAUDE.md` — in the "Run modes" section, extend the `diff` bullet:

```markdown
  With `qa.parallelDiff: true`, a diff run plans the blast radius into objectives and
  fans out parallel workers (>=2 objectives; single-agent otherwise). Re-generation
  passes (fix/review/coverage) are always single-agent.
```

- [ ] **Step 2: Full gate + commit**

```bash
npm run typecheck && npm test
git add config/apps/example.yaml CLAUDE.md
git commit -m "docs: qa.parallelDiff flag"
```

---

### F3 exit criteria

- `npm test` + `npm run typecheck` green.
- With the flag OFF (default), the generate path is byte-for-byte today's behavior.
- With the flag ON, a multi-flow commit fans out; a single-flow commit falls back without losing prompt context.
