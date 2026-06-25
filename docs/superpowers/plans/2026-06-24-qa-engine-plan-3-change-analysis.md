# QA Engine — Plan 3: Change Analysis

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the `change-analysis` bounded context (spec §5.3(2)) inside `qa-engine/src/contexts/change-analysis/`, plus the ONE canonical `DiffParserService` in the shared-kernel (`qa-engine/src/shared-kernel/diff-parser/`) that consolidates the **3 real diff-content parsers** (`parseDiffHunks`, `parseChangedFiles`, `changedFilesFromDiff`) and the user's `changed-elements.ts` extraction into a single source of truth. The context owns `classifyCommit` (the token-spend gate), the `LanguageId` ONE-registry (killing the `SUPPORTED_LANGUAGES` vs `AST_GREP_LANGUAGES` drift), typed `ExtractorSkipped` degradation events (replacing opaque `skipped` strings), the `StaticSignal` Sha-keyed read-model, the change VOs, the `analyze-change` use-case, and 5 extractor **adapters that WRAP the proven `src/qa/static-signal/` extractors** (wrap-then-replace — do NOT rewrite tree-sitter / ast-grep / lizard / difftastic logic). All in parallel to `src/`, touching **no** `src/` runtime. Plan 1's characterization comparator must keep passing; `npm test` + `npm run typecheck` stay green.

**Architecture:** This implements spec §5.3(2) (the `change-analysis` context) and §7.2 Step 5 (lift `classifyCommit` + static-signal as a leaf/pure context; the 3 diff-content parsers consolidate into `DiffParserService`). The context is hexagonal: pure **domain** (`CommitClassification` logic, `DiffParserService`, `StaticSignal`, `LanguageId`, the VOs, `ExtractorSkipped`), an **application** layer (`analyze-change` use-case + the refined extractor ports + `VcsReadPort`), and **infrastructure** (the 5 extractor adapters wrapping `src/qa/static-signal/*`, and `GitMirrorReadAdapter` for typed VCS reads). `DiffParserService`, `SandboxedBinaryRunner`, `ProcessKillPort`, and `scrubEnv` are **consumed FROM the shared-kernel / shared-infrastructure** (Plan 2 built the runner + kill; Plan 3 adds only `diff-parser/` to the kernel). **Signal-only by contract: change-analysis NEVER blocks publish** — every extractor fails open with a typed `ExtractorSkipped`, every degrade returns an empty signal, never a throw that reaches the orchestrator.

**Tech Stack:** TypeScript 5.6 (strict, `noUncheckedIndexedAccess`, `noEmit`), `tsx`, `node:test` + `node:assert/strict`, path aliases (`@kernel/*`, `@contexts/*`) from `qa-engine/tsconfig.json`, `.ts` import extensions (`allowImportingTsExtensions`). The wrapped binaries (tree-sitter WASM, `sg`, `python3 -m lizard`, `difft`) are the *deliberately-uncovered boundary* — adapter tests assert the **wrapping/mapping** (delegation, typed-skip on tool-missing), not the binaries themselves, exactly as `src/qa/static-signal/*.test.ts` stubs them today.

This plan covers spec §5.3(2), §5.2 (the `diff-parser/` kernel module + the `change-analysis/` tree), and §7.2 Step 5's change-analysis slice. It does **NOT** touch the `src/` runtime, the git-**status** parsers (`parseStatusOutput` → `workspace-and-publication`; `parsePorcelain` → `test-execution`), Seam-2 (`opencode-client ⇄ prompts`, Plan 5), `generation`/prompts, the core orchestrator (Plan 6), or the cutover (Plan 7). It does **NOT** delete or edit the user's `src/qa/changed-elements.ts` — it CONSOLIDATES that logic into the kernel `DiffParserService`; `src/` keeps its copy until Step 6 cutover.

---

## File Structure

**Created — shared-kernel `diff-parser/` (production; the ONE canonical parser)**
- `qa-engine/src/shared-kernel/diff-parser/diff-parser.service.ts` — `DiffParserService` consolidating `parseDiffHunks` (changed lines, new-side), `parseChangedFiles` (all changed file paths), `changedFilesFromDiff` (modified-only paths), and `extractChangedElements` + `changedElementsFromGuidance` (HTML selector signals). Pure, no I/O.
- `qa-engine/src/shared-kernel/diff-parser/changed-lines.ts` — `ChangedLines` type (`Map<string, Set<number>>`) + `DiffHunk` VO.
- `qa-engine/src/shared-kernel/diff-parser/changed-element.ts` — `ChangedElement` VO (the user's interface, lifted verbatim in shape).

**Created — `change-analysis/domain/` (production)**
- `qa-engine/src/contexts/change-analysis/domain/language-id.ts` — the ONE `LanguageId` registry (kills the drift): `LanguageId` type, `LanguageRegistry` (the single supported set + `ext → lang` map + `languageForFile` + `groupByLanguage`).
- `qa-engine/src/contexts/change-analysis/domain/commit-classification.ts` — `classifyCommit` ported verbatim in behavior; `CommitType`/`CommitAction`/`CommitIntent`/`CommitClassification` VOs.
- `qa-engine/src/contexts/change-analysis/domain/static-signal.ts` — `StaticSignal` Sha-keyed read-model (carries typed `ExtractorSkipped[]`, NOT `string[]`) + the change VOs (`ChangedSymbol`/`RelationEdge`/`ComplexityHotspot`/`FileChangeKind`/`ChangePattern`) + `EMPTY_STATIC_SIGNAL`.

**Created — `change-analysis/application/` (production)**
- `qa-engine/src/contexts/change-analysis/application/ports/index.ts` — **refined** (Plan 2 left a stub): the 5 extractor ports keyed on the domain VOs + `VcsReadPort` + `ExtractorSkipped`.
- `qa-engine/src/contexts/change-analysis/application/analyze-change.use-case.ts` — `analyzeChange` (fan out the 5 extractors fail-open, assemble `StaticSignal`).

**Created — `change-analysis/infrastructure/` (production; wrap-then-replace)**
- `qa-engine/src/contexts/change-analysis/infrastructure/extractors/tree-sitter-symbol.adapter.ts` — wraps `extractSymbols`.
- `qa-engine/src/contexts/change-analysis/infrastructure/extractors/tree-sitter-relation.adapter.ts` — wraps `extractRelations`.
- `qa-engine/src/contexts/change-analysis/infrastructure/extractors/lizard-complexity.adapter.ts` — wraps `extractComplexity`.
- `qa-engine/src/contexts/change-analysis/infrastructure/extractors/difftastic-semantic-diff.adapter.ts` — wraps `extractSemanticDiff`.
- `qa-engine/src/contexts/change-analysis/infrastructure/extractors/ast-grep-pattern.adapter.ts` — wraps `extractPatterns`.
- `qa-engine/src/contexts/change-analysis/infrastructure/extractors/default-extractors.ts` — the production extractor map (mirrors `aggregate.defaults.ts`).
- `qa-engine/src/contexts/change-analysis/infrastructure/git-mirror-read.adapter.ts` — `GitMirrorReadAdapter` implementing `VcsReadPort` over the kernel `SandboxedBinaryRunner` (typed read side; no raw git argv leaking past the adapter).

**Created — tests (mirror under `qa-engine/test/`)**
- `qa-engine/test/shared-kernel/diff-parser/diff-parser.service.test.ts`
- `qa-engine/test/contexts/change-analysis/domain/language-id.test.ts`
- `qa-engine/test/contexts/change-analysis/domain/commit-classification.test.ts`
- `qa-engine/test/contexts/change-analysis/domain/static-signal.test.ts`
- `qa-engine/test/contexts/change-analysis/application/analyze-change.use-case.test.ts`
- `qa-engine/test/contexts/change-analysis/infrastructure/extractors/extractor-adapters.test.ts`
- `qa-engine/test/contexts/change-analysis/infrastructure/git-mirror-read.adapter.test.ts`

**Consumed (do NOT redefine — from Plan 2)**
- `@kernel/sha.ts` (`Sha`), `@kernel/blast-radius.ts` (`BlastRadius`), `@kernel/result.ts` (`Result`/`ok`/`err`/`isOk`), `@kernel/domain-error.ts` (`InfraError`).
- `qa-engine/src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts` (`SandboxedBinaryRunner`), `.../process-kill.adapter.ts`, `.../scrub-env.ts`.

**Frozen (do NOT edit)**
- All of `src/` runtime — including `src/qa/changed-elements.ts`, `src/qa/commit-classify.ts`, `src/qa/static-signal/*` (wrapped, never modified). `src/pipeline.ts` `PipelineDeps`/`runPipeline`, `src/types.ts` `RunOutcome`, `contract/openapi.json`.
- `qa-engine/test/contexts/ports-compile.test.ts` — the existing port-barrel compile test stays green after the change-analysis port refinement (it imports the barrel; the refined exports must still compile).

---

## Task 0: Re-verify reality vs HEAD

The user edits `src/` in parallel; the snapshot drifts. Lock today's facts before depending on them. No code — a checklist run, recorded inline. If anything diverges, adjust the ported logic to match HEAD (the proven `src/` code is the source of truth, never this plan's quoted snippet).

**Files:** none (record findings in Task 1's commit body if anything diverged).

- [ ] **Step 1: Confirm the 3 diff-content parsers still live where the spec says**

```bash
cd /Users/arielyumn/Desktop/TRABAJO/ai-pipeline
rg -n 'export function parseDiffHunks'        src/qa/change-coverage.ts
rg -n 'export function parseChangedFiles'     src/qa/commit-classify.ts
rg -n 'function changedFilesFromDiff'         src/qa/static-signal/semantic-diff.ts
```
Expected: one hit each (`parseDiffHunks` in change-coverage.ts; `parseChangedFiles` in commit-classify.ts; `changedFilesFromDiff` — module-private — in semantic-diff.ts). If a function moved, port from its NEW location.

- [ ] **Step 2: Confirm the git-STATUS parsers are NOT in this area (they stay out)**

```bash
rg -n 'parseStatusOutput|parsePorcelain' src/qa/ src/server/ 2>/dev/null
```
Expected: hits only in `confinement`/code-runner-style files (status parsing), NONE in change-coverage/commit-classify/static-signal. These belong to `workspace-and-publication` / `test-execution`. Do NOT pull them into `DiffParserService`.

- [ ] **Step 3: Read the user's `changed-elements.ts` at HEAD (it is uncommitted WIP — re-read, never trust this plan's quote)**

```bash
git status --short src/qa/changed-elements.ts src/qa/changed-elements.test.ts
rg -n 'export (function|interface) (extractChangedElements|changedElementsFromGuidance|ChangedElement)' src/qa/changed-elements.ts
```
Expected: both files `??` (untracked WIP). `ChangedElement` interface + `extractChangedElements(diff)` + `changedElementsFromGuidance(guidance)` exported. The CURRENT file is the source of truth for the consolidation — diff this plan's quoted snippet against it before porting and use HEAD where they differ.

- [ ] **Step 4: Confirm the LanguageId registry DRIFT still exists**

```bash
rg -n 'AST_GREP_LANGUAGES'  src/qa/static-signal/patterns.ts
rg -n 'SUPPORTED_LANGUAGES' src/qa/static-signal/languages.ts
```
Expected: `patterns.ts:19` has its own `const AST_GREP_LANGUAGES = new Set([...])` — a **hardcoded duplicate** of `SUPPORTED_LANGUAGES`. This is the drift Task 3 kills. If `patterns.ts` already imports the shared set, skip the drift-fix assertion (but still build the one registry).

