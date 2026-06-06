# Critical Review: verify Mode Architecture

**Reviewer**: Sisyphus (Senior Architect)
**Target**: `docs/verify-mode.md`
**Date**: 2026-06-05

---

## Executive Summary

The plan correctly identifies the gap — repos without a browser surface cannot be tested — but over-specifies the solution. A YAML config declaring the test framework, N framework-specific output parsers, a full parallel seed template, and a dedicated agent skill: this is the kind of upfront design that ships slowly and maintains poorly. The same outcome can be achieved with zero new config fields, zero new parsers, and a conventions doc instead of a seed template. The agent is the flexible component. Let it do the detection and adaptation. The orchestrator stays thin.

---

## Flaw 1: Framework-per-App YAML Is Premature Abstraction

**What the plan says**: Each app declares `verify.framework: "vitest"` and `verify.command: "npx vitest run"` in its YAML config.

**Why it is wrong**: The orchestrator does not need to know which test framework a repo uses. It never parses test output per framework — per Flaw 3, it should not parse test output at all. The only consumer of the framework information is the agent, and the agent can detect the framework by reading `package.json`, `go.mod`, `pom.xml`, or `requirements.txt` in the working copy. This is exactly what the agent already does for OpenAPI spec location (it searches common locations; the config only provides an optional hint).

Adding a required config field for every onboarded app creates friction. A developer who wants code testing on their repo must research which value to put in `verify.framework`, ensure it matches their actual setup, and keep it in sync when they migrate frameworks. This is configuration drift waiting to happen.

**The correct approach**: The `verify` section in the app config is a boolean gate: `code: true` enables the mode. That is the only config. The agent detects the framework. The orchestrator runs `npm test` (or the equivalent detected command) and checks the exit code.

**Verdict**: Drop `verify.framework`, `verify.command`, `verify.seedDir`, and `verify.env` from the app config. Replace with `code: true`. The agent detects the rest.

---

## Flaw 2: N Framework-Specific Output Parsers

**What the plan says**: Build a parser for each framework: Vitest JSON reporter, node:test TAP output, `go test -json`, `pytest --json-report`. Map each to QaCase[].

**Why it is wrong**: This is a maintenance commitment with low return. Each parser must handle framework version changes, output format evolution, and edge cases (nested test suites, skipped tests, parameterized tests). Six frameworks means six parsers to maintain. The value is individual test case reporting in the run result — but the publish decision (PR vs Issue) only needs the binary verdict: pass or fail.

The QaCase[] structure exists because Playwright reports individual spec results, which is valuable for debugging E2E failures where "the checkout spec failed on step 3" is actionable. For code tests, the equivalent is the test framework's own output, which is already available in the run logs. Duplicating it into QaCase[] adds no information.

**The correct approach**: The execute step for code mode runs the test command and checks the exit code. Exit 0 = pass verdict. Exit non-zero = fail verdict. The raw output is captured in `run.logs` for debugging. No framework-specific parsing. No QaCase[] mapping. The orchestrator treats code tests as a black box: it runs the command, checks the result, and reports.

**Verdict**: Eliminate all framework output parsers. Binary pass/fail based on exit code. Raw output in logs.

---

## Flaw 3: The Seed Template Duplicates Structure

**What the plan says**: `config/verify/` with `package.json`, `vitest.config.ts`, `tsconfig.json`, `eslint.config.js`, `fixtures.ts` — parallel to `config/e2e/`.

**Why it is wrong**: The E2E seed exists because Playwright E2E projects have specific structural requirements: a `playwright.config.ts` with browser settings, a `fixtures.ts` with authentication helpers, an `eslint.config.js` with `eslint-plugin-playwright`. The orchestrator bootstraps this because a repo without E2E tests has NONE of these files.

But a repo that already has code tests already has a test setup. A Node.js repo already has `package.json` with a test script. It already has `tsconfig.json`. It already has an ESLint config. The seed template would overwrite or conflict with the repo's existing tooling.

The only thing the repo might NOT have is conventions for AI-generated tests: where to put them, how to name them, what patterns to follow. That is a documentation problem, not a scaffolding problem.

