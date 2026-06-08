# panchito
<div align="center">

[![Node.js 22+](https://img.shields.io/badge/node-22%2B-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue)](https://www.typescriptlang.org)
[![Playwright](https://img.shields.io/badge/Playwright-1.50-45ba4b)](https://playwright.dev)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED)](https://www.docker.com)
[![OpenCode](https://img.shields.io/badge/OpenCode-powered-7b68ee)](https://opencode.ai)

</div>

## Contents

- [1. Overview](#1-overview)
- [2. How it works](#2-how-it-works)
  - [Architecture](#architecture)
  - [The QA pipeline](#the-qa-pipeline)
  - [What happens at the end](#what-happens-at-the-end)
  - [The learning layer](#the-learning-layer)
- [3. Getting started](#3-getting-started)
  - [Prerequisites](#prerequisites)
  - [Install and verify](#install-and-verify)
  - [Configure your API key](#configure-your-api-key)
  - [AI model configuration](#ai-model-configuration)
  - [Onboard an app](#onboard-an-app)
  - [Trigger a manual run](#trigger-a-manual-run)
  - [Deploy with Docker](#deploy-with-docker)

---

**Autonomous QA that watches your repos, tests every deploy, and learns from every failure.**

When a commit lands on DEV, an AI agent reads the change, writes Playwright tests for what could break, runs them against the live environment, and either opens a PR against the app's repository with the new tests or files a GitHub Issue if something fails.

It is app-agnostic: onboard any repo by adding a single YAML file. No app code lives here.

---

## 1. Overview

panchito turns every deploy into a QA checkpoint, automatically.

| Capability | What it means |
|---|---|
| **Commit-aware testing** | Reads the diff and commit message to understand what changed. Skips style-only commits, writes targeted tests for features and fixes, runs regression-only for refactors. |
| **Two-model review** | A different AI model reviews every generated test for value. Tests that click without asserting, use fragile selectors, or miss the actual change are rejected before they reach the suite. |
| **Self-improving suite** | When tests pass and the reviewer approves, they are committed to the app's repository via PR with auto-merge. The suite grows with every deploy and never degrades into "green noise." |
| **Learning from failures** | Every failed run is reflected on, distilled into a reusable rule, and injected into future runs. Mutation testing measures whether the tests actually catch bugs (valueScore). Rules that correlate with better outcomes are promoted; the rest decay. |
| **Multi-app, single engine** | One centralized service watches all your team's repos. Each app gets its own namespace for test data and persistent memory. |
| **Shadow mode** | Onboard a repo without touching it: the full pipeline runs, but PRs and Issues are only logged. Flip the switch when you are ready. |

<details>
<summary>What it is not</summary>

- It does **not** build or start your app. Tests run against the live DEV URL.
- It does **not** replace your existing test suite. It augments it with AI-generated E2E coverage.
- It does **not** require per-app code changes. Onboarding is a YAML config file.

</details>

---

## 2. How it works

### Architecture

```mermaid
flowchart LR
    GH["GitHub push to DEV"] -->|webhook| O[Orchestrator]
    O -->|HTTP session| OC[OpenCode AI Engine]
    OC -->|reads code via| SE[Serena LSP]
    OC -->|writes specs| WC[(Repo Working Copy)]
    OC -->|stores memory in| EN[Engram]
    O -->|runs Playwright| DEV[DEV Environment]
    O -->|publishes| PR[GitHub PR / Issue]
    O -->|writes outcomes + rules| LD[(Learning Ledger)]
    LD -->|retrieval injected into prompt| OC
```

<table>
<tr>
<td width="50%" valign="top">

### Orchestrator
**Node.js** deterministic infrastructure.

Receives webhooks, manages the sequential queue, clones repos, runs Playwright against DEV, publishes results. Runs mutation testing to measure test quality (valueScore). Maintains the learning ledger: labels errors, reflects on failures, distills rules, and injects learned knowledge into future runs. Every side-effecting step is dependency-injected and unit-tested with stubs.

</td>
<td width="50%" valign="top">

### OpenCode
**AI engine** running two models.

The `qa-generator` agent reads code via Serena (semantic LSP navigation) and writes Playwright specs. The `qa-reviewer` subagent independently judges quality. Engram provides persistent episodic memory across runs.

</td>
</tr>
</table>

Both services share a volume for repo working copies. The AI agent reads code and writes tests directly where the orchestrator expects them.

### The QA pipeline

Every run follows the same sequence, whether triggered by a webhook or manually:

| Step | What happens |
|---|---|
| **1. Deploy gate** | Waits until DEV reports the right commit SHA and is healthy. Skipped if no health endpoint is configured, or in code mode. |
| **2. Classification** | Reads the commit message and diff. Conventional Commits like `style:` with no logic changes are skipped before spending a single token. |
| **3. Retrieval** | Loads learned rules, structural patterns, and proven scenario archetypes from past runs — injects them into the agent prompt. |
| **4. Generation** | The AI agent reads the blast radius of the change using semantic code navigation, writes tests into the repo, and invokes the reviewer. |
| **5. Static gate** | TypeScript compilation, ESLint, and Playwright's test list must pass. Invalid code is rejected before execution. |
| **6. Execution** | Runs tests against the live DEV URL (e2e) or the repo's own test runner (code mode). Results are classified as pass, fail, or flaky. |
| **7. Oracle** | For code mode green runs: mutation testing via Stryker measures how many injected bugs the tests actually catch (valueScore). |
| **8. Reflection** | On failed runs, an LLM reflects on the error and produces a preventive rule. The rule is distilled and stored for future runs. |
| **9. Decision** | Green and approved: PR with auto-merge. Failures: GitHub Issue. Flaky: quarantined. DEV down: infrastructure error. |

> [!NOTE]
> **Shadow mode** (`qa.shadow: true` in the app config) runs the full pipeline but does not publish PRs or open Issues. Use this when onboarding a repo for the first time.

### What happens at the end

| Outcome | Action |
|---|---|
| All green, reviewer approved | PR with auto-merge commits tests into the app's repository |
| All green, reviewer rejected | GitHub Issue for the team to iterate |
| Failures detected | GitHub Issue with sanitized logs |
| Flaky tests | Quarantined, no Issue created |
| DEV unhealthy | Marked as infrastructure error, not a code bug |

### The learning layer

Beyond deciding pass/fail, panchito learns from every run to improve future ones:

| Component | What it does |
|---|---|
| **Labeler** | Classifies every run into an error class (E-STATIC, E-EXEC-FAIL, E-FALSE-POSITIVE…) — zero LLM, purely from the gates and reviewer. |
| **Oracle** | Measures test quality objectively. For code repos: mutation testing via Stryker — mutates source code, runs the test suite, and scores how many mutants were killed. |
| **Reflector** | On failed runs, an LLM analyzes the error and produces a structured reflection anchored to real artifacts (assert output, uncovered lines, reviewer corrections). |
| **Distiller** | Converts reflections into reusable rules — deduplicated, stored, and injected into future agent prompts so the same mistake isn't made twice. |
| **Curriculum** | Tracks which scenario archetypes (invalid input, re-query-after-mutation, empty state, …) have caught real bugs. Only proven archetypes are fed to the agent. |
| **Attribution** | When a rule was retrieved for a run, the run's valueScore updates the rule's successRate. Rules that correlate with good outcomes are promoted. |

Inspect the learning state at any time:

```bash
npm run qa -- --app my-app --learning
```

Or ask the TUI chat: *"¿qué reglas ha aprendido el sistema?"*

<details>
<summary>Execution modes</summary>

| Mode | When to use |
|---|---|
| `diff` (default) | Webhook-triggered: tests the blast radius of a single commit |
| `complete` | Fill coverage gaps: analyzes the whole repo and tests uncovered flows |
| `exhaustive` | Full audit: re-evaluates every existing test and regenerates the suite |
| `manual` | Focused: generation guided by a natural language prompt |
| `code` target | Source-code testing: runs the repo's own test suite, with mutation testing via Stryker (no browser, no DEV URL) |

</details>

<details>
<summary>Quality gates</summary>

Four layers prevent low-quality tests from entering the suite:

| Layer | What it catches |
|---|---|
| **Static analysis** | Tests that do not compile, violate lint rules, or have missing metadata |
| **AI reviewer** | Tests with trivial assertions, fragile selectors, or no real verification of the change |
| **Change-coverage** | Tests that pass but don't exercise the lines the commit changed — a green suite that proves nothing |
| **Mutation testing** | Tests that pass but don't detect injected bugs — the deepest false positive |

</details>

---

## 3. Getting started

### Prerequisites

- **Node.js 22** or later
- **Docker** and Docker Compose (for production deployment)
- An **OpenCode API key** (a single key covers both AI models)
- A GitHub repo you want to watch, deployed to a DEV environment

### Install and verify

```bash
git clone <this-repo>
cd panchito
npm install
npm test           # unit tests (network and AI calls are stubbed)
npm run typecheck  # strict TypeScript validation
```

### Configure your API key

```bash
cp .env.example .env
```

Edit `.env` and set:

```
OPENCODE_API_KEY=opencode-go-your-key-here
```

> [!IMPORTANT]
> The API key is the only mandatory secret for local development. For production, you also need `GITHUB_TOKEN` and `WEBHOOK_SECRET`.

### AI model configuration

The project uses two AI models via a single OpenCode API key. Both are pre-configured in `opencode/opencode.json` and require no changes to start.

| Agent | Model ID | Role |
|---|---|---|
| `qa-generator` | `opencode-go/deepseek-v4-pro` | Reads code, writes Playwright tests, invokes the reviewer |
| `qa-reviewer` | `opencode-go/qwen3.7-max` | Read-only quality judge; rejects tests with trivial assertions or fragile patterns |

> [!TIP]
> Run `opencode models` to verify both model IDs are available under your subscription. If a model is not listed, edit `opencode/opencode.json` and replace it with one that is. The reviewer must use a different model from the generator.

**What you must configure manually:**

| Item | Where | Required |
|---|---|---|
| API key | `.env` as `OPENCODE_API_KEY` | Yes |
| Model IDs | `opencode/opencode.json` under `agent.*.model` | Only if the defaults are unavailable |
| GitHub token | `.env` as `GITHUB_TOKEN` | Yes, for PR and Issue creation |
| Webhook secret | `.env` as `WEBHOOK_SECRET` | Yes, for production webhook validation |

<details>
<summary>What is pre-configured automatically</summary>

| Item | Where | Notes |
|---|---|---|
| Agent prompts and procedures | `opencode/agent/*.md` | Ready to use |
| Playwright authoring skills | `opencode/skill/playwright-authoring/` | Login, geolocation, mobile, uploads |
| Quality review criteria | `opencode/skill/test-value-review/` | False-positive pattern catalog |
| MCP servers (Serena, Engram) | `opencode/opencode.json` | Code navigation + persistent memory |
| Docker images | `Dockerfile`, `opencode/Dockerfile` | Both services build from these |

</details>

### Onboard an app

Copy the example config and fill in your app's details:

```bash
cp config/apps/example.yaml config/apps/my-app.yaml
```

Edit `config/apps/my-app.yaml`:

```yaml
name: "my-app"
repo: "your-org/your-repo"
baseBranch: "main"

dev:
  baseUrl: "https://dev.my-app.internal"

qa:
  needsReview: true
  shadow: true            # start in shadow mode: no PRs or Issues opened
  testDataPrefix: "qa-bot"

report:
  onFailure: "github-issue"
```

### Trigger a manual run

```bash
npm run qa -- --app my-app --sha <commit-sha>

# Inspect what the system has learned across runs
npm run qa -- --app my-app --learning
```

<details>
<summary>Run in different modes</summary>

```bash
# Fill coverage gaps across the whole repo
npm run qa -- --app my-app --sha <commit-sha> --mode complete

# Audit and regenerate the entire suite
npm run qa -- --app my-app --sha <commit-sha> --mode exhaustive

# Focus on a specific feature
npm run qa -- --app my-app --sha <commit-sha> --mode manual --guidance "test the checkout flow with an empty cart"
```

</details>

### Deploy with Docker

```bash
# With Doppler for secrets
doppler run -- docker compose up --build

# Without Doppler (secrets in .env)
docker compose up --build
```

<details>
<summary>Trigger a run via webhook</summary>

```bash
SHA=$(git ls-remote https://github.com/your-org/your-repo main | cut -f1)
curl -X POST localhost:8080 \
  -H 'content-type: application/json' \
  -d "{\"repo\":\"your-org/your-repo\",\"sha\":\"$SHA\"}"
```

</details>

---

**Need more detail?** Read [`CLAUDE.md`](CLAUDE.md) for the full operational reference, [`AGENTS.md`](AGENTS.md) for OpenCode agent instructions.