- [ ] **Step 5: Confirm the static-signal extractor surface (the wrap targets)**

```bash
rg -n 'export (async )?function (extractSymbols|extractRelations|extractComplexity|extractSemanticDiff|extractPatterns)' src/qa/static-signal/
rg -n 'export interface StaticSignal|export const EMPTY_STATIC_SIGNAL' src/qa/static-signal/types.ts
rg -n 'skipped' src/qa/static-signal/types.ts
```
Expected: 5 extractor exports; `StaticSignal` + `EMPTY_STATIC_SIGNAL` in types.ts; `skipped: string[]` field present (the opaque-string smell Task 4 replaces with `ExtractorSkipped[]`).

- [ ] **Step 6: Confirm the kernel building blocks Plan 3 consumes exist**

```bash
fd 'sha.ts|blast-radius.ts|result.ts|domain-error.ts' qa-engine/src/shared-kernel
fd 'sandboxed-binary-runner.ts|process-kill.adapter.ts|scrub-env.ts' qa-engine/src/shared-infrastructure
test -d qa-engine/src/shared-kernel/diff-parser && echo "diff-parser EXISTS (unexpected)" || echo "diff-parser ABSENT (Plan 3 creates it)"
```
Expected: the four kernel VO files + the three shared-infra files exist; `diff-parser/` is **ABSENT** (Plan 3 owns it). If `diff-parser/` already exists, a prior plan built it — read it and extend rather than recreate.

- [ ] **Step 7: Baseline gate is green before touching anything**

```bash
npm run typecheck && node --import ./test-setup.mjs --import tsx --test "qa-engine/test/**/*.test.ts"
```
Expected: typecheck clean; all existing qa-engine tests pass (Plan 1 + Plan 2 net). Record the test count. If red, STOP and report — Plan 3 must start from green.

---

## Task 1: The canonical `DiffParserService` — changed lines + changed files (kernel)

The 1st base-error fix: ONE diff parser instead of three. `DiffParserService.changedLines` ports `parseDiffHunks` (new-side line sets); `DiffParserService.changedFiles` ports `parseChangedFiles` (every changed path); `DiffParserService.modifiedFiles` ports `changedFilesFromDiff` (both-sides-present only). Pure, no I/O.

**Files:**
- `qa-engine/src/shared-kernel/diff-parser/changed-lines.ts` (create)
- `qa-engine/src/shared-kernel/diff-parser/diff-parser.service.ts` (create)
- `qa-engine/test/shared-kernel/diff-parser/diff-parser.service.test.ts` (create)

- [ ] **Step 1: Write the failing test for `changedLines` (ports `parseDiffHunks`)**

`qa-engine/test/shared-kernel/diff-parser/diff-parser.service.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";

const svc = new DiffParserService();

function diff(file: string, body: string[]): string {
  return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, ...body].join("\n");
}

test("changedLines: added lines are numbered on the new side", () => {
  const d = diff("src/a.ts", ["@@ -1,2 +1,3 @@", " ctx", "+added one", "+added two"]);
  const map = svc.changedLines(d);
  assert.deepEqual([...(map.get("src/a.ts") ?? new Set())].sort((x, y) => x - y), [2, 3]);
});

test("changedLines: pure deletion contributes no new lines (file absent)", () => {
  const d = diff("src/b.ts", ["@@ -1,2 +1,1 @@", " ctx", "-gone"]);
  const map = svc.changedLines(d);
  assert.equal(map.has("src/b.ts"), false);
});

test("changedLines: a '+++ '/'--- ' INSIDE hunk content is not mistaken for a header", () => {
  const d = diff("docs/x.md", ["@@ -1,1 +1,3 @@", " intro", "+--- a/fake", "+++ b/fake"]);
  const map = svc.changedLines(d);
  // both added lines belong to docs/x.md, not a phantom "fake" file
  assert.deepEqual([...(map.get("docs/x.md") ?? new Set())].sort((x, y) => x - y), [2, 3]);
  assert.equal(map.has("fake"), false);
});
```

- [ ] **Step 2: Run it — RED (module missing)**

```bash
node --import ./test-setup.mjs --import tsx --test "qa-engine/test/shared-kernel/diff-parser/diff-parser.service.test.ts"
```
Expected: fails to resolve `@kernel/diff-parser/diff-parser.service.ts`.

- [ ] **Step 3: Create the `ChangedLines` type**

`qa-engine/src/shared-kernel/diff-parser/changed-lines.ts`:
```ts
// file (repo-relative, POSIX) → set of 1-based line numbers on the NEW side. The unit the analyze
// and coverage phases intersect on. Carried verbatim from src/qa/change-coverage.ts CoveredLines.
export type ChangedLines = Map<string, Set<number>>;

// One unified-diff hunk header: the new-side start line + how many lines it spans.
export interface DiffHunk {
  file: string;
  newStart: number;
  newCount: number;
}
```

- [ ] **Step 4: Implement `DiffParserService.changedLines` (port `parseDiffHunks` verbatim in behavior)**

`qa-engine/src/shared-kernel/diff-parser/diff-parser.service.ts`:
```ts
// THE ONE canonical diff parser. Consolidates the 3 diff-CONTENT parsers that drifted across src/:
//   parseDiffHunks (change-coverage.ts)  → changedLines
//   parseChangedFiles (commit-classify.ts) → changedFiles
//   changedFilesFromDiff (semantic-diff.ts) → modifiedFiles
// plus the user's changed-elements extraction (extractChangedElements/changedElementsFromGuidance).
// The git-STATUS parsers (parseStatusOutput/parsePorcelain) are NOT diffs and stay in their own
// bounded contexts. Pure: no I/O, no spawn, deterministic.
import type { ChangedLines } from "./changed-lines.ts";

export class DiffParserService {
  // Added/modified lines per file, numbered on the NEW side. Pure deletions contribute nothing.
  changedLines(diff: string): ChangedLines {
    const changed: ChangedLines = new Map();
    let file: string | null = null;
    let newLine = 0;
    let inHunk = false;
    for (const raw of diff.split("\n")) {
      if (raw.startsWith("diff --git")) { file = null; inHunk = false; continue; }
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (hunk) { newLine = Number(hunk[1]); inHunk = true; continue; }
      if (!inHunk) {
        if (raw.startsWith("+++ ")) {
          const p = raw.slice(4).trim();
          file = p === "/dev/null" ? null : p.replace(/^[ab]\//, "").replace(/\t.*$/, "");
        }
        continue;
      }
      if (file === null) continue;
      const c = raw[0];
      if (c === "+") {
        let set = changed.get(file);
        if (!set) changed.set(file, (set = new Set()));
        set.add(newLine);
        newLine++;
      } else if (c === "-") { /* old side only */ }
      else if (c === "\\") { /* "\ No newline at end of file" */ }
      else { newLine++; }
    }
    return changed;
  }
}
```

- [ ] **Step 5: Run it — GREEN for `changedLines`**

```bash
node --import ./test-setup.mjs --import tsx --test "qa-engine/test/shared-kernel/diff-parser/diff-parser.service.test.ts"
```
Expected: the 3 `changedLines` tests pass.

- [ ] **Step 6: Write failing tests for `changedFiles` + `modifiedFiles`**

Append to the test file:
```ts
test("changedFiles: every changed path (added, modified, deleted) from the diff --git headers", () => {
  const d = [
    "diff --git a/src/added.ts b/src/added.ts",
    "--- /dev/null",
    "+++ b/src/added.ts",
    "@@ -0,0 +1,1 @@",
    "+new",
    "diff --git a/src/mod.ts b/src/mod.ts",
    "--- a/src/mod.ts",
    "+++ b/src/mod.ts",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
  ].join("\n");
  assert.deepEqual(svc.changedFiles(d).sort(), ["src/added.ts", "src/mod.ts"]);
});

test("modifiedFiles: only files present on BOTH sides (a pure add is excluded)", () => {
  const d = [
    "diff --git a/src/added.ts b/src/added.ts",
    "--- /dev/null",
    "+++ b/src/added.ts",
    "@@ -0,0 +1,1 @@",
    "+new",
    "diff --git a/src/mod.ts b/src/mod.ts",
    "--- a/src/mod.ts",
    "+++ b/src/mod.ts",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
  ].join("\n");
  // added.ts has --- /dev/null (not --- a/...), so it is NOT a modification
  assert.deepEqual(svc.modifiedFiles(d), ["src/mod.ts"]);
});
```

- [ ] **Step 7: Run it — RED (`changedFiles`/`modifiedFiles` undefined)**

```bash
node --import ./test-setup.mjs --import tsx --test "qa-engine/test/shared-kernel/diff-parser/diff-parser.service.test.ts"
```
Expected: `svc.changedFiles is not a function`.

- [ ] **Step 8: Implement `changedFiles` (port `parseChangedFiles`) + `modifiedFiles` (port `changedFilesFromDiff`)**

Add both methods to `DiffParserService`:
```ts
  // Every changed path from the `diff --git a/X b/Y` headers (added, modified, deleted). Ported
  // from commit-classify.ts parseChangedFiles: prefer the b/ side, fall back to a/.
  changedFiles(diff: string): string[] {
    const files: string[] = [];
    for (const line of diff.split("\n")) {
      const m = line.match(/^diff --git a\/(\S+) b\/(\S+)/);
      if (m) files.push(m[2] ?? m[1]!);
    }
    return files;
  }

  // Only files present on BOTH sides (modified). Ported from semantic-diff.ts changedFilesFromDiff:
  // a pure add (--- /dev/null) or pure delete (+++ /dev/null) is excluded.
  modifiedFiles(diff: string): string[] {
    const files: string[] = [];
    let basePath: string | null = null;
    let headPath: string | null = null;
    let afterDiffGit = false;
    for (const line of diff.split("\n")) {
      if (line.startsWith("diff --git ")) {
        if (basePath !== null && headPath !== null) files.push(headPath);
        afterDiffGit = true; basePath = null; headPath = null;
        continue;
      }
      if (!afterDiffGit) continue;
      if (line.startsWith("--- a/")) { basePath = line.slice(6).trim(); continue; }
      if (line.startsWith("+++ b/")) { headPath = line.slice(6).trim(); continue; }
      if (line.startsWith("@@")) afterDiffGit = false;
    }
    if (basePath !== null && headPath !== null) files.push(headPath);
    return files;
  }
```

- [ ] **Step 9: Run it — GREEN (all 5 tests)**

```bash
node --import ./test-setup.mjs --import tsx --test "qa-engine/test/shared-kernel/diff-parser/diff-parser.service.test.ts"
```
Expected: 5/5 pass.

- [ ] **Step 10: Typecheck + commit**

```bash
npm run typecheck
git add qa-engine/src/shared-kernel/diff-parser/ qa-engine/test/shared-kernel/diff-parser/
git commit -m "feat(kernel): DiffParserService consolidates the 3 diff-content parsers"
```
Expected: clean typecheck; one commit; only `qa-engine/` paths staged (never `git add -A`).

---

## Task 2: Consolidate the user's `changed-elements` extraction into `DiffParserService` (kernel)

