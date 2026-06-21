# Deterministic Static-Signal Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strengthen panchito's deterministic (non-AI) signal so the agent receives richer, objective code context per run — first by fixing two signals whose resources already exist (PR-range blast radius, branch coverage), then by adding a language-agnostic static-analysis layer (difftastic, Lizard, tree-sitter, ast-grep) wired for JavaScript/TypeScript and Java but trivially extensible.

**Architecture:** Two stages. **Stage 1** wires resources that already exist but are unused: `getChangedFilesInRange` (PR-range) and branch data in lcov/Istanbul (already emitted, never parsed). **Stage 2** adds a new deterministic module `src/qa/static-signal/` that runs in the orchestrator BEFORE generation, extracts structural signal from the diff, and injects it into the prompt as one rendered section — mirroring how `change-coverage.ts` measures and `exploration-brief.ts` renders. Every new signal is **fail-open, additive, signal-only**: it never blocks publish and degrades to "absent" when a tool or language is unsupported. The agent's semantic navigation (Serena/LSP) is untouched and complementary — the static layer pre-computes the cheap syntactic layer; Serena keeps the cross-file semantic layer.

**Tech Stack:** TypeScript via `tsx` (no build step), `node:test` + `node:assert/strict`, dependency-injection (`*Deps` + `default*Deps`) for every side-effecting module. External single-purpose binaries: `difft` (difftastic, Rust), `lizard` (Python), `ast-grep`/`sg` (Rust), and tree-sitter via `web-tree-sitter` (WASM grammars) for portability.

---

## Design decisions (resolved — review before executing)

These were decided across the investigation. Each closes a real fork; flag any you disagree with before execution.

1. **Engine vs function overlap.** ast-grep and difftastic are built ON tree-sitter; they share the parser internally but each performs a DISTINCT function. The rule enforced throughout: **one function → one tool**. The aggregator emits exactly one value per signal kind.
2. **ast-grep vs the existing `structural-pattern.ts` (regex).** ast-grep becomes the PRIMARY pattern source for supported languages; the existing regex (`src/qa/learning/structural-pattern.ts`) stays as the FALLBACK for languages with no ast-grep rules. The aggregator emits a single `patterns` field. No double signal. `structural-pattern.ts` is NOT deleted (the learning layer still consumes it).
3. **tree-sitter vs the explorer pass (Serena).** tree-sitter pre-computes the SYNTACTIC layer (changed symbols + signatures + import relations) deterministically in the orchestrator. The `qa-explorer` agent pass (Serena, cross-file semantics) is NOT removed — it now starts from the static signal as a base. Static = cheap/syntactic/always-on; Serena = expensive/semantic/on-demand.
4. **Interconnected flows (multi-class, multi-repo).** Intra-repo relations come from a lightweight tree-sitter import graph (`relations.ts`). Cross-repo (microservices) reuses the EXISTING machinery (`services[]`, `context.json` FE↔BE links) — no new cross-repo resolver in this plan.
5. **Signal-only, fail-open.** Like the value oracle and `changeCoverage: signal`, the static signal never blocks publish and never throws into the pipeline; any failure logs and degrades to absent.
6. **Project-agnostic.** Nothing references `config/apps/*`. The language registry is keyed by LANGUAGE, not by app. Initial languages: `javascript`, `typescript`, `java`. Adding a language = one registry entry + its grammar/queries/rules.
7. **Spike-first for external tools.** Each binary-backed extractor's FIRST task captures the tool's REAL output into a fixture; the parser is then TDD'd against that fixture. We never invent an external tool's output format.
8. **Security: external tools run under scrubEnv + sandbox privilege-drop.** All external binary invocations (`exec.ts`) apply the same `resolveSandbox` + `sandboxSpawnOptions` pattern from `src/qa/code-runner.ts` in addition to `scrubEnv`. difftastic, Lizard, ast-grep, and tree-sitter PARSE (not execute) untrusted watched-repo source — the risk is lower than code-mode execution — but they are sandboxed for consistency with the security boundary documented in CLAUDE.md: "the LLM agent is read-only on watched repos; only the deterministic orchestrator does git writes." Crashes from malformed source are caught by the aggregator's `guard` and record a `skipped` note.

---

## File structure

**Stage 1 — modify only:**
- `src/integrations/repo-mirror.ts` — add `getRangeDiff` (twin of existing `getChangedFilesInRange`).
- `src/types.ts` — add `RunOptions.baseSha`.
- `src/server/webhook.ts` — capture `before` from push events into the payload.
- `src/index.ts`, `src/cli.ts` — thread `baseSha`.
- `src/pipeline.ts` — use range diff in `prepare`.
- `src/qa/change-coverage.ts` — add branch-coverage types, parsers, and computation.

**Stage 2 — new module `src/qa/static-signal/`:**
- `languages.ts` — extensible language registry (ext → language → config). One responsibility: language resolution.
- `types.ts` — `StaticSignal`, per-extractor result types, `StaticSignalDeps`.
- `exec.ts` — shared bounded external-binary runner (extracted pattern from `mutation-code.ts`).
- `symbols.ts` — tree-sitter: changed symbols + signatures.
- `relations.ts` — tree-sitter: intra-repo import/relationship graph.
- `complexity.ts` — Lizard: per-function cyclomatic complexity.
- `semantic-diff.ts` — difftastic: real vs cosmetic change per file.
- `patterns.ts` — ast-grep: change patterns (with regex fallback via existing `structural-pattern.ts`).
- `aggregate.ts` — runs all extractors, assembles `StaticSignal`, fail-open per extractor.
- `render.ts` — `StaticSignal` → prompt section text (mirrors `renderExplorationBrief`).
- Colocated `*.test.ts` for each.
- `src/integrations/prompts.ts` — add one `section("static-signal", …)`.
- `src/pipeline.ts` — call the aggregator before generation; thread result into `GenerateInput`.
- `Dockerfile` — install `difft`, `lizard`, `ast-grep`.

---

# STAGE 1 — Fix signals whose resources already exist

## Task 1.1: `getRangeDiff` (PR-range diff)

**Files:**
- Modify: `src/integrations/repo-mirror.ts` (add after `getChangedFilesInRange`, ~line 268)
- Test: `src/integrations/repo-mirror.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/integrations/repo-mirror.test.ts` (reuse the existing `gitStub` helper at ~line 145):

```typescript
test("getRangeDiff diffs base..head as one range", async () => {
  const d = gitStub(() => "range-diff");
  const diff = await getRangeDiff("/dir", "aaaa111", "bbbb222", d);
  assert.equal(diff, "range-diff");
  assert.deepEqual(d.calls[0], ["diff", "aaaa111..bbbb222"]);
});

test("getRangeDiff rejects a non-hex base sha", async () => {
  const d = gitStub(() => "");
  await assert.rejects(() => getRangeDiff("/dir", "not-a-sha", "bbbb222", d), /invalid commit sha/);
});
```