**The correct approach**: Instead of a seed template, provide a conventions document at `config/code-test-conventions.md`. The agent reads this document as part of the `code-test-authoring` skill. It tells the agent:
- Auto-detect the test framework from the repo's dependencies
- Place generated tests alongside existing ones (follow the repo's convention)
- Use the repo's existing test command — do not install new dependencies
- Follow the patterns in existing test files for mocking, fixtures, and assertions

The orchestrator has no seed to copy. The agent adapts to whatever is already there.

**Verdict**: Replace seed template with a conventions document. The agent adapts to the repo's existing test setup.

---

## Flaw 4: The Name "verify" Collides with Existing Terminology

**What the plan says**: The mode is called `verify`.

**Why it is wrong**: The pipeline already has a step called "Validate (Filter B)" which the codebase refers to as `validateSpecs()` and `validate()`. "Verify" and "validate" are synonyms. A developer reading the code will see `mode: "verify"` and `step: "validate"` and not immediately understand the difference.

The mode name should describe WHAT is being tested, not HOW. The existing modes do this: `diff` tests the diff of a commit, `complete` tests the complete repo, `manual` tests based on manual guidance. The new mode tests the source code logic. Call it `code`.

**The correct approach**: Rename the mode to `code`. It is short, distinct from existing modes, and describes the target: code logic, not deployed behavior.

| Mode | What it tests |
|---|---|
| `diff` | The deployed app, scoped to a commit's blast radius |
| `code` | The source code logic, scoped to a commit's blast radius |

**Verdict**: Rename `verify` to `code`.

---

## Flaw 5: Self-Testing Is Presented as Straightforward When It Is the Hardest Case

**What the plan says**: "The agent writes a new integration test `queue-drain-race.test.ts` that exercises enqueue + dequeue + concurrent drain edge case using the existing DI pattern."

**Why it is wrong**: Generating a meaningful integration test for a DI-based pipeline orchestration system requires deep understanding of the codebase. The agent must understand the PipelineDeps interface, the stub pattern, the mock setup, the assertion on call ordering, and the verdict classification logic. This is not "write a test for a REST endpoint." This is "write a test for a test framework."

ai-pipeline already has 104 unit tests covering the pipeline logic. The agent would need to generate tests that add value beyond what already exists. That means finding untested edge cases, race conditions, or integration gaps — exactly the kind of testing that requires human reasoning about the system's invariants.

The self-testing scenario is aspirational, not actionable in the first iteration. Presenting it as a primary use case sets unrealistic expectations.

**The correct approach**: Position self-testing as a long-term validation target, not a v1 feature. The primary use case for `code` mode is onboarding repos that have NO existing test coverage. A backend service with zero tests gets its first integration tests generated by the agent. A library with zero tests gets unit tests for its public API. This is measurable, valuable, and achievable.

**Verdict**: Demote self-testing from a primary scenario to a future goal. Focus v1 on repos without existing coverage.

---

## Flaw 6: The Agent Skill Attempts to Teach What the Agent Already Knows

**What the plan says**: Create `opencode/skill/code-test-authoring/` with sections on framework selection, mocking and fixtures, assertion patterns, integration test patterns, CLI test patterns.

**Why it is wrong**: A capable LLM already knows how to write Vitest tests, Jest tests, node:test tests, and pytest tests. These are well-documented, widely-used frameworks. The agent does not need a skill to teach it how to use `describe`/`it` or `expect().toBe()`. The skill would either state the obvious (wasting context budget) or provide ai-pipeline-specific conventions (which belong in a shorter conventions doc, not a full skill).

The Playwright authoring skill exists because Playwright E2E testing has ai-pipeline-specific patterns: the two-layer Keycloak login, the `namespace` fixture, the `authenticate` override, the `cleanup` registration. These are NOT standard Playwright patterns — they are conventions invented by this project. Without the skill, the agent would write standard Playwright tests that do not work in this system.

For code tests, there are no ai-pipeline-specific conventions. The agent writes standard framework tests that run with the repo's existing test command. The only project-specific guidance is: "detect the framework from the repo's dependencies, follow the existing test patterns, use the existing test command." That is 3 bullet points, not a skill.

**The correct approach**: Add a `## Code mode` section to `qa-generator.md` with the detection and adaptation rules. No separate skill file. If the agent consistently generates incorrect patterns for a specific framework, add framework-specific guidance reactively — not proactively.

**Verdict**: Drop the `code-test-authoring` skill. Add 3-5 lines of mode-specific guidance to the existing `qa-generator.md` procedure.

---

## Summary: What to Keep, What to Cut

| Component | Verdict | Reason |
|---|---|---|
| `verify.framework` / `verify.command` in YAML | **Cut** | Agent auto-detects. Config is `code: true` only. |
| N framework output parsers | **Cut** | Binary pass/fail via exit code. Raw output in logs. |
| Full `config/verify/` seed template | **Cut** | Repo already has test setup. Replace with conventions doc. |
| `code-test-authoring` skill | **Cut** | Agent already knows frameworks. Add 3-5 lines to qa-generator.md. |
| `verify` as the mode name | **Cut** | Rename to `code`. Distinct from existing `validate` step. |
| New RunMode in pipeline | **Keep** | Adding a mode is the right mechanism. Shares queue, classify, publish. |
| Validation dispatch by mode | **Keep** | `tsc + eslint` for code mode (no framework-specific lint plugins). |
| Self-testing as primary use case | **Demote** | Too ambitious for v1. Focus on repos without existing coverage. |
| Per-app enablement in config | **Keep** | `code: true` gate. Simple, explicit, auditable. |

---

## The Simplified Architecture (Version 2)

```
1. App config declares: code: true

2. Agent detects framework from repo dependencies:
   - package.json with vitest → vitest
   - package.json with jest → jest
   - package.json without test framework → node:test (built-in)
   - go.mod → go test
   - pom.xml with junit → junit

3. Agent generates tests:
   - Reads existing test files to learn patterns (naming, structure, imports)
   - Writes new test files following the same conventions
   - Uses the repo's existing test command (from package.json scripts.test)
   - Updates manifest.json with code-test metadata

4. Validation:
   - tsc --noEmit (already works for any TS project)
   - eslint (repo's existing config, no framework-specific plugin added)

5. Execution:
   - npm test (or detected equivalent)
   - Exit code 0 → pass verdict
   - Exit code != 0 → fail verdict
   - Raw output captured in logs

6. Publish: unchanged (green → PR, fail → Issue)
```

That is the entire mechanism. 6 components reduced to 2: a new RunMode and a boolean config gate. The agent handles the rest.