The 4-vs-3 base-error: `changed-elements.ts` is the **4th consumer** of `parseDiffHunks`, not a 4th parser. Fold its `extractChangedElements` + `changedElementsFromGuidance` into `DiffParserService` so the single parser owns both line truth AND selector-signal extraction. **Re-read `src/qa/changed-elements.ts` at HEAD (Task 0 Step 3) and port THAT — the snippet below mirrors the current file but the live WIP wins on any difference.**

**Files:**
- `qa-engine/src/shared-kernel/diff-parser/changed-element.ts` (create)
- `qa-engine/src/shared-kernel/diff-parser/diff-parser.service.ts` (extend)
- `qa-engine/test/shared-kernel/diff-parser/diff-parser.service.test.ts` (extend)

- [ ] **Step 1: Write failing tests for `changedElements` (lift the decisive cases from `changed-elements.test.ts`)**

Append to the test file:
```ts
import { ChangedElement } from "@kernel/diff-parser/changed-element.ts";

function htmlDiff(lines: string[], file = "src/home.component.html"): string {
  return [
    `diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`,
    `@@ -1,3 +1,${lines.length + 2} @@`, ` <div>`, ...lines, ` </div>`,
  ].join("\n");
}

test("changedElements: data-cy → testId", () => {
  const els = svc.changedElements(htmlDiff([`+<button data-cy="submit-order">Place Order</button>`]));
  assert.ok(els.find((e) => e.testId === "submit-order"));
});

test("changedElements: routerLink literal resolves to href, not the attr name", () => {
  const els = svc.changedElements(htmlDiff([`+<a routerLink="/products">Products</a>`]));
  assert.ok(els.find((e) => e.href === "/products"));
  assert.ok(!els.some((e) => "routerLink" in (e as unknown as Record<string, unknown>)));
});

test("changedElements: bare relative routerLink (no leading / or #) is skipped", () => {
  const els = svc.changedElements(htmlDiff([`+<a routerLink="products">Products</a>`]));
  assert.equal(els.filter((e) => e.href !== undefined).length, 0);
});

test("changedElements: interpolated {{...}} text is skipped", () => {
  const els = svc.changedElements(htmlDiff([`+<button>{{ submitLabel }}</button>`]));
  assert.ok(!els.some((e) => e.text?.includes("{{")));
});

test("changedElements: pure TS diff → []", () => {
  const els = svc.changedElements(diff("src/svc.ts", ["@@ -1,2 +1,3 @@", " class X {", "+  private n = 0;", " }"]));
  assert.deepEqual(els, []);
});

test("changedElements: capped at 200 entries", () => {
  const lines = Array.from({ length: 250 }, (_, i) => `+<button data-cy="b-${i}">x</button>`);
  const d = [`diff --git a/h.html b/h.html`, `--- a/h.html`, `+++ b/h.html`, `@@ -1,5 +1,255 @@`, ...lines].join("\n");
  assert.ok(svc.changedElements(d).length <= 200);
});

test("changedElementsFromGuidance: QA stopwords are filtered, distinctive nouns kept", () => {
  const els = svc.changedElementsFromGuidance("test the contact form");
  const texts = els.map((e) => e.text?.toLowerCase());
  assert.ok(!texts.includes("test"));
  assert.ok(!texts.includes("form"));
  assert.ok(texts.includes("contact"));
});

test("changedElementsFromGuidance: empty string → []", () => {
  assert.deepEqual(svc.changedElementsFromGuidance(""), []);
});
```

- [ ] **Step 2: Run it — RED (`ChangedElement` + methods missing)**

```bash
node --import ./test-setup.mjs --import tsx --test "qa-engine/test/shared-kernel/diff-parser/diff-parser.service.test.ts"
```
Expected: cannot resolve `@kernel/diff-parser/changed-element.ts`.

- [ ] **Step 3: Create the `ChangedElement` VO (lift the user's interface verbatim in shape)**

`qa-engine/src/shared-kernel/diff-parser/changed-element.ts`:
```ts
// A stable HTML selector signal extracted from a diff's added lines (or from manual guidance).
// Shape lifted verbatim from src/qa/changed-elements.ts ChangedElement so callers migrate 1:1.
export interface ChangedElement {
  file: string;       // repo-relative; "" for guidance-derived entries
  line: number;       // 1-based new-side line; 0 for guidance-derived entries
  testId?: string;    // data-cy / data-testid / data-test
  id?: string;        // id="" value
  name?: string;      // name="" / formControlName value
  text?: string;      // visible inner text (button/link/heading/label)
  href?: string;      // resolved path (href OR routerLink → href), / or # only
  role?: string;      // best-effort tag → ARIA role
  raw: string;        // trimmed added line (debug/telemetry)
}
```

- [ ] **Step 4: Port `extractChangedElements` + `changedElementsFromGuidance` as private helpers + public methods**

Extend `diff-parser.service.ts` — **re-read `src/qa/changed-elements.ts` at HEAD first** and copy the FULL file logic verbatim (constants, all helpers, both exported functions). Do NOT use a paraphrase or the snippets below as the authoritative source — the live file is the oracle (parity tests enforce it).

Critical detail: `isVisibleTextTag` has a `mat-*` branch that MUST NOT be omitted:
```ts
// Copy this EXACTLY from src/qa/changed-elements.ts — do NOT simplify away the mat-* branch.
function isVisibleTextTag(tag: string): boolean {
  const low = tag.toLowerCase();
  return VISIBLE_TEXT_TAGS.has(low) || low.startsWith("mat-");
}
```
And `extractSignalsFromLine` must dispatch to `extractMatInnerText` for `mat-*` tags (see the `tag.startsWith("mat-")` branch in the live file). Both `extractMatInnerText` and `extractInnerText` must be ported verbatim. A missing `mat-*` branch silently drops Angular Material text signals — the `<mat-button>` parity test (added below) will catch this.

Expose two public methods that delegate to `this.changedLines` for line truth. Public surface:
```ts
  // Scan a diff's added lines for stable selector signals. Pure. Capped at 200. A miss degrades
  // to []; never throws, never blocks.
  //
  // TWO-PASS design (port verbatim from src/qa/changed-elements.ts):
  //   Pass 1 — parseDiffHunks / changedLines builds the authoritative file→lineSet map.
  //   Pass 2 — an independent second walk over the raw diff lines extracts HTML selector signals
  //             from `+` content, tracking file + line number with the same advance rules as Pass 1.
  // The two-pass design is intentional: Pass 1 owns line-number truth; Pass 2 owns content
  // extraction. They advance in lock-step, so file/line are identical to what changedLines
  // produces — the implementation note in src/qa/changed-elements.ts explains this explicitly.
  // Do NOT collapse to a single pass; that would silently diverge line numbering across hunks
  // and interleaved deletions.
  changedElements(diff: string): ChangedElement[] { /* ported body — re-read src/qa/changed-elements.ts at HEAD */ }

  // MANUAL mode: tokenize guidance into noun-phrases (quoted spans kept whole; standalone tokens
  // must be ≥5 chars or a proper noun AND not a QA stopword). Returns ChangedElement{ text } only.
  changedElementsFromGuidance(guidance: string): ChangedElement[] { /* ported body */ }
```
> Implementation note: keep the inner walker identical to `changedLines`' line-advance rules (`+` advances, `-` does not, context advances) so file/line are byte-for-byte the same as today — this is what makes the consolidation safe.

- [ ] **Step 5: Run it — GREEN (all new tests)**

```bash
node --import ./test-setup.mjs --import tsx --test "qa-engine/test/shared-kernel/diff-parser/diff-parser.service.test.ts"
```
Expected: every `changedElements`/`changedElementsFromGuidance` test passes alongside the Task-1 tests.

- [ ] **Step 6: Parity guard — assert the kernel parser matches the legacy `src/` functions on the same inputs**

Add a parity test that imports BOTH the kernel service and the live `src/` functions and asserts identical output (this is the strangler guard — it proves consolidation is behavior-preserving and stays green until Step 6 cutover deletes the originals). Append to the test file:
```ts
import { extractChangedElements as legacyExtract, changedElementsFromGuidance as legacyGuidance } from "../../../../src/qa/changed-elements.ts";
import { parseDiffHunks as legacyHunks } from "../../../../src/qa/change-coverage.ts";

test("PARITY: changedElements matches legacy extractChangedElements", () => {
  const d = htmlDiff([`+<button data-cy="x" id="y" name="z">Go</button>`, `+<a href="/p">P</a>`]);
  assert.deepEqual(svc.changedElements(d), legacyExtract(d));
});

test("PARITY: changedElementsFromGuidance matches legacy", () => {
  assert.deepEqual(svc.changedElementsFromGuidance("test the contact form and dashboard"), legacyGuidance("test the contact form and dashboard"));
});

test("PARITY mat-*: <mat-button> inner text is captured (isVisibleTextTag mat-* branch)", () => {
  // Exercises the low.startsWith("mat-") path in isVisibleTextTag + the extractMatInnerText dispatch.
  // If the mat-* branch was omitted, changedElements returns [] and this parity test fails.
  const d = htmlDiff([`+<mat-button color="primary">Save Changes</mat-button>`]);
  const got = svc.changedElements(d);
  const exp = legacyExtract(d);
  assert.deepEqual(got, exp, "mat-* inner text diverged from legacy — check isVisibleTextTag and extractMatInnerText");
  assert.ok(got.some((e) => e.text === "Save Changes"), "mat-button text not captured");
});

test("PARITY: changedLines matches legacy parseDiffHunks", () => {
  const d = htmlDiff([`+<button data-cy="x">Go</button>`]);
  const got = svc.changedLines(d);
  const exp = legacyHunks(d);
  assert.deepEqual([...got.entries()].map(([f, s]) => [f, [...s].sort((a, b) => a - b)]), [...exp.entries()].map(([f, s]) => [f, [...s].sort((a, b) => a - b)]));
});

test("PARITY two-pass: multiple hunks with interleaved deletions produce correct line numbers", () => {
  // A diff with two hunks and deletions between added lines. If the second pass drifts from the
  // first (e.g. by re-implementing line advance differently), the line numbers on buttons will
  // diverge — especially once line numbers reach ≥10 where lexicographic sort would mask it.
  const d = [
    "diff --git a/src/page.html b/src/page.html",
    "--- a/src/page.html",
    "+++ b/src/page.html",
    "@@ -1,5 +1,6 @@",
    " <div>",
    "-<span>old</span>",
    `+<button data-cy="btn-1">First</button>`,
    " <p>ctx</p>",
    " <p>ctx</p>",
    `+<button data-cy="btn-2">Second</button>`,
    " </div>",
    "@@ -20,3 +21,4 @@",
    " <footer>",
    "-<span>old-footer</span>",
    `+<button data-cy="btn-11">Eleven</button>`,
    `+<button data-cy="btn-12">Twelve</button>`,
    " </footer>",
  ].join("\n");
  const got = svc.changedElements(d);
  const exp = legacyExtract(d);
  // The two-pass port must match the legacy oracle byte-for-byte on every element.
  assert.deepEqual(got, exp, "two-pass line numbering diverged from the legacy oracle");
  // Spot-check: btn-11 must NOT appear on a line < 21 (catches off-by-one from hunk offset).
  const btn11 = got.find((e) => e.testId === "btn-11");
  assert.ok(btn11 !== undefined && btn11.line >= 21, `btn-11 line ${btn11?.line} should be ≥ 21`);
});
```
> If the parity test fails, the live WIP changed since Task 0 — re-read `src/qa/changed-elements.ts` and re-port. The legacy code is the oracle.

- [ ] **Step 7: Run parity + typecheck — GREEN**

```bash
node --import ./test-setup.mjs --import tsx --test "qa-engine/test/shared-kernel/diff-parser/diff-parser.service.test.ts" && npm run typecheck
```
Expected: all green (including the 3 parity tests); typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add qa-engine/src/shared-kernel/diff-parser/ qa-engine/test/shared-kernel/diff-parser/
git commit -m "feat(kernel): fold changed-elements extraction into DiffParserService with legacy parity"
```

---

## Task 3: The `LanguageId` ONE-registry — kill the `SUPPORTED_LANGUAGES` vs `AST_GREP_LANGUAGES` drift (domain)

The 2nd base-error fix. `languages.ts` declares `SUPPORTED_LANGUAGES`; `patterns.ts:19` declares a SECOND hardcoded `AST_GREP_LANGUAGES` with the same members — two sets that can silently diverge. The context owns ONE `LanguageRegistry`: the supported set, the ext→lang map, `languageForFile`, `groupByLanguage`, AND `hasAstGrepRules` (so the pattern adapter keys off the registry, never a private duplicate set).

**Files:**
- `qa-engine/src/contexts/change-analysis/domain/language-id.ts` (create)
- `qa-engine/test/contexts/change-analysis/domain/language-id.test.ts` (create)

- [ ] **Step 1: Write the failing test (one registry, no second set)**

`qa-engine/test/contexts/change-analysis/domain/language-id.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { LanguageRegistry, type LanguageId } from "@contexts/change-analysis/domain/language-id.ts";

test("the supported set is the single source of truth", () => {
  assert.deepEqual([...LanguageRegistry.supported].sort(), ["java", "javascript", "typescript"]);
});

test("languageForFile maps extensions to languages, null for unsupported", () => {
  assert.equal(LanguageRegistry.languageForFile("a/b.tsx"), "typescript");
  assert.equal(LanguageRegistry.languageForFile("a/b.mjs"), "javascript");
  assert.equal(LanguageRegistry.languageForFile("a/B.java"), "java");
  assert.equal(LanguageRegistry.languageForFile("a/b.rb"), null);
  assert.equal(LanguageRegistry.languageForFile("noext"), null);
});

test("groupByLanguage buckets files and drops unsupported", () => {
  const g = LanguageRegistry.groupByLanguage(["a.ts", "b.js", "c.py", "d.java"]);
  assert.deepEqual(g.get("typescript"), ["a.ts"]);
  assert.deepEqual(g.get("javascript"), ["b.js"]);
  assert.deepEqual(g.get("java"), ["d.java"]);
  assert.equal(g.has("python" as LanguageId), false);
});

test("DRIFT KILLED: hasAstGrepRules derives from the ONE record — true for every ast-grep-capable lang", () => {
  // All three currently-supported languages have ast-grep rules. The one-record design
  // means adding a non-astGrep language (e.g. "go") would return false without touching a
  // separate set.
  assert.equal(LanguageRegistry.hasAstGrepRules("javascript"), true);
  assert.equal(LanguageRegistry.hasAstGrepRules("typescript"), true);
  assert.equal(LanguageRegistry.hasAstGrepRules("java"), true);
  // A language NOT in the registry returns false (no second set to diverge from).
  assert.equal(LanguageRegistry.hasAstGrepRules("ruby" as LanguageId), false);
});
```

- [ ] **Step 2: Run it — RED**

```bash
node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/change-analysis/domain/language-id.test.ts"
```
Expected: cannot resolve `@contexts/change-analysis/domain/language-id.ts`.

- [ ] **Step 3: Implement the registry**

`qa-engine/src/contexts/change-analysis/domain/language-id.ts`:
```ts
// The SINGLE source of truth for language support across every extractor in this context. Adding a
// language is ONE record entry here — `supported` and `hasAstGrepRules` BOTH derive from it, so
// there is no second set that could silently diverge. This kills the legacy drift where patterns.ts
// kept its own AST_GREP_LANGUAGES set parallel to languages.ts SUPPORTED_LANGUAGES.
// Project-agnostic: keyed by language, never by app.
export type LanguageId = "javascript" | "typescript" | "java";

// Per-language metadata record: the SINGLE declaration a maintainer touches when adding a language.
// `astGrep: true` → the language has structured ast-grep rules and should use AstGrepPatternAdapter.
// `astGrep: false` → falls back to the regex pattern engine.
// Both `supported` (the registry Set) and `hasAstGrepRules` derive from this record — no second set.
const LANGS: Record<LanguageId, { astGrep: boolean }> = {
  javascript: { astGrep: true },
  typescript: { astGrep: true },
  java:       { astGrep: true },
};

const EXT_TO_LANGUAGE: Record<string, LanguageId> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  java: "java",
};

