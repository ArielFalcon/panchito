# code mode: Source-Logic Testing Architecture

**Status**: Proposal (v2, revised after architectural review)
**Author**: Sisyphus (AI Architect)
**Date**: 2026-06-05
**Review**: `docs/verify-mode-review.md`

---

## 1. Problem Statement

ai-pipeline today only tests deployed web applications through a browser. Every mode (`diff`, `complete`, `exhaustive`, `manual`) requires a live DEV URL, generates Playwright specs, and runs them through a browser.

This excludes three entire categories of repositories:

| Category | Example | Why excluded today |
|---|---|---|
| Backend services | REST API, GraphQL, gRPC server | No browser surface to test |
| Libraries and packages | npm package, shared utilities | No deployable URL, no UI |
| CLI and infrastructure tools | **ai-pipeline itself** | No web interface, tests are `node:test` |

---

## 2. Design Goal

Add a `code` mode that tests source code logic directly — integration tests, unit tests, API tests — without a browser or DEV environment. The mode must:

1. Work for any repo type, regardless of whether it has a web UI
2. Integrate into the existing pipeline: same queue, same classification, same publish, same invariants
3. Require minimal configuration from the app owner: one boolean field
4. Let the agent detect the test framework and adapt to existing conventions automatically

---

## 3. Architecture

### 3.1 The Mode: `code`

`code` is a new `RunMode` alongside `diff`, `complete`, `exhaustive`, `manual`. It shares the same pipeline infrastructure and differs only in what the agent generates and how the orchestrator validates and executes.