Add `getRangeDiff` to the existing import from `./repo-mirror` at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test --test-name-pattern="getRangeDiff" src/integrations/repo-mirror.test.ts`
Expected: FAIL — "getRangeDiff is not a function" / import error.

- [ ] **Step 3: Write minimal implementation**

In `src/integrations/repo-mirror.ts`, immediately after `getChangedFilesInRange` (ends ~line 267):

```typescript
// Full unified diff across a commit RANGE (base..head) — the union of everything a PR
// introduced, not just its tip. Twin of getChangedFilesInRange, but returns the diff WITH
// line content so parseDiffHunks derives both changed files AND changed lines. Single-commit
// callers keep using getCommitDiff; this is only taken when a base SHA is known (PR/push range).
export async function getRangeDiff(
  dir: string,
  baseSha: string,
  headSha: string,
  deps: MirrorDeps,
): Promise<string> {
  assertHexSha(baseSha);
  assertHexSha(headSha);
  return deps.git(["diff", `${baseSha}..${headSha}`], dir);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test --test-name-pattern="getRangeDiff" src/integrations/repo-mirror.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/integrations/repo-mirror.ts src/integrations/repo-mirror.test.ts
git commit -m "feat(qa): add getRangeDiff for PR-range blast radius"
```

## Task 1.2: `RunOptions.baseSha` + thread it into `prepare`

**Files:**
- Modify: `src/types.ts` (`RunOptions`, ~line 41-53)
- Modify: `src/pipeline.ts` (`PipelineDeps.prepare` type; impl ~256-261; call ~1024)
- Test: `src/pipeline.test.ts`

- [ ] **Step 1: Add the field (no test — type-only change)**

In `src/types.ts`, inside `RunOptions` (after `commits?: number;`):

```typescript
  // PR/push range: when set and != the head sha, the diff spans baseSha..sha (the whole PR),
  // not just the tip commit. Absent → single-commit behavior (unchanged).
  baseSha?: string;
```

- [ ] **Step 2: Write the failing test**

In `src/pipeline.test.ts`, add a test that the prepare dep receives `baseSha`. Use the existing `deps()` function (defined at line 252 in `pipeline.test.ts`) which is the file's stub builder — NOT a `makePipelineDepsStub` helper (that name does not exist in this file). The `APP` constant is the local app fixture. The second argument to `runPipeline` is the source (`TriggerSource`); `"webhook"` is the real default (the arg at line 119 in `runner.ts`); use `"webhook"` here to match the call site convention:

```typescript
test("runPipeline forwards opts.baseSha to prepare (PR-range)", async () => {
  const prepareCalls: Array<{ sha: string; baseSha?: string }> = [];
  const calls: string[] = [];
  const d = deps(passing(), calls, {});
  d.prepare = async (_repo: string, sha: string, _commits?: number, baseSha?: string) => {
    prepareCalls.push({ sha, baseSha });
    return { mirrorDir: d.mirrorDir, diff: "diff --git a/x b/x\n", message: "feat: x" };
  };
  await runPipeline(APP, "bbbb222", d, "webhook", { mode: "diff", baseSha: "aaaa111" });
  assert.equal(prepareCalls[0]?.baseSha, "aaaa111");
});
```

(The local helper is `deps()`, not `makePipelineDepsStub`. `APP` is the app fixture constant already in scope. The `source` param is `TriggerSource`; pass `"webhook"` — the pipeline's real default trigger source.)

- [ ] **Step 3: Run test to verify it fails**

Run: `node --import tsx --test --test-name-pattern="forwards opts.baseSha" src/pipeline.test.ts`
Expected: FAIL — `baseSha` is `undefined` (not threaded yet).

- [ ] **Step 4: Implement the threading**

In `src/pipeline.ts`, there are TWO `prepare` call sites. Update them as follows:

(a) Update the `prepare` signature in the `PipelineDeps` interface (verified: around line 125) to add a 4th optional param `baseSha?: string`.

(b) Update `defaultPipelineDeps.prepare` (verified at lines 255-260) to:

```typescript
    prepare: async (repo, sha, commits, baseSha) => {
      const mirrorDir = await ensureMirror(repo, sha, defaultMirrorDeps);
      const diff = baseSha && baseSha !== sha
        ? await getRangeDiff(mirrorDir, baseSha, sha, defaultMirrorDeps)
        : await getCommitDiff(mirrorDir, sha, defaultMirrorDeps, commits);
      const message = await getCommitMessage(mirrorDir, sha, defaultMirrorDeps);
      return { mirrorDir, diff, message };
    },
```

Add `getRangeDiff` to the existing import from `./integrations/repo-mirror`.

(c) **PRIMARY call site** (verified at line 1022, inside the `else` branch for non-service runs) — pass `opts.baseSha`:

```typescript
    ({ mirrorDir, diff, message } = await deps.prepare(app.repo, sha, commits, opts.baseSha));
```

(d) **SERVICE call site** (verified at line 1013, inside the `if (triggerService)` branch) — do NOT pass `baseSha`. The service call is:

```typescript
    const svc = await deps.prepare(triggerService.repo, sha);
```

It must stay as a single-commit call (no range diff). In a service-triggered run, the diff is the service repo's tip commit — `baseSha` would refer to the primary repo's range, which has no meaning here.

Enumerate: four sites total — one interface, one default impl, one primary call (add baseSha), one service call (leave unchanged).

- [ ] **Step 5: Run test + full suite**

Run: `node --import tsx --test --test-name-pattern="forwards opts.baseSha" src/pipeline.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/pipeline.ts src/pipeline.test.ts
git commit -m "feat(qa): thread baseSha through pipeline prepare (range diff)"
```

## Task 1.3: Capture `before` from push events in the webhook

**Files:**
- Modify: `src/server/webhook.ts` (`WebhookPayload` type; `parseWebhook` ~31-48)
- Modify: `src/index.ts` (`enqueueApiRun` ~203; the webhook handler ~579 destructure)
- Modify: `src/server/runner.ts` (`RunRequest` interface ~lines 41-54; `opts` object ~line 147)
- Test: `src/server/webhook.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/server/webhook.test.ts` (match its existing `parseWebhook` test style):

```typescript
test("parseWebhook captures push-event before as baseSha", () => {
  const payload = parseWebhook({
    repository: { full_name: "o/r" },
    before: "a".repeat(40),
    after: "b".repeat(40),
  });
  assert.equal(payload?.sha, "b".repeat(40));
  assert.equal(payload?.baseSha, "a".repeat(40));
});

test("parseWebhook drops an all-zero before (new branch)", () => {
  const payload = parseWebhook({
    repository: { full_name: "o/r" },
    before: "0".repeat(40),
    after: "b".repeat(40),
  });
  assert.equal(payload?.baseSha, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test --test-name-pattern="before as baseSha" src/server/webhook.test.ts`
Expected: FAIL — `baseSha` is `undefined`.

- [ ] **Step 3: Implement**

(a) Add `baseSha?: string;` to the `WebhookPayload` interface in `src/server/webhook.ts`.

(b) In `parseWebhook`, the GitHub push-event branch becomes:

```typescript
  // GitHub push event: { repository: { full_name }, before, after } → always "diff".
  // `before` is the SHA prior to the push (the range base); all-zeros means a new branch — drop it.
  const repository = b.repository as { full_name?: unknown } | undefined;
  if (typeof repository?.full_name === "string" && typeof b.after === "string" && HEX_SHA.test(b.after)) {
    const before =
      typeof b.before === "string" && HEX_SHA.test(b.before) && !/^0+$/.test(b.before) ? b.before : undefined;
    return { repo: repository.full_name, sha: b.after, mode: "diff", baseSha: before };
  }
```

Also accept `baseSha` in the simple-shape branch (add `baseSha: typeof b.baseSha === "string" && HEX_SHA.test(b.baseSha) ? b.baseSha : undefined` to that return object).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test --test-name-pattern="parseWebhook" src/server/webhook.test.ts`
Expected: PASS (all parseWebhook tests).

- [ ] **Step 5: Thread baseSha through enqueue**

There are four concrete sites, verified in the codebase:

**(a) `src/server/runner.ts` — `RunRequest` interface (verified lines 41-54):** Add `baseSha?: string` to `RunRequest`:

```typescript
  baseSha?: string; // PR/push range: when set, diff spans baseSha..sha (range diff)
```

**(b) `src/server/runner.ts` — `opts` object passed to `runPipeline` (verified line 147):** Add `baseSha: req.baseSha` to the RunOptions object:

```typescript
        { mode: req.mode, target: req.target, guidance: req.guidance, fixCases: req.fixCases, parentRunId: req.parentRunId, triggerRepo: req.triggerRepo, previousNamespace, runId: record.id, commits: req.commits, baseSha: req.baseSha },
```

**(c) `src/index.ts` — `enqueueApiRun` function (verified line 203):** Add a `baseSha?: string` parameter after `triggerRepo`, and include it in the `RunRequest` object passed to `enqueueTrackedRun`. The ONLY call that must forward `baseSha` is the primary-role call (the `m.role === "primary"` branch, verified line 591). The cross-repo service call (verified line 593) does NOT receive `baseSha` — that call passes `triggerRepo` instead, and `baseSha` in a service run refers to the PRIMARY repo range, which is inapplicable:

```typescript
function enqueueApiRun(app: string, sha: string, target: string, mode: RunMode, guidance?: string, shadow?: boolean, commits?: number, triggerRepo?: string, baseSha?: string): string {
  // ...
  return enqueueTrackedRun(queue, { app, sha, target: target as TestTarget, mode, guidance, shadow, commits, source: "webhook", triggerRepo, baseSha }, ...);
}
```

**(d) `src/index.ts` — webhook handler destructure (verified line 585):** Add `baseSha` to the destructure from `result.payload` and pass it to the primary `enqueueApiRun` call:

```typescript
const { repo, sha, mode, guidance, baseSha } = result.payload;
// ...
enqueueApiRun(m.app.name, sha, m.app.code ? "code" : "e2e", mode, guidance, undefined, undefined, undefined, baseSha);
```

The service-role call at line 593 passes `repo` as `triggerRepo` and passes `undefined` for `baseSha`.

- [ ] **Step 6: Run typecheck + commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/server/webhook.ts src/server/webhook.test.ts src/index.ts
git commit -m "feat(qa): capture push-event before-sha as PR-range base"
```

## Task 1.4: CLI `--base-sha` flag

**Files:**
- Modify: `src/cli.ts` (`parseArgs` ~171-197; `main` enqueue ~115-122)
- Test: `src/cli.test.ts` (if present; else add a `parseArgs` export test)

- [ ] **Step 1: Write the failing test**

If `parseArgs` is not exported, export it first. Add to `src/cli.test.ts`:

```typescript
test("parseArgs reads --base-sha", () => {
  const a = parseArgs(["--app", "x", "--sha", "bbbb222", "--base-sha", "aaaa111"]);
  assert.equal(a.baseSha, "aaaa111");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test --test-name-pattern="base-sha" src/cli.test.ts`
Expected: FAIL — `baseSha` undefined.

- [ ] **Step 3: Implement**

In `parseArgs`, add `baseSha: out["base-sha"]` to the returned object and to its return type. In the usage string add `[--base-sha <sha>]`. In `main`'s `enqueueTrackedRun` call (lines 115-122) add `baseSha: args.baseSha,`.

- [ ] **Step 4: Run test + commit**

Run: `node --import tsx --test --test-name-pattern="base-sha" src/cli.test.ts`
Expected: PASS.

```bash
git add src/cli.ts src/cli.test.ts
git commit -m "feat(qa): add --base-sha CLI flag for range diff"
```

## Task 1.5: Branch-coverage types

**Files:**
- Modify: `src/qa/change-coverage.ts` (types block ~29-46)
- Test: none (type-only)

- [ ] **Step 1: Add types**

In `src/qa/change-coverage.ts`, after `CoveredLines` (line 30):

```typescript
// file → line → branch tally on that line. lcov BRDA / Istanbul branchMap give per-branch
// taken counts; we fold them to {total, taken} per line so it joins on the same changed-line keys.
export type CoveredBranches = Map<string, Map<number, { total: number; taken: number }>>;
```

Extend `ChangeCoverage` (line 41-46) with one additive field:

```typescript
export interface ChangeCoverage {
  measured: boolean;
  overall: { changedLines: number; coveredChanged: number; ratio: number };
  perFile: Array<{ file: string; changed: number; covered: number; ratio: number }>;
  uncovered: Array<{ file: string; lines: number[] }>;
  // Additive, signal-only: branch tally restricted to changed lines. null when no branch
  // data was available (degrade-to-unknown, exactly like measured=false for lines).
  branches: { changedBranches: number; takenBranches: number; ratio: number } | null;
}
```

- [ ] **Step 2: Typecheck (expect existing construction sites to error)**

Run: `npm run typecheck`
Expected: FAIL — `computeChangeCoverage` return object is missing `branches`. (Fixed in Task 1.7.) This is the failing state; proceed.

- [ ] **Step 3: Commit (types only, will compile after 1.7)**

Defer commit until Task 1.7 compiles. Continue to 1.6.

## Task 1.6: `parseLcovBranches` + `parseIstanbulBranches`

**Files:**
- Modify: `src/qa/change-coverage.ts` (after `parseLcov` ~207 and `parseIstanbulJson` ~229)
- Test: `src/qa/change-coverage.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/qa/change-coverage.test.ts` (reuse the `lines` helper style; add a `branchLines` helper):

```typescript
function branchTally(m: CoveredBranches): Record<string, Record<number, { total: number; taken: number }>> {
  const o: Record<string, Record<number, { total: number; taken: number }>> = {};
  for (const [f, perLine] of m) { o[f] = {}; for (const [ln, t] of perLine) o[f][ln] = t; }
  return o;
}

test("parseLcovBranches: BRDA tallies total and taken per line", () => {
  // BRDA:<line>,<block>,<branch>,<taken>  (taken '-' or 0 = not taken)
  const lcov = ["SF:/repo/src/a.ts", "BRDA:5,0,0,1", "BRDA:5,0,1,-", "BRDA:8,0,0,3", "end_of_record"].join("\n");
  assert.deepEqual(branchTally(parseLcovBranches(lcov, "/repo")), {
    "src/a.ts": { 5: { total: 2, taken: 1 }, 8: { total: 1, taken: 1 } },
  });
});

test("parseIstanbulBranches: branchMap loc.start.line with b>0 counts as taken", () => {
  const json = {
    "/repo/src/a.ts": {
      path: "/repo/src/a.ts",
      branchMap: { "0": { loc: { start: { line: 5 } }, locations: [{ start: { line: 5 } }, { start: { line: 5 } }] } },
      b: { "0": [3, 0] },
    },
  };
  assert.deepEqual(branchTally(parseIstanbulBranches(json, "/repo")), {
    "src/a.ts": { 5: { total: 2, taken: 1 } },
  });
});
```

Add `parseLcovBranches`, `parseIstanbulBranches`, `CoveredBranches` to the test's imports.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test --test-name-pattern="Branches" src/qa/change-coverage.test.ts`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Implement `parseLcovBranches`**

After `parseLcov` (line 207) in `src/qa/change-coverage.ts`:

```typescript
// Branch coverage from lcov BRDA records: BRDA:<line>,<block>,<branch>,<taken>.
// <taken> is a hit count, or "-" when the branch was never reached. We fold per line:
// total = number of BRDA records on that line; taken = those with a numeric, >0 hit count.
export function parseLcovBranches(text: string, repoDir?: string): CoveredBranches {
  const out: CoveredBranches = new Map();
  let file: string | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      file = normalizeRepoPath(line.slice(3).trim(), repoDir);
      if (!out.has(file)) out.set(file, new Map());
    } else if (line.startsWith("BRDA:") && file) {
      const parts = line.slice(5).split(",");
      const ln = Number(parts[0]);
      // Guard: BRDA lines must have ≥4 comma-separated fields (<line>,<block>,<branch>,<taken>).
      // A truncated BRDA line (fewer than 4 parts) is skipped, not miscounted as an untaken branch.
      if (parts.length < 4 || !Number.isFinite(ln)) continue;
      const takenRaw = parts[3];
      const perLine = out.get(file)!;
      const tally = perLine.get(ln) ?? { total: 0, taken: 0 };
      tally.total += 1;
      if (takenRaw !== "-" && Number(takenRaw) > 0) tally.taken += 1;
      perLine.set(ln, tally);
    } else if (line.startsWith("end_of_record")) {
      file = null;
    }
  }
  return out;
}
```

- [ ] **Step 4: Implement `parseIstanbulBranches`**

After `parseIstanbulJson` (line 229):

```typescript
// Branch coverage from Istanbul: branchMap[id] gives the branch location(s); b[id] is the
// per-branch hit-count array. We anchor each branch to branchMap[id].loc.start.line and fold:
// total = number of sub-branches (b[id].length); taken = those with count > 0.
export function parseIstanbulBranches(json: unknown, repoDir?: string): CoveredBranches {
  const out: CoveredBranches = new Map();
  if (!json || typeof json !== "object") return out;
  for (const [rawPath, entry] of Object.entries(json as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as {
      path?: string;
      branchMap?: Record<string, { loc?: { start?: { line?: number } } }>;
      b?: Record<string, number[]>;
    };
    const map = e.branchMap;
    const counts = e.b;
    if (!map || !counts) continue;
    const file = normalizeRepoPath(e.path ?? rawPath, repoDir);
    const perLine = new Map<number, { total: number; taken: number }>();
    for (const [id, meta] of Object.entries(map)) {
      const ln = meta.loc?.start?.line;
      const arr = counts[id];
      if (typeof ln !== "number" || !Array.isArray(arr)) continue;
      const tally = perLine.get(ln) ?? { total: 0, taken: 0 };
      tally.total += arr.length;
      tally.taken += arr.filter((c) => c > 0).length;
      perLine.set(ln, tally);
    }
    if (perLine.size) out.set(file, perLine);
  }
  return out;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --import tsx --test --test-name-pattern="Branches" src/qa/change-coverage.test.ts`
Expected: PASS (both).

- [ ] **Step 6: Commit**

```bash
git add src/qa/change-coverage.ts src/qa/change-coverage.test.ts
git commit -m "feat(qa): parse lcov BRDA + Istanbul branchMap (branch coverage)"
```

## Task 1.7: Fold branches into `computeChangeCoverage`

**Files:**
- Modify: `src/qa/change-coverage.ts` (`computeChangeCoverage` ~117-145)
- Test: `src/qa/change-coverage.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
test("computeChangeCoverage folds branch tally restricted to changed lines", () => {
  const changed: CoveredLines = new Map([["src/a.ts", new Set([5, 8])]]);
  const coveredLines: CoveredLines = new Map([["src/a.ts", new Set([5, 8])]]);
  const coveredBranches: CoveredBranches = new Map([
    ["src/a.ts", new Map([[5, { total: 2, taken: 1 }], [99, { total: 4, taken: 4 }]])], // line 99 NOT changed → excluded
  ]);
  const cc = computeChangeCoverage(changed, coveredLines, coveredBranches);
  assert.deepEqual(cc.branches, { changedBranches: 2, takenBranches: 1, ratio: 0.5 });
});

test("computeChangeCoverage: branches null when no branch data", () => {
  const changed: CoveredLines = new Map([["src/a.ts", new Set([1])]]);
  const cc = computeChangeCoverage(changed, new Map([["src/a.ts", new Set([1])]]));
  assert.equal(cc.branches, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test --test-name-pattern="branch tally restricted" src/qa/change-coverage.test.ts`
Expected: FAIL — `computeChangeCoverage` takes 2 args / returns no `branches`.

- [ ] **Step 3: Implement**

Change the `computeChangeCoverage` signature and add the branch fold. Replace lines 117-145:

```typescript
export function computeChangeCoverage(
  changed: CoveredLines,
  covered: CoveredLines,
  coveredBranches?: CoveredBranches,
): ChangeCoverage {
  const perFile: ChangeCoverage["perFile"] = [];
  const uncovered: ChangeCoverage["uncovered"] = [];
  let totalChanged = 0;
  let totalCovered = 0;
  let anyFileMeasured = false;

  // Branch fold: only branches sitting on a CHANGED line count (join on the same keys as lines).
  let branchTotal = 0;
  let branchTaken = 0;
  let anyBranchMeasured = false;

  for (const [file, lineSet] of changed) {
    const cov = covered.get(file);
    if (cov) anyFileMeasured = true;
    let fileCovered = 0;
    const fileUncovered: number[] = [];
    for (const ln of lineSet) {
      if (cov?.has(ln)) fileCovered++;
      else fileUncovered.push(ln);
    }
    totalChanged += lineSet.size;
    totalCovered += fileCovered;
    perFile.push({ file, changed: lineSet.size, covered: fileCovered, ratio: lineSet.size ? fileCovered / lineSet.size : 1 });
    if (fileUncovered.length) uncovered.push({ file, lines: fileUncovered.sort((a, b) => a - b) });

    const branchesForFile = coveredBranches?.get(file);
    if (branchesForFile) {
      for (const ln of lineSet) {
        const tally = branchesForFile.get(ln);
        if (tally) {
          anyBranchMeasured = true;
          branchTotal += tally.total;
          branchTaken += tally.taken;
        }
      }
    }
  }

  return {
    measured: anyFileMeasured,
    overall: { changedLines: totalChanged, coveredChanged: totalCovered, ratio: totalChanged ? totalCovered / totalChanged : 1 },
    perFile,
    uncovered,
    branches: anyBranchMeasured
      ? { changedBranches: branchTotal, takenBranches: branchTaken, ratio: branchTotal ? branchTaken / branchTotal : 1 }
      : null,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass + typecheck**

Run: `node --import tsx --test --test-name-pattern="branch" src/qa/change-coverage.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: clean (the Task 1.5 type error is now resolved — every `computeChangeCoverage` return has `branches`).

- [ ] **Step 5: Commit (includes Task 1.5 types)**

```bash
git add src/qa/change-coverage.ts src/qa/change-coverage.test.ts
git commit -m "feat(qa): fold branch coverage into change-coverage (signal-only)"
```

## Task 1.8: Wire branch coverage into the pipeline via a separate dep (signal-only)

**Files:**
- Modify: `src/pipeline.ts` (PipelineDeps interface; `defaultPipelineDeps`; two `computeChangeCoverage` call sites)
- Test: `src/pipeline.test.ts`

> **Design note (CRITICAL — do NOT deviate):** The existing `collectCoverage` dep in `PipelineDeps` currently returns `CoveredLines | null` (verified: `src/qa/change-coverage.ts` line 347, `defaultCollectCoverage` returns `CoveredLines | null`). The prod function `defaultCollectCoverage`, every stub in `src/pipeline.test.ts` (the `coverage` option in `deps()` at line 264 holds `Array<CoveredLines | null>`, returned by the `collectCoverage` stub at line 313), and the two pipeline call sites at lines 2507-2509 and 2538-2539 ALL assume this shape.
>
> Changing this return type to `{lines, branches}` would break: (1) the `PipelineDeps.collectCoverage` interface, (2) `defaultCollectCoverage`, (3) EVERY `coverage:` stub in `pipeline.test.ts` (there are ~8 stubs returning `CoveredLines | null`), AND (4) the enforce-path call site at line 2539 (`computeChangeCoverage(changed, reCollected ?? new Map())`).
>
> **The less-invasive approach (what this task implements):** keep `collectCoverage` returning `CoveredLines | null` UNCHANGED. Add a SEPARATE optional dep `collectBranchCoverage` to `PipelineDeps` that returns `CoveredBranches | null`. Call it alongside `collectCoverage` and pass the result as the 3rd arg to BOTH `computeChangeCoverage` call sites.

- [ ] **Step 1: Write the failing test**

In `src/pipeline.test.ts`, add a test that verifies the pipeline calls `collectBranchCoverage` when wired and passes the result to coverage. The `deps()` helper (line 252) does not currently support `collectBranchCoverage` — add it inline:

```typescript
test("runPipeline passes branch coverage to computeChangeCoverage when dep is wired", async () => {
  const calls: string[] = [];
  const branches: CoveredBranches = new Map([["src/a.ts", new Map([[1, { total: 2, taken: 1 }]])]]);
  const d = deps(passing(), calls, { diff: DIFF_4, coverage: [cov([1, 2, 3, 4])], message: "feat: x" });
  d.collectBranchCoverage = async () => branches;
  const outcome = await runPipeline(APP, "abcd1234", d, "webhook", { mode: "diff" });
  // signal-only: not a publish gate, but the branch field must be present
  assert.ok(outcome.coverage?.branches !== undefined);
});
```

(Import `CoveredBranches` from `src/qa/change-coverage`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test --test-name-pattern="branch coverage to computeChangeCoverage" src/pipeline.test.ts`
Expected: FAIL — `collectBranchCoverage` dep does not exist yet.

- [ ] **Step 3: Add the dep to `PipelineDeps` and `defaultPipelineDeps`**

In `src/pipeline.ts`, `PipelineDeps` interface — add after the existing `collectCoverage` field:

```typescript
  // SEPARATE optional dep — adds branch-coverage signal without changing collectCoverage's
  // CoveredLines | null return type. Absent → branches stay null (fail-open, never blocks).
  collectBranchCoverage?(input: CoverageCollectInput): Promise<CoveredBranches | null>;
```

In `defaultPipelineDeps` — wire a real branch collector that reads the SAME lcov/Istanbul sources as `collectCoverage` (call `parseLcovBranches` / `parseIstanbulBranches` on the same files that `collectNativeCoverage` reads). Absent or errored → return `null`. Returns `null` for V8/JaCoCo paths (out of scope):

```typescript
    collectBranchCoverage: async (input) => {
      if (input.target !== "code") return null; // V8 branch parsing out of scope
      try {
        return collectNativeBranchCoverage(input.repoDir);
      } catch {
        return null;
      }
    },
```

> **Limitation (stated, not silent):** branch coverage is code-mode-scoped. e2e/V8 branch data requires parsing the V8 coverage format for branch records, which is out of scope for this plan. `collectBranchCoverage` returns `null` for `target !== "code"`, so `cc.branches` is always `null` for e2e runs. This degrade is identical to the existing line-coverage `measured=false` degrade and never blocks publish.

Add a `collectNativeBranchCoverage(repoDir: string): CoveredBranches | null` helper to `src/qa/change-coverage.ts`. It mirrors `collectNativeCoverage` (verified in `src/qa/change-coverage.ts`, function at line 364), reading the same paths in the same priority order — lcov first, then Istanbul JSON. JaCoCo is skipped (no BRDA-equivalent in the XML output format parsed by `parseJacocoXml`).

> **Export decision:** `collectNativeBranchCoverage` MUST be `export function` (not module-private). `defaultPipelineDeps.collectBranchCoverage` in `pipeline.ts` calls it directly, and `pipeline.ts` imports from `./qa/change-coverage`. This mirrors exactly how `defaultCollectCoverage` (exported, line 347) wraps the module-private `collectNativeCoverage` (line 364) — BUT for branch coverage the simpler approach is to export `collectNativeBranchCoverage` directly (no additional `defaultCollectBranchCoverage` wrapper needed) and have `defaultPipelineDeps` call it inside its own try/catch (the dep already wraps in try/catch per the implementation below). Choose whichever matches the codebase's `defaultCollectCoverage` pattern: the dep's try/catch IS the error boundary, so the helper itself does not need to catch.

```typescript
// Branch coverage from native reports: reads the SAME sources as collectNativeCoverage (lcov
// first, then Istanbul JSON). JaCoCo XML is not parsed for branches (out of scope).
// Returns null when no usable branch data is found — degrade is identical to line coverage's
// null return (→ cc.branches = null, never blocks publish).
// Scoped to code-mode only; e2e/V8 branch parsing is a follow-up.
// MUST be exported: pipeline.ts imports and calls it inside defaultPipelineDeps.collectBranchCoverage.
export function collectNativeBranchCoverage(repoDir: string): CoveredBranches | null {
  const lcovPaths = ["coverage/lcov.info", "lcov.info", "coverage/lcov/lcov.info"];
  for (const rel of lcovPaths) {
    const p = join(repoDir, rel);
    if (existsSync(p)) {
      const cov = parseLcovBranches(readFileSync(p, "utf8"), repoDir);
      if (cov.size) return cov;
    }
  }
  const istanbul = join(repoDir, "coverage", "coverage-final.json");
  if (existsSync(istanbul)) {
    const cov = parseIstanbulBranches(JSON.parse(readFileSync(istanbul, "utf8")), repoDir);
    if (cov.size) return cov;
  }
  return null;
}
```

(`join`, `existsSync`, `readFileSync` are already imported at the top of `change-coverage.ts`; `parseLcovBranches` and `parseIstanbulBranches` are defined in Task 1.6.)

- [ ] **Step 4: Update BOTH `computeChangeCoverage` call sites in pipeline.ts**

There are exactly two call sites; update both to pass the branch result as the 3rd arg:

**Call site 1 — main coverage path (verified line 2509):**

```typescript
      const collectedBranches = deps.collectBranchCoverage
        ? await deps.collectBranchCoverage({ target: isCode ? "code" : "e2e", repoDir: mirrorDir, e2eDir, changedFiles, namespace: coverageNs })
        : null;
      let cc = computeChangeCoverage(changed, collected ?? new Map(), collectedBranches ?? undefined);
```

**Call site 2 — enforce re-run path (verified line 2539):**

```typescript
              const reBranches = deps.collectBranchCoverage
                ? await deps.collectBranchCoverage({ target: isCode ? "code" : "e2e", repoDir: mirrorDir, e2eDir, changedFiles, namespace: coverageNs })
                : null;
              cc = computeChangeCoverage(changed, reCollected ?? new Map(), reBranches ?? undefined);
```

**No existing stub in `pipeline.test.ts` needs changing** — `collectBranchCoverage` is absent from all existing stubs (optional dep → branches stays null → `cc.branches === null`). Only the new test above wires it.

- [ ] **Step 5: Run tests + typecheck**

Run: `npm test` (focus first: `node --import tsx --test src/qa/change-coverage.test.ts src/pipeline.test.ts`)
Expected: PASS.
Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Log the branch signal**

In `src/pipeline.ts`, after the coverage log at line 2512, add:

```typescript
      if (cc.branches) log(`[qa] branch-coverage: ${cc.branches.takenBranches}/${cc.branches.changedBranches} branches on changed lines (${(cc.branches.ratio * 100).toFixed(0)}%)`);
```

(Signal-only — logged and persisted, NOT a publish gate. `blocksPublish` is unchanged.)

- [ ] **Step 7: Commit**

```bash
git add src/qa/change-coverage.ts src/qa/change-coverage.test.ts src/pipeline.ts src/pipeline.test.ts
git commit -m "feat(qa): branch coverage via separate dep — signal-only, no DI interface break"
```

**Stage 1 gate:** `npm test` and `npm run typecheck` green. Stage 1 is independently shippable.

---

# STAGE 2 — Deterministic static-signal layer

> Each binary-backed extractor is **spike-first**: its first task captures the tool's REAL output into a committed fixture under `src/qa/static-signal/__fixtures__/`, and the parser is TDD'd against that fixture. Do not hand-write a tool's output format.

## Task 2.0: Scaffolding — registry, types, aggregator, renderer, empty wire

**Files:**
- Create: `src/qa/static-signal/languages.ts`, `src/qa/static-signal/types.ts`, `src/qa/static-signal/aggregate.ts`, `src/qa/static-signal/render.ts`
- Create tests: colocated `*.test.ts`
- Modify: `src/integrations/prompts.ts`, `src/pipeline.ts`, `src/integrations/opencode-client.ts` (GenerateInput type)

- [ ] **Step 1: Write the failing test for the language registry**

Create `src/qa/static-signal/languages.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { languageForFile, SUPPORTED_LANGUAGES } from "./languages";

test("languageForFile maps known extensions", () => {
  assert.equal(languageForFile("src/a.ts"), "typescript");
  assert.equal(languageForFile("src/a.tsx"), "typescript");
  assert.equal(languageForFile("src/a.js"), "javascript");
  assert.equal(languageForFile("src/Main.java"), "java");
});

test("languageForFile returns null for unsupported extensions (degrade)", () => {
  assert.equal(languageForFile("src/main.go"), null);
  assert.equal(languageForFile("README.md"), null);
});

test("SUPPORTED_LANGUAGES is the single source of truth", () => {
  assert.deepEqual([...SUPPORTED_LANGUAGES].sort(), ["java", "javascript", "typescript"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/qa/static-signal/languages.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry**

Create `src/qa/static-signal/languages.ts`:

```typescript
// The SINGLE source of truth for language support across every extractor. Adding a language
// is one entry here plus its grammar/queries/rules in the relevant extractor — nothing else.
// Project-AGNOSTIC: keyed by language, never by app.

export type LanguageId = "javascript" | "typescript" | "java";

export const SUPPORTED_LANGUAGES: ReadonlySet<LanguageId> = new Set(["javascript", "typescript", "java"]);

// Extension → language. Lowercased match. Unknown extension → null (caller degrades to "no signal").
const EXT_TO_LANGUAGE: Record<string, LanguageId> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  java: "java",
};

export function languageForFile(file: string): LanguageId | null {
  const dot = file.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = file.slice(dot + 1).toLowerCase();
  return EXT_TO_LANGUAGE[ext] ?? null;
}

// Group changed files by language, dropping unsupported ones. Used by every extractor to scope work.
export function groupByLanguage(files: string[]): Map<LanguageId, string[]> {
  const out = new Map<LanguageId, string[]>();
  for (const f of files) {
    const lang = languageForFile(f);
    if (!lang) continue;
    const list = out.get(lang) ?? [];
    list.push(f);
    out.set(lang, list);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/qa/static-signal/languages.test.ts`
Expected: PASS.

- [ ] **Step 5: Define the `StaticSignal` types**

Create `src/qa/static-signal/types.ts`:

```typescript
import type { LanguageId } from "./languages";

// A changed symbol with its signature — the syntactic layer tree-sitter pre-computes so the
// agent need not derive it with Serena. (Cross-file references stay with Serena — see relations.)
export interface ChangedSymbol {
  file: string;
  name: string;       // e.g. "CheckoutService.pay"
  kind: string;       // "function" | "method" | "class" | ...
  signature: string;  // one-line declaration text (no body)
  line: number;
}

// One directed relation between changed files (intra-repo import graph edge).
export interface RelationEdge {
  from: string; // repo-relative file
  to: string;   // repo-relative file (resolved import target) OR a module specifier if unresolved
  via: string;  // the imported symbol or module specifier
}

export interface ComplexityHotspot {
  file: string;
  function: string;
  ccn: number;     // cyclomatic complexity number
  nloc: number;    // lines of code (function body)
  line: number;
}

export interface FileChangeKind {
  file: string;
  cosmetic: boolean; // true = whitespace/comment-only per structural diff (skip deep testing)
}

export interface ChangePattern {
  file: string;
  pattern: string;  // e.g. "form", "api-call", "auth-flow"
  source: "ast-grep" | "regex"; // provenance (decision 2)
}

// The whole deterministic signal. Every field degrades to empty/[] independently (fail-open).
export interface StaticSignal {
  builtForSha: string;
  languages: LanguageId[];          // languages actually analyzed
  symbols: ChangedSymbol[];
  relations: RelationEdge[];
  complexity: ComplexityHotspot[];
  fileChangeKinds: FileChangeKind[];
  patterns: ChangePattern[];
  skipped: string[];                // human-readable notes: which extractor/lang degraded and why
}

export const EMPTY_STATIC_SIGNAL = (sha: string): StaticSignal => ({
  builtForSha: sha,
  languages: [],
  symbols: [],
  relations: [],
  complexity: [],
  fileChangeKinds: [],
  patterns: [],
  skipped: [],
});
```

- [ ] **Step 6: Write the failing test for the renderer**

Create `src/qa/static-signal/render.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { renderStaticSignal } from "./render";
import { EMPTY_STATIC_SIGNAL } from "./types";

test("renderStaticSignal returns empty string when no signal present", () => {
  assert.equal(renderStaticSignal(EMPTY_STATIC_SIGNAL("abc1234")), "");
});

test("renderStaticSignal lists symbols, relations, complexity, patterns", () => {
  const sig = EMPTY_STATIC_SIGNAL("abc1234");
  sig.languages = ["typescript"];
  sig.symbols = [{ file: "src/pay.ts", name: "pay", kind: "function", signature: "function pay(x: Cart): Order", line: 4 }];
  sig.relations = [{ from: "src/pay.ts", to: "src/order.ts", via: "OrderService" }];
  sig.complexity = [{ file: "src/pay.ts", function: "pay", ccn: 12, nloc: 40, line: 4 }];
  sig.patterns = [{ file: "src/pay.ts", pattern: "api-call", source: "ast-grep" }];
  const out = renderStaticSignal(sig);
  assert.match(out, /Static analysis/);
  assert.match(out, /function pay\(x: Cart\): Order/);
  assert.match(out, /src\/pay\.ts → src\/order\.ts/);
  assert.match(out, /ccn 12/);
  assert.match(out, /api-call/);
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `node --import tsx --test src/qa/static-signal/render.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 8: Implement the renderer (mirrors `renderExplorationBrief`)**

Create `src/qa/static-signal/render.ts`:

```typescript
import { sanitizeText } from "../../orchestrator/sanitizer";
import type { StaticSignal } from "./types";

const MAX_ITEMS = 200;
const MAX_LEN = 20_000;

// Structure → prompt section text. Same defensive pattern as renderExplorationBrief: sanitize
// every value, bound item count and total length, return "" when there's nothing to say.
export function renderStaticSignal(sig: StaticSignal): string {
  const s = (x: unknown): string => sanitizeText(String(x ?? "")).text;
  const has = sig.symbols.length || sig.relations.length || sig.complexity.length || sig.patterns.length || sig.fileChangeKinds.some((f) => f.cosmetic);
  if (!has) return "";

  const lines: string[] = [];
  lines.push("## Static analysis (deterministic — pre-computed from the diff)");
  lines.push(`Built for ${s(sig.builtForSha).slice(0, 7)} over ${sig.languages.join(", ") || "no supported language"}. This is GROUND TRUTH about the code structure — use it to target assertions; you need not re-derive it.`);
  lines.push("");

  const cosmetic = sig.fileChangeKinds.filter((f) => f.cosmetic).slice(0, MAX_ITEMS);
  if (cosmetic.length) {
    lines.push("### Cosmetic-only changes (whitespace/comments — deprioritize)");
    for (const f of cosmetic) lines.push(`- ${s(f.file)}`);
    lines.push("");
  }

  if (sig.symbols.length) {
    lines.push(`### Changed symbols (${sig.symbols.length})`);
    for (const sym of sig.symbols.slice(0, MAX_ITEMS)) lines.push(`- \`${s(sym.signature)}\` (${s(sym.file)}:${sym.line})`);
    lines.push("");
  }

  if (sig.relations.length) {
    lines.push(`### Relations between changed files (${sig.relations.length})`);
    for (const r of sig.relations.slice(0, MAX_ITEMS)) lines.push(`- ${s(r.from)} → ${s(r.to)} (via ${s(r.via)})`);
    lines.push("Test the flows that cross these edges, not each file in isolation.");
    lines.push("");
  }

  if (sig.complexity.length) {
    lines.push(`### Complexity hotspots (higher ccn = more paths → more cases needed)`);
    for (const c of sig.complexity.slice(0, MAX_ITEMS)) lines.push(`- ${s(c.function)} (${s(c.file)}:${c.line}) — ccn ${c.ccn}, ${c.nloc} loc`);
    lines.push("");
  }

  if (sig.patterns.length) {
    lines.push(`### Change patterns`);
    for (const p of sig.patterns.slice(0, MAX_ITEMS)) lines.push(`- ${s(p.pattern)} (${s(p.file)})`);
    lines.push("");
  }

  const out = lines.join("\n");
  return out.length > MAX_LEN ? out.slice(0, MAX_LEN) + "\n…(static signal truncated)" : out;
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `node --import tsx --test src/qa/static-signal/render.test.ts`
Expected: PASS.

- [ ] **Step 10: Implement the aggregator (extractors injected, fail-open)**

Create `src/qa/static-signal/aggregate.ts`:

```typescript
import { EMPTY_STATIC_SIGNAL, type StaticSignal } from "./types";
import { groupByLanguage } from "./languages";

// Each extractor is injected so the orchestration is unit-testable with stubs and any single
// extractor can fail (or be absent) without taking the others down. Mirrors PipelineDeps.
export interface StaticSignalDeps {
  symbols?(files: string[], repoDir: string): Promise<StaticSignal["symbols"]>;
  relations?(files: string[], repoDir: string): Promise<StaticSignal["relations"]>;
  complexity?(files: string[], repoDir: string): Promise<StaticSignal["complexity"]>;
  // sha + baseSha are required so the difft two-file approach can resolve the base blob via
  // `git show <baseSha ?? sha^>:<path>` without re-parsing the whole diff. Without sha, single-
  // commit fallback (`sha^`) cannot be computed inside the extractor.
  semanticDiff?(diff: string, repoDir: string, sha: string, baseSha?: string): Promise<StaticSignal["fileChangeKinds"]>;
  patterns?(files: string[], repoDir: string, diff: string): Promise<StaticSignal["patterns"]>;
}

export interface StaticSignalInput {
  sha: string;
  // PR/push range base: when set and != sha, the diff spans baseSha..sha (the whole PR).
  // Absent in single-commit runs. Used by the difft extractor to git-show the base blob;
  // the fallback is `${sha}^` (the parent commit) — see Task 2.1 Step 4.
  baseSha?: string;
  repoDir: string;
  changedFiles: string[];
  diff: string;
}

// Runs every available extractor, each guarded: a throw or rejection records a `skipped` note
// and leaves that field empty. Never throws. Returns EMPTY signal when no file is in a supported
// language. This is the orchestrator entry point.
export async function aggregateStaticSignal(input: StaticSignalInput, deps: StaticSignalDeps): Promise<StaticSignal> {
  const sig = EMPTY_STATIC_SIGNAL(input.sha);
  const byLang = groupByLanguage(input.changedFiles);
  sig.languages = [...byLang.keys()];
  const supportedFiles = [...byLang.values()].flat();
  if (supportedFiles.length === 0) {
    sig.skipped.push("no changed file is in a supported language (javascript/typescript/java)");
    return sig;
  }

  const guard = async <T>(name: string, run: (() => Promise<T>) | undefined, assign: (v: T) => void): Promise<void> => {
    if (!run) { sig.skipped.push(`${name}: extractor not configured`); return; }
    try {
      assign(await run());
    } catch (err) {
      sig.skipped.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  await Promise.all([
    guard("symbols", deps.symbols && (() => deps.symbols!(supportedFiles, input.repoDir)), (v) => (sig.symbols = v)),
    guard("relations", deps.relations && (() => deps.relations!(supportedFiles, input.repoDir)), (v) => (sig.relations = v)),
    guard("complexity", deps.complexity && (() => deps.complexity!(supportedFiles, input.repoDir)), (v) => (sig.complexity = v)),
    guard("semanticDiff", deps.semanticDiff && (() => deps.semanticDiff!(input.diff, input.repoDir, input.sha, input.baseSha)), (v) => (sig.fileChangeKinds = v)),
    guard("patterns", deps.patterns && (() => deps.patterns!(supportedFiles, input.repoDir, input.diff)), (v) => (sig.patterns = v)),
  ]);

  return sig;
}
```

- [ ] **Step 11: Write + run the aggregator test (fail-open behavior)**

Create `src/qa/static-signal/aggregate.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { aggregateStaticSignal } from "./aggregate";

const INPUT = { sha: "abc1234", repoDir: "/r", changedFiles: ["src/a.ts"], diff: "diff" };

test("aggregate returns EMPTY with a note when no supported language", async () => {
  const sig = await aggregateStaticSignal({ ...INPUT, changedFiles: ["main.go", "x.md"] }, {});
  assert.deepEqual(sig.languages, []);
  assert.match(sig.skipped.join(" "), /no changed file is in a supported language/);
});

test("aggregate isolates a throwing extractor (fail-open)", async () => {
  const sig = await aggregateStaticSignal(INPUT, {
    symbols: async () => [{ file: "src/a.ts", name: "f", kind: "function", signature: "function f()", line: 1 }],
    complexity: async () => { throw new Error("lizard missing"); },
  });
  assert.equal(sig.symbols.length, 1);
  assert.equal(sig.complexity.length, 0);
  assert.match(sig.skipped.join(" "), /complexity: lizard missing/);
});
```

Run: `node --import tsx --test src/qa/static-signal/aggregate.test.ts`
Expected: PASS.

- [ ] **Step 12: Wire an (empty) signal into the prompt — BOTH the single-agent AND the parallel-worker paths**

> **CRITICAL:** `diff` mode fans out to parallel workers via `runOpencodeParallel` → `buildWorkerPromptAssembled(w: ParallelWorkerInput)` (verified in `src/integrations/opencode-client.ts` line 1128, function defined in `src/integrations/prompts.ts` line 71). The parallel-worker path is ENTIRELY SEPARATE from the single-agent `buildPromptAssembled`/`OpencodeRunInput` path. Omitting the worker path would silently discard the entire static signal in `diff` mode with `parallelDiff: true` — the dominant fan-out path. Both paths are required edits.

There are **six** types/sites to update:

**Single-agent path (3 sites):**

**(a) `src/pipeline.ts` — `GenerateInput` interface (verified lines 75-110):** Add `staticSignal?: string` near `contextPack`:

```typescript
  staticSignal?: string; // deterministic static-analysis section; absent → no section in prompt
```

**(b) `src/integrations/opencode-client.ts` — `OpencodeRunInput` interface (verified lines 475-512):** Add `staticSignal?: string` near `contextPack` (line 509):

```typescript
  staticSignal?: string;
```

This is the type that `buildPromptAssembled` ultimately consumes (called from inside the `runOpencode` function that receives `OpencodeRunInput`).

**(c) `src/pipeline.ts` — manual `ocInput` mapping inside `defaultPipelineDeps.generate` (verified lines 264-298):** Add the forwarding field:

```typescript
        staticSignal: input.staticSignal,
```

**(d) `src/integrations/prompts.ts` — `buildPromptAssembled` input type + section assembly:** Add `staticSignal?: string` to the assembled-prompt input interface. Add the section after `context-brief`, before `context-pack`:

```typescript
    ...(staticSignalContent ? [section("static-signal", "semi-stable", staticSignalContent, { priority: 3 })] : []),
```

`buildPromptAssembled` receives `OpencodeRunInput`; `staticSignalContent` is derived from `input.staticSignal`.

**Parallel-worker path (2 additional sites — diff mode fan-out):**

**(e) `src/integrations/opencode-client.ts` — `ParallelWorkerInput` interface (verified lines 1083-1100):** Add `staticSignal?: string` alongside `learnedRules` and `brief`:

```typescript
  staticSignal?: string; // deterministic static-analysis section — same content as single-agent path
```

**(f) `src/integrations/prompts.ts` — `buildWorkerPromptAssembled` (verified line 71):** Add a `section("static-signal", "semi-stable", …)` to the assembled worker sections, using the same pattern and priority as the single-agent path. Insert it after the `worker-context` section (which carries the exploration brief) and before any volatile sections:

```typescript
    ...(w.staticSignal ? [section("static-signal", "semi-stable", w.staticSignal, { priority: 3 })] : []),
```

**(g) `src/integrations/opencode-client.ts` — `runOpencodeParallel` worker construction (verified lines 1361-1378):** Propagate `input.staticSignal` into every `ParallelWorkerInput` it constructs. The construction site is the `grounded.map(...)` at line 1361:

```typescript
  const workers: ParallelWorkerInput[] = grounded.map(({ objective: o, dom }) => ({
    // ... existing fields ...
    learnedRules: input.learnedRules,
    staticSignal: input.staticSignal, // propagate static signal to all workers
    ...(dom ? { domSnapshot: dom } : {}),
    runId: input.runId,
  }));
```

`input` here is `OpencodeRunInput` — `staticSignal` flows from the pipeline's `GenerateInput` → `OpencodeRunInput` (sites a–d) → every `ParallelWorkerInput` (this site) → `buildWorkerPromptAssembled` (site f).

- [ ] **Step 13: Wire the aggregator into the pipeline (empty deps = no-op)**

In `src/pipeline.ts`, between the end of the context-pack block and the generate call:

```typescript
    // Deterministic static signal (difftastic/lizard/tree-sitter/ast-grep). Signal-only, fail-open:
    // aggregateStaticSignal never throws; an absent extractor or unsupported language degrades to "".
    // Guard: skip for cross-repo (service-triggered) runs — in those runs `diff` is the SERVICE
    // repo's tip commit, not the primary repo being tested, so static analysis of it yields no
    // actionable prompt context. Precedent: pipeline.ts line 1259 (`!isCode && generating && !triggerService`
    // for the context-map block) uses the identical three-condition guard for a pre-generation step.
    let staticSignalText: string | undefined;
    if (deps.aggregateStaticSignal && !isCode && generating && !triggerService) {
      const sig = await deps.aggregateStaticSignal({ sha, baseSha: opts.baseSha, repoDir: mirrorDir, changedFiles: [...parseDiffHunks(promptDiff).keys()], diff: promptDiff });
      staticSignalText = renderStaticSignal(sig) || undefined;
      if (sig.skipped.length) log(`[qa] static-signal: ${sig.symbols.length} symbols, ${sig.relations.length} relations, ${sig.complexity.length} hotspots (skipped: ${sig.skipped.length})`);
    }
```

The guard is `if (!isCode && generating && !triggerService)` — NOT `if (!isCode && generating)`. Rationale: in a service-triggered cross-repo run, `diff` belongs to the service repo, not the primary e2e repo. The static-signal would analyze the wrong codebase's diff and produce misleading prompt context.

Add `staticSignal: staticSignalText` to the `baseGenInput` object (line 1582 area), add `staticSignal?: string` to `GenerateInput` (in `src/pipeline.ts`, near `contextPack` at line 102), forward it into `ocInput` (verified lines 264-298) as `staticSignal: input.staticSignal`, add `staticSignal?: string` to `OpencodeRunInput` (in `src/integrations/opencode-client.ts`, near `contextPack` at line 509), and thread it into the assembled-prompt input so Step 12's `staticSignalContent` is populated.

Add `aggregateStaticSignal` to `PipelineDeps` as an **OPTIONAL** field and to `defaultPipelineDeps`. The field must be optional (marked with `?`) so that existing `pipeline.test.ts` stubs produced by the `deps()` helper (which omits it) continue to compile and run without any change — an absent dep means no static signal (fail-open). No existing test stub needs changing. The no-op default MUST be:

```typescript
    aggregateStaticSignal?: (input: StaticSignalInput) => Promise<StaticSignal>;
```

And in `defaultPipelineDeps`:

```typescript
    aggregateStaticSignal: (input) => Promise.resolve(EMPTY_STATIC_SIGNAL(input.sha)),
```

**NOT** `async () => EMPTY_STATIC_SIGNAL(sha)` — `sha` is NOT in scope where `defaultPipelineDeps` is defined. The `sha` must come from the `StaticSignalInput` parameter (the `input` arg), which carries it as `input.sha`. The real extractors replace this in Task 2.7.

**Critical: do NOT use `deps.aggregateStaticSignal!(...)`** — the non-null assertion crashes when test stubs omit the field. The call site (Step 13 above) already uses the presence-guarded form `if (deps.aggregateStaticSignal && ...)`. The `?` makes the field absent in all existing stubs = no static signal = no change to existing test behavior.

- [ ] **Step 14: Run full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS / clean (empty signal renders to "", no behavior change).

- [ ] **Step 15: Commit**

```bash
git add src/qa/static-signal/ src/integrations/prompts.ts src/integrations/opencode-client.ts src/pipeline.ts
git commit -m "feat(qa): static-signal scaffolding — registry, aggregator, renderer, fail-open wire"
```

## Task 2.1: difftastic extractor (real vs cosmetic change)

**Files:**
- Create: `src/qa/static-signal/exec.ts`, `src/qa/static-signal/semantic-diff.ts`, fixture, tests

- [ ] **Step 1: SPIKE — capture difftastic's real JSON output (two-file approach — CANONICAL)**

The committed invocation strategy is the **two-file JSON approach**: for each changed file, materialize the base and head blobs via `git show base:file` / `git show head:file` into temp files, run `difft --display json <tmpBase> <tmpHead>`, parse the output, and clean up the temp files. This is the approach used consistently throughout the plan and in the multi-file production path.

Run the spike:

```bash
mkdir -p src/qa/static-signal/__fixtures__
printf 'function f(){return 1}\n' > /tmp/a.js
printf 'function f(){ return 1 }\n' > /tmp/b.js   # whitespace-only
difft --display json /tmp/a.js /tmp/b.js > src/qa/static-signal/__fixtures__/difft-cosmetic.json
printf 'function f(){return 2}\n' > /tmp/c.js      # value change
difft --display json /tmp/a.js /tmp/c.js > src/qa/static-signal/__fixtures__/difft-real.json
```

Open both fixtures. Note the exact field that distinguishes cosmetic from real (difftastic reports per-chunk change kinds; a whitespace-only diff produces no semantic change chunks). Record the field names you will parse.

The alternative (`git -c diff.external=difft diff`) is NOT used in this plan — it was listed as an option during exploration but the two-file approach is simpler to control (no git config override, clean temp files, explicit per-file output, consistent with the fixture-capture pattern).

- [ ] **Step 2: Write the failing parser test against the fixture**

Create `src/qa/static-signal/semantic-diff.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDifftJson } from "./semantic-diff";

const fx = (n: string) => readFileSync(join(import.meta.dirname, "__fixtures__", n), "utf8");

test("parseDifftJson marks a whitespace-only change cosmetic", () => {
  const kinds = parseDifftJson(fx("difft-cosmetic.json"));
  assert.equal(kinds.some((k) => k.cosmetic), true);
});

test("parseDifftJson marks a value change non-cosmetic", () => {
  const kinds = parseDifftJson(fx("difft-real.json"));
  assert.equal(kinds.every((k) => !k.cosmetic), true);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --import tsx --test src/qa/static-signal/semantic-diff.test.ts`
Expected: FAIL — parser not defined.

- [ ] **Step 4: Implement the shared exec helper + parser**

Create `src/qa/static-signal/exec.ts`. It applies the SAME privilege-drop pattern as `src/qa/code-runner.ts` (verified: `resolveSandbox` at line 112, `sandboxSpawnOptions` at line 136) in addition to `scrubEnv`. When no sandbox is available (e.g. macOS local dev, non-root), it degrades to scrubEnv-only — matching the existing precedent in code-runner:

```typescript
import { spawn, type ChildProcess } from "node:child_process";
import { scrubEnv, resolveSandbox, sandboxSpawnOptions } from "../code-runner";

const DEFAULT_TIMEOUT_MS = 60_000;

function killTree(child: ChildProcess): void {
  try { if (child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
  catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
}

export interface RunResult { code: number | null; stdout: string; stderr: string }

// One bounded external-binary invocation. Privilege-dropped (sandbox uid/gid when available,
// scrubEnv always) to match the security boundary from code-runner.ts. Resolves (never rejects)
// with code=null on spawn error or timeout — every extractor treats "tool missing" as a clean
// degrade, not a throw.
export function runBinary(cmd: string, args: string[], cwd: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolve) => {
    const env = scrubEnv();
    const sandbox = resolveSandbox();
    const spawnOpts = sandboxSpawnOptions(env, sandbox);
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { cwd, ...spawnOpts, detached: true });
    } catch {
      resolve({ code: null, stdout: "", stderr: "spawn failed" });
      return;
    }
    let stdout = "", stderr = "", settled = false;
    const settle = (r: RunResult) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => { killTree(child); settle({ code: null, stdout, stderr: `timeout ${timeoutMs}ms` }); }, timeoutMs);
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => settle({ code: null, stdout, stderr: String(e) }));
    child.on("close", (code) => settle({ code, stdout, stderr }));
  });
}
```

Create `src/qa/static-signal/semantic-diff.ts`. Implement `parseDifftJson(json: string): FileChangeKind[]` against the EXACT field names you recorded in Step 1. The runner `extractSemanticDiff(diff: string, repoDir: string, sha: string, baseSha?: string)` uses the **two-file approach** (canonical — see Step 1): for each file, materialize base and head blobs via `git show <base>:<path>` / `git show <head>:<path>` into OS temp files, call `runBinary("difft", ["--display", "json", tmpBase, tmpHead], repoDir)`, parse the JSON output. The base ref is `baseSha ?? \`${sha}^\`` — for single-commit runs, `^` is the parent commit; for PR-range runs, `baseSha` is the range start. Document this fallback explicitly in a comment.

> **Why sha is a required parameter:** `extractSemanticDiff` must resolve the base blob for each changed file via `git show <baseRef>:<path>`. Without the commit SHA, it cannot compute the single-commit fallback (`sha^`). The `diff` string only carries file paths and line changes, not the commit identity. The signature `(diff, repoDir, sha, baseSha?)` makes the dependency explicit and consistent with `StaticSignalDeps.semanticDiff`.

**Temp-file cleanup (required — no leaks on failure):** wrap each per-file difft processing in a `try/finally` so the temp files are removed even when `git show` or `runBinary` throws:

```typescript
const tmpBase = join(tmpdir(), `difft-base-${randomUUID()}`);
const tmpHead = join(tmpdir(), `difft-head-${randomUUID()}`);
try {
  // write base and head blobs, run difft, parse
} finally {
  rmSync(tmpBase, { force: true });
  rmSync(tmpHead, { force: true });
}
```

`rmSync` with `{ force: true }` is safe even when the file was never created (e.g. if `git show` threw before writing). The parser is the unit under test; the runner degrades to `[]` when `code === null`.

**Security note (applies to difft, lizard, sg, tree-sitter):** difftastic, Lizard, sg, and tree-sitter PARSE untrusted watched-repo source but do NOT execute it — the risk is lower than code-mode execution (no install step, no test runner). They are still run under `scrubEnv` + sandbox privilege-drop for consistency with the security boundary documented in CLAUDE.md ("LLM agent is read-only on watched repos; only the deterministic orchestrator does git writes"). A parse crash (e.g. malformed source) is caught by the aggregator's `guard` wrapper and records a `skipped` note.

- [ ] **Step 5: Run to verify it passes**

Run: `node --import tsx --test src/qa/static-signal/semantic-diff.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/qa/static-signal/exec.ts src/qa/static-signal/semantic-diff.ts src/qa/static-signal/semantic-diff.test.ts src/qa/static-signal/__fixtures__/difft-*.json
git commit -m "feat(qa): difftastic extractor — cosmetic vs real change (spike-driven)"
```

## Task 2.2: Lizard extractor (cyclomatic complexity)

**Files:**
- Create: `src/qa/static-signal/complexity.ts`, fixture, test

- [ ] **Step 1: SPIKE — capture Lizard's machine output**

```bash
printf 'function big(x){\n if(x>0){for(let i=0;i<x;i++){if(i%2){}}}\n return x\n}\n' > /tmp/big.js
lizard --csv /tmp/big.js > src/qa/static-signal/__fixtures__/lizard-big.csv
```

Open the CSV. Record the column order (Lizard CSV columns are: nloc, ccn, token, param, length, location, file, function, long_name, start_line, end_line — verify against YOUR output).

- [ ] **Step 2: Write the failing parser test**

Create `src/qa/static-signal/complexity.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLizardCsv } from "./complexity";

test("parseLizardCsv extracts ccn/nloc/function/line, repo-relative", () => {
  const csv = readFileSync(join(import.meta.dirname, "__fixtures__", "lizard-big.csv"), "utf8");
  const hotspots = parseLizardCsv(csv, "/tmp");
  const big = hotspots.find((h) => h.function === "big");
  assert.ok(big);
  assert.ok(big!.ccn >= 3);
  assert.equal(typeof big!.line, "number");
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --import tsx --test src/qa/static-signal/complexity.test.ts`
Expected: FAIL — parser not defined.

- [ ] **Step 4: Implement**

Create `src/qa/static-signal/complexity.ts`. `parseLizardCsv(csv, repoDir)` splits lines, maps the columns recorded in Step 1 to `ComplexityHotspot`, normalizes the file path relative to `repoDir` (reuse the project's path-normalization approach), and filters to a useful threshold (`ccn >= 5`, to keep only hotspots). `extractComplexity(files, repoDir)` runs `lizard --csv <files>` via `runBinary`, returns `parseLizardCsv(stdout)` or `[]` when `code === null`.

- [ ] **Step 5: Run + commit**

Run: `node --import tsx --test src/qa/static-signal/complexity.test.ts`
Expected: PASS.

```bash
git add src/qa/static-signal/complexity.ts src/qa/static-signal/complexity.test.ts src/qa/static-signal/__fixtures__/lizard-big.csv
git commit -m "feat(qa): Lizard extractor — cyclomatic complexity hotspots"
```

## Task 2.3: tree-sitter symbols extractor

**Files:**
- Create: `src/qa/static-signal/symbols.ts`, queries, fixtures, test
- Modify: `package.json` (add `web-tree-sitter` + grammar wasm deps)

- [ ] **Step 1: SPIKE — confirm grammar loading and node names per language**

Add deps: `npm install web-tree-sitter tree-sitter-wasms` (or vendor the `.wasm` grammars for javascript, typescript, tsx, java). Write a throwaway script that parses one `.ts` and one `.java` file and prints the root node's named children types. Record the node type names for declarations: TS → `function_declaration`, `method_definition`, `class_declaration`, `lexical_declaration`; Java → `method_declaration`, `class_declaration`, `interface_declaration`. (These differ per grammar — confirm against YOUR grammar versions; this is the refuted-claim cost.)

- [ ] **Step 2: Create the per-language query files**

Create `src/qa/static-signal/queries/typescript.scm` and `queries/java.scm` with tree-sitter queries capturing declarations and their name + signature span. Example (`typescript.scm`):

```scheme
(function_declaration name: (identifier) @name) @decl
(method_definition name: (property_identifier) @name) @decl
(class_declaration name: (type_identifier) @name) @decl
```

`java.scm`:

```scheme
(method_declaration name: (identifier) @name) @decl
(class_declaration name: (identifier) @name) @decl
(interface_declaration name: (identifier) @name) @decl
```

- [ ] **Step 3: Write the failing test against fixtures**

Create fixtures `__fixtures__/sample.ts` and `__fixtures__/Sample.java` with a couple of declarations each. Create `src/qa/static-signal/symbols.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { extractSymbols } from "./symbols";

test("extractSymbols finds TS functions with signatures", async () => {
  const syms = await extractSymbols(["sample.ts"], join(import.meta.dirname, "__fixtures__"));
  const pay = syms.find((s) => s.name === "pay");
  assert.ok(pay);
  assert.equal(pay!.kind, "function");
  assert.match(pay!.signature, /pay/);
});

test("extractSymbols finds Java methods", async () => {
  const syms = await extractSymbols(["Sample.java"], join(import.meta.dirname, "__fixtures__"));
  assert.ok(syms.some((s) => s.kind === "method"));
});

test("extractSymbols skips unsupported languages", async () => {
  const syms = await extractSymbols(["x.go"], join(import.meta.dirname, "__fixtures__"));
  assert.deepEqual(syms, []);
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `node --import tsx --test src/qa/static-signal/symbols.test.ts`
Expected: FAIL — `extractSymbols` not defined.

- [ ] **Step 5: Implement**

Create `src/qa/static-signal/symbols.ts`. `extractSymbols(files, repoDir)`:
- Group files by language via `groupByLanguage`; skip unsupported.
- Lazy-init the `web-tree-sitter` `Parser` and cache one parser per language (grammar load is the cost; cache it).
- For each file: read it, parse with the `Parser`, run the language query, and for each `@decl` capture build a `ChangedSymbol` — `name` from `@name`, `kind` from the node type mapped to a friendly label (`function_declaration`→`function`, `method_*`→`method`, `class_*`→`class`), `signature` = the declaration's first line (text up to the body's opening brace, trimmed), `line` = node start row + 1.
  > **Limitation — no per-file timeout:** `web-tree-sitter`'s `parse()` is synchronous WASM and cannot be interrupted by `setTimeout`. A per-file timeout of the kind you might use for async operations is NOT implementable here. Pathological inputs are mitigated by: (a) the aggregator's `guard` wrapper catching any thrown exception (a parse crash records a `skipped` note and moves on), and (b) if stalls are ever observed in practice, parsing can be moved into a `worker_threads` Worker with `worker.terminate()` as the interrupt — but that is a follow-up, not part of this plan. Do NOT claim a per-file timeout in code comments; the API cannot deliver one.
- Wrap grammar load in try/catch: a missing grammar for a language pushes nothing and lets the aggregator's guard record it (return `[]` for that language). Any per-file parse crash (malformed source, timeout) is caught by the aggregator's `guard` wrapper — the file contributes zero symbols rather than aborting the whole extractor.

- [ ] **Step 6: Run + commit**

Run: `node --import tsx --test src/qa/static-signal/symbols.test.ts`
Expected: PASS.

```bash
git add src/qa/static-signal/symbols.ts src/qa/static-signal/queries/ src/qa/static-signal/__fixtures__/sample.ts src/qa/static-signal/__fixtures__/Sample.java src/qa/static-signal/symbols.test.ts package.json package-lock.json
git commit -m "feat(qa): tree-sitter symbol+signature extractor (ts/js/java)"
```

## Task 2.4: tree-sitter relations (intra-repo import graph)

**Files:**
- Create: `src/qa/static-signal/relations.ts`, query additions, test

- [ ] **Step 1: SPIKE — capture import node shapes**

Using the Step 2.3 spike harness, print the node types for imports: TS → `import_statement` with `string` source; Java → `import_declaration` with `scoped_identifier`. Record them.

- [ ] **Step 2: Write the failing test**

Add fixtures where `sample.ts` imports from `./order`. Create `src/qa/static-signal/relations.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { extractRelations } from "./relations";

test("extractRelations links a changed file to its imported changed file", async () => {
  const edges = await extractRelations(["sample.ts", "order.ts"], join(import.meta.dirname, "__fixtures__"));
  assert.ok(edges.some((e) => e.from.endsWith("sample.ts") && e.to.endsWith("order.ts")));
});

test("extractRelations keeps unresolved imports as module specifiers", async () => {
  const edges = await extractRelations(["sample.ts"], join(import.meta.dirname, "__fixtures__"));
  // an import of an external package resolves to the specifier, not a repo file
  assert.ok(edges.every((e) => typeof e.to === "string"));
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --import tsx --test src/qa/static-signal/relations.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement**

Create `src/qa/static-signal/relations.ts`. `extractRelations(files, repoDir)`:
- Parse each supported file (reuse the cached parsers from `symbols.ts` — export the parser-cache helper from there to avoid duplication).
- Extract import specifiers per file.
- Resolve relative specifiers (`./`, `../`) against the file's dir to a repo-relative path; try the supported extensions to land on a real changed file. Keep the EDGE only when `to` resolves to ANOTHER file in the changed set (intra-repo relation between changed files) OR keep it with `to` = raw specifier when unresolved (still informative). `via` = the specifier/symbol.
- This is the "how classes relate" signal for interconnected flows. Cross-repo (microservices) is NOT resolved here — it stays with the existing `services[]`/`context.json` machinery (decision 4).

- [ ] **Step 5: Run + commit**

Run: `node --import tsx --test src/qa/static-signal/relations.test.ts`
Expected: PASS.

```bash
git add src/qa/static-signal/relations.ts src/qa/static-signal/relations.test.ts src/qa/static-signal/__fixtures__/order.ts
git commit -m "feat(qa): tree-sitter intra-repo relation graph for interconnected flows"
```

## Task 2.5: ast-grep patterns extractor (with regex fallback)

**Files:**
- Create: `src/qa/static-signal/patterns.ts`, rule files, fixture, test

- [ ] **Step 1: SPIKE — capture ast-grep JSON for one rule**

```bash
printf 'fetch("/api/x").then(r=>r.json())\n' > /tmp/p.js
sg run --pattern 'fetch($$$)' --json /tmp/p.js > src/qa/static-signal/__fixtures__/astgrep-fetch.json
```

Open the JSON; record the match shape (file, range, metaVariables). Decide the initial rule set per language (e.g. `api-call` → `fetch`/`axios`/`HttpClient`; `form` → `<form>`/`FormGroup`).

- [ ] **Step 2: Write the failing test**

Create `src/qa/static-signal/patterns.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAstGrepJson, patternsForLanguage } from "./patterns";

test("parseAstGrepJson maps matches to {file, pattern}", () => {
  const json = readFileSync(join(import.meta.dirname, "__fixtures__", "astgrep-fetch.json"), "utf8");
  const matches = parseAstGrepJson(json, "api-call", "/tmp");
  assert.ok(matches.some((m) => m.pattern === "api-call" && m.source === "ast-grep"));
});

test("patternsForLanguage falls back to regex when language has no ast-grep rules", () => {
  // 'go' has no rules → regex fallback path is selected (decision 2).
  // patternsForLanguage accepts `string` (NOT `LanguageId`) so unsupported languages
  // like "go" resolve to "regex" without a TypeScript type error.
  assert.equal(patternsForLanguage("go"), "regex");
  assert.equal(patternsForLanguage("typescript"), "ast-grep");
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --import tsx --test src/qa/static-signal/patterns.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement**

Create `src/qa/static-signal/patterns.ts`:
- `patternsForLanguage(lang: string): "ast-grep" | "regex"` — parameter is `string`, NOT `LanguageId`, so unsupported languages (e.g. `"go"`) resolve to `"regex"` without a type error. Returns `"ast-grep"` for languages with a rule set (ts/js/java), `"regex"` otherwise.
- `parseAstGrepJson(json, pattern, repoDir)` maps ast-grep matches to `ChangePattern[]` with `source: "ast-grep"`.
- `extractPatterns(files, repoDir, diff)`: for supported languages, run `sg` with the rule set via `runBinary` and parse; for unsupported languages present in the diff, call the EXISTING `detectStructuralPatterns` from `src/qa/learning/structural-pattern.ts` and map its output to `ChangePattern[]` with `source: "regex"` (decision 2 — single `patterns` field, no double signal). Deduplicate by `(file, pattern)`.

- [ ] **Step 5: Run + commit**

Run: `node --import tsx --test src/qa/static-signal/patterns.test.ts`
Expected: PASS.

```bash
git add src/qa/static-signal/patterns.ts src/qa/static-signal/patterns.test.ts src/qa/static-signal/__fixtures__/astgrep-fetch.json
git commit -m "feat(qa): ast-grep pattern extractor with regex fallback (no double signal)"
```

## Task 2.6: Install the binaries in the orchestrator image

**Files:**
- Modify: `Dockerfile` (after the code-mode runtimes block ~line 45, before the sandbox user ~line 75)

- [ ] **Step 1: Add the install block**

In `Dockerfile`, after the `cargo rustc ... maven gradle` block (line 45) add:

```dockerfile
# Deterministic static-signal extractors (Stage 2). Pinned for reproducibility; pick arch at build.
RUN pip3 install --no-cache-dir --break-system-packages lizard==1.17.31
# ast-grep publishes ONLY .zip Linux assets (app-x86_64-unknown-linux-gnu.zip /
# app-aarch64-unknown-linux-gnu.zip) — there is no .tar.gz for ast-grep on any release.
# The zip contains two binaries: sg (small, the one we need) and ast-grep (large alias).
# We extract ONLY sg. unzip -j strips any directory prefix and places sg directly in /usr/local/bin.
# difft IS a .tar.gz — that is correct and kept as-is.
RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/*
RUN ARCH="$(dpkg --print-architecture)" \
  && case "$ARCH" in \
       amd64) DIFFT_T=x86_64-unknown-linux-gnu; SG_T=x86_64-unknown-linux-gnu ;; \
       arm64) DIFFT_T=aarch64-unknown-linux-gnu; SG_T=aarch64-unknown-linux-gnu ;; \
       *) echo "unsupported arch for static-signal binaries: $ARCH" >&2; exit 1 ;; \
     esac \
  && curl -fsSL "https://github.com/Wilfred/difftastic/releases/download/0.65.0/difft-${DIFFT_T}.tar.gz" | tar -C /usr/local/bin -xz difft \
  && curl -fsSL -o /tmp/sg.zip "https://github.com/ast-grep/ast-grep/releases/download/0.39.5/app-${SG_T}.zip" \
  && unzip -j /tmp/sg.zip sg -d /usr/local/bin \
  && rm /tmp/sg.zip
```

**Key decisions (FIX A):**
- **ast-grep releases ONLY `.zip` Linux assets** (`app-x86_64-unknown-linux-gnu.zip`, `app-aarch64-unknown-linux-gnu.zip`) — no `.tar.gz` exists for ast-grep on any release. The previous iteration wrongly assumed `.tar.gz`. The zip contains both `sg` (small) and `ast-grep` (large alias); we extract ONLY `sg`.
- **`unzip` is added** to an `apt-get install --no-install-recommends` step (required for the `.zip` extraction).
- **`unzip -j /tmp/sg.zip sg -d /usr/local/bin`** extracts ONLY the `sg` binary, dropping directory structure (`-j`).
- **difft stays as `.tar.gz`** — that asset name IS correct for difftastic releases.
- **No `2>/dev/null || true`** — failures must be loud. If the download or extraction fails, the build breaks rather than silently producing an image without the binary. A missing binary at runtime degrades gracefully (extractor returns `[]`), but a missing binary because the Dockerfile silently skipped the install step is an operational error, not a valid degrade.
- Verify the release URLs and binary names against the installed local versions (the SPIKE tasks already validated them locally).

`web-tree-sitter` + grammar wasm come from `npm install` — already covered by the existing `RUN npm install`.

- [ ] **Step 2: Build to verify**

Run: `docker build -t panchito-test .`
Expected: build succeeds; the three binaries are on PATH.
Verify: `docker run --rm panchito-test sh -c "difft --version && lizard --version && sg --version"`
Expected: all three print versions.

- [ ] **Step 3: Commit**

```bash
git add Dockerfile
git commit -m "build: install difftastic, lizard, ast-grep in orchestrator image"
```

## Task 2.7: Wire real extractors into `defaultPipelineDeps` + extensibility test

**Files:**
- Modify: `src/pipeline.ts` (`defaultPipelineDeps.aggregateStaticSignal`)
- Create: `src/qa/static-signal/aggregate.defaults.ts` (the real `StaticSignalDeps`)
- Test: `src/qa/static-signal/extensibility.test.ts`

- [ ] **Step 1: Assemble the real deps**

Create `src/qa/static-signal/aggregate.defaults.ts`:

```typescript
import type { StaticSignalDeps } from "./aggregate";
import { extractSymbols } from "./symbols";
import { extractRelations } from "./relations";
import { extractComplexity } from "./complexity";
import { extractSemanticDiff } from "./semantic-diff";
import { extractPatterns } from "./patterns";

// The production extractor set. Each is independently fail-open via the aggregator's guard.
export const defaultStaticSignalDeps: StaticSignalDeps = {
  symbols: extractSymbols,
  relations: extractRelations,
  complexity: extractComplexity,
  semanticDiff: extractSemanticDiff,
  patterns: extractPatterns,
};
```

- [ ] **Step 2: Wire into the pipeline default**

In `src/pipeline.ts` `defaultPipelineDeps`, replace the Task 2.0 no-op with:

```typescript
    aggregateStaticSignal: (input) => aggregateStaticSignal(input, defaultStaticSignalDeps),
```

Import `aggregateStaticSignal` and `defaultStaticSignalDeps`.

- [ ] **Step 3: Write the extensibility + agnosticism test**

Create `src/qa/static-signal/extensibility.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { aggregateStaticSignal } from "./aggregate";
import { SUPPORTED_LANGUAGES } from "./languages";

test("a new language is added by ONE registry entry (guard: ruby unsupported today)", async () => {
  assert.equal(SUPPORTED_LANGUAGES.has("ruby" as never), false);
  const sig = await aggregateStaticSignal({ sha: "x", repoDir: "/r", changedFiles: ["app.rb"], diff: "" }, {});
  assert.deepEqual(sig.languages, []);
  assert.match(sig.skipped.join(" "), /no changed file is in a supported language/);
});

test("signal is project-agnostic: no app/config reference in the module", async () => {
  // structural guard: the static-signal module must never import from config/ or name an app
  const { readFileSync, readdirSync } = await import("node:fs");
  for (const f of readdirSync(import.meta.dirname).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
    const src = readFileSync(`${import.meta.dirname}/${f}`, "utf8");
    assert.equal(/config\/apps|portfolio|petclinic/.test(src), false, `${f} must be project-agnostic`);
  }
});
```

- [ ] **Step 4: Run full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 5: Document extension steps**

Create `src/qa/static-signal/README.md` documenting: to add a language, (1) add it to `SUPPORTED_LANGUAGES` + `EXT_TO_LANGUAGE` in `languages.ts`, (2) add `queries/<lang>.scm` and the grammar wasm, (3) add ast-grep rules (or rely on regex fallback). Note that Lizard and difftastic are language-agnostic and need no per-language config.

- [ ] **Step 6: Commit**

```bash
git add src/qa/static-signal/aggregate.defaults.ts src/pipeline.ts src/qa/static-signal/extensibility.test.ts src/qa/static-signal/README.md
git commit -m "feat(qa): wire static-signal extractors into pipeline; extensibility guard"
```

**Stage 2 gate:** `npm test` + `npm run typecheck` green; `docker build` succeeds; a diff touching `.ts`/`.java` files yields a non-empty `## Static analysis` prompt section; a diff touching only unsupported languages degrades to no section with a logged skip note.

---

## Self-Review

**Spec coverage:**
- PR-range blast radius → Tasks 1.1–1.4 (getRangeDiff + baseSha threading through webhook/CLI/pipeline). ✔
- Branch coverage → Tasks 1.5–1.8 (types, lcov+istanbul parsers, fold, collect+report, signal-only). ✔
- difftastic, Lizard, tree-sitter, ast-grep → Tasks 2.1, 2.2, 2.3, 2.5. ✔
- Configured for JS + Java initially, easily extensible → `languages.ts` registry + per-language queries/rules; Task 2.7 extensibility test + README. ✔
- No overlap / no contamination → decisions 1–3; single `patterns` field with ast-grep-or-regex (Task 2.5); tree-sitter pre-computes, Serena untouched. ✔
- Interconnected flows across classes/repos → relations graph (Task 2.4) intra-repo; cross-repo reuses `services[]`/`context.json` (decision 4). ✔
- Project-agnostic (java+js only for now) → registry keyed by language; Task 2.7 agnosticism guard test. ✔
- Integrates cleanly, fail-open → aggregator guard (Task 2.0); signal-only, never blocks publish.✔

**Placeholder scan:** External-tool output formats are intentionally captured by SPIKE steps (2.1/2.2/2.3/2.5 Step 1) into committed fixtures before any parser is written — this is by design, not a placeholder. Plumbing hops that reference adjacent types (WebhookPayload, enqueueTrackedRun, PipelineDeps) name the exact function/site and the exact field to add.

**Type consistency:** `StaticSignal` field names are identical across `types.ts`, `render.ts`, `aggregate.ts`, and the extractors. `CoveredBranches` shape (`{total, taken}`) is identical in both parsers and `computeChangeCoverage`. `getRangeDiff`/`baseSha` naming consistent across repo-mirror, types, webhook, cli, pipeline.

**Fan-out coverage:** `staticSignal` is wired through BOTH the single-agent path (`OpencodeRunInput` → `buildPromptAssembled`) AND the parallel-worker path (`ParallelWorkerInput` → `buildWorkerPromptAssembled`). The worker construction site in `runOpencodeParallel` (verified line 1361 in `src/integrations/opencode-client.ts`) propagates `input.staticSignal` into every `ParallelWorkerInput` it builds. Omitting this second path would silently discard the static signal in `diff` mode with `parallelDiff: true` — the dominant fan-out path. Task 2.0 Step 12 documents both paths explicitly.

**Semantic diff sha dependency:** `StaticSignalDeps.semanticDiff` takes `(diff, repoDir, sha, baseSha?)` — the commit SHA is a required parameter because the difft two-file approach needs it to compute the base blob ref (`baseSha ?? \`${sha}^\``). The aggregator guard call at line 1089 passes `input.sha` and `input.baseSha` consistently.

**Known follow-ups (out of scope, noted not silently dropped):** V8/JaCoCo branch parsing (Task 1.8 returns empty branches for those paths); raising any signal from `signal` to a publish gate; mutation testing's multi-language extension (separate effort).

---

## Open issues (resolve during execution — not fixing now)

These are KNOWN items deliberately deferred to TDD execution. They are documented here so they are not silently dropped.

1. **`promptDiff` capping vs. static signal scope.** `promptDiff` (the diff content fed to the agent) is capped for large diffs to fit the prompt budget. As a consequence, `aggregateStaticSignal` receives only the capped diff as `input.diff` (and derives `changedFiles` from `parseDiffHunks(promptDiff)`). This means the static signal, like `changeCoverage`, analyzes only the files the agent was shown — not the full commit if the diff was capped. This is intentional consistency with coverage; uncapped diff analysis would produce a signal the agent cannot use because it never saw those files.

2. **`collectBranchCoverage` is code-mode-scoped: e2e runs return `null`.** `defaultPipelineDeps.collectBranchCoverage` returns `null` when `input.target !== "code"` (e2e/V8 branch data requires parsing V8's coverage format for branch records, which is out of scope for this plan). As a result, `cc.branches` is always `null` for e2e runs. This is a stated limitation, not a bug — it degrades identically to line coverage's `measured=false` path and never blocks publish.

3. **tree-sitter has no in-thread parse timeout.** `web-tree-sitter`'s `parse()` is synchronous WASM and cannot be interrupted by `setTimeout`. There is no in-thread per-file timeout. Mitigation: (a) the aggregator's `guard` wrapper catches any thrown exception (a parse crash records a `skipped` note and moves on); (b) if stalls are observed in practice, parsing can be moved into a `worker_threads` Worker with `worker.terminate()` as the interrupt. That is a future hardening option, not part of this plan. Do NOT claim a per-file timeout in code comments; the WASM API cannot deliver one.

4. **Per-invocation `resolveSandbox()` does an `existsSync` on the hot path.** `exec.ts` calls `resolveSandbox()` on every external binary invocation. `resolveSandbox` (pattern from `src/qa/code-runner.ts` line 112) does a filesystem existence check on each call. This is an acceptable cost: it is the pre-existing pattern from code-runner and the static-signal layer runs once per pipeline run, not per-request. Revisit only if large diffs (many changed files × multiple extractors) show measurable overhead in profiling.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-21-deterministic-static-signal-layer.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