export const LanguageRegistry = {
  // Derived from LANGS — adding a new language to LANGS automatically includes it here.
  supported: new Set<LanguageId>(Object.keys(LANGS) as LanguageId[]) as ReadonlySet<LanguageId>,

  languageForFile(file: string): LanguageId | null {
    const dot = file.lastIndexOf(".");
    if (dot < 0) return null;
    return EXT_TO_LANGUAGE[file.slice(dot + 1).toLowerCase()] ?? null;
  },

  groupByLanguage(files: string[]): Map<LanguageId, string[]> {
    const out = new Map<LanguageId, string[]>();
    for (const f of files) {
      const lang = this.languageForFile(f);
      if (!lang) continue;
      const list = out.get(lang) ?? [];
      list.push(f);
      out.set(lang, list);
    }
    return out;
  },

  // Derived from LANGS[lang].astGrep — same record as `supported`. No second set.
  hasAstGrepRules(lang: LanguageId): boolean {
    return LANGS[lang]?.astGrep ?? false;
  },
} as const;
```

- [ ] **Step 4: Run it — GREEN; typecheck; commit**

```bash
node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/change-analysis/domain/language-id.test.ts" && npm run typecheck
git add qa-engine/src/contexts/change-analysis/domain/language-id.ts qa-engine/test/contexts/change-analysis/domain/language-id.test.ts
git commit -m "feat(change-analysis): one LanguageId registry, killing the AST_GREP_LANGUAGES drift"
```
Expected: green, clean typecheck, one commit.

---

## Task 4: `StaticSignal` read-model with typed `ExtractorSkipped` (domain)

The 3rd base-error fix: replace `skipped: string[]` with `skipped: ExtractorSkipped[]`. The Sha-keyed read-model carries typed degradation events ({ extractor, reason }) so a consumer can filter/route by extractor without substring-matching prose. Carry the change VOs here too (they were loosely typed in the Plan-2 port stub).

**Files:**
- `qa-engine/src/contexts/change-analysis/domain/static-signal.ts` (create)
- `qa-engine/test/contexts/change-analysis/domain/static-signal.test.ts` (create)

- [ ] **Step 1: Write the failing test**

`qa-engine/test/contexts/change-analysis/domain/static-signal.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyStaticSignal, type StaticSignal, type ExtractorSkipped } from "@contexts/change-analysis/domain/static-signal.ts";
import { Sha } from "@kernel/sha.ts";

test("emptyStaticSignal is keyed by Sha and starts empty", () => {
  const sig = emptyStaticSignal(Sha.of("abc1234"));
  assert.equal(sig.builtForSha, "abc1234");
  assert.deepEqual(sig.symbols, []);
  assert.deepEqual(sig.skipped, []);
});

test("skipped carries TYPED events, not opaque strings", () => {
  const skipped: ExtractorSkipped = { extractor: "complexity", reason: "lizard not on PATH" };
  const sig: StaticSignal = { ...emptyStaticSignal(Sha.of("abc1234")), skipped: [skipped] };
  assert.equal(sig.skipped[0]?.extractor, "complexity");
  assert.equal(sig.skipped[0]?.reason, "lizard not on PATH");
});
```

- [ ] **Step 2: Run it — RED**

```bash
node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/change-analysis/domain/static-signal.test.ts"
```
Expected: module missing.

- [ ] **Step 3: Implement the read-model + change VOs + `ExtractorSkipped`**

`qa-engine/src/contexts/change-analysis/domain/static-signal.ts`:
```ts
import type { Sha } from "@kernel/sha.ts";
import type { LanguageId } from "./language-id.ts";

// Change VOs (carried from src/qa/static-signal/types.ts; tightened from the loose Plan-2 stubs).
export interface ChangedSymbol { file: string; name: string; kind: string; signature: string; line: number; }
export interface RelationEdge { from: string; to: string; via: string; }
export interface ComplexityHotspot { file: string; function: string; ccn: number; nloc: number; line: number; }
export interface FileChangeKind { file: string; cosmetic: boolean; }
export interface ChangePattern { file: string; pattern: string; source: "ast-grep" | "regex"; }

// Typed degradation event: replaces the legacy opaque `skipped: string[]`. A consumer can route by
// `extractor` without substring-matching a prose message. Signal-only: a skip never blocks publish.
export interface ExtractorSkipped { extractor: string; reason: string; }

// Sha-keyed READ-MODEL (no guarded state transitions — demoted from aggregate per §5.3(2)).
export interface StaticSignal {
  builtForSha: string;
  languages: LanguageId[];
  symbols: ChangedSymbol[];
  relations: RelationEdge[];
  complexity: ComplexityHotspot[];
  fileChangeKinds: FileChangeKind[];
  patterns: ChangePattern[];
  skipped: ExtractorSkipped[];
}

export function emptyStaticSignal(sha: Sha): StaticSignal {
  return {
    builtForSha: sha.value, languages: [], symbols: [], relations: [],
    complexity: [], fileChangeKinds: [], patterns: [], skipped: [],
  };
}
```

- [ ] **Step 4: Run it — GREEN; typecheck; commit**

```bash
node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/change-analysis/domain/static-signal.test.ts" && npm run typecheck
git add qa-engine/src/contexts/change-analysis/domain/static-signal.ts qa-engine/test/contexts/change-analysis/domain/static-signal.test.ts
git commit -m "feat(change-analysis): StaticSignal read-model with typed ExtractorSkipped events"
```

---

## Task 5: `classifyCommit` ported to the domain (the token-spend gate)

Port `classifyCommit` and its private helpers VERBATIM in behavior into the context domain. It consumes `DiffParserService.changedFiles` for the scope (instead of the inlined `parseChangedFiles`), removing the last in-`commit-classify` diff parse. A parity test pins it against the live `src/qa/commit-classify.ts`.

**Files:**
- `qa-engine/src/contexts/change-analysis/domain/commit-classification.ts` (create)
- `qa-engine/test/contexts/change-analysis/domain/commit-classification.test.ts` (create)

- [ ] **Step 1: Write the failing decision-table test + a parity test**

`qa-engine/test/contexts/change-analysis/domain/commit-classification.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCommit } from "@contexts/change-analysis/domain/commit-classification.ts";
import { classifyCommit as legacy } from "../../../../../src/qa/commit-classify.ts";

const srcDiff = (added: string[]) => [
  "diff --git a/src/svc.ts b/src/svc.ts", "--- a/src/svc.ts", "+++ b/src/svc.ts",
  `@@ -1,1 +1,${added.length + 1} @@`, " export class S {", ...added.map((l) => "+" + l), " }",
].join("\n");

test("feat → generate", () => {
  assert.equal(classifyCommit("feat: add checkout", srcDiff(["if (x) return 1;"])).action, "generate");
});