| Aspect | E2E modes (`diff`, `complete`, ...) | `code` mode |
|---|---|---|
| Target | Deployed app at DEV URL | Source code in working copy |
| Test framework | Playwright | Auto-detected from repo dependencies |
| Agent skill | `playwright-authoring` | Existing framework knowledge + conventions |
| Validation | `tsc` + `eslint-plugin-playwright` + `playwright --list` | `tsc` + ESLint (repo's existing config) |
| Execution | Playwright runner against DEV | `npm test` (or detected equivalent) |
| Verdict classification | Per-spec pass/fail/flaky | Binary pass/fail via exit code |
| Seed template | `config/e2e/` (full Playwright project) | None (repo already has test setup) |

### 3.2 Configuration: One Boolean Gate

The app owner enables code testing with a single field:

```yaml
# config/apps/my-backend.yaml
name: "my-backend"
repo: "org/backend-service"

code: true   # enable code-logic testing
```

That is the only configuration. The orchestrator does not need to know which test framework the repo uses. The agent detects it from the repo's dependencies. The orchestrator runs whatever test command the repo defines and checks the exit code.

**Why not declare the framework**: Declaring it creates configuration drift — the YAML says `vitest` but the repo migrated to `jest` six months ago. The agent reads the actual repo state; the config should not duplicate information that lives elsewhere. The pattern already exists in the project: the agent auto-detects OpenAPI spec locations from common paths; the `openapi:` hint in app config is optional and only needed for non-standard layouts. Code testing follows the same pattern.

### 3.3 Agent: Detect, Adapt, Generate

The agent receives a `code` mode task and follows a detection-first approach:

**Step 1: Detect the framework.** The agent reads the repo's dependency manifest and determines which test framework is in use:

| Dependency file | Signal | Framework |
|---|---|---|
| `package.json` contains `vitest` | Vitest |
| `package.json` contains `jest` | Jest |
| `package.json` has no test framework dep | `node:test` (Node.js built-in) |
| `go.mod` exists | `go test` |
| `pom.xml` contains `junit` | JUnit |
| `requirements.txt` contains `pytest` | pytest |

**Step 2: Learn existing patterns.** The agent reads 2-3 existing test files to learn the repo's conventions: file naming (`*.test.ts` vs `*.spec.ts` vs `*_test.go`), import patterns, mock/fixture setup, assertion style. It matches these conventions exactly.

**Step 3: Generate tests for the blast radius.** Using serena for semantic code navigation (same as E2E modes), the agent identifies the code affected by the commit and generates tests that exercise it. For a backend service, this means integration tests that call the affected endpoints. For a library, this means unit tests for the changed public API. For a CLI tool, this means tests that execute the tool and assert on output.

**Step 4: Record metadata.** Same manifest pattern as E2E: `e2e/.qa/manifest.json` with `objective`, `targets`, `changeRef`.

**Step 5: Review.** The qa-reviewer subagent validates the generated tests against the same quality criteria as E2E tests, adapted for code tests: meaningful assertions, coverage of the actual change, adherence to the repo's existing patterns.

### 3.4 Validation: Lighter Than E2E

The static gate for `code` mode is simpler than for E2E:

| Check | E2E mode | `code` mode |
|---|---|---|
| TypeScript compilation | `tsc --noEmit` | `tsc --noEmit` |
| Lint | `eslint` with `eslint-plugin-playwright` | `eslint` (repo's existing config) |
| Test discovery | `playwright --list` | Not applicable |
| Manifest validity | Required | Required |

**Why no framework-specific lint rules**: The repo already has its own ESLint config. The orchestrator validates that the generated code compiles and passes the existing lint rules. If the repo wants stricter test-specific linting, it adds those plugins itself.

**Why no test discovery step**: Playwright's `--list` verifies that specs are loadable. For code tests, compilation already verifies this — if `tsc` passes, the tests are syntactically valid.

### 3.5 Execution: Binary Pass/Fail

The execute step runs the repo's test command and checks the exit code:

```
1. Run the test command (from package.json scripts.test, or detected equivalent)
2. Capture stdout/stderr → stored in run.logs
3. Exit code 0 → verdict = pass
4. Exit code != 0 → verdict = fail
```

**Why binary, not per-test**: Playwright reports individual spec results because E2E failures are often specific to one flow. Code test failures are already detailed in the framework's own output, which is captured in `run.logs`. Duplicating that into QaCase[] adds no information and requires maintaining N framework-specific parsers. The publish decision (PR vs Issue) only needs the binary verdict.

**Flaky detection**: Not applicable for code tests. Flakiness in E2E tests comes from browser timing and network conditions. Code tests are deterministic. A test that sometimes passes and sometimes fails is genuinely broken, not flaky.

### 3.6 Publish: Identical to E2E

The publish flow is unchanged. Green runs open PRs with auto-merge. Failed runs open Issues. The only difference is the PR body and Issue title, which reference `code` mode instead of `diff`.

---

## 4. What the Agent Needs to Know (Minimal Guidance)

The existing `qa-generator.md` procedure gains a `## Code mode` section with these rules:

```
## Code mode

When mode is "code", you test source code logic instead of a deployed web app.

1. Detect the test framework from the repo's dependencies (vitest, jest,
   node:test, go test, pytest, junit). Read 2-3 existing test files to learn
   naming, import, and fixture conventions.

2. Use serena to find the blast radius. Generate tests that exercise the
   affected code paths with meaningful assertions on inputs and outputs.

3. Place tests alongside existing ones following the repo's convention.
   Use the repo's existing test command. Do not install new dependencies.

4. Record metadata in e2e/.qa/manifest.json. The objective describes what
   code path is tested; targets list the symbols covered.
```

That is the entire mode-specific guidance. No separate skill file.

---

## 5. Use Cases (in Priority Order)

### Primary: Onboard repos without test coverage

A backend service has zero tests. The team onboards it to ai-pipeline with `code: true`. On the next deploy, the agent generates the first integration tests for the changed endpoints. The suite bootstraps itself run by run, just like E2E suites do today.

### Secondary: Augment repos with partial coverage

A library has unit tests for its utility functions but no integration tests for its database layer. The agent detects the gap and generates integration tests that exercise the data access patterns affected by the commit.

### Tertiary (future): Self-test ai-pipeline

The tool tests its own code on every commit. This requires the agent to understand the DI pattern, pipeline ordering, and verdict logic — a level of codebase comprehension that is aspirational for v1. The infrastructure exists; the agent's capability will grow into it.

---

## 6. Integration with Existing Architecture

```
                     ┌──────────────────────────────────┐
   GitHub webhook    │         orchestrator              │
   or CLI ─────────▶ │                                  │
                     │  mode=diff       → Playwright E2E │
                     │  mode=complete   → Playwright E2E │
                     │  mode=exhaustive → Playwright E2E │
                     │  mode=manual     → Playwright E2E │
                     │  mode=code       → Code Tests     │
                     │                                  │
                     │  setupTestProject(mode)           │
                     │  validate(mode)                   │
                     │  execute(mode)                    │
                     │  publish(result)   ← shared       │
                     └──────────────┬───────────────────┘
                                    │
                     ┌──────────────▼───────────────────┐
                     │         opencode serve            │
                     │  mode=code:                      │
                     │    auto-detect framework          │
                     │    follow existing patterns       │
                     │    use repo's test command        │
                     │  (same agent, same tools)         │
                     └──────────────────────────────────┘
```

**What does not change**: queue, working copy, classification, publish, report, engram, serena, the REST API.

**What adapts to mode**: the agent's task description, the validation checks, the test runner.

**What is eliminated from the original plan**: framework-per-app YAML, N output parsers, seed template, dedicated skill file.
