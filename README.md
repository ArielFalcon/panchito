# ai-pipeline

<div align="center">

[![Node.js 22+](https://img.shields.io/badge/node-22%2B-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue)](https://www.typescriptlang.org)
[![Playwright](https://img.shields.io/badge/Playwright-1.50-45ba4b)](https://playwright.dev)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED)](https://www.docker.com)
[![OpenCode](https://img.shields.io/badge/OpenCode-powered-7b68ee)](https://opencode.ai)

</div>

**Autonomous E2E QA that watches your repos and tests every deploy against DEV.**

When a commit lands on DEV, an AI agent reads the change, writes Playwright tests for what could break, runs them against the live environment, and either opens a PR with the new tests or files a GitHub Issue if something fails.

It is app-agnostic: onboard any repo by adding a single YAML file. No app code lives here.

---

## 1. Overview

ai-pipeline turns every deploy into a QA checkpoint, automatically.

| Capability | What it means |
|---|---|
| **Commit-aware testing** | Reads the diff and commit message to understand what changed. Skips style-only commits, writes targeted tests for features and fixes, runs regression-only for refactors. |
| **Two-model review** | A different AI model reviews every generated test for value. Tests that click without asserting, use fragile selectors, or miss the actual change are rejected before they reach the suite. |
| **Self-improving suite** | When tests pass and the reviewer approves, they are committed back to the repo via PR. The suite grows with every deploy and never degrades into "green noise." |
| **Multi-app, single engine** | One centralized service watches all your team's repos. Each app gets its own namespace for test data and persistent memory. |
| **Shadow mode** | Onboard a repo without touching it: the full pipeline runs, but PRs and Issues are only logged. Flip the switch when you are ready. |

### What it is not

- It does **not** build or start your app. Tests run against the live DEV URL.
- It does **not** replace your existing test suite. It augments it with AI-generated E2E coverage.
- It does **not** require per-app code changes. Onboarding is a YAML config file.

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
```

Two services run side by side, communicating over a single HTTP boundary. Both share a volume for repo working copies so the AI agent reads code and writes tests directly where the orchestrator expects them.

| Service | Role |
|---|---|
| **Orchestrator** (Node.js) | Receives webhooks, manages the queue, clones repos, runs Playwright, publishes results. All deterministic logic lives here. |
| **OpenCode** (AI engine) | Runs the AI agents that read code, generate tests, and review quality. Uses Serena for semantic code navigation and Engram for persistent memory. |

### The QA pipeline

Every run follows the same sequence, whether triggered by a webhook or manually:

| Step | What happens |
|---|---|
| **1. Deploy gate** | Waits until DEV reports the right commit SHA and is healthy. Skipped if no health endpoint is configured. |
| **2. Classification** | Reads the commit message and diff. Conventional Commits like `style:` with no logic changes are skipped before spending a single token. |
| **3. Generation** | The AI agent reads the blast radius of the change using semantic code navigation, writes Playwright specs into the repo's `e2e/` folder, and invokes the reviewer. |
| **4. Static gate** | TypeScript compilation, ESLint, and Playwright's test list must pass. Invalid code is rejected before execution. |
| **5. Execution** | Playwright runs the specs against the live DEV URL with namespaced test data. Results are classified as pass, fail, or flaky. |
| **6. Decision** | Green and approved: PR with auto-merge. Failures: GitHub Issue. Flaky: quarantined. DEV down: infrastructure error. |

> [!NOTE]
> **Shadow mode** (`qa.shadow: true` in the app config) runs the full pipeline but does not publish PRs or open Issues. Use this when onboarding a repo for the first time.

### What happens at the end

| Outcome | Action |
|---|---|
| All green, reviewer approved | PR with auto-merge commits tests into the repo |
| All green, reviewer rejected | GitHub Issue for the team to iterate |
| Failures detected | GitHub Issue with sanitized logs |
| Flaky tests | Quarantined, no Issue created |
| DEV unhealthy | Marked as infrastructure error, not a code bug |

### Execution modes

| Mode | When to use |
|---|---|
| `diff` (default) | Webhook-triggered: tests the blast radius of a single commit |
| `complete` | Fill coverage gaps: analyzes the whole repo and tests uncovered flows |
| `exhaustive` | Full audit: re-evaluates every existing test and regenerates the suite |
| `manual` | Focused: generation guided by a natural language prompt |

### Quality gates

Three layers prevent low-quality tests from entering the suite:

| Layer | What it catches |
|---|---|
| **Static analysis** | Tests that do not compile, violate lint rules, or have missing metadata |
| **AI reviewer** | Tests with trivial assertions, fragile selectors, or no real verification of the change |
| **Flakiness detection** | Tests that pass only after retries are quarantined instead of accepted |

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
cd ai-pipeline
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

**What is pre-configured automatically:**

| Item | Where | Notes |
|---|---|---|
| Agent prompts and procedures | `opencode/agent/*.md` | Ready to use |
| Playwright authoring skills | `opencode/skill/playwright-authoring/` | Login, geolocation, mobile, uploads |
| Quality review criteria | `opencode/skill/test-value-review/` | False-positive pattern catalog |
| MCP servers (Serena, Engram) | `opencode/opencode.json` | Code navigation + persistent memory |
| Docker images | `Dockerfile`, `opencode/Dockerfile` | Both services build from these |

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
```

### Run in different modes

```bash
# Fill coverage gaps across the whole repo
npm run qa -- --app my-app --sha <commit-sha> --mode complete

# Audit and regenerate the entire suite
npm run qa -- --app my-app --sha <commit-sha> --mode exhaustive

# Focus on a specific feature
npm run qa -- --app my-app --sha <commit-sha> --mode manual --guidance "test the checkout flow with an empty cart"
```

### Deploy with Docker

```bash
# With Doppler for secrets
doppler run -- docker compose up --build

# Without Doppler (secrets in .env)
docker compose up --build
```

Trigger a run from the command line once the services are up:

```bash
SHA=$(git ls-remote https://github.com/your-org/your-repo main | cut -f1)
curl -X POST localhost:8080 \
  -H 'content-type: application/json' \
  -d "{\"repo\":\"your-org/your-repo\",\"sha\":\"$SHA\"}"
```

---

**Need more detail?** Read [`CLAUDE.md`](CLAUDE.md) for the full operational reference, [`AGENTS.md`](AGENTS.md) for OpenCode agent instructions.