test("docs with no logic → skip (no token spend)", () => {
  const d = ["diff --git a/README.md b/README.md", "--- a/README.md", "+++ b/README.md", "@@ -1,1 +1,2 @@", " # Title", "+more prose"].join("\n");
  assert.equal(classifyCommit("docs: update readme", d).action, "skip");
});

test("CONTRADICTION: refactor whose diff adds net logic escalates to generate", () => {
  const c = classifyCommit("refactor: rename", srcDiff(["if (newBranch) doThing();"]));
  assert.equal(c.action, "generate");
  assert.equal(c.contradiction, true);
});

test("breaking change always generates", () => {
  assert.equal(classifyCommit("chore!: drop v1", srcDiff(["return;"])).action, "generate");
});

test("PARITY: matches legacy classifyCommit across the decision table", () => {
  const cases: Array<[string, string]> = [
    ["feat: x", srcDiff(["if (a) return;"])],
    ["refactor: move", srcDiff(["const moved = 1;"])],
    ["style: format", srcDiff(["const s = \"   spaced   \";"])],
    ["docs: readme", "diff --git a/x.md b/x.md\n--- a/x.md\n+++ b/x.md\n@@ -1,1 +1,2 @@\n a\n+b"],
    ["perf: faster loop", srcDiff(["for (let i=0;i<n;i++) work();"])],
  ];
  for (const [msg, d] of cases) {
    assert.deepEqual(classifyCommit(msg, d), legacy(msg, d), `divergence on: ${msg}`);
  }
});

test("PARITY relocation-subtraction: a logic line that moved (both + and - sides) is NOT escalated to generate", () => {
  // The genuinelyAddedLogic walker subtracts lines that appear on BOTH the +- and -- sides
  // (content relocation: same text removed elsewhere and added here). A moved line is NOT net-new
  // logic, so classifyCommit must return "regression" (or "skip") — NOT "generate".
  // If the subtraction path is mis-ported, the + line looks like new logic → wrong escalation.
  const relocatedDiff = [
    "diff --git a/src/svc.ts b/src/svc.ts",
    "--- a/src/svc.ts",
    "+++ b/src/svc.ts",
    "@@ -1,4 +1,4 @@",
    " export class S {",
    "-  if (x) return 1;",
    "+  if (x) return 1;",
    " }",
  ].join("\n");
  // Both legacy and new impl must agree: no net-new logic → "regression" (not "generate").
  const got = classifyCommit("refactor: move guard", relocatedDiff);
  const exp = legacy("refactor: move guard", relocatedDiff);
  assert.deepEqual(got, exp, "relocation-subtraction path diverged from legacy");
  assert.equal(got.action, "regression",
    "a moved logic line should NOT escalate refactor to generate");
});
```

- [ ] **Step 2: Run it — RED**

```bash
node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/change-analysis/domain/commit-classification.test.ts"
```
Expected: module missing.

- [ ] **Step 3: Port `classifyCommit` (re-read `src/qa/commit-classify.ts` at HEAD first)**

`qa-engine/src/contexts/change-analysis/domain/commit-classification.ts`: port the VOs (`CommitType`/`CommitAction`/`CommitIntent`/`CommitClassification`), `DEFAULT_ACTION`, `classifyCommit`, and the private helpers (`parseHeader`, `genuinelyAddedLogic`, `genuinelyAddedConfig`, `isSourceFile`, `isBehaviorConfigFile`, `looksLikeLogic`, `stripStrings`, the `SOURCE_EXT`/`BEHAVIOR_CONFIG`/`LOGIC` constants) VERBATIM in behavior. The ONLY change: replace the inlined `parseChangedFiles(diff)` with the shared parser:
```ts
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";
// ...
const diffParser = new DiffParserService();
export function classifyCommit(message: string, diff: string): CommitClassification {
  const { type, breaking } = parseHeader(message);
  const firstLine = (message.split("\n")[0] ?? "").trim();
  const body = message.split("\n").slice(1).join("\n").trim();
  const changedFiles = diffParser.changedFiles(diff); // was the inlined parseChangedFiles
  // ...rest verbatim: hasLogicChange / hasBehaviorConfigChange / action / contradiction / reason
}
```
> The `genuinelyAddedLogic`/`genuinelyAddedConfig` walkers stay private (they parse `+++`/`---`/`+`/`-` with content-relocation subtraction — that is classify-specific logic, NOT generic diff parsing, so it does NOT move to `DiffParserService`).

- [ ] **Step 4: Run it — GREEN (incl. parity); typecheck; commit**

```bash
node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/change-analysis/domain/commit-classification.test.ts" && npm run typecheck
git add qa-engine/src/contexts/change-analysis/domain/commit-classification.ts qa-engine/test/contexts/change-analysis/domain/commit-classification.test.ts
git commit -m "feat(change-analysis): classifyCommit ported to domain, consuming the kernel DiffParserService"
```
Expected: green incl. the parity case; clean typecheck.

---

## Task 6: Refine the extractor ports + `VcsReadPort` (application)

Plan 2 left `application/ports/index.ts` a stub with loose VO shapes and `extract(br: BlastRadius)`. Refine it so the ports key on the domain VOs (Task 4) and each returns `Result<T[], ExtractorSkipped>` (typed fail-open). The extractor input is the analyzed change (changed files + diff + repo dir + Sha), not just `BlastRadius` — the wrapped extractors need the diff (semantic-diff) and the repo dir (file reads).

**Files:**
- `qa-engine/src/contexts/change-analysis/application/ports/index.ts` (refine — replace the stub)
- `qa-engine/test/contexts/ports-compile.test.ts` (verify still green — do NOT edit)

- [ ] **Step 0: Scan for consumers importing the old loose VO shapes from the port barrel**

Before replacing the barrel, find every qa-engine consumer that imports the old loose VO shapes (`ChangedSymbol`, `RelationEdge`, `ComplexityHotspot`, `FileChangeKind`, `ChangePattern`) from the change-analysis ports barrel. Those callers must be updated to import from the domain module (`../../domain/static-signal.ts` or via `@contexts/change-analysis/domain/static-signal.ts`) once the barrel stops re-exporting them.

```bash
cd /Users/arielyumn/Desktop/TRABAJO/ai-pipeline
rg --type ts -n 'from.*change-analysis.*ports.*index|from.*application/ports' qa-engine/src qa-engine/test 2>/dev/null
rg --type ts -n 'ChangedSymbol|RelationEdge|ComplexityHotspot|FileChangeKind|ChangePattern' qa-engine/src qa-engine/test 2>/dev/null | rg 'from.*ports'
```

Expected: any hit that imports a VO name from the ports barrel must be updated to import from `domain/static-signal.ts`. Note that **VOs now live in the domain module** (`change-analysis/domain/static-signal.ts`) — the ports barrel only owns port interfaces and `ExtractorSkipped`. If any file imports a VO from the barrel today, record it here and fix it in Step 1 (do NOT skip this check — the ports-compile test may not catch an import that was previously satisfied by the old loose barrel re-export).

- [ ] **Step 1: Replace the port stub with VO-keyed ports**

`qa-engine/src/contexts/change-analysis/application/ports/index.ts`:
```ts
// Deterministic blast-radius analysis ports. VcsReadPort is the typed read side (no raw git argv
// leaks past the adapter). The 5 extractor ports are an ALL-OPTIONAL fail-open map: each returns a
// typed ExtractorSkipped on degrade, NEVER throws past the use-case. The change VOs are owned by the
// domain (static-signal.ts); ExtractorSkipped too. DiffParserService / SandboxedBinaryRunner /
// ProcessKillPort / scrubEnv are consumed FROM the kernel + shared-infrastructure, not redefined.
import type { Sha } from "@kernel/sha.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { Result } from "@kernel/result.ts";
import type {
  ChangedSymbol, RelationEdge, ComplexityHotspot, FileChangeKind, ChangePattern, ExtractorSkipped,
} from "../../domain/static-signal.ts";

export type { ExtractorSkipped };

// Typed read side over a git mirror. The adapter owns argv; callers see Sha + typed results only.
export interface VcsReadPort {
  diff(sha: Sha, opts?: { baseSha?: Sha; commits?: number }): Promise<string>;
  message(sha: Sha): Promise<string>;
  blastRadius(sha: Sha, opts?: { baseSha?: Sha; commits?: number }): Promise<BlastRadius>;
}

// What every extractor receives. Carries the analyzed change so each wrapped tool has what it needs
// (semantic-diff needs the diff + sha; the rest need files + repoDir).
export interface ExtractionContext {
  sha: Sha;
  baseSha?: Sha;
  repoDir: string;
  changedFiles: string[];
  diff: string;
}

export interface SymbolExtractorPort { extract(ctx: ExtractionContext): Promise<Result<ChangedSymbol[], ExtractorSkipped>>; }
export interface RelationExtractorPort { extract(ctx: ExtractionContext): Promise<Result<RelationEdge[], ExtractorSkipped>>; }
export interface ComplexityExtractorPort { extract(ctx: ExtractionContext): Promise<Result<ComplexityHotspot[], ExtractorSkipped>>; }
export interface SemanticDiffExtractorPort { extract(ctx: ExtractionContext): Promise<Result<FileChangeKind[], ExtractorSkipped>>; }
export interface PatternExtractorPort { extract(ctx: ExtractionContext): Promise<Result<ChangePattern[], ExtractorSkipped>>; }

// The all-optional fail-open extractor map (mirrors src/qa/static-signal/aggregate.ts StaticSignalDeps).
export interface ExtractorSet {
  symbols?: SymbolExtractorPort;
  relations?: RelationExtractorPort;
  complexity?: ComplexityExtractorPort;
  semanticDiff?: SemanticDiffExtractorPort;
  patterns?: PatternExtractorPort;
}
```

- [ ] **Step 2: Run the existing port-barrel compile test — still GREEN**

```bash
node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/ports-compile.test.ts" && npm run typecheck
```
Expected: the Plan-2 `ports-compile.test.ts` (imports all 9 barrels) still passes; typecheck clean. If it fails, a downstream context imported the old loose `ChangedSymbol` shape — fix that import, do NOT loosen the new VO.

- [ ] **Step 3: Commit**

```bash
git add qa-engine/src/contexts/change-analysis/application/ports/index.ts
git commit -m "refactor(change-analysis): extractor ports key on domain VOs with typed fail-open"
```

---

## Task 7: The `analyze-change` use-case (fan out fail-open → StaticSignal)

Port `aggregateStaticSignal`'s orchestration: fan out the 5 extractors with `Promise.all`, each guarded so a degrade records a typed `ExtractorSkipped` instead of throwing. Replaces the legacy `guard()` that pushed a string. Signal-only: an empty extractor set or all-skipped still returns a well-formed `StaticSignal`.

**Files:**
- `qa-engine/src/contexts/change-analysis/application/analyze-change.use-case.ts` (create)
- `qa-engine/test/contexts/change-analysis/application/analyze-change.use-case.test.ts` (create)

- [ ] **Step 1: Write the failing test (stubbed extractors — no real binaries)**

`qa-engine/test/contexts/change-analysis/application/analyze-change.use-case.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeChange } from "@contexts/change-analysis/application/analyze-change.use-case.ts";
import type { ExtractorSet } from "@contexts/change-analysis/application/ports/index.ts";
import { ok, err } from "@kernel/result.ts";
import { Sha } from "@kernel/sha.ts";

const ctx = { sha: Sha.of("abc1234"), repoDir: "/repo", changedFiles: ["a.ts"], diff: "diff" };

test("aggregates extractor results into a Sha-keyed StaticSignal", async () => {
  const set: ExtractorSet = {
    symbols: { extract: async () => ok([{ file: "a.ts", name: "f", kind: "function", signature: "f()", line: 1 }]) },
  };
  const sig = await analyzeChange(ctx, set);
  assert.equal(sig.builtForSha, "abc1234");
  assert.equal(sig.symbols.length, 1);
  assert.deepEqual(sig.languages, ["typescript"]);
});

test("a degraded extractor records a TYPED ExtractorSkipped, never throws", async () => {
  const set: ExtractorSet = {
    complexity: { extract: async () => err({ extractor: "complexity", reason: "lizard missing" }) },
  };
  const sig = await analyzeChange(ctx, set);
  assert.deepEqual(sig.complexity, []);
  assert.equal(sig.skipped[0]?.extractor, "complexity");
  assert.equal(sig.skipped[0]?.reason, "lizard missing");
});

test("a THROWN extractor error is caught and recorded as a skip (fail-open, never blocks)", async () => {
  const set: ExtractorSet = {
    relations: { extract: async () => { throw new Error("boom"); } },
  };
  const sig = await analyzeChange(ctx, set);
  assert.deepEqual(sig.relations, []);
  assert.equal(sig.skipped[0]?.extractor, "relations");
  assert.match(sig.skipped[0]!.reason, /boom/);
});

test("no supported-language file → records a skip and returns the empty signal", async () => {
  const sig = await analyzeChange({ ...ctx, changedFiles: ["x.rb"] }, {});
  assert.deepEqual(sig.languages, []);
  assert.equal(sig.skipped.some((s) => s.extractor === "languages"), true);
});

test("an absent extractor (undefined in the set) is simply not run (no skip noise)", async () => {
  const sig = await analyzeChange(ctx, {}); // languages supported, but no extractors configured
  assert.deepEqual(sig.symbols, []);
  // only the 'no extractor configured' skips, one per missing extractor
  assert.equal(sig.skipped.every((s) => s.reason === "extractor not configured"), true);
});

test("PARITY: unsupported files (.rb/.py/.rs) are NEVER seen by the symbol extractor", async () => {
  // Mixed input: one supported (.ts) and one unsupported (.rb) file.
  const seenFiles: string[] = [];
  const set: ExtractorSet = {
    symbols: { extract: async (c) => { seenFiles.push(...c.changedFiles); return ok([]); } },
  };
  await analyzeChange({ ...ctx, changedFiles: ["src/app.ts", "lib/helper.rb"] }, set);
  assert.deepEqual(seenFiles, ["src/app.ts"],
    "symbol extractor must only receive supported-language files, not .rb");
});
```

- [ ] **Step 2: Run it — RED**

```bash
node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/change-analysis/application/analyze-change.use-case.test.ts"
```
Expected: module missing.

- [ ] **Step 3: Implement `analyzeChange` (port `aggregateStaticSignal`, typed skips)**

`qa-engine/src/contexts/change-analysis/application/analyze-change.use-case.ts`:
```ts
import { isOk } from "@kernel/result.ts";
import { LanguageRegistry } from "../../domain/language-id.ts";
import { emptyStaticSignal, type StaticSignal } from "../../domain/static-signal.ts";
import type { ExtractionContext, ExtractorSet } from "./ports/index.ts";

// Fan out the 5 extractors fail-open and assemble the Sha-keyed StaticSignal. Mirrors the legacy
// aggregateStaticSignal, but every degrade is a TYPED ExtractorSkipped, not an opaque string, and
// a THROWN extractor is caught here (the use-case is the fail-open boundary — nothing reaches the
// orchestrator). Signal-only by contract: this can never block publish.
//
// PARITY NOTE: the legacy `aggregateStaticSignal` passes only `supportedFiles` (files under
// supported languages) to symbols/relations/complexity/patterns, and the raw diff only to
// semanticDiff. This use-case preserves that invariant: `filteredCtx` carries only the
// language-filtered files for the 4 AST-based extractors; the full `ctx` (with diff) goes
// only to semanticDiff. Unsupported files (.rb/.py/.rs etc.) never reach AST extractors.
export async function analyzeChange(ctx: ExtractionContext, extractors: ExtractorSet): Promise<StaticSignal> {
  const sig = emptyStaticSignal(ctx.sha);
  const byLang = LanguageRegistry.groupByLanguage(ctx.changedFiles);
  sig.languages = [...byLang.keys()];
  const supportedFiles = [...byLang.values()].flat();
  if (supportedFiles.length === 0) {
    sig.skipped.push({ extractor: "languages", reason: "no changed file is in a supported language (javascript/typescript/java)" });
    return sig;
  }

  // filteredCtx: same as ctx but changedFiles restricted to the supported-language subset.
  // Passed to symbol/relation/complexity/pattern extractors (AST-based, language-gated).
  // semanticDiff receives the full ctx (needs the raw diff and all file paths).
  const filteredCtx: ExtractionContext = { ...ctx, changedFiles: supportedFiles };

  const run = async <T>(
    name: string,
    port: { extract(c: ExtractionContext): Promise<import("@kernel/result.ts").Result<T, { extractor: string; reason: string }>> } | undefined,
    extractCtx: ExtractionContext,
    assign: (v: T) => void,
  ): Promise<void> => {
    if (!port) { sig.skipped.push({ extractor: name, reason: "extractor not configured" }); return; }
    try {
      const r = await port.extract(extractCtx);
      if (isOk(r)) assign(r.value);
      else sig.skipped.push(r.error);
    } catch (e) {
      sig.skipped.push({ extractor: name, reason: e instanceof Error ? e.message : String(e) });
    }
  };

  await Promise.all([
    run("symbols",      extractors.symbols,      filteredCtx, (v) => (sig.symbols = v)),
    run("relations",    extractors.relations,    filteredCtx, (v) => (sig.relations = v)),
    run("complexity",   extractors.complexity,   filteredCtx, (v) => (sig.complexity = v)),
    run("semanticDiff", extractors.semanticDiff, ctx,         (v) => (sig.fileChangeKinds = v)),
    run("patterns",     extractors.patterns,     filteredCtx, (v) => (sig.patterns = v)),
  ]);
  return sig;
}
```

- [ ] **Step 4: Run it — GREEN; typecheck; commit**

```bash
node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/change-analysis/application/analyze-change.use-case.test.ts" && npm run typecheck
git add qa-engine/src/contexts/change-analysis/application/analyze-change.use-case.ts qa-engine/test/contexts/change-analysis/application/analyze-change.use-case.test.ts
git commit -m "feat(change-analysis): analyze-change use-case fanning out extractors fail-open"
```

---

## Task 8: The 5 extractor adapters — WRAP the proven `src/qa/static-signal/*` (infrastructure)

Wrap-then-replace: each adapter DELEGATES to the live, proven extractor and maps the result into `Result<T[], ExtractorSkipped>`. **Do NOT rewrite tree-sitter / ast-grep / lizard / difftastic logic.** The adapter test asserts delegation + the typed-skip mapping with the underlying call stubbed (the binary is the deliberately-uncovered boundary).

**Files:**
- `qa-engine/src/contexts/change-analysis/infrastructure/extractors/tree-sitter-symbol.adapter.ts` (create)
- `qa-engine/src/contexts/change-analysis/infrastructure/extractors/tree-sitter-relation.adapter.ts` (create)
- `qa-engine/src/contexts/change-analysis/infrastructure/extractors/lizard-complexity.adapter.ts` (create)
- `qa-engine/src/contexts/change-analysis/infrastructure/extractors/difftastic-semantic-diff.adapter.ts` (create)
- `qa-engine/src/contexts/change-analysis/infrastructure/extractors/ast-grep-pattern.adapter.ts` (create)
- `qa-engine/src/contexts/change-analysis/infrastructure/extractors/default-extractors.ts` (create)
- `qa-engine/test/contexts/change-analysis/infrastructure/extractors/extractor-adapters.test.ts` (create)

- [ ] **Step 1: Write the failing test (inject a fake extractor fn — no real binaries)**

Each adapter takes its underlying extractor function as a constructor dependency so the test stubs it. `extractor-adapters.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { TreeSitterSymbolAdapter } from "@contexts/change-analysis/infrastructure/extractors/tree-sitter-symbol.adapter.ts";
import { TreeSitterRelationAdapter } from "@contexts/change-analysis/infrastructure/extractors/tree-sitter-relation.adapter.ts";
import { LizardComplexityAdapter } from "@contexts/change-analysis/infrastructure/extractors/lizard-complexity.adapter.ts";
import { DifftasticSemanticDiffAdapter } from "@contexts/change-analysis/infrastructure/extractors/difftastic-semantic-diff.adapter.ts";
import { AstGrepPatternAdapter } from "@contexts/change-analysis/infrastructure/extractors/ast-grep-pattern.adapter.ts";
import { isOk, isErr } from "@kernel/result.ts";
import { Sha } from "@kernel/sha.ts";

const ctx = { sha: Sha.of("abc1234"), repoDir: "/repo", changedFiles: ["a.ts"], diff: "d" };

test("symbol adapter delegates to the wrapped extractor and returns ok(symbols)", async () => {
  let calledFiles: string[] | null = null;
  const fake = async (files: string[], _repo: string) => { calledFiles = files; return [{ file: "a.ts", name: "f", kind: "function", signature: "f()", line: 1 }]; };
  const r = await new TreeSitterSymbolAdapter(fake).extract(ctx);
  assert.deepEqual(calledFiles, ["a.ts"]);
  assert.ok(isOk(r) && r.value.length === 1);
});

test("complexity adapter maps a thrown wrapped error to a typed ExtractorSkipped", async () => {
  const fake = async () => { throw new Error("lizard exploded"); };
  const r = await new LizardComplexityAdapter(fake).extract(ctx);
  assert.ok(isErr(r));
  assert.ok(isErr(r) && r.error.extractor === "complexity");
});

test("semantic-diff adapter passes diff + sha + baseSha through to the wrapped extractor", async () => {
  let seen: { diff?: string; sha?: string; base?: string } = {};
  const fake = async (diff: string, _repo: string, sha: string, base?: string) => { seen = { diff, sha, base }; return [{ file: "a.ts", cosmetic: false }]; };
  const r = await new DifftasticSemanticDiffAdapter(fake).extract({ ...ctx, baseSha: Sha.of("def5678") });
  assert.equal(seen.diff, "d");
  assert.equal(seen.sha, "abc1234");
  assert.equal(seen.base, "def5678");
  assert.ok(isOk(r));
});

test("relation adapter delegates to the wrapped extractor with files + repoDir (2-arg)", async () => {
  let calledWith: { files: string[]; repoDir: string } | null = null;
  const fake = async (files: string[], repoDir: string) => {
    calledWith = { files, repoDir };
    return [{ from: "a.ts", to: "b.ts", via: "import" }];
  };
  const r = await new TreeSitterRelationAdapter(fake).extract(ctx);
  assert.deepEqual(calledWith, { files: ["a.ts"], repoDir: "/repo" });
  assert.ok(isOk(r) && r.value.length === 1 && r.value[0]?.from === "a.ts");
});

test("pattern adapter delegates to the wrapped extractor with files + repoDir + diff (3-arg, per FIX 1 receives FILTERED files)", async () => {
  let calledWith: { files: string[]; repoDir: string; diff: string } | null = null;
  const fake = async (files: string[], repoDir: string, diff: string) => {
    calledWith = { files, repoDir, diff };
    return [{ file: "a.ts", pattern: "if-return", source: "ast-grep" as const }];
  };
  const r = await new AstGrepPatternAdapter(fake).extract(ctx);
  assert.deepEqual(calledWith, { files: ["a.ts"], repoDir: "/repo", diff: "d" });
  assert.ok(isOk(r) && r.value.length === 1 && r.value[0]?.pattern === "if-return");
});
```

- [ ] **Step 2: Run it — RED**

```bash
node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/change-analysis/infrastructure/extractors/extractor-adapters.test.ts"
```
Expected: adapter modules missing.

- [ ] **Step 3: Implement the symbol adapter (the template the others follow)**

`tree-sitter-symbol.adapter.ts`:
```ts
import { ok, err, type Result } from "@kernel/result.ts";
import type { SymbolExtractorPort, ExtractionContext, ExtractorSkipped } from "../../application/ports/index.ts";
import type { ChangedSymbol } from "../../domain/static-signal.ts";
import { extractSymbols as realExtractSymbols } from "../../../../../src/qa/static-signal/symbols.ts";

// WRAP-THEN-REPLACE: delegate to the proven tree-sitter extractor; map degrade → typed skip.
// The underlying fn is injected so tests stub it (the WASM grammar is the uncovered boundary).
type SymbolFn = (files: string[], repoDir: string) => Promise<ChangedSymbol[]>;

export class TreeSitterSymbolAdapter implements SymbolExtractorPort {
  constructor(private readonly run: SymbolFn = realExtractSymbols) {}
  async extract(ctx: ExtractionContext): Promise<Result<ChangedSymbol[], ExtractorSkipped>> {
    try {
      return ok(await this.run(ctx.changedFiles, ctx.repoDir));
    } catch (e) {
      return err({ extractor: "symbols", reason: e instanceof Error ? e.message : String(e) });
    }
  }
}
```

- [ ] **Step 4: Implement the other 4 adapters (concrete bodies — each adapter is a standalone file)**

`tree-sitter-relation.adapter.ts`:
```ts
import { ok, err, type Result } from "@kernel/result.ts";
import type { RelationExtractorPort, ExtractionContext, ExtractorSkipped } from "../../application/ports/index.ts";
import type { RelationEdge } from "../../domain/static-signal.ts";
import { extractRelations as realExtractRelations } from "../../../../../src/qa/static-signal/relations.ts";

// WRAP-THEN-REPLACE: delegate to the proven tree-sitter relation extractor; map degrade → typed skip.
// extractRelations is 2-arg: (files, repoDir) — no diff needed. The underlying fn is injected so
// tests stub it (the WASM grammar is the uncovered boundary).
type RelationFn = (files: string[], repoDir: string) => Promise<RelationEdge[]>;

export class TreeSitterRelationAdapter implements RelationExtractorPort {
  constructor(private readonly run: RelationFn = realExtractRelations) {}
  async extract(ctx: ExtractionContext): Promise<Result<RelationEdge[], ExtractorSkipped>> {
    try {
      return ok(await this.run(ctx.changedFiles, ctx.repoDir));
    } catch (e) {
      return err({ extractor: "relations", reason: e instanceof Error ? e.message : String(e) });
    }
  }
}
```

`lizard-complexity.adapter.ts`:
```ts
import { ok, err, type Result } from "@kernel/result.ts";
import type { ComplexityExtractorPort, ExtractionContext, ExtractorSkipped } from "../../application/ports/index.ts";
import type { ComplexityHotspot } from "../../domain/static-signal.ts";
import { extractComplexity as realExtractComplexity } from "../../../../../src/qa/static-signal/complexity.ts";

// WRAP-THEN-REPLACE: delegate to the proven lizard complexity extractor; map degrade → typed skip.
// extractComplexity is 2-arg: (files, repoDir). Injected for testability (lizard binary boundary).
type ComplexityFn = (files: string[], repoDir: string) => Promise<ComplexityHotspot[]>;

export class LizardComplexityAdapter implements ComplexityExtractorPort {
  constructor(private readonly run: ComplexityFn = realExtractComplexity) {}
  async extract(ctx: ExtractionContext): Promise<Result<ComplexityHotspot[], ExtractorSkipped>> {
    try {
      return ok(await this.run(ctx.changedFiles, ctx.repoDir));
    } catch (e) {
      return err({ extractor: "complexity", reason: e instanceof Error ? e.message : String(e) });
    }
  }
}
```

`ast-grep-pattern.adapter.ts`:
```ts
import { ok, err, type Result } from "@kernel/result.ts";
import type { PatternExtractorPort, ExtractionContext, ExtractorSkipped } from "../../application/ports/index.ts";
import type { ChangePattern } from "../../domain/static-signal.ts";
import { extractPatterns as realExtractPatterns } from "../../../../../src/qa/static-signal/patterns.ts";

// WRAP-THEN-REPLACE: delegate to the proven ast-grep pattern extractor; map degrade → typed skip.
// extractPatterns is 3-arg: (files, repoDir, diff). Per the language-filter invariant (FIX 1),
// this adapter receives a filteredCtx where changedFiles already contains only supported-language
// files — the use-case has stripped unsupported files before calling this adapter.
// The underlying fn is injected so tests stub it (the sg binary is the uncovered boundary).
type PatternFn = (files: string[], repoDir: string, diff: string) => Promise<ChangePattern[]>;

export class AstGrepPatternAdapter implements PatternExtractorPort {
  constructor(private readonly run: PatternFn = realExtractPatterns) {}
  async extract(ctx: ExtractionContext): Promise<Result<ChangePattern[], ExtractorSkipped>> {
    try {
      return ok(await this.run(ctx.changedFiles, ctx.repoDir, ctx.diff));
    } catch (e) {
      return err({ extractor: "patterns", reason: e instanceof Error ? e.message : String(e) });
    }
  }
}
```

`difftastic-semantic-diff.adapter.ts`:
```ts
import { ok, err, type Result } from "@kernel/result.ts";
import type { SemanticDiffExtractorPort, ExtractionContext, ExtractorSkipped } from "../../application/ports/index.ts";
import type { FileChangeKind } from "../../domain/static-signal.ts";
import { extractSemanticDiff as realExtractSemanticDiff } from "../../../../../src/qa/static-signal/semantic-diff.ts";

// WRAP-THEN-REPLACE: delegate to the proven difftastic semantic-diff extractor; map degrade → typed skip.
// extractSemanticDiff is 4-arg: (diff, repoDir, sha, baseSha?). Maps ctx.sha/.baseSha → string values.
// Receives the FULL ctx (not filtered) — semanticDiff needs the raw diff and works on all file paths.
// The underlying fn is injected so tests stub it (the difft binary is the uncovered boundary).
type SemanticDiffFn = (diff: string, repoDir: string, sha: string, baseSha?: string) => Promise<FileChangeKind[]>;

export class DifftasticSemanticDiffAdapter implements SemanticDiffExtractorPort {
  constructor(private readonly run: SemanticDiffFn = realExtractSemanticDiff) {}
  async extract(ctx: ExtractionContext): Promise<Result<FileChangeKind[], ExtractorSkipped>> {
    try {
      return ok(await this.run(ctx.diff, ctx.repoDir, ctx.sha.value, ctx.baseSha?.value));
    } catch (e) {
      return err({ extractor: "semanticDiff", reason: e instanceof Error ? e.message : String(e) });
    }
  }
}
```

- [ ] **Step 5: Run it — GREEN; typecheck**

```bash
node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/change-analysis/infrastructure/extractors/extractor-adapters.test.ts" && npm run typecheck
```
Expected: all adapter tests pass; typecheck clean (the cross-tree import of `src/qa/static-signal/*` resolves via the relative path).

- [ ] **Step 6: Implement the production extractor map**

`default-extractors.ts`:
```ts
import type { ExtractorSet } from "../../application/ports/index.ts";
import { TreeSitterSymbolAdapter } from "./tree-sitter-symbol.adapter.ts";
import { TreeSitterRelationAdapter } from "./tree-sitter-relation.adapter.ts";
import { LizardComplexityAdapter } from "./lizard-complexity.adapter.ts";
import { DifftasticSemanticDiffAdapter } from "./difftastic-semantic-diff.adapter.ts";
import { AstGrepPatternAdapter } from "./ast-grep-pattern.adapter.ts";

// The production extractor set, mirroring src/qa/static-signal/aggregate.defaults.ts. Each adapter
// defaults its wrapped fn to the real extractor; the composition root injects this whole set.
export const defaultExtractors: ExtractorSet = {
  symbols: new TreeSitterSymbolAdapter(),
  relations: new TreeSitterRelationAdapter(),
  complexity: new LizardComplexityAdapter(),
  semanticDiff: new DifftasticSemanticDiffAdapter(),
  patterns: new AstGrepPatternAdapter(),
};
```

- [ ] **Step 7: Typecheck + commit**

```bash
npm run typecheck
git add qa-engine/src/contexts/change-analysis/infrastructure/extractors/ qa-engine/test/contexts/change-analysis/infrastructure/extractors/
git commit -m "feat(change-analysis): 5 extractor adapters wrapping the proven static-signal extractors"
```

---

## Task 9: `GitMirrorReadAdapter` — typed `VcsReadPort` over the kernel runner (infrastructure)

The typed read side: turn a `Sha` into a diff / message / `BlastRadius` without leaking raw git argv past the adapter. It consumes the kernel `SandboxedBinaryRunner` (Plan 2) + `DiffParserService.changedFiles` (Task 1) — no new spawn code, no new diff parser.

**Files:**
- `qa-engine/src/contexts/change-analysis/infrastructure/git-mirror-read.adapter.ts` (create)
- `qa-engine/test/contexts/change-analysis/infrastructure/git-mirror-read.adapter.test.ts` (create)

- [ ] **Step 1: Write the failing test (inject a fake `SandboxedBinaryRunner`)**

`git-mirror-read.adapter.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { GitMirrorReadAdapter } from "@contexts/change-analysis/infrastructure/git-mirror-read.adapter.ts";
import type { SandboxedBinaryRunner, SandboxedRunRequest } from "../../../../src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import { Sha } from "@kernel/sha.ts";

function runnerReturning(stdout: string, capture?: (r: SandboxedRunRequest) => void): SandboxedBinaryRunner {
  return { run: async (req) => { capture?.(req); return { exitCode: 0, stdout, stderr: "", timedOut: false }; } };
}

test("diff() shells git with the sha and returns stdout", async () => {
  let seen: SandboxedRunRequest | null = null;
  const adapter = new GitMirrorReadAdapter("/repo", runnerReturning("DIFF", (r) => (seen = r)));
  const out = await adapter.diff(Sha.of("abc1234"));
  assert.equal(out, "DIFF");
  assert.equal(seen!.command, "git");
  assert.ok(seen!.args.includes("abc1234"));
  assert.equal(seen!.cwd, "/repo");
});

test("blastRadius() returns a Sha-keyed BlastRadius from the parsed diff", async () => {
  const diff = ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -1,1 +1,2 @@", " a", "+b"].join("\n");
  const adapter = new GitMirrorReadAdapter("/repo", runnerReturning(diff));
  const br = await adapter.blastRadius(Sha.of("abc1234"));
  assert.deepEqual([...br.changedFiles], ["x.ts"]);
  assert.equal(br.isEmpty, false);
});

test("message() returns the commit message stdout trimmed", async () => {
  const adapter = new GitMirrorReadAdapter("/repo", runnerReturning("feat: x\n\nbody\n"));
  assert.equal(await adapter.message(Sha.of("abc1234")), "feat: x\n\nbody");
});

test("diff() throws on non-zero exitCode — never returns silent empty diff (CLAUDE.md surface-errors rule)", async () => {
  const badRunner: SandboxedBinaryRunner = {
    run: async () => ({ exitCode: 128, stdout: "", stderr: "fatal: bad object deadbeef", timedOut: false }),
  };
  const adapter = new GitMirrorReadAdapter("/repo", badRunner);
  await assert.rejects(
    () => adapter.diff(Sha.of("deadbeef")),
    (err: unknown) => err instanceof Error && /fatal: bad object deadbeef/.test(err.message),
    "expected diff() to throw when git exits non-zero",
  );
});
```

- [ ] **Step 2: Run it — RED**

```bash
node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/change-analysis/infrastructure/git-mirror-read.adapter.test.ts"
```
Expected: adapter missing.

- [ ] **Step 3: Implement `GitMirrorReadAdapter`**

`git-mirror-read.adapter.ts`:
```ts
import { Sha } from "@kernel/sha.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";
import type { SandboxedBinaryRunner } from "../../../shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import { scrubEnv } from "../../../shared-infrastructure/process-sandbox/scrub-env.ts";
import type { VcsReadPort } from "../application/ports/index.ts";

// Typed read side over a git mirror. argv lives HERE; callers pass Sha and receive typed results.
// No raw git strings, no new spawn code (consumes the kernel SandboxedBinaryRunner) and no new diff
// parser (consumes DiffParserService). Read-only: this adapter NEVER runs a git WRITE (the security
// boundary — writes live only in workspace-and-publication).
export class GitMirrorReadAdapter implements VcsReadPort {
  private readonly parser = new DiffParserService();
  constructor(private readonly repoDir: string, private readonly runner: SandboxedBinaryRunner) {}

  async diff(sha: Sha, opts?: { baseSha?: Sha; commits?: number }): Promise<string> {
    const range = opts?.baseSha ? `${opts.baseSha.value}..${sha.value}`
      : opts?.commits ? `${sha.value}~${opts.commits}..${sha.value}`
      : `${sha.value}^..${sha.value}`;
    const r = await this.runner.run({ command: "git", args: ["diff", "--no-color", range], cwd: this.repoDir, env: scrubEnv() });
    // Surface VCS errors loudly (CLAUDE.md: "Surface integration errors loudly — never swallow").
    // A non-zero exit or timeout means the sha/repo is invalid; returning an empty string would
    // silently look like "no changed files" to every downstream consumer. Throw so the use-case
    // fail-open catch records a typed skip — a genuine VCS error must NOT become an empty diff.
    if (r.timedOut) throw new Error(`git diff timed out for range ${range}`);
    if (r.exitCode !== 0) throw new Error(`git diff failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
    return r.stdout;
  }

  async message(sha: Sha): Promise<string> {
    const r = await this.runner.run({ command: "git", args: ["log", "-1", "--format=%B", sha.value], cwd: this.repoDir, env: scrubEnv() });
    return r.stdout.trim();
  }

  async blastRadius(sha: Sha, opts?: { baseSha?: Sha; commits?: number }): Promise<BlastRadius> {
    const diff = await this.diff(sha, opts);
    return BlastRadius.of(sha, this.parser.changedFiles(diff));
  }
}
```
> **Import paths (verified):** The production adapter uses `"../../../shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts"` (3 levels up from `infrastructure/` to `qa-engine/src/`; correct). The test at `qa-engine/test/contexts/change-analysis/infrastructure/` uses `"../../../../src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts"` (4 levels up to `qa-engine/`, then into `src/`; the path that resolves). `shared-infrastructure` has no `@` alias, so relative imports are correct in both locations.

- [ ] **Step 4: Run it — GREEN; typecheck; commit**

```bash
node --import ./test-setup.mjs --import tsx --test "qa-engine/test/contexts/change-analysis/infrastructure/git-mirror-read.adapter.test.ts" && npm run typecheck
git add qa-engine/src/contexts/change-analysis/infrastructure/git-mirror-read.adapter.ts qa-engine/test/contexts/change-analysis/infrastructure/git-mirror-read.adapter.test.ts
git commit -m "feat(change-analysis): GitMirrorReadAdapter typed VcsRead over the kernel runner"
```

---

## Task 10: Full-context green + final gate

Run the whole gate to confirm the context integrates and nothing in Plan 1/Plan 2 regressed.

**Files:** none (verification only).

- [ ] **Step 1: Run the full qa-engine test tree**

```bash
node --import ./test-setup.mjs --import tsx --test "qa-engine/test/**/*.test.ts"
```
Expected: every Plan 1 + Plan 2 + Plan 3 test passes. Record the new count (Plan 2 ended at 49 qa-engine tests + Plan 1's; Plan 3 adds the diff-parser, language-id, static-signal, commit-classification, analyze-change, extractor-adapters, and git-mirror-read suites).

- [ ] **Step 2: Run the FULL root gate (both trees) — the real CLAUDE.md gate**

```bash
npm run typecheck && npm test
```
Expected: typecheck clean across `src/` + `qa-engine/`; ALL tests green (the `src/` suite is untouched, so it must still pass; the parity tests prove the kernel parser matches the live `src/` functions).

- [ ] **Step 3: Confirm no `src/` runtime file changed**

```bash
git diff --name-only $(git merge-base main HEAD) HEAD -- src/ | rg -v '\.test\.ts$' || echo "no src/ runtime files touched"
git status --short src/qa/changed-elements.ts src/qa/commit-classify.ts src/qa/static-signal/
```
Expected: NO `src/` runtime file appears in this plan's commits (only `qa-engine/` paths). The user's WIP files keep their pre-existing `M`/`??` status — Plan 3 never staged them.
> Note: `$(git merge-base main HEAD)` is commit-count-agnostic — it finds the true divergence point from `main` regardless of how many commits Plan 3 produced (avoids breaking if the commit count changes). Do NOT use `HEAD~N` (N would need to be updated manually every time).

- [ ] **Step 4: Save progress to engram**

```text
mem_save(project: "panchito", type: "architecture", topic_key: "architecture/qa-engine-rewrite-progress",
  title: "QA-engine Plan 3 (change-analysis) executed",
  content: "Plan 3 DONE. Built shared-kernel/diff-parser (DiffParserService consolidating the 3 diff-content parsers + changed-elements extraction, with legacy parity tests), change-analysis context (LanguageId one-registry killing the AST_GREP drift, StaticSignal w/ typed ExtractorSkipped, classifyCommit ported, analyze-change use-case, 5 wrap-then-replace extractor adapters, GitMirrorReadAdapter). Signal-only fail-open throughout. No src/ runtime touched; user WIP preserved. Next: Plan 4.")
```

---

## Self-Review

**Spec coverage (§5.3(2), §5.2, §7.2 Step 5):**
- ✅ `classifyCommit` ported (the token-spend gate) — Task 5, with legacy parity.
- ✅ ONE canonical `DiffParserService` consolidating the **3 diff-content parsers** (`parseDiffHunks`/`parseChangedFiles`/`changedFilesFromDiff`) **+ the user's `changed-elements` extraction** — Tasks 1+2. The git-**status** parsers (`parseStatusOutput`/`parsePorcelain`) are explicitly kept OUT (Task 0 Step 2).
- ✅ `StaticSignal` Sha-keyed read-model — Task 4.
- ✅ `LanguageId` ONE-registry, killing the `SUPPORTED_LANGUAGES` vs `AST_GREP_LANGUAGES` drift — Task 3 (drift verified live in Task 0 Step 4).
- ✅ Typed `ExtractorSkipped` events replacing opaque `skipped` strings — Tasks 4+7.
- ✅ VOs `CommitIntent`/`CommitType`/`CommitAction` (Task 5), `DiffHunk` (Task 1), `ChangedSymbol`/`RelationEdge`/`ComplexityHotspot`/`FileChangeKind`/`ChangePattern` (Task 4).
- ✅ Ports: `analyze-change` use-case (Task 7); `Symbol/Relation/Complexity/SemanticDiff/Pattern` extractor ports + `VcsReadPort` refined (Task 6).
- ✅ Adapters: the 5 extractor adapters WRAPPING `src/qa/static-signal/*` (Task 8 — wrap-then-replace, no tree-sitter/ast-grep/lizard/difftastic rewrite); `GitMirrorReadAdapter` (Task 9) consuming the kernel `SandboxedBinaryRunner`/`scrubEnv`.

**Base-error fixes (each documented in its task):**
- 4-vs-3 diff-parser confusion → Task 2 names `changed-elements` the 4th *consumer*, not parser; consolidates all into `DiffParserService` with parity guards.
- `LanguageId` registry drift → Task 3 collapses to one registry; `hasAstGrepRules` is a property OF it.
- Opaque `skipped` strings → Tasks 4+7 use typed `ExtractorSkipped`.
- Duplicated `killTree`/spawn → Task 9 consumes the kernel runner (no new spawn).
- Fail-open discipline → Task 7 catches thrown extractor errors INTO skips (signal-only, never blocks); asserted by the "thrown error → skip" test.

**Placeholder scan:** every task has a failing test → run command → real implementation → run command → commit. No "wrap the rest similarly" without the concrete template + the per-adapter delta (Task 8 Step 4 lists each adapter's wrapped fn + skip name explicitly). No test-less steps. The ported bodies (`changedLines`, `classifyCommit`, `changedElements`) are flagged "re-read the live `src/` file and port THAT" because the user edits `src/` in parallel — the plan's snippets are the current-HEAD mirror, the live file is the oracle (parity tests enforce it).

**Type consistency vs the Plan-2 kernel:**
- `Sha` (`@kernel/sha.ts`) — used by `StaticSignal`/`ExtractionContext`/`GitMirrorReadAdapter`; `.value` for the string form.
- `BlastRadius` (`@kernel/blast-radius.ts`) — built via `BlastRadius.of(sha, files)` in `GitMirrorReadAdapter`; `VcsReadPort.blastRadius` returns it.
- `Result<T,E>`/`ok`/`err`/`isOk`/`isErr` (`@kernel/result.ts`) — every extractor port returns `Result<T[], ExtractorSkipped>`; the use-case branches on `isOk`. In tests, ALWAYS use the `isErr(r)` type guard to access `r.error` — never cast `r as { error: ... }`. The guard narrows the type so `r.error` is verified by the compiler, not cast away. Example: `assert.ok(isErr(r) && r.error.extractor === "complexity")` (NOT `(r as any).error`).
- `SandboxedBinaryRunner` (shared-infrastructure, Plan 2) — consumed by `GitMirrorReadAdapter` via constructor injection; `scrubEnv` from the same module.
- `ExtractorSkipped` — Plan 2's port stub declared `{ extractor; reason }`; Task 4 makes the domain the owner and the refined port re-exports it (no shape change, so the existing `ports-compile.test.ts` stays green — verified in Task 6 Step 2).
- The refined `change-analysis` port barrel still satisfies the Plan-2 `ports-compile.test.ts` (9-barrel import) — Task 6 keeps it green rather than editing it.
